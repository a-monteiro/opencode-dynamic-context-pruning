import assert from "node:assert/strict"
import test from "node:test"

const { stripReminderBlocks, stripReminderBlocksFromMessages, createReminderFilter } = await import(
    "../lib/v2/reminder-cleanup"
)
const { filterChatCompletionsSse } = await import("../lib/v2/sse-reminder")

// Built from char codes so tooling that strips marker characters from source
// cannot corrupt the fixture.
const LT = String.fromCharCode(60)
const GT = String.fromCharCode(62)
const OPEN = `${LT}dcp-system-reminder${GT}`
const CLOSE = `${LT}/dcp-system-reminder${GT}`
const SENTENCE = "If your subagent-related conversation needs to be compressed"

// ---------------------------------------------------------------- helper (batch)

test("a complete reminder block is removed and surrounding prose kept", () => {
    const text = `before\n${OPEN}\nbody line one\nbody line two\n${CLOSE}\nafter\n`
    assert.equal(stripReminderBlocks(text), "before\nafter\n")
})

test("an unclosed reminder tail is removed at EOF", () => {
    const text = `answer stays\n${OPEN}\nreminder body that never closes`
    assert.equal(stripReminderBlocks(text), "answer stays\n")
})

test("a bare marker without the leading angle bracket is recognized", () => {
    const text = `prose\n${OPEN.slice(1)}\nbody\n${CLOSE.slice(1)}\ntail`
    assert.equal(stripReminderBlocks(text), "prose\ntail")
})

test("a marker at the very start of the text is recognized", () => {
    const text = `${OPEN}\nbody\n${CLOSE}\ntail`
    assert.equal(stripReminderBlocks(text), "tail")
    assert.equal(stripReminderBlocks(`${OPEN}\nbody with no closer`), "")
})

test("markers embedded midline and fenced code are preserved", () => {
    const midline = `see ${OPEN} inline and ${CLOSE} here`
    assert.equal(stripReminderBlocks(midline), midline)

    const fenced = [
        "example:",
        "```",
        `${OPEN}`,
        "quoted reminder example",
        `${CLOSE}`,
        "```",
        "done",
    ].join("\n")
    assert.equal(stripReminderBlocks(fenced), fenced)

    const double = `before\n${OPEN}\n${SENTENCE}\n${CLOSE}\nafter\n${OPEN}\nagain\n${CLOSE}\nend`
    assert.equal(stripReminderBlocks(double), "before\nafter\nend")
})

test("ordinary text and repeated transforms are untouched", () => {
    const text = "mail me at a@b.com, see <https://x.dev>, and 1 < 2\nthen a normal line"
    assert.equal(stripReminderBlocks(text), text)
    const once = stripReminderBlocks(`x\n${OPEN}\nbody\n${CLOSE}\ny`)
    assert.equal(stripReminderBlocks(once), once)
})

test("real fixture: answer plus 127 echoed fragments yields the answer only", () => {
    const answer = "Final answer: 42.\n"
    const echoed = answer + `${OPEN}\n` + (SENTENCE + "\n").repeat(127)
    const cleaned = stripReminderBlocks(echoed)
    assert.equal(cleaned, answer)
    assert.ok(!cleaned.includes(SENTENCE))
})

test("only assistant text parts are sanitized", () => {
    const reminder = `${OPEN}\nbody\n${CLOSE}`
    const messages: any[] = [
        { info: { role: "user" }, parts: [{ type: "text", text: `u ${reminder}` }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: `a\n${reminder}\nb` }] },
        {
            info: { role: "assistant" },
            parts: [
                {
                    type: "tool",
                    tool: "bash",
                    state: { status: "completed", output: `t ${reminder}` },
                },
            ],
        },
    ]
    stripReminderBlocksFromMessages(messages)
    assert.equal(messages[0].parts[0].text, `u ${reminder}`)
    assert.equal(messages[1].parts[0].text, "a\nb")
    assert.equal(messages[2].parts[0].state.output, `t ${reminder}`)
})

// ---------------------------------------------------------------- SSE streaming

const chunk = (content: unknown, index = 0) =>
    `data: ${JSON.stringify({
        id: "chatcmpl",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
        choices: [{ index, delta: { content }, finish_reason: null }],
    })}\n\n`
