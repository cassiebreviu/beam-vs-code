import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { execOnBeam } from './tsh';
export const SECRET_KEY = 'beams.githubPat';


export interface GithubSetupOptions {
    beamId: string;
    username: string;
    email: string;
    authMethod: 'pat' | 'oauth' | 'tsh-git';
    pat?: string;
    cloneRepo?: string;
    cloneDir?: string;
}

const GH_INSTALL_SCRIPT = [
    'type -p wget >/dev/null || sudo apt update && sudo apt-get install wget -y',
    'sudo mkdir -p -m 755 /etc/apt/keyrings',
    'wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null',
    'sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg',
    'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli-stable.list > /dev/null',
    'sudo apt update',
    'sudo apt install gh -y',
].join('\n');

function execScriptOnBeam(beamId: string, script: string, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn('tsh', ['beams', 'exec', beamId, '--', 'bash', '-s'], {
            timeout,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
            } else {
                reject(new Error(`Script failed (exit ${code}): ${stderr || stdout}`));
            }
        });
        child.on('error', reject);
        child.stdin.write(`set -e\n${script}\n`);
        child.stdin.end();
    });
}

export async function setupGithubOnBeam(
    options: GithubSetupOptions,
    progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<void> {
    const { beamId, username, email, authMethod, pat, cloneRepo, cloneDir } = options;
    const timeout = 120000;

    progress.report({ message: 'Configuring git identity...' });
    await execOnBeam(beamId, ['git', 'config', '--global', 'user.name', username], timeout);
    await execOnBeam(beamId, ['git', 'config', '--global', 'user.email', email], timeout);

    if (authMethod === 'tsh-git') {
        progress.report({ message: 'Configuring Teleport git proxy...' });
        await execScriptOnBeam(beamId, 'tsh git config update', timeout);
    } else {
        progress.report({ message: 'Checking GitHub CLI...' });
        let ghInstalled = false;
        try {
            await execOnBeam(beamId, ['which', 'gh'], timeout);
            ghInstalled = true;
        } catch { /* not installed */ }

        if (!ghInstalled) {
            progress.report({ message: 'Installing GitHub CLI...' });
            await execScriptOnBeam(beamId, GH_INSTALL_SCRIPT, timeout);
        }

        if (authMethod === 'pat' && pat) {
            progress.report({ message: 'Authenticating with GitHub...' });
            const escapedPat = pat.trim().replace(/'/g, "'\\''");
            await execScriptOnBeam(beamId, `printf '%s' '${escapedPat}' | gh auth login -h github.com -p https --with-token`, timeout);
            progress.report({ message: 'Configuring git credential helper...' });
            await execScriptOnBeam(beamId, 'gh auth setup-git', timeout);
        }

        progress.report({ message: 'Configuring Teleport git proxy...' });
        await execScriptOnBeam(beamId, 'tsh git config update 2>/dev/null || true', timeout);
    }

    if (cloneRepo) {
        progress.report({ message: `Cloning ${cloneRepo}...` });
        const cloneCmd = authMethod === 'tsh-git'
            ? `git clone git@github.com:${cloneRepo}.git${cloneDir ? ` "${cloneDir}"` : ''}`
            : cloneDir
                ? `gh repo clone "${cloneRepo}" "${cloneDir}"`
                : `gh repo clone "${cloneRepo}"`;
        await execScriptOnBeam(beamId, cloneCmd, 300000);
    }
}

export async function isTshGitAvailable(beamId: string): Promise<boolean> {
    try {
        await execOnBeam(beamId, ['bash', '-c', 'tsh git config update'], 10000);
        return true;
    } catch {
        return false;
    }
}

export async function autoSetupGithub(
    beamId: string,
    context: vscode.ExtensionContext,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    force = false,
): Promise<{ applied: boolean; error?: string }> {
    const config = vscode.workspace.getConfiguration('beams');
    if (!force) {
        const autoSetup = config.get<boolean>('github.autoSetup', true);
        if (!autoSetup) {
            return { applied: false };
        }
    }

    const username = config.get<string>('github.username');
    const email = config.get<string>('github.email');
    const authMethod = config.get<string>('github.authMethod') as 'pat' | 'oauth' | 'tsh-git' | '';
    const defaultCloneRepo = config.get<string>('github.defaultCloneRepo');

    if (!username || !authMethod) {
        return { applied: false };
    }

    const pat = authMethod === 'pat' ? await context.secrets.get(SECRET_KEY) : undefined;
    if (authMethod === 'pat' && !pat) {
        return { applied: false, error: 'Stored PAT not found — run "Setup GitHub on Beam" to re-enter' };
    }

    if (authMethod === 'oauth') {
        try {
            await setupGithubOnBeam({
                beamId,
                username,
                email: email || `${username}@users.noreply.github.com`,
                authMethod: 'oauth',
            }, progress);
            openOAuthTerminal(beamId);
            return { applied: true };
        } catch (err) {
            return { applied: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    try {
        await setupGithubOnBeam({
            beamId,
            username,
            email: email || `${username}@users.noreply.github.com`,
            authMethod,
            pat,
            cloneRepo: defaultCloneRepo || undefined,
        }, progress);
        return { applied: true };
    } catch (err) {
        return { applied: false, error: err instanceof Error ? err.message : String(err) };
    }
}

export function openOAuthTerminal(beamId: string): void {
    const terminal = vscode.window.createTerminal({
        name: `gh auth - ${beamId}`,
        shellPath: 'tsh',
        shellArgs: ['beams', 'exec', beamId, '--', 'gh', 'auth', 'login', '-h', 'github.com', '-p', 'https', '-w'],
        iconPath: new vscode.ThemeIcon('mark-github'),
    });
    terminal.show();
}
