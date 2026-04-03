/**
 * CliProviderInstance — Runtime instance for CLI Provider
 *
 * Lifecycle layer on top of ProviderCliAdapter.
 * collectCliData() + status transition logic from daemon-status.ts moved here.
 */

import * as path from 'path';
import * as crypto from 'crypto';
import type { ProviderModule, ProviderLaunchMode, ProviderLaunchOption } from './contracts.js';
import type { ProviderInstance, ProviderState, ProviderEvent, InstanceContext } from './provider-instance.js';
import { ProviderCliAdapter } from '../cli-adapters/provider-cli-adapter.js';
import type { CliProviderModule } from '../cli-adapters/provider-cli-adapter.js';
import type { PtyTransportFactory } from '../cli-adapters/pty-transport.js';
import { StatusMonitor } from './status-monitor.js';
import { ChatHistoryWriter } from '../config/chat-history.js';
import { LOG } from '../logging/logger.js';

export class CliProviderInstance implements ProviderInstance {
    readonly type: string;
    readonly category = 'cli' as const;

    private adapter: ProviderCliAdapter;
    private context: InstanceContext | null = null;
    private events: ProviderEvent[] = [];
    private lastStatus: string = 'starting';
    private generatingStartedAt: number = 0;
    private settings: Record<string, any> = {};
    private monitor: StatusMonitor;
    private generatingDebounceTimer: NodeJS.Timeout | null = null;
    private generatingDebouncePending: { chatTitle: string; timestamp: number } | null = null;
    private lastApprovalEventAt = 0;
    private historyWriter: ChatHistoryWriter;
    readonly instanceId: string;

    private launchMode: ProviderLaunchMode | null;
    private resolvedOutputFormat: 'terminal' | 'stream-json';

    constructor(
        private provider: ProviderModule,
        private workingDir: string,
        private cliArgs: string[] = [],
        instanceId?: string,
        transportFactory?: PtyTransportFactory,
        launchModeId?: string,
    ) {
        this.type = provider.type;
        this.instanceId = instanceId || crypto.randomUUID();
        this.launchMode = (launchModeId && provider.launchModes?.find(m => m.id === launchModeId)) || null;
        this.resolvedOutputFormat = this.resolveOutputFormat();
        this.adapter = new ProviderCliAdapter(provider as any as CliProviderModule, workingDir, cliArgs, transportFactory);
        this.monitor = new StatusMonitor();
        this.historyWriter = new ChatHistoryWriter();
    }

    /**
     * Determine output rendering format from:
     * 1. launchMode.outputFormat (explicit override)
     * 2. launchOptions[].outputFormatMap — check actual args for matching values
     * 3. Default: 'terminal'
     */
    private resolveOutputFormat(): 'terminal' | 'stream-json' {
        if (this.launchMode?.outputFormat) return this.launchMode.outputFormat;
        if (this.provider.launchOptions?.length) {
            for (const opt of this.provider.launchOptions) {
                if (!opt.outputFormatMap) continue;
                // Check if any cliArg matches a value with an outputFormatMap entry
                for (const [val, fmt] of Object.entries(opt.outputFormatMap)) {
                    if (this.cliArgs.includes(val)) return fmt;
                }
            }
        }
        return 'terminal';
    }

 // ─── Lifecycle ─────────────────────────────────

    async init(context: InstanceContext): Promise<void> {
        this.context = context;
        this.settings = context.settings || {};
        this.monitor.updateConfig({
            approvalAlert: this.settings.approvalAlert !== false,
            longGeneratingAlert: this.settings.longGeneratingAlert !== false,
            longGeneratingThresholdSec: this.settings.longGeneratingThresholdSec || 180,
        });

 // Server connection
        if (context.serverConn) {
            this.adapter.setServerConn(context.serverConn);
        }

 // PTY output callback
        if (context.onPtyData) {
            this.adapter.setOnPtyData(context.onPtyData);
        }

 // Emit event on status change
        this.adapter.setOnStatusChange(() => {
            this.detectStatusTransition();
        });

 // PTY spawn
        await this.adapter.spawn();
    }

    async onTick(): Promise<void> {
 // CLI is event-based so tick is unnecessary
 // Health check etc here if needed
    }