const finish = (index = 0) =>
    `data: ${JSON.stringify({
        id: "chatcmpl",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
        choices: [{ index, delta: {}, finish_reason: "stop" }],
    })}\n\n`
const DONE = "data: [DONE]\n\n"

function streamResponse(
    parts: Array<string | Uint8Array>,
    headers: Record<string, string> = {},
): Response {
    const encoder = new TextEncoder()
    return new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                for (const part of parts)
                    controller.enqueue(typeof part === "string" ? encoder.encode(part) : part)
                controller.close()
            },
        }),
        {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "text/event-stream", ...headers },
        },
    )
}

function collectDeltas(text: string, index = 0): string {
    let out = ""
    for (const frame of text.replace(/\r\n/g, "\n").split(/\n\n/)) {
        const values = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => (line[5] === " " ? line.slice(6) : line.slice(5)))
        if (values.length === 0) continue
        const data = values.join("\n")
        if (data === "[DONE]") continue
        let parsed: any
        try {
            parsed = JSON.parse(data)
        } catch {
            continue
        }
        for (const choice of parsed.choices ?? [])
            if ((choice.index ?? 0) === index && typeof choice.delta?.content === "string")
                out += choice.delta.content
    }
    return out
}

async function runSse(
    parts: Array<string | Uint8Array>,
    headers?: Record<string, string>,
): Promise<Response> {
    const response = filterChatCompletionsSse(streamResponse(parts, headers))
    if (!response) throw new Error("expected a filtered SSE response")
    return response
}

test("real fixture streams only the answer, at every split offset and one byte at a time", async () => {
    const answer = "Final answer: 42.\n"
    const payload = chunk(answer) + chunk(`${OPEN}\n` + (SENTENCE + "\n").repeat(127)) + finish() + DONE
    const bytes = new TextEncoder().encode(payload)

    const respond = async (pieces: Uint8Array[]): Promise<string> => {
        const out = await runSse(pieces)
        assert.ok(out)
        return out.text()
    }

    assert.equal(collectDeltas(await respond([bytes])), answer)

    for (let offset = 0; offset <= bytes.length; offset++) {
        const text = await respond([bytes.slice(0, offset), bytes.slice(offset)])
        assert.equal(collectDeltas(text), answer, `offset ${offset}`)
        assert.ok(!text.includes(SENTENCE), `offset ${offset} leaked reminder body`)
    }

    const oneByte = await respond(Array.from(bytes, (byte) => Uint8Array.of(byte)))
    assert.equal(collectDeltas(oneByte), answer)
    assert.ok(!oneByte.includes(SENTENCE))
})

test("a closed reminder keeps the prose that follows", async () => {
    const out = await runSse([chunk(`before\n${OPEN}\nbody\n${CLOSE}\nafter\n`), finish(), DONE])
    assert.ok(out)
    assert.equal(collectDeltas(await out.text()), "before\nafter\n")
})

test("each choice keeps an independent filter", async () => {
    const out = await runSse([
        chunk("keep\n", 0) + chunk("clean ", 1),
        chunk(`${OPEN}\nblocked\n`, 0) + chunk("reply", 1),
        finish(0) + finish(1),
        DONE,
    ])
    assert.ok(out)
    const text = await out.text()
    assert.equal(collectDeltas(text, 0), "keep\n")
    assert.equal(collectDeltas(text, 1), "clean reply")
})

test("flush emits ordinary pending prefixes on finish, DONE and EOF", async () => {
    for (const tail of [finish() + DONE, DONE, ""]) {
        const out = await runSse([chunk("done\n<"), tail])
        assert.ok(out)
        assert.equal(collectDeltas(await out.text()), "done\n<")
    }

    for (const prefix of ["dcp", "<dc", "/dc", "   ", OPEN.slice(0, 8)]) {
        for (const tail of [finish() + DONE, DONE, ""]) {
            const out = await runSse([chunk(`done\n${prefix}`), tail])
            assert.ok(out)
            assert.equal(collectDeltas(await out.text()), `done\n${prefix}`)
        }
    }
})

