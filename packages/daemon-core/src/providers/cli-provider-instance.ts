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
import { normalizeInputEnvelope, type ProviderModule, flattenContent } from './contracts.js';
import { assertTextOnlyInput } from './provider-input-support.js';
import type { ProviderInstance, ProviderState, ProviderEvent, InstanceContext, ProviderErrorReason } from './provider-instance.js';
import { ProviderCliAdapter } from '../cli-adapters/provider-cli-adapter.js';
import type { CliProviderModule } from '../cli-adapters/provider-cli-adapter.js';
import type { PtyRuntimeMetadata, PtyTransportFactory } from '../cli-adapters/pty-transport.js';
import { StatusMonitor } from './status-monitor.js';
import { ChatHistoryWriter, readChatHistory } from '../config/chat-history.js';
import { LOG } from '../logging/logger.js';
import type { ChatMessage } from '../types.js';
import { buildPersistedProviderEffectMessage, normalizeProviderEffects } from './control-effects.js';
import { formatAutoApprovalMessage, pickApprovalButton } from './approval-utils.js';
import { getCliScriptCommand, parseCliScriptResult } from './cli-script-results.js';
import { mergeProviderPatchState, resolveProviderStateSurface } from './provider-patch-state.js';
import { normalizeProviderSessionId } from './provider-session-id.js';
import { buildChatMessage, buildRuntimeSystemChatMessage, normalizeChatMessages } from './chat-message-normalization.js';

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

export function getForcedNewSessionScriptName(
    provider: ProviderModule | undefined,
    launchMode: 'new' | 'resume' | 'manual',
): string | null {
    if (!provider || launchMode !== 'new') return null;
    const resume = provider.resume;
    if (!resume?.supported) return null;
    if (Array.isArray(resume.newSessionArgs) && resume.newSessionArgs.length > 0) return null;

    const controls = Array.isArray((provider as any).controls) ? (provider as any).controls : [];
    for (const control of controls) {
        if (control?.type !== 'action') continue;
        if (typeof control?.confirmTitle === 'string' && control.confirmTitle.trim()) continue;
        if (typeof control?.confirmMessage === 'string' && control.confirmMessage.trim()) continue;
        if (typeof control?.confirmLabel === 'string' && control.confirmLabel.trim()) continue;
        const invokeScript = typeof control?.invokeScript === 'string' ? control.invokeScript.trim() : '';
        if (!invokeScript) continue;
        const controlId = typeof control?.id === 'string' ? control.id.trim() : '';
        if (controlId === 'new_session' || /^new.?session$/i.test(invokeScript)) {
            return invokeScript;
        }
    }

    return null;
}

