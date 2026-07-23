const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ensureBeamSshConfig } = require('../out/ssh');

test('repairs only the matching legacy Beam SSH blocks', async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-vs-code-'));
    const configPath = path.join(testHome, '.ssh', 'config');
    const backupPath = `${configPath}.teleport-beams.bak`;
    fs.mkdirSync(path.dirname(configPath));
    const originalConfig = [
        'Host unrelated',
        '    HostName api.example.beams.run',
        '',
        '# BEGIN Teleport Beams',
        'Host *.example.beams.run !example.beams.run',
        '    ProxyCommand tsh proxy ssh --proxy=example.beams.run:443 %h',
        '',
        'Host vscode--beam-1.example.beams.sh',
        '    HostName beam-1.example.beams.run',
        '# END Teleport Beams',
        '',
    ].join('\n');
    fs.writeFileSync(configPath, originalConfig);

    try {
        process.env.HOME = testHome;
        process.env.USERPROFILE = testHome;
        const host = await ensureBeamSshConfig('beam-1', 'example.beams.sh');
        const config = fs.readFileSync(configPath, 'utf8');

        assert.equal(host, 'vscode--beam-1.example.beams.sh');
        assert.match(config, /Host \*\.example\.beams\.sh !example\.beams\.sh/);
        assert.match(config, /ProxyCommand .*--proxy=example\.beams\.sh:443/);
        assert.match(config, /HostName beam-1\.example\.beams\.sh/);
        assert.match(config, /HostName api\.example\.beams\.run/);
        assert.equal(fs.readFileSync(backupPath, 'utf8'), originalConfig);
        if (process.platform !== 'win32') {
            assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
            assert.equal(fs.statSync(backupPath).mode & 0o777, 0o600);
        }
        assert.deepEqual(fs.readdirSync(path.dirname(configPath)).sort(), [
            'config',
            'config.teleport-beams.bak',
        ]);
    } finally {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
        if (originalUserProfile === undefined) {
            delete process.env.USERPROFILE;
        } else {
            process.env.USERPROFILE = originalUserProfile;
        }
        fs.rmSync(testHome, { recursive: true, force: true });
    }
});
