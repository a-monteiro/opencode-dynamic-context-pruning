import { afterAll, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const directory = await mkdtemp(join(tmpdir(), "dcp-min-range-tokens-"))
process.env.XDG_DATA_HOME = directory
process.env.XDG_CONFIG_HOME = directory
process.env.OPENCODE_CONFIG_DIR = join(directory, "opencode")
await mkdir(process.env.OPENCODE_CONFIG_DIR, { recursive: true })
const configPath = join(process.env.OPENCODE_CONFIG_DIR, "dcp.jsonc")
const writeConfig = (extra: Record<string, unknown> = {}) =>
    writeFile(
        configPath,
        JSON.stringify({ autoUpdate: false, pruneNotification: "off", ...extra }),
    )
await writeConfig()

const { createSessionState } = await import("../lib/state/state")
const { getConfig, validateConfigTypes } = await import("../lib/config")
const { countTokens, countVisibleMessageTokens } = await import("../lib/token-utils")
const { measureSelectionVisibleTokens, validateMinRangeTokens } =
    await import("../lib/compress/range-utils")
const { createCompressRangeTool } = await import("../lib/compress/range")
const { formatMessageRef } = await import("../lib/message-ids")

afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
})

const warningsClient = { tui: { showToast() {} } } as any
const logger = { info() {}, warn() {}, error() {}, debug() {}, async saveContext() {} } as any

const rawMessage = (id: string, text: string, created = 1): any => ({
    info: {
        id,
        sessionID: "s",
        role: "user",
        time: { created },
        model: { providerID: "test", modelID: "model" },
    },
    parts: [{ type: "text", text }],
})

const selectionOf = (messageIds: string[], requiredBlockIds: number[] = []): any => ({
    startReference: { kind: "message", rawIndex: 0, messageId: messageIds[0] },
    endReference: { kind: "message", rawIndex: messageIds.length - 1, messageId: messageIds.at(-1) },
    messageIds,
    messageTokenById: new Map(),
    toolIds: [],
    requiredBlockIds,
})

const searchContextOf = (messages: any[], summaries: Map<number, any> = new Map()): any => ({
    rawMessages: messages,
    rawMessagesById: new Map(messages.map((message) => [message.info.id, message])),
    rawIndexById: new Map(messages.map((message, index) => [message.info.id, index])),
    summaryByBlockId: summaries,
})

const planOf = (index: number, selection: any): any => ({
    index,
    entry: { startId: `content-${index}-start`, endId: `content-${index}-end`, summary: "s" },
    selection,
    anchorMessageId: selection.messageIds[0] ?? "anchor",
})

async function makeContext(floor: number | undefined, rawMessages: any[]) {
    await writeConfig(floor === undefined ? {} : { compress: { minRangeTokens: floor } })
    const config = getConfig({ directory, client: warningsClient } as any)
    const state = createSessionState("compact")
    state.sessionId = "s"
    const client = {
        session: {
            get: async () => ({ data: {} }),
            messages: async () => ({ data: rawMessages }),
        },
    }
    const prompts = { reload() {}, getRuntimePrompts: () => ({ compressRange: "" }) } as any
    const tool = createCompressRangeTool({ client, state, logger, config, prompts })
    const toolCtx: any = {
        sessionID: "s",
        messageID: "assistant-message",
        callID: "compress-call",
        ask: async () => {},
        metadata: () => {},
    }
    const args = {
        topic: "Small range",
        content: [
            { startId: formatMessageRef(1, "compact"), endId: formatMessageRef(2, "compact"), summary: "done" },
        ],
    }
    return { tool, toolCtx, args, state }
}

test("pruned tool payloads do not inflate the measured content", () => {
    const state = createSessionState("compact")
    const toolMessage: any = {
        info: { id: "t1", sessionID: "s", role: "assistant", time: { created: 2 } },
        parts: [
            {
                type: "tool",
                callID: "call-1",
                tool: "bash",
                state: { status: "completed", input: {}, output: "x".repeat(400) },
            },
        ],
    }

    expect(countVisibleMessageTokens(state, toolMessage)).toBeGreaterThan(0)

    state.prune.tools.set("call-1", 1)
    expect(countVisibleMessageTokens(state, toolMessage)).toBe(0)
})

