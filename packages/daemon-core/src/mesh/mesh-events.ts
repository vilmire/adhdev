import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { loadConfig } from '../config/config.js';
import { getMesh, getMeshByRepo } from '../config/mesh-config.js';
import { detectCLI } from '../detection/cli-detector.js';
import { LOG } from '../logging/logger.js';
import { appendLedgerEntry, buildTaskCompletionEvidence, getLedgerDir, getSessionRecoveryContext, isIntentionalCleanupStopEntry, readLedgerEntries } from './mesh-ledger.js';
import type { MeshLedgerKind, SessionRecoveryContext } from './mesh-ledger.js';
import { claimNextTask, updateSessionTaskStatus, enqueueTask, updateTaskStatus, getQueue, recordTaskAutoLaunch, updateDirectDispatchStatus, cleanupTerminalDirectDispatches } from './mesh-work-queue.js';
import { BeadsDB } from './beads-db.js';

// ---------------------------------------------------------------------------
// Remote Node Idle Session Tracking
// ---------------------------------------------------------------------------
// Tracks remote sessions that emitted 'agent:ready' so triggerMeshQueue
// can assign tasks to them. Each entry carries an expiresAt timestamp;
// entries are swept on insertion to prevent unbounded growth.
// ---------------------------------------------------------------------------
interface RemoteIdleSession {
    nodeId: string;
    sessionId: string;
    providerType: string;
    expiresAt: number;
}
const REMOTE_IDLE_SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes
const remoteIdleSessions = new Map<string, RemoteIdleSession>(); // key: `${nodeId}:${sessionId}`

function readWorkerResultMetadata(event: Record<string, unknown>): Record<string, unknown> | undefined {
    return readRecord(event.workerResult) || readRecord(event.meshWorkerResult) || readRecord(event.structuredResult);
}

function sweepExpiredRemoteIdleSessions(): void {
    const now = Date.now();
    for (const [key, session] of remoteIdleSessions) {
        if (session.expiresAt <= now) remoteIdleSessions.delete(key);
    }
}

// ---------------------------------------------------------------------------
// MCP coordinator pending-event queue — FILE-BASED PERSISTENCE
// ---------------------------------------------------------------------------
// When a mesh event fires but no CLI coordinator session is registered (e.g.
// the coordinator is Claude Code running via MCP), we persist the event to a
// per-mesh JSONL file so it survives daemon restarts. The 50-entry hard cap
// is removed; the file is drained atomically on each get_pending_mesh_events
// call and limited to 100 KB to prevent runaway growth.
//
// File: <ledgerDir>/<meshId>.pending-events.jsonl
// ---------------------------------------------------------------------------

export interface PendingMeshCoordinatorEvent {
    event: string;
    meshId: string;
    nodeLabel: string;
    nodeId?: string;
    workspace?: string;
    metadataEvent: Record<string, unknown>;
    coordinatorMessage?: string;
    queuedAt: number;
    /**
     * When set, this event is intended for a specific coordinator daemon.
     * Coordinators on other daemons should ignore it during drain.
     * Absent on legacy events — treated as broadcast to any coordinator.
     */
    targetCoordinatorDaemonId?: string;
}

const REFINE_TERMINAL_EVENTS = new Set(['refine:completed', 'refine:failed']);

function readRefineJobId(event: { metadataEvent?: Record<string, unknown> } | Record<string, unknown>): string {
    const metadata = readRecord((event as any).metadataEvent) || event as Record<string, unknown>;
    const result = readRecord(metadata.result);
    const refineJob = readRecord(result?.refineJob);
    return readNonEmptyString(metadata.jobId) || readNonEmptyString(refineJob?.jobId);
}

function buildRefineTerminalEventFingerprint(meshId: string, eventName: string, metadataEvent: Record<string, unknown>): string {
    const jobId = readRefineJobId({ metadataEvent });
    return jobId && REFINE_TERMINAL_EVENTS.has(eventName) ? `${meshId}::${eventName}::${jobId}` : '';
}

function hasPendingRefineTerminalEventDuplicate(event: PendingMeshCoordinatorEvent): boolean {
    if (!REFINE_TERMINAL_EVENTS.has(event.event)) return false;
    const jobId = readRefineJobId(event);
    if (!jobId) return false;
    return readPendingMeshCoordinatorEventsFromDisk(event.meshId).some((pending) =>
        pending.event === event.event && readRefineJobId(pending) === jobId,
    );
}

function buildPendingEventFingerprint(event: PendingMeshCoordinatorEvent): string {
    const metadata = readRecord(event.metadataEvent) || {};
    const sessionId = resolveEventSessionId(metadata);
    const providerSessionId = readNonEmptyString(metadata.providerSessionId);
    const taskId = readNonEmptyString(metadata.taskId) || readNonEmptyString(readRecord(metadata.payload)?.taskId);
    const jobId = readRefineJobId(event);
    const timestamp = metadata.timestamp !== undefined && metadata.timestamp !== null ? String(metadata.timestamp) : '';
    return [
        event.meshId,
        event.event,
        event.nodeId || '',
        sessionId || '',
        providerSessionId || '',
        taskId || '',
        jobId || '',
        timestamp || '',
    ].join('::');
}

function hasPendingCoordinatorEventDuplicate(event: PendingMeshCoordinatorEvent): boolean {
    const fingerprint = buildPendingEventFingerprint(event);
    if (!fingerprint.trim()) return false;
    return readPendingMeshCoordinatorEventsFromDisk(event.meshId).some((pending) => buildPendingEventFingerprint(pending) === fingerprint);
}

function getPendingEventsPath(meshId: string, coordinatorDaemonId?: string): string {
    const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (coordinatorDaemonId) {
        const safeDaemon = coordinatorDaemonId.replace(/[^a-zA-Z0-9_-]/g, '_');
        return join(getLedgerDir(), `${safe}-${safeDaemon}.pending-events.jsonl`);
    }
    return join(getLedgerDir(), `${safe}.pending-events.jsonl`);
}

function readPendingMeshCoordinatorEventsFromDisk(meshId?: string, coordinatorDaemonId?: string): PendingMeshCoordinatorEvent[] {
    if (!meshId) return [];
    // Read coordinator-scoped file first; fall back to legacy shared file.
    const paths = coordinatorDaemonId
        ? [getPendingEventsPath(meshId, coordinatorDaemonId), getPendingEventsPath(meshId)]
        : [getPendingEventsPath(meshId)];
    const events: PendingMeshCoordinatorEvent[] = [];
    for (const path of paths) {
        if (!existsSync(path)) continue;
        try {
            const raw = readFileSync(path, 'utf-8');
            const parsed = raw.split('\n').filter(Boolean).flatMap(line => {
                try { return [JSON.parse(line) as PendingMeshCoordinatorEvent]; } catch { return []; }
            });
            // If reading the shared file, filter to events that target this coordinator or are unscoped.
            const filtered = (coordinatorDaemonId && path === getPendingEventsPath(meshId))
                ? parsed.filter(e => !e.targetCoordinatorDaemonId || e.targetCoordinatorDaemonId === coordinatorDaemonId)
                : parsed;
            events.push(...filtered);
        } catch { /* skip unreadable files */ }
    }
    return events;
}

function refineTerminalEventFromLedger(meshId: string, pending: readonly PendingMeshCoordinatorEvent[]): PendingMeshCoordinatorEvent[] {
    const acceptedJobIds = new Set(
        pending
            .filter(event => event.event === 'refine:accepted')
            .map(event => readRefineJobId(event))
            .filter(Boolean),
    );
    if (acceptedJobIds.size === 0) return [];
    const existingTerminalJobIds = new Set(
        pending
            .filter(event => REFINE_TERMINAL_EVENTS.has(event.event))
            .map(event => `${event.event}:${readRefineJobId(event)}`)
            .filter(value => !value.endsWith(':')),
    );
    const backfilled: PendingMeshCoordinatorEvent[] = [];
    const entries = readLedgerEntries(meshId, { tail: 200 });
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.kind !== 'task_completed' && entry.kind !== 'task_failed') continue;
        const payload = readRecord(entry.payload);
        if (payload?.source !== 'refine_mesh_node_async_job') continue;
        const refineJob = readRecord(payload.refineJob);
        const jobId = readNonEmptyString(refineJob?.jobId);
        if (!jobId || !acceptedJobIds.has(jobId)) continue;
        const eventName = entry.kind === 'task_completed' ? 'refine:completed' : 'refine:failed';
        if (existingTerminalJobIds.has(`${eventName}:${jobId}`)) continue;
        existingTerminalJobIds.add(`${eventName}:${jobId}`);
        const result = readRecord(payload.result);
        const metadataEvent = {
            source: 'refine_mesh_node_async_job',
            jobId,
            interactionId: readNonEmptyString(refineJob?.interactionId),
            meshId,
            nodeId: readNonEmptyString(refineJob?.nodeId) || entry.nodeId,
            targetDaemonId: readNonEmptyString(refineJob?.targetDaemonId),
            workspace: readNonEmptyString(refineJob?.workspace),
            status: eventName === 'refine:completed' ? 'completed' : 'failed',
            startedAt: readNonEmptyString(refineJob?.startedAt),
            completedAt: readNonEmptyString(refineJob?.completedAt) || entry.timestamp,
            retryOfJobId: readNonEmptyString(refineJob?.retryOfJobId) || readNonEmptyString(payload.retryOfJobId),
            ...(result ? { result } : {}),
        };
        backfilled.push({
            event: eventName,
            meshId,
            nodeLabel: readNonEmptyString(refineJob?.nodeId) || entry.nodeId || 'refine job',
            nodeId: readNonEmptyString(refineJob?.nodeId) || entry.nodeId,
            workspace: readNonEmptyString(refineJob?.workspace),
            metadataEvent,
            coordinatorMessage: buildMeshSystemMessage({
                event: eventName,
                nodeLabel: readNonEmptyString(refineJob?.nodeId) || entry.nodeId || 'refine job',
                metadataEvent,
            }),
            queuedAt: Date.now(),
        });
    }
    return backfilled.reverse();
}