    getState(): ProviderState {
        const adapterStatus = this.adapter.getStatus();
        const runtime = this.adapter.getRuntimeMetadata();

        const dirName = this.workingDir.split('/').filter(Boolean).pop() || 'session';

        if (adapterStatus.terminalHistory?.trim()) {
            this.historyWriter.appendTerminalHistory(
                this.type,
                adapterStatus.terminalHistory,
                `${this.provider.name} · ${dirName}`,
                this.instanceId,
            );
        }

        return {
            type: this.type,
            name: this.provider.name,
            category: 'cli',
            status: adapterStatus.status,
            mode: this.resolvedOutputFormat === 'stream-json' ? 'chat' : 'terminal',
            launchMode: this.launchMode?.id,
            activeChat: {
                id: `${this.type}_${this.workingDir}`,
                title: `${this.provider.name} · ${dirName}`,
                status: adapterStatus.status,
                messages: [],
                activeModal: adapterStatus.activeModal,
                terminalHistory: adapterStatus.terminalHistory,
                inputContent: '',
            },
            workspace: this.workingDir,
            instanceId: this.instanceId,
            lastUpdated: Date.now(),
            settings: this.settings,
            pendingEvents: this.flushEvents(),
            runtime: runtime ? {
                runtimeId: runtime.runtimeId,
                runtimeKey: runtime.runtimeKey,
                displayName: runtime.displayName,
                workspaceLabel: runtime.workspaceLabel,
                writeOwner: runtime.writeOwner || null,
                attachedClients: runtime.attachedClients || [],
            } : undefined,
            resume: this.provider.resume,
            controlValues: undefined, // CLI controls not yet wired from stream
            providerControls: this.provider.controls as any,
        };
    }

    onEvent(event: string, data?: any): void {
        if (event === 'send_message' && data?.text) {
            void this.adapter.sendMessage(data.text).catch((e: any) => {
                LOG.warn('CLI', `[${this.type}] send_message failed: ${e?.message || e}`);
            });
        } else if (event === 'server_connected' && data?.serverConn) {
            this.adapter.setServerConn(data.serverConn);
        } else if (event === 'resolve_action' && data) {
            void this.adapter.resolveAction(data).catch((e: any) => {
                LOG.warn('CLI', `[${this.type}] resolve_action failed: ${e?.message || e}`);
            });
        }
    }

    dispose(): void {
        this.adapter.shutdown();
        this.monitor.reset();
    }

    private completedDebounceTimer: NodeJS.Timeout | null = null;
    private completedDebouncePending: { chatTitle: string; duration: number; timestamp: number } | null = null;

