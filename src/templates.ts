import * as vscode from 'vscode';

export interface BeamTemplate {
    label: string;
    description: string;
    commands: string[];
    custom?: boolean;
}

export const builtinTemplates: BeamTemplate[] = [
    {
        label: 'Default',
        description: 'Empty beam',
        commands: [],
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
