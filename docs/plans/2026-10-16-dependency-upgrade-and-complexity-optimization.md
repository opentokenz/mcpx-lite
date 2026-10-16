# Dependency upgrade, dead-code removal, and duplication reduction

## Goal

Bring the runtime and toolchain dependencies up to their current releases, remove production code that no
longer has a caller, and remove the duplicated helper logic that the current tree carries. Each of the three
steps must be independently verifiable and independently revertible, and no step may change observable tool
behaviour except where explicitly listed below.

## Context

Baseline measured on the current working tree (2026-10-16, Node v26.12.0, pnpm 12.5.1):

- `pnpm test`: 312 passed, 14 skipped, 33 passed files, 2 skipped files, 6.39s.
- `pnpm typecheck`: clean. TypeScript 6.0.3 checks 449 files in 0.64s using 195 MB.
- Source is 6,094 lines across 34 files; tests are 6,989 lines across 37 files.
- `node_modules` is 112 MB. Heaviest entries are `typescript` (24 MB), the rolldown platform binding
  (16 MB), `esbuild` plus its platform binary (20 MB), `lightningcss` (8.2 MB), `zod` (8.0 MB),
  `@modelcontextprotocol/client` (6.6 MB), `@modelcontextprotocol/server` (6.3 MB).

Per-request and per-call cost measured on the same tree: `buildServer` costs 0.368 ms (of which
`createTools` is 0.003 ms), `SessionStore.list` over 200 sessions costs 5.8 ms, `SkillIndex.scan` costs
1.20 ms, `analyzeShellCommand` costs 2.5 µs, and rendering one 400-character log line through the ANSI
helpers costs about 10.7 µs. None of these is a bottleneck at the load this gateway serves, so this plan
does not change any runtime hot path.

The working tree already contains uncommitted work: `src/daemon.ts`, `src/runtime-control.ts`,
`test/cli.test.ts`, `test/runtime-control.test.ts`, `docs/plans/2026-09-28-mcpx-lite-rename.md`, and
modifications to 27 tracked files. This plan builds on that work and preserves its rename and daemon
behaviour. Some files overlap: the dependency ranges, Node minimum, CI and README are updated, and the
existing `closeServer` helper in `src/runtime-control.ts` is exported for reuse.

## Decisions

1. **Upgrade the three `@modelcontextprotocol/*` packages as one unit.** `@modelcontextprotocol/node@2.1.1`
   declares `@modelcontextprotocol/server: ^2.3.0` as a peer, so the node adapter cannot move without the
   server package. Move `client` and `server` to `^2.3.1` and `node` to `^2.1.1`. The exported surface the
   project uses is additive-only across that range: comparing the 2.1.0 and 2.3.1 declaration files shows
   no removals, two additions (`McpServerOptions`, `VerifyBearerTokenOptions`), an unchanged client export
   set, unchanged declarations for `toNodeHandler`, `localhostHostValidation` and
   `localhostOriginValidation`, and the same supported protocol versions (`2025-11-25`, `2026-07-28`).

2. **Move `typescript` to `^7.0.2`.** TypeScript 7 is the native compiler, distributed as platform
   binaries through 20 optional dependencies. Verified in a throwaway copy at `/tmp/tstest` (source copied,
   `node_modules` symlinked) that it accepts the existing `tsconfig.json` unchanged, checks all 449 files,
   and reports injected type errors identically to 6.0.3. Total check time drops from 0.64s to 0.088s and
   memory from 195 MB to 137 MB.

3. **Move `vitest` to `^5.0.5`, `zod` to `^4.6.7`, and `@types/node` to `^26.6.5`.** The first two are
   patch releases inside their existing caret ranges. `@types/node` moves to the version matching the local
   Node v26.12.0 runtime. The user has confirmed Node 22 does not need support, so update
   `package.json` to `engines: { node: ">=24" }`, update the Windows CI runtime from Node 22 to Node 24,
   and update the README's Node requirement to `>=24`. The shipped artifacts are Bun-compiled binaries
   and do not require Node at all; Node is only needed to run from source and for tests and typecheck.

4. **Wire the two never-called cleanup functions instead of deleting them.**
   `McpTrustStore.clearSession` and `McpManager.closeScope` were both introduced in the initial MCP gateway
   commit and have no caller anywhere in `src/` or `test/`. They form an obvious pair intended for the
   `session close` path. Wiring them closes a real resource leak: today a stdio downstream MCP server's
   child process stays alive until the whole runtime exits, even after its session is closed. The
   user-visible consequence is that `session close` followed by `session resume` requires a fresh MCP
   approval card. If the user prefers to keep trust across close and resume, the alternative is to delete
   both functions and accept that downstream connections live until process exit.

