import * as vscode from 'vscode';
import { BeamItem } from './beamItem';
import { BeamsProvider } from './beamsProvider';
import { BeamFileExplorer } from './fileExplorer';
import { addBeam, removeBeam, publishBeam, unpublishBeam, execOnBeam, scpFromBeam, checkStatus, listBeams } from './tsh';
import { openBeamTerminal } from './terminal';
import { getAllTemplates } from './templates';
import { setupGithubOnBeam, openOAuthTerminal, autoSetupGithub, toOwnerRepo, SECRET_KEY } from './github';
import { ensureBeamSshConfig } from './ssh';
import { AgentActivityProvider } from './activity';
import { AgentEventsProvider } from './events';
import { SessionProfilesProvider } from './sessionProfilesProvider';
import { SessionProfileItem } from './sessionProfileItem';
import {
    SessionProfile,
    listSessionProfiles,
    getSessionSummary,
    getSessionSummaryPath,
    saveSessionProfile,
    deleteSessionProfile,
    detectRepoRoot,
    captureGitRef,
    captureRemoteUrl,
    captureRecentActivity,
    generateSessionSummary,
    cloneRepoOnBeam,
    applyGitRef,
    writeSessionSummaryToBeam,
    appendSessionSummaryToUserMemory,
} from './sessionProfiles';
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
    activityProvider: AgentActivityProvider,
    eventsProvider: AgentEventsProvider,
    sessionProfilesProvider: SessionProfilesProvider,
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
            activityProvider.setBeam(item.beam);
            eventsProvider.setBeam(item.beam);
            if (poller) {
                await poller.setBeam(item.beam.id);
                vscode.commands.executeCommand('beams.selectScm');
            }
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
            const allTemplates = getAllTemplates();
            const picked = await vscode.window.showQuickPick(
                allTemplates.map(t => ({
                    label: t.label,
                    description: t.description,
                    template: t,
                })),
                { placeHolder: 'Select a template for the new beam' }
            );
            if (!picked) {
                return;
            }

            // Resolve conflict between template GitHub config and stored preferences
            let useTemplateGithub = false;
            const templateGithub = picked.template.github;
            if (templateGithub?.username) {
                const cfg = vscode.workspace.getConfiguration('beams');
                const storedUsername = cfg.get<string>('github.username');
                const storedEmail = cfg.get<string>('github.email');
                if (storedUsername && templateGithub.email && storedEmail && templateGithub.email !== storedEmail) {
                    const choice = await vscode.window.showQuickPick(
                        [
                            { label: `Use stored identity (${storedEmail})`, useTemplate: false },
                            { label: `Use template identity (${templateGithub.email})`, useTemplate: true },
                        ],
                        { placeHolder: 'Template has different git identity than your stored preferences' }
                    );
                    if (!choice) {
                        return;
                    }
                    useTemplateGithub = choice.useTemplate;
                }
            }

            // Ask whether to apply saved GitHub credentials (only when not using template config)
            let applyGithubCredentials = false;
            if (!useTemplateGithub) {
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
                    { location: vscode.ProgressLocation.Notification, title: `Creating beam (${picked.template.label})...` },
                    async (progress) => {
                        const b = await addBeam();
                        if (picked.template.commands.length > 0) {
                            progress.report({ message: 'Running template setup...' });
                            for (const cmd of picked.template.commands) {
                                await execOnBeam(b.id, [cmd]);
                            }
                        }
                        try {
                            const status = await checkStatus();
                            if (status.loggedIn && status.cluster) {
                                await ensureBeamSshConfig(b.id, status.cluster);
                                if (useTemplateGithub && templateGithub) {
                                    // Apply template's GitHub config instead of stored prefs
                                    progress.report({ message: 'Applying template GitHub config...' });
                                    await setupGithubOnBeam({
                                        beamId: b.id,
                                        username: templateGithub.username!,
                                        email: templateGithub.email || `${templateGithub.username}@users.noreply.github.com`,
                                        authMethod: templateGithub.authMethod || 'tsh-git',
                                        cloneRepo: templateGithub.cloneRepo,
                                    }, progress);
                                } else if (applyGithubCredentials) {
                                    const result = await autoSetupGithub(b.id, context, progress, true);
                                    if (result.error) {
                                        vscode.window.showWarningMessage(`GitHub auto-setup: ${result.error}`);
                                    }
                                }
                            }
                        } catch { /* non-fatal */ }

                        let publishedUrl: string | undefined;
                        if (picked.template.autoPublish) {
                            progress.report({ message: 'Publishing beam...' });
                            try {
                                publishedUrl = await publishBeam(b.id);
                            } catch { /* non-fatal — user can publish manually */ }
                        }

                        if (enableLocalContainer) {
                            progress.report({ message: 'Setting up local debug container...' });
                            try {
                                const repoRoot = (await detectRepoRoot(b.id)) ?? '/home/beams';
                                const record = createLocalContainerRecord(b.id, repoRoot, localContainerSyncMode);
                                writeDockerfile(b.id, generateDockerfile(picked.template));
                                writeDevcontainerJson(record);
                            } catch (err: unknown) {
                                vscode.window.showWarningMessage(`Local debug container setup failed: ${err instanceof Error ? err.message : err}`);
                            }
                        }

                        return { beam: b, publishedUrl };
                    }
                );
                const message = beam.publishedUrl
                    ? `Beam "${beam.beam.id}" created with ${picked.template.label} template. Published at ${beam.publishedUrl}`
                    : `Beam "${beam.beam.id}" created with ${picked.template.label} template.`;
                vscode.window.showInformationMessage(message);
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
                    { label: '$(shield) Teleport Git Proxy (tsh git)', description: 'Use Teleport-managed GitHub access — no token needed', method: 'tsh-git' as const },
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

            const cloneRepo = await vscode.window.showInputBox({
                prompt: 'Repository to clone (or leave empty to skip)',
                placeHolder: 'owner/repo',
                ignoreFocusOut: true,
            });

            let cloneDir: string | undefined;
            if (cloneRepo) {
                cloneDir = await vscode.window.showInputBox({
                    prompt: 'Clone directory (or leave empty for default)',
                    placeHolder: '/home/beams/my-project',
                    ignoreFocusOut: true,
                });
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
                            cloneRepo: cloneRepo || undefined,
                            cloneDir: cloneDir || undefined,
                        }, progress);
                    }
                );

                if (authChoice.method === 'oauth') {
                    openOAuthTerminal(beamId);
                    vscode.window.showInformationMessage('GitHub CLI installed and git configured. Complete OAuth login in the terminal.');
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
            const beamId = item?.beam?.id;
            if (!beamId) {
                vscode.window.showErrorMessage('Select a beam first.');
                return;
            }

            const command = await vscode.window.showInputBox({
                prompt: 'Command to run on the beam (must listen on port 8080)',
                placeHolder: 'npm start / python3 -m http.server 8080 / go run .',
            });
            if (!command) {
                return;
            }

            const terminal = vscode.window.createTerminal({
                name: `Run: ${beamId}`,
                shellPath: 'tsh',
                shellArgs: ['beams', 'exec', beamId, '--', command],
                iconPath: new vscode.ThemeIcon('play'),
            });
            terminal.show();

            try {
                const url = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Publishing beam...' },
                    () => publishBeam(beamId)
                );
                const action = await vscode.window.showInformationMessage(
                    `Beam running and published: ${url}`,
                    'Open in Browser',
                    'Copy URL',
                    'Open in VS Code (Remote-SSH)'
                );
                if (action === 'Open in Browser') {
                    vscode.env.openExternal(vscode.Uri.parse(url));
                } else if (action === 'Copy URL') {
                    await vscode.env.clipboard.writeText(url);
                } else if (action === 'Open in VS Code (Remote-SSH)') {
                    await vscode.commands.executeCommand('beams.connect', item);
                }
                provider.refresh();
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Failed to publish: ${err instanceof Error ? err.message : err}`);
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
                vscode.window.showErrorMessage(`Export failed: ${err instanceof Error ? err.message : err}`);
            }
        }),

        vscode.commands.registerCommand('beams.refreshSessionProfiles', () => {
            sessionProfilesProvider.refresh();
        }),

        vscode.commands.registerCommand('beams.createSetupProfile', async () => {
            await runSetupProfileFlow(sessionProfilesProvider);
        }),

        vscode.commands.registerCommand('beams.saveSessionProfile', async (item?: BeamItem) => {
            let beamId = item?.beam?.id;
            if (!beamId) {
                const beams = await listBeams();
                if (beams.length === 0) {
                    vscode.window.showErrorMessage('No beams available.');
                    return;
                }
                const picked = await vscode.window.showQuickPick(
                    beams.map(b => ({ label: b.id, description: b.owner ? `Owner: ${b.owner}` : undefined })),
                    { placeHolder: 'Select a beam to save a session profile from', ignoreFocusOut: true }
                );
                if (!picked) {
                    return;
                }
                beamId = picked.label;
            }

            const repoRoot = await detectRepoRoot(beamId);

            const existing = listSessionProfiles();
            const existingForBeam = existing.find(p => p.beamId === beamId && !p.setup);
            const taskId = await vscode.window.showInputBox({
                prompt: 'Task/profile id (used to resume this session later)',
                placeHolder: 'fix-auth-bug',
                value: existingForBeam?.taskId,
                ignoreFocusOut: true,
                validateInput: v => /^[a-z0-9][a-z0-9-_]*$/i.test(v) ? undefined : 'Use letters, numbers, - and _ only',
            });
            if (!taskId) {
                return;
            }

            const existingProfile = existing.find(p => p.taskId === taskId);
            const label = await vscode.window.showInputBox({
                prompt: 'Short label for this profile',
                value: existingProfile?.label ?? taskId,
                ignoreFocusOut: true,
            });
            if (label === undefined) {
                return;
            }

            await runSaveSessionProfileFlow(sessionProfilesProvider, beamId, repoRoot, taskId, label, existingProfile);
        }),

        vscode.commands.registerCommand('beams.viewSessionProfile', async (item?: SessionProfileItem) => {
            if (!item?.profile) {
                return;
            }
            const uri = vscode.Uri.file(getSessionSummaryPath(item.profile.taskId));
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: true });
        }),

        vscode.commands.registerCommand('beams.resumeSessionProfile', async (item?: SessionProfileItem) => {
            let profile = item?.profile;
            if (!profile) {
                const all = listSessionProfiles();
                if (all.length === 0) {
                    vscode.window.showInformationMessage('No saved session profiles.');
                    return;
                }
                const picked = await vscode.window.showQuickPick(
                    all.map(p => ({
                        label: p.label,
                        description: p.gitBranch
                            ? `${p.gitBranch}@${(p.gitCommitSha ?? '').slice(0, 7)}`
                            : (p.setup ? `${p.setup.commands.length} setup command(s)` : undefined),
                        detail: `Updated ${new Date(p.updatedAt).toLocaleString()}`,
                        profile: p,
                    })),
                    { placeHolder: 'Select a session profile to resume', ignoreFocusOut: true }
                );
                if (!picked) {
                    return;
                }
                profile = picked.profile;
            }

            const beams = await listBeams();
            const target = await vscode.window.showQuickPick(
                [
                    { label: '$(add) Create a new beam', beamId: undefined as string | undefined },
                    ...beams.map(b => ({ label: b.id, description: b.owner ? `Owner: ${b.owner}` : undefined, beamId: b.id })),
                ],
                { placeHolder: `Resume "${profile.label}" into which beam?`, ignoreFocusOut: true }
            );
            if (!target) {
                return;
            }

            let beamId = target.beamId;
            let publishedUrl: string | undefined;
            let wroteMemoryFile = false;
            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `Resuming "${profile.label}"...` },
                    async (progress) => {
                        if (!beamId) {
                            progress.report({ message: 'Creating beam...' });
                            const b = await addBeam();
                            beamId = b.id;
                        }

                        if (profile!.setup?.commands?.length) {
                            progress.report({ message: 'Running setup commands...' });
                            for (const cmd of profile!.setup.commands) {
                                await execOnBeam(beamId, [cmd]);
                            }
                            if (profile!.setup.autoPublish) {
                                progress.report({ message: 'Publishing beam...' });
                                try {
                                    publishedUrl = await publishBeam(beamId);
                                } catch { /* non-fatal — user can publish manually */ }
                            }
                        }

                        if (!profile!.gitBranch) {
                            return;
                        }

                        progress.report({ message: 'Locating git repository on beam...' });
                        let repoRoot = await detectRepoRoot(beamId);
                        if (!repoRoot) {
                            if (!profile!.remoteUrl) {
                                throw new Error('No git repository found on this beam, and this profile has no remote URL recorded to clone from. Clone the repo (Setup GitHub on Beam) first.');
                            }
                            const dirName = profile!.remoteUrl.replace(/\.git$/, '').split('/').filter(Boolean).pop() || 'project';
                            const targetDir = `/home/beams/${dirName}`;

                            progress.report({ message: 'Cloning repository...' });
                            try {
                                await cloneRepoOnBeam(beamId, profile!.remoteUrl, targetDir);
                            } catch {
                                // Likely a private repo with no credentials on this fresh beam yet —
                                // fall back to whatever GitHub auth prefs the user already has stored.
                                const cfg = vscode.workspace.getConfiguration('beams');
                                const username = cfg.get<string>('github.username');
                                const authMethod = cfg.get<string>('github.authMethod') as 'pat' | 'oauth' | 'tsh-git' | '' | undefined;
                                if (!username || !authMethod) {
                                    throw new Error(
                                        `Could not clone ${profile!.remoteUrl} (likely a private repo with no GitHub credentials on this beam yet). ` +
                                        'Run "Setup GitHub on Beam" first, then resume again.'
                                    );
                                }
                                const email = cfg.get<string>('github.email') || `${username}@users.noreply.github.com`;
                                const pat = authMethod === 'pat' ? await context.secrets.get(SECRET_KEY) : undefined;
                                progress.report({ message: 'Applying stored GitHub credentials...' });
                                await setupGithubOnBeam({
                                    beamId,
                                    username,
                                    email,
                                    authMethod,
                                    pat,
                                    cloneRepo: toOwnerRepo(profile!.remoteUrl),
                                    cloneDir: targetDir,
                                }, progress);
                            }
                            repoRoot = targetDir;
                        }

                        progress.report({ message: `Checking out ${profile!.gitBranch}...` });
                        await applyGitRef(beamId, repoRoot, profile!.gitBranch, profile!.gitCommitSha ?? '');

                        progress.report({ message: 'Loading session memory...' });
                        const summaryMd = getSessionSummary(profile!.taskId);
                        await writeSessionSummaryToBeam(beamId, repoRoot, profile!.taskId, summaryMd);
                        await appendSessionSummaryToUserMemory(beamId, profile!.taskId, profile!.label, summaryMd);
                        wroteMemoryFile = true;
                    }
                );
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Failed to resume "${profile.label}": ${err instanceof Error ? err.message : err}`);
                return;
            }

            provider.refresh();
            const resultMessage = publishedUrl
                ? `"${profile.label}" resumed on beam "${beamId}". Published at ${publishedUrl}`
                : `"${profile.label}" resumed on beam "${beamId}".`;
            if (wroteMemoryFile && beamId) {
                const repoRoot = await detectRepoRoot(beamId) ?? profile.repoRoot;
                if (repoRoot) {
                    // The summary was also appended to /home/beams/.claude/CLAUDE.md
                    // (user memory), which Claude Code auto-loads into every session on
                    // this beam — no need to explicitly tell it to go read a file.
                    const terminal = openBeamTerminal({ id: beamId });
                    terminal.sendText(`cd "${repoRoot}" && claude`);
                }
                const openAction = await vscode.window.showInformationMessage(
                    `${resultMessage} Started a Claude session with the saved memory loaded.`,
                    'Open Session Memory File'
                );
                if (openAction === 'Open Session Memory File' && repoRoot) {
                    const uri = vscode.Uri.parse(`beam://${beamId}${repoRoot}/.claude/session-memory/${profile.taskId}.md`);
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(doc);
                }
            } else {
                vscode.window.showInformationMessage(resultMessage);
            }
        }),

        vscode.commands.registerCommand('beams.updateSessionProfile', async (item?: SessionProfileItem) => {
            let profile = item?.profile;
            if (!profile) {
                const all = listSessionProfiles();
                if (all.length === 0) {
                    vscode.window.showInformationMessage('No saved session profiles.');
                    return;
                }
                const picked = await vscode.window.showQuickPick(
                    all.map(p => ({ label: p.label, description: p.taskId, profile: p })),
                    { placeHolder: 'Select a session profile to update', ignoreFocusOut: true }
                );
                if (!picked) {
                    return;
                }
                profile = picked.profile;
            }

            if (profile.setup) {
                await runSetupProfileFlow(sessionProfilesProvider, profile);
                return;
            }

            const beams = await listBeams();
            let beamId = profile.beamId && beams.some(b => b.id === profile!.beamId) ? profile.beamId : undefined;
            if (!beamId) {
                const picked = await vscode.window.showQuickPick(
                    beams.map(b => ({ label: b.id, description: b.owner ? `Owner: ${b.owner}` : undefined })),
                    {
                        placeHolder: `"${profile.label}" was saved from beam "${profile.beamId || '?'}", which is no longer available — select a beam to update from`,
                        ignoreFocusOut: true,
                    }
                );
                if (!picked) {
                    return;
                }
                beamId = picked.label;
            }

            const repoRoot = await detectRepoRoot(beamId) ?? profile.repoRoot;

            await runSaveSessionProfileFlow(sessionProfilesProvider, beamId, repoRoot, profile.taskId, profile.label, profile);
        }),

        vscode.commands.registerCommand('beams.deleteSessionProfile', async (item?: SessionProfileItem) => {
            let profile = item?.profile;
            if (!profile) {
                const all = listSessionProfiles();
                if (all.length === 0) {
                    vscode.window.showInformationMessage('No saved session profiles.');
                    return;
                }
                const picked = await vscode.window.showQuickPick(
                    all.map(p => ({ label: p.label, taskId: p.taskId })),
                    { placeHolder: 'Select a session profile to delete', ignoreFocusOut: true }
                );
                if (!picked) {
                    return;
                }
                profile = all.find(p => p.taskId === picked.taskId);
            }
            if (!profile) {
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Delete session profile "${profile.label}"?`,
                { modal: true },
                'Delete'
            );
            if (confirm !== 'Delete') {
                return;
            }
            deleteSessionProfile(profile.taskId);
            sessionProfilesProvider.refresh();
            vscode.window.showInformationMessage(`Session profile "${profile.label}" deleted.`);
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

// Shared by beams.saveSessionProfile (new profile, beamId/repoRoot/taskId/label freshly
// prompted) and beams.updateSessionProfile (reuses the stored beamId/taskId/label so the
// existing profile.json/summary.md are simply overwritten in place).
async function runSaveSessionProfileFlow(
    sessionProfilesProvider: SessionProfilesProvider,
    beamId: string,
    repoRoot: string | undefined,
    taskId: string,
    label: string,
    existingProfile: SessionProfile | undefined,
): Promise<void> {
    let gitRef: { branch: string; sha: string } | undefined;
    let remoteUrl: string | undefined;
    let recentActivity = '';
    let llmSummary: string | undefined;
    let llmSummaryError: string | undefined;
    try {
        const captured = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `${existingProfile ? 'Updating' : 'Saving'} session profile "${label}"...`,
            },
            async (progress) => {
                let ref: { branch: string; sha: string } | undefined;
                let url: string | undefined;
                let activity = '';
                if (repoRoot) {
                    progress.report({ message: 'Reading git state from beam...' });
                    ref = await captureGitRef(beamId, repoRoot);
                    url = await captureRemoteUrl(beamId, repoRoot);
                    activity = await captureRecentActivity(beamId, repoRoot);
                }
                progress.report({ message: 'Asking Claude on the beam to draft the summary...' });
                const summary = await generateSessionSummary(beamId, repoRoot ?? '/home/beams', label, activity);
                return { ref, url, activity, summary };
            }
        );
        gitRef = captured.ref;
        remoteUrl = captured.url;
        recentActivity = captured.activity;
        llmSummary = captured.summary.text;
        llmSummaryError = captured.summary.error;
    } catch (err: unknown) {
        vscode.window.showErrorMessage(`Failed to read git state: ${err instanceof Error ? err.message : err}`);
        return;
    }

    const priorSummary = getSessionSummary(taskId);
    let summaryMd: string;
    if (priorSummary) {
        summaryMd = priorSummary;
    } else if (llmSummary) {
        summaryMd = [`# Session Summary: ${label}`, '', llmSummary].join('\n');
    } else {
        summaryMd = [
            `# Session Summary: ${label}`,
            '',
            '## What was tried',
            '',
            '## Decisions made',
            '',
            "## What's left",
            '',
            ...(llmSummaryError ? [`_Claude auto-draft failed: ${llmSummaryError}_`, ''] : []),
            ...(recentActivity ? ['---', '', '_Reference below, fill in manually:_', '', recentActivity, ''] : []),
        ].join('\n');
    }

    const now = new Date().toISOString();
    const status = await checkStatus();
    const profile: SessionProfile = {
        taskId,
        label,
        beamId,
        repoRoot,
        gitBranch: gitRef?.branch,
        gitCommitSha: gitRef?.sha,
        remoteUrl,
        createdBy: existingProfile?.createdBy ?? (status.user || os.userInfo().username),
        createdAt: existingProfile?.createdAt ?? now,
        updatedAt: now,
    };
    saveSessionProfile(profile, summaryMd);
    sessionProfilesProvider.refresh();
    await vscode.commands.executeCommand('beamSessionProfiles.focus');
    const gitSuffix = gitRef ? ` (${gitRef.branch}@${gitRef.sha.slice(0, 7)})` : ' (no git repository detected on this beam)';
    vscode.window.showInformationMessage(
        `Session profile "${label}" ${existingProfile ? 'updated' : 'saved'}${gitSuffix}.`
    );

    // Open the saved summary file itself (not a scratch buffer) so further edits save
    // straight back to disk — no separate confirm-before-save step.
    const summaryDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(getSessionSummaryPath(taskId)));
    await vscode.window.showTextDocument(summaryDoc, { preview: false });
}

