import { afterAll, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const directory = await mkdtemp(join(tmpdir(), "dcp-plan-mode-reminder-"))
process.env.XDG_DATA_HOME = directory
process.env.XDG_CONFIG_HOME = directory
process.env.OPENCODE_CONFIG_DIR = join(directory, "opencode")
await mkdir(process.env.OPENCODE_CONFIG_DIR, { recursive: true })
await writeFile(
    join(process.env.OPENCODE_CONFIG_DIR, "dcp.jsonc"),
    JSON.stringify({ autoUpdate: false, pruneNotification: "off" }),
)

const { createSessionState } = await import("../lib/state/state")
const { getConfig } = await import("../lib/config")
const { prune } = await import("../lib/messages/prune")

afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
})

const logger = { info() {}, warn() {}, error() {}, debug() {}, async saveContext() {} } as any
const config = getConfig({ directory, client: { tui: { showToast() {} } } } as any)

const enterPlan =
    "<system-reminder>\nYou are in Plan mode. Discuss the plan with the user directly in the conversation.\n</system-reminder>"
const exitPlan =
    "<system-reminder>\nYou are NO LONGER in Plan mode. The previous Plan restrictions no longer apply.\n</system-reminder>"

const message = (id: string, role: "user" | "assistant", text: string): any => ({
    info: { id, sessionID: "s", role, time: { created: 1 }, agent: "build", model: {} },
    parts: [{ sessionID: "s", messageID: id, id: `${id}:0`, type: "text", text }],
})

function compressedState(anchor: string, compressedIds: string[]) {
    const state = createSessionState("compact")
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        active: true,
        summary: "SUMMARY",
        anchorMessageId: anchor,
    } as any)
    state.prune.messages.activeByAnchorMessageId.set(anchor, 1)
    state.prune.messages.activeBlockIds.add(1)
    for (const id of compressedIds)
        state.prune.messages.byMessageId.set(id, {
            tokenCount: 1,
            allBlockIds: [1],
            activeBlockIds: [1],
        })
    return state
}

const texts = (messages: any[]) => messages.map((m) => m.parts[0].text)

test("a compressed Plan exit reminder survives so an earlier enter reminder is not the latest", () => {
    const messages = [
        message("m1", "user", enterPlan),
        message("m2", "user", "plan this"),
        message("m3", "assistant", "here is a plan"),
        message("m4", "user", exitPlan),
        message("m5", "user", "go"),
        message("m6", "assistant", "done"),
        message("m7", "user", "next"),
    ]
    prune(compressedState("m2", ["m2", "m3", "m4", "m5", "m6"]), logger, config, messages)

    const visible = texts(messages)
    expect(visible).toEqual([enterPlan, "SUMMARY", exitPlan, "next"])
    expect(visible.findLast((text) => text === enterPlan || text === exitPlan)).toBe(exitPlan)
})

test("compression still drops ordinary messages that quote the reminder text", () => {
    const quoted = message("m3", "user", `see this: ${exitPlan}`)
    const multiPart = message("m4", "user", exitPlan)
    multiPart.parts.push({ ...multiPart.parts[0], id: "m4:1", text: "extra" })
    const assistant = message("m5", "assistant", exitPlan)
    const messages = [message("m1", "user", "start"), message("m2", "user", "a"), quoted, multiPart, assistant, message("m6", "user", "tail")]
    prune(compressedState("m2", ["m2", "m3", "m4", "m5"]), logger, config, messages)

    expect(texts(messages)).toEqual(["start", "SUMMARY", "tail"])
})
