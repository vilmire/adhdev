/**
 * SpecCliAdapter — bridges SpecDriver into the daemon's CliAdapter
 * interface so an existing CliProviderInstance can drive a spec-backed
 * provider without rewriting the surrounding session machinery.
 *
 * Translation:
 *   spec state.id 'approval' (with modal_buttons that produced a modal)
 *     → CliAdapterStatus.status='waiting_approval', activeModal={...}
 *   spec state.id 'busy' / any non-decision state with a 'busy' label
 *     → status='generating'
 *   spec state.id 'idle' or default
 *     → status='idle'
 *
 * Methods that the round-3 spec model doesn't have an opinion on
 * (transcript reading, slash commands, history, runtime metadata
 * surfacing) are minimal stubs. They satisfy the daemon's call sites
 * without pretending to implement anything.
 */
'use strict';

import { FsmDriver, type DashboardEvent, type ISpecDriver } from './fsm-driver.js';
import { executeNativeHistory } from './native-history-executor.js';
import * as fs from 'node:fs';
import type { NativeHistoryConfig, Control } from './types.js';
import type { CliAdapter, CliAdapterStatus } from '../../cli-adapter-types.js';
import type { ChatMessage } from '../../types.js';
import type { PtyTransportFactory } from '../../cli-adapters/pty-transport.js';
import { LOG } from '../../logging/logger.js';
import {
    buildClaudeInteractiveTuiAnswerSteps,
    buildClaudeInteractiveToolResult,
    detectClaudeAskUserQuestionPromptFromJson,
    detectClaudeAskUserQuestionPromptFromTuiPages,
    type ClaudeInteractiveTuiPage,
    type InteractivePrompt,
    type InteractivePromptResponse,
} from '../types/interactive-prompt.js';


function stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return String(text || '')
        .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
        .replace(/\x1B[P^_X][\s\S]*?(?:\x07|\x1B\\)/g, '')
        .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

export class SpecCliAdapter implements CliAdapter {
    readonly cliType: string;
    readonly cliName: string;
    readonly workingDir: string;
    /**
     * Marker the daemon's finalization gate checks: `getStatus()` returns
     * `messages: []` by design here (chat history lives in the daemon's
     * native-history pipeline, not the adapter). Without this flag,
     * cli-provider-instance's `missing_final_assistant` gate would stall
     * every turn until the 30s safety timeout because it expects the
     * adapter to surface the final assistant message.
     */
    readonly chatMessagesOwnedExternally = true as const;

    private driver: ISpecDriver;
    /** Common spec fields the adapter reads, present in both v3 and v4. */
    private spec: {
        id: string;
        name: string;
        control_bar?: Control[];
        native_history?: NativeHistoryConfig;
    };
    private lastEvent: DashboardEvent | null = null;
    private latestState: { id: string; label: string; title: string | null; status: 'idle' | 'generating' | 'approval' } | null = null;
    private latestModal: { title: string | null; buttons: { index: number; label: string }[] } | null = null;
    private statusCallback: (() => void) | null = null;
    private ptyDataCallback: ((data: string) => void) | null = null;
    private partialResponse = '';
    private activeInteractivePrompt: InteractivePrompt | null = null;
    private interactivePromptTransport: 'stream-json' | 'tui' | null = null;
    private claudeTuiPromptCaptureInFlight = false;
    private jsonLineTail = '';
    private exited = false;
    private spawned = false;
    private providerSessionId: string | undefined;
    /** Wall clock at the moment spawn() ran. Used as the cutoff for
     *  native-history file selection so a prior session's transcript
     *  can't leak into this session before the agent has written its
     *  own records. */
    private spawnedAtMs = 0;
    /** Env vars the daemon set on the spawned child. Mesh coordinator
     *  points hermes at a per-coordinator HERMES_HOME so the dashboard's
     *  native-history reader needs that override to find the right
     *  state.db; without it the reader sees ~/.hermes/state.db which
     *  the coordinator-launched hermes never writes to. The choice to
     *  redirect HERMES_HOME is a workaround for an unresolved hermes
     *  upstream feature gap (see hermes-agent#23130 — runtime-supplied
     *  MCP config), so this routing keeps the dashboard honest until
     *  hermes ships a runtime MCP override. */
    private spawnedEnv: Record<string, string> = {};