function reconcilePendingMeshCoordinatorEvents(meshId: string, events: PendingMeshCoordinatorEvent[]): PendingMeshCoordinatorEvent[] {
    const backfilled = refineTerminalEventFromLedger(meshId, events);
    if (backfilled.length === 0) return events;
    const terminalJobIds = new Set(backfilled.map(event => readRefineJobId(event)).filter(Boolean));
    return [
        ...events.filter(event => !(event.event === 'refine:accepted' && terminalJobIds.has(readRefineJobId(event)))),
        ...backfilled,
    ];
}

export function queuePendingMeshCoordinatorEvent(event: PendingMeshCoordinatorEvent): boolean {
    try {
        if (hasPendingRefineTerminalEventDuplicate(event)) {
            LOG.info('MeshEvents', `Suppressed duplicate pending ${event.event} for refine job ${readRefineJobId(event)}`);
            return true;
        }
        if (hasPendingCoordinatorEventDuplicate(event)) {
            LOG.info('MeshEvents', `Suppressed duplicate pending ${event.event} for mesh ${event.meshId}`);
            return true;
        }
        // Write to the coordinator-scoped file when the target coordinator is known;
        // fall back to the shared file for legacy/unscoped events.
        const path = getPendingEventsPath(event.meshId, event.targetCoordinatorDaemonId);
        appendFileSync(path, JSON.stringify(event) + '\n', 'utf-8');
        return true;
    } catch (e: any) {
        LOG.warn('MeshEvents', `Failed to persist pending coordinator event: ${e?.message || e}`);
        return false;
    }
}

/** Drain and return all pending coordinator events for meshId, removing them from disk. */
export function drainPendingMeshCoordinatorEvents(meshId?: string, coordinatorDaemonId?: string): PendingMeshCoordinatorEvent[] {
    if (!meshId) return [];
    const paths = coordinatorDaemonId
        ? [getPendingEventsPath(meshId, coordinatorDaemonId), getPendingEventsPath(meshId)]
        : [getPendingEventsPath(meshId)];
    const all: PendingMeshCoordinatorEvent[] = [];
    for (const path of paths) {
        if (!existsSync(path)) continue;
        try {
            const parsed = readPendingMeshCoordinatorEventsFromDisk(meshId, coordinatorDaemonId);
            try { unlinkSync(path); } catch { /* concurrent drain already removed it */ }
            all.push(...parsed);
        } catch { /* skip */ }
    }
    if (all.length === 0) return [];
    return reconcilePendingMeshCoordinatorEvents(meshId, all);
}

/** Peek at pending coordinator events without draining (non-destructive). */
export function getPendingMeshCoordinatorEvents(meshId?: string, coordinatorDaemonId?: string): readonly PendingMeshCoordinatorEvent[] {
    if (!meshId) return [];
    return reconcilePendingMeshCoordinatorEvents(meshId, readPendingMeshCoordinatorEventsFromDisk(meshId, coordinatorDaemonId));
}

/** Explicitly clear all pending coordinator events for a mesh (and coordinator if scoped). */
export function clearPendingMeshCoordinatorEvents(meshId?: string, coordinatorDaemonId?: string): void {
    if (!meshId) return;
    const paths = coordinatorDaemonId
        ? [getPendingEventsPath(meshId, coordinatorDaemonId), getPendingEventsPath(meshId)]
        : [getPendingEventsPath(meshId)];
    for (const path of paths) {
        if (existsSync(path)) try { unlinkSync(path); } catch { /* already removed */ }
    }
}

function readNonEmptyString(value: unknown): string {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function resolveEventSessionId(event: Record<string, unknown>, fallback?: unknown): string {
    return readNonEmptyString(event.targetSessionId)
        || readNonEmptyString(event.sessionId)
        || readNonEmptyString(event.instanceId)
        || readNonEmptyString(fallback);
}

const MESH_COORDINATOR_EVENTS = new Set([
    'agent:generating_started',
    'agent:generating_completed',
    'agent:waiting_approval',
    'agent:stopped',
    'agent:ready',
    'monitor:long_generating',
    'refine:accepted',
    'refine:completed',
    'refine:failed',
]);

const EVENT_TO_LEDGER_KIND: Record<string, MeshLedgerKind> = {
    'agent:generating_completed': 'task_completed',
    'agent:waiting_approval': 'task_approval_needed',
    'agent:stopped': 'task_failed',
    'monitor:long_generating': 'task_stalled',
};

function isMeshCoordinatorEvent(eventName: unknown): eventName is string {
    return typeof eventName === 'string' && MESH_COORDINATOR_EVENTS.has(eventName);
}

function formatCompletionMetadata(event: Record<string, unknown>): string {
    const completionDiagnostic = event.completionDiagnostic && typeof event.completionDiagnostic === 'object'
        ? event.completionDiagnostic as Record<string, unknown>
        : null;
    const diagnosticReason = completionDiagnostic
        ? readNonEmptyString(completionDiagnostic.blockReason) || 'present'
        : '';
    const finalAssistantPresent = typeof completionDiagnostic?.finalAssistantPresent === 'boolean'
        ? String(completionDiagnostic.finalAssistantPresent)
        : '';
    const parts = [
        readNonEmptyString(event.targetSessionId) ? `session_id=${readNonEmptyString(event.targetSessionId)}` : '',
        readNonEmptyString(event.providerType) ? `provider=${readNonEmptyString(event.providerType)}` : '',
        readNonEmptyString(event.providerSessionId) ? `provider_session_id=${readNonEmptyString(event.providerSessionId)}` : '',
        diagnosticReason ? `completion_diagnostic=${diagnosticReason}` : '',
        finalAssistantPresent ? `final_assistant=${finalAssistantPresent}` : '',
    ].filter(Boolean);
    return parts.length > 0 ? ` (${parts.join('; ')})` : '';
}

function getMeshWithCache(components: DaemonComponents, meshId: string): any | undefined {
    const localMesh = getMesh(meshId);
    if (localMesh) return localMesh;
    return components.router?.getCachedInlineMesh(meshId);
}

const INTENTIONAL_CLEANUP_STOP_SUPPRESSION_MS = 30 * 60 * 1000;

function isIntentionalCleanupStopMetadata(event: Record<string, unknown>): boolean {
    return event.intentional === true
        || event.intentionalStop === true
        || event.operatorCleanup === true
        || event.reason === 'operator_cleanup'
        || event.stopReason === 'operator_cleanup'
        || event.cleanupReason === 'operator_cleanup'
        || event.source === 'mesh_cleanup_sessions'
        || event.source === 'mesh_remove_node';
}

function hasRecentIntentionalCleanupStop(meshId: string, sessionId?: string, nodeId?: string): boolean {
    if (!sessionId && !nodeId) return false;
    const cutoff = Date.now() - INTENTIONAL_CLEANUP_STOP_SUPPRESSION_MS;
    const entries = readLedgerEntries(meshId);
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        const timestamp = new Date(entry.timestamp).getTime();
        if (!Number.isNaN(timestamp) && timestamp < cutoff) break;
        if (!isIntentionalCleanupStopEntry(entry)) continue;
        if (sessionId && entry.sessionId === sessionId) return true;
        if (!sessionId && nodeId && entry.nodeId === nodeId) return true;
    }
    return false;
}

function shouldSuppressIntentionalCleanupStop(args: {
    event: string;
    meshId: string;
    metadataEvent: Record<string, unknown>;
    sessionId?: string;
    nodeId?: string;
}): boolean {
    if (args.event !== 'agent:stopped' && args.event !== 'monitor:long_generating') return false;
    if (isIntentionalCleanupStopMetadata(args.metadataEvent)) return true;
    return hasRecentIntentionalCleanupStop(args.meshId, args.sessionId, args.nodeId);
}

