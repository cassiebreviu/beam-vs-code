import * as vscode from 'vscode';
import { Beam } from './tsh';

export class BeamItem extends vscode.TreeItem {
    constructor(public readonly beam: Beam) {
        super(beam.id, vscode.TreeItemCollapsibleState.None);

        const expires = new Date(beam.expires);
        const remaining = Math.max(0, Math.floor((expires.getTime() - Date.now()) / 60000));
        const timeStr = remaining > 60
            ? `${Math.floor(remaining / 60)}h ${remaining % 60}m`
            : `${remaining}m`;

        this.description = `expires in ${timeStr}`;
        this.tooltip = `UUID: ${beam.uuid}\nOwner: ${beam.owner}\nExpires: ${beam.expires}${beam.url ? `\nURL: ${beam.url}` : ''}`;
        this.contextValue = beam.url ? 'beamPublished' : 'beam';
        this.iconPath = new vscode.ThemeIcon(beam.url ? 'globe' : 'vm');

        this.command = {
            command: 'beams.connect',
            title: 'Connect to Beam',
            arguments: [this],
        };
    }
}