// Shared by beams.createSetupProfile (no existing profile, prompts for a fresh taskId)
// and beams.updateSessionProfile (existing setup profile, taskId/inputs pre-filled and
// overwritten in place on save).
async function runSetupProfileFlow(
    sessionProfilesProvider: SessionProfilesProvider,
    existingProfile?: SessionProfile,
): Promise<void> {
    let taskId = existingProfile?.taskId;
    if (!taskId) {
        taskId = await vscode.window.showInputBox({
            prompt: 'Profile id',
            placeHolder: 'vscode-server',
            ignoreFocusOut: true,
            validateInput: v => /^[a-z0-9][a-z0-9-_]*$/i.test(v) ? undefined : 'Use letters, numbers, - and _ only',
        });
        if (!taskId) return;
    }

    const label = await vscode.window.showInputBox({
        prompt: 'Short label for this profile',
        value: existingProfile?.label ?? taskId,
        ignoreFocusOut: true,
    });
    if (label === undefined) return;

    const priorDescription = existingProfile
        ? getSessionSummary(existingProfile.taskId).replace(/^#[^\n]*\n+/, '').trim()
        : '';
    const description = await vscode.window.showInputBox({
        prompt: 'Short description (saved as this profile\'s summary)',
        placeHolder: 'Installs code-server and publishes it for browser-based development',
        value: priorDescription || undefined,
        ignoreFocusOut: true,
    });
    if (description === undefined) return;

    const commandsInput = await vscode.window.showInputBox({
        prompt: 'Setup commands to run on the target beam (semicolon-separated)',
        placeHolder: 'curl -fsSL https://code-server.dev/install.sh | sh; ...',
        value: existingProfile?.setup?.commands?.join('; '),
        ignoreFocusOut: true,
    });
    const commands = (commandsInput ?? '').split(';').map(c => c.trim()).filter(Boolean);
    if (commands.length === 0) {
        vscode.window.showErrorMessage('At least one setup command is required.');
        return;
    }

    const autoPublishPick = await vscode.window.showQuickPick(
        [
            { label: 'No', description: 'Just run the setup commands', value: false },
            { label: 'Yes', description: 'Also run `tsh beams publish` after setup', value: true },
        ],
        {
            placeHolder: 'Automatically publish the beam after setup?',
            ignoreFocusOut: true,
        }
    );
    if (!autoPublishPick) return;

    const now = new Date().toISOString();
    const status = await checkStatus();
    const profile: SessionProfile = {
        taskId,
        label,
        beamId: '',
        createdBy: existingProfile?.createdBy ?? (status.user || os.userInfo().username),
        createdAt: existingProfile?.createdAt ?? now,
        updatedAt: now,
        setup: { commands, autoPublish: autoPublishPick.value },
    };
    saveSessionProfile(profile, `# ${label}\n\n${description}\n`);
    sessionProfilesProvider.refresh();
    await vscode.commands.executeCommand('beamSessionProfiles.focus');
    vscode.window.showInformationMessage(`Setup profile "${label}" ${existingProfile ? 'updated' : 'saved'}.`);
}