const RECENT_COMPLETION_FINGERPRINT_TTL_MS = 10 * 60 * 1000;

function hasFingerprintSeen(fingerprint: string): boolean {
    try {
        return BeadsDB.getInstance().hasCompletionFingerprint(fingerprint);
    } catch {
        return false;
    }
}

function recordFingerprintSeen(fingerprint: string): void {
    try {
        const db = BeadsDB.getInstance();
        db.recordCompletionFingerprint(fingerprint, RECENT_COMPLETION_FINGERPRINT_TTL_MS);
        db.sweepExpiredFingerprints();
    } catch { /* best-effort; duplicate events are preferable to a crash */ }
}

function readEventTimestamp(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function buildMeshCompletionFingerprint(args: {
    meshId: string;
    event: string;
    sessionId: string;
    providerType?: string;
    providerSessionId?: string;
    timestamp?: number | null;
    finalSummary?: string;
    /** When set, scopes the fingerprint to a specific coordinator daemon so
     *  two coordinators processing events from their respective workers don't
     *  suppress each other's completion events. */
    coordinatorDaemonId?: string;
}): string {
    const timestampPart = Number.isFinite(args.timestamp)
        ? String(args.timestamp)
        : readNonEmptyString(args.finalSummary).slice(0, 200);
    return [
        args.meshId,
        args.event,
        args.sessionId,
        args.providerType || '',
        args.providerSessionId || '',
        timestampPart,
        args.coordinatorDaemonId || '',
    ].join('::');
}

function isDuplicateMeshCompletionEvent(args: {
    meshId: string;
    event: string;
    sessionId: string;
    providerType?: string;
    providerSessionId?: string;
    timestamp?: number | null;
    finalSummary?: string;
    coordinatorDaemonId?: string;
}): boolean {
    const fingerprint = buildMeshCompletionFingerprint(args);
    if (!fingerprint) return false;
    if (hasFingerprintSeen(fingerprint)) return true;
    recordFingerprintSeen(fingerprint);
    return false;
}

function isDuplicateRefineTerminalEvent(meshId: string, eventName: string, metadataEvent: Record<string, unknown>): boolean {
    const fingerprint = buildRefineTerminalEventFingerprint(meshId, eventName, metadataEvent);
    if (!fingerprint) return false;
    if (hasFingerprintSeen(fingerprint)) return true;
    recordFingerprintSeen(fingerprint);
    return false;
}

function findRecentTerminalLedgerEvidence(args: {
    meshId: string;
    sessionId?: string;
    nodeId?: string;
}): { id: string; kind: MeshLedgerKind; payload: Record<string, unknown>; timestamp: string } | null {
    if (!args.sessionId && !args.nodeId) return null;
    // Tail-limit: terminal evidence for a just-fired completion will always be in recent entries.
    const entries = readLedgerEntries(args.meshId, { tail: 100 });
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.kind !== 'task_completed' && entry.kind !== 'task_failed' && entry.kind !== 'task_stalled') continue;
        if (args.sessionId && entry.sessionId === args.sessionId) {
            return { id: entry.id, kind: entry.kind, payload: entry.payload || {}, timestamp: entry.timestamp };
        }
        if (!args.sessionId && args.nodeId && entry.nodeId === args.nodeId) {
            return { id: entry.id, kind: entry.kind, payload: entry.payload || {}, timestamp: entry.timestamp };
        }
    }
    return null;
}

// Returns true when a task_dispatched entry for the given session appears AFTER the terminal
// entry (identified by terminalId) in ledger order. Positional (append) order is used rather
// than timestamp comparison because both entries may share the same millisecond.
function hasDispatchAfterTerminal(meshId: string, sessionId: string, terminalId: string): boolean {
    // Only look at recent entries — a new dispatch after a terminal will always be recent.
    const entries = readLedgerEntries(meshId, { tail: 100 });
    let pastTerminal = false;
    for (const entry of entries) {
        if (!pastTerminal) {
            if (entry.id === terminalId) pastTerminal = true;
            continue;
        }
        if (entry.kind === 'task_dispatched' && entry.sessionId === sessionId) return true;
    }
    return false;
}

function buildLongGeneratingCompletionReconciliation(args: {
    meshId: string;
    nodeId?: string;
    nodeLabel: string;
    metadataEvent: Record<string, unknown>;
    sourceInstanceId?: string;
}): Record<string, unknown> | null {
    const sessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
    const nodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
    const providerType = readNonEmptyString(args.metadataEvent.providerType);
    const providerSessionId = readNonEmptyString(args.metadataEvent.providerSessionId);
    const workerResult = readWorkerResultMetadata(args.metadataEvent);
    const completionDiagnostic = readRecord(args.metadataEvent.completionDiagnostic);
    const finalSummary = readNonEmptyString(args.metadataEvent.finalSummary);
    const status = readNonEmptyString(args.metadataEvent.status).toLowerCase();
    const explicitCompletionEvidence = Boolean(
        finalSummary
        || workerResult
        || completionDiagnostic?.finalAssistantPresent === true
        || status === 'idle'
        || status === 'ready'
        || status === 'completed',
    );
    if (explicitCompletionEvidence) {
        return {
            ...args.metadataEvent,
            targetSessionId: sessionId,
            providerType,
            providerSessionId,
            finalSummary,
            source: 'long_generating_reconciliation',
            reconciledFromEvent: 'monitor:long_generating',
            timestamp: args.metadataEvent.timestamp ?? Date.now(),
            completionDiagnostic: {
                ...(completionDiagnostic || {}),
                reconciliationReason: 'provider_completion_evidence',
            },
        };
    }

    const terminal = findRecentTerminalLedgerEvidence({
        meshId: args.meshId,
        sessionId: sessionId || undefined,
        nodeId: nodeId || undefined,
    });
    if (!terminal) return null;
    return {
        ...args.metadataEvent,
        source: 'long_generating_terminal_ledger_suppression',
        terminalLedgerKind: terminal.kind,
        terminalLedgerAt: terminal.timestamp,
    };
}


export function tryAssignQueueTask(
    components: DaemonComponents,
    meshId: string,
    nodeId: string,
    sessionId: string,
    providerType: string
): boolean {
    const task = claimNextTask(meshId, nodeId, sessionId);
    if (!task) {
        return false;
    }

    LOG.info('MeshQueue', `Node ${nodeId} (${sessionId}) pulled task ${task.id}`);

    // Check if the node is remote
    const mesh = getMeshWithCache(components, meshId);
    const node = mesh?.nodes.find((n: any) => n.id === nodeId);
    
    // If the node is explicitly remote and we have a dispatch mechanism, route via P2P
    if (node?.daemonId && components.dispatchMeshCommand) {
        const isLocalNode = components.cliManager.adapters.has(sessionId);
        if (!isLocalNode) {
            components.dispatchMeshCommand(node.daemonId, 'agent_command', {
                targetSessionId: sessionId,
                cliType: providerType,
                action: 'send_chat',
                message: task.message,
            }).catch((e: any) => {
                LOG.error('MeshQueue', `Failed to dispatch task via P2P to remote node ${nodeId}: ${e?.message}`);
                // Revert to pending so the task can be retried rather than permanently failing
                updateTaskStatus(meshId, task.id, 'pending');
                try {
                    appendLedgerEntry(meshId, {
                        kind: 'dispatch_failed' as any,
                        nodeId,
                        sessionId,
                        payload: { taskId: task.id, error: e?.message, retryable: true },
                    });
                } catch { /* ledger write is best-effort */ }
            });
            return true;
        }
    }

    // Local routing
    components.cliManager.handleCliCommand('agent_command', {
        targetSessionId: sessionId,
        cliType: providerType,
        action: 'send_chat',
        message: task.message,
    }).catch((e: any) => {
        LOG.error('MeshQueue', `Failed to dispatch task locally to node ${nodeId}: ${e?.message}`);
        updateTaskStatus(meshId, task.id, 'failed');
    });

    return true;
}

const autoLaunchInProgress = new Set<string>();
const autoLaunchCooldownUntil = new Map<string, number>();
const AUTO_LAUNCH_COOLDOWN_MS = 5_000;

function normalizeProviderPriority(policy: unknown): string[] {
    const raw = policy && typeof policy === 'object' && !Array.isArray(policy)
        ? (policy as Record<string, unknown>).providerPriority
        : undefined;
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    return raw
        .map(type => typeof type === 'string' ? type.trim() : '')
        .filter(Boolean)
        .filter(type => {
            if (seen.has(type)) return false;
            seen.add(type);
            return true;
        });
}

function isTerminalSessionStatus(status: string): boolean {
    return ['stopped', 'failed', 'terminated', 'exited', 'closed'].includes(status);
}