test("active compressions are excluded and their visible summary counts once", () => {
    const state = createSessionState("compact")
    const first = rawMessage("m1", "alpha beta")
    const second = rawMessage("m2", "gamma delta")
    state.prune.messages.byMessageId.set("m1", {
        tokenCount: 99,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    const block = { blockId: 1, anchorMessageId: "m1", summaryTokens: 7, active: true }
    const searchContext = searchContextOf([first, second], new Map([[1, block]]))

    const measured = measureSelectionVisibleTokens(
        selectionOf(["m1", "m2"], [1]),
        searchContext,
        state,
    )

    expect(measured).toBe(countTokens("gamma delta") + 7)
})

test("underfloor is rejected, exactly the floor and above are allowed", () => {
    const state = createSessionState("compact")
    const searchContext = searchContextOf([rawMessage("m1", "alpha beta"), rawMessage("m2", "gamma delta")])
    const plan = planOf(0, selectionOf(["m1", "m2"]))
    const measured = countTokens("alpha beta") + countTokens("gamma delta")

    expect(() => validateMinRangeTokens([plan], searchContext, state, measured)).not.toThrow()
    expect(() => validateMinRangeTokens([plan], searchContext, state, measured + 1)).toThrow(
        new RegExp(`about ${measured} visible tokens, below compress\\.minRangeTokens \\(${measured + 1}\\)`),
    )
    expect(() => validateMinRangeTokens([plan], searchContext, state, 1)).not.toThrow()
})

test("zero and malformed floors stay off so a bad config cannot deadlock compression", () => {
    const state = createSessionState("compact")
    const searchContext = searchContextOf([rawMessage("m1", "alpha beta"), rawMessage("m2", "gamma delta")])
    const plan = planOf(0, selectionOf(["m1", "m2"]))

    for (const value of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => validateMinRangeTokens([plan], searchContext, state, value)).not.toThrow()
    }
})

test("an underfloor selection rejects the whole batch and names every offender", () => {
    const state = createSessionState("compact")
    const searchContext = searchContextOf([rawMessage("m1", "alpha beta")])
    const plans = [planOf(0, selectionOf([])), planOf(1, selectionOf([]))]

    expect(() => validateMinRangeTokens(plans, searchContext, state, 100)).toThrow(
        /rejected this batch[\s\S]*content\[0\][\s\S]*content\[1\][\s\S]*about 0 visible tokens, below compress\.minRangeTokens \(100\)[\s\S]*Widen the range across closed or stale history to include more content, or skip this range; never widen into active history just to reach the floor\./,
    )
})

test("emergency context-limit anchors bypass the floor", () => {
    const state = createSessionState("compact")
    const searchContext = searchContextOf([rawMessage("m1", "small")])
    const plan = planOf(0, selectionOf(["m1"]))
    state.nudges.contextLimitAnchors.add("anchor")

    expect(() => validateMinRangeTokens([plan], searchContext, state, 1_000_000)).not.toThrow()
})

test("config layering accepts minRangeTokens and leaves other limits untouched", async () => {
    await writeConfig({ compress: { minRangeTokens: 20000 } })
    const layered = getConfig({ directory, client: warningsClient } as any)
    expect(layered.compress.minRangeTokens).toBe(20000)
    expect(layered.compress.maxContextLimit).toBe(100000)
    expect(layered.compress.minContextLimit).toBe(50000)

    await writeConfig()
    expect(getConfig({ directory, client: warningsClient } as any).compress.minRangeTokens).toBe(0)
})

test("invalid minRangeTokens values are reported", () => {
    const negative = validateConfigTypes({ compress: { minRangeTokens: -1 } })
    expect(negative.some((error) => error.key === "compress.minRangeTokens")).toBe(true)

    const nonNumeric = validateConfigTypes({ compress: { minRangeTokens: "20000" } })
    expect(nonNumeric.some((error) => error.key === "compress.minRangeTokens")).toBe(true)

    const fractional = validateConfigTypes({ compress: { minRangeTokens: 1.5 } })
    expect(fractional.some((error) => error.key === "compress.minRangeTokens")).toBe(true)

    const valid = validateConfigTypes({ compress: { minRangeTokens: 20000 } })
    expect(valid.some((error) => error.key === "compress.minRangeTokens")).toBe(false)
})

test("the repo schema vendors minRangeTokens", async () => {
    const schema = JSON.parse(
        await readFile(new URL("../dcp.schema.json", import.meta.url), "utf8"),
    )
    expect(schema.properties.compress.additionalProperties).toBe(false)
    expect(schema.properties.compress.properties.minRangeTokens.type).toBe("integer")
    expect(schema.properties.compress.properties.minRangeTokens.minimum).toBe(0)
    expect(schema.properties.compress.default.minRangeTokens).toBe(0)
})

test("range compression below the floor rejects without creating a block", async () => {
    const messages = [rawMessage("m1", "hello world"), rawMessage("m2", "second message")]
    const { tool, toolCtx, args, state } = await makeContext(1_000_000, messages)

    await expect(tool.execute(args, toolCtx)).rejects.toThrow(/compress\.minRangeTokens/)
    expect(state.prune.messages.blocksById.size).toBe(0)
    expect(state.prune.messages.nextRunId).toBe(1)
    expect(state.prune.messages.nextBlockId).toBe(1)
})

test("range compression at the floor succeeds and still allocates a block", async () => {
    const messages = [rawMessage("m1", "hello world"), rawMessage("m2", "second message")]
    const floor = countTokens("hello world") + countTokens("second message")
    const { tool, toolCtx, args, state } = await makeContext(floor, messages)

    expect(typeof (await tool.execute(args, toolCtx))).toBe("string")
    expect(state.prune.messages.blocksById.size).toBe(1)
    expect(state.prune.messages.nextRunId).toBe(2)
})

test("default zero floor preserves prior behavior", async () => {
    const messages = [rawMessage("m1", "hi"), rawMessage("m2", "ok")]
    const { tool, toolCtx, args, state } = await makeContext(undefined, messages)

    expect(typeof (await tool.execute(args, toolCtx))).toBe("string")
    expect(state.prune.messages.blocksById.size).toBe(1)
})

test("emergency anchors let the tool compress a small range", async () => {
    const messages = [rawMessage("m1", "tiny"), rawMessage("m2", "range")]
    const { tool, toolCtx, args, state } = await makeContext(1_000_000, messages)
    state.nudges.contextLimitAnchors.add("anchor")

    expect(typeof (await tool.execute(args, toolCtx))).toBe("string")
    expect(state.prune.messages.blocksById.size).toBe(1)
})

test("a mixed-size batch rejects as a whole and allocates nothing", async () => {
    const large = "z".repeat(4000)
    const messages = [
        rawMessage("m1", large),
        rawMessage("m2", large),
        rawMessage("m3", "tiny"),
        rawMessage("m4", "range"),
    ]
    const floor = countTokens(large) * 2 - 1
    const { tool, toolCtx, state } = await makeContext(floor, messages)
    const args = {
        topic: "Mixed batch",
        content: [
            {
                startId: formatMessageRef(1, "compact"),
                endId: formatMessageRef(2, "compact"),
                summary: "large range done",
            },
            {
                startId: formatMessageRef(3, "compact"),
                endId: formatMessageRef(4, "compact"),
                summary: "small range done",
            },
        ],
    }

    await expect(tool.execute(args, toolCtx)).rejects.toThrow(/compress\.minRangeTokens/)
    expect(state.prune.messages.blocksById.size).toBe(0)
    expect(state.prune.messages.nextRunId).toBe(1)
    expect(state.prune.messages.nextBlockId).toBe(1)
})