test("non-content fields, comments and unknown frames pass through unchanged", async () => {
    const toolFrame =
        `data: ${JSON.stringify({
            id: "chatcmpl",
            object: "chat.completion.chunk",
            choices: [
                {
                    index: 0,
                    delta: {
                        tool_calls: [{ index: 0, id: "call", function: { name: "bash", arguments: "" } }],
                    },
                    finish_reason: null,
                },
            ],
        })}\n\n`
    const usageFrame =
        `data: ${JSON.stringify({
            id: "chatcmpl",
            object: "chat.completion.chunk",
            choices: [],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        })}\n\n`
    const reasoningFrame =
        `data: ${JSON.stringify({
            id: "chatcmpl",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { reasoning: "think" }, finish_reason: null }],
        })}\n\n`
    const malformed = "data: {not json}\n\n"
    const out = await runSse([
        ": OPENROUTER PROCESSING\n\n",
        chunk("hi"),
        toolFrame,
        reasoningFrame,
        malformed,
        usageFrame,
        finish(),
        DONE,
    ])
    assert.ok(out)
    const text = await out.text()
    assert.ok(text.includes(": OPENROUTER PROCESSING"))
    assert.ok(text.includes('"tool_calls"'))
    assert.ok(text.includes('"arguments":""'))
    assert.ok(text.includes('"reasoning":"think"'))
    assert.ok(text.includes("{not json}"))
    assert.ok(text.includes('"total_tokens":8'))
    assert.ok(text.includes('"finish_reason":"stop"'))
    assert.ok(text.includes("data: [DONE]"))
    assert.equal(collectDeltas(text), "hi")
})

test("CRLF frames and multiple data lines are handled", async () => {
    const crlf = (value: string) => value.split("\n").join("\r\n")
    const filtered =
        crlf(
            `data: ${JSON.stringify({
                id: "c",
                object: "chat.completion.chunk",
                choices: [
                    {
                        index: 0,
                        delta: { content: `x\n${OPEN}\ny\n${CLOSE}\nz` },
                        finish_reason: null,
                    },
                ],
            })}`,
        ) + "\r\n\r\n"
    const multi = `data: {"id":"c","object":"chat.completion.chunk",\r\ndata: "choices":[]}\r\n\r\n`
    const out = await runSse([filtered, multi, "data: [DONE]\r\n\r\n"])
    assert.ok(out)
    const text = await out.text()
    assert.equal(collectDeltas(text), "x\nz")
    assert.ok(text.includes('"choices":[]'))
})

test("non-SSE and error responses are left alone", async () => {
    const json = filterChatCompletionsSse(streamResponse([chunk("x")], { "content-type": "application/json" }))
    assert.equal(json, undefined)

    const empty = new Response(null, { status: 204, headers: { "content-type": "text/event-stream" } })
    assert.equal(filterChatCompletionsSse(empty), undefined)

    const error = new Response(chunk("x"), {
        status: 500,
        headers: { "content-type": "text/event-stream" },
    })
    assert.equal(filterChatCompletionsSse(error), undefined)
})

test("rewriting drops stale length and encoding headers but keeps the rest", async () => {
    const out = await runSse([chunk("hello"), finish(), DONE], {
        "content-length": "999",
        "content-encoding": "gzip",
        "x-request-id": "abc",
    })
    assert.ok(out)
    assert.equal(out.headers.get("content-length"), null)
    assert.equal(out.headers.get("content-encoding"), null)
    assert.equal(out.headers.get("x-request-id"), "abc")
    assert.equal(out.status, 200)
    assert.equal(out.statusText, "OK")
    assert.ok(/text\/event-stream/.test(out.headers.get("content-type") ?? ""))
})

test("the first frame is readable before the stream closes", async () => {
    const encoder = new TextEncoder()
    let upstream!: ReadableStreamDefaultController<Uint8Array>
    const out = filterChatCompletionsSse(
        new Response(new ReadableStream<Uint8Array>({ start(controller) { upstream = controller } }), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
        }),
    )
    if (!out?.body) throw new Error("expected a readable SSE body")
    const reader = out.body.getReader()
    upstream.enqueue(encoder.encode(chunk("first")))
    const first = await reader.read()
    assert.ok(new TextDecoder().decode(first.value).includes("first"))
    upstream.enqueue(encoder.encode(finish() + DONE))
    upstream.close()
    await reader.cancel()
})

test("cancelling the rewritten stream cancels upstream", async () => {
    let cancelled = false
    const out = filterChatCompletionsSse(
        new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(chunk("x")))
                },
                cancel() {
                    cancelled = true
                },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    )
    if (!out?.body) throw new Error("expected a readable SSE body")
    await out.body.cancel()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(cancelled, true)
})