function isIdleSessionState(state: any): boolean {
    const status = readNonEmptyString(state?.status).toLowerCase();
    if (isTerminalSessionStatus(status)) return false;
    return status === 'idle' || state?.activeChat?.status === 'waiting_input';
}

function isDirtyNode(node: any): boolean {
    return node?.health === 'dirty' || node?.git?.dirty === true;
}

function isLaunchableNode(node: any): boolean {
    if (!node || node.status === 'disabled' || node.status === 'removed') return false;
    const health = readNonEmptyString(node.health).toLowerCase();
    if (!health) return true;
    return health === 'online' || health === 'unknown';
}

function localAutoLaunchSkipReason(node: any): string | null {
    const daemonId = readNonEmptyString(node?.daemonId);
    const machineId = readNonEmptyString(node?.machineId);
    const appConfig = loadConfig();
    const localMachineId = readNonEmptyString(appConfig.machineId) || readNonEmptyString(appConfig.registeredMachineId);
    const cloudDaemonId = localMachineId ? `daemon_${localMachineId}` : '';
    const standaloneDaemonId = localMachineId ? `standalone_${localMachineId}` : '';

    const daemonMatchesLocal = !daemonId || daemonId === cloudDaemonId || daemonId === standaloneDaemonId;
    const machineMatchesLocal = !machineId || (localMachineId && machineId === localMachineId);

    // ADHDev-managed local worktrees are explicitly safe to launch locally, but
    // still must not be auto-launched if their metadata points at another
    // daemon/machine. Remote nodes require an explicit coordinator launch path.
    if (node?.isLocalWorktree === true) {
        return daemonMatchesLocal && machineMatchesLocal ? null : 'remote_auto_launch_unsupported';
    }

    // Legacy/local workspace nodes may not have daemon/machine metadata. If
    // metadata is present, require it to identify this daemon/machine before
    // using the local cliManager.launch_cli path.
    if (daemonId || machineId) {
        return daemonMatchesLocal && machineMatchesLocal ? null : 'remote_auto_launch_unsupported';
    }

    return null;
}

function activeAssignedCount(meshId: string): number {
    return getQueue(meshId, { status: ['assigned'] as any }).length;
}

function nodeHasActiveAssignment(meshId: string, nodeId: string): boolean {
    return getQueue(meshId, { status: ['assigned'] as any }).some(task => task.assignedNodeId === nodeId);
}

function sessionHasActiveAssignment(meshId: string, sessionId: string): boolean {
    return getQueue(meshId, { status: ['assigned'] as any }).some(task => task.assignedSessionId === sessionId);
}

function liveSessionCountForNode(components: DaemonComponents, meshId: string, nodeId: string): number {
    return components.instanceManager.getByCategory('cli').filter((inst: any) => {
        const state = inst.getState();
        const settings = state.settings as Record<string, unknown> || {};
        if (readNonEmptyString(settings.meshNodeFor) !== meshId) return false;
        const instNodeId = readNonEmptyString(settings.meshNodeId) || readNonEmptyString(settings.nodeId);
        if (instNodeId !== nodeId) return false;
        const status = readNonEmptyString(state.status).toLowerCase();
        return !isTerminalSessionStatus(status);
    }).length;
}

function recordAutoLaunchEvent(meshId: string, args: {
    phase: 'skipped' | 'started' | 'failed' | 'completed';
    taskId: string;
    nodeId?: string;
    providerType?: string;
    sessionId?: string;
    reason?: string;
    error?: string;
}) {
    try {
        appendLedgerEntry(meshId, {
            kind: 'session_auto_launch',
            nodeId: args.nodeId,
            sessionId: args.sessionId,
            providerType: args.providerType,
            payload: {
                phase: args.phase,
                taskId: args.taskId,
                reason: args.reason,
                error: args.error,
            },
        });
    } catch (e: any) {
        LOG.warn('MeshQueue', `Failed to record auto-launch ledger event: ${e?.message || e}`);
    }
}

function markAutoLaunch(meshId: string, taskId: string, args: {
    status: 'skipped' | 'started' | 'failed' | 'completed';
    reason?: string;
    nodeId?: string;
    providerType?: string;
    sessionId?: string;
    error?: string;
}) {
    recordTaskAutoLaunch(meshId, taskId, {
        status: args.status,
        reason: args.reason || args.error,
        nodeId: args.nodeId,
        providerType: args.providerType,
        sessionId: args.sessionId,
    });
    recordAutoLaunchEvent(meshId, {
        phase: args.status,
        taskId,
        nodeId: args.nodeId,
        providerType: args.providerType,
        sessionId: args.sessionId,
        reason: args.reason,
        error: args.error,
    });
}

async function resolveUsableProvider(components: DaemonComponents, nodeId: string, node: any): Promise<{ providerType?: string; reason?: string }> {
    const providerPriority = normalizeProviderPriority(node?.policy);
    if (!providerPriority.length) return { reason: 'missing_provider_priority' };
    const providerLoader = components.providerLoader;
    if (!providerLoader) return { reason: 'provider_loader_unavailable' };

    const failed: string[] = [];
    for (const requestedType of providerPriority) {
        const normalizedType = typeof providerLoader.resolveAlias === 'function'
            ? providerLoader.resolveAlias(requestedType)
            : requestedType;
        if (typeof providerLoader.isMachineProviderEnabled === 'function' && !providerLoader.isMachineProviderEnabled(normalizedType)) {
            failed.push(`${requestedType}: disabled`);
            continue;
        }
        let detected: any;
        try {
            detected = await detectCLI(normalizedType, providerLoader, { includeVersion: false });
        } catch (e: any) {
            failed.push(`${requestedType}: detect failed: ${e?.message || e}`);
            continue;
        }
        if (typeof providerLoader.setCliDetectionResults === 'function') {
            providerLoader.setCliDetectionResults([{
                id: normalizedType,
                installed: !!detected,
                path: detected?.path,
            }], false);
        }
        (components as any).onStatusChange?.();
        if (detected) return { providerType: normalizedType };
        failed.push(`${requestedType}: not detected`);
    }
    return { reason: `provider_priority_unusable: ${failed.join('; ') || nodeId}` };
}

async function maybeAutoLaunchOneQueueSession(components: DaemonComponents, meshId: string, mesh: any): Promise<boolean> {
    const queue = getQueue(meshId);
    const pending = queue.filter(task => task.status === 'pending');
    if (!pending.length) return false;

    const maxParallelTasks = Math.max(1, Math.floor(Number(mesh?.policy?.maxParallelTasks) || 2));
    for (const task of pending) {
        if (activeAssignedCount(meshId) >= maxParallelTasks) {
            markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'max_parallel_tasks_reached' });
            return false;
        }
        if (task.targetSessionId) {
            markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'target_session_constraint' });
            continue;
        }

        const candidateNodes = Array.isArray(mesh?.nodes)
            ? mesh.nodes.filter((node: any) => task.targetNodeId ? node?.id === task.targetNodeId : true)
            : [];
        if (!candidateNodes.length) {
            markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'no_matching_node', nodeId: task.targetNodeId });
            continue;
        }

        for (const node of candidateNodes) {
            const nodeId = readNonEmptyString(node?.id);
            if (!nodeId) continue;
            const launchKey = `${meshId}:${nodeId}`;
            const cooldownUntil = autoLaunchCooldownUntil.get(launchKey) || 0;
            if (autoLaunchInProgress.has(launchKey)) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'auto_launch_in_progress', nodeId });
                continue;
            }
            if (Date.now() < cooldownUntil) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'auto_launch_cooldown', nodeId });
                continue;
            }
            if (isDirtyNode(node)) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'dirty_workspace', nodeId });
                continue;
            }
            if (!isLaunchableNode(node)) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'node_not_launch_ready', nodeId });
                continue;
            }
            const localSkipReason = localAutoLaunchSkipReason(node);
            if (localSkipReason) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: localSkipReason, nodeId });
                continue;
            }
            if (nodeHasActiveAssignment(meshId, nodeId)) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'node_has_active_assignment', nodeId });
                continue;
            }
            const maxConcurrentSessions = Number(node?.policy?.maxConcurrentSessions);
            if (Number.isFinite(maxConcurrentSessions) && maxConcurrentSessions >= 0 && liveSessionCountForNode(components, meshId, nodeId) >= maxConcurrentSessions) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'max_concurrent_sessions_reached', nodeId });
                continue;
            }

            autoLaunchInProgress.add(launchKey);
            try {
                const resolved = await resolveUsableProvider(components, nodeId, node);
                if (!resolved.providerType) {
                    markAutoLaunch(meshId, task.id, { status: 'skipped', reason: resolved.reason || 'provider_unusable', nodeId });
                    continue;
                }

                markAutoLaunch(meshId, task.id, { status: 'started', nodeId, providerType: resolved.providerType });
                const launchResult: any = await components.cliManager.handleCliCommand('launch_cli', {
                    cliType: resolved.providerType,
                    dir: node.workspace,
                    settings: {
                        meshNodeFor: meshId,
                        meshNodeId: nodeId,
                        spawnedSessionVisibility: mesh?.policy?.spawnedSessionVisibility || 'hidden',
                        launchedByCoordinator: true,
                        autoLaunchedForQueueTaskId: task.id,
                    },
                });
                if (!launchResult?.success) {
                    const reason = launchResult?.error || 'launch_cli_failed';
                    markAutoLaunch(meshId, task.id, { status: 'failed', reason, nodeId, providerType: resolved.providerType });
                    autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS);
                    return false;
                }
                const sessionId = readNonEmptyString(launchResult.sessionId) || readNonEmptyString(launchResult.id) || readNonEmptyString(launchResult.runtimeSessionId);
                if (!sessionId) {
                    markAutoLaunch(meshId, task.id, { status: 'failed', reason: 'launch_missing_session_id', nodeId, providerType: resolved.providerType });
                    autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS);
                    return false;
                }
                markAutoLaunch(meshId, task.id, { status: 'completed', nodeId, providerType: resolved.providerType, sessionId });
                tryAssignQueueTask(components, meshId, nodeId, sessionId, resolved.providerType);
                return true;
            } catch (e: any) {
                markAutoLaunch(meshId, task.id, { status: 'failed', error: e?.message || String(e), nodeId });
                autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS);
                return false;
            } finally {
                autoLaunchInProgress.delete(launchKey);
            }
        }
    }
    return false;
}

