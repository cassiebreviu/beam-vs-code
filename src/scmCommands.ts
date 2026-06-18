import * as vscode from 'vscode';
import { execOnBeam } from './tsh';
import { BeamGitScmProvider } from './scm';
import { BeamPoller } from './polling';

export function registerScmCommands(
    context: vscode.ExtensionContext,
    getScm: () => BeamGitScmProvider | undefined,
    getPoller: () => BeamPoller | undefined,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('beams.showDiff', async (item?: { beamId?: string; path?: string; name?: string }) => {
            const poller = getPoller();
            if (!item?.beamId || !item?.path || !poller?.hasGitRepo()) return;

            const originalUri = vscode.Uri.parse(`beam-git://${item.beamId}${item.path}`);
            const workingUri = vscode.Uri.parse(`beam://${item.beamId}${item.path}`);
            const title = `${item.name ?? item.path.split('/').pop()} (Working Tree)`;
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
    );
}
