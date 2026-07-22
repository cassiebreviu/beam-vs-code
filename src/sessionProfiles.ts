import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execOnBeam } from './tsh';

export interface SessionProfile {
    taskId: string;
    label: string;
    beamId: string;
    repoRoot: string;
    gitBranch: string;
    gitCommitSha: string;
    remoteUrl?: string;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
}

function getProfilesRoot(): string {
    return path.join(os.homedir(), '.teleport', 'beams', 'session-profiles');
}

function getProfileDir(taskId: string): string {
    return path.join(getProfilesRoot(), taskId);
}

export function listSessionProfiles(): SessionProfile[] {
    const root = getProfilesRoot();
    if (!fs.existsSync(root)) {
        return [];
    }
    const profiles: SessionProfile[] = [];
    for (const taskId of fs.readdirSync(root)) {
        const file = path.join(root, taskId, 'profile.json');
        if (!fs.existsSync(file)) continue;
        try {
            profiles.push(JSON.parse(fs.readFileSync(file, 'utf-8')));
        } catch { /* skip corrupt profile */ }
    }
    profiles.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return profiles;
}

export function getSessionProfile(taskId: string): SessionProfile | undefined {
    const file = path.join(getProfileDir(taskId), 'profile.json');
    if (!fs.existsSync(file)) {
        return undefined;
    }
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return undefined;
    }
}

export function getSessionSummaryPath(taskId: string): string {
    return path.join(getProfileDir(taskId), 'summary.md');
}

export function getSessionSummary(taskId: string): string {
    const file = getSessionSummaryPath(taskId);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
}

// Prototype storage only: local disk, standing in for the RFD's S3-backed profile
// store. Also skips the RFD's scan-before-write/scan-before-load step — treat any
// summary as trusted input for now until that check exists.
export function saveSessionProfile(profile: SessionProfile, summaryMd: string): void {
    const dir = getProfileDir(profile.taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(profile, null, 2), 'utf-8');
    fs.writeFileSync(path.join(dir, 'summary.md'), summaryMd, 'utf-8');
}

export function deleteSessionProfile(taskId: string): void {
    const dir = getProfileDir(taskId);
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
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

export async function captureGitRef(beamId: string, repoRoot: string): Promise<{ branch: string; sha: string }> {
    const output = await execOnBeam(beamId, [
        `cd "${repoRoot}" && git rev-parse --abbrev-ref HEAD && echo "---SEP---" && git rev-parse HEAD`,
    ], 10000);
    const sepIdx = output.indexOf('---SEP---');
    if (sepIdx === -1) {
        throw new Error('Failed to read git ref from beam');
    }
    const branch = output.slice(0, sepIdx).trim();
    const sha = output.slice(sepIdx + '---SEP---'.length).trim();
    return { branch, sha };
}

export async function applyGitRef(beamId: string, repoRoot: string, branch: string, sha: string): Promise<void> {
    await execOnBeam(beamId, [
        `cd "${repoRoot}" && git fetch origin "${branch}" 2>/dev/null; ` +
        `(git checkout "${branch}" 2>/dev/null || git checkout -b "${branch}" "origin/${branch}") && git reset --hard "${sha}"`,
    ], 30000);
}

export async function captureRemoteUrl(beamId: string, repoRoot: string): Promise<string | undefined> {
    try {
        const output = await execOnBeam(beamId, [`cd "${repoRoot}" && git config --get remote.origin.url`], 10000);
        const url = output.trim();
        return url || undefined;
    } catch {
        return undefined;
    }
}

export async function cloneRepoOnBeam(beamId: string, remoteUrl: string, targetDir: string): Promise<void> {
    await execOnBeam(beamId, [`git clone "${remoteUrl}" "${targetDir}"`], 180000);
}

function shellSingleQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

// RFD: "Beams summarizes the session into the profile format." The beam already runs
// `claude` for the agentic session itself, so ask that same CLI (in headless -p mode,
// resuming its most recent conversation in this repo) to draft the summary. Read-only
// by design (--permission-mode plan) — this never edits files on the beam.
export async function generateSessionSummary(beamId: string, repoRoot: string, label: string): Promise<string | undefined> {
    const prompt = [
        `Write a concise session summary for a task-resumption profile called "${label}".`,
        'Use exactly this markdown structure with no extra preamble or closing remarks:',
        '',
        '## What was tried',
        '',
        '## Decisions made',
        '',
        "## What's left",
        '',
        'Fill in terse bullet points under each heading based on this coding session. ' +
        'If a section has nothing to report, leave it with a single bullet saying so.',
    ].join('\n');

    const cmd = `cd "${repoRoot}" && claude --continue -p --permission-mode plan ${shellSingleQuote(prompt)}`;
    try {
        const output = await execOnBeam(beamId, [cmd], 120000);
        const text = output.trim();
        return text || undefined;
    } catch {
        return undefined;
    }
}

// Lightweight, non-AI fallback seed for the editable summary template when Claude-based
// generation above fails — real git signal so the scratch buffer never starts fully blank.
export async function captureRecentActivity(beamId: string, repoRoot: string): Promise<string> {
    let log = '';
    let status = '';
    try {
        log = await execOnBeam(beamId, [`cd "${repoRoot}" && git log --oneline -15 2>/dev/null`], 10000);
    } catch { /* ignore */ }
    try {
        status = await execOnBeam(beamId, [`cd "${repoRoot}" && git status --porcelain=v1 2>/dev/null`], 10000);
    } catch { /* ignore */ }

    const sections: string[] = [];
    if (log.trim()) {
        sections.push('Recent commits:', '```', log.trim(), '```');
    }
    if (status.trim()) {
        sections.push('Uncommitted changes at save time:', '```', status.trim(), '```');
    }
    return sections.join('\n\n');
}

export async function writeSessionSummaryToBeam(
    beamId: string,
    repoRoot: string,
    taskId: string,
    summaryMd: string,
): Promise<string> {
    const remotePath = `${repoRoot}/.claude/session-memory/${taskId}.md`;
    const remoteDir = remotePath.slice(0, remotePath.lastIndexOf('/'));
    const encoded = Buffer.from(summaryMd, 'utf-8').toString('base64');
    await execOnBeam(beamId, [`mkdir -p "${remoteDir}" && echo "${encoded}" | base64 -d > "${remotePath}"`]);
    return remotePath;
}
