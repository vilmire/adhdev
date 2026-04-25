/**
 * DaemonCommandRouter — Unified command routing for daemon-level commands
 *
 * Unified command routing for daemon-level commands.
 *
 * Routing flow:
 *   1. Daemon-level commands (launch_ide, stop_ide, restart_ide, etc.) → handled here
 *   2. CLI/ACP commands → delegated to cliManager
 *   3. Everything else → delegated to commandHandler.handle()
 */

import { DaemonCdpManager } from '../cdp/manager.js';
import { registerExtensionProviders } from '../cdp/setup.js';
import { DaemonCommandHandler } from './handler.js';
import { DaemonCliManager } from './cli-manager.js';
import { supportsExplicitSessionResume } from './cli-manager.js';
import type { HostedCliRuntimeDescriptor } from './cli-manager.js';
import type { ProviderLoader } from '../providers/provider-loader.js';
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import { launchWithCdp, killIdeProcess, isIdeRunning } from '../launch.js';
import { loadConfig, saveConfig, updateConfig } from '../config/config.js';
import { loadState, saveState } from '../config/state-store.js';
import { resolveIdeLaunchWorkspace } from '../config/workspaces.js';
import { appendRecentActivity, getRecentActivity, markSessionSeen, dismissSessionNotification, markSessionNotificationUnread } from '../config/recent-activity.js';
import { getSavedProviderSessions } from '../config/saved-sessions.js';
import { listSavedHistorySessions } from '../config/chat-history.js';
import { detectIDEs } from '../detection/ide-detector.js';
import { SessionRegistry } from '../sessions/registry.js';
import { LOG } from '../logging/logger.js';
import { logCommand } from '../logging/command-log.js';
import type { CommandLogEntry } from '../logging/command-log.js';
import { getRecentLogs, LOG_PATH } from '../logging/logger.js';
import { createInteractionId, getRecentDebugTrace, recordDebugTrace } from '../logging/debug-trace.js';
import { getSessionHostSurfaceKind, partitionSessionHostRecords } from '../session-host/runtime-surface.js';
import { buildSessionEntries } from '../status/builders.js';
import { buildMachineInfo, buildStatusSnapshot } from '../status/snapshot.js';
import { getSessionCompletionMarker } from '../status/snapshot.js';
import { spawnDetachedDaemonUpgradeHelper } from './upgrade-helper.js';
import * as fs from 'fs';

// ─── Types ───

export interface SessionHostControlPlane {
    getDiagnostics(payload?: { includeSessions?: boolean; limit?: number }): Promise<any>;
    listSessions(): Promise<any[]>;
    stopSession(sessionId: string): Promise<any>;
    resumeSession(sessionId: string): Promise<any>;
    restartSession(sessionId: string): Promise<any>;
    sendSignal(sessionId: string, signal: string): Promise<any>;
    forceDetachClient(sessionId: string, clientId: string): Promise<any>;
    pruneDuplicateSessions(payload?: { providerType?: string; workspace?: string; dryRun?: boolean }): Promise<any>;
    acquireWrite(payload: { sessionId: string; clientId: string; ownerType: 'agent' | 'user'; force?: boolean }): Promise<any>;
    releaseWrite(payload: { sessionId: string; clientId: string }): Promise<any>;
}

export interface CommandRouterDeps {
    commandHandler: DaemonCommandHandler;
    cliManager: DaemonCliManager;
    cdpManagers: Map<string, DaemonCdpManager>;
    providerLoader: ProviderLoader;
    instanceManager: ProviderInstanceManager;
    /** Reference to detected IDEs array (mutable — router updates it) */
    detectedIdes: { value: any[] };
    sessionRegistry: SessionRegistry;
    /** Callback for CDP manager creation after launch_ide */
    onCdpManagerCreated?: (ideType: string, manager: DaemonCdpManager) => void;
    /** Callback after IDE connected (e.g., startAgentStreamPolling) */
    onIdeConnected?: () => void;
    /** Callback after status change (stop_ide, restart) */
    onStatusChange?: () => void;
    /** Callback after chat-related commands */
    onPostChatCommand?: () => void;
    /** Get a connected CDP manager (for agent stream reset check) */
    getCdpLogFn?: (ideType: string) => (msg: string) => void;
    /** Package name for upgrade detection ('adhdev' or '@adhdev/daemon-standalone') */
    packageName?: string;
    /** Canonical daemon status identity used by snapshot commands */
    statusInstanceId?: string;
    statusVersion?: string;
    /** Session host control plane */
    sessionHostControl?: SessionHostControlPlane | null;
}

export interface CommandRouterResult {
    success: boolean;
    [key: string]: unknown;
}

// Commands that trigger post-chat status updates
const CHAT_COMMANDS = [
    'send_chat', 'new_chat', 'switch_chat', 'set_mode',
    'change_model',
];
const READ_DEBUG_ENABLED = process.argv.includes('--dev') || process.env.ADHDEV_READ_DEBUG === '1';

