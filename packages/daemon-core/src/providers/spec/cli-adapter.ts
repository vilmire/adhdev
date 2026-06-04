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

import { SpecDriver, type DashboardEvent } from './driver.js';
import { loadSpec } from './loader.js';
import type { CliSpec } from './types.js';
import type { CliAdapter, CliAdapterStatus } from '../../cli-adapter-types.js';
import type { ChatMessage } from '../../types.js';
import { LOG } from '../../logging/logger.js';

export class SpecCliAdapter implements CliAdapter {
    readonly cliType: string;
    readonly cliName: string;
    readonly workingDir: string;

    private driver: SpecDriver;
    private spec: CliSpec;
    private lastEvent: DashboardEvent | null = null;
    private latestState: { id: string; label: string; title: string | null } | null = null;
    private latestModal: { title: string | null; buttons: { index: number; label: string }[] } | null = null;
    private statusCallback: (() => void) | null = null;
    private ptyDataCallback: ((data: string) => void) | null = null;
    private partialResponse = '';
    private exited = false;
    private spawned = false;
    private providerSessionId: string | undefined;

    constructor(
        specPath: string,
        workingDir: string,
        _cliArgs: string[],
        extraEnv: Record<string, string>,
    ) {
        const res = loadSpec(specPath);
        if (!res.ok) throw new Error(`spec invalid (${specPath}): ${res.errors.join('; ')}`);
        this.spec = res.spec;
        this.cliType = this.spec.id;
        this.cliName = this.spec.name;
        this.workingDir = workingDir;

        this.driver = new SpecDriver({
            specPath,
            workingDir,
            extraEnv,
            hotReload: true,
            emitTrace: false,
        });
        this.driver.subscribe((ev) => this.handleEvent(ev));
    }

    async spawn(): Promise<void> {
        if (this.spawned) return;
        this.driver.start();
        this.spawned = true;
    }

    async sendMessage(text: string): Promise<void> {
        // Content-free at info — the prompt body is user data.
        LOG.info('SpecAdapter', `[${this.cliType}] sendMessage(len=${text.length})`);
        LOG.debug('SpecAdapter', `[${this.cliType}] sendMessage body=${JSON.stringify(text.slice(0, 80))}${text.length > 80 ? '…' : ''}`);
        this.driver.dispatch({ kind: 'send_message', text });
    }

    getStatus(): CliAdapterStatus {
        if (this.exited) return { status: 'stopped', messages: [], activeModal: null };
        if (!this.spawned) return { status: 'starting', messages: [], activeModal: null };

        // Refresh native history lazily — the watch_path is cheap to stat,
        // but parsing a full session.jsonl every call would be wasteful.
        this.maybeRefreshNativeHistory();

        const state = this.latestState;
        if (!state) return { status: 'starting', messages: [], activeModal: null };

        const modal = this.latestModal;
        const lc = state.id.toLowerCase();
        if (modal) {
            return {
                status: 'waiting_approval',
                messages: [],
                activeModal: {
                    message: modal.title ?? state.label,
                    buttons: modal.buttons.map(b => b.label),
                },
            };
        }
        if (/busy|generating|working|running|thinking/i.test(lc + ' ' + state.label)) {
            return { status: 'generating', messages: [], activeModal: null };
        }
        return { status: 'idle', messages: [], activeModal: null };
    }

    private maybeRefreshNativeHistory(): void {
        // Native history is now sourced by daemon's chat-history pipeline
        // (which calls provider.scripts.readNativeHistory wired by
        // provider-loader). SpecCliAdapter no longer polls or caches.
    }

    getScriptParsedStatus(): unknown {
        return this.getStatus();
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
        this.driver.dispatch({ kind: 'send_message', text: data });
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

    isApprovalRecentlyResolved(): boolean { return false; }
    clearHistory(): void { /* no transcript buffer yet */ }
    updateRuntimeSettings(): void { /* no runtime settings in spec model yet */ }
    setServerConn(): void { /* server conn unused by SpecDriver */ }
    invokeScript(): Promise<unknown> {
        return Promise.resolve({ status: 'not_supported', reason: 'spec providers expose actions via control_bar, not script invocation' });
    }
    getDebugSnapshot(): unknown {
        return {
            cliType: this.cliType,
            spec_id: this.spec.id,
            current_state: this.latestState,
            current_modal: this.latestModal,
            exited: this.exited,
        };
    }
    getRuntimeMetadata(): unknown {
        return { runtimeId: this.spec.id, runtimeKey: this.spec.id, displayName: this.spec.name };
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
                this.statusCallback?.();
                return;
            case 'pty_data':
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
}

