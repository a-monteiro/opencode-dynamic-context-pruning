import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const root = mkdtempSync(join(tmpdir(), "dcp-v2-inprogress-"))
process.env.XDG_DATA_HOME = join(root, "data")
process.env.XDG_CONFIG_HOME = join(root, "config")
process.env.OPENCODE_CONFIG_DIR = join(root, "config", "opencode")
mkdirSync(process.env.OPENCODE_CONFIG_DIR, { recursive: true })
writeFileSync(
    join(process.env.OPENCODE_CONFIG_DIR, "dcp.jsonc"),
    JSON.stringify({ autoUpdate: false }),
)
test.after(() => rmSync(root, { recursive: true, force: true }))

const { project } = await import("../lib/v2/messages")
const { createSessionState } = await import("../lib/state/state")
const { assignMessageRefs, formatMessageIdTag } = await import("../lib/message-ids")
const { stripHallucinations } = await import("../lib/messages/utils")
const { injectCompressNudges, injectMessageIds } = await import("../lib/messages/inject/inject")
const { getConfig } = await import("../lib/config")
const { TURN_NUDGE } = await import("../lib/prompts/turn-nudge")
const { ITERATION_NUDGE } = await import("../lib/prompts/iteration-nudge")
const { CONTEXT_LIMIT_NUDGE } = await import("../lib/prompts/context-limit-nudge")

const logger = { info() {}, warn() {}, error() {}, debug() {}, async saveContext() {} } as any
const config = getConfig({ directory: root, client: { tui: { showToast() {} } } } as any)
const prompts = {
    system: "",
    compressRange: "",
    compressMessage: "",
    contextLimitNudge: CONTEXT_LIMIT_NUDGE,
    turnNudge: TURN_NUDGE,
    iterationNudge: ITERATION_NUDGE,
    manualExtension: "",
    subagentExtension: "",
}
const session = { id: "session", agent: "build", model: { providerID: "test", id: "model" } }

const ITERATION_MARKER = "You've been iterating for a while after the last user message."

const userEntry = (id: string, text: string): any => ({
    id,
    type: "user",
    text,
    time: { created: 100 },
})
const assistantEntry = (id: string, content: any[], completed?: number): any => ({
    id,
    type: "assistant",
    agent: "build",
    model: { id: "model", providerID: "test" },
    content,
    // V2 clears time.completed while a message is still being generated.
    time: { created: 200, ...(completed !== undefined ? { completed } : {}) },
})
const userNative = (id: string, text: string): any => ({
    id,
    role: "user",
    content: [{ type: "text", text }],
})
const assistantNative = (id: string, content: any[]): any => ({ id, role: "assistant", content })

// Mirrors the V2 context hook tail: project -> strip -> assign refs -> nudge -> ids.
function runHook(state: any, entries: any[], native: any[]): any[] {
    const view = project(native, entries, session)
    stripHallucinations(view.messages, state.idFormat)
    assignMessageRefs(state, view.messages)
    injectCompressNudges(state, config, logger, view.messages, prompts, undefined, false, true)
    injectMessageIds(state, config, view.messages)
    return view.restore()
}

function refTag(state: any, id: string): string {
    return formatMessageIdTag(state.messageIds.byRawId.get(id)!, undefined, state.idFormat).replace(
        /^\n+/,
        "",
    )
}

function textOf(message: any): string {
    return message.content
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text)
        .join("")
}

for (const format of ["xml", "compact"] as const) {
    test(`V2 keeps an in-progress assistant reply clean and nudges the latest user instead (${format})`, () => {
        const state = createSessionState(format)
        state.sessionId = "inprogress"
        state.nudges.iterationNudgeAnchors.add("a1")

        const restored = runHook(
            state,
            [
                userEntry("u1", "hello"),
                assistantEntry("a1", [
                    { type: "text", text: "draft" },
                    {
                        type: "tool",
                        id: "call1",
                        name: "bash",
                        state: { status: "running", input: {} },
                    },
                ]),
            ],
            [
                userNative("u1", "hello"),
                assistantNative("a1", [
                    { type: "text", text: "draft" },
                    { type: "tool-call", id: "call1", name: "bash", input: {} },
                ]),
            ],
        )

        const assistant = restored.find((message) => message.id === "a1")
        assert.equal(
            textOf(assistant),
            `draft\n\n${refTag(state, "a1")}`,
            "the in-progress reply keeps its text and still gets its ref",
        )
        assert.ok(
            !JSON.stringify(assistant).includes(ITERATION_MARKER),
            "the nudge must not land on the in-progress assistant message",
        )

        const user = restored.find((message) => message.id === "u1")
        assert.ok(
            textOf(user).includes(ITERATION_MARKER),
            "the nudge is redirected to the latest user message",
        )
    })
}

test("V2 still refs completed assistant messages byte-identically", () => {
    const state = createSessionState("compact")
    state.sessionId = "completed-earlier"
    state.nudges.iterationNudgeAnchors.add("a2")

    const restored = runHook(
        state,
        [
            userEntry("u1", "hello"),
            assistantEntry("a1", [{ type: "text", text: "one" }], 300),
            userEntry("u2", "again"),
            assistantEntry("a2", [{ type: "text", text: "two" }]),
        ],
        [
            userNative("u1", "hello"),
            assistantNative("a1", [{ type: "text", text: "one" }]),
            userNative("u2", "again"),
            assistantNative("a2", [{ type: "text", text: "two" }]),
        ],
    )

    assert.equal(state.messageIds.byRawId.get("a1"), "@2@", "refs are assigned in transcript order")

    const completed = restored.find((message) => message.id === "a1")
    assert.equal(
        textOf(completed),
        `one\n\n${refTag(state, "a1")}`,
        "completed ref injection is an unchanged snapshot",
    )

    const inProgress = restored.find((message) => message.id === "a2")
    assert.equal(
        textOf(inProgress),
        `two\n\n${refTag(state, "a2")}`,
        "the in-progress reply keeps receiving its ref as before",
    )

    const user = restored.find((message) => message.id === "u2")
    assert.ok(textOf(user).includes(ITERATION_MARKER), "the nudge moves to the latest user message")
})