function normalizeCommandSource(source: string): CommandLogEntry['source'] {
    switch (source) {
        case 'ws':
        case 'p2p':
        case 'ext':
        case 'api':
        case 'standalone':
            return source;
        default:
            return 'unknown';
    }
}

function normalizeCommandArgsWithInteractionId(args: any): Record<string, unknown> {
    const base = args && typeof args === 'object' ? { ...args } : {};
    if (typeof base._interactionId !== 'string' || !String(base._interactionId).trim()) {
        base._interactionId = createInteractionId();
    }
    return base;
}

function toHostedCliRuntimeDescriptor(record: any): HostedCliRuntimeDescriptor | null {
    if (!record || typeof record !== 'object') return null;
    const runtimeId = typeof record.sessionId === 'string' ? record.sessionId : '';
    const cliType = typeof record.providerType === 'string' ? record.providerType : '';
    const workspace = typeof record.workspace === 'string' ? record.workspace : '';
    if (!runtimeId || !cliType || !workspace) return null;
    return {
        runtimeId,
        runtimeKey: typeof record.runtimeKey === 'string' ? record.runtimeKey : undefined,
        displayName: typeof record.displayName === 'string' ? record.displayName : undefined,
        workspaceLabel: typeof record.workspaceLabel === 'string' ? record.workspaceLabel : undefined,
        lifecycle: typeof record.lifecycle === 'string' ? record.lifecycle as HostedCliRuntimeDescriptor['lifecycle'] : undefined,
        recoveryState: typeof record.meta?.runtimeRecoveryState === 'string'
            ? String(record.meta.runtimeRecoveryState)
            : null,
        cliType,
        workspace,
        cliArgs: Array.isArray(record.meta?.cliArgs) ? record.meta.cliArgs as string[] : [],
        providerSessionId: typeof record.meta?.providerSessionId === 'string'
            ? String(record.meta.providerSessionId)
            : undefined,
    };
}

function getWriteConflictOwnerClientId(error: unknown): string | undefined {
    const message = typeof error === 'string'
        ? error
        : error instanceof Error
            ? error.message
            : '';
    const match = /^Write owned by\s+(.+)$/.exec(message.trim());
    return match?.[1]?.trim() || undefined;
}

function summarizeSessionHostRecord(result: unknown): Record<string, unknown> {
    if (!result || typeof result !== 'object') return {};
    const record = result as Record<string, any>;
    return {
        runtimeKey: typeof record.runtimeKey === 'string' ? record.runtimeKey : undefined,
        lifecycle: typeof record.lifecycle === 'string' ? record.lifecycle : undefined,
        surfaceKind: getSessionHostSurfaceKind(record as any),
        attachedClientCount: Array.isArray(record.attachedClients) ? record.attachedClients.length : undefined,
        hasWriteOwner: !!record.writeOwner,
        writeOwnerClientId: typeof record.writeOwner?.clientId === 'string' ? record.writeOwner.clientId : undefined,
    };
}

function summarizeSessionHostRecords(result: unknown): Record<string, unknown> {
    const records = Array.isArray(result) ? result : [];
    const groups = partitionSessionHostRecords(records as any[]);
    return {
        sessionCount: records.length,
        liveRuntimeCount: groups.liveRuntimes.length,
        recoverySnapshotCount: groups.recoverySnapshots.length,
        inactiveRecordCount: groups.inactiveRecords.length,
    };
}

function summarizeSessionHostDiagnostics(result: unknown): Record<string, unknown> {
    const diagnostics = result && typeof result === 'object' ? result as Record<string, any> : {};
    const sessions = Array.isArray(diagnostics.sessions) ? diagnostics.sessions : [];
    return {
        runtimeCount: typeof diagnostics.runtimeCount === 'number' ? diagnostics.runtimeCount : undefined,
        ...summarizeSessionHostRecords(sessions),
    };
}

function summarizeSessionHostPruneResult(result: unknown): Record<string, unknown> {
    const value = result && typeof result === 'object' ? result as Record<string, any> : {};
    return {
        duplicateGroupCount: typeof value.duplicateGroupCount === 'number' ? value.duplicateGroupCount : undefined,
        prunedCount: Array.isArray(value.prunedSessionIds) ? value.prunedSessionIds.length : undefined,
        keptCount: Array.isArray(value.keptSessionIds) ? value.keptSessionIds.length : undefined,
    };
}

export class DaemonCommandRouter {
    private deps: CommandRouterDeps;

    constructor(deps: CommandRouterDeps) {
        this.deps = deps;
    }

