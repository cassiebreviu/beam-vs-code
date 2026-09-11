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

export function getAllTemplates(): BeamTemplate[] {
    return builtinTemplates;
}
