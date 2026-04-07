/**
 * CliProviderInstance — Runtime instance for CLI Provider
 *
 * Lifecycle layer on top of ProviderCliAdapter.
 * collectCliData() + status transition logic from daemon-status.ts moved here.
 */

import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { createRequire } from 'node:module';
import type { ProviderModule } from './contracts.js';
import type { ProviderInstance, ProviderState, ProviderEvent, InstanceContext } from './provider-instance.js';
import { ProviderCliAdapter } from '../cli-adapters/provider-cli-adapter.js';
import type { CliProviderModule } from '../cli-adapters/provider-cli-adapter.js';
import type { PtyTransportFactory } from '../cli-adapters/pty-transport.js';
import { StatusMonitor } from './status-monitor.js';
import { ChatHistoryWriter } from '../config/chat-history.js';
import { LOG } from '../logging/logger.js';
import type { ChatMessage } from '../types.js';

let CachedDatabaseSync: (new (path: string, options?: { readOnly?: boolean }) => {
    prepare(sql: string): { get(...params: Array<string | number>): unknown };
    close(): void;
}) | null = null;

function getDatabaseSync() {
    if (CachedDatabaseSync) return CachedDatabaseSync;
    const requireFn = typeof require === 'function'
        ? require
        : createRequire(path.join(process.cwd(), '__adhdev_sqlite_loader__.js'));
    const sqliteModule = requireFn(`node:${'sqlite'}`) as {
        DatabaseSync: typeof CachedDatabaseSync;
    };
    CachedDatabaseSync = sqliteModule.DatabaseSync;
    if (!CachedDatabaseSync) {
        throw new Error('node:sqlite DatabaseSync unavailable');
    }
    return CachedDatabaseSync;
}

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
    private runtimeMessages: Array<{ key: string; message: ChatMessage }> = [];
    readonly instanceId: string;

    private presentationMode: 'terminal' | 'chat';
    private providerSessionId?: string;
    private launchMode: 'new' | 'resume' | 'manual';
    private readonly startedAt = Date.now();
    private onProviderSessionResolved?: (info: {
        instanceId: string;
        providerType: string;
        providerName: string;
        workspace: string;
        providerSessionId: string;
        previousProviderSessionId?: string;
    }) => void;

    constructor(
        private provider: ProviderModule,
        private workingDir: string,
        private cliArgs: string[] = [],
        instanceId?: string,
        transportFactory?: PtyTransportFactory,
        options?: {
            providerSessionId?: string;
            launchMode?: 'new' | 'resume' | 'manual';
            onProviderSessionResolved?: (info: {
                instanceId: string;
                providerType: string;
                providerName: string;
                workspace: string;
                providerSessionId: string;
                previousProviderSessionId?: string;
            }) => void;
        },
    ) {
        this.type = provider.type;
        this.instanceId = instanceId || crypto.randomUUID();
        this.presentationMode = 'chat';
        this.providerSessionId = options?.providerSessionId;
        this.launchMode = options?.launchMode || 'new';
        this.onProviderSessionResolved = options?.onProviderSessionResolved;
        this.adapter = new ProviderCliAdapter(provider as any as CliProviderModule, workingDir, cliArgs, transportFactory);
        this.monitor = new StatusMonitor();
        this.historyWriter = new ChatHistoryWriter();
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
        if (this.providerSessionId && this.launchMode === 'resume') {
            const resumedAt = Date.now();
            this.historyWriter.appendSystemMarker(
                this.type,
                `Resumed saved session at ${this.formatMarkerTimestamp(resumedAt)}`,
                {
                    instanceId: this.instanceId,
                    historySessionId: this.providerSessionId,
                    dedupKey: `resume:${this.providerSessionId}:${resumedAt}`,
                    receivedAt: resumedAt,
                },
            );
        }
    }

    async onTick(): Promise<void> {
        if (this.providerSessionId) return;

        let probedSessionId: string | null = null;

        // Prefer declarative probe from provider.json schema
        const probeConfig = this.provider.sessionProbe;
        if (probeConfig) {
            probedSessionId = this.probeSessionIdFromConfig(probeConfig);
        } else {
            // Legacy hardcoded probes (backward compat until providers migrate)
            if (this.type === 'opencode-cli') {
                probedSessionId = this.probeSessionIdFromConfig({
                    dbPath: '~/.local/share/opencode/opencode.db',
                    query: 'select id from session where directory in ({dirs}) and time_created >= ? and time_archived is null order by time_updated desc limit 1',
                    timestampFormat: 'unix_ms',
                });
            } else if (this.type === 'codex-cli') {
                probedSessionId = this.probeSessionIdFromConfig({
                    dbPath: '~/.codex/state_5.sqlite',
                    query: 'select id from threads where cwd in ({dirs}) and created_at >= ? and archived = 0 order by created_at desc limit 1',
                    timestampFormat: 'unix_s',
                });
            } else if (this.type === 'goose-cli') {
                probedSessionId = this.probeSessionIdFromConfig({
                    dbPath: '~/.local/share/goose/sessions/sessions.db',
                    query: 'select id from sessions where working_dir in ({dirs}) and created_at >= ? order by updated_at desc limit 1',
                    timestampFormat: 'iso',
                });
            }
        }

        if (probedSessionId) {
            this.promoteProviderSessionId(probedSessionId);
        }
    }

    /**
     * Generic session ID probe using declarative ProviderSessionProbe config.
     * Replaces the previously duplicated probeOpenCode/Codex/Goose functions.
     */
    private probeSessionIdFromConfig(probe: {
        dbPath: string;
        query: string;
        timestampFormat?: 'unix_ms' | 'unix_s' | 'iso';
    }): string | null {
        const resolvedDbPath = probe.dbPath.replace(/^~/, os.homedir());
        if (!fs.existsSync(resolvedDbPath)) return null;

        const directories = this.getProbeDirectories();
        const minCreatedAt = Math.max(0, this.startedAt - 60_000);
        const tsFormat = probe.timestampFormat || 'unix_ms';

        let timestampParam: string | number;
        if (tsFormat === 'unix_s') {
            timestampParam = Math.floor(minCreatedAt / 1000);
        } else if (tsFormat === 'iso') {
            timestampParam = new Date(minCreatedAt).toISOString().slice(0, 19).replace('T', ' ');
        } else {
            timestampParam = minCreatedAt;
        }

        // Build query: replace {dirs} with SQL placeholder list
        const placeholders = this.buildSqlPlaceholderList(directories.length);
        const query = probe.query.replace('{dirs}', placeholders);

        try {
            return this.querySqliteText(resolvedDbPath, query, [...directories, timestampParam]);
        } catch {
            return null;
        }
    }

    getState(): ProviderState {
        const adapterStatus = this.adapter.getStatus();
        const parsedStatus = this.adapter.getScriptParsedStatus?.() || null;
        const parsedProviderSessionId = typeof parsedStatus?.providerSessionId === 'string'
            ? parsedStatus.providerSessionId.trim()
            : '';
        if (parsedProviderSessionId) {
            this.promoteProviderSessionId(parsedProviderSessionId);
        }
        const runtime = this.adapter.getRuntimeMetadata();
        const parsedMessages = Array.isArray(parsedStatus?.messages) ? parsedStatus.messages : [];
        const mergedMessages = this.mergeConversationMessages(parsedMessages);

        const dirName = this.workingDir.split('/').filter(Boolean).pop() || 'session';

        if (parsedMessages.length > 0) {
            let messagesToSave = parsedMessages;
            if ((parsedStatus?.status === 'generating' || parsedStatus?.status === 'long_generating')) {
                const lastIdx = messagesToSave.length - 1;
                if (lastIdx >= 0 && messagesToSave[lastIdx]?.role === 'assistant') {
                    messagesToSave = messagesToSave.slice(0, lastIdx);
                }
            }
            if (messagesToSave.length > 0) {
                this.historyWriter.appendNewMessages(
                    this.type,
                    messagesToSave,
                    parsedStatus?.title || dirName,
                    this.instanceId,
                    this.providerSessionId,
                );
            }
        }

        return {
            type: this.type,
            name: this.provider.name,
            category: 'cli',
            status: adapterStatus.status,
            mode: this.presentationMode,
            activeChat: {
                id: `${this.type}_${this.workingDir}`,
                title: parsedStatus?.title || dirName,
                status: parsedStatus?.status || adapterStatus.status,
                messages: mergedMessages,
                activeModal: parsedStatus?.activeModal ?? adapterStatus.activeModal,
                inputContent: '',
            },
            workspace: this.workingDir,
            instanceId: this.instanceId,
            providerSessionId: this.providerSessionId,
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

    setPresentationMode(mode: 'terminal' | 'chat'): void {
        if (this.presentationMode === mode) return;
        this.presentationMode = mode;
    }

    getPresentationMode(): 'terminal' | 'chat' {
        return this.presentationMode;
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
                    this.appendRuntimeSystemMessage(
                        this.formatApprovalRequestMessage(modal?.message, modal?.buttons),
                        `approval_request:${now}`,
                        now,
                    );
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

    recordApprovalSelection(buttonText: string): void {
        const cleanButton = String(buttonText || '').trim();
        if (!cleanButton) return;
        const now = Date.now();
        this.appendRuntimeSystemMessage(
            `Approval selected: ${cleanButton}`,
            `approval_selection:${now}:${cleanButton}`,
            now,
        );
    }

    private formatMarkerTimestamp(timestamp: number): string {
        const date = new Date(timestamp);
        const pad = (value: number) => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    private appendRuntimeSystemMessage(content: string, dedupKey: string, receivedAt = Date.now()): void {
        const normalizedContent = String(content || '').trim();
        if (!normalizedContent) return;
        if (this.runtimeMessages.some((entry) => entry.key === dedupKey)) return;

        this.runtimeMessages.push({
            key: dedupKey,
            message: {
                role: 'system',
                senderName: 'System',
                content: normalizedContent,
                receivedAt,
                timestamp: receivedAt,
            },
        });
        if (this.runtimeMessages.length > 50) {
            this.runtimeMessages = this.runtimeMessages.slice(-50);
        }

        this.historyWriter.appendNewMessages(
            this.type,
            [{
                role: 'system',
                senderName: 'System',
                content: normalizedContent,
                receivedAt,
                historyDedupKey: dedupKey,
            }],
            this.adapter.getScriptParsedStatus?.()?.title || this.workingDir.split('/').filter(Boolean).pop() || 'session',
            this.instanceId,
            this.providerSessionId,
        );
    }

    private mergeConversationMessages(parsedMessages: any[]): ChatMessage[] {
        if (this.runtimeMessages.length === 0) return parsedMessages;

        return [...parsedMessages, ...this.runtimeMessages.map((entry) => entry.message)]
            .map((message, index) => ({ message, index }))
            .sort((a, b) => {
                const aTime = a.message.receivedAt || a.message.timestamp || 0;
                const bTime = b.message.receivedAt || b.message.timestamp || 0;
                if (aTime !== bTime) return aTime - bTime;
                return a.index - b.index;
            })
            .map((entry) => entry.message);
    }

    private formatApprovalRequestMessage(modalMessage?: string, buttons?: string[]): string {
        const lines = ['Approval requested'];
        const cleanMessage = String(modalMessage || '').trim();
        if (cleanMessage) lines.push(cleanMessage);
        const labels = (buttons || []).map((button) => String(button || '').trim()).filter(Boolean);
        if (labels.length > 0) {
            lines.push(labels.map((label) => `[${label}]`).join(' '));
        }
        return lines.join('\n');
    }

    private promoteProviderSessionId(sessionId: string): void {
        const nextSessionId = String(sessionId || '').trim();
        if (!nextSessionId || nextSessionId === this.providerSessionId) return;

        const previousHistorySessionId = this.providerSessionId || this.instanceId;
        const previousProviderSessionId = this.providerSessionId;
        this.providerSessionId = nextSessionId;
        this.historyWriter.promoteHistorySession(this.type, previousHistorySessionId, nextSessionId);
        this.adapter.updateRuntimeMeta({ providerSessionId: nextSessionId });
        this.onProviderSessionResolved?.({
            instanceId: this.instanceId,
            providerType: this.type,
            providerName: this.provider.name,
            workspace: this.workingDir,
            providerSessionId: nextSessionId,
            previousProviderSessionId,
        });
        LOG.info('CLI', `[${this.type}] discovered provider session id: ${nextSessionId}`);
    }


    private getProbeDirectories(): string[] {
        const dirs = new Set<string>();
        const addDir = (value: string | null | undefined) => {
            const normalized = typeof value === 'string' ? value.trim() : '';
            if (normalized) dirs.add(normalized);
        };

        addDir(this.workingDir);
        try {
            addDir(fs.realpathSync.native(this.workingDir));
        } catch {
            // noop
        }

        return Array.from(dirs);
    }

    private buildSqlPlaceholderList(count: number): string {
        return Array.from({ length: count }, () => '?').join(', ');
    }

    private querySqliteText(dbPath: string, query: string, params: Array<string | number>): string | null {
        let db: {
            prepare(sql: string): { get(...values: Array<string | number>): unknown };
            close(): void;
        } | null = null;
        try {
            const DatabaseSync = getDatabaseSync();
            db = new DatabaseSync(dbPath, { readOnly: true });
            const row = db.prepare(query).get(...params) as { id?: unknown } | undefined;
            const sessionId = typeof row?.id === 'string' ? row.id.trim() : '';
            return sessionId || null;
        } catch {
            return null;
        } finally {
            try {
                db?.close();
            } catch {
                // noop
            }
        }
    }
}
