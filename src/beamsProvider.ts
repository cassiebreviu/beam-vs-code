import * as vscode from 'vscode';
import { BeamItem } from './beamItem';
import { listBeams, isTshAvailable } from './tsh';

export class BeamsProvider implements vscode.TreeDataProvider<BeamItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<BeamItem | undefined | null>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private refreshInterval: NodeJS.Timeout | undefined;

    constructor() {
        this.refreshInterval = setInterval(() => this.refresh(), 30000);
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    dispose(): void {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
        }
    }

    getTreeItem(element: BeamItem): vscode.TreeItem {
        return element;
    }

    async getChildren(): Promise<BeamItem[]> {
        const available = await isTshAvailable();
        if (!available) {
            vscode.window.showErrorMessage(
                'tsh is not installed or not in PATH. Install Teleport: https://goteleport.com/docs/installation/'
            );
            return [];
        }

        try {
            const beams = await listBeams();
            return beams.map(b => new BeamItem(b));
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('not logged in') || msg.includes('relogin')) {
                vscode.window.showWarningMessage('Not logged in to Teleport. Run: tsh login');
            }
            return [];
        }
    }
}
