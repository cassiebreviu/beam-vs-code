import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

const MARKER_START = '# BEGIN Teleport Beams';
const MARKER_END = '# END Teleport Beams';

function sshCluster(cluster: string): string {
    return cluster.replace(/\.beams\.sh$/, '.beams.run');
}

function getTshPath(): string {
    if (process.platform === 'win32') {
        return 'tsh.exe';
    }
    if (process.platform === 'darwin') {
        const connectPath = '/Applications/Teleport Connect.app/Contents/MacOS/tsh.app/Contents/MacOS/tsh';
        if (fs.existsSync(connectPath)) {
            return connectPath;
        }
    }
    return 'tsh';
}

function getSshConfigPath(): string {
    return path.join(os.homedir(), '.ssh', 'config');
}

function readSshConfig(): string {
    const configPath = getSshConfigPath();
    if (!fs.existsSync(configPath)) {
        return '';
    }
    return fs.readFileSync(configPath, 'utf-8');
}

function writeSshConfig(content: string): void {
    const configPath = getSshConfigPath();
    const sshDir = path.dirname(configPath);
    if (!fs.existsSync(sshDir)) {
        fs.mkdirSync(sshDir, { mode: 0o700, recursive: true });
    }
    fs.writeFileSync(configPath, content, { mode: 0o600 });
}

async function getTshConfig(): Promise<string | null> {
    try {
        const tshPath = getTshPath();
        const { stdout } = await exec(tshPath, ['config'], { timeout: 10000 });
        return stdout;
    } catch {
        return null;
    }
}

function patchTshConfigForBeams(tshConfig: string, cluster: string): string {
    const shVariant = cluster.replace(/\.beams\.run$/, '.beams.sh');
    const lines = tshConfig.split('\n');
    const result: string[] = [];
    let inClusterBlock = false;

    for (const line of lines) {
        if (line.startsWith('Host ') && (line.includes(cluster) || line.includes(shVariant))) {
            inClusterBlock = true;
            // Rewrite the Host line to use the .beams.run domain
            result.push(line.replace(shVariant, cluster));
            continue;
        } else if (line.startsWith('Host ') && inClusterBlock) {
            inClusterBlock = false;
        }

        if (inClusterBlock) {
            if (line.trim().startsWith('Port ')) {
                continue;
            }
            if (line.trim().startsWith('ProxyCommand ')) {
                const tshPath = getTshPath();
                result.push(`    StrictHostKeyChecking no`);
                result.push(`    ProxyCommand sh -c '"${tshPath}" proxy ssh --cluster=${cluster} --proxy=${cluster}:443 %r@teleport.internal/beams/alias=$(echo %h | cut -d. -f1)'`);
                continue;
            }
        }

        result.push(line);
    }

    return result.join('\n');
}

function buildBeamsBlock(cluster: string, beamId: string): string {
    const tshPath = getTshPath();
    const wildcardHost = `*.${cluster}`;
    const beamHost = `vscode+${beamId}.${cluster}`;

    return [
        MARKER_START,
        `Host ${beamHost}`,
        `    HostName ${beamId}.${cluster}`,
        '    User beams',
        '    StrictHostKeyChecking no',
        '    UserKnownHostsFile /dev/null',
        `    ProxyCommand sh -c '"${tshPath}" proxy ssh --cluster=${cluster} --proxy=${cluster}:443 %r@teleport.internal/beams/alias=$(echo %h | cut -d. -f1)'`,
        '',
        `Host ${wildcardHost} !${cluster}`,
        '    StrictHostKeyChecking no',
        '    UserKnownHostsFile /dev/null',
        `    ProxyCommand sh -c '"${tshPath}" proxy ssh --cluster=${cluster} --proxy=${cluster}:443 %r@teleport.internal/beams/alias=$(echo %h | cut -d. -f1)'`,
        MARKER_END,
    ].join('\n');
}

