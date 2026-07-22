# Teleport Beams - VS Code Extension

Manage and connect to Teleport Beams directly from VS Code. Create, monitor, and SSH into ephemeral sandbox VMs built for agentic workloads.

## Features

- **Beams sidebar** — list, create, and delete beams
- **File explorer** — browse beam files without SSH
- **Agent Activity** — live token usage, cost estimation, and tool call tracking
- **Agent Events** — chronological stream of Claude session events parsed from the JSONL transcript
- **Remote-SSH** — one-click VS Code Remote-SSH connection to any beam
- **Terminal** — open a tsh SSH session in the integrated terminal
- **Templates** — save and reuse beam configurations
- **Session Profiles** — checkpoint a task's git state + a summarized session memory so you can resume on a fresh beam where you left off (local prototype of the "Beams Task Profiles" RFD)
- **Export** — download beam files as a tar.gz archive
- **GitHub credentials** — automatic PAT injection for git operations on beams

## Prerequisites

- [Teleport](https://goteleport.com/docs/installation/) (`tsh` CLI) installed and in your PATH
- Logged in to your Teleport cluster: `tsh login --proxy=<cluster>.beams.run`
- VS Code 1.85+

## Install from VSIX

```bash
# Clone and build
git clone https://github.com/cassiebreviu/beam-vs-code.git
cd beam-vs-code
npm install
npm run package

# Install the extension
code --install-extension teleport-beams-0.1.0.vsix
```

Or in VS Code: Extensions panel > `...` menu > "Install from VSIX..." and select the `.vsix` file.

## Development

```bash
npm install
npm run dev        # watch mode — recompiles on save
```

Press `F5` in VS Code to launch the Extension Development Host.

## Usage

1. Open the **Beams** panel in the activity bar (left sidebar).
2. Click **Login** (key icon) if not already authenticated.
3. Click **Create Beam** (+) to spin up a new VM.
4. Click a beam to select it — the Files, Agent Activity, and Agent Events panels populate.
5. Use the inline buttons on each beam:
   - `$(remote)` — open a Remote-SSH session in a new VS Code window
   - `$(terminal)` — open a tsh SSH terminal

## Session Profiles

A **Session Profile** is a per-task checkpoint of where you left off: the git branch/commit a task was on, plus a short markdown summary of what was tried, decisions made, and what's left. It's a local prototype of the RFD's `save-session` / `resume-session` workflow — profiles are stored under `~/.teleport/beams/session-profiles/<task-id>/` (not S3), and code changes always go through your normal git commit/push, never through the profile.

- **Save Session Profile** (right-click a beam in the **Beams** panel) — reads the beam's current git branch/commit, asks the `claude` CLI already running on that beam (`claude --continue -p`, read-only) to draft a summary of the session, then opens it in an editable markdown buffer for you to review/edit before saving. Falls back to a blank template seeded with recent git log/status if the auto-draft fails.
- **Session Profiles** panel — lists saved profiles; click one to view its summary.
- **Resume Session Profile** (from the panel, or command palette) — pick a profile and a target beam (existing or new); it checks out the recorded branch/commit on that beam and writes the summary to `.claude/session-memory/<task-id>.md` in the repo, layered on top of the repo's existing `CLAUDE.md`.
- **Delete Session Profile** — removes the local profile permanently.

Note: this MVP does not yet implement the RFD's scan-before-write/scan-before-load content check — summaries are treated as trusted local input for now.

## SSH Configuration

The extension automatically manages `~/.ssh/config` entries for beam connections. It:

- Rewrites `tsh config` output to use the correct `.beams.run` domain
- Sets up a `ProxyCommand` that routes through `tsh proxy ssh` using the beam alias
- Migrates stale `.beams.sh` entries automatically

## Commands

| Command | Description |
|---------|-------------|
| Beams: Login | Authenticate with Teleport |
| Beams: Create Beam | Create a new beam from a template |
| Beams: Open in VS Code (Remote-SSH) | Connect via Remote-SSH |
| Beams: SSH into Beam | Open terminal session |
| Beams: Open Beam Files | Browse files remotely |
| Beams: Export as Zip | Download beam contents |
| Beams: Publish Beam | Make beam accessible via URL |
| Beams: Set GitHub PAT | Store a GitHub token for credential injection |
| Beams: Save Session Profile | Checkpoint a beam's git state + session summary |
| Beams: Resume Session Profile | Restore a saved profile's git state + summary into a beam |
| Beams: Delete Session Profile | Remove a saved session profile |

## Packaging

```bash
npm run package    # builds and produces teleport-beams-<version>.vsix
```