    constructor(
        specPath: string,
        workingDir: string,
        cliArgs: string[],
        extraEnv: Record<string, string>,
        transportFactory?: PtyTransportFactory,
    ) {
        const raw = JSON.parse(fs.readFileSync(specPath, 'utf8'));
        this.spec = {
            id: raw.id,
            name: raw.name,
            control_bar: raw.control_bar,
            native_history: raw.native_history,
        };
        this.cliType = this.spec.id;
        this.cliName = this.spec.name;
        this.workingDir = workingDir;
        this.spawnedEnv = { ...extraEnv };

        // cli-manager.ts allocates providerSessionId per launch and threads
        // it through resume.newSessionArgs as additional cliArgs (e.g.
        // ["--session-id", "<uuid>"]). We must hand those to the driver
        // so the agent uses the daemon's id, otherwise (claude case) the
        // agent generates its own id and the chat-history pipeline can't
        // pair the on-disk transcript with the live session.
        this.driver = new FsmDriver({
            specPath,
            workingDir,
            extraEnv,
            hotReload: true,
            emitTrace: false,
            transportFactory,
            extraCliArgs: cliArgs,
        });
        this.driver.subscribe((ev) => this.handleEvent(ev));
    }

    async spawn(): Promise<void> {
        if (this.spawned) return;
        this.driver.start();
        this.spawned = true;
        this.spawnedAtMs = Date.now();
    }

    async sendMessage(text: string): Promise<void> {
        // Content-free at info — the prompt body is user data.
        LOG.info('SpecAdapter', `[${this.cliType}] sendMessage(len=${text.length})`);
        LOG.debug('SpecAdapter', `[${this.cliType}] sendMessage body=${JSON.stringify(text.slice(0, 80))}${text.length > 80 ? '…' : ''}`);
        this.driver.dispatch({ kind: 'send_message', text });
    }

    getStatus(): CliAdapterStatus {
        const sessionFields = this.providerSessionId ? { providerSessionId: this.providerSessionId } : {};
        if (this.exited) return { status: 'stopped', messages: [], activeModal: null, activeInteractivePrompt: this.activeInteractivePrompt, ...sessionFields };
        if (!this.spawned) return { status: 'starting', messages: [], activeModal: null, activeInteractivePrompt: this.activeInteractivePrompt, ...sessionFields };

        // Refresh native history lazily — the watch_path is cheap to stat,
        // but parsing a full session.jsonl every call would be wasteful.
        this.maybeRefreshNativeHistory();

        const state = this.latestState;
        if (!state) return { status: 'starting', messages: [], activeModal: null, activeInteractivePrompt: this.activeInteractivePrompt, ...sessionFields };

        // The FSM state is authoritative for status. We do NOT infer status from whether
        // a modal was parsed this frame: a modal/approval state whose buttons briefly fail
        // to parse (PTY repaint) must still report waiting_approval, not collapse to idle —
        // that collapse fired false completions while a session sat at an approval prompt.
        const modal = this.latestModal;
        if (state.status === 'approval') {
            return {
                status: 'waiting_approval',
                messages: [],
                // Surface buttons when we have them; an approval state with no parsed
                // modal this frame still stays waiting_approval (no activeModal yet).
                activeModal: modal
                    ? { message: modal.title ?? state.label, buttons: modal.buttons.map(b => b.label) }
                    : null,
                activeInteractivePrompt: this.activeInteractivePrompt,
                ...sessionFields,
            };
        }
        if (state.status === 'generating') {
            return { status: 'generating', messages: [], activeModal: null, activeInteractivePrompt: this.activeInteractivePrompt, ...sessionFields };
        }
        return { status: 'idle', messages: [], activeModal: null, activeInteractivePrompt: this.activeInteractivePrompt, ...sessionFields };
    }

    private maybeRefreshNativeHistory(): void {
        // Native history is now sourced by daemon's chat-history pipeline
        // (which calls provider.scripts.readNativeHistory wired by
        // provider-loader). SpecCliAdapter no longer polls or caches.
    }

    getScriptParsedStatus(): unknown {
        const providerSessionId = this.extractProviderSessionIdFromScreen();
        if (providerSessionId) this.providerSessionId = providerSessionId;
        const status = this.getStatus();
        return {
            ...status,
            messages: this.readClaudeScreenAssistantMessages(),
            ...(this.providerSessionId ? { providerSessionId: this.providerSessionId } : {}),
        };
    }

    getPartialResponse(): string {
        return this.partialResponse;
    }

    shutdown(): void {
        try { this.driver.dispatch({ kind: 'shutdown' }); } catch { /* ignore */ }
    }

