import * as vscode from 'vscode';
import { classifyTshError, tshErrorMessage, TshErrorKind } from './tsh';

// A disconnected beam usually fails several operations at once (tree refresh, git poll,
// an open editor) and the tree view re-queries on a timer, so the same condition would
// otherwise stack up duplicate notifications. Collapse repeats of the same beam+kind.
const DEDUPE_WINDOW_MS = 30000;
const lastShown = new Map<string, number>();

function shouldShow(key: string): boolean {
    const now = Date.now();
    const previous = lastShown.get(key);
    if (previous !== undefined && now - previous < DEDUPE_WINDOW_MS) {
        return false;
    }
    lastShown.set(key, now);
    return true;
}

export function resetBeamNotice(beamId: string): void {
    for (const key of [...lastShown.keys()]) {
        if (key.startsWith(`${beamId}:`)) {
            lastShown.delete(key);
        }
    }
}

export interface ReportOptions {
    /** Beam the failed operation targeted, if any. */
    beamId?: string;
    /** Human-readable description of what failed, e.g. "list files". */
    action: string;
    /** Refresh the beams list after reporting a disconnect. */
    refresh?: () => void;
}

/**
 * Surface a tsh failure at the right severity: an expired or stopped beam is reported as
 * information (it is expected — beams are ephemeral), an expired login as a warning with
 * a next step, and anything genuinely unexpected as an error.
 */
export function reportTshError(err: unknown, options: ReportOptions): TshErrorKind {
    const kind = classifyTshError(err);
    const { beamId, action, refresh } = options;
    const label = beamId ? `Beam "${beamId}"` : 'Beam';

    if (kind === 'disconnected') {
        if (shouldShow(`${beamId ?? '-'}:disconnected`)) {
            vscode.window.showInformationMessage(
                `${label} is no longer available — it may have expired or been stopped.`
            );
        }
        refresh?.();
        return kind;
    }

    if (kind === 'auth') {
        if (shouldShow(`${beamId ?? '-'}:auth`)) {
            void vscode.window.showWarningMessage(
                'Your Teleport session has expired. Log in again to continue.',
                'Login'
            ).then(choice => {
                if (choice === 'Login') {
                    void vscode.commands.executeCommand('beams.login');
                }
            });
        }
        return kind;
    }

    vscode.window.showErrorMessage(`Failed to ${action}: ${tshErrorMessage(err)}`);
    return kind;
}