    private async traceSessionHostAction<T>(
        action: string,
        args: any,
        run: () => Promise<T>,
        summarizeResult?: (result: T) => Record<string, unknown>,
    ): Promise<T> {
        const interactionId = typeof args?._interactionId === 'string' ? args._interactionId : undefined;
        const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : undefined;
        const requestedPayload: Record<string, unknown> = { action };
        if (sessionId) requestedPayload.sessionId = sessionId;
        if (typeof args?.clientId === 'string') requestedPayload.clientId = args.clientId;
        if (typeof args?.signal === 'string') requestedPayload.signal = args.signal;
        if (typeof args?.providerType === 'string') requestedPayload.providerType = args.providerType;
        if (typeof args?.workspace === 'string') requestedPayload.workspace = args.workspace;
        if (typeof args?.dryRun === 'boolean') requestedPayload.dryRun = args.dryRun;

        recordDebugTrace({
            interactionId,
            category: 'session_host',
            stage: 'action_requested',
            level: 'info',
            sessionId,
            payload: requestedPayload,
        });

        try {
            const result = await run();
            recordDebugTrace({
                interactionId,
                category: 'session_host',
                stage: 'action_result',
                level: 'info',
                sessionId,
                payload: {
                    ...requestedPayload,
                    success: true,
                    ...(summarizeResult ? summarizeResult(result) : {}),
                },
            });
            return result;
        } catch (error: any) {
            recordDebugTrace({
                interactionId,
                category: 'session_host',
                stage: 'action_failed',
                level: 'error',
                sessionId,
                payload: {
                    ...requestedPayload,
                    error: error?.message || String(error),
                    failureKind: getWriteConflictOwnerClientId(error) ? 'write_conflict' : 'request_failed',
                    conflictOwnerClientId: getWriteConflictOwnerClientId(error),
                },
            });
            throw error;
        }
    }

    /**
     * Unified command routing.
     * Returns result for all commands:
     *   1. Daemon-level commands (launch_ide, stop_ide, etc.)
     *   2. CLI commands (launch_cli, stop_cli, agent_command)
     *   3. DaemonCommandHandler delegation (CDP/agent-stream/file commands)
     *
     * @param cmd Command name
     * @param args Command arguments
     * @param source Log source ('ws' | 'p2p' | 'standalone' | etc.)
     */
    async execute(cmd: string, args: any, source: string = 'unknown'): Promise<CommandRouterResult> {
        const cmdStart = Date.now();
        const logSource = normalizeCommandSource(source);
        const normalizedArgs = normalizeCommandArgsWithInteractionId(args);
        const interactionId = typeof normalizedArgs._interactionId === 'string' ? normalizedArgs._interactionId : undefined;

        recordDebugTrace({
            interactionId,
            category: 'command',
            stage: 'received',
            level: 'info',
            payload: { cmd, source: logSource },
        });

        try {
            // 1. Try daemon-level command
            const daemonResult = await this.executeDaemonCommand(cmd, normalizedArgs);
            if (daemonResult) {
                logCommand({ ts: new Date().toISOString(), cmd, source: logSource, interactionId, args: normalizedArgs, success: daemonResult.success, durationMs: Date.now() - cmdStart });
                recordDebugTrace({
                    interactionId,
                    category: 'command',
                    stage: 'completed',
                    level: daemonResult.success ? 'info' : 'warn',
                    payload: { cmd, source: logSource, success: daemonResult.success, durationMs: Date.now() - cmdStart },
                });
                return daemonResult;
            }

            // 2. Delegate to DaemonCommandHandler
            const handlerResult = await this.deps.commandHandler.handle(cmd, normalizedArgs);
            logCommand({ ts: new Date().toISOString(), cmd, source: logSource, interactionId, args: normalizedArgs, success: handlerResult.success, durationMs: Date.now() - cmdStart });
            recordDebugTrace({
                interactionId,
                category: 'command',
                stage: 'completed',
                level: handlerResult.success ? 'info' : 'warn',
                payload: { cmd, source: logSource, success: handlerResult.success, durationMs: Date.now() - cmdStart },
            });

            // 3. Post-chat command callback
            if (CHAT_COMMANDS.includes(cmd) && this.deps.onPostChatCommand) {
                this.deps.onPostChatCommand();
            }

            return handlerResult;
        } catch (e: any) {
            logCommand({ ts: new Date().toISOString(), cmd, source: logSource, interactionId, args: normalizedArgs, success: false, error: e.message, durationMs: Date.now() - cmdStart });
            recordDebugTrace({
                interactionId,
                category: 'command',
                stage: 'failed',
                level: 'error',
                payload: { cmd, source: logSource, error: e?.message || String(e), durationMs: Date.now() - cmdStart },
            });
            throw e;
        }
    }

    // ─── Daemon-level command core ───────────────────

