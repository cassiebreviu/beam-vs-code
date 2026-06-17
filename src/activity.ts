import * as vscode from 'vscode';
import { Beam, execOnBeam } from './tsh';

interface AgentSession {
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    cacheWrite: number;
    costUsd: number;
    toolCalls: ToolCall[];
    messages: number;
    model: string;
}

interface ToolCall {
    tool: string;
    args?: string;
    fullArgs?: unknown;
    result?: string;
}

const COST_PER_MILLION: Record<string, [number, number, number, number]> = {
    'opus': [15, 18.75, 1.5, 75],
    'sonnet': [3, 3.75, 0.3, 15],
    'haiku': [0.8, 1.0, 0.08, 4],
};

function estimateCost(model: string, tokensIn: number, cacheWrite: number, cacheRead: number, tokensOut: number): number {
    const key = Object.keys(COST_PER_MILLION).find(k => model.includes(k)) ?? 'sonnet';
    const [inRate, cwRate, crRate, outRate] = COST_PER_MILLION[key]!;
    return (tokensIn * inRate + cacheWrite * cwRate + cacheRead * crRate + tokensOut * outRate) / 1_000_000;
}

class ActivityItem extends vscode.TreeItem {
    public detail?: string;

    constructor(label: string, description?: string, icon?: string, collapsible?: vscode.TreeItemCollapsibleState, detail?: string) {
        super(label, collapsible ?? vscode.TreeItemCollapsibleState.None);
        this.description = description;
        this.detail = detail;
        if (icon) {
            this.iconPath = new vscode.ThemeIcon(icon);
        }
        if (detail) {
            this.command = {
                command: 'beams.showActivityDetail',
                title: 'Show Detail',
                arguments: [this],
            };
        }
    }
}