/**
 * Triggers a queue check for all nodes in the mesh.
 * Called when a new task is enqueued, in case nodes are already idle.
 */
export async function triggerMeshQueue(components: DaemonComponents, meshId: string): Promise<void> {
    const mesh = getMeshWithCache(components, meshId);
    if (!mesh) return;

    // Find all CLI instances that belong to this mesh and are idle
    const cliInstances = components.instanceManager.getByCategory('cli');
    for (const inst of cliInstances) {
        const state = inst.getState();
        const settings = state.settings as Record<string, unknown> || {};
        
        const instMeshId = readNonEmptyString(settings.meshNodeFor);
        if (instMeshId !== meshId) continue;

        const nodeId = readNonEmptyString(settings.meshNodeId) || readNonEmptyString(settings.nodeId);
        if (!nodeId) continue;

        // Only genuinely idle live sessions can pull work. Restored/stopped
        // records are kept for transcript/recovery visibility, but assigning
        // queue items to them strands tasks in assigned/pending without chat.
        if (!isIdleSessionState(state)) continue;

        const sessionId = state.instanceId;
        const providerType = state.type || readNonEmptyString(settings.providerType);
        
        if (providerType) {
            // Try to assign a task to this idle node
            tryAssignQueueTask(components, meshId, nodeId, sessionId, providerType);
        }
    }

    // Also check known idle remote sessions
    for (const [key, idle] of remoteIdleSessions.entries()) {
        // Find if this node is in the same mesh
        const node = mesh.nodes.find((n: any) => n.id === idle.nodeId);
        if (node) {
            const assigned = tryAssignQueueTask(components, meshId, idle.nodeId, idle.sessionId, idle.providerType);
            if (assigned) {
                remoteIdleSessions.delete(key);
            }
        }
    }

    await maybeAutoLaunchOneQueueSession(components, meshId, mesh);
}

function buildMeshSystemMessage(args: {
    event: string;
    nodeLabel: string;
    metadataEvent: Record<string, unknown>;
    recoveryContext?: SessionRecoveryContext | null;
}): string {
    const metadata = formatCompletionMetadata(args.metadataEvent);
    if (args.event === 'agent:generating_completed') {
        if (args.metadataEvent.source === 'long_generating_reconciliation') {
            return `[System] ${args.nodeLabel} already has completion evidence${metadata}. The long-generating monitor reconciled the terminal handoff and marked the session complete; wait for the queued completion event/status refresh before doing any manual transcript check.`;
        }
        return `[System] ${args.nodeLabel} has completed its task and is now idle${metadata}. This completion came from the agent status event path; use mesh_read_chat once to review its final progress, but do not poll repeatedly.`;
    }
    if (args.event === 'agent:waiting_approval') {
        return `[System] ${args.nodeLabel} is waiting for approval to proceed${metadata}. You may use mesh_read_chat and mesh_approve to handle it.`;
    }
    if (args.event === 'agent:stopped') {
        const rc = args.recoveryContext;
        if (rc && rc.consecutiveNodeFailures > 0) {
            const parts = [
                `[System] ${args.nodeLabel} has stopped unexpectedly${metadata}.`,
                `\n\n**Recovery Context:**`,
                `- Consecutive failures on this node: ${rc.consecutiveNodeFailures}`,
                rc.taskAttemptCount > 0 ? `- This task has been attempted ${rc.taskAttemptCount} time(s)` : '',
                `- Recommendation: ${rc.advice}`,
            ];
            if (rc.retryRecommended && rc.lastTaskMessage) {
                parts.push(
                    `\n\n**Original task to retry:**`,
                    `> ${rc.lastTaskMessage.length > 300 ? rc.lastTaskMessage.slice(0, 300) + '...' : rc.lastTaskMessage}`,
                    `\nTo retry: call \`mesh_launch_session\` for this node, then \`mesh_send_task\` with the original task.`,
                );
            } else if (!rc.retryRecommended) {
                parts.push(
                    `\nDo NOT retry on this node. Consider reassigning to a different node or asking the user for guidance.`,
                );
            }
            return parts.filter(Boolean).join('\n');
        }
        return `[System] ${args.nodeLabel} has stopped${metadata}. Use mesh_read_chat once if you need to inspect its last output.`;
    }
    if (args.event === 'monitor:long_generating') {
        return `[System] ${args.nodeLabel} is still reported as generating after a long interval${metadata}. Wait for pendingCoordinatorEvents or a completion/status event; if the user explicitly asks for status, make one bounded status check and then wait again.`;
    }
    if (args.event === 'refine:accepted') {
        const jobId = readRefineJobId({ metadataEvent: args.metadataEvent });
        return `[System] Refinery accepted async job${jobId ? ` ${jobId}` : ''} for ${args.nodeLabel}. Completion/failure will be delivered as a terminal refine event; do not poll repeatedly.`;
    }
    if (args.event === 'refine:completed') {
        const jobId = readRefineJobId({ metadataEvent: args.metadataEvent });
        const result = readRecord(args.metadataEvent.result);
        const validationSummary = readRecord(result?.validationSummary);
        const patchEquivalence = readRecord(result?.patchEquivalence);
        const finalConvergence = readRecord(result?.finalBranchConvergenceState);
        const validationStatus = readNonEmptyString(validationSummary?.status);
        const patchStatus = readNonEmptyString(patchEquivalence?.status)
            || (patchEquivalence?.equivalent === true ? 'passed' : '');
        const into = readNonEmptyString(result?.into);
        const branch = readNonEmptyString(result?.branch);
        const mergeStatus = result?.merged === true ? 'merged' : readNonEmptyString(finalConvergence?.status);
        const convergenceStatus = readNonEmptyString(finalConvergence?.status);
        const nextStep = readNonEmptyString(result?.nextStep)
            || readNonEmptyString(finalConvergence?.nextStep)
            || 'Continue from the updated mesh state.';
        const details = [
            jobId ? `job_id=${jobId}` : '',
            branch && into ? `${branch}→${into}` : '',
            validationStatus ? `validation=${validationStatus}` : '',
            patchStatus ? `patch_equivalence=${patchStatus}` : '',
            mergeStatus ? `merge=${mergeStatus}` : '',
            convergenceStatus ? `final_convergence=${convergenceStatus}` : '',
        ].filter(Boolean).join('; ');
        return `[System] Refinery async job for ${args.nodeLabel} completed successfully${details ? ` (${details})` : ''}.\nNext step: ${nextStep}`;
    }
    if (args.event === 'refine:failed') {
        const jobId = readRefineJobId({ metadataEvent: args.metadataEvent });
        const result = readRecord(args.metadataEvent.result);
        const validationSummary = readRecord(result?.validationSummary);
        const patchEquivalence = readRecord(result?.patchEquivalence);
        const finalConvergence = readRecord(result?.finalBranchConvergenceState);
        const code = readNonEmptyString(result?.code);
        const error = readNonEmptyString(result?.error);
        const validationStatus = readNonEmptyString(validationSummary?.status);
        const patchStatus = readNonEmptyString(patchEquivalence?.status)
            || (patchEquivalence?.equivalent === true ? 'passed' : '');
        const mergeStatus = result?.merged === true
            ? 'merged'
            : finalConvergence?.merged === false
                ? 'not_merged'
                : '';
        const convergenceStatus = readNonEmptyString(result?.convergenceStatus)
            || readNonEmptyString(finalConvergence?.status);
        const blockedReason = readNonEmptyString(result?.blockedReason);
        const nextStep = readNonEmptyString(result?.nextStep) || readNonEmptyString(finalConvergence?.nextStep);
        const details = [
            jobId ? `job_id=${jobId}` : '',
            code ? `code=${code}` : '',
            validationStatus ? `validation=${validationStatus}` : '',
            patchStatus ? `patch_equivalence=${patchStatus}` : '',
            mergeStatus ? `merge=${mergeStatus}` : '',
            convergenceStatus ? `convergence=${convergenceStatus}` : '',
            blockedReason ? `reason=${blockedReason}` : '',
        ].filter(Boolean).join('; ');
        const parts = [
            `[System] Refinery async job for ${args.nodeLabel} failed${details ? ` (${details})` : ''}${error ? `: ${error}` : '.'}`,
            nextStep ? `Next step: ${nextStep}` : 'Review the terminal refine event/ledger before retrying.',
        ];
        return parts.join('\n');
    }
    return '';
}