test("the filter is a reusable bounded state machine", () => {
    const filter = createReminderFilter()
    assert.equal(filter.push("plain text, no markers"), "plain text, no markers")
    assert.equal(filter.flush(), "")
    const split = createReminderFilter()
    assert.equal(split.push(`${OPEN.slice(0, 6)}`), "")
    assert.equal(split.push(`${OPEN.slice(6)}\nbody`), "")
    assert.equal(split.flush(), "")
})

test("F1: ambiguous opener prefixes and stray closers remain literal", () => {
    for (const text of ["dcp", "<dc", "/dc", "   ", OPEN.slice(0, -1), CLOSE])
        assert.equal(stripReminderBlocks(text), text)
})

test("F2: full fence runs and invalid closing suffixes preserve quoted markers", () => {
    for (const delimiter of ["`", "~"]) {
        for (const length of [4, 20, 10000]) {
            const fence = delimiter.repeat(length)
            const text = `${fence}markdown\n${delimiter.repeat(3)}\n${OPEN}\nquoted\n${CLOSE}\n${fence}suffix\n${OPEN}\nquoted again\n${CLOSE}\n${fence}\n`
            const filter = createReminderFilter()
            let streamed = ""
            for (const char of text) streamed += filter.push(char)
            assert.equal(streamed + filter.flush(), text)
            assert.equal(stripReminderBlocks(text), text)
        }
    }
})

test("F3: same-frame finishes append pending text in each choice's order", async () => {
    const frame = `data: ${JSON.stringify({
        object: "chat.completion.chunk",
        choices: [0, 1].map((index) => ({
            index, delta: { content: `hello ${index}\nd`, reasoning: "keep" }, finish_reason: "stop",
        })),
        usage: { total_tokens: 8 },
    })}\n\n`
    const out = await runSse([frame, DONE])
    assert.ok(out)
    const text = await out.text()
    for (const index of [0, 1]) assert.equal(collectDeltas(text, index), `hello ${index}\nd`)
    assert.ok(text.includes('"reasoning":"keep"'))
    assert.ok(text.includes('"total_tokens":8'))
})

test("F4: changed multi-data events retain all other SSE lines and delimiters", async () => {
    const prefix = ": comment\r\nevent: message\r\nid: 7\r\nretry: 100\r\ncustom: keep\r\n"
    const frame = `${prefix}data: {"object":"chat.completion.chunk",\r\ndata: "choices":[{"index":0,"delta":{"content":${JSON.stringify(`hi\n${OPEN}\nbody\n${CLOSE}\ntail`)}},"finish_reason":null}]}\r\n\r\n`
    const out = await runSse([frame, DONE])
    assert.ok(out)
    const text = await out.text()
    assert.ok(text.startsWith(prefix))
    assert.ok(text.includes("\r\n\r\n"))
    assert.equal(collectDeltas(text), "hi\ntail")
})

test("F5: delimiter-free streams emit losslessly before consuming four MiB", async () => {
    let pulls = 0
    const size = 64 * 1024
    const response = new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
            pulls++
            controller.enqueue(new TextEncoder().encode("x".repeat(size)))
            if (pulls === 64) controller.close()
        },
    }), { headers: { "content-type": "text/event-stream" } })
    const out = filterChatCompletionsSse(response)
    if (!out?.body) throw new Error("expected a readable SSE body")
    const reader = out.body.getReader()
    const first = await reader.read()
    assert.ok(pulls < 16, `consumed ${pulls} chunks before first output`)
    let bytes = first.value?.length ?? 0
    for (;;) {
        const next = await reader.read()
        if (next.done) break
        assert.ok(next.value.every((byte) => byte === 120))
        bytes += next.value.length
    }
    assert.equal(bytes, 4 * 1024 * 1024)
})

test("F6: unknown protocols and explicit non-assistant roles remain unchanged", async () => {
    const literal = `${OPEN}\nbody\n${CLOSE}\n`
    const unknown = `event: response.audit\ndata: ${JSON.stringify({
        object: "audit.record", choices: [{ index: 0, delta: { content: literal }, finish_reason: null }],
    })}\n\n`
    const user = `data: ${JSON.stringify({
        object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "user", content: literal }, finish_reason: null }],
    })}\n\n`
    const following = chunk(literal)
    const out = await runSse([unknown, user, following, finish(), DONE])
    assert.ok(out)
    assert.equal(await out.text(), unknown + user + following + finish() + DONE)
})

