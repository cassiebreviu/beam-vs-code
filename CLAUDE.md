# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run compile        # one-shot TypeScript compile → out/
npm run dev            # watch mode, recompiles on save
npm run package        # compile + vsce package → teleport-beams-<version>.vsix
npm run install-local  # install the built .vsix into VS Code
npm test                # compile + run test/*.test.js (node:test)
```

There is no linter configured. The test suite is minimal (currently just `test/ssh.test.js`, covering SSH config repair) — TypeScript compilation (`tsc`) remains the primary correctness check for everything else.

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
| `templates.ts` | Built-in beam creation template catalog consumed by `beams.create` and `localContainer.ts`'s Dockerfile generation (custom template capture was removed — see Session Profiles) |
| `commands.ts` | Registers all `beams.*` VS Code commands |
| `fileDecorations.ts` | Git status badge decorations on files in the file explorer |
| `sessionProfiles.ts` | Session Profiles storage (git ref + summary + metadata) and beam-side capture/apply helpers |
| `sessionProfilesProvider.ts` / `sessionProfileItem.ts` | `TreeDataProvider`/`TreeItem` for the Session Profiles panel |

### Virtual filesystem schemes

- **`beam://<beamId><remotePath>`** — writable; reads/writes go through `tsh beams exec cat` / `echo | base64 -d`
- **`beam-git://<beamId><remotePath>`** — read-only; serves HEAD version of files as the QuickDiff baseline

The `BeamGitScmProvider` implements `QuickDiffProvider.provideOriginalResource()` to map `beam://` URIs to their `beam-git://` counterparts, enabling VS Code's inline diff gutter.

### SSH config management

`ensureBeamSshConfig()` in `ssh.ts` writes per-beam entries into `~/.ssh/config`. It:
1. Uses the `.beams.sh` cluster domain reported by `tsh status`
2. Patches the `ProxyCommand` in any existing `tsh config` output to use `tsh proxy ssh` with the beam alias
3. Inserts specific `vscode--<beamId>.<cluster>` `Host` entries before wildcard entries so they match first

### Agent activity parsing

`activity.ts` reads the most-recently-modified JSONL file under `/home/beams/.claude/projects/` (excluding subagent dirs). It deduplicates token counts by `msg.id` (multiple JSONL lines share the same `id` for split content blocks) and matches `tool_use` blocks to their `tool_result` responses by `tool_use_id`.

### Session Profiles

Local prototype of the "Beams Task Profiles" RFD's `save-session`/`resume-session` workflow — `tsh` has no CLI support for this yet, so `sessionProfiles.ts` stores profiles entirely on the client under `~/.teleport/beams/session-profiles/<task-id>/{profile.json,summary.md}` rather than S3.

- **Save** (`beams.saveSessionProfile`): detects the repo root under `/home/beams` on the selected beam (git state capture is skipped, not an error, if none is found — e.g. a beam with no repo yet), captures `git rev-parse --abbrev-ref HEAD` + `git rev-parse HEAD` + `git config --get remote.origin.url`, then asks the beam's own `claude` CLI to draft the summary (`generateSessionSummary` in `sessionProfiles.ts`, via `claude --continue -p` at the default read-only permission mode, grounded with `git log`/`git status` output folded into the prompt). Falls back to a What was tried/Decisions made/What's left template (noting the specific auto-draft failure) if Claude produces nothing. Saves immediately — no confirmation step — then opens the saved `summary.md` itself (not a scratch buffer) so further edits go straight back to disk.
- **Update** (`beams.updateSessionProfile`, from the Session Profiles panel's inline actions): re-runs the same capture-and-save flow against a profile's stored `taskId`/`beamId` (prompting for a different beam only if the original one is gone), overwriting `profile.json`/`summary.md` in place — `createdAt`/`createdBy` are preserved. Works for both session and setup profiles.
- **Resume** (`beams.resumeSessionProfile`): if the target beam doesn't have the repo yet, clones it from the recorded `remoteUrl` first, then checks out the recorded branch/commit, then writes the summary two ways: `.claude/session-memory/<task-id>.md` in the repo (human-readable, layered on top of the repo's own `CLAUDE.md`), and — via `appendSessionSummaryToUserMemory` in `sessionProfiles.ts` — into `/home/beams/.claude/CLAUDE.md`, the beam's *user*-level memory file that Claude Code auto-loads into every session without being asked (unlike the per-repo file, which needs something to explicitly point at it). That append is idempotent, replacing an earlier `<!-- BEGIN/END session-memory:<task-id> -->` block for the same task instead of duplicating it. Because the context is already auto-loaded, opening a terminal afterward just runs plain `claude` — no initial "go read this file" prompt needed. (An earlier attempt tried synthesizing/replaying a Claude Code on-disk session transcript so the task would show up directly under `/resume`'s picker — that on-disk JSONL schema turned out to be too undocumented/fragile to reproduce reliably and was reverted; the user-memory approach here is the current mechanism for carrying context into a resumed session.)
- **Delete** (`beams.deleteSessionProfile`): removes the local profile directory.
- Per the RFD, code changes always go through the normal git/commit path — profiles carry summary + git ref only, never uncommitted diffs.
- The RFD's scan-before-write/scan-before-load content check is **not implemented** in this MVP; summaries are treated as trusted input.

### GitHub integration

Three auth methods are supported: `pat` (Personal Access Token stored in VS Code secrets), `oauth` (GitHub CLI browser flow), `tsh-git` (Teleport-managed proxy, no token needed). Preferences are stored in VS Code global configuration under `beams.github.*`.
