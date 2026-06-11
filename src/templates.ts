import * as vscode from 'vscode';

export interface BeamTemplate {
    label: string;
    description: string;
    commands: string[];
    custom?: boolean;
}

export const builtinTemplates: BeamTemplate[] = [
    {
        label: 'Python',
        description: 'Python 3 with venv and pip',
        commands: [
            'python3 -m venv /home/beams/project/.venv',
            'mkdir -p /home/beams/project',
            '/home/beams/project/.venv/bin/pip install --upgrade pip',
        ],
    },
    {
        label: 'Node.js',
        description: 'Node.js project with npm init',
        commands: [
            'mkdir -p /home/beams/project',
            'cd /home/beams/project && npm init -y',
        ],
    },
    {
        label: 'TypeScript',
        description: 'TypeScript project with tsconfig',
        commands: [
            'mkdir -p /home/beams/project',
            'cd /home/beams/project && npm init -y && npm install typescript @types/node --save-dev && npx tsc --init',
        ],
    },
    {
        label: 'Go',
        description: 'Go module project',
        commands: [
            'mkdir -p /home/beams/project',
            'cd /home/beams/project && go mod init project',
        ],
    },
    {
        label: 'React',
        description: 'Vite + React + TypeScript',
        commands: [
            'npm create vite@latest /home/beams/project -- --template react-ts',
            'cd /home/beams/project && npm install',
        ],
    },
    {
        label: 'FastAPI',
        description: 'Python FastAPI with uvicorn',
        commands: [
            'mkdir -p /home/beams/project',
            'python3 -m venv /home/beams/project/.venv',
            '/home/beams/project/.venv/bin/pip install fastapi uvicorn',
        ],
    },
    {
        label: 'Empty',
        description: 'Just a blank project directory',
        commands: [
            'mkdir -p /home/beams/project',
        ],
    },
];

const CUSTOM_TEMPLATES_KEY = 'beams.customTemplates';

export function getCustomTemplates(context: vscode.ExtensionContext): BeamTemplate[] {
    return context.globalState.get<BeamTemplate[]>(CUSTOM_TEMPLATES_KEY) ?? [];
}

export function getAllTemplates(context: vscode.ExtensionContext): BeamTemplate[] {
    const custom = getCustomTemplates(context);
    return [...custom, ...builtinTemplates];
}

export async function saveCustomTemplate(
    context: vscode.ExtensionContext,
    template: BeamTemplate
): Promise<void> {
    const custom = getCustomTemplates(context);
    custom.push({ ...template, custom: true });
    await context.globalState.update(CUSTOM_TEMPLATES_KEY, custom);
}

export async function deleteCustomTemplate(
    context: vscode.ExtensionContext,
    label: string
): Promise<void> {
    const custom = getCustomTemplates(context);
    const filtered = custom.filter(t => t.label !== label);
    await context.globalState.update(CUSTOM_TEMPLATES_KEY, filtered);
}
