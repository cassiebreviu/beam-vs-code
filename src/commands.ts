import * as vscode from 'vscode';
import { BeamItem, setBeamLabel } from './beamItem';
import { BeamsProvider } from './beamsProvider';
import { BeamFileExplorer } from './fileExplorer';
import { addBeam, removeBeam, publishBeam, unpublishBeam, execOnBeam, scpFromBeam, checkStatus, listBeams, waitForBeamReady, detectRepoRoot } from './tsh';
import { openBeamTerminal } from './terminal';
import { reportTshError } from './notify';
import { setupGithubOnBeam, autoSetupGithub, SECRET_KEY } from './github';
import { ensureBeamSshConfig } from './ssh';
import { AgentEventsProvider } from './events';
import {
    LocalContainerSyncMode,
    isDockerAvailable,
    createLocalContainerRecord,
    getLocalContainerRecord,
    deleteLocalContainerRecord,
    generateDockerfile,
    writeDockerfile,
    writeDevcontainerJson,
    buildContainerImage,
    ensureContainerRunning,
    stopContainer,
    removeContainer,
    openContainerTerminal,
} from './localContainer';
import { ContainerSyncEngine } from './containerSync';
import * as path from 'path';
import * as os from 'os';

export function registerCommands(
    context: vscode.ExtensionContext,
    provider: BeamsProvider,
    fileExplorer: BeamFileExplorer,
    eventsProvider: AgentEventsProvider,
    poller?: import('./polling').BeamPoller,
    _getScm?: () => import('./scm').BeamGitScmProvider | undefined,
    containerSync?: ContainerSyncEngine,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('beams.select', async (item: BeamItem) => {
            if (!item?.beam) {
                return;
            }
            fileExplorer.setBeam(item.beam);
            eventsProvider.setBeam(item.beam);
            if (poller) {
                await poller.setBeam(item.beam.id);
                vscode.commands.executeCommand('beams.selectScm');
            }
        }),

        vscode.commands.registerCommand('beams.refresh', () => {
            provider.refresh();
        }),

        vscode.commands.registerCommand('beams.rename', async (item?: BeamItem) => {
            if (!item?.beam) { return; }
            const newName = await vscode.window.showInputBox({
                prompt: 'Enter a custom name for this beam (leave empty to reset)',
                placeHolder: item.beam.id,
                value: (item.label as string) !== item.beam.id ? (item.label as string) : '',
            });
            if (newName === undefined) { return; }
            setBeamLabel(item.beam.id, newName || undefined);
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
            // Ask whether to apply saved GitHub credentials
            let applyGithubCredentials = false;
            {
                const cfg = vscode.workspace.getConfiguration('beams');
                const savedUsername = cfg.get<string>('github.username');
                const savedAuthMethod = cfg.get<string>('github.authMethod');
                if (savedUsername && savedAuthMethod) {
                    const savedEmail = cfg.get<string>('github.email') || `${savedUsername}@users.noreply.github.com`;
                    const choice = await vscode.window.showQuickPick(
                        [
                            { label: '$(mark-github) Apply saved GitHub credentials', description: `${savedUsername} · ${savedEmail}`, apply: true },
                            { label: '$(dash) Skip', description: 'Set up GitHub later via Setup GitHub on Beam', apply: false },
                        ],
                        { placeHolder: 'Set up GitHub credentials on the new beam?' }
                    );
                    if (choice === undefined) {
                        return;
                    }
                    applyGithubCredentials = choice.apply;
                }
            }

            // Local debug container: decided once, here, at creation time only.
            // There is deliberately no command anywhere in this extension that
            // edits this choice for an existing beam — delete this beam and
            // create a new one to change it.
            let enableLocalContainer = false;
            let localContainerSyncMode: LocalContainerSyncMode = 'manual';
            if (await isDockerAvailable()) {
                const choice = await vscode.window.showQuickPick(
                    [
                        { label: '$(circle-slash) No', description: 'Recommended', enable: false },
                        { label: '$(vm) Yes', description: 'Mirrors this beam into a locked-down local Docker container for debugging. Cannot be changed later — delete this beam and create a new one to change this choice.', enable: true },
                    ],
                    { placeHolder: 'Enable local debug container for this beam? (fixed for this beam’s lifetime)' }
                );
                if (choice === undefined) {
                    return;
                }
                enableLocalContainer = choice.enable;

                if (enableLocalContainer) {
                    const syncChoice = await vscode.window.showQuickPick(
                        [
                            { label: '$(sync) Automatic', description: 'Syncs shortly after git status changes on the beam (also fixed for this beam’s lifetime)', mode: 'automatic' as LocalContainerSyncMode },
                            { label: '$(circle-outline) Manual', description: 'Only syncs when you run "Sync Local Debug Container Now"', mode: 'manual' as LocalContainerSyncMode },
                        ],
                        { placeHolder: 'How should the local debug container sync from the beam?' }
                    );
                    if (syncChoice === undefined) {
                        return;
                    }
                    localContainerSyncMode = syncChoice.mode;
                }
            }

            try {
                const beam = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Creating beam...' },
                    async (progress) => {
                        const b = await addBeam();
                        progress.report({ message: 'Waiting for beam to be ready...' });
                        await waitForBeamReady(b.id);
                        try {
                            const status = await checkStatus();
                            if (status.loggedIn && status.cluster) {
                                await ensureBeamSshConfig(b.id, status.cluster);
                                if (applyGithubCredentials) {
                                    const result = await autoSetupGithub(b.id, context, progress, true);
                                    if (result.error) {
                                        vscode.window.showWarningMessage(`GitHub auto-setup: ${result.error}`);
                                    }
                                }
                            }
                        } catch { /* non-fatal */ }

                        if (enableLocalContainer) {
                            progress.report({ message: 'Setting up local debug container...' });
                            try {
                                const repoRoot = (await detectRepoRoot(b.id)) ?? '/home/beams';
                                const record = createLocalContainerRecord(b.id, repoRoot, localContainerSyncMode);
                                writeDockerfile(b.id, generateDockerfile());
                                writeDevcontainerJson(record);
                            } catch (err: unknown) {
                                vscode.window.showWarningMessage(`Local debug container setup failed: ${err instanceof Error ? err.message : err}`);
                            }
                        }

                        return { beam: b };
                    }
                );
                vscode.window.showInformationMessage(`Beam "${beam.beam.id}" created.`);
                provider.refresh();

                // Build the local container image in the background — not
                // awaited, so it never adds latency to beam creation itself.
                const record = getLocalContainerRecord(beam.beam.id);
                if (record) {
                    void vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, title: `Building local debug container image for "${beam.beam.id}"...` },
                        async () => {
                            try {
                                await buildContainerImage(record);
                            } catch (err: unknown) {
                                vscode.window.showWarningMessage(`Local debug container image build failed: ${err instanceof Error ? err.message : err}`);
                            }
                        }
                    );
                }
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Failed to create beam: ${err instanceof Error ? err.message : err}`);
            }
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

            // A local debug container must never outlive its beam. Cleanup
            // failures here are surfaced but must never block beam deletion,
            // which has already succeeded above.
            const record = getLocalContainerRecord(item.beam.id);
            if (record) {
                try {
                    await stopContainer(record);
                    await removeContainer(record);
                    deleteLocalContainerRecord(item.beam.id);
                } catch (err: unknown) {
                    vscode.window.showWarningMessage(
                        `Beam deleted, but cleaning up its local debug container failed: ${err instanceof Error ? err.message : err}. ` +
                        `You may need to run "docker rm -f ${record.containerName}" manually.`
                    );
                }
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

                const detectedRoot = await detectRepoRoot(item.beam.id);
                let folder = await vscode.window.showInputBox({
                    prompt: 'Directory to open as the workspace root (e.g. the repo root, so Source Control diffs/commits are scoped correctly)',
                    value: detectedRoot ?? '/home/beams',
                    ignoreFocusOut: true,
                    validateInput: v => v.startsWith('/') ? undefined : 'Must be an absolute path (starting with /)',
                });
                if (!folder) {
                    return;
                }
                folder = folder.replace(/\/+$/, '') || '/';

                const host = await ensureBeamSshConfig(item.beam.id, status.cluster);
                const config = vscode.workspace.getConfiguration('remote.SSH');
                if (config.inspect<boolean>('enableRemoteCommand') && !config.get<boolean>('enableRemoteCommand')) {
                    await config.update('enableRemoteCommand', true, vscode.ConfigurationTarget.Global);
                }
                const remoteUri = vscode.Uri.parse(`vscode-remote://ssh-remote+${host}${folder}`);
                await vscode.commands.executeCommand('vscode.openFolder', remoteUri, { forceNewWindow: true });
            } catch (err: unknown) {
                reportTshError(err, { beamId: item.beam.id, action: 'connect', refresh: () => provider.refresh() });
            }
        }),

        vscode.commands.registerCommand('beams.ssh', (item: BeamItem) => {
            if (!item?.beam) {
                return;
            }
            openBeamTerminal(item.beam);
        }),

        vscode.commands.registerCommand('beams.openFiles', async (item: BeamItem) => {
            if (!item?.beam) {
                return;
            }
            fileExplorer.setBeam(item.beam);
            if (poller) {
                await poller.setBeam(item.beam.id);
                vscode.commands.executeCommand('beams.selectScm');
            }
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
                reportTshError(err, { beamId: entry.beamId, action: 'open file' });
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
                reportTshError(err, { beamId: item.beam.id, action: 'publish', refresh: () => provider.refresh() });
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
                reportTshError(err, { beamId: item.beam.id, action: 'unpublish', refresh: () => provider.refresh() });
            }
        }),

        vscode.commands.registerCommand('beams.copyUrl', async (item: BeamItem) => {
            if (!item?.beam.url) {
                return;
            }
            await vscode.env.clipboard.writeText(item.beam.url);
            vscode.window.showInformationMessage('URL copied to clipboard.');
        }),


        vscode.commands.registerCommand('beams.setupGithub', async (item?: BeamItem) => {
            let beamId = item?.beam?.id;
            if (!beamId) {
                const beams = await listBeams();
                if (beams.length === 0) {
                    vscode.window.showErrorMessage('No beams available. Create a beam first.');
                    return;
                }
                const picked = await vscode.window.showQuickPick(
                    beams.map(b => ({
                        label: b.id,
                        description: b.owner ? `Owner: ${b.owner}` : undefined,
                    })),
                    { placeHolder: 'Select a beam to set up GitHub on', ignoreFocusOut: true }
                );
                if (!picked) {
                    return;
                }
                beamId = picked.label;
            }

            const username = await vscode.window.showInputBox({
                prompt: 'GitHub username',
                placeHolder: 'octocat',
                ignoreFocusOut: true,
            });
            if (!username) {
                return;
            }

            const email = await vscode.window.showInputBox({
                prompt: 'Git email',
                placeHolder: `${username}@users.noreply.github.com`,
                value: `${username}@users.noreply.github.com`,
                ignoreFocusOut: true,
            });
            if (email === undefined) {
                return;
            }

            const authChoice = await vscode.window.showQuickPick(
                [
                    // { label: '$(shield) Teleport Git Proxy (tsh git)', description: 'Use Teleport-managed GitHub access — no token needed', method: 'tsh-git' as const },
                    { label: '$(globe) Full account access (OAuth)', description: 'Authenticate via browser — grants access to all your repos', method: 'oauth' as const },
                    { label: '$(key) Fine-grained token (PAT)', description: 'Paste a token scoped to specific repos', method: 'pat' as const },
                ],
                { placeHolder: 'How would you like to authenticate with GitHub?', ignoreFocusOut: true }
            );
            if (!authChoice) {
                return;
            }

            let pat: string | undefined;
            if (authChoice.method === 'pat') {
                pat = await vscode.window.showInputBox({
                    prompt: 'Paste your GitHub Personal Access Token',
                    password: true,
                    placeHolder: 'ghp_... or github_pat_...',
                    ignoreFocusOut: true,
                });
                if (!pat) {
                    return;
                }
            }

            let cloneRepo: string | undefined;
            let cloneDir: string | undefined;
            if (authChoice.method !== 'oauth') {
                cloneRepo = await vscode.window.showInputBox({
                    prompt: 'Repository to clone (or leave empty to skip)',
                    placeHolder: 'owner/repo',
                    ignoreFocusOut: true,
                }) || undefined;

                if (cloneRepo) {
                    cloneDir = await vscode.window.showInputBox({
                        prompt: 'Clone directory (or leave empty for default)',
                        placeHolder: '/home/beams/my-project',
                        ignoreFocusOut: true,
                    }) || undefined;
                }
            }

            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Setting up GitHub on beam...', cancellable: false },
                    async (progress) => {
                        await setupGithubOnBeam({
                            beamId,
                            username,
                            email: email || `${username}@users.noreply.github.com`,
                            authMethod: authChoice.method,
                            pat,
                            cloneRepo,
                            cloneDir,
                        }, progress);
                    }
                );

                if (authChoice.method === 'oauth') {
                    vscode.window.showInformationMessage(
                        'GitHub CLI installed. Open a terminal on the beam and run: gh auth login'
                    );
                } else {
                    vscode.window.showInformationMessage('GitHub setup complete on beam.');
                }

                const remember = await vscode.window.showInformationMessage(
                    'Remember these settings for future beams?',
                    'Yes', 'No'
                );
                if (remember === 'Yes') {
                    const cfg = vscode.workspace.getConfiguration('beams');
                    await cfg.update('github.username', username, vscode.ConfigurationTarget.Global);
                    await cfg.update('github.email', email || `${username}@users.noreply.github.com`, vscode.ConfigurationTarget.Global);
                    await cfg.update('github.authMethod', authChoice.method, vscode.ConfigurationTarget.Global);
                    if (pat) {
                        await context.secrets.store(SECRET_KEY, pat);
                    }
                    if (cloneRepo) {
                        await cfg.update('github.defaultCloneRepo', cloneRepo, vscode.ConfigurationTarget.Global);
                    }
                }
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`GitHub setup failed: ${err instanceof Error ? err.message : err}`);
            }
        }),

        vscode.commands.registerCommand('beams.run', async (item?: BeamItem) => {
            if (!item?.beam) {
                vscode.window.showErrorMessage('Select a beam first.');
                return;
            }
            if (item.beam.url) {
                vscode.env.openExternal(vscode.Uri.parse(item.beam.url));
            } else {
                const action = await vscode.window.showInformationMessage(
                    'This beam is not published yet. Publish it first?',
                    'Publish'
                );
                if (action === 'Publish') {
                    try {
                        const url = await vscode.window.withProgress(
                            { location: vscode.ProgressLocation.Notification, title: 'Publishing beam...' },
                            () => publishBeam(item.beam.id)
                        );
                        provider.refresh();
                        vscode.env.openExternal(vscode.Uri.parse(url));
                    } catch (err: unknown) {
                        reportTshError(err, { beamId: item.beam.id, action: 'publish', refresh: () => provider.refresh() });
                    }
                }
            }
        }),

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
                reportTshError(err, { beamId: item.beam.id, action: 'export beam files', refresh: () => provider.refresh() });
            }
        }),

        // Local debug container commands. Note there is deliberately no
        // enable/toggle/configure command here — see beams.create.
        vscode.commands.registerCommand('beams.container.open', async (item: BeamItem) => {
            if (!item?.beam) {
                return;
            }
            const record = getLocalContainerRecord(item.beam.id);
            if (!record?.enabled) {
                vscode.window.showErrorMessage('This beam does not have a local debug container enabled.');
                return;
            }
            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `Preparing local debug container for "${item.beam.id}"...` },
                    async () => {
                        await ensureContainerRunning(record);
                        if (containerSync) {
                            await containerSync.syncNow(item.beam.id, record.repoRoot);
                        }
                    }
                );
                openContainerTerminal(record);
                vscode.window.showInformationMessage(
                    `Tip: for full IntelliSense, you can also open ${path.join(os.homedir(), '.teleport', 'beams', 'local-containers', item.beam.id, 'workspace')} directly as a VS Code folder.`
                );
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Failed to open local debug container: ${err instanceof Error ? err.message : err}`);
            }
        }),

        vscode.commands.registerCommand('beams.container.syncNow', async (item: BeamItem) => {
            if (!item?.beam || !containerSync) {
                return;
            }
            const record = getLocalContainerRecord(item.beam.id);
            if (!record?.enabled) {
                vscode.window.showErrorMessage('This beam does not have a local debug container enabled.');
                return;
            }
            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `Syncing local debug container for "${item.beam.id}"...` },
                    () => containerSync.syncNow(item.beam.id, record.repoRoot)
                );
                vscode.window.showInformationMessage(`Local debug container for "${item.beam.id}" synced.`);
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Sync failed: ${err instanceof Error ? err.message : err}`);
            }
        }),

        vscode.commands.registerCommand('beams.container.rebuild', async (item: BeamItem) => {
            if (!item?.beam) {
                return;
            }
            const record = getLocalContainerRecord(item.beam.id);
            if (!record?.enabled) {
                vscode.window.showErrorMessage('This beam does not have a local debug container enabled.');
                return;
            }
            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `Rebuilding local debug container image for "${item.beam.id}"...` },
                    async () => {
                        await buildContainerImage(record, { noCache: true });
                        await removeContainer(record);
                        await ensureContainerRunning(record);
                    }
                );
                vscode.window.showInformationMessage(`Local debug container for "${item.beam.id}" rebuilt.`);
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Rebuild failed: ${err instanceof Error ? err.message : err}`);
            }
        }),

        vscode.commands.registerCommand('beams.container.teardown', async (item: BeamItem) => {
            if (!item?.beam) {
                return;
            }
            const record = getLocalContainerRecord(item.beam.id);
            if (!record) {
                vscode.window.showInformationMessage('This beam does not have a local debug container.');
                return;
            }
            const confirm = await vscode.window.showWarningMessage(
                `Delete the local debug container and synced files for "${item.beam.id}"? The beam itself is not affected.`,
                { modal: true },
                'Delete'
            );
            if (confirm !== 'Delete') {
                return;
            }
            try {
                await stopContainer(record);
                await removeContainer(record);
                deleteLocalContainerRecord(item.beam.id);
                provider.refresh();
                vscode.window.showInformationMessage(`Local debug container for "${item.beam.id}" removed.`);
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Teardown failed: ${err instanceof Error ? err.message : err}`);
            }
        })
    );
}