    cancel(): void {
        try { this.driver.dispatch({ kind: 'cancel' }); } catch { /* ignore */ }
    }

    isProcessing(): boolean {
        return this.getStatus().status === 'generating';
    }

    isReady(): boolean {
        return this.spawned && !this.exited;
    }

    setOnStatusChange(cb: () => void): void {
        this.statusCallback = cb;
    }

    setOnPtyData(cb: (data: string) => void): void {
        this.ptyDataCallback = cb;
    }

    writeRaw(data: string): void {
        // Raw pty input — typed characters, escape codes, arrow keys —
        // goes straight to the underlying terminal. send_message would
        // append submit_key after every chunk, which is why typing in
        // the dashboard terminal felt like "enter on every keystroke".
        this.driver.dispatch({ kind: 'pty_write', data });
    }

    resize(cols: number, rows: number): void {
        this.driver.dispatch({ kind: 'resize', cols, rows });
    }

    resolveModal(buttonIndex: number): void {
        // CliAdapter buttonIndex is 0-based; spec buttons are 1-based.
        this.driver.dispatch({ kind: 'click_modal_button', index: buttonIndex + 1 });
    }

    async resolveAction(data: unknown): Promise<void> {
        const args = (data && typeof data === 'object') ? (data as any) : {};
        const explicitIndex = typeof args.buttonIndex === 'number' ? args.buttonIndex : -1;
        if (explicitIndex >= 0) { this.resolveModal(explicitIndex); return; }
        const action = typeof args.action === 'string' ? args.action : 'approve';
        const buttons = this.latestModal?.buttons ?? [];
        if (buttons.length === 0) return;
        let target = -1;
        if (action === 'reject' || action === 'deny') {
            target = buttons.findIndex(b => /^(no|deny|reject|cancel)\b/i.test(b.label));
            if (target < 0) target = buttons.length - 1;
        } else {
            target = buttons.findIndex(b => /^(yes|allow|approve|accept|continue|proceed|update)\b/i.test(b.label));
            if (target < 0) target = 0;
        }
        this.resolveModal(target);
    }

    async setInteractivePromptResponse(response: InteractivePromptResponse): Promise<void> {
        const prompt = this.activeInteractivePrompt;
        if (!prompt || prompt.promptId !== response.promptId) throw new Error('Interactive prompt response does not match active prompt');
        if (this.cliType !== 'claude-cli') return;
        if (this.interactivePromptTransport === 'tui') {
            const steps = buildClaudeInteractiveTuiAnswerSteps(prompt, response);
            for (const step of steps) {
                this.driver.dispatch({ kind: 'pty_write', data: step });
                await new Promise(resolve => setTimeout(resolve, 180));
            }
        } else {
            this.driver.dispatch({ kind: 'pty_write', data: `${buildClaudeInteractiveToolResult(response)}\n` });
        }
        this.activeInteractivePrompt = null;
        this.interactivePromptTransport = null;
        this.statusCallback?.();
    }

