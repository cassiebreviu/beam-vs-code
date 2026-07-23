import * as vscode from 'vscode';
import { execOnBeam } from './tsh';

export interface PollConsumer {
    onGitStatus?(beamId: string, repoRoot: string, porcelain: string, headSha: string): void;
    onFileStats?(beamId: string, stats: Map<string, number>): void;
}

export class BeamPoller implements vscode.Disposable {
    private gitInterval: NodeJS.Timeout | undefined;
    private fileStatInterval: NodeJS.Timeout | undefined;
    private consumers = new Set<PollConsumer>();
    private currentBeamId: string | undefined;
    private repoRoot: string | undefined;
    private headSha = '';
    private trackedFiles = new Set<string>();
    private gitBusy = false;
    private statBusy = false;
    private errorCount = 0;
    private focusListener: vscode.Disposable | undefined;
    private configListener: vscode.Disposable | undefined;
    private paused = false;

    constructor() {
        this.focusListener = vscode.window.onDidChangeWindowState(state => {
            this.paused = !state.focused;
        });
        this.configListener = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('beams.git')) {
                this.restart();
            }
        });
    }

    async setBeam(beamId: string): Promise<void> {
        this.stop();
        this.currentBeamId = beamId;
        this.repoRoot = undefined;
        this.headSha = '';
        this.trackedFiles.clear();
        this.errorCount = 0;

        await this.detectRepo();
        this.start();
    }

    getRepoRoot(): string | undefined {
        return this.repoRoot;
    }

    hasGitRepo(): boolean {
        return this.repoRoot !== undefined;
    }

    getBeamId(): string | undefined {
        return this.currentBeamId;
    }

    getHeadSha(): string {
        return this.headSha;
    }

    addConsumer(consumer: PollConsumer): void {
        this.consumers.add(consumer);
    }

    removeConsumer(consumer: PollConsumer): void {
        this.consumers.delete(consumer);
    }

    trackFile(remotePath: string): void {
        this.trackedFiles.add(remotePath);
    }

    untrackFile(remotePath: string): void {
        this.trackedFiles.delete(remotePath);
    }

    clearTrackedFiles(): void {
        this.trackedFiles.clear();
    }

    pollNow(): void {
        this.pollGitStatus();
    }

    private async detectRepo(): Promise<void> {
        if (!this.currentBeamId) return;
        const enabled = vscode.workspace.getConfiguration('beams').get<boolean>('git.enabled', true);
        if (!enabled) return;

        try {
            const output = await execOnBeam(this.currentBeamId, [
                'git', '-C', '/home/beams', 'rev-parse', '--show-toplevel',
            ], 10000);
            const root = output.trim();
            if (root) {
                this.repoRoot = root;
                return;
            }
        } catch { /* no git repo at /home/beams */ }

        try {
            const output = await execOnBeam(this.currentBeamId, [
                'bash', '-c', 'find /home/beams -maxdepth 2 -name .git -type d -print -quit',
            ], 10000);
            const gitDir = output.trim();
            if (gitDir) {
                this.repoRoot = gitDir.replace(/\/.git$/, '');
            }
        } catch { /* nothing found */ }
    }

    private start(): void {
        const config = vscode.workspace.getConfiguration('beams');
        const gitMs = (config.get<number>('git.statusPollInterval', 5)) * 1000;
        const statMs = (config.get<number>('git.fileStatPollInterval', 3)) * 1000;

        if (this.repoRoot) {
            this.pollGitStatus();
            this.gitInterval = setInterval(() => this.pollGitStatus(), gitMs);
        }
        this.pollFileStats();
        this.fileStatInterval = setInterval(() => this.pollFileStats(), statMs);
    }

    private restart(): void {
        this.stop();
        if (this.currentBeamId) {
            this.start();
        }
    }

    stop(): void {
        if (this.gitInterval) {
            clearInterval(this.gitInterval);
            this.gitInterval = undefined;
        }
        if (this.fileStatInterval) {
            clearInterval(this.fileStatInterval);
            this.fileStatInterval = undefined;
        }
    }

    private async pollGitStatus(): Promise<void> {
        if (!this.currentBeamId || !this.repoRoot || this.gitBusy || this.paused) return;
        this.gitBusy = true;
        try {
            const output = await execOnBeam(this.currentBeamId, [
                'bash', '-c', `cd "${this.repoRoot}" && git rev-parse HEAD 2>/dev/null && echo "---SEP---" && git status --porcelain=v1 2>/dev/null`,
            ], 15000);

            const sepIdx = output.indexOf('---SEP---');
            if (sepIdx === -1) {
                this.gitBusy = false;
                return;
            }
            this.headSha = output.slice(0, sepIdx).trim();
            const porcelain = output.slice(sepIdx + '---SEP---'.length + 1);

            for (const consumer of this.consumers) {
                consumer.onGitStatus?.(this.currentBeamId, this.repoRoot, porcelain, this.headSha);
            }
            this.errorCount = 0;
        } catch {
            this.errorCount++;
        }
        this.gitBusy = false;
    }

    private async pollFileStats(): Promise<void> {
        if (!this.currentBeamId || this.trackedFiles.size === 0 || this.statBusy || this.paused) return;
        this.statBusy = true;
        try {
            const files = [...this.trackedFiles];
            const output = await execOnBeam(this.currentBeamId, [
                'bash', '-c', `stat --format='%n %Y' ${files.map(f => `"${f}"`).join(' ')} 2>/dev/null || true`,
            ], 10000);

            const stats = new Map<string, number>();
            for (const line of output.split('\n')) {
                const lastSpace = line.lastIndexOf(' ');
                if (lastSpace === -1) continue;
                const path = line.slice(0, lastSpace);
                const mtime = parseInt(line.slice(lastSpace + 1), 10);
                if (path && !isNaN(mtime)) {
                    stats.set(path, mtime);
                }
            }

            if (stats.size > 0) {
                for (const consumer of this.consumers) {
                    consumer.onFileStats?.(this.currentBeamId, stats);
                }
            }
        } catch { /* ignore */ }
        this.statBusy = false;
    }

    dispose(): void {
        this.stop();
        this.focusListener?.dispose();
        this.configListener?.dispose();
        this.consumers.clear();
    }
}