5. **Do not cache the downstream tool list for `mcp_tool call`.** The redundant `listTools()` round trip per
   `call` stays as it is, so `mcp_tool` behaviour and downstream request counts are unchanged.

6. **Do not restructure the `registry.ts` type erasure.** The four `any` occurrences in `src/` all live in
   `registry.ts`, where `defineTool` erases a heterogeneous tool array into one shape. Per-tool inference
   already works at each definition site, so handlers are checked against their own schemas. Removing the
   erasure would move the same cast to the call site without adding real safety, so the plan leaves it.

7. **Do not consolidate the two MCP server-display implementations.** `displayServer` in
   `src/tools/mcp-tool.ts` deliberately reads the unresolved `EffectiveMcpServer`, because
   `resolveMcpServerConfig` throws on a missing environment variable and the `list` action must stay a
   read-only summary that cannot fail that way. The duplication is intentional.

## Rationale

The dependency step is safe to do first because the MCP SDK surface the project uses is additive-only
between 2.1.0 and 2.3.1, and because the compiler change is verifiable in isolation through
`pnpm typecheck`. Doing it first means the later refactor steps are verified under the versions the project
will actually ship. Deleting dead code before consolidating duplication keeps the consolidation diff small
and keeps the test suite's pass/fail signal meaningful.

## Alternatives Considered

- **Refactor first, then upgrade.** Produces a cleaner upgrade diff, but mixes a compiler change that can
  alter type-check outcomes with structural edits, making a failure harder to bisect.
- **One combined change.** Runs CI once, but any failure requires splitting the work anyway to find it.
- **Delete `closeScope` and `clearSession` instead of wiring them.** Smaller diff, but leaves downstream
  child processes running after their session closes.
- **Keep Node 22 support.** The user confirmed Node 22 need not be supported; retaining it would make the
  declared runtime floor and Windows CI inconsistent with the chosen `@types/node@26`.
- **Delete `padToWidth` and `GATEWAY_INSTRUCTIONS` only when a real consumer needs to change.** Deferring
  leaves two exported symbols whose only consumers are tests, which invites accidental use of the stale
  frozen copy of the gateway instructions.

## Scope

### In

- Upgrade `@modelcontextprotocol/client`, `@modelcontextprotocol/server`, `@modelcontextprotocol/node`,
  `typescript`, `vitest`, `zod`, and `@types/node`; reconcile `pnpm-workspace.yaml` release-age exclusions.
- Delete `src/mcp-connector.ts` and `test/mcp-connector.test.ts`.
- Delete `padToWidth` from `src/ansi.ts` and its test block; delete `GATEWAY_INSTRUCTIONS` from
  `src/session.ts` and point its test at `createGatewayInstructions()`.
- Wire `McpManager.closeScope` and `McpTrustStore.clearSession` into the `session close` path.
- Bound the `SessionStore.chains` map so a long-running daemon does not retain one promise per session
  ever touched.
- Extract the shared `session`/`read_resource`/`get_prompt`/`call`/`inspect` preamble in
  `src/tools/mcp-tool.ts` into one helper.
- Consolidate `isInsideWorkspace`/`isAncestor`, `metadata()` (session and skills tools), the three
  `errorMessage` helpers plus eight inline copies, and the `server.close` promise wrapper.

### Out

- Changes to daemon or rename behaviour beyond the agreed Node minimum and dependency/metadata updates;
  the existing uncommitted feature changes are preserved.
- The `mcp_tool` tool-list cache, the `registry.ts` type erasure, and the two MCP display implementations
  (see Decisions 5, 6 and 7).
- `read` reading a whole file to compute `totalLines` for large offsets, and `trash` invoking its backend
  once per path — both are deliberate trade-offs, not defects.
- Constructing a fresh `McpServer` per request (measured at 0.368 ms, of which `createTools` is 0.003 ms).
- Supporting Node versions below 24.
- README `src/` tree completeness beyond the removal of `mcp-connector.ts`.

## Design

**Step 1 — dependencies.** Update the seven `package.json` ranges, regenerate `pnpm-lock.yaml`, and update
the `minimumReleaseAgeExclude` list in `pnpm-workspace.yaml` so the new `@types/node`, `vitest`,
`@vitest/mocker`, and `@vitest/spy` versions are not blocked if a minimum release age is in force. Verify
that the TypeScript 7 platform binaries for `darwin-arm64`, `linux-x64`, `linux-arm64`, `win32-x64`, and
`win32-arm64` all resolve in the lockfile, because `.github/workflows/windows.yml` installs with
`require-lockfile: true` on `windows-latest`.