    isApprovalRecentlyResolved(): boolean { return false; }
    clearHistory(): void { /* no transcript buffer yet */ }
    updateRuntimeSettings(): void { /* no runtime settings in spec model yet */ }
    setServerConn(): void { /* server conn unused by SpecDriver */ }
    /**
     * Map an invokeScript(name, args) call onto a control_bar entry.
     *
     * scriptName is matched against control.id. The control's action.type
     * drives the dispatch:
     *
     *   send_keys     → click_control                   (e.g. stop)
     *   open_picker   → click_control then resolve when extract_choices
     *                   surface; choice index comes from args.choiceIndex
     *                   or args.choice (string label match), defaulting to 0
     *   attach_image  → attach_image dispatch; expects args.blob (data url
     *                   or base64) and args.mime
     *
     * Callers that pass an unknown control id get a { not_found } response.
     * No control matched, no driver call — keeps the surface honest.
     */
    invokeScript(scriptName: string, args?: Record<string, unknown>): Promise<unknown> {
        const controls = this.spec.control_bar ?? [];
        const ctl = controls.find(c => c.id === scriptName);
        if (!ctl) {
            return Promise.resolve({ ok: false, error: `unknown control: ${scriptName}` });
        }
        // Args may arrive as either { blob, mime } (direct invocation) or
        // { params: { blob, mime } } (when the dashboard wraps script args
        // in a params bag). Look at both.
        const flat: Record<string, unknown> = { ...(args || {}) };
        if (args && typeof args.params === 'object' && args.params) {
            Object.assign(flat, args.params as Record<string, unknown>);
        }
        const action = ctl.action;
        if (action.type === 'attach_image') {
            const blob = typeof flat.blob === 'string' ? flat.blob : '';
            const mime = typeof flat.mime === 'string' ? flat.mime : 'image/png';
            if (!blob) return Promise.resolve({ ok: false, error: 'attach_image requires args.blob (base64 or data URL)' });
            this.driver.dispatch({ kind: 'attach_image', blob, mime });
            return Promise.resolve({ ok: true, effects: [{ type: 'attached_image', controlId: ctl.id }] });
        }
        // send_keys + open_picker both route through click_control. For
        // open_picker the dashboard sees the picker modal arrive via a
        // state_changed event, then submits the choice using
        // resolveModal/click_modal_button. invokeScript's synchronous
        // return is just an acknowledgement that the trigger fired.
        this.driver.dispatch({ kind: 'click_control', control_id: ctl.id, payload: flat });
        const effects: { type: string; controlId: string }[] = [];
        if (action.type === 'open_picker') effects.push({ type: 'opened_picker', controlId: ctl.id });
        else if (action.type === 'send_keys') effects.push({ type: 'sent_keys', controlId: ctl.id });
        return Promise.resolve({ ok: true, effects });
    }
    getDebugSnapshot(): unknown {
        let screen = '';
        let sections: Record<string, string> | undefined;
        try {
            screen = this.driver.snapshot();
            const driverSections = this.driver.getSections?.();
            if (driverSections) {
                sections = Object.fromEntries(driverSections.map(s => [s.id, s.text]));
            } else {
                sections = this.readCurrentScreenSections(screen);
            }
        } catch { /* best-effort */ }
        // Read native transcript messages for the debug snapshot
        let messages: any[] = [];
        if (this.spec.native_history?.source) {
            try {
                const nhResult = executeNativeHistory(this.spec.native_history, {
                    agentType: this.cliType,
                    providerSessionId: this.providerSessionId,
                    sessionStartedAtMs: this.spawnedAtMs,
                    envOverrides: this.spawnedEnv,
                    workspace: this.workingDir,
                });
                if (nhResult && Array.isArray(nhResult.messages)) messages = nhResult.messages;
            } catch { /* best-effort */ }
        } else {
            messages = this.readClaudeScreenAssistantMessages();
        }
        return {
            cliType: this.cliType,
            spec_id: this.spec.id,
            current_state: this.latestState,
            current_modal: this.latestModal,
            activeInteractivePrompt: this.activeInteractivePrompt,
            exited: this.exited,
            screen,
            sections,
            stateHistory: this.driver.getStateHistory(),
            idleHoldPending: this.driver.hasIdleHoldPending(),
            lastBusyAt: this.driver.getLastBusyAt(),
            specPath: this.driver.getSpecPath(),
            cursorPosition: this.driver.getCursorPosition(),
            completionIdleDebounce: this.driver.getCompletionIdleDebounceState(),
            // v4 FSM live transition table (null for v3 specs). Every outgoing
            // transition from the current state with its per-condition match
            // result + countdown — the canonical "why isn't it moving" answer.
            fsm: this.driver.getFsmDebug?.() ?? null,
            // Extended fields
            name: this.cliName,
            status: this.getStatus().status,
            workingDir: this.workingDir,
            spawnedAtMs: this.spawnedAtMs,
            providerSessionId: this.providerSessionId ?? null,
            messages,
            committedMessages: messages,
        };
    }
    getRuntimeMetadata(): unknown {
        return {
            runtimeId: this.spec.id,
            runtimeKey: this.spec.id,
            displayName: this.spec.name,
            spawnedAtMs: this.spawnedAtMs,
            spawnedEnv: this.spawnedEnv,
            ...(this.providerSessionId ? { providerSessionId: this.providerSessionId } : {}),
        };
    }
    updateRuntimeMeta(meta?: Record<string, unknown>): void {
        if (meta && typeof meta.providerSessionId === 'string') {
            this.providerSessionId = meta.providerSessionId;
        }
    }
    refreshProviderDefinition(): void { /* hot reload handled by SpecDriver fs.watch */ }

