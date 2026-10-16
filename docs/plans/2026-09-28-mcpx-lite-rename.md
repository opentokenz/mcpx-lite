# Rename project to mcpx-lite

## Goal

Rename the active project identity to `mcpx-lite` across its package, commands, MCP metadata, runtime configuration, installation, and current documentation. This is an intentionally breaking change for historical configuration and session data.

## Context

The current identity appears in package metadata and build artifacts, the installed command, MCP server/client metadata, runtime prompts and messages, `MINI_PI_MCP_*` environment variables, the default `~/.mini-pi-mcp` directory, the Windows workflow, and installer tests. The working tree also contains the previously implemented daemon startup changes; those changes must be preserved while their names and defaults are updated.

## Decisions

- Use `mcpx-lite` as the package, executable, installed command, build artifact prefix, and MCP server identity; name the downstream client `mcpx-lite-gateway`.
- Replace configuration variables with `MCPX_LITE_HOST`, `MCPX_LITE_PORT`, `MCPX_LITE_HOME`, `MCPX_LITE_GLOBAL_SKILLS`, and `MCPX_LITE_LOG`. Do not read legacy `MINI_PI_MCP_*` variables.
- Set the default data directory to `~/.mcpx-lite`. Do not import, migrate, read, or delete data from `~/.mini-pi-mcp`.
- Rename the packaged-binary test variable to `MCPX_LITE_BINARY`. Do not install a `mini-pi-mcp` alias or delete pre-existing installed binaries outside the repository.
- Keep the repository directory and historical `docs/plans/` records unchanged. Keep the package version and default port `29090` unchanged.
- A previously running instance that uses the old data directory is not discoverable through the new runtime record; users must stop it once manually before the new instance can bind the same port.

## Rationale

The user requested a clean, incompatible rename. A new data directory and configuration namespace make the break explicit. Leaving the old directory untouched avoids destructive cleanup while ensuring the new runtime does not silently continue using historical sessions.

## Alternatives Considered

- Keep the old environment variables and data directory while changing only the product name. This would minimize migration work but would not complete the requested breaking rename.
- Rename all identifiers and automatically migrate the old data directory. This adds migration behavior the user explicitly declined.

## Scope

### In

- Rename package metadata, build artifacts, installer target, MCP identities, runtime messages/prompts/control endpoint identifiers, environment variables, default home, current README, Windows workflow, and related tests.
- Preserve the existing foreground/background CLI behavior and port while moving runtime state and logs under the new home directory.

### Out

- Renaming the checkout directory, rewriting historical plans, publishing the package, changing the version/port, migrating or deleting old user data, and removing old binaries already installed outside the repository.

## Design

- `loadConfig` reads only the `MCPX_LITE_*` variables and defaults the home directory to `~/.mcpx-lite`.
- The installer builds and installs `mcpx-lite`; platform artifacts use `mcpx-lite-<platform>-<arch>` names, with `.exe` on Windows.
- MCP server/client metadata and user-visible runtime text use `mcpx-lite`; daemon state and logs continue to use `runtime.json` and `daemon.log` under the configured new home.
- Update active documentation and CI references. Preserve old-name references only in historical plan documents or explicit tests proving old variables are ignored.

## Acceptance Criteria

- The package, installed CLI, artifacts, MCP server identity, and runtime-facing documentation consistently use `mcpx-lite`.
- Each `MCPX_LITE_*` variable configures the same setting as before; legacy `MINI_PI_MCP_*` variables have no effect.
- With no explicit home, the runtime uses `~/.mcpx-lite`; old session data remains untouched and is not loaded.
- Daemon start/stop and automatic replacement continue to work using the new home and control identifiers.
- Installer fixtures and the Windows packaged-binary workflow use the renamed artifact and command.

## Test Strategy

- Add/update config tests for new variable names, the new default home, and ignored legacy variables.
- Update MCP identity and CLI startup tests to assert the renamed server/client names and binary environment variable.
- Update installer tests for all supported macOS/Linux targets and the new installed filename; update Windows CI artifact selection.
- Run `pnpm test`, `pnpm typecheck`, build the current host executable, and run packaged startup/daemon tests with `MCPX_LITE_BINARY` set.

## Implementation Plan

1. Write failing tests for the new configuration namespace, default home, MCP metadata, installer names, and ignored legacy variables.
2. Rename package/build/install/CI identifiers and update MCP identities and runtime-facing strings while preserving daemon behavior.
3. Update the README and active test fixtures; review the complete tracked and untracked diff, preserving prior daemon changes and leaving historical plans untouched.
4. Run the full test suite, typecheck, host build, and packaged executable startup/daemon tests.

## Verification

- Confirm RED failures identify old naming/config behavior before implementation, then confirm GREEN after each subsystem change.
- Confirm `pnpm test`, `pnpm typecheck`, the host build, and packaged CLI smoke tests pass.
- Run `git diff --check` and inspect the full diff, including untracked files and generated artifacts.