**Step 2 — dead code and leaks.** `src/mcp-connector.ts` is a second, divergent implementation of the
downstream client: it wraps `Client` separately from `src/mcp-client.ts`, lacks the Windows `.cmd`/`.bat`
launch handling that `mcp-client.ts` performs through `buildWindowsBatchLaunch`, and is imported only by
its own test. Removing it removes 131 production lines and 163 test lines and leaves one client wrapper.
`SessionStore.queue` will delete its chain entry once the queued promise settles and the entry is still the
latest; the unit test inspects the private map through reflection instead of adding a production getter.
The `session close` action gains the two cleanup calls in the order "close downstream connections, then
clear trust".

**Step 3 — duplication.** The `mcp_tool` preamble helper takes the server name and the approval inputs and
returns either an `approval_required` result or the resolved connection, which removes the four copies of
the same ten-line sequence and the risk of a branch that forgets the project-connection approval. The four
small helpers move to the module that already owns the concept: the workspace containment test stays in
`src/session.ts`, `skillMetadata` moves to `src/skills.ts`, `errorMessage` moves to `src/errors.ts`, and
`closeServer` is exported from `src/runtime-control.ts` for reuse by `src/index.ts`.

## Acceptance Criteria

- `pnpm test` passes with no new failures and no test deleted other than those covering removed code.
- `pnpm typecheck` is clean under TypeScript 7 with `tsconfig.json` unchanged.
- `package.json`, the README and Windows CI consistently require/run Node 24 or newer; `pnpm start`
  starts, serves `POST /mcp`, and `--daemon` / `--stop` still work.
- No file in `src/` or `test/` references `mcp-connector`, `padToWidth`, or `GATEWAY_INSTRUCTIONS`.
- `session close` closes that session's downstream MCP connections and clears its MCP trust grants.
- `SessionStore` retains no chain entry after a queued operation settles.
- MCP server identity, protocol version `2026-07-28`, all nine tool schemas, every approval card text, and
  the number of downstream requests `mcp_tool call` issues are unchanged.

## Test Strategy

- **Step 1** changes no behaviour, so no new tests: the existing 312-test suite plus `pnpm typecheck` are
  the verification. Any failure here is a version incompatibility, not a missing test.
- **Step 2** gets RED tests first for both behaviour changes: a test asserting `SessionStore` drains its
  internal chain map after `appendHistory` resolves, and a test asserting `session close` closes the
  session's downstream MCP connection and forces a fresh approval after `session resume`. The deletions
  change no behaviour and are verified by grepping for the removed symbols plus a green suite.
- **Step 3** is behaviour-preserving, so the existing suite is the regression net; the extraction must not
  change any assertion in `test/mcp-tool.test.ts`.
- Run the trash smoke test separately only if `trash` behaviour is touched; this plan does not touch it.

## Implementation Plan

1. **Step 1.** Update the seven dependency ranges and Node minimum version in `package.json`, README, and
   Windows CI; regenerate the lockfile, reconcile `minimumReleaseAgeExclude`, then run `pnpm typecheck`
   and `pnpm test`.
2. **Step 2a.** Write the RED test for `SessionStore.chains` draining, confirm it fails, then implement the
   bound and confirm GREEN.
3. **Step 2b.** Write the RED tests for `session close` releasing downstream connections and trust, confirm
   they fail, then wire `closeScope` and `clearSession` and confirm GREEN.
4. **Step 2c.** Delete `src/mcp-connector.ts`, `test/mcp-connector.test.ts`, `padToWidth` and its test
   block, and `GATEWAY_INSTRUCTIONS` with its test block repointed; confirm the suite is GREEN and the
   symbols are unreferenced.
5. **Step 3.** Extract the `mcp_tool` preamble helper and the four shared helpers; confirm the suite is
   unchanged and GREEN.
6. Review the complete diff including untracked files, then run the final verification.

## Verification

- On Node 24.21.0, `pnpm typecheck` passed and `pnpm test` passed: 32 files, 310 passed and 14 skipped.
- Built `dist/mcpx-lite-macos-arm64`; with `MCPX_LITE_BINARY` set, `test/server-startup.test.ts` passed all
  6 source and packaged-runtime startup/daemon tests.
- `pnpm install --frozen-lockfile`, `pnpm dedupe --check`, and `git diff --check` passed.
- All six TypeScript 7 platform package entries required by macOS, Linux, and Windows are in the lockfile;
  removed symbols and the second MCP connector implementation have no remaining references.
- The temporary TypeScript 7 comparison measured a 0.088s compiler total versus 0.64s for TypeScript 6.0.3;
  the repository `pnpm typecheck` also passes under the installed TypeScript 7 toolchain.