    /**
     * Daemon-level command execution (IDE start/stop/restart, CLI, detect, logs).
     * Returns null if not handled at this level → caller delegates to CommandHandler.
     */
    private async executeDaemonCommand(cmd: string, args: any): Promise<CommandRouterResult | null> {
        switch (cmd) {
            // ─── CLI / ACP commands ───
            case 'launch_cli':
            case 'stop_cli':
            case 'set_cli_view_mode':
            case 'agent_command': {
                return this.deps.cliManager.handleCliCommand(cmd, args);
            }

            // ─── Logs ───
            case 'get_logs': {
                const count = parseInt(args?.count) || parseInt(args?.lines) || 100;
                const minLevel = args?.minLevel || 'info';
                const sinceTs = args?.since || 0;

                try {
                    // Priority 1: ring buffer (fast and structured)
                    let logs = getRecentLogs(count, minLevel);
                    if (sinceTs > 0) {
                        logs = logs.filter((l: any) => l.ts > sinceTs);
                    }
                    if (logs.length > 0) {
                        return { success: true, logs, totalBuffered: logs.length };
                    }
                    // Priority 2: file fallback
                    if (fs.existsSync(LOG_PATH)) {
                        const content = fs.readFileSync(LOG_PATH, 'utf-8');
                        const allLines = content.split('\n');
                        const recent = allLines.slice(-count).join('\n');
                        return { success: true, logs: recent, totalLines: allLines.length };
                    }
                    return { success: true, logs: [], totalBuffered: 0 };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'get_debug_trace': {
                const count = parseInt(args?.count) || parseInt(args?.limit) || 100;
                const sinceTs = Number(args?.since) || 0;
                const interactionId = typeof args?.interactionId === 'string' ? args.interactionId : undefined;
                const category = typeof args?.category === 'string' ? args.category : undefined;
                const trace = getRecentDebugTrace({ interactionId, category, limit: count })
                    .filter((entry) => !sinceTs || entry.ts > sinceTs);
                return { success: true, trace, count: trace.length };
            }

            case 'session_host_get_diagnostics': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const diagnostics = await this.traceSessionHostAction('session_host_get_diagnostics', args, () => this.deps.sessionHostControl!.getDiagnostics({
                    includeSessions: args?.includeSessions !== false,
                    limit: Number(args?.limit) || undefined,
                }), (result) => ({
                    includeSessions: args?.includeSessions !== false,
                    limit: Number(args?.limit) || undefined,
                    ...summarizeSessionHostDiagnostics(result),
                }));
                return { success: true, diagnostics };
            }

            case 'session_host_list_sessions': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessions = await this.traceSessionHostAction('session_host_list_sessions', args, () => this.deps.sessionHostControl!.listSessions(), (records) => summarizeSessionHostRecords(records));
                return { success: true, sessions };
            }

            case 'session_host_stop_session': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
                if (!sessionId) return { success: false, error: 'sessionId required' };
                const record = await this.traceSessionHostAction('session_host_stop_session', args, () => this.deps.sessionHostControl!.stopSession(sessionId), (result) => summarizeSessionHostRecord(result));
                return { success: true, record };
            }

            case 'session_host_resume_session': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
                if (!sessionId) return { success: false, error: 'sessionId required' };
                const record = await this.traceSessionHostAction('session_host_resume_session', args, async () => {
                    const nextRecord = await this.deps.sessionHostControl!.resumeSession(sessionId);
                    const hosted = toHostedCliRuntimeDescriptor(nextRecord);
                    if (hosted) {
                        await this.deps.cliManager.restoreHostedSessions([hosted]);
                    }
                    return nextRecord;
                }, (result) => ({
                    ...summarizeSessionHostRecord(result),
                    restoredHostedSession: !!toHostedCliRuntimeDescriptor(result),
                }));
                return { success: true, record };
            }