test("case-insensitive indented markers work across every content split", () => {
    for (const newline of ["\n", "\r\n"]) {
        const text = `before${newline} \t${OPEN.toUpperCase()}${newline}body${newline}  ${CLOSE.toUpperCase()}${newline}after`
        for (let offset = 0; offset <= text.length; offset++) {
            const filter = createReminderFilter()
            assert.equal(filter.push(text.slice(0, offset)) + filter.push(text.slice(offset)) + filter.flush(), `before${newline}after`)
        }
    }
})

test("fenced Unicode literals remain byte-identical across one-byte SSE input", async () => {
    const literal = `~~~markdown\n${OPEN}\nquoted 🙂 café\n${CLOSE}\n~~~suffix\n${OPEN}\nquoted again\n${CLOSE}\n~~~\n`
    const payload = chunk(literal) + finish() + DONE
    const bytes = new TextEncoder().encode(payload)
    const out = await runSse(Array.from(bytes, (byte) => Uint8Array.of(byte)))
    assert.ok(out)
    assert.equal(await out.text(), payload)
})

test("oversized valid tool arguments and the remaining response pass losslessly", async () => {
    const argumentsText = "x".repeat(400 * 1024) + "🙂"
    const tool = `id: large\r\ndata: ${JSON.stringify({
        object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [
            { index: 0, function: { name: "example", arguments: argumentsText } },
        ] }, finish_reason: null }],
    })}\r\n\r\n`
    const following = chunk(`keep\n${OPEN}\nbody\n${CLOSE}\nafter`) + finish() + DONE
    const bytes = new TextEncoder().encode(tool + following)
    for (const size of [bytes.length, 8192, 257]) {
        const pieces: Uint8Array[] = []
        for (let offset = 0; offset < bytes.length; offset += size) pieces.push(bytes.subarray(offset, offset + size))
        const out = await runSse(pieces)
        assert.ok(out)
        const text = await out.text()
        assert.ok(text.startsWith(tool))
        assert.equal(text === tool + following, true)
        assert.equal(collectDeltas(text), `keep\n${OPEN}\nbody\n${CLOSE}\nafter`)
    }
})

function crlfToolFrame(length: number): string {
    const build = (argumentsText: string) => `data: ${JSON.stringify({
        object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [
            { index: 0, function: { name: "example", arguments: argumentsText } },
        ] }, finish_reason: null }],
    })}\r\n\r\n`
    const frame = build("x".repeat(length - build("").length))
    assert.equal(new TextEncoder().encode(frame).length, length)
    return frame
}

for (const delta of [-1, 0, 1, 2]) {
    test(`CRLF frame at cap${delta ? (delta < 0 ? delta : `+${delta}`) : ""} completes without overflow for every chunk layout`, async () => {
        const cap = 256 * 1024
        const tool = crlfToolFrame(cap + delta)
        const prefix = `start\n${LT}dcp`
        const later = `\nkeep\n${OPEN}\nbody\n${CLOSE}\nafter`
        const following = chunk(later) + finish() + DONE
        const encoder = new TextEncoder()
        const head = encoder.encode(chunk(prefix))
        const bytes = encoder.encode(chunk(prefix) + tool + following)
        const splitCrLf = head.length + cap + delta - 1
        const layouts: Record<string, Uint8Array[]> = {
            single: [bytes],
            "split final CR/LF": [bytes.subarray(0, splitCrLf), bytes.subarray(splitCrLf)],
            "4096 bytes": [],
        }
        for (let offset = 0; offset < bytes.length; offset += 4096) layouts["4096 bytes"]!.push(bytes.subarray(offset, offset + 4096))
        const filter = createReminderFilter()
        const sanitized = filter.push(prefix + later) + filter.flush()
        assert.ok(!sanitized.includes(OPEN))
        for (const [name, pieces] of Object.entries(layouts)) {
            const text = await (await runSse(pieces)).text()
            assert.equal(text.split(tool).length, 2, `${name}: tool frame must appear unchanged exactly once`)
            if (delta > 0) {
                assert.ok(text.endsWith(tool + following), `${name}: response-wide passthrough after overflow`)
                assert.equal(collectDeltas(text), prefix + later, name)
            } else {
                assert.equal(collectDeltas(text), sanitized, name)
            }
        }
    })
}

