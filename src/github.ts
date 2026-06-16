import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

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
