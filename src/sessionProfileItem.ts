import * as vscode from 'vscode';
import { SessionProfile } from './sessionProfiles';

export class SessionProfileItem extends vscode.TreeItem {
    constructor(public readonly profile: SessionProfile) {
        super(profile.label, vscode.TreeItemCollapsibleState.None);

        const shortSha = profile.gitCommitSha.slice(0, 7);
        this.description = `${profile.gitBranch}@${shortSha}`;
        this.tooltip = [
            `Task: ${profile.taskId}`,
            `Branch: ${profile.gitBranch}`,
            `Commit: ${profile.gitCommitSha}`,
            `Saved from beam: ${profile.beamId}`,
            `Created by: ${profile.createdBy}`,
            `Created: ${profile.createdAt}`,
            `Updated: ${profile.updatedAt}`,
        ].join('\n');
        this.contextValue = 'sessionProfile';
        this.iconPath = new vscode.ThemeIcon('history');

        this.command = {
            command: 'beams.viewSessionProfile',
            title: 'View Session Profile',
            arguments: [this],
        };
    }
}
