import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

export interface Beam {
    id: string;
    uuid: string;
    owner: string;
    expires: string;
    url: string;
}

export interface TshStatus {
    loggedIn: boolean;
    user: string;
    cluster: string;
    validUntil: string;
}

async function runTsh(args: string[], options?: { timeout?: number }): Promise<string> {
    const { stdout } = await exec('tsh', args, {
        timeout: options?.timeout ?? 30000,
        maxBuffer: 50 * 1024 * 1024,
    });
    return stdout;
}

export async function listBeams(): Promise<Beam[]> {
    const output = await runTsh(['beams', 'ls', '-f', 'json']);
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) {
        return [];
    }
    return parsed;
}

export async function addBeam(): Promise<Beam> {
    const output = await runTsh(['beams', 'add', '-f', 'json']);
    return JSON.parse(output);
}

export async function removeBeam(id: string): Promise<void> {
    await runTsh(['beams', 'rm', id]);
}

export async function publishBeam(id: string, tcp = false): Promise<string> {
    const args = ['beams', 'publish'];
    if (tcp) {
        args.push('--tcp');
    }
    args.push(id);
    const output = await runTsh(args);
    const urlMatch = output.match(/https?:\/\/\S+/);
    return urlMatch ? urlMatch[0] : output.trim();
}

export async function unpublishBeam(id: string): Promise<void> {
    await runTsh(['beams', 'unpublish', id]);
}

export async function execOnBeam(id: string, command: string[], timeout?: number): Promise<string> {
    const output = await runTsh(['beams', 'exec', id, '--', ...command], { timeout: timeout ?? 30000 });
    return output;
}

export async function checkStatus(): Promise<TshStatus> {
    try {
        const output = await runTsh(['status']);
        const user = output.match(/Logged in as:\s+(\S+)/)?.[1] ?? '';
        const cluster = output.match(/Cluster:\s+(\S+)/)?.[1] ?? '';
        const validUntil = output.match(/Valid until:\s+(.+?)(?:\s+\[|$)/)?.[1] ?? '';
        return { loggedIn: true, user, cluster, validUntil };
    } catch {
        return { loggedIn: false, user: '', cluster: '', validUntil: '' };
    }
}

export async function scpFromBeam(id: string, remotePath: string, localPath: string): Promise<void> {
    await runTsh(['beams', 'scp', `${id}:${remotePath}`, localPath], { timeout: 300000 });
}

export async function isTshAvailable(): Promise<boolean> {
    try {
        await exec('tsh', ['version'], { timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}
