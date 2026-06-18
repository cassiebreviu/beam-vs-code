import * as vscode from 'vscode';
import { BeamItem } from './beamItem';
import { BeamsProvider } from './beamsProvider';
import { BeamFileExplorer } from './fileExplorer';
import { addBeam, removeBeam, publishBeam, unpublishBeam, execOnBeam, scpFromBeam, checkStatus, listBeams } from './tsh';
import { openBeamTerminal } from './terminal';
import { getAllTemplates, saveCustomTemplate, deleteCustomTemplate, getCustomTemplates } from './templates';
import { setupGithubOnBeam, openOAuthTerminal, autoSetupGithub, SECRET_KEY } from './github';
import { ensureBeamSshConfig } from './ssh';
import { AgentActivityProvider } from './activity';
import { AgentEventsProvider } from './events';
import * as path from 'path';

export function registerCommands(
    context: vscode.ExtensionContext,
    provider: BeamsProvider,
    fileExplorer: BeamFileExplorer,
    activityProvider: AgentActivityProvider,
    eventsProvider: AgentEventsProvider,
    poller?: import('./polling').BeamPoller,
    _getScm?: () => import('./scm').BeamGitScmProvider | undefined,
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
                    label: t.custom ? `$(star) ${t.label}` : t.label,
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

            try {
                const beam = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `Creating beam (${picked.template.label})...` },
                    async (progress) => {
                        const b = await addBeam();
                        if (picked.template.commands.length > 0) {
                            progress.report({ message: 'Running template setup...' });
                            for (const cmd of picked.template.commands) {
                                await execOnBeam(b.id, ['bash', '-c', cmd]);
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
                ignoreFocusOut: true,
            });
            if (!name) {
                return;
            }

            const description = await vscode.window.showInputBox({
                prompt: 'Short description',
                placeHolder: 'Python + Redis + custom tools',
                ignoreFocusOut: true,
            });
            if (description === undefined) {
                return;
            }

            const commandsInput = await vscode.window.showInputBox({
                prompt: 'Setup commands (semicolon-separated)',
                placeHolder: 'apt install -y redis; pip install redis; mkdir -p /home/beams/project',
                value: '',
                ignoreFocusOut: true,
            });
            if (commandsInput === undefined) {
                return;
            }

            // If user left commands empty, capture full environment from the beam
            let commands: string[];
            let envSnapshot: import('./templates').TemplateEnvSnapshot | undefined;
            let github: import('./templates').TemplateGithub | undefined;
            if (!commandsInput.trim()) {
                const capture = await vscode.window.showQuickPick(
                    [
                        { label: 'Capture full environment', description: 'Auto-detect packages, git config, env vars, scripts' },
                        { label: 'Save with no commands', description: 'Template will just create an empty beam' },
                    ],
                    { placeHolder: 'No commands entered — capture from beam?' }
                );

                if (capture?.label === 'Capture full environment') {
                    const captured = await captureBeamConfig(item.beam.id);
                    commands = captured.commands;
                    envSnapshot = captured.envSnapshot;
                    // Capture current GitHub settings as template defaults
                    const cfg = vscode.workspace.getConfiguration('beams');
                    const ghUsername = cfg.get<string>('github.username');
                    const ghAuthMethod = cfg.get<string>('github.authMethod') as 'pat' | 'oauth' | 'tsh-git' | '';
                    if (ghUsername && ghAuthMethod) {
                        github = {
                            username: ghUsername,
                            email: cfg.get<string>('github.email') || undefined,
                            authMethod: ghAuthMethod,
                        };
                    }
                } else {
                    commands = ['mkdir -p /home/beams/project'];
                }
            } else {
                commands = commandsInput.split(';').map(c => c.trim()).filter(Boolean);
            }

            await saveCustomTemplate({ label: name, description: description || '', commands, github, envSnapshot });
            vscode.window.showInformationMessage(`Template "${name}" saved.`);
        }),

        vscode.commands.registerCommand('beams.deleteTemplate', async () => {
            const custom = getCustomTemplates();
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

            await deleteCustomTemplate(picked.label);
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
                shellArgs: ['beams', 'exec', beamId, '--', 'bash', '-c', command],
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
        })
    );
}

interface CapturedConfig {
    commands: string[];
    github?: import('./templates').TemplateGithub;
    envSnapshot?: import('./templates').TemplateEnvSnapshot;
}

