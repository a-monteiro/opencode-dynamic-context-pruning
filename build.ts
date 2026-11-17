import { build } from "bun"

const result = await build({
    entrypoints: [new URL("./index.ts", import.meta.url).pathname],
    outdir: new URL("./dist", import.meta.url).pathname,
    target: "node",
    format: "esm",
    external: ["@opencode/plugin", "@anthropic-ai/tokenizer", "jsonc-parser", "jsonc-parser/*", "zod"],
    sourcemap: "external",
})
if (!result.success) throw new AggregateError(result.logs, "DCP V2 build failed")