    private handleEvent(ev: DashboardEvent): void {
        this.lastEvent = ev;
        switch (ev.kind) {
            case 'state_changed':
                this.latestState = ev.state;
                this.latestModal = ev.modal;
                // info-level keeps only spec-defined identifiers (state.id /
                // state.label / button count). The extracted title can carry
                // user data — file paths, command text, ticket titles — so
                // it stays at debug.
                LOG.info('SpecAdapter', `[${this.cliType}] state=${ev.state.id} (${ev.state.label}) modal=${ev.modal ? `${ev.modal.buttons.length}-buttons` : 'none'}`);
                if (ev.state.title) {
                    LOG.debug('SpecAdapter', `[${this.cliType}] state.title=${JSON.stringify(ev.state.title)}`);
                }
                this.maybeCaptureClaudeTuiPrompt();
                this.statusCallback?.();
                return;
            case 'pty_data':
                this.detectInteractivePromptFromPtyChunk(ev.chunk);
                this.maybeCaptureClaudeTuiPrompt();
                try { this.ptyDataCallback?.(ev.chunk); } catch { /* ignore */ }
                return;
            case 'exit':
                this.exited = true;
                this.statusCallback?.();
                return;
            case 'spec_error':
                LOG.warn('SpecAdapter', `[${this.cliType}] spec reload error: ${ev.errors.join('; ')}`);
                return;
            default:
                return;
        }
    }

    private detectInteractivePromptFromPtyChunk(chunk: string): void {
        if (this.cliType !== 'claude-cli' || !chunk) return;
        this.jsonLineTail += chunk;
        if (this.jsonLineTail.length > 64 * 1024) this.jsonLineTail = this.jsonLineTail.slice(-64 * 1024);
        const lines = this.jsonLineTail.split(/\r?\n/);
        this.jsonLineTail = lines.pop() || '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('{') || !trimmed.includes('AskUserQuestion')) continue;
            try {
                const parsed = JSON.parse(trimmed);
                const prompt = detectClaudeAskUserQuestionPromptFromJson(parsed, this.cliType);
                if (!prompt) continue;
                this.activeInteractivePrompt = prompt;
                this.interactivePromptTransport = 'stream-json';
                this.statusCallback?.();
            } catch {
                // PTY output is not guaranteed to be machine JSON.
            }
        }
    }

    private readCurrentScreenSections(_screenText: string): Record<string, string> {
        try {
            const sections = this.driver.getSections() ?? [];
            return Object.fromEntries(sections.map(section => [section.id, section.text]));
        } catch {
            return {};
        }
    }

