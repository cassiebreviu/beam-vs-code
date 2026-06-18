# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run compile        # one-shot TypeScript compile → out/
npm run dev            # watch mode, recompiles on save
npm run package        # compile + vsce package → teleport-beams-<version>.vsix
npm run install-local  # install the built .vsix into VS Code
```

There is no test suite and no linter configured. TypeScript compilation (`tsc`) is the only correctness check.

Press **F5** in VS Code to launch the Extension Development Host (reads `.vscode/launch.json`).

## Architecture

This is a VS Code extension that manages Teleport Beams — ephemeral sandbox VMs for agentic workloads. All source is in `src/`, compiled to `out/` (no bundler, just `tsc`).

### Core data flow

`tsh.ts` is the only file that shells out to the `tsh` CLI. Everything goes through two primitives:
- `execOnBeam(id, cmd[])` → runs `tsh beams exec <id> -- <cmd>` and returns stdout
- Direct `tsh` subcommands (`listBeams`, `addBeam`, `removeBeam`, etc.)

`BeamPoller` (`polling.ts`) is the real-time hub. On a selected beam it polls:
1. `git rev-parse HEAD && git status --porcelain=v1` on a configurable interval (default 5s)
2. `stat --format='%n %Y'` for any open `beam://` files (default 3s)

It notifies registered `PollConsumer` implementors. Polling pauses when VS Code loses focus and restarts on configuration changes.

### Key modules

| File | Role |
|------|------|
| `extension.ts` | Activation entry point — wires all providers together and registers the `beam://` and `beam-git://` filesystem schemes |
| `tsh.ts` | All tsh CLI interactions; defines the `Beam` and `TshStatus` types |
| `beamsProvider.ts` | `TreeDataProvider` for the Beams panel list |
| `beamFs.ts` | `FileSystemProvider` for `beam://` URIs — reads/writes remote files via `tsh beams exec` |
| `polling.ts` | `BeamPoller` — polls git status + file mtimes, fans out to consumers |
| `scm.ts` | `BeamGitScmProvider` — VS Code SCM panel, consumes porcelain output from BeamPoller |
| `scmCommands.ts` | Stage/unstage/commit/discard git commands over `tsh beams exec` |
| `activity.ts` | Parses Claude JSONL transcripts from `/home/beams/.claude/projects/` for token/cost display |
| `events.ts` | Streams chronological events from the same JSONL transcript |
| `ssh.ts` | Manages `~/.ssh/config` between `# BEGIN Teleport Beams` / `# END Teleport Beams` markers for Remote-SSH |
| `templates.ts` | Built-in and custom beam creation templates stored in VS Code global state |
| `commands.ts` | Registers all `beams.*` VS Code commands |
| `fileDecorations.ts` | Git status badge decorations on files in the file explorer |

### Virtual filesystem schemes

- **`beam://<beamId><remotePath>`** — writable; reads/writes go through `tsh beams exec cat` / `echo | base64 -d`
- **`beam-git://<beamId><remotePath>`** — read-only; serves HEAD version of files as the QuickDiff baseline

The `BeamGitScmProvider` implements `QuickDiffProvider.provideOriginalResource()` to map `beam://` URIs to their `beam-git://` counterparts, enabling VS Code's inline diff gutter.

### SSH config management

`ensureBeamSshConfig()` in `ssh.ts` writes per-beam entries into `~/.ssh/config`. It:
1. Normalizes `.beams.sh` cluster domains to `.beams.run`
2. Patches the `ProxyCommand` in any existing `tsh config` output to use `tsh proxy ssh` with the beam alias
3. Inserts specific `vscode+<beamId>.<cluster>` `Host` entries before wildcard entries so they match first

### Agent activity parsing

`activity.ts` reads the most-recently-modified JSONL file under `/home/beams/.claude/projects/` (excluding subagent dirs). It deduplicates token counts by `msg.id` (multiple JSONL lines share the same `id` for split content blocks) and matches `tool_use` blocks to their `tool_result` responses by `tool_use_id`.

### GitHub integration

Three auth methods are supported: `pat` (Personal Access Token stored in VS Code secrets), `oauth` (GitHub CLI browser flow), `tsh-git` (Teleport-managed proxy, no token needed). Preferences are stored in VS Code global configuration under `beams.github.*`.
