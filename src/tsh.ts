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


// tsh colourises its diagnostics, so raw error text arrives with SGR escapes embedded
// (e.g. "\x1b[31mERROR: \x1b[0m..."). Strip them before matching or displaying.
export function stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

export type TshErrorKind = 'disconnected' | 'auth' | 'other';

// A beam that has expired, been deleted, or stopped answering is a normal, expected
// end-of-life condition rather than a failure the user needs to act on. `tsh` reports
// it through several different wordings depending on how far the connection got.
const DISCONNECT_PATTERNS = [
    'does not exist',
    'not found',
    'is not running',
    'connection refused',
    'connection reset',
    'context deadline exceeded',
    'i/o timeout',
    'no route to host',
    'broken pipe',
    'unexpected eof',
    'ssh: handshake failed',
    'failed to dial',
    'dial tcp',
];

const AUTH_PATTERNS = [
    'not logged in',
    'relogin',
    'certificate has expired',
    'access denied',
];

export function tshErrorMessage(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return stripAnsi(raw)
        .replace(/^Command failed:[^\n]*\n?/, '')
        .replace(/^ERROR:\s*/gm, '')
        .trim();
}

// Disconnect patterns are checked before auth ones on purpose: when a beam is gone,
// `tsh` first tries to re-resolve it and emits "cannot relogin in non-interactive
// session" alongside "does not exist". Classifying that as an auth problem would send
// the user off to `tsh login` for what is really just a dead beam.
export function classifyTshError(err: unknown): TshErrorKind {
    const msg = tshErrorMessage(err).toLowerCase();
    if (DISCONNECT_PATTERNS.some(p => msg.includes(p))) {
        return 'disconnected';
    }
    if (AUTH_PATTERNS.some(p => msg.includes(p))) {
        return 'auth';
    }
    const code = (err as { code?: unknown } | undefined)?.code;
    const killed = (err as { killed?: unknown } | undefined)?.killed;
    if (code === 'ETIMEDOUT' || killed === true) {
        return 'disconnected';
    }
    return 'other';
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

export async function waitForBeamReady(id: string, timeoutMs = 60000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            await execOnBeam(id, ['true'], 5000);
            return;
        } catch {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    throw new Error(`Beam "${id}" did not become ready within ${timeoutMs / 1000}s`);
}

export async function detectRepoRoot(beamId: string): Promise<string | undefined> {
    try {
        const output = await execOnBeam(beamId, ['git', '-C', '/home/beams', 'rev-parse', '--show-toplevel'], 10000);
        const root = output.trim();
        if (root) {
            return root;
        }
    } catch { /* no repo at /home/beams */ }

    try {
        // NOTE: tsh beams exec joins the argv into one remote command line rather than
        // preserving argv boundaries, so a `['bash', '-c', '<compound command>']` wrapper
        // has its script truncated to just the first word by the outer shell. Pass
        // compound commands as a single string element instead — no bash -c wrapper.
        const output = await execOnBeam(beamId, [
            'find /home/beams -maxdepth 2 -name .git -type d -print -quit',
        ], 10000);
        const gitDir = output.trim();
        if (gitDir) {
            return gitDir.replace(/\/\.git$/, '');
        }
    } catch { /* nothing found */ }

    return undefined;
}

// `tsh beams exec` joins its argv into a single remote command line rather than preserving
// argument boundaries (confirmed empirically — a multi-element `command` array arrives on the
// beam as one space-joined string re-parsed by the remote shell). Any value that isn't a fixed
// literal — file paths, commit messages, branch names, anything sourced from user input or a
// stored profile — must be quoted with this before being interpolated into a command string,
// or it can break argument boundaries or inject shell syntax on the beam.
export function shellSingleQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
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