export async function ensureBeamSshConfig(beamId: string, rawCluster: string): Promise<string> {
    const cluster = sshCluster(rawCluster);
    const host = `vscode+${beamId}.${cluster}`;
    let config = readSshConfig();

    const beamHostEntry = `Host ${host}`;
    if (config.includes(beamHostEntry)) {
        return host;
    }

    // Migrate stale .beams.sh entry to .beams.run if present
    if (rawCluster !== cluster) {
        const staleHost = `vscode+${beamId}.${rawCluster}`;
        if (config.includes(`Host ${staleHost}`)) {
            config = config.replace(
                new RegExp(`Host ${staleHost.replace(/\./g, '\\.')}`, 'g'),
                `Host ${host}`
            );
            config = config.replace(
                new RegExp(`HostName ${beamId}\\.${rawCluster.replace(/\./g, '\\.')}`, 'g'),
                `HostName ${beamId}.${cluster}`
            );
            writeSshConfig(config);
            return host;
        }
    }

    // If there's an existing tsh-generated block for this cluster, patch its ProxyCommand
    // Also check for the .beams.sh variant since tsh config may have generated that
    const rawClusterPattern = rawCluster !== cluster ? `*.${rawCluster}` : null;
    if ((config.includes(`*.${cluster}`) || (rawClusterPattern && config.includes(rawClusterPattern))) && !config.includes(MARKER_START)) {
        config = patchTshConfigForBeams(config, cluster);
        const tshPath = getTshPath();
        const beamEntry = [
            '',
            MARKER_START,
            `Host ${host}`,
            `    HostName ${beamId}.${cluster}`,
            '    User beams',
            '    StrictHostKeyChecking no',
            '    UserKnownHostsFile /dev/null',
            `    ProxyCommand sh -c '"${tshPath}" proxy ssh --cluster=${cluster} --proxy=${cluster}:443 %r@teleport.internal/beams/alias=$(echo %h | cut -d. -f1)'`,
            MARKER_END,
        ].join('\n');
        // Insert beam entry BEFORE the wildcard so it matches first
        let wildcardIdx = config.indexOf(`Host *.${cluster}`);
        if (wildcardIdx === -1 && rawClusterPattern) {
            wildcardIdx = config.indexOf(`Host ${rawClusterPattern}`);
        }
        if (wildcardIdx > 0) {
            config = config.slice(0, wildcardIdx) + beamEntry + '\n\n' + config.slice(wildcardIdx);
        } else {
            config += '\n' + beamEntry + '\n';
        }
        writeSshConfig(config);
        return host;
    }

    // No existing tsh config — try to generate it
    const tshPath = getTshPath();
    if (!config.includes(MARKER_START)) {
        const tshConfig = await getTshConfig();
        if (tshConfig) {
            const patched = patchTshConfigForBeams(tshConfig, cluster);
            const block = [
                MARKER_START,
                `Host ${host}`,
                `    HostName ${beamId}.${cluster}`,
                '    User beams',
                '    StrictHostKeyChecking no',
                '    UserKnownHostsFile /dev/null',
                `    ProxyCommand sh -c '"${tshPath}" proxy ssh --cluster=${cluster} --proxy=${cluster}:443 %r@teleport.internal/beams/alias=$(echo %h | cut -d. -f1)'`,
                '',
                patched,
                MARKER_END,
            ].join('\n');
            if (config.length > 0 && !config.endsWith('\n')) {
                config += '\n';
            }
            config += '\n' + block + '\n';
            writeSshConfig(config);
            return host;
        }
    }

    // Fallback: add entry to existing beams block
    const markerIdx = config.indexOf(MARKER_START);
    if (markerIdx !== -1) {
        const endIdx = config.indexOf(MARKER_END);
        if (endIdx !== -1) {
            const before = config.slice(0, endIdx);
            const after = config.slice(endIdx);
            const newEntry = [
                '',
                `Host ${host}`,
                `    HostName ${beamId}.${cluster}`,
                '    User beams',
                '    StrictHostKeyChecking no',
                '    UserKnownHostsFile /dev/null',
                `    ProxyCommand sh -c '"${tshPath}" proxy ssh --cluster=${cluster} --proxy=${cluster}:443 %r@teleport.internal/beams/alias=$(echo %h | cut -d. -f1)'`,
            ].join('\n');
            config = before + newEntry + '\n' + after;
            writeSshConfig(config);
            return host;
        }
    }

    const block = buildBeamsBlock(cluster, beamId);
    if (config.length > 0 && !config.endsWith('\n')) {
        config += '\n';
    }
    config += '\n' + block + '\n';
    writeSshConfig(config);
    return host;
}