export async function waitForCliAdapterReady(
    adapter: { isReady?: () => boolean; getStatus?: () => { status?: string } },
    options?: { timeoutMs?: number; pollMs?: number },
): Promise<void> {
    const timeoutMs = Math.max(100, options?.timeoutMs ?? 15_000);
    const pollMs = Math.max(10, options?.pollMs ?? 50);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (adapter?.isReady?.()) return;
        const status = adapter?.getStatus?.()?.status;
        if (status === 'stopped') {
            throw new Error('CLI runtime stopped before it became ready');
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    throw new Error(`CLI runtime did not become ready within ${timeoutMs}ms`);
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
    private controlValues: Record<string, string | number | boolean> = {};
    private summaryMetadata: unknown = undefined;
    private appliedEffectKeys = new Set<string>();
    private historyWriter: ChatHistoryWriter;
    private runtimeMessages: Array<{ key: string; message: ChatMessage }> = [];
    readonly instanceId: string;
    private suppressIdleHistoryReplay = false;
    private errorMessage: string | undefined = undefined;
    private errorReason: ProviderErrorReason | undefined = undefined;

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
        this.adapter = new ProviderCliAdapter(provider as CliProviderModule, workingDir, cliArgs, transportFactory);
        this.monitor = new StatusMonitor();
        this.historyWriter = new ChatHistoryWriter();
    }

 // ─── Lifecycle ─────────────────────────────────

    async init(context: InstanceContext): Promise<void> {
        this.context = context;
        this.settings = context.settings || {};
        this.adapter.updateRuntimeSettings?.(this.settings);
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
        await this.enforceFreshSessionLaunchIfNeeded();
        this.maybeAppendRuntimeRecoveryMessage(this.adapter.getRuntimeMetadata());
        if (this.providerSessionId) {
            this.historyWriter.compactHistorySession(this.type, this.providerSessionId);
            const restoredHistory = readChatHistory(this.type, 0, 200, this.providerSessionId);
            this.historyWriter.seedSessionHistory(
                this.type,
                restoredHistory.messages,
                this.providerSessionId,
                this.instanceId,
            );
            this.suppressIdleHistoryReplay = restoredHistory.messages.length > 0;
            if (restoredHistory.messages.length > 0) {
                this.adapter.seedCommittedMessages(
                    restoredHistory.messages.map((message) => ({
                        role: message.role,
                        content: message.content,
                        timestamp: message.receivedAt,
                        receivedAt: message.receivedAt,
                        kind: message.kind,
                        senderName: message.senderName,
                    })),
                );
            }
        }
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
        if (this.type === 'hermes-cli' && this.launchMode === 'new') return;

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
                    query: 'select id from threads where cwd in ({dirs}) and updated_at >= ? and archived = 0 order by updated_at desc limit 1',
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
        let parsedStatus: any = null;
        let parseErrorMessage: string | undefined;
        if (typeof this.adapter.getScriptParsedStatus === 'function') {
            try {
                parsedStatus = this.adapter.getScriptParsedStatus() || null;
                this.errorMessage = undefined;
                this.errorReason = undefined;
            } catch (error: any) {
                parseErrorMessage = error?.message || String(error);
                this.errorMessage = parseErrorMessage;
                this.errorReason = 'parse_error';
            }
        } else {
            this.errorMessage = undefined;
            this.errorReason = undefined;
        }
        const autoApproveActive = adapterStatus.status === 'waiting_approval' && this.shouldAutoApprove();
        const visibleStatus = parseErrorMessage
            ? 'error'
            : (autoApproveActive ? 'generating' : adapterStatus.status);
        const parsedProviderSessionId = normalizeProviderSessionId(
            this.type,
            typeof parsedStatus?.providerSessionId === 'string' ? parsedStatus.providerSessionId : '',
        );
        if (parsedProviderSessionId) {
            this.promoteProviderSessionId(parsedProviderSessionId);
        }
        const runtime = this.adapter.getRuntimeMetadata();
        this.maybeAppendRuntimeRecoveryMessage(runtime);
        let parsedMessages = Array.isArray(parsedStatus?.messages)
            ? parsedStatus.messages
            : (parseErrorMessage
                ? normalizeChatMessages(Array.isArray(adapterStatus.messages) ? adapterStatus.messages as any : [])
                : []);
        const historyMessageCount = Number.isFinite(parsedStatus?.historyMessageCount)
            ? Math.max(0, Number(parsedStatus.historyMessageCount))
            : null;
        if (historyMessageCount !== null) {
            parsedMessages = historyMessageCount > 0
                ? parsedMessages.slice(-historyMessageCount)
                : [];
        }
        const mergedMessages = this.mergeConversationMessages(parsedMessages);

        const dirName = this.workingDir.split('/').filter(Boolean).pop() || 'session';

        if (parsedMessages.length > 0) {
            const shouldSkipReplayPersist =
                this.suppressIdleHistoryReplay
                && adapterStatus.status === 'idle'
                && parsedStatus?.status === 'idle';
            let messagesToSave = parsedMessages;
            if ((parsedStatus?.status === 'generating' || parsedStatus?.status === 'long_generating')) {
                const lastIdx = messagesToSave.length - 1;
                if (lastIdx >= 0 && messagesToSave[lastIdx]?.role === 'assistant') {
                    messagesToSave = messagesToSave.slice(0, lastIdx);
                }
            }
            if (!shouldSkipReplayPersist && messagesToSave.length > 0) {
                this.historyWriter.appendNewMessages(
                    this.type,
                    messagesToSave,
                    parsedStatus?.title || dirName,
                    this.instanceId,
                    this.providerSessionId,
                );
            }
        }

        this.applyProviderResponse(parsedStatus, { phase: 'immediate' });
        const surface = resolveProviderStateSurface({
            summaryMetadata: this.summaryMetadata as any,
            controlValues: this.controlValues,
        });

        return {
            type: this.type,
            name: this.provider.name,
            category: 'cli',
            status: visibleStatus,
            mode: this.presentationMode,
            activeChat: {
                id: `${this.type}_${this.workingDir}`,
                title: parsedStatus?.title || dirName,
                status: parseErrorMessage
                    ? 'error'
                    : autoApproveActive && parsedStatus?.status === 'waiting_approval'
                    ? 'generating'
                    : (parsedStatus?.status || visibleStatus),
                messages: mergedMessages,
                activeModal: autoApproveActive ? null : (parsedStatus?.activeModal ?? adapterStatus.activeModal),
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
                lifecycle: runtime.lifecycle ?? null,
                surfaceKind: runtime.surfaceKind,
                writeOwner: runtime.writeOwner || null,
                attachedClients: runtime.attachedClients || [],
                restoredFromStorage: runtime.restoredFromStorage === true,
                recoveryState: runtime.recoveryState ?? null,
            } : undefined,
            resume: this.provider.resume,
            controlValues: surface.controlValues,
            providerControls: this.provider.controls,
            summaryMetadata: surface.summaryMetadata as any,
            errorMessage: this.errorMessage,
            errorReason: this.errorReason,
        };
    }

    setPresentationMode(mode: 'terminal' | 'chat'): void {
        if (this.presentationMode === mode) return;
        this.presentationMode = mode;
    }

    getPresentationMode(): 'terminal' | 'chat' {
        return this.presentationMode;
    }

    updateSettings(newSettings: Record<string, any>): void {
        this.settings = { ...newSettings };
        this.adapter.updateRuntimeSettings?.(this.settings);
        this.monitor.updateConfig({
            approvalAlert: this.settings.approvalAlert !== false,
            longGeneratingAlert: this.settings.longGeneratingAlert !== false,
            longGeneratingThresholdSec: this.settings.longGeneratingThresholdSec || 180,
        });
    }

    onEvent(event: string, data?: any): void {
        if (event === 'send_message') {
            const input = normalizeInputEnvelope(data);
            assertTextOnlyInput(this.provider, input);
            if (input.textFallback) {
                void this.adapter.sendMessage(input.textFallback).catch((e: any) => {
                    LOG.warn('CLI', `[${this.type}] send_message failed: ${e?.message || e}`);
                });
            }
        } else if (event === 'server_connected' && data?.serverConn) {
            this.adapter.setServerConn(data.serverConn);
        } else if (event === 'resolve_action' && data) {
            void this.adapter.resolveAction(data).catch((e: any) => {
                LOG.warn('CLI', `[${this.type}] resolve_action failed: ${e?.message || e}`);
            });
        } else if (event === 'provider_state_patch' && data && typeof data === 'object') {
            this.applyProviderResponse(data, { phase: 'immediate' });
        }
    }

    dispose(): void {
        this.adapter.shutdown();
        this.monitor.reset();
        this.appliedEffectKeys.clear();
    }

    private completedDebounceTimer: NodeJS.Timeout | null = null;
    private completedDebouncePending: { chatTitle: string; duration: number; timestamp: number } | null = null;

    private async enforceFreshSessionLaunchIfNeeded(): Promise<void> {
        const scriptName = getForcedNewSessionScriptName(this.provider, this.launchMode);
        if (!scriptName) return;

        LOG.info('CLI', `[${this.type}] forcing fresh session launch via script: ${scriptName}`);
        await waitForCliAdapterReady(this.adapter);
        const raw = await this.adapter.invokeScript(scriptName, {});
        const parsed = parseCliScriptResult(raw);
        if (!parsed.success) {
            throw new Error(parsed.payload?.error || `Failed to invoke fresh-session script '${scriptName}'`);
        }

        const cliCommand = getCliScriptCommand(parsed.payload);
        if (cliCommand?.type === 'send_message' && cliCommand.text) {
            await this.adapter.sendMessage(cliCommand.text);
        } else if (cliCommand?.type === 'pty_write' && cliCommand.text) {
            this.adapter.writeRaw(cliCommand.text + '\r');
        }

        this.applyProviderResponse(parsed.payload, { phase: 'immediate' });
    }

    private detectStatusTransition(): void {
        const now = Date.now();
        const adapterStatus = this.adapter.getStatus();
        const parsedStatus = this.adapter.getScriptParsedStatus?.() || null;
        const rawStatus = adapterStatus.status;
        const autoApproveActive = rawStatus === 'waiting_approval' && this.shouldAutoApprove();
        if (autoApproveActive) {
            const { index: buttonIndex, label: buttonLabel } = pickApprovalButton(adapterStatus.activeModal?.buttons, this.provider);
            this.recordAutoApproval(adapterStatus.activeModal?.message, buttonLabel, now);
            setTimeout(() => {
                this.adapter.resolveModal(buttonIndex);
            }, 0);
        }
        const newStatus = autoApproveActive ? 'generating' : rawStatus;
        const dirName = this.workingDir.split('/').filter(Boolean).pop() || 'session';
        const chatTitle = `${this.provider.name} · ${dirName}`;
        const partial = this.adapter.getPartialResponse();
        const progressFingerprint = newStatus === 'generating'
            ? `${partial || ''}::${adapterStatus.messages.at(-1)?.content || ''}`.slice(-2000)
            : undefined;

        const previousStatus = this.lastStatus;
        if (newStatus !== this.lastStatus) {
            LOG.info('CLI', `[${this.type}] status: ${this.lastStatus} → ${newStatus}`);
            if (this.lastStatus === 'idle' && newStatus === 'generating') {
                this.suppressIdleHistoryReplay = false;
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
                this.suppressIdleHistoryReplay = false;
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

        this.applyProviderResponse(parsedStatus, {
            phase: (newStatus === 'idle' && (previousStatus === 'generating' || previousStatus === 'waiting_approval'))
                ? 'turn_completed'
                : 'immediate',
        });

 // Monitor check (cooldown based notification, IDE/CLI common)
        const agentKey = `${this.type}:cli`;
        const monitorEvents = this.monitor.check(agentKey, newStatus, now, progressFingerprint);
        for (const me of monitorEvents) {
            this.pushEvent({ event: me.type, agentKey: me.agentKey, message: me.message, elapsedSec: me.elapsedSec, timestamp: me.timestamp });
        }
    }

    private pushEvent(event: ProviderEvent): void {
        this.events.push(event);
    }

    private flushEvents(): ProviderEvent[] {
        const events = [...this.events];
        this.events = [];
        return events;
    }

    private applyProviderResponse(data: any, options: { phase: 'immediate' | 'turn_completed' }): void {
        if (!data || typeof data !== 'object') return;

        const patchedProviderSessionId = normalizeProviderSessionId(
            this.type,
            typeof data.providerSessionId === 'string' ? data.providerSessionId : '',
        );
        if (patchedProviderSessionId) {
            this.promoteProviderSessionId(patchedProviderSessionId);
        }

        if (data.sessionEvent === 'new_session') {
            this.runtimeMessages = [];
            this.suppressIdleHistoryReplay = false;
            this.adapter.clearHistory();
        }

        const patchedState = mergeProviderPatchState({
            providerControls: this.provider.controls,
            data,
            currentControlValues: this.controlValues,
            currentSummaryMetadata: this.summaryMetadata,
        });
        this.controlValues = patchedState.controlValues;
        this.summaryMetadata = patchedState.summaryMetadata;

        const effects = normalizeProviderEffects(data);
        for (const effect of effects) {
            const effectWhen = effect.when || 'immediate';
            if (effectWhen === 'turn_completed' && options.phase !== 'turn_completed') continue;
            if (effectWhen === 'immediate' && options.phase === 'turn_completed') continue;

            const effectKey = this.getEffectDedupKey(effect);
            if (this.appliedEffectKeys.has(effectKey)) continue;
            this.appliedEffectKeys.add(effectKey);

            if (effect.persist !== false) {
                const persistedMessage = buildPersistedProviderEffectMessage(effect);
                if (persistedMessage) this.appendRuntimeMessage(persistedMessage, effectKey);
            }

            if (effect.type === 'message' && effect.message) {
                const content = typeof effect.message.content === 'string'
                    ? effect.message.content
                    : JSON.stringify(effect.message.content);
                this.pushEvent({
                    event: 'provider:message',
                    timestamp: Date.now(),
                    content,
                    role: effect.message.role || 'system',
                    kind: effect.message.kind,
                    senderName: effect.message.senderName,
                });
            } else if (effect.type === 'toast' && effect.toast) {
                this.pushEvent({
                    event: 'provider:toast',
                    effectId: effect.id || effectKey,
                    timestamp: Date.now(),
                    message: effect.toast.message,
                    level: effect.toast.level || 'info',
                });
            } else if (effect.type === 'notification' && effect.notification) {
                this.pushEvent({
                    event: 'provider:notification',
                    effectId: effect.id || effectKey,
                    timestamp: Date.now(),
                    title: effect.notification.title,
                    message: effect.notification.body,
                    content: typeof effect.notification.bubbleContent === 'string'
                        ? effect.notification.bubbleContent
                        : effect.notification.body,
                    level: effect.notification.level || 'info',
                    channels: effect.notification.channels || ['toast'],
                    preferenceKey: effect.notification.preferenceKey,
                });
            }
        }

        if (this.appliedEffectKeys.size > 200) {
            this.appliedEffectKeys = new Set(Array.from(this.appliedEffectKeys).slice(-100));
        }
    }

    private getEffectDedupKey(effect: { id?: string; type: string; message?: { content?: unknown }; toast?: { message?: string }; notification?: { title?: string; body?: string } }): string {
        if (effect.id) return `provider_effect:${effect.id}`;
        if (effect.type === 'message') {
            const content = typeof effect.message?.content === 'string'
                ? effect.message.content
                : JSON.stringify(effect.message?.content || '');
            return `provider_effect:message:${content}`;
        }
        if (effect.type === 'notification') {
            return `provider_effect:notification:${effect.notification?.title || ''}:${effect.notification?.body || ''}`;
        }
        return `provider_effect:toast:${effect.toast?.message || ''}`;
    }

    private getPersistedEffectContent(effect: { type: string; message?: { content?: unknown }; toast?: { message?: string }; notification?: { title?: string; body?: string; bubbleContent?: unknown } }): string | null {
        if (effect.type === 'message') {
            return typeof effect.message?.content === 'string'
                ? effect.message.content
                : JSON.stringify(effect.message?.content || '');
        }
        if (effect.type === 'toast') {
            return effect.toast?.message || null;
        }
        if (effect.type === 'notification') {
            if (typeof effect.notification?.bubbleContent === 'string') return effect.notification.bubbleContent;
            if (typeof effect.notification?.title === 'string' && effect.notification.title.trim()) {
                return `${effect.notification.title}\n${effect.notification.body || ''}`.trim();
            }
            return effect.notification?.body || null;
        }
        return null;
    }

 // ─── Adapter access (backward compat) ──────────────────

    getAdapter(): ProviderCliAdapter {
        return this.adapter;
    }

    get cliType(): string { return this.type; }
    get cliName(): string { return this.provider.name; }

    private shouldAutoApprove(): boolean {
        return this.settings.autoApprove !== false;
    }

    private recordAutoApproval(modalMessage?: string, buttonLabel?: string, now = Date.now()): void {
        this.appendRuntimeSystemMessage(
            formatAutoApprovalMessage(modalMessage, buttonLabel),
            `auto_approval:${now}:${buttonLabel || 'approve'}`,
            now,
        );
    }

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

    private maybeAppendRuntimeRecoveryMessage(runtime: PtyRuntimeMetadata | null): void {
        if (!runtime?.restoredFromStorage || !runtime.runtimeId) return;

        const recoveryState = String(runtime.recoveryState || '').trim();
        if (!recoveryState) return;

        let content = '';
        if (recoveryState === 'auto_resumed') {
            content = 'Session host restored this CLI after restart and reattached it from a saved snapshot.';
        } else if (recoveryState === 'resume_failed') {
            const errorSuffix = runtime.recoveryError ? ` Resume failed: ${runtime.recoveryError}` : '';
            content = `Session host found this CLI after restart, but automatic resume failed.${errorSuffix}`;
        } else if (recoveryState === 'host_restart_interrupted') {
            content = 'Session host found this CLI in interrupted state after restart and is attempting to resume it.';
        } else if (recoveryState === 'orphan_snapshot') {
            content = 'Session host restored the last snapshot for this CLI, but the original runtime was not resumed automatically.';
        } else {
            content = `Session host restored this CLI after restart (${recoveryState}).`;
        }

        this.appendRuntimeSystemMessage(
            content,
            `runtime_recovery:${runtime.runtimeId}:${recoveryState}`,
        );
    }

    private appendRuntimeSystemMessage(content: string, dedupKey: string, receivedAt = Date.now()): void {
        this.appendRuntimeMessage(buildRuntimeSystemChatMessage({
            content,
            receivedAt,
            timestamp: receivedAt,
        }), dedupKey);
    }

    private appendRuntimeMessage(message: ChatMessage, dedupKey: string): void {
        const normalizedMessage = buildChatMessage({
            ...message,
            receivedAt: typeof message.receivedAt === 'number' ? message.receivedAt : (message.timestamp || Date.now()),
            timestamp: typeof message.timestamp === 'number' ? message.timestamp : (message.receivedAt || Date.now()),
        } as ChatMessage);
        const normalizedContent = typeof normalizedMessage.content === 'string'
            ? normalizedMessage.content.trim()
            : flattenContent(normalizedMessage.content).trim();
        if (!normalizedContent && (!Array.isArray(normalizedMessage.content) || normalizedMessage.content.length === 0)) return;
        if (this.runtimeMessages.some((entry) => entry.key === dedupKey)) return;

        this.runtimeMessages.push({
            key: dedupKey,
            message: normalizedMessage,
        });

        if (normalizedContent) {
            this.historyWriter.appendNewMessages(
                this.type,
                [{
                    role: normalizedMessage.role,
                    senderName: normalizedMessage.senderName,
                    kind: normalizedMessage.kind,
                    content: normalizedContent,
                    receivedAt: normalizedMessage.receivedAt || normalizedMessage.timestamp,
                    historyDedupKey: dedupKey,
                }],
                this.adapter.getScriptParsedStatus?.()?.title || this.workingDir.split('/').filter(Boolean).pop() || 'session',
                this.instanceId,
                this.providerSessionId,
            );
        }
    }

    private mergeConversationMessages(parsedMessages: any[]): ChatMessage[] {
        if (this.runtimeMessages.length === 0) return normalizeChatMessages(parsedMessages);

        return normalizeChatMessages([...parsedMessages, ...this.runtimeMessages.map((entry) => entry.message)]
            .map((message, index) => ({ message, index }))
            .sort((a, b) => {
                const aTime = a.message.receivedAt || a.message.timestamp || 0;
                const bTime = b.message.receivedAt || b.message.timestamp || 0;
                if (aTime !== bTime) return aTime - bTime;
                return a.index - b.index;
            })
            .map((entry) => entry.message));
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
        this.historyWriter.writeSessionStart(this.type, nextSessionId, this.workingDir, this.instanceId);
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
