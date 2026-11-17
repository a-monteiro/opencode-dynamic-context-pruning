import type { WithParts } from "../state"

const OPEN = "dcp-system-reminder>"
const CLOSE = "/dcp-system-reminder>"
const MAX_INDENT = 32

export interface ReminderFilter {
    push(chunk: string): string
    flush(): string
}

export function createReminderFilter(): ReminderFilter {
    let suppressed = false
    let skipClosingNewline = false
    let skipLf = false
    let mode: "prefix" | "body" | "fence-run" | "fence-tail" = "prefix"
    let prefix = ""
    let fence: { char: string; length: number } | undefined
    let delimiter = ""
    let delimiterLength = 0
    let closingFence = false

    function finishDelimiter(): void {
        closingFence = !!fence && delimiter === fence.char && delimiterLength >= fence.length
        if (!fence && delimiterLength >= 3) fence = { char: delimiter, length: delimiterLength }
        mode = closingFence ? "fence-tail" : "body"
    }

    function finishLine(): void {
        if (mode === "fence-run") finishDelimiter()
        if (mode === "fence-tail" && closingFence) fence = undefined
        mode = "prefix"
        prefix = ""
        closingFence = false
    }

    return {
        push(chunk: string): string {
            let out = ""
            for (const char of chunk) {
                if (skipLf) {
                    skipLf = false
                    if (char === "\n") continue
                }
                if (skipClosingNewline) {
                    skipClosingNewline = false
                    if (char === "\n" || char === "\r") {
                        skipLf = char === "\r"
                        finishLine()
                        continue
                    }
                }
                if (char === "\n" || char === "\r") {
                    if (!suppressed) out += prefix + char
                    finishLine()
                    continue
                }
                if (mode === "fence-run") {
                    out += char
                    if (char === delimiter) delimiterLength++
                    else {
                        finishDelimiter()
                        if (char !== " " && char !== "\t") mode = "body"
                    }
                    continue
                }
                if (mode === "fence-tail") {
                    out += char
                    if (char !== " " && char !== "\t") mode = "body"
                    continue
                }
                if (mode === "body") {
                    if (!suppressed) out += char
                    continue
                }
                prefix += char
                const rest = prefix.replace(/^[ \t]*/, "")
                const indent = prefix.length - rest.length
                if (indent > MAX_INDENT) {
                    if (!suppressed) out += prefix
                    prefix = ""
                    mode = "body"
                    continue
                }
                if (!rest) continue
                if (!suppressed && indent <= 3 && !prefix.slice(0, indent).includes("\t") &&
                    (rest === "`" || rest === "~")) {
                    out += prefix
                    prefix = ""
                    delimiter = rest
                    delimiterLength = 1
                    mode = "fence-run"
                    continue
                }
                const marker = suppressed ? CLOSE : OPEN
                const lower = rest.toLowerCase()
                if ((suppressed || !fence) && (marker.startsWith(lower) || `<${marker}`.startsWith(lower))) {
                    if (lower !== marker && lower !== `<${marker}`) continue
                    suppressed = !suppressed
                    skipClosingNewline = !suppressed
                } else if (!suppressed) out += prefix
                prefix = ""
                mode = "body"
            }
            return out
        },
        flush(): string {
            const out = suppressed ? "" : prefix
            finishLine()
            suppressed = false
            skipClosingNewline = false
            skipLf = false
            fence = undefined
            return out
        },
    }
}

export function stripReminderBlocks(text: string): string {
    const filter = createReminderFilter()
    return filter.push(text) + filter.flush()
}

export function stripReminderBlocksFromMessages(messages: WithParts[]): void {
    for (const message of messages) {
        if (message.info?.role !== "assistant") continue
        for (const part of message.parts) {
            if (part.type === "text" && typeof part.text === "string")
                part.text = stripReminderBlocks(part.text)
        }
    }
}
