import * as vscode from 'vscode';
import { Beam, execOnBeam } from './tsh';

interface AgentEvent {
    timestamp: string;
    type: string;
    summary: string;
    detail?: string;
    icon: string;
}

class EventItem extends vscode.TreeItem {
    constructor(public readonly event: AgentEvent) {
        super(event.summary, vscode.TreeItemCollapsibleState.None);
        this.description = event.timestamp;
        this.iconPath = new vscode.ThemeIcon(event.icon);
        this.tooltip = event.detail ?? event.summary;
        if (event.detail) {
            this.command = {
                command: 'beams.showActivityDetail',
                title: 'Show Detail',
                arguments: [{ label: event.summary, detail: event.detail }],
            };
        }
    }
}

export class AgentEventsProvider implements vscode.TreeDataProvider<EventItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<EventItem | undefined | null>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private currentBeam: Beam | undefined;
    private events: AgentEvent[] = [];
    private pollInterval: NodeJS.Timeout | undefined;
    private transcriptPath: string | undefined;
    private lastLineCount = 0;

    setBeam(beam: Beam): void {
        this.currentBeam = beam;
        this.events = [];
        this.transcriptPath = undefined;
        this.lastLineCount = 0;
        this.startPolling();
        this._onDidChangeTreeData.fire(undefined);
    }

    stop(): void {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = undefined;
        }
    }

    private startPolling(): void {
        this.stop();
        this.poll();
        this.pollInterval = setInterval(() => this.poll(), 3000);
    }

    private async poll(): Promise<void> {
        if (!this.currentBeam) return;

        try {
            if (!this.transcriptPath) {
                this.transcriptPath = await this.findTranscript();
                if (!this.transcriptPath) return;
            }

            const output = await execOnBeam(this.currentBeam.id, [
                'tail', '-n', '100', this.transcriptPath
            ]);

            if (!output.trim()) return;

            const lines = output.split('\n').filter(l => l.trim());
            if (lines.length === this.lastLineCount) return;

            this.lastLineCount = lines.length;
            this.events = this.parseEvents(lines);
            this._onDidChangeTreeData.fire(undefined);
        } catch {
            this.transcriptPath = undefined;
        }
    }

    private async findTranscript(): Promise<string | undefined> {
        if (!this.currentBeam) return undefined;
        try {
            const output = await execOnBeam(this.currentBeam.id, [
                'ls', '-t', '/home/beams/.claude/projects/-home-beams/'
            ]);
            const files = output.trim().split('\n').filter(f => f.endsWith('.jsonl'));
            if (files.length === 0) return undefined;
            return `/home/beams/.claude/projects/-home-beams/${files[0]}`;
        } catch {
            return undefined;
        }
    }

    private parseEvents(lines: string[]): AgentEvent[] {
        const events: AgentEvent[] = [];

        for (const line of lines) {
            try {
                const parsed = JSON.parse(line);
                const event = this.toEvent(parsed);
                if (event) events.push(event);
            } catch {
                continue;
            }
        }

        return events.slice(-50);
    }

    private toEvent(parsed: Record<string, unknown>): AgentEvent | null {
        const ts = parsed.timestamp
            ? new Date(parsed.timestamp as string).toLocaleTimeString()
            : '';

        const msg = parsed.message as Record<string, unknown> | undefined;
        if (!msg) return null;

        const role = msg.role as string | undefined;
        const content = msg.content;

        if (role === 'user') {
            const text = extractText(content);
            if (!text) return null;
            return {
                timestamp: ts,
                type: 'user',
                summary: truncate(text, 80),
                detail: text,
                icon: 'account',
            };
        }

        if (role === 'assistant') {
            if (!Array.isArray(content)) return null;

            for (const block of content) {
                const b = block as Record<string, unknown>;
                if (b.type === 'tool_use') {
                    const name = (b.name as string) ?? 'tool';
                    const args = summarizeToolArgs(b.input);
                    return {
                        timestamp: ts,
                        type: 'tool_use',
                        summary: `${name}${args ? ': ' + args : ''}`,
                        detail: JSON.stringify(b.input, null, 2),
                        icon: 'wrench',
                    };
                }
                if (b.type === 'text') {
                    const text = (b.text as string) ?? '';
                    if (!text.trim()) continue;
                    return {
                        timestamp: ts,
                        type: 'assistant',
                        summary: truncate(text, 80),
                        detail: text,
                        icon: 'hubot',
                    };
                }
            }
            return null;
        }

        if (parsed.type === 'tool_result' || (msg as Record<string, unknown>).type === 'tool_result') {
            return {
                timestamp: ts,
                type: 'tool_result',
                summary: 'Tool result received',
                icon: 'check',
            };
        }

        return null;
    }

    getTreeItem(element: EventItem): vscode.TreeItem {
        return element;
    }

    getChildren(): EventItem[] {
        if (!this.currentBeam) {
            return [new EventItem({ timestamp: '', type: 'info', summary: 'Select a beam to view events', icon: 'info' })];
        }

        if (this.events.length === 0) {
            return [new EventItem({ timestamp: '', type: 'info', summary: 'Waiting for events...', icon: 'loading~spin' })];
        }

        return this.events.slice().reverse().map(e => new EventItem(e));
    }
}

function extractText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter((b: Record<string, unknown>) => b.type === 'text')
            .map((b: Record<string, unknown>) => b.text ?? '')
            .join('\n');
    }
    return '';
}

function truncate(s: string, max: number): string {
    const line = s.split('\n')[0] ?? s;
    return line.length > max ? line.slice(0, max) + '...' : line;
}

function summarizeToolArgs(input: unknown): string {
    if (!input || typeof input !== 'object') return '';
    const obj = input as Record<string, unknown>;
    if (obj.file_path) return String(obj.file_path).split('/').pop() ?? '';
    if (obj.path) return String(obj.path).split('/').pop() ?? '';
    if (obj.command) {
        const cmd = String(obj.command);
        return cmd.length > 60 ? cmd.slice(0, 60) + '...' : cmd;
    }
    if (obj.query) {
        const q = String(obj.query);
        return q.length > 60 ? q.slice(0, 60) + '...' : q;
    }
    return '';
}