function injectMeshSystemMessage(components: DaemonComponents, args: {
    meshId: string;
    sourceInstanceId?: string;
    nodeId?: string;
    nodeLabel: string;
    event: string;
    metadataEvent: Record<string, unknown>;
}) {
    const eventSessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
    const eventNodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);

    // Resolve coordinator ownership early — used in fingerprinting and coordinator routing.
    const sourceSession = args.sourceInstanceId
        ? components.instanceManager.getInstance(args.sourceInstanceId)
        : undefined;
    const workerCoordinatorDaemonId = readNonEmptyString(
        (sourceSession?.getState()?.settings as Record<string, unknown>)?.meshCoordinatorDaemonId,
    );
    const localDaemonId = readNonEmptyString(loadConfig().machineId);
    const intentionalCleanupStop = shouldSuppressIntentionalCleanupStop({
        event: args.event,
        meshId: args.meshId,
        metadataEvent: args.metadataEvent,
        sessionId: eventSessionId || undefined,
        nodeId: eventNodeId || undefined,
    });
    if (intentionalCleanupStop) {
        if (eventSessionId && eventNodeId) {
            remoteIdleSessions.delete(`${eventNodeId}:${eventSessionId}`);
        }
        LOG.info('MeshEvents', `Suppressed ${args.event} for intentionally cleanup-stopped session ${eventSessionId || '(unknown session)'}`);
        return { success: true, forwarded: 0, suppressed: true, intentionalCleanupStop: true };
    }

    if (args.event === 'monitor:long_generating') {
        const reconciledCompletion = buildLongGeneratingCompletionReconciliation({
            meshId: args.meshId,
            nodeId: args.nodeId,
            nodeLabel: args.nodeLabel,
            metadataEvent: args.metadataEvent,
            sourceInstanceId: args.sourceInstanceId,
        });
        if (reconciledCompletion?.source === 'long_generating_reconciliation') {
            LOG.info('MeshEvents', `Reconciled long-generating monitor to completion for session ${eventSessionId || '(unknown session)'}`);
            return injectMeshSystemMessage(components, {
                ...args,
                event: 'agent:generating_completed',
                metadataEvent: reconciledCompletion,
            });
        }
        if (reconciledCompletion?.source === 'long_generating_terminal_ledger_suppression') {
            LOG.info('MeshEvents', `Suppressed long-generating monitor because terminal ledger evidence already exists for session ${eventSessionId || '(unknown session)'}`);
            return {
                success: true,
                forwarded: 0,
                suppressed: true,
                terminalLedgerEvidence: true,
                terminalLedgerKind: reconciledCompletion.terminalLedgerKind,
            };
        }
    }

    if (isDuplicateRefineTerminalEvent(args.meshId, args.event, args.metadataEvent)) {
        LOG.info('MeshEvents', `Suppressed duplicate ${args.event} for refine job ${readRefineJobId({ metadataEvent: args.metadataEvent })}`);
        return { success: true, forwarded: 0, suppressed: true, duplicateRefineTerminalEvent: true };
    }

    const eventTimestamp = readEventTimestamp(args.metadataEvent.timestamp);
    if (args.event === 'agent:generating_completed' && eventSessionId) {
        const terminal = findRecentTerminalLedgerEvidence({
            meshId: args.meshId,
            sessionId: eventSessionId,
            nodeId: eventNodeId || undefined,
        });
        if (terminal?.kind === 'task_completed' && !sessionHasActiveAssignment(args.meshId, eventSessionId)) {
            // If a new task_dispatched was recorded for this session after the prior terminal,
            // this completion belongs to the new task — never suppress it as a duplicate.
            const newDispatchAfterTerminal = hasDispatchAfterTerminal(args.meshId, eventSessionId, terminal.id);
            if (!newDispatchAfterTerminal) {
                const terminalProviderSessionId = readNonEmptyString(terminal.payload.providerSessionId);
                const terminalFinalSummary = readNonEmptyString(terminal.payload.finalSummary);
                const eventProviderSessionId = readNonEmptyString(args.metadataEvent.providerSessionId);
                const eventFinalSummary = readNonEmptyString(args.metadataEvent.finalSummary);
                if (
                    (terminalProviderSessionId && terminalProviderSessionId === eventProviderSessionId)
                    || (terminalFinalSummary && terminalFinalSummary === eventFinalSummary)
                    || args.metadataEvent.source === 'long_generating_reconciliation'
                ) {
                    LOG.info('MeshEvents', `Suppressed duplicate completion with existing terminal ledger evidence for mesh ${args.meshId} session ${eventSessionId}`);
                    return { success: true, forwarded: 0, suppressed: true, duplicateCompletion: true, terminalLedgerEvidence: true };
                }
            }
        }
        const duplicateCompletion = isDuplicateMeshCompletionEvent({
            meshId: args.meshId,
            event: args.event,
            sessionId: eventSessionId,
            providerType: readNonEmptyString(args.metadataEvent.providerType) || undefined,
            providerSessionId: readNonEmptyString(args.metadataEvent.providerSessionId) || undefined,
            timestamp: eventTimestamp,
            finalSummary: readNonEmptyString(args.metadataEvent.finalSummary) || undefined,
            // Scope dedup to the coordinator daemon so two coordinators for the same mesh
            // don't suppress each other's completion events via shared fingerprint table.
            coordinatorDaemonId: workerCoordinatorDaemonId || undefined,
        });
        if (duplicateCompletion) {
            LOG.info('MeshEvents', `Suppressed duplicate completion for mesh ${args.meshId} session ${eventSessionId}`);
            return { success: true, forwarded: 0, suppressed: true, duplicateCompletion: true };
        }
    }

    // ── Task Queue & Ledger ──
    let completedTaskForLedger: { id?: string } | null = null;
    if (args.event === 'agent:generating_completed') {
        const sessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
        const nodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
        const providerType = readNonEmptyString(args.metadataEvent.providerType);
        
        if (sessionId) {
            const completedTask = updateSessionTaskStatus(args.meshId, sessionId, 'completed', {
                occurredAt: eventTimestamp !== null ? new Date(eventTimestamp).toISOString() : undefined,
            });
            completedTaskForLedger = completedTask ? { id: completedTask.id } : null;
            updateDirectDispatchStatus(args.meshId, sessionId, 'completed');
            setImmediate(() => cleanupTerminalDirectDispatches());
            if (nodeId && providerType) {
                setImmediate(() => {
                    tryAssignQueueTask(components, args.meshId, nodeId, sessionId, providerType);
                });
            }
        }
    } else if (args.event === 'agent:ready') {
        const sessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
        const nodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
        const providerType = readNonEmptyString(args.metadataEvent.providerType);
        const providerSessionId = readNonEmptyString(args.metadataEvent.providerSessionId) || undefined;
        const finalSummary = readNonEmptyString(args.metadataEvent.finalSummary) || undefined;
        const workerResult = readWorkerResultMetadata(args.metadataEvent);
        const hasCompletionEvidence = !!finalSummary || !!workerResult;
        const completedTask = sessionId && hasCompletionEvidence
            ? updateSessionTaskStatus(args.meshId, sessionId, 'completed')
            : null;
        if (completedTask && sessionId) {
            completedTaskForLedger = { id: completedTask.id };
            updateDirectDispatchStatus(args.meshId, sessionId, 'completed');
            setImmediate(() => cleanupTerminalDirectDispatches());
            try {
                appendLedgerEntry(args.meshId, {
                    kind: 'task_completed',
                    nodeId: nodeId || undefined,
                    sessionId,
                    providerType: providerType || undefined,
                    payload: {
                        event: args.event,
                        nodeLabel: args.nodeLabel,
                        taskId: completedTask.id,
                        completedViaReady: true,
                        providerSessionId,
                        finalSummary,
                        workerResult,
                        evidence: buildTaskCompletionEvidence({
                            event: 'agent:ready',
                            nodeId,
                            sessionId,
                            providerType: providerType || undefined,
                            providerSessionId,
                            finalSummary,
                            workerResult,
                        }),
                    },
                });
            } catch (e: any) {
                LOG.warn('MeshLedger', `Failed to record task_completed from ready: ${e?.message || e}`);
            }
        }
        
        if (sessionId && nodeId && providerType) {
            sweepExpiredRemoteIdleSessions();
            remoteIdleSessions.set(`${nodeId}:${sessionId}`, {
                nodeId, sessionId, providerType,
                expiresAt: Date.now() + REMOTE_IDLE_SESSION_TTL_MS,
            });
            setImmediate(() => {
                const assigned = tryAssignQueueTask(components, args.meshId, nodeId, sessionId, providerType);
                if (assigned) remoteIdleSessions.delete(`${nodeId}:${sessionId}`);
            });
        }
    } else if (args.event === 'agent:generating_started') {
        const sessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
        const nodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
        if (sessionId && nodeId) {
            remoteIdleSessions.delete(`${nodeId}:${sessionId}`);
        }
        if (sessionId) {
            // Mark direct dispatch as acknowledged — the session started generating.
            updateDirectDispatchStatus(args.meshId, sessionId, 'acked');
        }
    } else if (args.event === 'agent:stopped') {
        const sessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
        const nodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
        if (sessionId && nodeId) {
            remoteIdleSessions.delete(`${nodeId}:${sessionId}`);
        }
        if (sessionId) {
            const failedTask = updateSessionTaskStatus(args.meshId, sessionId, 'failed');
            completedTaskForLedger = failedTask ? { id: failedTask.id } : null;
            updateDirectDispatchStatus(args.meshId, sessionId, 'failed');
        }
    }

    const ledgerKind = EVENT_TO_LEDGER_KIND[args.event];
    if (ledgerKind) {
        try {
            const ledgerNodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId) || undefined;
            const ledgerSessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId) || undefined;
            const ledgerProviderType = readNonEmptyString(args.metadataEvent.providerType) || undefined;
            const providerSessionId = readNonEmptyString(args.metadataEvent.providerSessionId) || undefined;
            const finalSummary = readNonEmptyString(args.metadataEvent.finalSummary) || undefined;
            const workerResult = readWorkerResultMetadata(args.metadataEvent);
            const completionEvidence = ledgerKind === 'task_completed' && ledgerNodeId && ledgerSessionId
                ? buildTaskCompletionEvidence({
                    event: 'agent:generating_completed',
                    nodeId: ledgerNodeId,
                    sessionId: ledgerSessionId,
                    providerType: ledgerProviderType,
                    providerSessionId,
                    finalSummary,
                    workerResult,
                })
                : undefined;
            appendLedgerEntry(args.meshId, {
                kind: ledgerKind,
                nodeId: ledgerNodeId,
                sessionId: ledgerSessionId,
                providerType: ledgerProviderType,
                payload: {
                    event: args.event,
                    nodeLabel: args.nodeLabel,
                    taskId: completedTaskForLedger?.id || undefined,
                    providerSessionId,
                    finalSummary,
                    workerResult,
                    completionDiagnostic: args.metadataEvent.completionDiagnostic && typeof args.metadataEvent.completionDiagnostic === 'object'
                        ? args.metadataEvent.completionDiagnostic
                        : undefined,
                    evidence: completionEvidence,
                },
            });
        } catch (e: any) {
            LOG.warn('MeshLedger', `Failed to record ${ledgerKind}: ${e?.message || e}`);
        }
    }

    // ── Recovery Context: enrich agent:stopped with retry intelligence ──
    let recoveryContext: SessionRecoveryContext | null = null;
    if (args.event === 'agent:stopped') {
        try {
            // Resolve maxTaskRetries from mesh policy
            const mesh = getMesh(args.meshId);
            const maxRetries = mesh?.policy?.maxTaskRetries ?? 1;

            recoveryContext = getSessionRecoveryContext(args.meshId, {
                sessionId: resolveEventSessionId(args.metadataEvent, args.sourceInstanceId) || undefined,
                nodeId: readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId) || undefined,
                maxRetries,
            });
            recoveryContext.failedProviderType = readNonEmptyString(args.metadataEvent.providerType) || null;

            // Record recovery_attempted if retry is recommended
            if (recoveryContext.retryRecommended && recoveryContext.consecutiveNodeFailures > 0) {
                appendLedgerEntry(args.meshId, {
                    kind: 'recovery_attempted',
                    nodeId: recoveryContext.failedNodeId || undefined,
                    sessionId: recoveryContext.failedSessionId || undefined,
                    providerType: recoveryContext.failedProviderType || undefined,
                    payload: {
                        consecutiveFailures: recoveryContext.consecutiveNodeFailures,
                        taskAttemptCount: recoveryContext.taskAttemptCount,
                        retryRecommended: recoveryContext.retryRecommended,
                        advice: recoveryContext.advice,
                    },
                });

                // Auto-Recovery (Phase 5): Automatically re-enqueue the task and re-launch the session
                if (recoveryContext.lastTaskMessage && recoveryContext.failedNodeId && recoveryContext.failedProviderType) {
                    const autoNodeId = recoveryContext.failedNodeId;
                    try {
                        const task = enqueueTask(args.meshId, recoveryContext.lastTaskMessage, {
                            targetNodeId: autoNodeId
                        });
                        LOG.info('MeshRecovery', `Auto-requeued failed task: ${task.id} for node ${autoNodeId}`);

                        const node = mesh?.nodes.find(n => n.id === autoNodeId);
                        if (node) {
                            components.cliManager.handleCliCommand('launch_cli', {
                                cliType: recoveryContext.failedProviderType,
                                dir: node.workspace,
                                settings: {
                                    meshNodeFor: args.meshId,
                                    meshNodeId: node.id,
                                    spawnedSessionVisibility: mesh?.policy?.spawnedSessionVisibility || 'hidden',
                                    launchedByCoordinator: true,
                                }
                            }).catch((e: any) => LOG.error('MeshRecovery', `Failed to auto-relaunch session for ${node.id}: ${e?.message}`));
                        }
                    } catch (e: any) {
                        LOG.warn('MeshRecovery', `Failed to execute auto-recovery: ${e?.message}`);
                    }
                }
            }

            LOG.info('MeshRecovery', `Recovery context for ${args.nodeLabel}: ${recoveryContext.advice}`);
        } catch (e: any) {
            LOG.warn('MeshRecovery', `Failed to build recovery context: ${e?.message || e}`);
        }
    }

    const messageText = buildMeshSystemMessage({
        event: args.event,
        nodeLabel: args.nodeLabel,
        metadataEvent: args.metadataEvent,
        recoveryContext,
    });
    if (!messageText) return { success: false, error: 'unsupported mesh event' };

    const coordinatorInstances = components.instanceManager.getByCategory('cli').filter((inst) => {
        const instState = inst.getState();
        if (instState.settings?.meshCoordinatorFor !== args.meshId) return false;
        if (args.sourceInstanceId && instState.instanceId === args.sourceInstanceId) return false;
        // If the worker knows which coordinator daemon launched it, only route to coordinators
        // on that specific daemon. This prevents cross-contamination when multiple coordinator
        // sessions run simultaneously for the same mesh on different daemons.
        if (workerCoordinatorDaemonId && localDaemonId && workerCoordinatorDaemonId !== localDaemonId) return false;
        return true;
    });

    // Refine terminal events (refine:completed, refine:failed) are coordinator-delivered
    // synchronously; only buffer them for MCP when no CLI coordinator is present.
    // Agent runtime events (agent:*) use dual delivery so both CLI and MCP coordinators
    // receive them regardless of whether a live CLI coordinator session is active.
    const isRefineTerminalEvent = REFINE_TERMINAL_EVENTS.has(args.event);

    if (coordinatorInstances.length === 0) {
        // No local CLI coordinator — buffer for MCP-based coordinator on the target daemon.
        if (queuePendingMeshCoordinatorEvent({
                event: args.event,
                meshId: args.meshId,
                nodeLabel: args.nodeLabel,
                nodeId: args.nodeId || undefined,
                workspace: readNonEmptyString(args.metadataEvent.workspace),
                metadataEvent: {
                    ...args.metadataEvent,
                    ...(recoveryContext ? { recoveryContext } : {}),
                },
                coordinatorMessage: messageText,
                queuedAt: Date.now(),
                // Scope to the coordinator daemon that launched this worker so drain
                // by other coordinators on the same daemon doesn't consume this event.
                ...(workerCoordinatorDaemonId ? { targetCoordinatorDaemonId: workerCoordinatorDaemonId } : {}),
            })) {
            LOG.info('MeshEvents', `Queued ${args.event} for MCP coordinator (mesh ${args.meshId}${workerCoordinatorDaemonId ? `, coordinator daemon ${workerCoordinatorDaemonId}` : ''})`);
        }
        return { success: true, forwarded: 0 };
    }

    // CLI coordinator is present. For non-refine events, also buffer for MCP coordinators
    // that poll via get_pending_mesh_events (dual delivery). Refine terminal events are
    // forwarded directly only — they must not accumulate in the pending queue when a live
    // coordinator already received them.
    //
    // Exception: if ALL live CLI coordinator instances are in a generating/active state
    // when a refine terminal event fires (e.g. a Codex CLI coordinator that triggered an
    // async refine job and is still in the generating turn that sent it), the coordinator
    // cannot immediately receive send_message input. Buffer the event to the pending queue
    // so it is available via get_pending_mesh_events when the coordinator returns to idle.
    // Critically: do NOT attempt send_message injection into a generating PTY coordinator for
    // terminal refine events — injecting text into an active PTY can corrupt the input stream
    // and leave the coordinator stuck in generating state, unable to process the refine result.
    const allCoordinatorsGenerating = isRefineTerminalEvent && coordinatorInstances.every((inst) => {
        const s = inst.getState();
        const status = readNonEmptyString(s.status).toLowerCase();
        const activeChatStatus = readNonEmptyString(s.activeChat?.status).toLowerCase();
        return status === 'generating' || status === 'streaming' || status === 'long_generating'
            || activeChatStatus === 'generating' || activeChatStatus === 'streaming';
    });

    if (!isRefineTerminalEvent || allCoordinatorsGenerating) {
        if (queuePendingMeshCoordinatorEvent({
                event: args.event,
                meshId: args.meshId,
                nodeLabel: args.nodeLabel,
                nodeId: args.nodeId || undefined,
                workspace: readNonEmptyString(args.metadataEvent.workspace),
                metadataEvent: {
                    ...args.metadataEvent,
                    ...(recoveryContext ? { recoveryContext } : {}),
                },
                coordinatorMessage: messageText,
                queuedAt: Date.now(),
                ...(workerCoordinatorDaemonId ? { targetCoordinatorDaemonId: workerCoordinatorDaemonId } : {}),
            })) {
            if (allCoordinatorsGenerating) {
                LOG.info('MeshEvents', `Queued ${args.event} for generating CLI coordinator (mesh ${args.meshId}) — will be delivered via get_pending_mesh_events when coordinator returns to idle`);
            } else {
                LOG.info('MeshEvents', `Queued ${args.event} for MCP coordinator (mesh ${args.meshId})`);
            }
        }
    }

    // When all CLI coordinators are actively generating and a terminal refine event fires,
    // skip send_message injection entirely. The event is already buffered to the pending queue.
    // Injecting into a generating PTY coordinator can corrupt its input stream and cause it to
    // remain stuck in generating state, never processing the refine result.
    // The coordinator will drain pending events via get_pending_mesh_events on its next idle cycle.
    if (allCoordinatorsGenerating) {
        return { success: true, forwarded: 0, bufferedForGeneratingCoordinator: true };
    }

    for (const coord of coordinatorInstances) {
        const coordState = coord.getState();
        LOG.info('MeshEvents', `Forwarding mesh event to coordinator ${coordState.instanceId}`);
        coord.onEvent('send_message', { input: { text: messageText, textFallback: messageText } });
    }
    return { success: true, forwarded: coordinatorInstances.length };
}

