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
    private lastContent = '';

    setBeam(beam: Beam): void {
        this.currentBeam = beam;
        this.events = [];
        this.transcriptPath = undefined;
        this.lastContent = '';
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

            if (!output.trim()) {
                if (this.events.length > 0) {
                    this.events = [];
                    this._onDidChangeTreeData.fire(undefined);
                }
                return;
            }

            if (output === this.lastContent) return;
            this.lastContent = output;

            const lines = output.split('\n').filter(l => l.trim());
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
                'bash', '-c', 'find /home/beams/.claude/projects -name "*.jsonl" -not -path "*/subagents/*" -printf "%T@ %p\\n" 2>/dev/null | sort -rn | head -1 | cut -d" " -f2-'
            ]);
            const path = output.trim();
            if (!path) return undefined;
            return path;
        } catch {
            return undefined;
        }
    }

    private parseEvents(lines: string[]): AgentEvent[] {
        const events: AgentEvent[] = [];

        for (const line of lines) {
            try {
                const parsed = JSON.parse(line);
                const lineEvents = this.toEvents(parsed);
                events.push(...lineEvents);
            } catch {
                continue;
            }
        }

        return events.slice(-50);
    }

    private toEvents(parsed: Record<string, unknown>): AgentEvent[] {
        const ts = parsed.timestamp
            ? new Date(parsed.timestamp as string).toLocaleTimeString()
            : '';

        const msg = parsed.message as Record<string, unknown> | undefined;
        if (!msg) return [];

        const role = msg.role as string | undefined;
        const content = msg.content;

        if (role === 'user') {
            // Tool result entries have role:'user' but content is [{type:'tool_result',...}]
            if (Array.isArray(content)) {
                for (const block of content) {
                    const b = block as Record<string, unknown>;
                    if (b.type === 'tool_result') {
                        const isError = b.is_error === true;
                        const text = extractToolResultText(b.content);
                        const snippet = text ? truncate(text, 70) : '';
                        return [{
                            timestamp: ts,
                            type: 'tool_result',
                            summary: isError ? `Error: ${snippet || 'tool failed'}` : (snippet || 'Tool completed'),
                            detail: text || undefined,
                            icon: isError ? 'error' : 'check',
                        }];
                    }
                }
            }
            const text = extractText(content);
            if (!text) return [];
            return [{
                timestamp: ts,
                type: 'user',
                summary: truncate(text, 80),
                detail: text,
                icon: 'account',
            }];
        }

        if (role === 'assistant') {
            if (!Array.isArray(content)) return [];
            const events: AgentEvent[] = [];

            for (const block of content) {
                const b = block as Record<string, unknown>;

                if (b.type === 'thinking') {
                    const text = (b.thinking as string) ?? '';
                    if (text.trim()) {
                        events.push({
                            timestamp: ts,
                            type: 'thinking',
                            summary: `Thinking: ${truncate(text, 70)}`,
                            detail: text,
                            icon: 'lightbulb',
                        });
                    }
                }

                if (b.type === 'tool_use') {
                    const name = (b.name as string) ?? 'tool';
                    const args = summarizeToolArgs(b.input);
                    events.push({
                        timestamp: ts,
                        type: 'tool_use',
                        summary: `${name}${args ? ': ' + args : ''}`,
                        detail: JSON.stringify(b.input, null, 2),
                        icon: 'wrench',
                    });
                }

                if (b.type === 'text') {
                    const text = (b.text as string) ?? '';
                    if (text.trim()) {
                        events.push({
                            timestamp: ts,
                            type: 'assistant',
                            summary: truncate(text, 80),
                            detail: text,
                            icon: 'hubot',
                        });
                    }
                }
            }

            return events;
        }

        // Fallback for any other entry type with tool_result content
        if (parsed.type === 'tool_result' || msg.type === 'tool_result') {
            const isError = (msg.is_error === true) || (parsed.is_error === true);
            const resultContent = msg.content ?? parsed.content;
            const text = extractToolResultText(resultContent);
            const snippet = text ? truncate(text, 70) : '';
            return [{
                timestamp: ts,
                type: 'tool_result',
                summary: isError ? `Error: ${snippet || 'tool failed'}` : (snippet || 'Tool completed'),
                detail: text || undefined,
                icon: isError ? 'error' : 'check',
            }];
        }

        return [];
    }

    getTreeItem(element: EventItem): vscode.TreeItem {
        return element;
    }

    getChildren(): EventItem[] {
        if (!this.currentBeam) {
            return [new EventItem({ timestamp: '', type: 'info', summary: 'Select a beam to view events', icon: 'info' })];
        }

        if (this.events.length === 0) {
            const msg = this.transcriptPath
                ? 'Waiting for events...'
                : 'No agent session found on this beam';
            const icon = this.transcriptPath ? 'loading~spin' : 'info';
            return [new EventItem({ timestamp: '', type: 'info', summary: msg, icon })];
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

function extractToolResultText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((b: Record<string, unknown>) => {
                if (b.type === 'text') return (b.text as string) ?? '';
                return '';
            })
            .filter(Boolean)
            .join('\n');
    }
    return '';
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
