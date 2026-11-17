# DCP 3.2.0 V2 parity preparation

DCP 3.2.0 already isolates V2 session state and serializes operations per session.
It does not persist message aliases or the native compaction epoch.
This vendor patch adds those missing V1 protections without replacing the upstream V2 adapter.

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