    private extractProviderSessionIdFromScreen(): string | undefined {
        if (this.cliType !== 'codex-cli') return this.providerSessionId;
        let screenText = '';
        try {
            screenText = this.driver.snapshot();
        } catch {
            return this.providerSessionId;
        }
        const clean = stripAnsi(screenText);
        const match = clean.match(/(?:gpt-|o\d|codex-)[^\n·]*·[^\n·]*·\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        return match?.[1] || this.providerSessionId;
    }

    private readClaudeScreenAssistantMessages(): ChatMessage[] {
        if (this.cliType !== 'claude-cli') return [];
        let screenText = '';
        try {
            screenText = this.driver.snapshot();
        } catch {
            return [];
        }
        const sections = this.readCurrentScreenSections(screenText);
        const body = sections.body || screenText;
        const messages: ChatMessage[] = [];
        const seen = new Set<string>();
        for (const line of body.split(/\r?\n/)) {
            const match = line.match(/^\s*⏺\s+(.+?)\s*$/);
            const content = match?.[1]?.trim();
            if (!content || seen.has(content)) continue;
            seen.add(content);
            messages.push({
                role: 'assistant',
                kind: 'standard',
                content,
                source: 'assistant_text',
                userFacing: true,
                bubbleState: 'final',
            });
        }
        return messages;
    }

    private maybeCaptureClaudeTuiPrompt(): void {
        if (this.cliType !== 'claude-cli'
            || this.activeInteractivePrompt
            || this.claudeTuiPromptCaptureInFlight) return;
        const screenText = this.driver.snapshot();
        const headers = this.readClaudeTuiHeaders(screenText);
        if (!screenText.includes('Enter to select')) return;
        if (headers.length === 0) {
            const prompt = detectClaudeAskUserQuestionPromptFromTuiPages([{ screenText }], {
                promptId: `ask-user-${this.providerSessionId || 'claude'}-${Date.now()}`,
                providerType: this.cliType,
            });
            if (!prompt) return;
            this.activeInteractivePrompt = prompt;
            this.interactivePromptTransport = 'tui';
            this.statusCallback?.();
            return;
        }
        this.claudeTuiPromptCaptureInFlight = true;
        void this.captureClaudeTuiPrompt(screenText, headers).finally(() => {
            this.claudeTuiPromptCaptureInFlight = false;
        });
    }

    private readClaudeTuiHeaders(screenText: string): string[] {
        const navLine = screenText.split(/\r?\n/).find(line => line.includes('✔ Submit') && /[☐☒]/.test(line));
        if (!navLine) return [];
        const headers: string[] = [];
        for (const match of navLine.matchAll(/[☐☒]\s+(.+?)(?=\s+[☐☒]|\s+✔\s+Submit)/g)) {
            const header = match[1]?.trim();
            if (header) headers.push(header);
        }
        return headers;
    }

    private async captureClaudeTuiPrompt(firstScreen: string, headers: string[]): Promise<void> {
        const pages: ClaudeInteractiveTuiPage[] = [{ screenText: firstScreen, header: headers[0] }];
        for (let index = 1; index < headers.length; index += 1) {
            this.driver.dispatch({ kind: 'pty_write', data: '\t' });
            await new Promise(resolve => setTimeout(resolve, 120));
            pages.push({ screenText: this.driver.snapshot(), header: headers[index] });
        }
        for (let index = headers.length - 1; index > 0; index -= 1) {
            this.driver.dispatch({ kind: 'pty_write', data: '\x1b[Z' });
            await new Promise(resolve => setTimeout(resolve, 80));
        }

        const prompt = detectClaudeAskUserQuestionPromptFromTuiPages(pages, {
            promptId: `ask-user-${this.providerSessionId || 'claude'}-${Date.now()}`,
            providerType: this.cliType,
        });
        if (!prompt) return;
        this.activeInteractivePrompt = prompt;
        this.interactivePromptTransport = 'tui';
        this.statusCallback?.();
    }

    getDebugState(): Record<string, any> {
        const screen = this.driver.getScreen?.() ?? '';
        const history = this.driver.getStateHistory();
        const status = this.getStatus();
        
        let messages: any[] = [];
        if (this.spec.native_history?.source) {
            try {
                const result = executeNativeHistory(this.spec.native_history, {
                    agentType: this.cliType,
                    providerSessionId: this.providerSessionId,
                    sessionStartedAtMs: this.spawnedAtMs,
                    envOverrides: this.spawnedEnv,
                    workspace: this.workingDir,
                });
                if (result && Array.isArray(result.messages)) {
                    messages = result.messages;
                }
            } catch (e) {
                // Ignore native history read errors in debug state
            }
        } else {
            messages = this.readClaudeScreenAssistantMessages();
        }

        const latestState = this.latestState;
        const latestModal = this.latestModal;
        return {
            type: this.cliType,
            name: this.cliName,
            status: status.status,
            rawStatus: status.status,
            projectedStatus: status.status,
            ready: this.spawned,
            // Legacy snapshot-style fields for panels that read getDebugSnapshot shape
            spec_id: this.spec.id,
            current_state: latestState ?? null,
            current_modal: latestModal ?? null,
            exited: this.exited,
            idleHoldPending: this.driver.hasIdleHoldPending?.() ?? false,
            lastBusyAt: this.driver.getLastBusyAt?.() ?? 0,
            screen: screen,
            screenText: screen,
            workingDir: this.workingDir,
            spawnedAtMs: this.spawnedAtMs,
            providerSessionId: this.providerSessionId ?? null,
            sections: this.driver.getSections?.() ?? null,
            stateHistory: history,
            specPath: this.driver.getSpecPath?.() ?? null,
            // v4 FSM live transition table — present only for FsmDriver. Lets
            // the panel (and the daemon API) show, for the current instant,
            // every outgoing transition with its per-condition match result
            // and countdown. This is the canonical "why isn't it transitioning"
            // answer — no screenshots needed.
            fsm: this.driver.getFsmDebug?.() ?? null,
            messages,
            committedMessages: messages,
        };
    }

    getTraceState(limit = 120): Record<string, any> {
        const history = this.driver.getStateHistory();
        return {
            status: this.getStatus().status,
            stateHistory: history.slice(-limit),
            screenText: this.driver.getScreen?.() ?? '',
        };
    }

    getProviderResolutionMeta(): Record<string, any> {
        return {
            type: this.cliType,
            providerDir: null,
            resolvedVersion: null,
        };
    }
}
