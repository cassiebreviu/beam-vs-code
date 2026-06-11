import * as vscode from 'vscode';
import { BeamsProvider } from './beamsProvider';
import { BeamFileExplorer } from './fileExplorer';
import { BeamFileSystemProvider } from './beamFs';
import { registerCommands } from './commands';

export function activate(context: vscode.ExtensionContext): void {
    const provider = new BeamsProvider();
    const fileExplorer = new BeamFileExplorer();

    vscode.window.createTreeView('beamsList', {
        treeDataProvider: provider,
        showCollapseAll: false,
    });

    vscode.window.createTreeView('beamFiles', {
        treeDataProvider: fileExplorer,
        showCollapseAll: true,
    });

    const fsProvider = new BeamFileSystemProvider();
    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider('beam', fsProvider, {
            isCaseSensitive: true,
        })
    );

    registerCommands(context, provider, fileExplorer);

    context.subscriptions.push({ dispose: () => provider.dispose() });
}

export function deactivate(): void {}