test("oversize fallback flushes earlier ambiguous text before passing the frame", async () => {
    const large = chunk("x".repeat(300 * 1024))
    const out = await runSse([chunk("start\ndcp"), large, chunk("end"), finish(), DONE])
    assert.ok(out)
    assert.equal(collectDeltas(await out.text()), "start\ndcp" + "x".repeat(300 * 1024) + "end")
})

test("CR-only and mixed SSE delimiters preserve unchanged events", async () => {
    const payload = chunk("hello").replaceAll("\n", "\r") + ": comment\r\n\r" + DONE
    const bytes = new TextEncoder().encode(payload)
    for (let offset = 0; offset <= bytes.length; offset++) {
        const out = await runSse([bytes.subarray(0, offset), bytes.subarray(offset)])
        assert.ok(out)
        assert.equal(await out.text(), payload)
    }
})

test("unknown named events and Responses envelopes are byte-identical", async () => {
    const literal = `${OPEN}\nbody\n${CLOSE}\n`
    for (const object of [undefined, "response.output_text.delta", "audit.record"]) {
        const body = `data: ${JSON.stringify({ object, choices: [{ index: 0, delta: { content: literal } }] })}\n\n`
        const out = await runSse([body])
        assert.ok(out)
        assert.equal(await out.text(), body)
    }
    const body = `event: response.audit\n${chunk(literal)}`
    const out = await runSse([body])
    assert.ok(out)
    assert.equal(await out.text(), body)
})

test("an unterminated final event flushes ambiguous prose in order", async () => {
    const out = await runSse([chunk("hello\n<dc").trimEnd()])
    assert.ok(out)
    assert.equal(collectDeltas(await out.text()), "hello\n<dc")
})

test("upstream errors propagate without emitting incomplete reminder text", async () => {
    const failure = new Error("upstream failed")
    const source = new ReadableStream<Uint8Array>({
        pull(controller) { controller.error(failure) },
    })
    const out = filterChatCompletionsSse(new Response(source, { headers: { "content-type": "text/event-stream" } }))
    if (!out) throw new Error("expected a filtered SSE response")
    await assert.rejects(out.text(), (error: unknown) => error === failure)
})

for (const kind of ["midline", "fence"]) {
    test(`R1: oversize fallback preserves subsequent ${kind} literals`, async () => {
        const before = kind === "midline" ? "Normal prose " : "````markdown\n"
        const after = kind === "midline" ? `${OPEN.slice(1)} literal\n` : `${OPEN}\nquoted body\n${CLOSE}\n` + "````\n"
        const tool = `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{
            index: 0, delta: { tool_calls: [{ index: 0, function: { name: "example", arguments: "x".repeat(300 * 1024) } }] }, finish_reason: null,
        }] })}\n\n`
        const subsequent = chunk(after) + chunk(`${OPEN}\nintentional passthrough\n${CLOSE}\n`) + finish() + DONE
        const out = await runSse([chunk(before), tool, subsequent])
        assert.ok(out)
        assert.equal(await out.text() === chunk(before) + tool + subsequent, true, "response must remain byte-identical after fallback")
    })
}

test("response-wide passthrough preserves backpressure and cancellation", async () => {
    let pulls = 0
    let cancelled = false
    const bytes = new TextEncoder().encode("x".repeat(64 * 1024))
    const out = filterChatCompletionsSse(new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
            pulls++
            controller.enqueue(bytes)
        },
        cancel() { cancelled = true },
    }), { headers: { "content-type": "text/event-stream" } }))
    if (!out?.body) throw new Error("expected a readable SSE body")
    const reader = out.body.getReader()
    await reader.read()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.ok(pulls < 16, `passthrough consumed ${pulls} chunks without downstream reads`)
    await reader.cancel()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(cancelled, true)
})

test("response-wide passthrough propagates later upstream errors", async () => {
    const failure = new Error("upstream failed after fallback")
    let pulls = 0
    const out = filterChatCompletionsSse(new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
            if (pulls++ === 0) controller.enqueue(new TextEncoder().encode("x".repeat(300 * 1024)))
            else controller.error(failure)
        },
    }), { headers: { "content-type": "text/event-stream" } }))
    if (!out) throw new Error("expected a filtered SSE response")
    await assert.rejects(out.text(), (error: unknown) => error === failure)
})
