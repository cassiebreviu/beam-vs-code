import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import { execOnBeam, checkStatus } from './tsh';

export type VncState = 'off' | 'installing' | 'running' | 'tunneled' | 'error';

let _instance: VncManager | undefined;
export function getVncManager(): VncManager | undefined { return _instance; }

export class VncManager implements vscode.Disposable {
    private _state: VncState = 'off';
    private _beamId: string | undefined;
    private _tunnel: ChildProcess | undefined;
    private _onDidChangeState = new vscode.EventEmitter<VncState>();
    readonly onDidChangeState = this._onDidChangeState.event;
    private output = vscode.window.createOutputChannel('Beams: VNC');

    constructor() {
        _instance = this;
    }

    get state(): VncState { return this._state; }
    get beamId(): string | undefined { return this._beamId; }

    isVncActive(beamId: string): boolean {
        return this._beamId === beamId && (this._state === 'running' || this._state === 'tunneled');
    }

    private setState(s: VncState): void {
        this._state = s;
        this._onDidChangeState.fire(s);
    }

    async startVnc(beamId: string): Promise<void> {
        this._beamId = beamId;
        this.setState('installing');

        const config = vscode.workspace.getConfiguration('beams');
        const geometry = config.get<string>('vnc.geometry', '1920x1080');

        const installCmd = [
            'bash', '-c',
            'sudo apt-get update -qq && sudo apt-get install -y tigervnc-standalone-server dbus-x11 openbox tint2 thunar firefox-esr && ' +
            '(pgrep Xtigervnc && kill $(pgrep Xtigervnc) && sleep 1 || true) && ' +
            'rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null; ' +
            `Xtigervnc :1 -geometry ${geometry} -depth 24 -rfbport 5901 -SecurityTypes None & ` +
            'sleep 1 && export DISPLAY=:1 && openbox & tint2 & vncconfig -nowin & ' +
            'code --no-sandbox --disable-gpu & ' +
            'sleep 2 && pgrep Xtigervnc > /dev/null && echo VNC_READY',
        ];

        try {
            this.output.appendLine(`[${beamId}] Installing and starting VNC...`);
            const result = await execOnBeam(beamId, installCmd, 120000);
            this.output.appendLine(result);

            if (result.includes('VNC_READY')) {
                this.setState('running');
                this.output.appendLine(`[${beamId}] VNC server running on :5901`);
            } else {
                this.setState('error');
                this.output.appendLine(`[${beamId}] VNC server failed to start`);
            }
        } catch (err: unknown) {
            this.setState('error');
            const msg = err instanceof Error ? err.message : String(err);
            this.output.appendLine(`[${beamId}] Error: ${msg}`);
            throw err;
        }
    }

    async openTunnel(beamId: string): Promise<void> {
        if (this._tunnel) {
            this.closeTunnel();
        }

        const status = await checkStatus();
        if (!status.loggedIn || !status.cluster) {
            throw new Error('Not logged in to Teleport');
        }

        const config = vscode.workspace.getConfiguration('beams');
        const localPort = config.get<number>('vnc.localPort', 5901);
        const host = `${beamId}.${status.cluster}`;

        this.output.appendLine(`[${beamId}] Opening SSH tunnel: localhost:${localPort} → ${host}:5901`);

        this._tunnel = spawn('ssh', [
            '-L', `${localPort}:127.0.0.1:5901`,
            '-N',
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            `beams@${host}`,
        ]);

        this._tunnel.stderr?.on('data', (data: Buffer) => {
            this.output.appendLine(`[tunnel] ${data.toString().trim()}`);
        });

        this._tunnel.on('error', (err) => {
            this.output.appendLine(`[tunnel] Error: ${err.message}`);
            this._tunnel = undefined;
            this.setState('running');
        });

        this._tunnel.on('close', (code) => {
            this.output.appendLine(`[tunnel] Closed (code ${code})`);
            this._tunnel = undefined;
            if (this._state === 'tunneled') {
                this.setState('running');
            }
        });

        // Give SSH a moment to establish
        await new Promise(resolve => setTimeout(resolve, 2000));

        if (this._tunnel && !this._tunnel.killed) {
            this.setState('tunneled');
        }
    }

    closeTunnel(): void {
        if (this._tunnel) {
            this._tunnel.kill();
            this._tunnel = undefined;
            if (this._state === 'tunneled') {
                this.setState('running');
            }
            this.output.appendLine('Tunnel closed');
        }
    }

    async getStatus(beamId: string): Promise<'off' | 'running' | 'tunneled'> {
        if (this._tunnel && !this._tunnel.killed && this._beamId === beamId) {
            return 'tunneled';
        }
        try {
            const result = await execOnBeam(beamId, ['pgrep', 'Xtigervnc'], 5000);
            if (result.trim()) {
                return 'running';
            }
        } catch {
            // pgrep exits non-zero if no match
        }
        return 'off';
    }

    dispose(): void {
        this.closeTunnel();
        this._onDidChangeState.dispose();
        this.output.dispose();
    }
}
