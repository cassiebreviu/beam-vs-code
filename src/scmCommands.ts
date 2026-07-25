import * as vscode from 'vscode';
import { execOnBeam } from './tsh';
import { BeamGitScmProvider } from './scm';
import { BeamPoller } from './polling';
import { toOwnerRepo } from './github';

export function registerScmCommands(
    context: vscode.ExtensionContext,
    getScm: () => BeamGitScmProvider | undefined,
    getPoller: () => BeamPoller | undefined,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('beams.showDiff', async (item?: { beamId?: string; path?: string; name?: string; entry?: { beamId?: string; path?: string; name?: string } }) => {
            const poller = getPoller();
            // Inline tree-item commands receive the FileItem itself, whose fields live
            // under `.entry` — fall back to that shape if the flat fields aren't present.
            const beamId = item?.beamId ?? item?.entry?.beamId;
            const path = item?.path ?? item?.entry?.path;
            const name = item?.name ?? item?.entry?.name;
            if (!beamId || !path || !poller?.hasGitRepo()) return;

            const originalUri = vscode.Uri.parse(`beam-git://${beamId}${path}`);
            const workingUri = vscode.Uri.parse(`beam://${beamId}${path}`);
            const title = `${name ?? path.split('/').pop()} (Working Tree)`;
            await vscode.commands.executeCommand('vscode.diff', originalUri, workingUri, title);
        }),

        vscode.commands.registerCommand('beams.gitStage', async (resourceState: vscode.SourceControlResourceState) => {
            const poller = getPoller();
            if (!poller?.getBeamId() || !poller.getRepoRoot()) return;
            const filePath = resourceState.resourceUri.path;
            await execOnBeam(poller.getBeamId()!, [
                'git', '-C', poller.getRepoRoot()!, 'add', filePath,
            ]);
            poller.pollNow();
        }),

        vscode.commands.registerCommand('beams.gitUnstage', async (resourceState: vscode.SourceControlResourceState) => {
            const poller = getPoller();
            if (!poller?.getBeamId() || !poller.getRepoRoot()) return;
            const filePath = resourceState.resourceUri.path;
            await execOnBeam(poller.getBeamId()!, [
                'git', '-C', poller.getRepoRoot()!, 'reset', 'HEAD', filePath,
            ]);
            poller.pollNow();
        }),

        vscode.commands.registerCommand('beams.gitDiscard', async (resourceState: vscode.SourceControlResourceState) => {
            const poller = getPoller();
            if (!poller?.getBeamId() || !poller.getRepoRoot()) return;

            const confirm = await vscode.window.showWarningMessage(
                `Discard changes to ${resourceState.resourceUri.path.split('/').pop()}?`,
                { modal: true },
                'Discard'
            );
            if (confirm !== 'Discard') return;

            const filePath = resourceState.resourceUri.path;
            await execOnBeam(poller.getBeamId()!, [
                'git', '-C', poller.getRepoRoot()!, 'checkout', '--', filePath,
            ]);
            poller.pollNow();
        }),

        vscode.commands.registerCommand('beams.gitCommit', async () => {
            const scm = getScm();
            const poller = getPoller();
            if (!scm || !poller?.getBeamId() || !poller.getRepoRoot()) return;

            const message = scm.inputBox.value.trim();
            if (!message) {
                vscode.window.showErrorMessage('Enter a commit message first.');
                return;
            }

            try {
                await execOnBeam(poller.getBeamId()!, [
                    'git', '-C', poller.getRepoRoot()!, 'commit', '-m', message,
                ]);
                scm.inputBox.value = '';
                poller.pollNow();
                vscode.window.showInformationMessage('Committed successfully.');
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Commit failed: ${err instanceof Error ? err.message : err}`);
            }
        }),

        vscode.commands.registerCommand('beams.gitRefreshScm', () => {
            getPoller()?.pollNow();
        }),

        vscode.commands.registerCommand('beams.gitPush', async () => {
            const poller = getPoller();
            const beamId = poller?.getBeamId();
            const repoRoot = poller?.getRepoRoot();
            if (!beamId || !repoRoot) return;

            try {
                const branch = (await execOnBeam(beamId, ['git', '-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `Pushing "${branch}"...` },
                    () => execOnBeam(beamId, ['git', '-C', repoRoot, 'push', '-u', 'origin', branch], 60000)
                );
                vscode.window.showInformationMessage(`Pushed "${branch}" to origin.`);
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Push failed: ${err instanceof Error ? err.message : err}`);
            }
        }),

        vscode.commands.registerCommand('beams.createPullRequest', async () => {
            const poller = getPoller();
            const beamId = poller?.getBeamId();
            const repoRoot = poller?.getRepoRoot();
            if (!beamId || !repoRoot) return;

            try {
                const branch = (await execOnBeam(beamId, ['git', '-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
                const remoteUrl = (await execOnBeam(beamId, ['git', '-C', repoRoot, 'config', '--get', 'remote.origin.url'])).trim();
                if (!remoteUrl) {
                    vscode.window.showErrorMessage('No git remote configured for this repo.');
                    return;
                }

                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `Pushing "${branch}"...` },
                    () => execOnBeam(beamId, ['git', '-C', repoRoot, 'push', '-u', 'origin', branch], 60000)
                );

                // Opens in the user's own authenticated browser session — avoids needing
                // `gh` installed/authenticated on the beam (not the case for tsh-git beams).
                const ownerRepo = toOwnerRepo(remoteUrl);
                const url = `https://github.com/${ownerRepo}/compare/${encodeURIComponent(branch)}?expand=1`;
                await vscode.env.openExternal(vscode.Uri.parse(url));
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Failed to open pull request: ${err instanceof Error ? err.message : err}`);
            }
        }),
    );
}
