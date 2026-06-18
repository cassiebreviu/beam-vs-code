import * as vscode from 'vscode';
import { Beam, execOnBeam } from './tsh';

interface FileEntry {
    name: string;
    path: string;
    isDirectory: boolean;
    beamId: string;
}

class FileItem extends vscode.TreeItem {
    constructor(public readonly entry: FileEntry) {
        super(
            entry.name,
            entry.isDirectory
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
        );

        this.iconPath = entry.isDirectory
            ? new vscode.ThemeIcon('folder')
            : new vscode.ThemeIcon('file');

        this.contextValue = entry.isDirectory ? 'beamFolder' : 'beamFile';

        this.resourceUri = vscode.Uri.parse(`beam://${entry.beamId}${entry.path}`);

        if (!entry.isDirectory) {
            this.command = {
                command: 'beams.openFile',
                title: 'Open File',
                arguments: [entry],
            };
        }
    }
}

export class BeamFileExplorer implements vscode.TreeDataProvider<FileItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<FileItem | undefined | null>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private currentBeam: Beam | undefined;

    setBeam(beam: Beam): void {
        this.currentBeam = beam;
        this._onDidChangeTreeData.fire(undefined);
    }

    getBeam(): Beam | undefined {
        return this.currentBeam;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: FileItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: FileItem): Promise<FileItem[]> {
        if (!this.currentBeam) {
            return [];
        }

        const dirPath = element ? element.entry.path : '/home/beams';
        const beamId = this.currentBeam.id;

        try {
            const output = await execOnBeam(beamId, ['ls', '-1F', dirPath]);

            if (!output.trim()) {
                return [];
            }

            const entries: FileItem[] = [];
            for (const line of output.trim().split('\n')) {
                if (!line) continue;
                const isDirectory = line.endsWith('/');
                const isLink = line.endsWith('@');
                const isExec = line.endsWith('*');
                const name = (isDirectory || isLink || isExec)
                    ? line.slice(0, -1)
                    : line;
                if (!name || name.startsWith('.')) continue;

                const path = dirPath.endsWith('/')
                    ? `${dirPath}${name}`
                    : `${dirPath}/${name}`;

                entries.push(new FileItem({
                    name,
                    path,
                    isDirectory,
                    beamId,
                }));
            }

            entries.sort((a, b) => {
                if (a.entry.isDirectory !== b.entry.isDirectory) {
                    return a.entry.isDirectory ? -1 : 1;
                }
                return a.entry.name.localeCompare(b.entry.name);
            });

            return entries;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to list files: ${msg}`);
            return [];
        }
    }
}
