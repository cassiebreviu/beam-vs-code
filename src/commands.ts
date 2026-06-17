import * as vscode from 'vscode';
import { BeamItem } from './beamItem';
import { BeamsProvider } from './beamsProvider';
import { BeamFileExplorer } from './fileExplorer';
import { addBeam, removeBeam, publishBeam, unpublishBeam, execOnBeam, scpFromBeam, checkStatus } from './tsh';
import { openBeamTerminal } from './terminal';
import { getAllTemplates, saveCustomTemplate, deleteCustomTemplate, getCustomTemplates } from './templates';
import { setupGitCredentials, promptAndStoreGithubPat, clearGithubPat } from './github';
import { ensureBeamSshConfig } from './ssh';
import { AgentActivityProvider } from './activity';
import { AgentEventsProvider } from './events';
import * as path from 'path';

export function registerCommands(
    context: vscode.ExtensionContext,
    provider: BeamsProvider,
    fileExplorer: BeamFileExplorer,
    activityProvider: AgentActivityProvider,
    eventsProvider: AgentEventsProvider
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('beams.select', (item: BeamItem) => {
            if (!item?.beam) {
                return;
            }
            fileExplorer.setBeam(item.beam);
            activityProvider.setBeam(item.beam);
            eventsProvider.setBeam(item.beam);
        }),

        vscode.commands.registerCommand('beams.refresh', () => {
            provider.refresh();
        }),

        vscode.commands.registerCommand('beams.login', async () => {
            const cluster = await vscode.window.showInputBox({
                prompt: 'Teleport cluster proxy address',
                placeHolder: 'example.teleport.sh',
            });
            if (!cluster) {
                return;
            }
            const terminal = vscode.window.createTerminal({
                name: 'tsh login',
                shellPath: process.platform === 'win32' ? 'tsh.exe' : 'tsh',
                shellArgs: ['login', `--proxy=${cluster}`],
                iconPath: new vscode.ThemeIcon('key'),
            });
            terminal.show();
        }),

        vscode.commands.registerCommand('beams.create', async () => {
            const allTemplates = getAllTemplates(context);
            const picked = await vscode.window.showQuickPick(
                allTemplates.map(t => ({
                    label: t.custom ? `$(star) ${t.label}` : t.label,
                    description: t.description,
                    template: t,
                })),
                { placeHolder: 'Select a template for the new beam' }
            );
            if (!picked) {
                return;
            }

            try {
                const beam = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `Creating beam (${picked.template.label})...` },
                    async () => {
                        const b = await addBeam();
                        if (picked.template.commands.length > 0) {
                            for (const cmd of picked.template.commands) {
                                await execOnBeam(b.id, ['bash', '-c', cmd]);
                            }
                        }
                        try {
                            const status = await checkStatus();
                            if (status.loggedIn && status.cluster) {
                                const host = await ensureBeamSshConfig(b.id, status.cluster);
                                await setupGitCredentials(host, context.secrets);
                            }
                        } catch { /* non-fatal */ }
                        return b;
                    }
                );
                vscode.window.showInformationMessage(`Beam "${beam.id}" created with ${picked.template.label} template.`);
                provider.refresh();
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Failed to create beam: ${err instanceof Error ? err.message : err}`);
            }
        }),

        vscode.commands.registerCommand('beams.saveAsTemplate', async (item: BeamItem) => {
            if (!item?.beam) {
                return;
            }

            const name = await vscode.window.showInputBox({
                prompt: 'Template name',
                placeHolder: 'My Custom Setup',
            });
            if (!name) {
                return;
            }

            const description = await vscode.window.showInputBox({
                prompt: 'Short description',
                placeHolder: 'Python + Redis + custom tools',
            });
            if (description === undefined) {
                return;
            }

            const commandsInput = await vscode.window.showInputBox({
                prompt: 'Setup commands (semicolon-separated)',
                placeHolder: 'apt install -y redis; pip install redis; mkdir -p /home/beams/project',
                value: '',
            });
            if (commandsInput === undefined) {
                return;
            }

            // If user left commands empty, capture installed packages from the beam
            let commands: string[];
            if (!commandsInput.trim()) {
                const capture = await vscode.window.showQuickPick(
                    [
                        { label: 'Capture installed packages', description: 'Auto-detect pip/npm packages on this beam' },
                        { label: 'Save with no commands', description: 'Template will just create an empty beam' },
                    ],
                    { placeHolder: 'No commands entered — capture from beam?' }
                );

                if (capture?.label === 'Capture installed packages') {
                    commands = await captureBeamConfig(item.beam.id);
                } else {
                    commands = ['mkdir -p /home/beams/project'];
                }
            } else {
                commands = commandsInput.split(';').map(c => c.trim()).filter(Boolean);
            }

            await saveCustomTemplate(context, { label: name, description: description || '', commands });
            vscode.window.showInformationMessage(`Template "${name}" saved.`);
        }),

        vscode.commands.registerCommand('beams.deleteTemplate', async () => {
            const custom = getCustomTemplates(context);
            if (custom.length === 0) {
                vscode.window.showInformationMessage('No custom templates to delete.');
                return;
            }

            const picked = await vscode.window.showQuickPick(
                custom.map(t => ({ label: t.label, description: t.description })),
                { placeHolder: 'Select a custom template to delete' }
            );
            if (!picked) {
                return;
            }

            await deleteCustomTemplate(context, picked.label);
            vscode.window.showInformationMessage(`Template "${picked.label}" deleted.`);
        }),

        vscode.commands.registerCommand('beams.delete', async (item: BeamItem) => {
            if (!item) {
                return;
            }
            const confirm = await vscode.window.showWarningMessage(
                `Delete beam "${item.beam.id}"?`,
                { modal: true },
                'Delete'
            );
            if (confirm !== 'Delete') {
                return;
            }
            try {
                await removeBeam(item.beam.id);
                vscode.window.showInformationMessage(`Beam "${item.beam.id}" deleted.`);
                provider.refresh();
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Failed to delete beam: ${err instanceof Error ? err.message : err}`);
            }
        }),

        vscode.commands.registerCommand('beams.connect', async (item: BeamItem) => {
            if (!item?.beam) {
                return;
            }
            try {
                const status = await checkStatus();
                if (!status.loggedIn || !status.cluster) {
                    vscode.window.showErrorMessage('Not logged in to Teleport. Use "Beams: Login" first.');
                    return;
                }
                const host = await ensureBeamSshConfig(item.beam.id, status.cluster);
                try {
                    await setupGitCredentials(host, context.secrets);
                } catch { /* non-fatal — beam may not have git yet */ }
                const config = vscode.workspace.getConfiguration('remote.SSH');
                if (!config.get<boolean>('enableRemoteCommand')) {
                    await config.update('enableRemoteCommand', true, vscode.ConfigurationTarget.Global);
                }
                const remoteUri = vscode.Uri.parse(`vscode-remote://ssh-remote+${host}/home/beams`);
                await vscode.commands.executeCommand('vscode.openFolder', remoteUri);
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Failed to connect: ${err instanceof Error ? err.message : err}`);
            }
        }),

        vscode.commands.registerCommand('beams.ssh', (item: BeamItem) => {
            if (!item?.beam) {
                return;
            }
            openBeamTerminal(item.beam);
        }),

        vscode.commands.registerCommand('beams.openFiles', (item: BeamItem) => {
            if (!item?.beam) {
                return;
            }
            fileExplorer.setBeam(item.beam);
            vscode.commands.executeCommand('beamFiles.focus');
        }),

        vscode.commands.registerCommand('beams.openFile', async (entry: { beamId: string; path: string; name: string }) => {
            if (!entry) {
                return;
            }
            const uri = vscode.Uri.parse(`beam://${entry.beamId}${entry.path}`);
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc);
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Failed to open file: ${err instanceof Error ? err.message : err}`);
            }
        }),

        vscode.commands.registerCommand('beams.refreshFiles', () => {
            fileExplorer.refresh();
        }),

        vscode.commands.registerCommand('beams.publish', async (item: BeamItem) => {
            if (!item) {
                return;
            }
            try {
                const url = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Publishing beam...' },
                    () => publishBeam(item.beam.id)
                );
                const action = await vscode.window.showInformationMessage(
                    `Beam published: ${url}`,
                    'Copy URL'
                );
                if (action === 'Copy URL') {
                    await vscode.env.clipboard.writeText(url);
                }
                provider.refresh();
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Failed to publish: ${err instanceof Error ? err.message : err}`);
            }
        }),

        vscode.commands.registerCommand('beams.unpublish', async (item: BeamItem) => {
            if (!item) {
                return;
            }
            try {
                await unpublishBeam(item.beam.id);
                vscode.window.showInformationMessage(`Beam "${item.beam.id}" unpublished.`);
                provider.refresh();
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Failed to unpublish: ${err instanceof Error ? err.message : err}`);
            }
        }),

        vscode.commands.registerCommand('beams.copyUrl', async (item: BeamItem) => {
            if (!item?.beam.url) {
                return;
            }
            await vscode.env.clipboard.writeText(item.beam.url);
            vscode.window.showInformationMessage('URL copied to clipboard.');
        }),

        vscode.commands.registerCommand('beams.setGithubPat', () => promptAndStoreGithubPat(context.secrets)),

        vscode.commands.registerCommand('beams.clearGithubPat', () => clearGithubPat(context.secrets)),

        vscode.commands.registerCommand('beams.showActivityDetail', (item: { detail?: string; label?: string | vscode.TreeItemLabel }) => {
            if (!item?.detail) {
                return;
            }
            const channel = vscode.window.createOutputChannel('Beam Activity Detail');
            channel.clear();
            const title = typeof item.label === 'string' ? item.label : item.label?.label ?? 'Detail';
            channel.appendLine(`═══ ${title} ═══`);
            channel.appendLine('');
            channel.appendLine(item.detail);
            channel.show(true);
        }),

        vscode.commands.registerCommand('beams.export', async (item: BeamItem) => {
            if (!item?.beam) {
                return;
            }

            const remotePath = await vscode.window.showInputBox({
                prompt: 'Remote path on beam to export',
                value: '/home/beams',
                placeHolder: '/home/beams/my-project',
            });
            if (!remotePath) {
                return;
            }

            const homeDir = process.env.HOME || process.env.USERPROFILE || '';
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(homeDir, 'Downloads', `${item.beam.id}-export.tar.gz`)),
                filters: { 'Tar files': ['tar.gz', 'tgz'] },
                title: 'Save exported archive to...',
            });
            if (!saveUri) {
                return;
            }

            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Exporting beam files...' },
                    async () => {
                        const remoteArchive = '/tmp/beam-export.tar.gz';
                        await execOnBeam(item.beam.id, [
                            'tar', '-czf', remoteArchive,
                            '--exclude=./node_modules',
                            '--exclude=./.git',
                            '--exclude=./.claude',
                            '-C', remotePath, '.'
                        ]);
                        await scpFromBeam(item.beam.id, remoteArchive, saveUri.fsPath);
                        await execOnBeam(item.beam.id, ['rm', '-f', remoteArchive]);
                    }
                );
                const action = await vscode.window.showInformationMessage(
                    `Exported to ${saveUri.fsPath}`,
                    'Open Folder'
                );
                if (action === 'Open Folder') {
                    const dir = vscode.Uri.file(path.dirname(saveUri.fsPath));
                    vscode.commands.executeCommand('revealFileInOS', dir);
                }
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Export failed: ${err instanceof Error ? err.message : err}`);
            }
        })
    );
}