export function handleMeshForwardEvent(components: DaemonComponents, payload: Record<string, unknown>) {
    const eventName = readNonEmptyString(payload.event);
    if (!isMeshCoordinatorEvent(eventName)) {
        return { success: false, error: 'unsupported mesh event' };
    }
    const meshId = readNonEmptyString(payload.meshId);
    if (!meshId) return { success: false, error: 'meshId required' };

    const nodeId = readNonEmptyString(payload.nodeId);
    const workspace = readNonEmptyString(payload.workspace);
    const nodeLabel = nodeId ? `Node '${nodeId}'` : workspace ? `Agent at ${workspace}` : 'Remote agent';
    return injectMeshSystemMessage(components, {
        meshId,
        nodeId,
        nodeLabel,
        event: eventName,
        metadataEvent: {
            targetSessionId: readNonEmptyString(payload.targetSessionId) || readNonEmptyString(payload.sessionId) || readNonEmptyString(payload.instanceId),
            providerType: readNonEmptyString(payload.providerType),
            providerSessionId: readNonEmptyString(payload.providerSessionId),
            finalSummary: readNonEmptyString(payload.finalSummary) || readNonEmptyString(payload.summary),
            jobId: readNonEmptyString(payload.jobId),
            interactionId: readNonEmptyString(payload.interactionId),
            status: readNonEmptyString(payload.status),
            targetDaemonId: readNonEmptyString(payload.targetDaemonId),
            startedAt: readNonEmptyString(payload.startedAt),
            completedAt: readNonEmptyString(payload.completedAt),
            retryOfJobId: readNonEmptyString(payload.retryOfJobId),
            ...(payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result) ? { result: payload.result } : {}),
            ...(payload.completionDiagnostic && typeof payload.completionDiagnostic === 'object' && !Array.isArray(payload.completionDiagnostic) ? { completionDiagnostic: payload.completionDiagnostic } : {}),
            ...(payload.workerResult && typeof payload.workerResult === 'object' && !Array.isArray(payload.workerResult) ? { workerResult: payload.workerResult } : {}),
            ...(payload.meshWorkerResult && typeof payload.meshWorkerResult === 'object' && !Array.isArray(payload.meshWorkerResult) ? { meshWorkerResult: payload.meshWorkerResult } : {}),
            ...(payload.structuredResult && typeof payload.structuredResult === 'object' && !Array.isArray(payload.structuredResult) ? { structuredResult: payload.structuredResult } : {}),
            ...(payload.timestamp !== undefined ? { timestamp: payload.timestamp } : {}),
            intentional: payload.intentional === true,
            intentionalStop: payload.intentionalStop === true,
            operatorCleanup: payload.operatorCleanup === true,
            reason: readNonEmptyString(payload.reason),
            stopReason: readNonEmptyString(payload.stopReason),
            cleanupReason: readNonEmptyString(payload.cleanupReason),
            source: readNonEmptyString(payload.source),
        },
    });
}