export class AgentActivityProvider implements vscode.TreeDataProvider<ActivityItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ActivityItem | undefined | null>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private currentBeam: Beam | undefined;
    private session: AgentSession | undefined;
    private pollInterval: NodeJS.Timeout | undefined;
    private transcriptPath: string | undefined;

    setBeam(beam: Beam): void {
        this.currentBeam = beam;
        this.session = undefined;
        this.transcriptPath = undefined;
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
        this.pollInterval = setInterval(() => this.poll(), 5000);
    }

    private async poll(): Promise<void> {
        if (!this.currentBeam) return;

        try {
            if (!this.transcriptPath) {
                this.transcriptPath = await this.findTranscript();
                if (!this.transcriptPath) return;
            }

            // Use tail to get the last 200 lines of the transcript
            const output = await execOnBeam(this.currentBeam.id, [
                'tail', '-n', '200', this.transcriptPath
            ]);

            if (!output.trim()) return;

            const lines = output.split('\n').filter(l => l.trim());
            this.parseTranscript(lines);
            this._onDidChangeTreeData.fire(undefined);
        } catch {
            // transcript might not exist yet, retry finding it next poll
            this.transcriptPath = undefined;
        }
    }

    private async findTranscript(): Promise<string | undefined> {
        if (!this.currentBeam) return undefined;
        try {
            const output = await execOnBeam(this.currentBeam.id, [
                'bash', '-c', 'find /home/beams/.claude/projects -name "*.jsonl" -printf "%T@ %p\\n" 2>/dev/null | sort -rn | head -1 | cut -d" " -f2-'
            ]);
            const path = output.trim();
            if (!path) return undefined;
            return path;
        } catch {
            return undefined;
        }
    }

    private parseTranscript(lines: string[]): void {
        let tokensIn = 0;
        let tokensOut = 0;
        let cacheRead = 0;
        let cacheWrite = 0;
        let model = 'claude-sonnet-4';
        const toolCalls: ToolCall[] = [];
        let messages = 0;

        for (const line of lines) {
            try {
                const parsed = JSON.parse(line);
                if (!parsed.message) continue;

                const msg = parsed.message;
                if (msg.model) model = msg.model;

                if (msg.usage) {
                    tokensIn += msg.usage.input_tokens ?? 0;
                    tokensOut += msg.usage.output_tokens ?? 0;
                    cacheRead += msg.usage.cache_read_input_tokens ?? 0;
                    cacheWrite += msg.usage.cache_creation_input_tokens ?? 0;
                }

                if (parsed.type === 'assistant' || parsed.type === 'user') {
                    messages++;
                }

                if (Array.isArray(msg.content)) {
                    for (const block of msg.content) {
                        if (block.type === 'tool_use') {
                            toolCalls.push({
                                tool: block.name ?? '?',
                                args: summarizeArgs(block.input),
                                fullArgs: block.input,
                            });
                        }
                        if (block.type === 'tool_result' && toolCalls.length > 0) {
                            const text = typeof block.content === 'string'
                                ? block.content
                                : Array.isArray(block.content)
                                    ? block.content.map((c: { text?: string }) => c.text ?? '').join('\n')
                                    : '';
                            const target = toolCalls.find(tc => !tc.result);
                            if (target) {
                                target.result = text.length > 2000 ? text.slice(0, 2000) + '...' : text;
                            }
                        }
                    }
                }
            } catch {
                continue;
            }
        }

        const costUsd = estimateCost(model, tokensIn, cacheWrite, cacheRead, tokensOut);

        this.session = {
            tokensIn,
            tokensOut,
            cacheRead,
            cacheWrite,
            costUsd,
            toolCalls: toolCalls.slice(-30),
            messages,
            model,
        };
    }

    getTreeItem(element: ActivityItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ActivityItem): ActivityItem[] {
        if (!this.currentBeam) {
            return [new ActivityItem('Select a beam to view activity', undefined, 'info')];
        }

        if (!this.session) {
            const msg = this.transcriptPath
                ? 'Waiting for session data...'
                : 'No agent session found on this beam';
            return [new ActivityItem(msg, this.transcriptPath ? 'polling...' : undefined, this.transcriptPath ? 'loading~spin' : 'info')];
        }

        if (element?.label === 'Tool Calls') {
            return this.session.toolCalls.slice().reverse().map(tc => {
                const desc = tc.args ? `${tc.args}` : '';
                const detail = formatToolDetail(tc);
                return new ActivityItem(tc.tool, desc, 'wrench', undefined, detail);
            });
        }

        const s = this.session;
        const tokenDetail = [
            `Input tokens: ${s.tokensIn.toLocaleString()}`,
            `Output tokens: ${s.tokensOut.toLocaleString()}`,
            `Cache read: ${s.cacheRead.toLocaleString()}`,
            `Cache write: ${s.cacheWrite.toLocaleString()}`,
            `Total: ${(s.tokensIn + s.tokensOut + s.cacheRead + s.cacheWrite).toLocaleString()}`,
        ].join('\n');
        const costDetail = [
            `Model: ${s.model}`,
            `Estimated cost: $${s.costUsd.toFixed(4)}`,
            '',
            `Breakdown:`,
            `  Input: ${s.tokensIn.toLocaleString()} tokens`,
            `  Output: ${s.tokensOut.toLocaleString()} tokens`,
            `  Cache read: ${s.cacheRead.toLocaleString()} tokens`,
            `  Cache write: ${s.cacheWrite.toLocaleString()} tokens`,
        ].join('\n');
        const items: ActivityItem[] = [
            new ActivityItem('Model', s.model, 'hubot', undefined, `Model: ${s.model}`),
            new ActivityItem('Tokens In', `${formatNumber(s.tokensIn)} (${formatNumber(s.cacheRead)} cached)`, 'arrow-down', undefined, tokenDetail),
            new ActivityItem('Tokens Out', formatNumber(s.tokensOut), 'arrow-up', undefined, tokenDetail),
            new ActivityItem('Cost', `$${s.costUsd.toFixed(4)}`, 'credit-card', undefined, costDetail),
            new ActivityItem('Messages', `${s.messages}`, 'comment'),
            new ActivityItem(
                'Tool Calls',
                `${s.toolCalls.length} recent`,
                'tools',
                s.toolCalls.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
            ),
        ];

        return items;
    }
}

function formatNumber(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return `${n}`;
}

function formatToolDetail(tc: ToolCall): string {
    const parts: string[] = [`Tool: ${tc.tool}`];
    if (tc.fullArgs) {
        parts.push('', 'Arguments:', JSON.stringify(tc.fullArgs, null, 2));
    }
    if (tc.result) {
        parts.push('', 'Result:', tc.result);
    }
    return parts.join('\n');
}

function summarizeArgs(input: unknown): string {
    if (!input || typeof input !== 'object') return '';
    const obj = input as Record<string, unknown>;
    if (obj.file_path) return String(obj.file_path).split('/').pop() ?? '';
    if (obj.path) return String(obj.path).split('/').pop() ?? '';
    if (obj.command) {
        const cmd = String(obj.command);
        return cmd.length > 50 ? cmd.slice(0, 50) + '...' : cmd;
    }
    if (obj.query) {
        const q = String(obj.query);
        return q.length > 50 ? q.slice(0, 50) + '...' : q;
    }
    return '';
}
