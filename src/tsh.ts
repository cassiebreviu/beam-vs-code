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

export interface AppResource {
    name: string;
    cluster: string;
    proxy: string;
    subKind: string;
    publicAddr: string;
    uri: string;
    description: string;
    labels: Record<string, string>;
}

export interface DbResource {
    name: string;
    cluster: string;
    proxy: string;
    protocol: string;
    description: string;
    labels: Record<string, string>;
}

export interface KubeResource {
    name: string;
    cluster: string;
    proxy: string;
    labels: Record<string, string>;
}

export interface NodeResource {
    name: string;
    hostname: string;
    cluster: string;
    proxy: string;
    addr: string;
    labels: Record<string, string>;
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

export interface RawClusterProfile {
    profile_url?: string;
    username?: string;
    cluster?: string;
    roles?: string[];
    logins?: string[];
    valid_until?: string;
}

export async function listClusterProfiles(): Promise<{ active?: RawClusterProfile; profiles?: RawClusterProfile[] }> {
    const output = await runTsh(['status', '--format=json'], { timeout: 10000 });
    return JSON.parse(output);
}

// `tsh <kind> ls -f json` returns a bare array of resource objects; `--all` wraps each in
// {proxy, cluster, <kind>: {...}} so items from federated/leaf clusters carry their origin.
// The wrapper key names for db/kube couldn't be confirmed against a live cluster with such
// resources in this environment, so we fall back to a few plausible keys, then to the raw
// object itself, rather than assuming a single name and risking a silent empty result.
function unwrapResource(raw: Record<string, unknown>, wrapperKeys: string[]): { inner: Record<string, unknown>; cluster: string; proxy: string } {
    let inner = raw;
    for (const key of wrapperKeys) {
        if (raw[key] && typeof raw[key] === 'object') {
            inner = raw[key] as Record<string, unknown>;
            break;
        }
    }
    return {
        inner,
        cluster: (raw.cluster as string) ?? '',
        proxy: (raw.proxy as string) ?? '',
    };
}

function labelsOf(inner: Record<string, unknown>): Record<string, string> {
    const metadata = (inner.metadata as Record<string, unknown>) ?? {};
    return (metadata.labels as Record<string, string>) ?? {};
}

function nameOf(inner: Record<string, unknown>): string {
    const metadata = (inner.metadata as Record<string, unknown>) ?? {};
    return (metadata.name as string) ?? '';
}

function descriptionOf(inner: Record<string, unknown>): string {
    const metadata = (inner.metadata as Record<string, unknown>) ?? {};
    return (metadata.description as string) ?? '';
}

async function listResources(subcommand: string[], wrapperKeys: string[], proxy?: string): Promise<Record<string, unknown>[]> {
    const args = [...subcommand, '-f', 'json', '--all'];
    if (proxy) {
        args.push(`--proxy=${proxy}`);
    }
    const output = await runTsh(args, { timeout: 15000 });
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) {
        return [];
    }
    return parsed.map((raw: Record<string, unknown>) => {
        const { inner, cluster, proxy: itemProxy } = unwrapResource(raw, wrapperKeys);
        return { ...inner, cluster, proxy: itemProxy };
    });
}

export async function listApps(proxy?: string): Promise<AppResource[]> {
    const items = await listResources(['apps', 'ls'], ['app'], proxy);
    return items.map(item => {
        const spec = (item.spec as Record<string, unknown>) ?? {};
        return {
            name: nameOf(item),
            cluster: item.cluster as string,
            proxy: item.proxy as string,
            subKind: (item.sub_kind as string) ?? '',
            publicAddr: (spec.public_addr as string) ?? '',
            uri: (spec.uri as string) ?? '',
            description: descriptionOf(item),
            labels: labelsOf(item),
        };
    });
}

export async function listDatabases(proxy?: string): Promise<DbResource[]> {
    const items = await listResources(['db', 'ls'], ['database', 'db'], proxy);
    return items.map(item => {
        const spec = (item.spec as Record<string, unknown>) ?? {};
        return {
            name: nameOf(item),
            cluster: item.cluster as string,
            proxy: item.proxy as string,
            protocol: (spec.protocol as string) ?? '',
            description: descriptionOf(item),
            labels: labelsOf(item),
        };
    });
}

export async function listKubeClusters(proxy?: string): Promise<KubeResource[]> {
    const items = await listResources(['kube', 'ls'], ['kubernetes_cluster', 'kube_cluster'], proxy);
    return items.map(item => ({
        name: nameOf(item),
        cluster: item.cluster as string,
        proxy: item.proxy as string,
        labels: labelsOf(item),
    }));
}

export async function listNodes(proxy?: string): Promise<NodeResource[]> {
    const items = await listResources(['ls'], ['node'], proxy);
    return items.map(item => {
        const spec = (item.spec as Record<string, unknown>) ?? {};
        return {
            name: nameOf(item),
            hostname: (spec.hostname as string) ?? '',
            cluster: item.cluster as string,
            proxy: item.proxy as string,
            addr: (spec.addr as string) ?? '',
            labels: labelsOf(item),
        };
    });
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