export function setupMeshEventForwarding(components: DaemonComponents) {
    components.instanceManager.onEvent((event) => {
        // We only care about lightweight Repo Mesh coordinator control/status hints.
        if (!isMeshCoordinatorEvent(event.event)) return;

        const instanceId = readNonEmptyString(event.instanceId);
        if (!instanceId) return;

        // Try to find the workspace and mesh metadata of the sub-agent.
        const sourceInstance = components.instanceManager.getInstance(instanceId);
        if (!sourceInstance || sourceInstance.category !== 'cli') return;
        const state = sourceInstance.getState();
        const workspace = readNonEmptyString(state.workspace);
        if (!workspace) return;
        const settings = state.settings && typeof state.settings === 'object' ? state.settings as Record<string, unknown> : {};

        // Coordinator sessions must never inject events into themselves.
        // A coordinator instance carries meshCoordinatorFor but not meshNodeFor/launchedByCoordinator.
        if (readNonEmptyString(settings.meshCoordinatorFor)) return;

        const meshIdFromRuntime = readNonEmptyString(settings.meshNodeFor);

        // Only forward events for sessions that were explicitly launched as mesh-node delegates
        // (meshNodeFor set by mesh_launch_session) or that carry the launchedByCoordinator flag.
        // Do NOT fall back to workspace-based mesh lookup: that would pick up coordinator sessions
        // and any other CLI session that happens to share the same workspace, causing spurious
        // system-message injection into the coordinator's own conversation.
        const isMeshDelegate = Boolean(meshIdFromRuntime || settings.launchedByCoordinator);
        if (!isMeshDelegate) return;

        const mesh = meshIdFromRuntime ? getMeshWithCache(components, meshIdFromRuntime) : getMeshByRepo(workspace);
        const meshId = meshIdFromRuntime || readNonEmptyString(mesh?.id);
        if (!meshId) return;

        // Determine node label. Inline/cloud meshes may be unavailable here, so preserve runtime node id.
        const targetNode = mesh?.nodes?.find((n: any) => n.workspace === workspace);
        const runtimeNodeId = readNonEmptyString(settings.meshNodeId);
        const resolvedNodeId = targetNode?.id || runtimeNodeId;
        const nodeLabel = targetNode
            ? `Node '${targetNode.id}'`
            : runtimeNodeId
                ? `Node '${runtimeNodeId}'`
                : `Agent at ${workspace}`;

        injectMeshSystemMessage(components, {
            meshId,
            sourceInstanceId: instanceId,
            nodeId: resolvedNodeId,
            nodeLabel,
            event: event.event,
            metadataEvent: event,
        });
    });
}
