import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { execOnBeam } from './tsh';

const exec = promisify(execFile);
const SECRET_KEY = 'beams.githubPat';

export async function setupGitCredentials(sshHost: string, secrets: vscode.SecretStorage): Promise<void> {
    const username = vscode.workspace.getConfiguration('beams').get<string>('github.username');
    const pat = await secrets.get(SECRET_KEY);

    if (!username || !pat) {
        return;
    }

    const script = `git config --global credential.helper store && echo "https://${username}:${pat}@github.com" > ~/.git-credentials`;
    await exec('ssh', ['-o', 'StrictHostKeyChecking=no', sshHost, script], { timeout: 15000 });
}

export async function promptAndStoreGithubPat(secrets: vscode.SecretStorage): Promise<void> {
    const config = vscode.workspace.getConfiguration('beams');
    let username = config.get<string>('github.username');

    if (!username) {
        username = await vscode.window.showInputBox({
            prompt: 'Enter your GitHub username',
            placeHolder: 'octocat',
        });
        if (!username) {
            return;
        }
        await config.update('github.username', username, vscode.ConfigurationTarget.Global);
    }

    const pat = await vscode.window.showInputBox({
        prompt: 'Enter your GitHub Personal Access Token',
        password: true,
        placeHolder: 'ghp_... or github_pat_...',
    });
    if (!pat) {
        return;
    }
    await secrets.store(SECRET_KEY, pat);
    vscode.window.showInformationMessage('GitHub credentials saved. They will be applied to new beams automatically.');
}

export async function clearGithubPat(secrets: vscode.SecretStorage): Promise<void> {
    await secrets.delete(SECRET_KEY);
    vscode.window.showInformationMessage('GitHub PAT cleared.');
}

export interface GithubSetupOptions {
    beamId: string;
    username: string;
    email: string;
    authMethod: 'pat' | 'oauth';
    pat?: string;
    cloneRepo?: string;
    cloneDir?: string;
}

const GH_INSTALL_SCRIPT = [
    '(type -p wget >/dev/null || (sudo apt update && sudo apt-get install wget -y))',
    'sudo mkdir -p -m 755 /etc/apt/keyrings',
    'wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null',
    'sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg',
    'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli-stable.list > /dev/null',
    'sudo apt update && sudo apt install gh -y',
].join(' && ');

export async function setupGithubOnBeam(
    options: GithubSetupOptions,
    progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<void> {
    const { beamId, username, email, authMethod, pat, cloneRepo, cloneDir } = options;
    const timeout = 120000;

    progress.report({ message: 'Installing GitHub CLI...' });
    await execOnBeam(beamId, ['bash', '-c', GH_INSTALL_SCRIPT], timeout);

    progress.report({ message: 'Configuring git identity...' });
    await execOnBeam(beamId, ['bash', '-c', `git config --global user.name "${username}" && git config --global user.email "${email}"`], timeout);

    if (authMethod === 'pat' && pat) {
        progress.report({ message: 'Authenticating with GitHub...' });
        await execOnBeam(beamId, ['bash', '-c', `echo "${pat}" | gh auth login -h github.com -p https --with-token`], timeout);
    }

    progress.report({ message: 'Configuring Teleport git proxy...' });
    await execOnBeam(beamId, ['bash', '-c', 'tsh git config update 2>/dev/null || true'], timeout);

    if (cloneRepo) {
        progress.report({ message: `Cloning ${cloneRepo}...` });
        const cloneCmd = cloneDir
            ? `gh repo clone "${cloneRepo}" "${cloneDir}"`
            : `gh repo clone "${cloneRepo}"`;
        await execOnBeam(beamId, ['bash', '-c', cloneCmd], timeout);
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
