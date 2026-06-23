/**
 * RF-ROUTER LOW family — session-host control commands.
 *
 * Extracted verbatim from DaemonCommandRouter.executeDaemonCommand. Each handler
 * reads only ctx.deps.sessionHostControl (+ cliManager for the resume/restart
 * hosted-session restore) and returns the same CommandRouterResult as before.
 * The trace/summarize helpers were `this`-free module functions in router.ts and
 * are relocated here unchanged.
 */
import type { HostedCliRuntimeDescriptor } from '../cli-manager.js';
import { recordDebugTrace } from '../../logging/debug-trace.js';
import { getSessionHostSurfaceKind, partitionSessionHostRecords } from '../../session-host/runtime-surface.js';
import type { LowFamilyContext, LowFamilyHandler } from './types.js';

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

async function traceSessionHostAction<T>(
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

export const sessionHostHandlers: Record<string, LowFamilyHandler> = {
    session_host_get_diagnostics: async (ctx: LowFamilyContext, args: any) => {
        if (!ctx.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
        const diagnostics = await traceSessionHostAction('session_host_get_diagnostics', args, () => ctx.deps.sessionHostControl!.getDiagnostics({
            includeSessions: args?.includeSessions !== false,
            limit: Number(args?.limit) || undefined,
        }), (result) => ({
            includeSessions: args?.includeSessions !== false,
            limit: Number(args?.limit) || undefined,
            ...summarizeSessionHostDiagnostics(result),
        }));
        return { success: true, diagnostics };
    },

    session_host_list_sessions: async (ctx: LowFamilyContext, args: any) => {
        if (!ctx.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
        const sessions = await traceSessionHostAction('session_host_list_sessions', args, () => ctx.deps.sessionHostControl!.listSessions(), (records) => summarizeSessionHostRecords(records));
        return { success: true, sessions };
    },

    session_host_stop_session: async (ctx: LowFamilyContext, args: any) => {
        if (!ctx.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
        const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
        if (!sessionId) return { success: false, error: 'sessionId required' };
        const record = await traceSessionHostAction('session_host_stop_session', args, () => ctx.deps.sessionHostControl!.stopSession(sessionId), (result) => summarizeSessionHostRecord(result));
        return { success: true, record };
    },

    session_host_resume_session: async (ctx: LowFamilyContext, args: any) => {
        if (!ctx.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
        const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
        if (!sessionId) return { success: false, error: 'sessionId required' };
        const record = await traceSessionHostAction('session_host_resume_session', args, async () => {
            const nextRecord = await ctx.deps.sessionHostControl!.resumeSession(sessionId);
            const hosted = toHostedCliRuntimeDescriptor(nextRecord);
            if (hosted) {
                await ctx.deps.cliManager.restoreHostedSessions([hosted]);
            }
            return nextRecord;
        }, (result) => ({
            ...summarizeSessionHostRecord(result),
            restoredHostedSession: !!toHostedCliRuntimeDescriptor(result),
        }));
        return { success: true, record };
    },

    session_host_restart_session: async (ctx: LowFamilyContext, args: any) => {
        if (!ctx.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
        const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
        if (!sessionId) return { success: false, error: 'sessionId required' };
        const record = await traceSessionHostAction('session_host_restart_session', args, async () => {
            const nextRecord = await ctx.deps.sessionHostControl!.restartSession(sessionId);
            const hosted = toHostedCliRuntimeDescriptor(nextRecord);
            if (hosted) {
                await ctx.deps.cliManager.restoreHostedSessions([hosted]);
            }
            return nextRecord;
        }, (result) => ({
            ...summarizeSessionHostRecord(result),
            restoredHostedSession: !!toHostedCliRuntimeDescriptor(result),
        }));
        return { success: true, record };
    },

    session_host_send_signal: async (ctx: LowFamilyContext, args: any) => {
        if (!ctx.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
        const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
        const signal = typeof args?.signal === 'string' ? args.signal : '';
        if (!sessionId) return { success: false, error: 'sessionId required' };
        if (!signal) return { success: false, error: 'signal required' };
        const record = await traceSessionHostAction('session_host_send_signal', args, () => ctx.deps.sessionHostControl!.sendSignal(sessionId, signal), (result) => summarizeSessionHostRecord(result));
        return { success: true, record };
    },

    session_host_force_detach_client: async (ctx: LowFamilyContext, args: any) => {
        if (!ctx.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
        const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
        const clientId = typeof args?.clientId === 'string' ? args.clientId : '';
        if (!sessionId) return { success: false, error: 'sessionId required' };
        if (!clientId) return { success: false, error: 'clientId required' };
        const record = await traceSessionHostAction('session_host_force_detach_client', args, () => ctx.deps.sessionHostControl!.forceDetachClient(sessionId, clientId), (result) => summarizeSessionHostRecord(result));
        return { success: true, record };
    },

    session_host_prune_duplicate_sessions: async (ctx: LowFamilyContext, args: any) => {
        if (!ctx.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
        const result = await traceSessionHostAction('session_host_prune_duplicate_sessions', args, () => ctx.deps.sessionHostControl!.pruneDuplicateSessions({
            providerType: typeof args?.providerType === 'string' ? args.providerType : undefined,
            workspace: typeof args?.workspace === 'string' ? args.workspace : undefined,
            dryRun: args?.dryRun === true,
        }), (value) => summarizeSessionHostPruneResult(value));
        return { success: true, result };
    },

    session_host_acquire_write: async (ctx: LowFamilyContext, args: any) => {
        if (!ctx.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
        const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
        const clientId = typeof args?.clientId === 'string' ? args.clientId : '';
        const ownerType = args?.ownerType === 'agent' ? 'agent' : 'user';
        if (!sessionId) return { success: false, error: 'sessionId required' };
        if (!clientId) return { success: false, error: 'clientId required' };
        const record = await traceSessionHostAction('session_host_acquire_write', args, () => ctx.deps.sessionHostControl!.acquireWrite({
            sessionId,
            clientId,
            ownerType,
            force: args?.force !== false,
        }), (result) => ({
            ...summarizeSessionHostRecord(result),
            ownerType,
        }));
        return { success: true, record };
    },

    session_host_release_write: async (ctx: LowFamilyContext, args: any) => {
        if (!ctx.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
        const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
        const clientId = typeof args?.clientId === 'string' ? args.clientId : '';
        if (!sessionId) return { success: false, error: 'sessionId required' };
        if (!clientId) return { success: false, error: 'clientId required' };
        const record = await traceSessionHostAction('session_host_release_write', args, () => ctx.deps.sessionHostControl!.releaseWrite({
            sessionId,
            clientId,
        }), (result) => summarizeSessionHostRecord(result));
        return { success: true, record };
    },
};
