import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const root = mkdtempSync(join(tmpdir(), "dcp-reply-cleanup-"))
process.env.XDG_DATA_HOME = join(root, "data")
process.env.XDG_CONFIG_HOME = join(root, "config")
process.env.OPENCODE_CONFIG_DIR = join(root, "config", "opencode")
mkdirSync(process.env.OPENCODE_CONFIG_DIR, { recursive: true })
writeFileSync(join(process.env.OPENCODE_CONFIG_DIR, "dcp.jsonc"), JSON.stringify({ autoUpdate: false }))
test.after(() => rmSync(root, { recursive: true, force: true }))

const { createSessionState } = await import("../lib/state/state")
const { assignMessageRefs } = await import("../lib/message-ids")
const { injectMessageIds } = await import("../lib/messages/inject/inject")
const { stripHallucinations, stripHallucinationsFromString } = await import("../lib/messages/utils")
const { createTextCompleteHandler } = await import("../lib/hooks")
const { getConfig } = await import("../lib/config")

const config = getConfig({ directory: root, client: { tui: { showToast() {} } } } as any)

const user = (id: string, text: string): any => ({
    info: { id, role: "user", sessionID: "s", agent: "build", model: { providerID: "p", modelID: "m" } },
    parts: [{ id: `${id}:text`, type: "text", text }],
})
const assistant = (id: string, parts: any[]): any => ({
    info: { id, role: "assistant", sessionID: "s", modelID: "m", providerID: "p" },
    parts,
})
const completedTool = (id: string, output: string): any => ({
    id: `${id}:tool`,
    type: "tool",
    tool: "bash",
    callID: `${id}:call`,
    state: { status: "completed", output },
})

// Mirrors the transform order upstream uses (strip -> assign refs -> inject ids),
// with the format the adapter selects. V2 passes state.idFormat; V1 is XML-only.
function transform(state: any, messages: any[]): void {
    stripHallucinations(messages, state.idFormat)
    assignMessageRefs(state, messages)
    injectMessageIds(state, config, messages)
}

function occurrences(text: string, needle: string): number {
    return text.split(needle).length - 1
}

// Built from char codes so the literal tag characters survive tooling that
// strips them from source.
const AT = String.fromCharCode(64)
const LT = String.fromCharCode(60)
const GT = String.fromCharCode(62)

test("compact text.complete strips echoed at-refs", async () => {
    const handler = createTextCompleteHandler(createSessionState("compact"))
    const output = { text: `I will use ${AT}1${AT} to compress.\n${AT}2${AT} done\n` }
    await handler({ sessionID: "s", messageID: "m", partID: "p" }, output)
    assert.equal(output.text, "I will use  to compress.\n done\n")
})

test("xml text.complete strips echoed dcp-message-id tags", async () => {
    const handler = createTextCompleteHandler(createSessionState("xml"))
    const tag = `${LT}dcp-message-id${GT}m0001${LT}/dcp-message-id${GT}`
    const output = { text: `before ${tag} after` }
    await handler({ sessionID: "s", messageID: "m", partID: "p" }, output)
    assert.equal(output.text, "before  after")
})

test("cleanup removes a trailing run of degenerate tag debris (#562)", () => {
    const debris = [
        "Which do you prefer?",
        "<<",
        "<<",
        "<<",
        "<<",
        "<<",
        "<<",
        "<<",
        "<",
        "<m0477",
        "<",
        "",
    ].join("\n")
    assert.equal(stripHallucinationsFromString(debris), "Which do you prefer?")
})

test("cleanup leaves ordinary text without refs untouched", async () => {
    const text = "mail me at a@b.com, see <https://x.dev>, and 1 < 2"
    assert.equal(stripHallucinationsFromString(text, "compact"), text)
    assert.equal(stripHallucinationsFromString(text, "xml"), text)

    const handler = createTextCompleteHandler(createSessionState("compact"))
    const output = { text }
    await handler({ sessionID: "s", messageID: "m", partID: "p" }, output)
    assert.equal(output.text, text)
})

for (const format of ["xml", "compact"] as const) {
    test(`#614 injection is byte-stable and single-tagged across transforms (${format})`, () => {
        const state = createSessionState(format)
        state.sessionId = "s"
        const messages = [
            user("u1", "run it"),
            assistant("a1", [completedTool("a1", "tool output")]),
            user("u2", "and again"),
            assistant("a2", [{ id: "a2:text", type: "text", text: "done" }]),
        ]

        transform(state, messages)
        const first = JSON.stringify(messages)
        const ref = (id: string) => state.messageIds.byRawId.get(id)!

        for (const [id, expected] of [["u1", 1], ["a2", 1]] as const) {
            assert.equal(occurrences((messages.find((m) => m.info.id === id)!.parts[0] as any).text, ref(id)), expected)
        }
        assert.equal(occurrences((messages[1].parts[0] as any).state.output, ref("a1")), 1)

        transform(state, messages)
        const second = JSON.stringify(messages)
        assert.equal(second, first, "prior messages must stay byte-identical across transforms")

        assert.equal(occurrences((messages[1].parts[0] as any).state.output, ref("a1")), 1)
    })
}

test("#614 a completed tool output does not grow across repeated transforms", () => {
    const state = createSessionState("xml")
    state.sessionId = "s"
    const messages = [user("u1", "run it"), assistant("a1", [completedTool("a1", "tool output")])]

    transform(state, messages)
    const once = (messages[1].parts[0] as any).state.output
    for (let i = 0; i < 3; i++) transform(state, messages)
    assert.equal((messages[1].parts[0] as any).state.output, once)
})