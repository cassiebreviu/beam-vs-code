import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

interface ClusterProfile {
    profileUrl: string;
    username: string;
    cluster: string;
    roles: string[];
    logins: string[];
    validUntil: string;
    active: boolean;
}

class ClusterItem extends vscode.TreeItem {
    constructor(public readonly profile: ClusterProfile) {
        super(profile.cluster, vscode.TreeItemCollapsibleState.Collapsed);

        const remaining = Math.max(0, Math.floor((new Date(profile.validUntil).getTime() - Date.now()) / 60000));
        const timeStr = remaining > 60
            ? `${Math.floor(remaining / 60)}h ${remaining % 60}m`
            : `${remaining}m`;

        this.description = profile.active ? `active • ${timeStr}` : timeStr;
        this.tooltip = [
            `Cluster: ${profile.cluster}`,
            `User: ${profile.username}`,
            `Roles: ${profile.roles.join(', ')}`,
            `Logins: ${profile.logins.join(', ')}`,
            `Valid until: ${profile.validUntil}`,
        ].join('\n');
        this.iconPath = new vscode.ThemeIcon(profile.active ? 'plug' : 'circle-outline');
        this.contextValue = profile.active ? 'clusterActive' : 'cluster';
    }
}

class ClusterDetailItem extends vscode.TreeItem {
    constructor(label: string, value: string, icon?: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = value;
        if (icon) {
            this.iconPath = new vscode.ThemeIcon(icon);
        }
    }
}

type TreeItem = ClusterItem | ClusterDetailItem;

export class ClustersProvider implements vscode.TreeDataProvider<TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | null>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private profiles: ClusterProfile[] = [];
    private pollInterval: NodeJS.Timeout | undefined;

    constructor() {
        this.startPolling();
    }

    refresh(): void {
        this.poll();
    }

    dispose(): void {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = undefined;
        }
    }

    private startPolling(): void {
        this.poll();
        this.pollInterval = setInterval(() => this.poll(), 30000);
    }

    private async poll(): Promise<void> {
        try {
            const { stdout } = await exec('tsh', ['status', '--format=json'], { timeout: 10000 });
            const data = JSON.parse(stdout);
            const profiles: ClusterProfile[] = [];

            if (data.active) {
                profiles.push(this.parseProfile(data.active, true));
            }

            if (Array.isArray(data.profiles)) {
                for (const p of data.profiles) {
                    profiles.push(this.parseProfile(p, false));
                }
            }

            this.profiles = profiles;
            this._onDidChangeTreeData.fire(undefined);
        } catch {
            this.profiles = [];
            this._onDidChangeTreeData.fire(undefined);
        }
    }

    private parseProfile(raw: Record<string, unknown>, active: boolean): ClusterProfile {
        return {
            profileUrl: (raw.profile_url as string) ?? '',
            username: (raw.username as string) ?? '',
            cluster: (raw.cluster as string) ?? '',
            roles: (raw.roles as string[]) ?? [],
            logins: (raw.logins as string[]) ?? [],
            validUntil: (raw.valid_until as string) ?? '',
            active,
        };
    }

    getTreeItem(element: TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TreeItem): TreeItem[] {
        if (!element) {
            if (this.profiles.length === 0) {
                return [new ClusterDetailItem('Not logged in', 'run tsh login', 'warning')];
            }
            return this.profiles.map(p => new ClusterItem(p));
        }

        if (element instanceof ClusterItem) {
            const p = element.profile;
            return [
                new ClusterDetailItem('User', p.username, 'account'),
                new ClusterDetailItem('Roles', p.roles.join(', '), 'shield'),
                new ClusterDetailItem('Logins', p.logins.join(', '), 'terminal'),
                new ClusterDetailItem('Valid until', new Date(p.validUntil).toLocaleString(), 'clock'),
                new ClusterDetailItem('URL', p.profileUrl, 'link'),
            ];
        }

        return [];
    }
}
