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

## Packaging

```bash
npm run package    # builds and produces teleport-beams-<version>.vsix
```

