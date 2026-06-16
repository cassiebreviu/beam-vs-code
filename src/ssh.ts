import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

function writeSshConfig(content: string): void {
    const configPath = getSshConfigPath();
    const sshDir = path.dirname(configPath);
    if (!fs.existsSync(sshDir)) {
        fs.mkdirSync(sshDir, { mode: 0o700, recursive: true });
    }
    fs.writeFileSync(configPath, content, { mode: 0o600 });
}

function buildBeamsBlock(cluster: string, beamId: string): string {
    const tshPath = getTshPath();
    const wildcardHost = `*.${cluster}`;
    const beamHost = `vscode+${beamId}.${cluster}`;

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

export function ensureBeamSshConfig(beamId: string, cluster: string): string {
    const host = `vscode+${beamId}.${cluster}`;
    let config = readSshConfig();

    const beamHostEntry = `Host ${host}`;
    if (config.includes(beamHostEntry)) {
        return host;
    }

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