    private detectStatusTransition(): void {
        const now = Date.now();
        const adapterStatus = this.adapter.getStatus();
        const newStatus = adapterStatus.status;
        const dirName = this.workingDir.split('/').filter(Boolean).pop() || 'session';
        const chatTitle = `${this.provider.name} · ${dirName}`;
        const partial = this.adapter.getPartialResponse();
        const progressFingerprint = newStatus === 'generating'
            ? `${partial || ''}::${adapterStatus.messages.at(-1)?.content || ''}`.slice(-2000)
            : undefined;

        if (newStatus !== this.lastStatus) {
            LOG.info('CLI', `[${this.type}] status: ${this.lastStatus} → ${newStatus}`);
            if (this.lastStatus === 'idle' && newStatus === 'generating') {
                // Cancel any pending completed event (multi-step: idle→generating resume)
                if (this.completedDebouncePending) {
                    LOG.info('CLI', `[${this.type}] cancelled pending completed (resumed generating)`);
                    if (this.completedDebounceTimer) { clearTimeout(this.completedDebounceTimer); this.completedDebounceTimer = null; }
                    this.completedDebouncePending = null;
                }

                if (!this.generatingStartedAt) this.generatingStartedAt = now;
                // Defer the generating_started event — if idle comes back within 1s,
                // the whole started→completed pair was a false positive from PTY noise
                if (this.generatingDebounceTimer) clearTimeout(this.generatingDebounceTimer);
                this.generatingDebouncePending = { chatTitle, timestamp: now };
                this.generatingDebounceTimer = setTimeout(() => {
                    if (this.generatingDebouncePending) {
                        this.pushEvent({ event: 'agent:generating_started', ...this.generatingDebouncePending });
                        this.generatingDebouncePending = null;
                    }
                    this.generatingDebounceTimer = null;
                }, 1000);
            } else if (newStatus === 'waiting_approval') {
                // Flush pending generating_started if debounce still pending
                if (this.generatingDebouncePending) {
                    if (this.generatingDebounceTimer) { clearTimeout(this.generatingDebounceTimer); this.generatingDebounceTimer = null; }
                    this.pushEvent({ event: 'agent:generating_started', ...this.generatingDebouncePending });
                    this.generatingDebouncePending = null;
                }
                // Cancel any pending completed
                if (this.completedDebounceTimer) { clearTimeout(this.completedDebounceTimer); this.completedDebounceTimer = null; }
                this.completedDebouncePending = null;

                if (!this.generatingStartedAt) this.generatingStartedAt = now;
                const modal = adapterStatus.activeModal;
                LOG.info('CLI', `[${this.type}] approval modal: "${modal?.message?.slice(0, 80) ?? 'none'}"`);
                // Only push event if not already in waiting_approval (prevent flood from rapid cycles)
                const approvalCooldown = 5000;
                if (this.lastStatus !== 'waiting_approval' && (!this.lastApprovalEventAt || now - this.lastApprovalEventAt > approvalCooldown)) {
                    this.lastApprovalEventAt = now;
                    this.pushEvent({
                        event: 'agent:waiting_approval', chatTitle, timestamp: now,
                        modalMessage: modal?.message,
                        modalButtons: modal?.buttons,
                    });
                }
            } else if (newStatus === 'idle' && (this.lastStatus === 'generating' || this.lastStatus === 'waiting_approval')) {
                const duration = this.generatingStartedAt ? Math.round((now - this.generatingStartedAt) / 1000) : 0;
                // If debounce still pending (generating lasted < 1s), cancel both events
                if (this.generatingDebouncePending) {
                    LOG.info('CLI', `[${this.type}] suppressed short generating (${now - this.generatingStartedAt}ms)`);
                    if (this.generatingDebounceTimer) { clearTimeout(this.generatingDebounceTimer); this.generatingDebounceTimer = null; }
                    this.generatingDebouncePending = null;
                    this.generatingStartedAt = 0;
                } else {
                    // Debounce completed — wait 2s, if still idle then emit
                    if (this.completedDebounceTimer) clearTimeout(this.completedDebounceTimer);
                    this.completedDebouncePending = { chatTitle, duration, timestamp: now };
                    this.completedDebounceTimer = setTimeout(() => {
                        if (this.completedDebouncePending) {
                            LOG.info('CLI', `[${this.type}] completed in ${this.completedDebouncePending.duration}s`);
                            this.pushEvent({ event: 'agent:generating_completed', ...this.completedDebouncePending });
                            this.completedDebouncePending = null;
                            this.generatingStartedAt = 0;
                        }
                        this.completedDebounceTimer = null;
                    }, 2000);
                }
            } else if (newStatus === 'stopped') {
                // Cancel any pending debounce
                if (this.generatingDebounceTimer) { clearTimeout(this.generatingDebounceTimer); this.generatingDebounceTimer = null; }
                this.generatingDebouncePending = null;
                if (this.completedDebounceTimer) { clearTimeout(this.completedDebounceTimer); this.completedDebounceTimer = null; }
                this.completedDebouncePending = null;
                this.pushEvent({ event: 'agent:stopped', chatTitle, timestamp: now });
            }
            this.lastStatus = newStatus;
        }

 // Monitor check (cooldown based notification, IDE/CLI common)
        const agentKey = `${this.type}:cli`;
        const monitorEvents = this.monitor.check(agentKey, newStatus, now, progressFingerprint);
        for (const me of monitorEvents) {
            this.pushEvent({ event: me.type, agentKey: me.agentKey, message: me.message, elapsedSec: me.elapsedSec, timestamp: me.timestamp });
        }
    }

    private pushEvent(event: ProviderEvent): void {
        this.events.push(event);
 // Max 50
        if (this.events.length > 50) this.events = this.events.slice(-50);
    }

    private flushEvents(): ProviderEvent[] {
        const events = [...this.events];
        this.events = [];
        return events;
    }

 // ─── Adapter access (backward compat) ──────────────────

    getAdapter(): ProviderCliAdapter {
        return this.adapter;
    }

    get cliType(): string { return this.type; }
    get cliName(): string { return this.provider.name; }
}
