import * as vscode from 'vscode';
import { Beam, execOnBeam } from './tsh';

type ChangeStatus = 'M' | 'A' | 'D' | 'R' | '?';

interface FileChange {
    status: ChangeStatus;
    path: string;
    beamId: string;
}

const STATUS_ICONS: Record<ChangeStatus, string> = {
    M: 'diff-modified',
    A: 'diff-added',
    D: 'diff-removed',
    R: 'diff-renamed',
    '?': 'question',
};

const STATUS_LABELS: Record<ChangeStatus, string> = {
    M: 'Modified',
    A: 'Added',
    D: 'Deleted',
    R: 'Renamed',
    '?': 'Untracked',
};

class FileChangeItem extends vscode.TreeItem {
    constructor(public readonly change: FileChange) {
        const filename = change.path.split('/').pop() ?? change.path;
        super(filename, vscode.TreeItemCollapsibleState.None);

        this.description = change.path;
        this.iconPath = new vscode.ThemeIcon(STATUS_ICONS[change.status]);
        this.tooltip = `${STATUS_LABELS[change.status]}: ${change.path}`;
        this.contextValue = 'fileChange';

        if (change.status !== 'D') {
            this.command = {
                command: 'beams.openChangeDiff',
                title: 'Open Diff',
                arguments: [change],
            };
        }
    }
}

export class FileChangesProvider implements vscode.TreeDataProvider<FileChangeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<FileChangeItem | undefined | null>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private currentBeam: Beam | undefined;
    private changes: FileChange[] = [];
    private pollInterval: NodeJS.Timeout | undefined;
    private lastOutput = '';

    setBeam(beam: Beam): void {
        this.currentBeam = beam;
        this.changes = [];
        this.lastOutput = '';
        this.startPolling();
        this._onDidChangeTreeData.fire(undefined);
    }

    refresh(): void {
        this.lastOutput = '';
        this.poll();
    }

    stop(): void {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = undefined;
        }
    }

    private startPolling(): void {
        this.stop();
        this.poll();
        this.pollInterval = setInterval(() => this.poll(), 5000);
    }

    private async poll(): Promise<void> {
        if (!this.currentBeam) return;

        try {
            const output = await execOnBeam(this.currentBeam.id, [
                'bash', '-c', 'cd /home/beams && git status --porcelain 2>/dev/null || true'
            ]);

            if (output === this.lastOutput) return;
            this.lastOutput = output;

            this.changes = this.parseStatus(output, this.currentBeam.id);
            this._onDidChangeTreeData.fire(undefined);
        } catch {
            // beam may not have git initialized
        }
    }

    private parseStatus(output: string, beamId: string): FileChange[] {
        const lines = output.trim().split('\n').filter(Boolean);
        const changes: FileChange[] = [];

        for (const line of lines) {
            const statusChar = line.slice(0, 2).trim();
            const filePath = line.slice(3);
            if (!filePath) continue;

            let status: ChangeStatus;
            if (statusChar === '??') {
                status = '?';
            } else if (statusChar.includes('D')) {
                status = 'D';
            } else if (statusChar.includes('A')) {
                status = 'A';
            } else if (statusChar.includes('R')) {
                status = 'R';
            } else {
                status = 'M';
            }

            changes.push({ status, path: filePath, beamId });
        }

        return changes;
    }

    getTreeItem(element: FileChangeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): FileChangeItem[] {
        if (!this.currentBeam) {
            return [new FileChangeItem({ status: 'M', path: 'Select a beam to view changes', beamId: '' })];
        }

        if (this.changes.length === 0) {
            const item = new vscode.TreeItem('No uncommitted changes', vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('check');
            return [item as unknown as FileChangeItem];
        }

        return this.changes.map(c => new FileChangeItem(c));
    }
}
