import type { AdapterChangeCause, CliAdapter, CliAdapterStatus } from '../../cli-adapter-types.js';
import type { PtyRuntimeMetadata } from '../../cli-adapters/pty-transport.js';
import type { InteractivePromptResponse } from '../types/interactive-prompt.js';
import type { SpecAdapterExitReport, SpecAdapterSignalReport } from '../spec/cli-adapter.js';
import { CodexStdioTransport, type RpcMessage, type RpcId } from './transport.js';
import { CodexQuestionLedger, record } from './questions.js';
import { CodexItemHistory } from './history.js';

/**
 * Opt-in dashboard-only runtime. No PTY attach, cold resume, or terminal input.
 * Protocol source: openai/codex rust-v0.162.1, app-server-protocol/schema/typescript/v2.
 * Async answers use ordinary input; only expectedTurnId is native authority.
 * Terminal-only async skip changes TUI-local state and emits no shared event
 * (tui/src/bottom_pane/async_questions/input.rs::handle_key_event).
 * This transport has one owning dashboard connection, so it never offers
 * shared-terminal async parity or reconstructs pending questions from history.
 */
export class CodexAppServerAdapter implements CliAdapter {
    readonly nativeTransport = 'codex-app-server' as const;
    readonly cliType = 'codex-cli';
    readonly cliName = 'Codex CLI';
    readonly transport: CodexStdioTransport;
    readonly questions: CodexQuestionLedger;
    private history = new CodexItemHistory();
    private status = 'starting';
    private errorMessage?: string;
    private nativeFailure = false;
    private settings: Record<string, unknown> = {};
    private change?: (cause: AdapterChangeCause) => void;
    private exit?: (report: SpecAdapterExitReport) => void;
    private approvals = new Map<RpcId, { method: string; params: Record<string, unknown> }>();
    private lastApprovalResolvedAt = 0;
    private started = false;
    private observedTurns = new Set<string>();
    private endedTurns = new Set<string>();

    constructor(readonly workingDir: string, readonly sessionId: string, private readonly command = 'codex',
        private readonly args: string[] = [], env: NodeJS.ProcessEnv = process.env,
        /** Isolated synthetic producers supply their own argv; production always uses app-server. */
        processArgs?: string[], private readonly envOverrides: Record<string, string> = {}) {
        this.transport = new CodexStdioTransport({ command, args: processArgs ?? [...args, 'app-server', '--listen', 'stdio://'],
            cwd: workingDir, env, onMessage: message => this.onMessage(message), onExit: (error, reason) => {
                this.questions.invalidate(); this.approvals.clear(); this.status = this.nativeFailure || reason !== 'requested' ? 'error' : 'stopped';
                if (reason !== 'requested' && !this.errorMessage) this.errorMessage = error.message;
                this.notify('pty_exit');
                this.exit?.({ runtimeSettings: this.settings });
            } });
        this.questions = new CodexQuestionLedger(sessionId, this.transport.generation);
    }

    async spawn(): Promise<void> {
        if (this.started) throw new Error('Codex managed session already started');
        this.started = true;
        this.transport.start();
        try {
            await this.transport.request('initialize', { clientInfo: { name: 'adhdev', title: 'ADHDev', version: '1' }, capabilities: { experimentalApi: true } });
            this.transport.write({ method: 'initialized' });
            const result = record(await this.transport.request('thread/start', { cwd: this.workingDir }));
            const thread = record(result?.thread);
            if (!thread || typeof thread.id !== 'string' || !thread.id) throw new Error('Invalid Codex thread/start response');
            this.questions.threadId = thread.id;
            this.status = 'idle'; this.notify('fsm_state');
        } catch (error) { this.transport.stop(); throw error; }
    }

