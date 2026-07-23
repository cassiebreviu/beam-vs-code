import * as vscode from 'vscode';
import { Beam } from './tsh';

export function openBeamTerminal(beam: Beam): vscode.Terminal {
    const tshPath = process.platform === 'win32' ? 'tsh.exe' : 'tsh';
    const terminal = vscode.window.createTerminal({
        name: `Beam: ${beam.id}`,
        shellPath: tshPath,
        shellArgs: ['beams', 'ssh', beam.id],
        iconPath: new vscode.ThemeIcon('terminal'),
    });
    terminal.show();
    return terminal;
}