async function captureBeamConfig(beamId: string): Promise<string[]> {
    const commands: string[] = ['mkdir -p /home/beams/project'];

    try {
        const pipOutput = await execOnBeam(beamId, ['bash', '-c', 'pip freeze 2>/dev/null || true']);
        const packages = pipOutput.trim().split('\n').filter(l => l && !l.startsWith('#'));
        if (packages.length > 0) {
            commands.push('python3 -m venv /home/beams/project/.venv');
            commands.push(`/home/beams/project/.venv/bin/pip install ${packages.join(' ')}`);
        }
    } catch { /* no pip */ }

    try {
        const npmGlobal = await execOnBeam(beamId, ['bash', '-c', 'npm list -g --depth=0 --json 2>/dev/null || true']);
        const parsed = JSON.parse(npmGlobal);
        const deps = Object.keys(parsed.dependencies ?? {}).filter(d => d !== 'npm');
        if (deps.length > 0) {
            commands.push(`npm install -g ${deps.join(' ')}`);
        }
    } catch { /* no npm or parse error */ }

    try {
        const aptOutput = await execOnBeam(beamId, ['bash', '-c', "apt-mark showmanual 2>/dev/null | grep -v -E '^(base-files|bash|coreutils|dpkg|apt)' || true"]);
        const aptPkgs = aptOutput.trim().split('\n').filter(Boolean);
        if (aptPkgs.length > 0) {
            commands.push(`apt-get install -y ${aptPkgs.join(' ')}`);
        }
    } catch { /* no apt */ }

    return commands;
}
