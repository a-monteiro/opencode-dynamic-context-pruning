import { createReminderFilter, type ReminderFilter } from "./reminder-cleanup"

const MAX_PENDING_FRAME_BYTES = 256 * 1024

function dataValue(line: string): string | undefined {
    if (line === "data") return ""
    if (!line.startsWith("data:")) return undefined
    const value = line.slice(5)
    return value.startsWith(" ") ? value.slice(1) : value
}

interface Envelope {
    id?: string
    created?: number
    model?: string
}

export function filterChatCompletionsSse(response: Response): Response | undefined {
    const contentType = response.headers.get("content-type") ?? ""
    if (!response.ok || !response.body || !/^text\/event-stream(?:\s*;|\s*$)/i.test(contentType))
        return undefined

    const decoder = new TextDecoder("utf-8", { ignoreBOM: true })
    const encoder = new TextEncoder()
    const filters = new Map<number, ReminderFilter>()
    const roles = new Map<number, string>()
    let envelope: Envelope = {}
    let buffer = new Uint8Array(4096)
    let buffered = 0
    let passthrough = false
    let lineHasContent = false
    let afterCr = false
    let endAfterCr = false

    function filterFor(index: number): ReminderFilter {
        let filter = filters.get(index)
        if (!filter) {
            filter = createReminderFilter()
            filters.set(index, filter)
        }
        return filter
    }

    function synthetic(index: number, content: string): string {
        return `data: ${JSON.stringify({
            ...envelope,
            object: "chat.completion.chunk",
            choices: [{ index, delta: { content }, finish_reason: null }],
        })}\n\n`
    }

    function flushFilters(): string[] {
        const flushed: string[] = []
        for (const [index, filter] of filters) {
            const rest = filter.flush()
            if (rest) flushed.push(synthetic(index, rest))
        }
        filters.clear()
        return flushed
    }

    function processFrame(frame: string): { before: string[]; changed?: string } {
        const lines = frame.split(/(\r\n|\r|\n)/)
        const dataLines: number[] = []
        const values: string[] = []
        for (let i = 0; i < lines.length; i += 2) {
            const line = lines[i]!
            if (line.startsWith("event:") && !["", "message"].includes(line.slice(6).trim()))
                return { before: [] }
            const value = dataValue(line)
            if (value === undefined) continue
            dataLines.push(i)
            values.push(value)
        }
        if (!dataLines.length) return { before: [] }
        const data = values.join("\n")
        if (data.trim() === "[DONE]") {
            const before = flushFilters()
            roles.clear()
            return { before }
        }
        let parsed: any
        try {
            parsed = JSON.parse(data)
        } catch {
            return { before: [] }
        }
        if (parsed?.object !== "chat.completion.chunk" || parsed.error ||
            !Array.isArray(parsed.choices) || !parsed.choices.every((choice: any) =>
                choice && Number.isInteger(choice.index) && choice.index >= 0 &&
                (choice.delta === undefined || (choice.delta && typeof choice.delta === "object" && !Array.isArray(choice.delta)))))
            return { before: [] }
        envelope = {
            id: typeof parsed.id === "string" ? parsed.id : undefined,
            created: typeof parsed.created === "number" ? parsed.created : undefined,
            model: typeof parsed.model === "string" ? parsed.model : undefined,
        }
        let changed = false
        const before: string[] = []
        for (const choice of parsed.choices) {
            const index = choice.index
            if (typeof choice.delta?.role === "string") {
                roles.set(index, choice.delta.role)
                if (choice.delta.role !== "assistant") {
                    const rest = filters.get(index)?.flush()
                    filters.delete(index)
                    if (rest) before.push(synthetic(index, rest))
                }
            }
            const assistant = !roles.has(index) || roles.get(index) === "assistant"
            const content = choice.delta?.content
            let filtered = assistant && typeof content === "string" ? filterFor(index).push(content) : content
            if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
                const rest = filters.get(index)?.flush()
                filters.delete(index)
                roles.delete(index)
                if (rest) {
                    if (typeof content === "string" && assistant) filtered += rest
                    else before.push(synthetic(index, rest))
                }
            }
            if (filtered !== content) {
                choice.delta.content = filtered
                changed = true
            }
        }
        if (!changed) return { before }
        for (const [position, index] of dataLines.entries()) {
            const line = lines[index]!
            const prefix = line.startsWith("data: ") ? "data: " : "data:"
            lines[index] = prefix + (position === 0 ? JSON.stringify(parsed) : "")
        }
        return { before, changed: lines.join("") }
    }

    function append(bytes: Uint8Array): void {
        if (!bytes.length) return
        const length = buffered + bytes.length
        if (length > buffer.length) {
            const grown = new Uint8Array(Math.min(MAX_PENDING_FRAME_BYTES, Math.max(length, buffer.length * 2)))
            grown.set(buffer.subarray(0, buffered))
            buffer = grown
        }
        buffer.set(bytes, buffered)
        buffered = length
    }

    function emitFrame(controller: TransformStreamDefaultController<Uint8Array>): void {
        if (buffered) {
            const result = processFrame(decoder.decode(buffer.subarray(0, buffered)))
            for (const text of result.before) controller.enqueue(encoder.encode(text))
            controller.enqueue(result.changed === undefined ? buffer.slice(0, buffered) : encoder.encode(result.changed))
        }
        buffered = 0
        lineHasContent = false
        afterCr = false
        endAfterCr = false
    }

    function failOpen(controller: TransformStreamDefaultController<Uint8Array>, rest: Uint8Array): void {
        // An opaque frame invalidates grammar state for the rest of this response.
        for (const text of flushFilters()) controller.enqueue(encoder.encode(text))
        roles.clear()
        if (buffered) controller.enqueue(buffer.slice(0, buffered))
        buffered = 0
        passthrough = true
        controller.enqueue(rest)
    }

    const stream = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            if (passthrough) {
                controller.enqueue(chunk)
                return
            }
            let start = 0
            for (let i = 0; i < chunk.length; i++) {
                const byte = chunk[i]!
                if (endAfterCr) {
                    const end = byte === 10 ? i + 1 : i
                    if (buffered + end - start > MAX_PENDING_FRAME_BYTES) return failOpen(controller, chunk.subarray(start))
                    append(chunk.subarray(start, end))
                    emitFrame(controller)
                    start = end
                    if (byte === 10) continue
                }
                let ended = false
                if (afterCr && byte === 10) afterCr = false
                else {
                    afterCr = false
                    if (byte === 13) {
                        endAfterCr = !lineHasContent
                        afterCr = lineHasContent
                        lineHasContent = false
                    } else if (byte === 10) {
                        ended = !lineHasContent
                        lineHasContent = false
                    } else lineHasContent = true
                }
                if (buffered + i + 1 - start > MAX_PENDING_FRAME_BYTES) return failOpen(controller, chunk.subarray(start))
                if (ended) {
                    append(chunk.subarray(start, i + 1))
                    emitFrame(controller)
                    start = i + 1
                }
            }
            append(chunk.subarray(start))
        },
        flush(controller) {
            if (passthrough) return
            const unterminated = !endAfterCr && buffered > 0
            emitFrame(controller)
            const flushed = flushFilters()
            if (unterminated && flushed.length) controller.enqueue(encoder.encode("\n\n"))
            for (const text of flushed) controller.enqueue(encoder.encode(text))
            roles.clear()
        },
    })

    const headers = new Headers(response.headers)
    headers.delete("content-length")
    headers.delete("content-encoding")
    return new Response(response.body.pipeThrough(stream), {
        status: response.status,
        statusText: response.statusText,
        headers,
    })
}
