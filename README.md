# Teleport Beams - VS Code Extension

Manage and connect to Teleport Beams directly from VS Code. Create, monitor, and SSH into ephemeral sandbox VMs built for agentic workloads.

## Features

- **Beams sidebar** — list, create, and delete beams
- **File explorer** — browse beam files without SSH
- **Agent Activity** — live token usage, cost estimation, and tool call tracking
- **Agent Events** — chronological stream of Claude session events parsed from the JSONL transcript
- **Remote-SSH** — one-click VS Code Remote-SSH connection to any beam
- **Terminal** — open a tsh SSH session in the integrated terminal
- **Source Control** — stage, unstage, commit, discard, push, and open a pull request against a beam's repo from the native SCM panel
- **Templates** — provision new beams from built-in starter templates
- **Session Profiles** — checkpoint a task's git state + a summarized session memory so you can resume on a fresh beam where you left off (local prototype of the "Beams Task Profiles" RFD)
- **Local Debug Containers** — mirror a beam's workspace into a local Docker container for fast iteration
- **Export** — download beam files as a tar.gz archive
- **GitHub credentials** — PAT, OAuth, or Teleport Git Proxy authentication for git operations on beams

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

- **Save Session Profile** (right-click a beam in the **Beams** panel) — reads the beam's current git branch/commit, asks the `claude` CLI already running on that beam (`claude --continue -p`, read-only) to draft a summary of the session, then saves immediately and opens the saved `summary.md` so you can keep editing it in place. Falls back to a blank template seeded with recent git log/status if the auto-draft fails.
- **Update Session Profile** (from the panel's inline actions) — re-runs the same capture-and-save flow against an existing profile, regenerating its summary from the beam's current state.
- **Session Profiles** panel — lists saved profiles; click one to view its summary.
- **Resume Session Profile** (from the panel, or command palette) — pick a profile and a target beam (existing or new); it checks out the recorded branch/commit on that beam (cloning first if needed) and writes the summary to `.claude/session-memory/<task-id>.md` in the repo as well as the beam's Claude user memory, so a freshly started `claude` session already has the context loaded.
- **Delete Session Profile** — removes the local profile permanently.

Note: this MVP does not yet implement the RFD's scan-before-write/scan-before-load content check — summaries are treated as trusted local input for now.

## SSH Configuration

The extension automatically manages `~/.ssh/config` entries for beam connections. It:

- Uses the `.beams.sh` domain reported by `tsh status`
- Sets up a `ProxyCommand` that routes through `tsh proxy ssh` using the beam alias
- Migrates stale `.beams.run` entries automatically

## Commands

| Command | Description |
|---------|-------------|
| Beams: Login | Authenticate with Teleport |
| Beams: Create Beam | Create a new beam from a template |
| Beams: Delete Beam | Delete a beam |
| Beams: Open in VS Code (Remote-SSH) | Connect via Remote-SSH (opens a new window) |
| Beams: SSH into Beam | Open terminal session |
| Beams: Open Beam Files | Browse files remotely |
| Beams: Export as Zip | Download beam contents |
| Beams: Publish Beam / Unpublish Beam | Make a beam accessible via URL, or take it back down |
| Beams: Run on Beam | Run a command on a beam and publish its port |
| Beams: Setup GitHub on Beam | Configure git identity and GitHub auth (PAT, OAuth, or Teleport Git Proxy) |
| Beams: Commit / Push Branch / Create Pull Request | Git operations against a beam's repo from the SCM panel |
| Beams: Save Session Profile | Checkpoint a beam's git state + session summary |
| Beams: Update Session Profile | Regenerate an existing profile's summary from the beam's current state |
| Beams: Resume Session Profile | Restore a saved profile's git state + summary into a beam |
| Beams: View Session Profile | Open a saved profile's summary |
| Beams: Delete Session Profile | Remove a saved session profile |
| Beams: New Setup Profile | Save a reusable list of provisioning commands as a profile |
| Beams: Open/Sync/Rebuild/Delete Local Debug Container | Manage a local Docker mirror of a beam's workspace |

This is a representative list — see the Command Palette (`Cmd+Shift+P` → "Beams:") for the full set.

## Packaging

```bash
npm run package    # builds and produces teleport-beams-<version>.vsix
```

