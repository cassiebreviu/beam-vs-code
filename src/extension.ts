import * as vscode from 'vscode';
import { BeamItem } from './beamItem';
import { BeamsProvider } from './beamsProvider';
import { BeamFileExplorer } from './fileExplorer';
import { BeamFileSystemProvider } from './beamFs';
import { AgentActivityProvider } from './activity';
import { AgentEventsProvider } from './events';
import { registerCommands } from './commands';

export function activate(context: vscode.ExtensionContext): void {
    const provider = new BeamsProvider();
    const fileExplorer = new BeamFileExplorer();
    const activityProvider = new AgentActivityProvider();
    const eventsProvider = new AgentEventsProvider();

    const beamsTree = vscode.window.createTreeView<BeamItem>('beamsList', {
        treeDataProvider: provider,
        showCollapseAll: false,
    });

    beamsTree.onDidChangeSelection(e => {
        const selected = e.selection[0];
        if (selected) {
            fileExplorer.setBeam(selected.beam);
            activityProvider.setBeam(selected.beam);
            eventsProvider.setBeam(selected.beam);
        }
    });

    vscode.window.createTreeView('beamFiles', {
        treeDataProvider: fileExplorer,
        showCollapseAll: true,
    });

    vscode.window.createTreeView('beamActivity', {
        treeDataProvider: activityProvider,
        showCollapseAll: false,
    });

    vscode.window.createTreeView('beamEvents', {
        treeDataProvider: eventsProvider,
        showCollapseAll: false,
    });

    const fsProvider = new BeamFileSystemProvider();
    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider('beam', fsProvider, {
            isCaseSensitive: true,
        })
    );

    registerCommands(context, provider, fileExplorer, activityProvider);

    context.subscriptions.push({ dispose: () => provider.dispose() });
    context.subscriptions.push({ dispose: () => activityProvider.stop() });
    context.subscriptions.push({ dispose: () => eventsProvider.stop() });
}

export function deactivate(): void {}
