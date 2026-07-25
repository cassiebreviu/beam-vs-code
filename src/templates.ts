import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface TemplateGithub {
    username?: string;
    email?: string;
    authMethod?: 'pat' | 'oauth' | 'tsh-git';
    cloneRepo?: string;
}

export interface TemplateEnvSnapshot {
    gitConfig?: Array<{ key: string; value: string }>;
    envVars?: string[];
    binScriptsTar?: string;
    systemdUnits?: Array<{ name: string; content: string }>;
}

export interface BeamTemplate {
    label: string;
    description: string;
    commands: string[];
    custom?: boolean;
    github?: TemplateGithub;
    envSnapshot?: TemplateEnvSnapshot;
    autoPublish?: boolean;
}

export const builtinTemplates: BeamTemplate[] = [
    {
        label: 'Default',
        description: 'Empty beam',
        commands: [],
    },
];

function getTemplatesPath(): string {
    return path.join(os.homedir(), '.teleport', 'beams', 'templates.json');
}

export function getCustomTemplates(): BeamTemplate[] {
    const filePath = getTemplatesPath();
    if (!fs.existsSync(filePath)) {
        return [];
    }
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const templates = JSON.parse(content);
        if (!Array.isArray(templates)) return [];
        return templates.map((t: BeamTemplate) => ({ ...t, custom: true }));
    } catch {
        return [];
    }
}

export function getAllTemplates(): BeamTemplate[] {
    const custom = getCustomTemplates();
    return [...custom, ...builtinTemplates];
}

export async function saveCustomTemplate(template: BeamTemplate): Promise<void> {
    const filePath = getTemplatesPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const custom = getCustomTemplates().map(({ label, description, commands, github, envSnapshot, autoPublish }) => {
        const t: Record<string, unknown> = { label, description, commands };
        if (github) t.github = github;
        if (envSnapshot) t.envSnapshot = envSnapshot;
        if (autoPublish) t.autoPublish = autoPublish;
        return t;
    });
    const entry: Record<string, unknown> = {
        label: template.label,
        description: template.description,
        commands: template.commands,
    };
    if (template.github) entry.github = template.github;
    if (template.envSnapshot) entry.envSnapshot = template.envSnapshot;
    if (template.autoPublish) entry.autoPublish = template.autoPublish;
    custom.push(entry);
    fs.writeFileSync(filePath, JSON.stringify(custom, null, 2), 'utf-8');
}

export async function deleteCustomTemplate(label: string): Promise<void> {
    const filePath = getTemplatesPath();
    const custom = getCustomTemplates()
        .filter(t => t.label !== label)
        .map(({ label, description, commands, github, envSnapshot, autoPublish }) => {
            const t: Record<string, unknown> = { label, description, commands };
            if (github) t.github = github;
            if (envSnapshot) t.envSnapshot = envSnapshot;
            if (autoPublish) t.autoPublish = autoPublish;
            return t;
        });
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(custom, null, 2), 'utf-8');
}
