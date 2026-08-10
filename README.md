# Teleport Beams - VS Code Extension

Manage and connect to Teleport Beams directly from VS Code. Create, monitor, and SSH into ephemeral sandbox VMs built for agentic workloads.

## Features

- **Beams sidebar** — list, create, and delete beams
- **File explorer** — browse beam files without SSH
- **Agent Activity** — live token usage, cost estimation, and tool call tracking
- **Agent Events** — chronological stream of Claude session events
- **Remote-SSH** — one-click VS Code Remote-SSH connection to any beam
- **Terminal** — open a tsh SSH session in the integrated terminal
- **Source Control** — stage, unstage, commit, discard, push, and open PRs from the native SCM panel
- **Templates** — provision new beams from built-in starter templates
- **Session Profiles** — checkpoint a task's git state + session summary so you can resume on a fresh beam
- **Local Debug Containers** — mirror a beam's workspace into a local Docker container
- **Export** — download beam files as a tar.gz archive
- **GitHub credentials** — PAT, OAuth, or Teleport Git Proxy authentication for git operations

## Prerequisites

- A Beams account — sign up at [beams.run](https://www.beams.run/)
- [Teleport](https://goteleport.com/docs/installation/) (`tsh` CLI) installed and in your PATH
- Logged in to your Teleport cluster: `tsh login --proxy=<cluster>.beams.sh`
- VS Code 1.85+

## Install from VSIX

```bash
# Clone and build
git clone https://github.com/cassiebreviu/beam-vs-code.git
cd beam-vs-code
npm install
npm run package

# Install the extension (filename matches the version in package.json)
code --install-extension teleport-beams-<version>.vsix
```

Or in VS Code: Extensions panel > `...` menu > "Install from VSIX..." and select the `.vsix` file.

## Development

```bash
npm install
npm run dev        # watch mode — recompiles on save
npm run compile    # one-shot TypeScript compile
npm test           # compile + run tests
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

A **Session Profile** checkpoints where you left off on a task: the git branch/commit plus a short markdown summary of what was tried, decisions made, and what's left. Profiles are stored locally under `~/.teleport/beams/session-profiles/<task-id>/`. Code changes always go through your normal git commit/push flow.

- **Save** (right-click a beam) — captures git state and auto-drafts a summary via the beam's `claude` CLI, then opens `summary.md` for editing.
- **Update** (inline action on an existing profile) — re-captures from the beam's current state.
- **Resume** (command palette or panel) — checks out the recorded branch/commit on a target beam and injects the summary into Claude's session memory.
- **Delete** — removes the local profile.

## Commands

| Command | Description |
|---------|-------------|
| Beams: Login | Authenticate with Teleport |
| Beams: Create Beam | Create a new beam from a template |
| Beams: Delete Beam | Delete a beam |
| Beams: Open in VS Code (Remote-SSH) | Connect via Remote-SSH |
| Beams: SSH into Beam | Open terminal session |
| Beams: Open Beam Files | Browse files remotely |
| Beams: Export as Zip | Download beam contents |
| Beams: Publish / Unpublish Beam | Make a beam accessible via URL |
| Beams: Run on Beam | Run a command on a beam and publish its port |
| Beams: Setup GitHub on Beam | Configure git identity and GitHub auth |
| Beams: Commit / Push / Create Pull Request | Git operations from the SCM panel |
| Beams: Save / Update / Resume / Delete Session Profile | Session profile management |
| Beams: Local Debug Container (Open/Sync/Rebuild/Delete) | Manage a local Docker mirror |

See the Command Palette (`Cmd+Shift+P` → "Beams:") for the full set.

## Packaging

```bash
npm run package    # builds and produces teleport-beams-<version>.vsix
```