    private notify(cause: AdapterChangeCause): void { this.change?.(cause); }
    private onMessage(message: RpcMessage): void {
        const p = record(message.params);
        if (!p || this.nativeFailure) return;
        if (message.id !== undefined) {
            if (message.method === 'item/tool/requestUserInput') {
                if (this.questions.capture(message.id, p)) this.notify('prompt_captured');
                else if (p.threadId === this.questions.threadId && p.turnId === this.questions.turnId) {
                    this.errorMessage = 'Codex question is malformed or already known; no answer dispatched'; this.notify('fsm_state');
                }
            } else if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'mcpServer/elicitation/request'].includes(message.method ?? '')
                && p.threadId === this.questions.threadId && p.turnId === this.questions.turnId
                && typeof p.itemId === 'string' && !this.approvals.has(message.id)) {
                this.approvals.set(message.id, { method: message.method ?? '', params: p }); this.notify('fsm_state');
            }
            return;
        }
        if (p.threadId !== this.questions.threadId) return;
        switch (message.method) {
            case 'turn/started': {
                const turn = record(p.turn);
                if (typeof turn?.id !== 'string' || this.endedTurns.has(turn.id) || this.observedTurns.has(turn.id)) return;
                this.observedTurns.add(turn.id);
                if (turn.id !== this.questions.turnId) this.approvals.clear();
                this.questions.beginTurn(turn.id); this.status = 'generating'; break;
            }
            case 'turn/completed': {
                const turn = record(p.turn);
                if (typeof turn?.id !== 'string') return;
                this.observedTurns.add(turn.id); this.endedTurns.add(turn.id);
                if (turn?.id !== this.questions.turnId) return;
                this.questions.invalidate(); this.approvals.clear();
                this.status = turn?.status === 'failed' ? 'error' : 'idle';
                this.nativeFailure = turn.status === 'failed';
                this.errorMessage = turn?.status === 'failed' ? 'Codex native turn failed' : undefined; break;
            }
            case 'serverRequest/resolved':
                this.questions.resolve(p.threadId, p.requestId);
                if (typeof p.requestId === 'string' || typeof p.requestId === 'number') this.approvals.delete(p.requestId);
                break;
            case 'item/started': case 'item/completed': {
                if (typeof p.turnId !== 'string') return;
                const timestamp = typeof p.startedAtMs === 'number' ? p.startedAtMs : typeof p.completedAtMs === 'number' ? p.completedAtMs : Date.now();
                this.history.item(this.questions.threadId, p.turnId, p.item, timestamp);
                if (p.turnId !== this.questions.turnId) break;
                const item = record(p.item);
                if (item?.type === 'userMessage') this.questions.observeReply(item.content);
                if (message.method === 'item/completed' && item?.type === 'agentMessage' && item.delivery === 'async' && typeof item.id === 'string') {
                    this.questions.captureAsync(item.id, p.turnId, item.questions);
                }
                break;
            }
            case 'item/agentMessage/delta':
                if (typeof p.turnId === 'string' && typeof p.itemId === 'string' && typeof p.delta === 'string') this.history.delta(this.questions.threadId, p.turnId, p.itemId, p.delta);
                break;
            case 'error':
                this.errorMessage = 'Codex reported a native error';
                if (p.willRetry === false) { this.nativeFailure = true; this.status = 'error'; this.questions.invalidate(); }
                break;
            case 'thread/status/changed': {
                const state = record(p.status);
                if (state?.type === 'systemError') { this.nativeFailure = true; this.status = 'error'; this.questions.invalidate(); this.approvals.clear(); }
                else if (state?.type === 'active' && Array.isArray(state.activeFlags)
                    && state.activeFlags.includes('waitingOnUserInput') && !this.questions.active()) {
                    this.errorMessage = 'Codex is waiting for input without an authoritative question request. Answering is unavailable.';
                }
                break;
            }
            default: return;
        }
        this.notify('fsm_state');
    }

    async sendMessage(text: string): Promise<{ status: 'delivered' }> {
        if (!this.isReady()) throw new Error('Codex managed runtime unavailable');
        const prompt = this.questions.active();
        if (prompt?.binding?.transport === 'codex_rpc' && prompt.blocking !== false) throw new Error('Resolve the current native question before sending another input');
        const priorAsync = this.questions.asyncKeys();
        const input = [{ type: 'text', text, textElements: [] }];
        if (this.questions.turnId) await this.transport.request('turn/steer', { threadId: this.questions.threadId, expectedTurnId: this.questions.turnId, input });
        else {
            const result = record(await this.transport.request('turn/start', { threadId: this.questions.threadId, input }));
            const turn = record(result?.turn);
            if (typeof turn?.id !== 'string') throw new Error('Invalid Codex turn response');
            // A native terminal event can arrive in the same chunk as this response.
            // The response must never resurrect a turn already completed by the stream.
            if (!this.observedTurns.has(turn.id)) { this.observedTurns.add(turn.id); this.questions.beginTurn(turn.id); this.status = 'generating'; }
        }
        this.questions.clearAsync(priorAsync);
        this.notify('fsm_state'); return { status: 'delivered' };
    }

    async setInteractivePromptResponse(response: InteractivePromptResponse): Promise<void> {
        if (!this.isReady()) throw new Error('Codex runtime unavailable');
        const prepared = this.questions.prepare(response);
        this.questions.reserve(prepared.key);
        if (response.action === 'dismiss') { this.questions.dismiss(prepared.key); this.notify('prompt_cleared'); return; }
        const binding = prepared.prompt.binding!;
        if (binding.transport === 'codex_rpc') {
            this.transport.write({ id: binding.requestId!, result: { answers: prepared.answers } });
        } else {
            const replies = prepared.prompt.questions.filter(q => prepared.answers[q.questionId]).map(q => ({
                questionItemId: q.questionId, question: boundedTitle(q.question), answer: prepared.answers[q.questionId].answers[0],
            }));
            const text = `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`;
            try {
                await this.transport.request('turn/steer', { threadId: binding.threadId, expectedTurnId: binding.turnId, input: [{ type: 'text', text, textElements: [] }] });
            } catch (error) { this.questions.uncertain(prepared.key); this.notify('prompt_updated'); throw error; }
            // An acknowledgement verifies ordinary input delivery, not native question authority.
            this.questions.observeReply([{ type: 'text', text }]);
        }
        this.notify('prompt_updated');
    }

    getStatus(): CliAdapterStatus {
        const approval = this.approvals.values().next().value;
        const prompt = this.questions.active();
        return { status: approval ? 'waiting_approval' : prompt?.binding?.transport === 'codex_rpc' && prompt.blocking !== false ? 'waiting_choice' : this.status, providerSessionId: this.questions.threadId || undefined,
            activeInteractivePrompt: this.questions.active(), errorMessage: this.errorMessage,
            activeModal: approval ? { kind: 'confirm', message: 'Native permission grants are unavailable in this dashboard-only transport. No approval was sent.', buttons: [] } : null };
    }
    getScriptParsedStatus() { return { ...this.getStatus(), messages: this.history.read(), title: this.cliName,
        ephemeralQuestionMessageKeys: this.history.ephemeralQuestionMessageKeys() }; }
    async readHistoryPage(threadId: string, cursor?: string): Promise<string | null> {
        if (!this.isReady() || threadId !== this.questions.threadId) throw new Error('Cannot switch managed Codex history to another thread');
        const page = record(await this.transport.request('thread/turns/list', { threadId, cursor, limit: 20, sortDirection: 'asc', itemsView: 'full' }));
        if (!page || !Array.isArray(page.data) || !(page.nextCursor === null || typeof page.nextCursor === 'string')) throw new Error('Invalid Codex history page');
        this.history.hydrate({ id: threadId, turns: page.data });
        this.notify('fsm_state');
        return page.nextCursor;
    }
    getRuntimeMetadata(): PtyRuntimeMetadata & Record<string, unknown> { return { runtimeId: this.sessionId, runtimeKey: this.transport.generation,
        surfaceKind: 'live_runtime', lifecycle: this.status, spawnedEnv: this.envOverrides, attachedClients: [{ clientId: this.sessionId, type: 'daemon', readOnly: false }] }; }
    getLaunchInfo() { return { command: this.command, args: [...this.args, 'app-server', '--listen', 'stdio://'], extraArgs: this.args, cwd: this.workingDir, extraEnvKeys: Object.keys(this.envOverrides), providerSessionId: this.questions.threadId }; }
    getInteractivePromptTransport(): 'wire' { return 'wire'; }
    isReady(): boolean { return this.transport.isAlive() && !!this.questions.threadId && !this.nativeFailure && this.status !== 'error'; }
    isAlive(): boolean { return this.transport.isAlive(); }
    isProcessing(): boolean { return this.status === 'generating'; }
    setOnChange(callback: (cause: AdapterChangeCause) => void): void { this.change = callback; }
    setOnStatusChange(callback: () => void): void { this.change = callback; }
    setOnExit(callback: ((report: SpecAdapterExitReport) => void) | null): void { this.exit = callback ?? undefined; }
    setOnSignal(_callback: ((report: SpecAdapterSignalReport) => void) | null): void {}
    setOnApprovalResolved(_callback: ((event: { resolvedAt: number; buttonLabel?: string }) => void) | null): void {}
    getLastApprovalResolvedAt(): number { return this.lastApprovalResolvedAt; }
    isApprovalRecentlyResolved(): boolean { return false; }
    updateRuntimeSettings(settings: Record<string, unknown>): void { this.settings = { ...settings }; }
    updateRuntimeMeta(meta: Record<string, unknown>): void {
        if (meta.providerSessionId && meta.providerSessionId !== this.questions.threadId) throw new Error('Managed Codex cannot switch or resume a native thread');
    }
    refreshProviderDefinition(_provider: unknown): void {}
    setServerConn(_connection: unknown): void {}
    setOnPtyData(_callback: (data: string) => void): void {}
    getTerminalScreenSnapshot(_maxBytes?: number): never { throw new Error('Managed Codex sessions have no terminal'); }
    injectKeys(): Promise<never> { return Promise.reject(new Error('Managed Codex sessions have no terminal input')); }
    setSignalObservation(_snapshot: unknown): void {}
    writeRaw(_data: string): void { throw new Error('Managed Codex stdio sessions do not support terminal input'); }
    resize(_cols: number, _rows: number): void {}
    invokeScript(_script: string, _args?: Record<string, unknown>): Promise<never> { return Promise.reject(new Error('PTY controls are unavailable for managed Codex sessions')); }
    resolveAction(_data: unknown): Promise<never> { return Promise.reject(new Error('Native permission grants require a supported exact owner approval path')); }
    async interruptTurn() {
        if (!this.questions.turnId) return { ok: false as const, reason: 'no_active_turn', message: 'No active Codex turn' };
        await this.transport.request('turn/interrupt', { threadId: this.questions.threadId, turnId: this.questions.turnId });
        this.questions.invalidate(); this.notify('prompt_cleared');
        return { ok: true as const, keyName: 'turn/interrupt', bytes: 0, confidence: 'proven' as const };
    }
    cancel(): void { void this.interruptTurn().catch(() => {}); }
    shutdown(): void { this.transport.stop(); }
    detach(): void { this.shutdown(); }
    clearHistory(): void { this.history.clear(); }
}

function boundedTitle(question: string): string {
    const bytes = Buffer.from(question);
    let end = Math.min(bytes.length, 512);
    if (end < bytes.length) while ((bytes[end] & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end).toString('utf8').replace(/[\r\n]/g, ' ');
}
