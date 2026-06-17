import * as vscode from 'vscode';
import { execOnBeam } from './tsh';

export class BeamFileSystemProvider implements vscode.FileSystemProvider {
    private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this._onDidChangeFile.event;

    watch(): vscode.Disposable {
        return new vscode.Disposable(() => {});
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const { beamId, remotePath } = this.parseUri(uri);
        const GIT_HEAD_PREFIX = '/.git-diff-head/';
        if (remotePath.startsWith(GIT_HEAD_PREFIX)) {
            return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 };
        }
        try {
            const output = await execOnBeam(beamId, [
                'stat', '--format=%F_%s_%Y', remotePath
            ]);
            const parts = output.trim().split('_');
            const typePart = parts.slice(0, -2).join('_');
            const isDir = typePart === 'directory';
            const size = parseInt(parts[parts.length - 2] ?? '0', 10);
            const mtime = parseInt(parts[parts.length - 1] ?? '0', 10) * 1000;
            return {
                type: isDir ? vscode.FileType.Directory : vscode.FileType.File,
                ctime: mtime,
                mtime,
                size,
            };
        } catch {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const { beamId, remotePath } = this.parseUri(uri);
        const output = await execOnBeam(beamId, ['ls', '-1F', remotePath]);
        const entries: [string, vscode.FileType][] = [];
        for (const line of output.trim().split('\n')) {
            if (!line) continue;
            const isDir = line.endsWith('/');
            const isLink = line.endsWith('@');
            const isExec = line.endsWith('*');
            const name = (isDir || isLink || isExec) ? line.slice(0, -1) : line;
            if (!name) continue;
            entries.push([
                name,
                isDir ? vscode.FileType.Directory : vscode.FileType.File,
            ]);
        }
        return entries;
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const { beamId, remotePath } = this.parseUri(uri);
        try {
            const GIT_HEAD_PREFIX = '/.git-diff-head/';
            if (remotePath.startsWith(GIT_HEAD_PREFIX)) {
                const filePath = remotePath.slice(GIT_HEAD_PREFIX.length);
                const output = await execOnBeam(beamId, [
                    'bash', '-c', `cd /home/beams && git show HEAD:"${filePath}" 2>/dev/null || true`
                ]);
                return Buffer.from(output);
            }
            const output = await execOnBeam(beamId, ['cat', remotePath]);
            return Buffer.from(output);
        } catch {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
        const { beamId, remotePath } = this.parseUri(uri);
        const encoded = Buffer.from(content).toString('base64');
        await execOnBeam(beamId, [
            'bash', '-c', `echo '${encoded}' | base64 -d > '${remotePath}'`
        ]);
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    }

    async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
        const { beamId, remotePath } = this.parseUri(uri);
        const args = options.recursive ? ['rm', '-rf', remotePath] : ['rm', remotePath];
        await execOnBeam(beamId, args);
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    }

    async rename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
        const old = this.parseUri(oldUri);
        const neu = this.parseUri(newUri);
        if (old.beamId !== neu.beamId) {
            throw vscode.FileSystemError.NoPermissions('Cannot move between beams');
        }
        await execOnBeam(old.beamId, ['mv', old.remotePath, neu.remotePath]);
        this._onDidChangeFile.fire([
            { type: vscode.FileChangeType.Deleted, uri: oldUri },
            { type: vscode.FileChangeType.Created, uri: newUri },
        ]);
    }

    async createDirectory(uri: vscode.Uri): Promise<void> {
        const { beamId, remotePath } = this.parseUri(uri);
        await execOnBeam(beamId, ['mkdir', '-p', remotePath]);
    }

    private parseUri(uri: vscode.Uri): { beamId: string; remotePath: string } {
        return {
            beamId: uri.authority,
            remotePath: uri.path || '/',
        };
    }
}