            case 'session_host_restart_session': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
                if (!sessionId) return { success: false, error: 'sessionId required' };
                const record = await this.traceSessionHostAction('session_host_restart_session', args, async () => {
                    const nextRecord = await this.deps.sessionHostControl!.restartSession(sessionId);
                    const hosted = toHostedCliRuntimeDescriptor(nextRecord);
                    if (hosted) {
                        await this.deps.cliManager.restoreHostedSessions([hosted]);
                    }
                    return nextRecord;
                }, (result) => ({
                    ...summarizeSessionHostRecord(result),
                    restoredHostedSession: !!toHostedCliRuntimeDescriptor(result),
                }));
                return { success: true, record };
            }

            case 'session_host_send_signal': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
                const signal = typeof args?.signal === 'string' ? args.signal : '';
                if (!sessionId) return { success: false, error: 'sessionId required' };
                if (!signal) return { success: false, error: 'signal required' };
                const record = await this.traceSessionHostAction('session_host_send_signal', args, () => this.deps.sessionHostControl!.sendSignal(sessionId, signal), (result) => summarizeSessionHostRecord(result));
                return { success: true, record };
            }

            case 'session_host_force_detach_client': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
                const clientId = typeof args?.clientId === 'string' ? args.clientId : '';
                if (!sessionId) return { success: false, error: 'sessionId required' };
                if (!clientId) return { success: false, error: 'clientId required' };
                const record = await this.traceSessionHostAction('session_host_force_detach_client', args, () => this.deps.sessionHostControl!.forceDetachClient(sessionId, clientId), (result) => summarizeSessionHostRecord(result));
                return { success: true, record };
            }

            case 'session_host_prune_duplicate_sessions': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const result = await this.traceSessionHostAction('session_host_prune_duplicate_sessions', args, () => this.deps.sessionHostControl!.pruneDuplicateSessions({
                    providerType: typeof args?.providerType === 'string' ? args.providerType : undefined,
                    workspace: typeof args?.workspace === 'string' ? args.workspace : undefined,
                    dryRun: args?.dryRun === true,
                }), (value) => summarizeSessionHostPruneResult(value));
                return { success: true, result };
            }

            case 'session_host_acquire_write': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
                const clientId = typeof args?.clientId === 'string' ? args.clientId : '';
                const ownerType = args?.ownerType === 'agent' ? 'agent' : 'user';
                if (!sessionId) return { success: false, error: 'sessionId required' };
                if (!clientId) return { success: false, error: 'clientId required' };
                const record = await this.traceSessionHostAction('session_host_acquire_write', args, () => this.deps.sessionHostControl!.acquireWrite({
                    sessionId,
                    clientId,
                    ownerType,
                    force: args?.force !== false,
                }), (result) => ({
                    ...summarizeSessionHostRecord(result),
                    ownerType,
                }));
                return { success: true, record };
            }

            case 'session_host_release_write': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
                const clientId = typeof args?.clientId === 'string' ? args.clientId : '';
                if (!sessionId) return { success: false, error: 'sessionId required' };
                if (!clientId) return { success: false, error: 'clientId required' };
                const record = await this.traceSessionHostAction('session_host_release_write', args, () => this.deps.sessionHostControl!.releaseWrite({
                    sessionId,
                    clientId,
                }), (result) => summarizeSessionHostRecord(result));
                return { success: true, record };
            }

            case 'list_saved_sessions': {
                const providerType = typeof args?.providerType === 'string'
                    ? args.providerType.trim()
                    : typeof args?.agentType === 'string'
                        ? args.agentType.trim()
                        : '';
                const kind = args?.kind === 'acp' ? 'acp' : 'cli';
                if (!providerType) {
                    return { success: false, error: 'providerType required' };
                }

                const wantsAll = args?.all === true;
                const offset = wantsAll ? 0 : Math.max(0, Number(args?.offset) || 0);
                const limit = wantsAll ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.min(100, Number(args?.limit) || 30));
                const { sessions: historySessions, hasMore } = listSavedHistorySessions(providerType, { offset, limit });
                const state = loadState();
                const savedSessions = getSavedProviderSessions(state, { providerType, kind });
                const recentSessions = getRecentActivity(state, 200)
                    .filter(entry => entry.providerType === providerType && entry.kind === kind && entry.providerSessionId);
                const savedSessionById = new Map(savedSessions.map(entry => [entry.providerSessionId, entry]));
                const recentSessionById = new Map(recentSessions.map(entry => [entry.providerSessionId!, entry]));
                const providerMeta = this.deps.providerLoader.getMeta(providerType);
                const canResumeById = supportsExplicitSessionResume(providerMeta?.resume);

                return {
                    success: true,
                    sessions: historySessions.map(session => {
                        const saved = savedSessionById.get(session.historySessionId);
                        const recent = recentSessionById.get(session.historySessionId);
                        return {
                            id: session.historySessionId,
                            providerSessionId: session.historySessionId,
                            providerType,
                            providerName: saved?.providerName || recent?.providerName || providerType,
                            kind: saved?.kind || recent?.kind || kind,
                            title: saved?.title || recent?.title || session.sessionTitle || session.preview || providerType,
                            workspace: saved?.workspace || recent?.workspace || session.workspace,
                            summaryMetadata: saved?.summaryMetadata || recent?.summaryMetadata,
                            preview: session.preview,
                            messageCount: session.messageCount,
                            firstMessageAt: session.firstMessageAt,
                            lastMessageAt: session.lastMessageAt,
                            canResume: !!(saved?.workspace || recent?.workspace || session.workspace) && canResumeById,
                        };
                    }),
                    hasMore,
                };
            }

            // ─── restart_session: IDE / CLI / ACP unified ───
            case 'restart_session': {
                const targetType = args?.cliType || args?.agentType || args?.ideType;
                if (!targetType) throw new Error('cliType or ideType required');

                // Check if IDE (in cdpManagers or provider category is ide)
                const isIde = this.deps.cdpManagers.has(targetType) ||
                    this.deps.providerLoader.getMeta(targetType)?.category === 'ide';

                if (isIde) {
                    // IDE restart: stop (with process kill) → launch
                    await this.stopIde(targetType, true);
                    const launchResult = await this.executeDaemonCommand('launch_ide', { ideType: targetType, enableCdp: true, workspace: args?.workspace });
                    return { success: true, restarted: true, ideType: targetType, launch: launchResult };
                }

                // CLI/ACP restart: delegate to CliManager
                return this.deps.cliManager.handleCliCommand(cmd, args);
            }

            // ─── IDE stop ───
            case 'stop_ide': {
                const ideType = args?.ideType;
                if (!ideType) throw new Error('ideType required');
                const killProcess = args?.killProcess !== false; // default true
                await this.stopIde(ideType, killProcess);
                try {
                    const results = await detectIDEs(this.deps.providerLoader);
                    this.deps.detectedIdes.value = results;
                    this.deps.providerLoader.setIdeDetectionResults(results, true);
                } catch { /* ignore detection refresh errors */ }
                return { success: true, ideType, stopped: true, processKilled: killProcess };
            }

            // ─── IDE restart ───
            case 'restart_ide': {
                const ideType = args?.ideType;
                if (!ideType) throw new Error('ideType required');
                await this.stopIde(ideType, true); // always kill process on restart
                const launchResult = await this.executeDaemonCommand('launch_ide', { ideType, enableCdp: true, workspace: args?.workspace });
                return { success: true, ideType, restarted: true, launch: launchResult };
            }

            // ─── IDE launch + CDP connect ───
            case 'launch_ide': {
                const ideKey = args?.ideId || args?.ideType;
                const resolvedWorkspace = resolveIdeLaunchWorkspace(
                    {
                        workspace: args?.workspace,
                        workspaceId: args?.workspaceId,
                        useDefaultWorkspace: args?.useDefaultWorkspace,
                    },
                    loadConfig(),
                );
                const launchArgs = {
                    ideId: ideKey,
                    workspace: resolvedWorkspace,
                    newWindow: args?.newWindow,
                };
                LOG.info('LaunchIDE', `target=${ideKey || 'auto'}`);
                const result = await launchWithCdp(launchArgs);

                if (result.success && result.port && result.ideId && !this.deps.cdpManagers.has(result.ideId)) {
                    const logFn = this.deps.getCdpLogFn
                        ? this.deps.getCdpLogFn(result.ideId)
                        : LOG.forComponent(`CDP:${result.ideId}`).asLogFn();
                    const provider = this.deps.providerLoader.getMeta(result.ideId);
                    const manager = new DaemonCdpManager(result.port, logFn, undefined, provider?.targetFilter);
                    const connected = await manager.connect();
                    if (connected) {
                        // Register active extension providers for this IDE in CDP manager
                        registerExtensionProviders(this.deps.providerLoader, manager, result.ideId);
                        this.deps.cdpManagers.set(result.ideId, manager);
                        LOG.info('CDP', `Connected: ${result.ideId} (port ${result.port})`);
                        LOG.info('CDP', `${this.deps.cdpManagers.size} IDE(s) connected`);

                        // Notify consumer (e.g. setupIdeInstance)
                        this.deps.onCdpManagerCreated?.(result.ideId, manager);
                    }
                }
                this.deps.onIdeConnected?.();
                try {
                    const results = await detectIDEs(this.deps.providerLoader);
                    this.deps.detectedIdes.value = results;
                    this.deps.providerLoader.setIdeDetectionResults(results, true);
                } catch { /* ignore detection refresh errors */ }
                if (result.success && resolvedWorkspace) {
                    try {
                        const next = appendRecentActivity(loadState(), {
                            kind: 'ide',
                            providerType: result.ideId || ideKey,
                            providerName: result.ideId || ideKey,
                            workspace: resolvedWorkspace,
                            title: result.ideId || ideKey,
                        });
                        saveState(next);
                    } catch { /* ignore activity persist errors */ }
                } else if (result.success && (result.ideId || ideKey)) {
                    try {
                        saveState(appendRecentActivity(loadState(), {
                            kind: 'ide',
                            providerType: result.ideId || ideKey,
                            providerName: result.ideId || ideKey,
                            title: result.ideId || ideKey,
                        }));
                    } catch { /* ignore activity persist errors */ }
                }
                return { ...result };
            }

            // ─── Detect IDEs ───
            case 'detect_ides': {
                const results = await detectIDEs(this.deps.providerLoader);
                this.deps.detectedIdes.value = results;
                this.deps.providerLoader.setIdeDetectionResults(results, true);
                return { success: true, detectedInfo: results };
            }

            // ─── Set User Name ───
            case 'set_user_name': {
                const name = args?.userName;
                if (!name || typeof name !== 'string') throw new Error('userName required');
                updateConfig({ userName: name });
                return { success: true, userName: name };
            }

            case 'get_status_metadata': {
                const snapshot = buildStatusSnapshot({
                    allStates: this.deps.instanceManager.collectAllStates(),
                    cdpManagers: this.deps.cdpManagers,
                    providerLoader: this.deps.providerLoader,
                    detectedIdes: this.deps.detectedIdes.value,
                    instanceId: this.deps.statusInstanceId || loadConfig().machineId || 'daemon',
                    version: this.deps.statusVersion || 'unknown',
                    profile: 'metadata',
                });
                return { success: true, status: snapshot };
            }

            case 'get_machine_runtime_stats': {
                return {
                    success: true,
                    machine: buildMachineInfo('full'),
                    timestamp: Date.now(),
                };
            }

            case 'mark_session_seen': {
                const sessionId = args?.sessionId;
                if (!sessionId || typeof sessionId !== 'string') {
                    return { success: false, error: 'sessionId is required' };
                }
                const currentState = loadState();
                const prevSeenAt = currentState.sessionReads?.[sessionId] || 0;
                const sessionEntries = buildSessionEntries(
                    this.deps.instanceManager.collectAllStates(),
                    this.deps.cdpManagers,
                );
                const targetSession = sessionEntries.find((entry) => entry.id === sessionId);
                const completionMarker = targetSession ? getSessionCompletionMarker(targetSession) : '';
                const next = markSessionSeen(
                    currentState,
                    sessionId,
                    typeof args?.seenAt === 'number' ? args.seenAt : Date.now(),
                    completionMarker,
                    targetSession?.providerSessionId,
                );
                if (READ_DEBUG_ENABLED) {
                    LOG.info('RecentRead', `mark_session_seen sessionId=${sessionId} seenAt=${String(args?.seenAt || '')} prevSeenAt=${String(prevSeenAt)} nextSeenAt=${String(next.sessionReads?.[sessionId] || 0)} marker=${completionMarker || '-'}`);
                }
                saveState(next);
                this.deps.onStatusChange?.();
                return {
                    success: true,
                    sessionId,
                    seenAt: next.sessionReads?.[sessionId] || Date.now(),
                    completionMarker,
                };
            }

            case 'delete_notification': {
                const sessionId = args?.sessionId;
                const notificationId = typeof args?.notificationId === 'string' ? args.notificationId.trim() : '';
                if (!sessionId || typeof sessionId !== 'string') {
                    return { success: false, error: 'sessionId is required' };
                }
                if (!notificationId) {
                    return { success: false, error: 'notificationId is required' };
                }
                const sessionEntries = buildSessionEntries(
                    this.deps.instanceManager.collectAllStates(),
                    this.deps.cdpManagers,
                );
                const targetSession = sessionEntries.find((entry) => entry.id === sessionId);
                const next = dismissSessionNotification(
                    loadState(),
                    sessionId,
                    notificationId,
                    targetSession?.providerSessionId,
                );
                saveState(next);
                this.deps.onStatusChange?.();
                return {
                    success: true,
                    sessionId,
                    notificationId,
                };
            }

            case 'mark_notification_unread': {
                const sessionId = args?.sessionId;
                const notificationId = typeof args?.notificationId === 'string' ? args.notificationId.trim() : '';
                if (!sessionId || typeof sessionId !== 'string') {
                    return { success: false, error: 'sessionId is required' };
                }
                if (!notificationId) {
                    return { success: false, error: 'notificationId is required' };
                }
                const sessionEntries = buildSessionEntries(
                    this.deps.instanceManager.collectAllStates(),
                    this.deps.cdpManagers,
                );
                const targetSession = sessionEntries.find((entry) => entry.id === sessionId);
                const next = markSessionNotificationUnread(
                    loadState(),
                    sessionId,
                    notificationId,
                    targetSession?.providerSessionId,
                );
                saveState(next);
                this.deps.onStatusChange?.();
                return {
                    success: true,
                    sessionId,
                    notificationId,
                };
            }

            // ─── Daemon Self-Upgrade ───
            case 'daemon_upgrade': {
                LOG.info('Upgrade', 'Remote upgrade requested from dashboard');
                try {
                    const { execSync } = await import('child_process');

                    // Detect package name for upgrade
                    const isStandalone = this.deps.packageName === '@adhdev/daemon-standalone'
                        || process.argv[1]?.includes('daemon-standalone');
                    const pkgName = isStandalone ? '@adhdev/daemon-standalone' : 'adhdev';

                    // Check latest version
                    const latest = execSync(`npm view ${pkgName} version`, { encoding: 'utf-8', timeout: 10000 }).trim();
                    LOG.info('Upgrade', `Latest ${pkgName}: v${latest}`);
                    let currentInstalled: string | null = null;
                    try {
                        const currentJson = execSync(`npm ls -g ${pkgName} --depth=0 --json`, {
                            encoding: 'utf-8',
                            timeout: 10000,
                            stdio: ['pipe', 'pipe', 'pipe'],
                        }).trim();
                        const parsed = JSON.parse(currentJson);
                        currentInstalled = parsed?.dependencies?.[pkgName]?.version || null;
                    } catch {
                        // ignore ls failures; upgrade can still proceed
                    }

                    const runningVersion = typeof this.deps.statusVersion === 'string'
                        ? this.deps.statusVersion.trim().replace(/^v/, '')
                        : null;
                    if (currentInstalled === latest && runningVersion === latest) {
                        LOG.info('Upgrade', `Already on latest version v${latest}; skipping install`);
                        return { success: true, upgraded: false, alreadyLatest: true, version: latest };
                    }
                    if (currentInstalled === latest && runningVersion && runningVersion !== latest) {
                        LOG.info('Upgrade', `Installed package is v${latest}, but running daemon is v${runningVersion}; scheduling restart`);
                    }

                    spawnDetachedDaemonUpgradeHelper({
                        packageName: pkgName,
                        targetVersion: latest,
                        parentPid: process.pid,
                        restartArgv: process.argv.slice(1),
                        cwd: process.cwd(),
                        sessionHostAppName: process.env.ADHDEV_SESSION_HOST_NAME || 'adhdev',
                    });
                    LOG.info('Upgrade', `Scheduled detached upgrade to v${latest}`);

                    // Exit after the command response has been sent so the helper can replace the package cleanly.
                    setTimeout(() => {
                        LOG.info('Upgrade', 'Exiting daemon so detached upgrader can continue...');
                        process.exit(0);
                    }, 3000);

                    return { success: true, upgraded: true, version: latest, restarting: true };
                } catch (e: any) {
                    LOG.error('Upgrade', `Failed: ${e.message}`);
                    return { success: false, error: e.message };
                }
            }

            // ─── Machine Settings ───
            case 'set_machine_nickname': {
                const nickname = args?.nickname;
                updateConfig({ machineNickname: nickname || null });
                return { success: true };
            }

            default:
                break;
        }

        return null; // Not handled at this level → delegate to CommandHandler
    }

    /**
     * IDE stop: CDP disconnect + InstanceManager cleanup + optionally kill OS process
     */
    private async stopIde(ideType: string, killProcess: boolean = false): Promise<void> {
        // 1. Release CDP manager(s) — handle multi-instance (e.g. "cursor" and "cursor_workspace")
        const cdpKeysToRemove: string[] = [];
        for (const key of this.deps.cdpManagers.keys()) {
            if (key === ideType || key.startsWith(`${ideType}_`)) {
                cdpKeysToRemove.push(key);
            }
        }
        for (const key of cdpKeysToRemove) {
            const cdp = this.deps.cdpManagers.get(key);
            if (cdp) {
                try { cdp.disconnect(); } catch { /* noop */ }
                this.deps.cdpManagers.delete(key);
                this.deps.sessionRegistry.unregisterByManagerKey(key);
                LOG.info('StopIDE', `CDP disconnected: ${key}`);
            }
        }

        // 2. Remove IDE instance(s) from InstanceManager
        const keysToRemove: string[] = [];
        for (const key of this.deps.instanceManager.listInstanceIds()) {
            if (key === `ide:${ideType}` || (typeof key === 'string' && key.startsWith(`ide:${ideType}_`))) {
                keysToRemove.push(key);
            }
        }
        for (const instanceKey of keysToRemove) {
            if (this.deps.instanceManager.getInstance(instanceKey)) {
                this.deps.instanceManager.removeInstance(instanceKey);
                LOG.info('StopIDE', `Instance removed: ${instanceKey}`);
            }
        }
        // Fallback: single instance key
        if (keysToRemove.length === 0) {
            const instanceKey = `ide:${ideType}`;
            if (this.deps.instanceManager.getInstance(instanceKey)) {
                this.deps.instanceManager.removeInstance(instanceKey);
                LOG.info('StopIDE', `Instance removed: ${instanceKey}`);
            }
        }

        // 3. Kill OS process if requested
        if (killProcess) {
            const running = isIdeRunning(ideType);
            if (running) {
                LOG.info('StopIDE', `Killing IDE process: ${ideType}`);
                const killed = await killIdeProcess(ideType);
                if (killed) {
                    LOG.info('StopIDE', `✅ Process killed: ${ideType}`);
                } else {
                    LOG.warn('StopIDE', `⚠ Could not kill process: ${ideType} (may need manual intervention)`);
                }
            } else {
                LOG.info('StopIDE', `Process not running: ${ideType}`);
            }
        }

        // 4. Notify consumer for status update
        this.deps.onStatusChange?.();
        LOG.info('StopIDE', `IDE stopped: ${ideType} (processKill=${killProcess})`);
    }
}
