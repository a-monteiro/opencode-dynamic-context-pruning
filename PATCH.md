# DCP 3.2.0 V2 parity preparation

DCP 3.2.0 already isolates V2 session state and serializes operations per session.
It does not persist message aliases or the native compaction epoch.
This vendor patch adds those missing V1 protections without replacing the upstream V2 adapter.

Persisted files add `messageIds.byRawId`, `messageIds.nextRef`, and `lastCompaction`.
Loading rebuilds the inverse map, validates compact aliases, and keeps counters above restored aliases.
Legacy files still load. Compact counters can exceed the V1 XML limit of 9999.
New native compaction discards stale aliases, compression blocks, tools, and nudges before restoring disk state.
Compaction detection also works when history contains only a checkpoint.

The V2 context hook saves aliases before returning the model-visible messages.
Compression checks the epoch before V2 loading can reset state, then checks again after fetching tool history.
Stale calls and retries fail until a fresh context hook exposes aliases.
Empty alias maps also block compression after a restart, rather than allocating potentially misleading aliases from raw history.
The upstream session queues remain intact. A separate disk queue preserves snapshot order and waits for writes before reads.

OpenCode 2.0.21 changed native media parts to `Media.Asset`.
The projection reads that asset's MIME type and inline data URL or remote URL without downloading it.
Restoration retains the original media object and provider metadata.
Compaction leaves `event.options`, including prepopulated `maxTokens`, unchanged.

## Reply cleanup and message-id injection

Ported upstream PR #634. `experimental.text.complete` now cleans the streamed reply
with the session's ID format, so compact `@N@` refs a model echoes are removed
instead of surviving the XML-only rules (#632). Trailing runs of degenerate tag
debris such as `<<`, a bare `<` or `<m0477` are also stripped (#562); the rule is
anchored to the end of the reply and needs two or more bracket-only lines, so a
lone bracket in prose, markdown or code is untouched.

Upstream issue #614 is present in this vendored copy through completed tool parts.
Injection appends the id tag to a tool output, and cleanup strips the tag but keeps
the newline that precedes it. Re-appending without normalizing therefore adds one
newline to every mid-conversation completed tool output on each request, so prior
messages never stay byte-identical and the prompt prefix cache cannot hold.
`appendToToolPart` now trims trailing newlines before appending, matching
`appendToTextPart`. The streaming and compression-rebuild mechanisms named in #614
did not reproduce here; text parts, XML refs and compact refs already round-trip.

## In-progress assistant messages

A V2 assistant message spans several steps, so the store clears its completion
time until the final step lands. Nudges anchored on that message were injected
into the reply as it streamed, and the model then saw them as part of its own
output. The projection now carries the store's completion time, and nudge
injection redirects a target that is still in progress to the last user message.

## Minimum visible range size

`compress.minRangeTokens` (default 0, off) rejects a range-mode batch before any
state mutation when a selected range covers fewer visible tokens than the floor.
The measurement counts only currently visible content: messages already active in
a compression are skipped, pruned tool payloads are excluded, and each visible
active summary is counted once through its `summaryTokens`. A malformed value is
treated as 0 so a bad config cannot block every compression, and the whole batch
is rejected with the measured tokens and floor so the model can widen across
closed or stale history or skip; the model must not widen into active history
purely to reach the floor.
Active context-limit anchors bypass the floor so emergency compression still works.
A vendored `dcp.schema.json` adds the property to the intact upstream schema, and
`dcp.jsonc` points `$schema` at that file's local absolute path and enables
`minRangeTokens: 20000`.

## Checks

Run from the vendored copy in the dotfiles repo:

```sh
bun install
bun run build.ts
node --import tsx --test tests/dcp-reminder-cleanup.test.ts
bun test ./tests/parity.test.ts
bun test ./tests/min-range-tokens.test.ts
../../node_modules/.bin/tsc --noEmit -p tsconfig.patch.json
```

The build bundles the upstream V1 tool helper, so the built runtime does not need a root V1 SDK dependency.
Its Zod import resolves through the native plugin SDK, which uses the same schema version as the upstream helper.
Restore this vendor's declared development dependencies with `bun install` here before rebuilding.
Run each vendored test suite separately: their temporary config environments are process-wide.
The TypeScript check covers the patched server source and V2 entry shim, not the TUI.

`scripts/vendor-dcp-v2.ts` copied the cached 3.2.0 package and recovered `index.ts` from its shipped source map.
It refuses to overwrite an existing vendor directory. Do not rerun it over this patch.
`build.ts` uses the established Bun workflow to regenerate `dist/index.js` and its source map.
The upstream public declaration remains unchanged; the added persistence fields are internal.
The license remains upstream's original. Package metadata omits the upstream `tests/logger` workspace, matching the published archive this patch was replayed from.
The root npm `typecheck` and `test` scripts still pass `--workspace=tests/logger`, so use the Bun and `tsc -p` commands above instead.

Tests use temporary config and storage, mock the public V2 context, and load the built runtime through the V2-only shim.
They cover successful compression after restart, interleaved sessions, queue recovery, stale refs, malformed persistence, and write failures.
Compaction tests preserve a native checkpoint and compression whose origin remains in the retained tail.
They verify `maxTokens` remains 16384. They do not make provider requests or prove live server hook ordering.
`tests/dcp-reply-cleanup.test.ts` covers the reply cleanup above and the injection
round-trip in both formats; five of its assertions fail on the unpatched sources.
`tests/dcp-reminder-cleanup.test.ts` covers the reminder state machine and the
OpenRouter SSE rewrite, including split-at-every-offset and one-byte streams.
`tests/parity.test.ts` exercises the V2 context hook and the scoped `http.response`
registration end to end.

## Caller handoff

Configure the native local plugin entry:

```text
<opencode-config>/plugins/local/dcp
```

That shim exposes only the upstream V2 `setup`, not the legacy V1 server function.
Do not load both the shim and the stock DCP package.
Settings live in `<opencode-config>/dcp.jsonc`; custom prompts live in its sibling `dcp-prompts/overrides/` directory.

The server watches `dist/index.js` and hot-reloads DCP when it changes, so build in a
scratch copy and swap the built files in atomically rather than building in place.
The queues protect one plugin instance, not multiple processes sharing a DCP storage directory.
Persistence failures retain upstream behavior: log the failure without failing the turn.
