import { afterAll, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const directory = await mkdtemp(join(tmpdir(), "dcp-v2-"))
process.env.XDG_DATA_HOME = directory
process.env.XDG_CONFIG_HOME = directory
process.env.OPENCODE_CONFIG_DIR = join(directory, "opencode")
await mkdir(process.env.OPENCODE_CONFIG_DIR, { recursive: true })
await writeFile(join(process.env.OPENCODE_CONFIG_DIR, "dcp.jsonc"), JSON.stringify({ autoUpdate: false }))
const { createSessionState, ensureSessionInitialized, checkSession } = await import("../lib/state/state")
const { saveSessionState, loadSessionState } = await import("../lib/state/persistence")
const { assignMessageRefs } = await import("../lib/message-ids")
const { prepareSession } = await import("../lib/compress/pipeline")
const { getConfig } = await import("../lib/config")
const logger = { info() {}, warn() {}, error() {}, debug() {}, async saveContext() {} } as any
const message = (id: string, summary = false, created = 1): any => ({
    info: { sessionID: "session", id, role: summary ? "assistant" : "user", summary, time: { created } },
    parts: [{ type: "text", text: id }],
})
const client: any = { session: { get: async () => ({ data: {} }), messages: async () => ({ data: [] }) } }
afterAll(async () => { await rm(directory, { recursive: true, force: true }) })

test("compact refs, inverse map, epoch, and counter survive restart and full history", async () => {
    const state = createSessionState("compact")
    state.sessionId = "persist"
    state.lastCompaction = 10
    assignMessageRefs(state, [message("visible")])
    state.messageIds.nextRef = 12000
    await saveSessionState(state, logger)
    const loaded = createSessionState("compact")
    await ensureSessionInitialized(client, loaded, "persist", logger, [message("summary", true, 10)], false)
    expect(loaded.messageIds.byRef.get("@1@")).toBe("visible")
    expect(loaded.lastCompaction).toBe(10)
    assignMessageRefs(loaded, [message("older"), message("visible"), message("new")])
    expect(loaded.messageIds.byRawId.get("visible")).toBe("@1@")
    expect(loaded.messageIds.byRawId.get("older")).toBe("@12000@")
    expect(loaded.messageIds.byRawId.get("new")).toBe("@12001@")
})

test("legacy files load; malformed aliases cannot collide or move the counter backwards", async () => {
    const state = createSessionState("compact")
    state.sessionId = "legacy"
    await saveSessionState(state, logger)
    const path = join(directory, "opencode/storage/plugin/dcp/legacy.json")
    const data = JSON.parse(await readFile(path, "utf8"))
    delete data.lastCompaction
    delete data.messageIds
    await writeFile(path, JSON.stringify(data))
    const old = createSessionState("compact")
    await ensureSessionInitialized(client, old, "legacy", logger, [], false)
    expect(old.messageIds.nextRef).toBe(1)
    data.messageIds = { byRawId: { first: "@12@", duplicate: "@12@", invalid: "m0001", unsafe: "@9007199254740992@" }, nextRef: 2 }
    await writeFile(path, JSON.stringify(data))
    const loaded = createSessionState("compact")
    await ensureSessionInitialized(client, loaded, "legacy", logger, [], false)
    expect([...loaded.messageIds.byRef]).toEqual([["@12@", "first"]])
    expect(loaded.messageIds.nextRef).toBe(13)
})

test("newer compaction discards disk refs, blocks, tools and nudges without resurrection", async () => {
    const state = createSessionState("compact")
    state.sessionId = "compact"
    assignMessageRefs(state, [message("old")])
    state.prune.tools.set("old-tool", 1)
    state.nudges.contextLimitAnchors.add("old")
    state.prune.messages.nextBlockId = 17
    await saveSessionState(state, logger)
    const loaded = createSessionState("compact")
    await ensureSessionInitialized(client, loaded, "compact", logger, [message("summary", true, 20), message("new")], false)
    expect(loaded.messageIds.byRef.size).toBe(0)
    expect(loaded.prune.tools.size).toBe(0)
    expect(loaded.prune.messages.nextBlockId).toBe(1)
    expect(loaded.nudges.contextLimitAnchors.size).toBe(0)
    assignMessageRefs(loaded, [message("new")])
    await checkSession(client, loaded, logger, [message("summary2", true, 30)], false)
    expect(loaded.messageIds.byRef.size).toBe(0)
    expect((await loadSessionState("compact", logger))?.lastCompaction).toBe(30)
})

test("compression detects compaction arriving during its second history fetch", async () => {
    const state = createSessionState("compact")
    state.sessionId = "session"
    assignMessageRefs(state, [message("old")])
    const changed = { session: { ...client.session, messages: async () => ({ data: [message("summary", true, 50), message("new")] }) } }
    await expect(prepareSession({ state, client: changed, logger, config: getConfig({ directory, client } as any) } as any,
        { sessionID: "session", async ask() {}, metadata() {} }, "Compress")).rejects.toThrow("Session compacted")
    expect(state.messageIds.byRef.size).toBe(0)
})

test("overlapping disk snapshots retain the latest refs and a failed write does not poison the queue", async () => {
    const state = createSessionState("compact")
    state.sessionId = "disk-queue"
    assignMessageRefs(state, [message("one")])
    const first = saveSessionState(state, logger)
    assignMessageRefs(state, [message("two")])
    const second = saveSessionState(state, logger)
    const read = loadSessionState("disk-queue", logger)
    await Promise.all([first, second])
    expect((await read)?.messageIds?.byRawId).toEqual({ one: "@1@", two: "@2@" })
    const path = join(directory, "opencode/storage/plugin/dcp/failed.json")
    await mkdir(path)
    state.sessionId = "failed"
    const errors: unknown[] = []
    await saveSessionState(state, { ...logger, error: (...args: unknown[]) => errors.push(args) })
    expect(errors.length).toBe(1)
    await rm(path, { recursive: true })
    await saveSessionState(state, logger)
    expect((await loadSessionState("failed", logger))?.messageIds?.nextRef).toBe(3)
})

const entry = (id: string, text = id): any => ({ id, type: "user", text, time: { created: 100 } })
const native = (id: string): any => ({ id, role: "user", content: [{ type: "text", text: id }] })

async function runtime() {
    const { default: plugin } = await import("../dist/index.js")
    const hooks: Record<string, (event: any) => Promise<void>> = {}
    const tools: Record<string, any> = {}
    const histories: Record<string, any[]> = {}
    let read: ((id: string) => Promise<void>) | undefined
    const ctx: any = {
        location: { directory },
        session: {
            get: async ({ sessionID }: any) => ({ id: sessionID, agent: "build", model: { providerID: "test", id: "model" } }),
            context: async ({ sessionID }: any) => { await read?.(sessionID); return histories[sessionID] ?? [] },
            hook: async (kind: string, handler: any) => { hooks[kind] = handler },
        },
        agent: { get: async () => ({ data: { permissions: [] } }) },
        model: { transform: async (handler: any) => handler({ list: () => [{ providerID: "test", id: "model", limit: { context: 100000 } }] }) },
        tool: { transform: async (handler: any) => handler({ add: (tool: any) => { tools[tool.name] = tool } }) },
        command: { transform: async () => {} },
        rpc: { register: async () => {} },
    }
    const dispose = await plugin.setup(ctx)
    const event = (id: string, ids: string[], options = {}): any => ({
        sessionID: id, agent: "build", model: { providerID: "test", id: "model" },
        messages: ids.map(native), system: [{ type: "text", text: "Assistant" }], tools: { compress: {} }, options,
    })
    return { hooks, tools, histories, event, dispose, setRead: (handler: typeof read) => { read = handler } }
}

test("built V2 entry persists model-visible refs across sessions and plugin restart", async () => {
    const first = await runtime()
    first.histories["runtime-parent"] = [entry("hidden"), entry("visible")]
    first.histories["runtime-other"] = [entry("other")]
    const initial = first.event("runtime-parent", ["visible"])
    await first.hooks.context(initial)
    expect(JSON.stringify(initial.messages)).toContain("@1@")
    await first.hooks.context(first.event("runtime-other", ["other"]))
    const disk = await loadSessionState("runtime-parent", logger)
    expect(disk?.messageIds?.byRawId).toEqual({ visible: "@1@" })
    first.dispose?.()
    const restarted = await runtime()
    restarted.histories["runtime-parent"] = first.histories["runtime-parent"]
    const again = restarted.event("runtime-parent", ["hidden", "visible"])
    await restarted.hooks.context(again)
    expect(again.messages[1].content[0].text).toContain("@1@")
    expect(again.messages[0].content[0].text).toContain("@2@")
    expect(again.system[0].text).toContain("compress")
    const result = await restarted.tools.compress.execute({ topic: "Resolved visible history", content: [{ startId: "@1@", endId: "@1@", summary: "Visible research is resolved." }] },
        { sessionID: "runtime-parent", agent: "build", messageID: "compress-turn", id: "compress-call", progress: async () => {} })
    expect(typeof result.content).toBe("string")
    const compressed = await loadSessionState("runtime-parent", logger)
    const block = Object.values(compressed!.prune.messages!.blocksById)[0]
    expect(block.effectiveMessageIds).toEqual(["visible"])
    expect(block.anchorMessageId).toBe("visible")
    restarted.dispose?.()
})

test("V2 rejects stale refs before tool load resets them, including retries and restarts", async () => {
    const app = await runtime()
    const id = "runtime-stale"
    app.histories[id] = [entry("before")]
    await app.hooks.context(app.event(id, ["before"]))
    app.histories[id] = [{ id: "summary", type: "compaction", status: "completed", time: { created: 200 } }, entry("after")]
    const context: any = { sessionID: id, agent: "build", messageID: "tool", id: "call", progress: async () => {} }
    await expect(app.tools.compress.execute({}, context)).rejects.toThrow("Session compacted")
    await expect(app.tools.compress.execute({}, context)).rejects.toThrow("Session compacted")
    app.dispose?.()
    // A fresh model turn is the only way to expose the post-compaction aliases.
    const fresh = await runtime()
    fresh.histories[id] = app.histories[id]
    const next = fresh.event(id, ["after"])
    await fresh.hooks.context(next)
    expect(next.messages[0].content[0].text).toContain("@1@")
    fresh.dispose?.()
    const beforeRestart = await runtime()
    beforeRestart.histories["restart-stale"] = [entry("before-restart")]
    await beforeRestart.hooks.context(beforeRestart.event("restart-stale", ["before-restart"]))
    beforeRestart.dispose?.()
    const afterRestart = await runtime()
    afterRestart.histories["restart-stale"] = app.histories[id]
    await expect(afterRestart.tools.compress.execute({}, { ...context, sessionID: "restart-stale" })).rejects.toThrow("Session compacted")
    afterRestart.dispose?.()
    const retryRestart = await runtime()
    retryRestart.histories["restart-stale"] = app.histories[id]
    await expect(retryRestart.tools.compress.execute({}, { ...context, sessionID: "restart-stale" })).rejects.toThrow("Message refs unavailable")
    retryRestart.dispose?.()
})

test("upstream V2 queues serialize one session, allow another, and recover after rejection", async () => {
    const app = await runtime()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let ready!: () => void
    const started = new Promise<void>(resolve => { ready = resolve })
    let reads = 0
    app.histories["queue-a"] = [entry("a")]
    app.histories["queue-b"] = [entry("b")]
    app.setRead(async id => { if (id === "queue-a") { reads++; ready(); await gate } })
    const first = app.hooks.context(app.event("queue-a", ["a"]))
    await started
    const second = app.hooks.context(app.event("queue-a", ["a"]))
    await app.hooks.context(app.event("queue-b", ["b"]))
    expect(reads).toBe(1)
    release()
    await Promise.all([first, second])
    expect(reads).toBe(2)
    app.setRead(async () => { throw new Error("history unavailable") })
    await expect(app.hooks.context(app.event("queue-a", ["a"]))).rejects.toThrow("history unavailable")
    app.setRead(undefined)
    await app.hooks.context(app.event("queue-a", ["a"]))
    expect((await loadSessionState("queue-a", logger))?.messageIds?.byRawId.a).toBe("@1@")
    app.dispose?.()
})

test("compaction preserves prepopulated maxTokens, checkpoint and retained-tail origins", async () => {
    const app = await runtime()
    const id = "runtime-compaction"
    app.histories[id] = [entry("prefix"), entry("tail")]
    await app.hooks.context(app.event(id, ["prefix", "tail"]))
    await app.tools.compress.execute({ topic: "Resolved prefix", content: [{ startId: "@1@", endId: "@1@", summary: "Prefix work is complete." }] },
        { sessionID: id, agent: "build", messageID: "tail", id: "tail-call", progress: async () => {} })
    const options = { maxTokens: 16384, temperature: 0.2 }
    const event = app.event(id, ["prefix"], options)
    const checkpoint = { role: "user", content: [{ type: "text", text: "Native checkpoint", providerMetadata: { test: { checkpoint: true } } }] }
    event.messages.unshift(checkpoint)
    await app.hooks.compaction(event)
    expect(event.options).toBe(options)
    expect(event.options.maxTokens).toBe(16384)
    expect(event.messages[0]).toEqual(checkpoint)
    expect(JSON.stringify(event.messages)).toContain("Prefix work is complete.")
    expect(JSON.stringify(event.messages)).toContain("@b1@")
    expect((await loadSessionState(id, logger))?.messageIds?.byRawId).toEqual({ prefix: "@1@", tail: "@2@" })
    expect((await loadSessionState(id, logger))?.prune.messages?.blocksById["1"].active).toBe(true)
    app.dispose?.()
})

test("2.0.21 media assets keep their native payload and provider metadata", async () => {
    const { Media } = await import("@opencode/ai/media")
    const { project } = await import("../lib/v2/messages")
    const asset = new Media.Asset({ source: { type: "base64", data: "aGVsbG8=", mediaType: "image/png" } })
    const part: any = { type: "media", media: asset, providerMetadata: { test: { keep: true } } }
    const session: any = { id: "media", agent: "build", model: { providerID: "test", id: "model" } }
    const view = project([{ id: "image", role: "user", content: [part] }], [entry("image")], session)
    expect((view.messages[0].parts[0] as any).mime).toBe("image/png")
    expect((view.messages[0].parts[0] as any).url).toBe("data:image/png;base64,aGVsbG8=")
    expect(view.restore()[0].content[0]).toBe(part)
    expect(JSON.stringify(view.restore())).toContain('"keep":true')
})

