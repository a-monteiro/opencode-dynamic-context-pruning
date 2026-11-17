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
    info: {
        sessionID: "session",
        id,
        role: summary ? "assistant" : "user",
        summary,
        time: { created },
        ...(summary ? { finish: "stop" } : {}),
    },
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
    const hookOptions: Record<string, any> = {}
    const tools: Record<string, any> = {}
    const histories: Record<string, any[]> = {}
    let read: ((id: string) => Promise<void>) | undefined
    const ctx: any = {
        location: { directory },
        session: {
            get: async ({ sessionID }: any) => ({ id: sessionID, agent: "build", model: { providerID: "test", id: "model" } }),
            context: async ({ sessionID }: any) => { await read?.(sessionID); return histories[sessionID] ?? [] },
            hook: async (kind: string, handler: any, options?: any) => { hooks[kind] = handler; hookOptions[kind] = options },
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
    return { hooks, hookOptions, tools, histories, event, dispose, setRead: (handler: typeof read) => { read = handler } }
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

for (const kind of ["midline", "fence"]) {
    test(`R1 built: oversize fallback preserves subsequent ${kind} literals`, async () => {
        const app = await runtime()
        const open = String.fromCharCode(60) + "dcp-system-reminder>"
        const close = String.fromCharCode(60) + "/dcp-system-reminder>"
        const frame = (delta: object) => `data: ${JSON.stringify({
            object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }],
        })}\n\n`
        const before = kind === "midline" ? "Normal prose " : "````markdown\n"
        const after = kind === "midline" ? `${open.slice(1)} literal\n` : `${open}\nquoted body\n${close}\n` + "````\n"
        const tool = frame({ tool_calls: [{ index: 0, function: { name: "example", arguments: "x".repeat(300 * 1024) } }] })
        const body = frame({ content: before }) + tool + frame({ content: after }) +
            frame({ content: `${open}\nintentional passthrough\n${close}\n` }) + "data: [DONE]\n\n"
        const event = {
            sessionID: "oversized-frame", agent: "build", model: { providerID: "openrouter", id: "m" }, kind: "primary",
            request: new Request("https://openrouter.ai/api/v1/chat/completions", { method: "POST" }),
            response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
        }
        await app.hooks["http.response"](event)
        expect(await event.response.text() === body).toBe(true)
        app.dispose?.()
    })
}

test("built: CRLF frames around the pending cap complete for every chunk layout", async () => {
    const app = await runtime()
    const cap = 256 * 1024
    const open = String.fromCharCode(60) + "dcp-system-reminder>"
    const close = String.fromCharCode(60) + "/dcp-system-reminder>"
    const frame = (delta: object, end = "\n\n") => `data: ${JSON.stringify({
        object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }],
    })}${end}`
    const tool = (args: string) => frame({ tool_calls: [{ index: 0, function: { name: "example", arguments: args } }] }, "\r\n\r\n")
    const encoder = new TextEncoder()
    const content = (text: string) => {
        let out = ""
        for (const event of text.split("\n\n")) if (event.startsWith("data: {")) {
            const parsed = JSON.parse(event.slice(6))
            for (const choice of parsed.choices ?? []) if (typeof choice.delta?.content === "string") out += choice.delta.content
        }
        return out
    }
    for (const delta of [-1, 0, 1, 2]) {
        const toolFrame = tool("x".repeat(cap + delta - tool("").length))
        expect(encoder.encode(toolFrame).length).toBe(cap + delta)
        const head = frame({ content: "start\n" + open.slice(0, 4) })
        const later = `\nkeep\n${open}\nbody\n${close}\nafter`
        const body = head + toolFrame + frame({ content: later }) + "data: [DONE]\n\n"
        const bytes = encoder.encode(body)
        const split = encoder.encode(head).length + cap + delta - 1
        const layouts = [[bytes], [bytes.subarray(0, split), bytes.subarray(split)], [] as Uint8Array[]]
        for (let offset = 0; offset < bytes.length; offset += 4096) layouts[2]!.push(bytes.subarray(offset, offset + 4096))
        for (const pieces of layouts) {
            const event = {
                sessionID: "crlf-cap", agent: "build", model: { providerID: "openrouter", id: "m" }, kind: "primary",
                request: new Request("https://openrouter.ai/api/v1/chat/completions", { method: "POST" }),
                response: new Response(new ReadableStream<Uint8Array>({ start(controller) {
                    for (const piece of pieces) controller.enqueue(piece)
                    controller.close()
                } }), { headers: { "content-type": "text/event-stream" } }),
            }
            await app.hooks["http.response"](event)
            const text = await event.response.text()
            expect(text.split(toolFrame).length).toBe(2)
            if (delta > 0) {
                expect(text.endsWith(toolFrame + frame({ content: later }) + "data: [DONE]\n\n")).toBe(true)
                expect(content(text.replaceAll("\r\n", "\n"))).toBe("start\n" + open.slice(0, 4) + later)
            } else {
                expect(content(text.replaceAll("\r\n", "\n"))).not.toContain(open)
                expect(content(text.replaceAll("\r\n", "\n"))).toContain("after")
            }
        }
    }
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

test("generate renders history like context and passes the one-shot prompt through untouched", async () => {
    const app = await runtime()
    const id = "runtime-generate"
    app.histories[id] = [entry("first"), entry("second")]
    const context = app.event(id, ["first", "second"])
    await app.hooks.context(context)
    const refs = (await loadSessionState(id, logger))?.messageIds?.byRawId
    const update = { role: "system", content: [{ type: "text", text: "Instruction update" }] }
    const ping = { role: "user", content: [{ type: "text", text: "Reply with exactly: OK" }] }
    const generate = app.event(id, ["first", "second"])
    generate.messages.push(structuredClone(update), structuredClone(ping))
    await app.hooks.generate(generate)
    expect(generate.messages.slice(0, -2)).toEqual(context.messages)
    expect(generate.messages.at(-2)).toEqual(update)
    expect(generate.messages.at(-1)).toEqual(ping)
    expect(generate.system).toEqual(context.system)
    expect((await loadSessionState(id, logger))?.messageIds?.byRawId).toEqual(refs)
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

test("V2 context hook strips an echoed reminder from assistant history", async () => {
    const app = await runtime()
    const LT = String.fromCharCode(60)
    const GT = String.fromCharCode(62)
    const open = `${LT}dcp-system-reminder${GT}`
    const close = `${LT}/dcp-system-reminder${GT}`
    const sentence = "If your subagent-related conversation needs to be compressed"
    const reminder = `${open}\n${sentence}\n${sentence}\n${close}\n`
    const id = "runtime-reminder"
    app.histories[id] = [
        { id: "u1", type: "user", text: "user prompt", time: { created: 100 } },
        {
            id: "a1",
            type: "assistant",
            agent: "build",
            model: { id: "model", providerID: "test" },
            content: [{ type: "text", text: `Here is my answer.\n${reminder}` }],
            time: { created: 200, completed: 300 },
        },
    ]
    const event: any = {
        sessionID: id,
        agent: "build",
        model: { providerID: "test", id: "model" },
        messages: [
            { id: "u1", role: "user", content: [{ type: "text", text: "user prompt" }] },
            {
                id: "a1",
                role: "assistant",
                content: [{ type: "text", text: `Here is my answer.\n${reminder}` }],
            },
        ],
        system: [{ type: "text", text: "Assistant" }],
        tools: { compress: {} },
        options: {},
    }
    await app.hooks.context(event)
    const assistant = event.messages.find((message: any) => message.id === "a1")
    const user = event.messages.find((message: any) => message.id === "u1")
    expect(assistant.content[0].text.startsWith("Here is my answer.")).toBe(true)
    expect(user.content[0].text.startsWith("user prompt")).toBe(true)
    expect(JSON.stringify(event.messages)).not.toContain(sentence)
    expect(app.hookOptions["http.response"]?.providerID).toBe("openrouter")

    const sse = (body: string) =>
        new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    const compactionEvent: any = {
        sessionID: id,
        agent: "build",
        model: { providerID: "openrouter", modelID: "m" },
        kind: "compaction",
        request: new Request("https://openrouter.ai/api/v1/chat/completions", { method: "POST" }),
        response: sse("data: {}\n\n"),
    }
    const compactionResponse = compactionEvent.response
    await app.hooks["http.response"](compactionEvent)
    expect(compactionEvent.response).toBe(compactionResponse)

    const primaryEvent: any = {
        sessionID: id,
        agent: "build",
        model: { providerID: "openrouter", modelID: "m" },
        kind: "primary",
        request: new Request("https://openrouter.ai/api/v1/chat/completions", { method: "POST" }),
        response: sse(
            `data: ${JSON.stringify({
                id: "c",
                object: "chat.completion.chunk",
                choices: [
                    {
                        index: 0,
                        delta: { content: `a\n${open}\n${sentence}\n${close}\n` },
                        finish_reason: null,
                    },
                ],
            })}\n\ndata: [DONE]\n\n`,
        ),
    }
    await app.hooks["http.response"](primaryEvent)
    expect(primaryEvent.response).not.toBe(compactionResponse)
    const streamed = await primaryEvent.response.text()
    expect(streamed).not.toContain(sentence)
    expect(streamed).toContain('"content":"a\\n"')

    const payload = (content: string, object = "chat.completion.chunk", role?: string) =>
        `data: ${JSON.stringify({ object, choices: [{ index: 0, delta: { content, role }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
    for (const [method, path, providerID, kind] of [
        ["GET", "/api/v1/chat/completions", "openrouter", "primary"],
        ["POST", "/api/v1/responses", "openrouter", "primary"],
        ["POST", "/api/v1/chat/completions", "other", "primary"],
        ["POST", "/api/v1/chat/completions", "openrouter", "title"],
        ["POST", "/api/v1/chat/completions", "openrouter", "generate"],
    ]) {
        const response = sse(payload(reminder))
        const routed = { ...primaryEvent, model: { providerID, id: "m" }, kind,
            request: new Request(`https://openrouter.ai${path}`, { method }), response }
        await app.hooks["http.response"](routed)
        expect(routed.response).toBe(response)
        expect(await response.text()).toBe(payload(reminder))
    }
    for (const body of [
        payload(reminder, "audit.record"),
        `event: response.audit\n${payload(reminder)}`,
        payload(reminder, "chat.completion.chunk", "user"),
        payload("````markdown\n```\n" + reminder + "```\n````\n"),
        payload("hello\nd"),
    ]) {
        const routed = { ...primaryEvent, response: sse(body) }
        await app.hooks["http.response"](routed)
        expect(await routed.response.text()).toBe(body)
    }
    app.dispose?.()
})
