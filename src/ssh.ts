import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

const MARKER_START = '# BEGIN Teleport Beams';
const MARKER_END = '# END Teleport Beams';

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

/** Backs up the current config, then atomically replaces it via a sibling file. */
function writeSshConfig(content: string): void {
    const configPath = getSshConfigPath();
    const sshDir = path.dirname(configPath);
    if (!fs.existsSync(sshDir)) {
        fs.mkdirSync(sshDir, { mode: 0o700, recursive: true });
    }

    const backupPath = `${configPath}.teleport-beams.bak`;
    const tempPath = `${configPath}.teleport-beams.${process.pid}.tmp`;
    if (fs.existsSync(configPath)) {
        fs.copyFileSync(configPath, backupPath);
        fs.chmodSync(backupPath, 0o600);
    }

    try {
        fs.writeFileSync(tempPath, content, { mode: 0o600 });
        fs.renameSync(tempPath, configPath);
    } finally {
        if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }
    }
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

/**
 * Adapts the matching cluster block from `tsh config` for Beam aliases.
 *
 * Beam SSH connections route through Teleport's internal `beams/alias`
 * principal, so the stock ProxyCommand is replaced and its fixed Port is
 * removed. Other cluster blocks are preserved verbatim.
 */
function patchTshConfigForBeams(tshConfig: string, cluster: string): string {
    const lines = tshConfig.split('\n');
    const result: string[] = [];
    let inClusterBlock = false;

    for (const line of lines) {
        if (line.startsWith('Host ') && line.includes(cluster)) {
            inClusterBlock = true;
            result.push(line);
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

function hasHost(config: string, host: string): boolean {
    return config.split('\n').some(line => {
        const match = line.match(/^\s*Host\s+(.+)$/i);
        return match?.[1].trim().split(/\s+/).includes(host) ?? false;
    });
}

/**
 * Migrates aliases created by older extension versions from `vscode+` and
 * `.beams.run` to the current host name.
 *
 * Rewrites are limited to exact Beam/cluster Host patterns and directives in
 * those blocks so unrelated `.beams.run` values in the user's config survive.
 */
function migrateLegacyConfig(config: string, cluster: string, beamId: string, host: string): string {
    const legacyCluster = cluster.replace(/\.beams\.sh$/, '.beams.run');
    const legacyHosts = new Set([
        `vscode+${beamId}.${cluster}`,
        `vscode+${beamId}.${legacyCluster}`,
        `vscode--${beamId}.${legacyCluster}`,
    ]);
    const relevantHosts = new Set([
        host,
        ...legacyHosts,
        cluster,
        legacyCluster,
        `!${cluster}`,
        `!${legacyCluster}`,
        `*.${cluster}`,
        `*.${legacyCluster}`,
    ]);
    let inRelevantBlock = false;

    return config.split('\n').map(line => {
        const hostMatch = line.match(/^(\s*Host\s+)(.+)$/i);
        if (hostMatch) {
            const patterns = hostMatch[2].trim().split(/\s+/);
            inRelevantBlock = patterns.some(pattern => relevantHosts.has(pattern));
            const migrated = patterns.map(pattern => {
                if (legacyHosts.has(pattern)) {
                    return host;
                }
                if (legacyCluster !== cluster && pattern.endsWith(legacyCluster)) {
                    const prefix = pattern.slice(0, -legacyCluster.length);
                    if (prefix === '' || prefix === '!' || prefix === '*.') {
                        return `${prefix}${cluster}`;
                    }
                }
                return pattern;
            });
            return hostMatch[1] + migrated.join(' ');
        }

        if (inRelevantBlock && legacyCluster !== cluster && /^\s*(?:HostName|ProxyCommand)\s+/i.test(line)) {
            return line.split(legacyCluster).join(cluster);
        }
        return line;
    }).join('\n');
}

function buildBeamsBlock(cluster: string, beamId: string): string {
    const tshPath = getTshPath();
    const wildcardHost = `*.${cluster}`;
    const beamHost = `vscode--${beamId}.${cluster}`;

    return [
        MARKER_START,
        `Host ${wildcardHost} !${cluster}`,
        '    StrictHostKeyChecking no',
        '    UserKnownHostsFile /dev/null',
        `    ProxyCommand sh -c '"${tshPath}" proxy ssh --cluster=${cluster} --proxy=${cluster}:443 %r@teleport.internal/beams/alias=$(echo %h | cut -d. -f1)'`,
        '',
        `Host ${beamHost}`,
        `    HostName ${beamId}.${cluster}`,
        '    User beams',
        '    UserKnownHostsFile /dev/null',
        '    RemoteCommand bash',
        MARKER_END,
    ].join('\n');
}

/**
 * Ensures `~/.ssh/config` contains a VS Code-safe alias for a Beam and returns
 * that alias. Specific Beam entries are placed before Teleport wildcards
 * because OpenSSH uses the first value it finds for each setting.
 *
 * Existing extension entries are migrated in place; otherwise the function
 * reuses `tsh config` when available and falls back to a standalone block.
 */
export async function ensureBeamSshConfig(beamId: string, rawCluster: string): Promise<string> {
    const cluster = rawCluster;
    const host = `vscode--${beamId}.${cluster}`;
    let config = readSshConfig();

    const migratedConfig = migrateLegacyConfig(config, cluster, beamId, host);
    const migrated = migratedConfig !== config;
    config = migratedConfig;
    if (hasHost(config, host)) {
        if (migrated) {
            writeSshConfig(config);
        }
        return host;
    }

    // If there's an existing tsh-generated block for this cluster, patch its ProxyCommand
    if (config.includes(`*.${cluster}`) && !config.includes(MARKER_START)) {
        config = patchTshConfigForBeams(config, cluster);
        const beamEntry = [
            '',
            MARKER_START,
            `Host ${host}`,
            `    HostName ${beamId}.${cluster}`,
            '    User beams',
            '    UserKnownHostsFile /dev/null',
            '    RemoteCommand bash',
            MARKER_END,
        ].join('\n');
        // Insert beam entry BEFORE the wildcard so it matches first
        const wildcardIdx = config.indexOf(`Host *.${cluster}`);
        if (wildcardIdx > 0) {
            config = config.slice(0, wildcardIdx) + beamEntry + '\n\n' + config.slice(wildcardIdx);
        } else {
            config += '\n' + beamEntry + '\n';
        }
        writeSshConfig(config);
        return host;
    }

    // No existing tsh config — try to generate it
    if (!config.includes(MARKER_START)) {
        const tshConfig = await getTshConfig();
        if (tshConfig) {
            const patched = patchTshConfigForBeams(tshConfig, cluster);
            const block = [
                MARKER_START,
                `Host ${host}`,
                `    HostName ${beamId}.${cluster}`,
                '    User beams',
                '    UserKnownHostsFile /dev/null',
                '    RemoteCommand bash',
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

    // Fallback: write standalone block (no tsh config available)
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
                '    UserKnownHostsFile /dev/null',
                '    RemoteCommand bash',
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