async function captureBeamConfig(beamId: string): Promise<CapturedConfig> {
    const commands: string[] = ['mkdir -p /home/beams/project'];
    const envSnapshot: import('./templates').TemplateEnvSnapshot = {};

    // Packages: pip
    try {
        const pipOutput = await execOnBeam(beamId, ['bash', '-c', 'pip freeze 2>/dev/null || true']);
        const packages = pipOutput.trim().split('\n').filter(l => l && !l.startsWith('#'));
        if (packages.length > 0) {
            commands.push('python3 -m venv /home/beams/project/.venv');
            commands.push(`/home/beams/project/.venv/bin/pip install ${packages.join(' ')}`);
        }
    } catch { /* no pip */ }

    // Packages: npm global
    try {
        const npmGlobal = await execOnBeam(beamId, ['bash', '-c', 'npm list -g --depth=0 --json 2>/dev/null || true']);
        const parsed = JSON.parse(npmGlobal);
        const deps = Object.keys(parsed.dependencies ?? {}).filter(d => d !== 'npm');
        if (deps.length > 0) {
            commands.push(`npm install -g ${deps.join(' ')}`);
        }
    } catch { /* no npm or parse error */ }

    // Packages: apt
    try {
        const aptOutput = await execOnBeam(beamId, ['bash', '-c', "apt-mark showmanual 2>/dev/null | grep -v -E '^(base-files|bash|coreutils|dpkg|apt)' || true"]);
        const aptPkgs = aptOutput.trim().split('\n').filter(Boolean);
        if (aptPkgs.length > 0) {
            commands.push(`apt-get install -y ${aptPkgs.join(' ')}`);
        }
    } catch { /* no apt */ }

    // Git config
    try {
        const gitOutput = await execOnBeam(beamId, ['bash', '-c', 'git config --global --list 2>/dev/null || true']);
        const entries = gitOutput.trim().split('\n')
            .filter(l => l.includes('='))
            .map(l => { const [k, ...v] = l.split('='); return { key: k, value: v.join('=') }; });
        if (entries.length > 0) {
            envSnapshot.gitConfig = entries;
            for (const { key, value } of entries) {
                commands.push(`git config --global "${key}" "${value}"`);
            }
        }
    } catch { /* no git */ }

    // Environment variables from .profile/.bashrc
    try {
        const envOutput = await execOnBeam(beamId, ['bash', '-c',
            'grep -h "^export " ~/.profile ~/.bashrc 2>/dev/null | sort -u || true']);
        const exports = envOutput.trim().split('\n').filter(Boolean);
        if (exports.length > 0) {
            envSnapshot.envVars = exports;
            for (const line of exports) {
                commands.push(`grep -qxF '${line}' ~/.bashrc 2>/dev/null || echo '${line}' >> ~/.bashrc`);
            }
        }
    } catch { /* ignore */ }

    // Custom scripts in ~/bin
    try {
        const binLs = await execOnBeam(beamId, ['bash', '-c', 'ls ~/bin 2>/dev/null || true']);
        const scripts = binLs.trim().split('\n').filter(Boolean);
        if (scripts.length > 0) {
            const binTar = await execOnBeam(beamId, ['bash', '-c',
                'tar -czf - -C ~ bin 2>/dev/null | base64 -w0'], 30000);
            if (binTar.trim() && binTar.trim().length < 5 * 1024 * 1024) {
                envSnapshot.binScriptsTar = binTar.trim();
                commands.push('mkdir -p ~/bin');
                commands.push(`echo "${binTar.trim()}" | base64 -d | tar -xzf - -C ~`);
                commands.push('chmod +x ~/bin/*');
            }
        }
    } catch { /* no ~/bin */ }

    // Systemd user services
    try {
        const units = await execOnBeam(beamId, ['bash', '-c',
            'systemctl --user list-unit-files --state=enabled --no-legend 2>/dev/null | awk "{print \\$1}" || true']);
        const services = units.trim().split('\n').filter(Boolean);
        if (services.length > 0) {
            const unitEntries: Array<{ name: string; content: string }> = [];
            for (const svc of services) {
                try {
                    const content = await execOnBeam(beamId, ['bash', '-c',
                        `cat ~/.config/systemd/user/${svc} 2>/dev/null || true`]);
                    if (content.trim()) {
                        unitEntries.push({ name: svc, content: content.trim() });
                        const escaped = content.trim().replace(/'/g, "'\\''");
                        commands.push(`mkdir -p ~/.config/systemd/user`);
                        commands.push(`cat > ~/.config/systemd/user/${svc} << 'UNIT_EOF'\n${escaped}\nUNIT_EOF`);
                        commands.push(`systemctl --user enable ${svc}`);
                    }
                } catch { /* skip this unit */ }
            }
            if (unitEntries.length > 0) {
                envSnapshot.systemdUnits = unitEntries;
            }
        }
    } catch { /* no systemd user */ }

    const hasSnapshot = envSnapshot.gitConfig || envSnapshot.envVars || envSnapshot.binScriptsTar || envSnapshot.systemdUnits;
    return {
        commands,
        envSnapshot: hasSnapshot ? envSnapshot : undefined,
    };
}

