import { appendFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { LOG } from '../logging/logger.js';
import { getLedgerDir, readLedgerEntries } from './mesh-ledger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { buildMeshSystemMessage, readNonEmptyString, readRecord, resolveEventSessionId } from './mesh-events-utils.js';

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

export function readRefineJobId(event: { metadataEvent?: Record<string, unknown> } | Record<string, unknown>): string {
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

export function buildPendingEventFingerprint(event: PendingMeshCoordinatorEvent): string {
    const metadata = readRecord(event.metadataEvent) || {};
    // Bootstrap events are node-scoped: dedup by meshId+event+nodeId only.
    // They carry no sessionId/taskId/timestamp — using those fields would produce
    // an empty fingerprint that defeats dedup entirely.
    if (event.event === 'worktree_bootstrap_complete' || event.event === 'worktree_bootstrap_failed') {
        return [event.meshId, event.event, event.nodeId || ''].join('::');
    }
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

// R3: TTL for the direct-delivered marker. A coordinator polls get_pending_mesh_events
// well within this window after a terminal event; after it expires the marker is swept and
// a late/duplicate drain would (harmlessly) re-surface — but by then the event is long gone
// from the queue too. 10 minutes mirrors the completion-fingerprint TTL.
const DIRECT_DELIVERED_TTL_MS = 10 * 60 * 1000;

/**
 * R3: record that an event was direct-injected into a live coordinator on `coordinatorDaemonId`.
 * That coordinator's own drain (get_pending_mesh_events with the same coordinatorDaemonId) will
 * skip the queued copy, so it receives the event exactly once instead of twice (PTY + poll).
 * Other consumers (unscoped drainers, other daemons) are unaffected — they did not get the inject.
 */
export function markMeshCoordinatorEventDirectDelivered(
    coordinatorDaemonId: string,
    event: PendingMeshCoordinatorEvent,
): void {
    if (!coordinatorDaemonId) return;
    const fingerprint = buildPendingEventFingerprint(event);
    if (!fingerprint.trim()) return;
    try {
        const store = MeshRuntimeStore.getInstance();
        store.recordDirectDelivered(coordinatorDaemonId, fingerprint, DIRECT_DELIVERED_TTL_MS);
        store.sweepExpiredDirectDelivered();
    } catch { /* best-effort — a duplicate is preferable to a crash */ }
}

function wasDirectDeliveredToCoordinator(coordinatorDaemonId: string, event: PendingMeshCoordinatorEvent): boolean {
    if (!coordinatorDaemonId) return false;
    const fingerprint = buildPendingEventFingerprint(event);
    if (!fingerprint.trim()) return false;
    try {
        return MeshRuntimeStore.getInstance().wasDirectDelivered(coordinatorDaemonId, fingerprint);
    } catch {
        return false;
    }
}

export function hasPendingCoordinatorEventDuplicate(event: PendingMeshCoordinatorEvent): boolean {
    const fingerprint = buildPendingEventFingerprint(event);
    if (!fingerprint.trim()) return false;
    // Check SQLite inbox first (G3 primary path)
    try {
        if (MeshRuntimeStore.getInstance().hasPendingEventFingerprint(event.meshId, fingerprint)) return true;
    } catch { /* fall through to JSONL check */ }
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
        const nodeLabel = readNonEmptyString(refineJob?.nodeId) || entry.nodeId || 'refine job';
        backfilled.push({
            event: eventName,
            meshId,
            nodeLabel,
            nodeId: readNonEmptyString(refineJob?.nodeId) || entry.nodeId,
            workspace: readNonEmptyString(refineJob?.workspace),
            metadataEvent,
            coordinatorMessage: buildMeshSystemMessage({ event: eventName, nodeLabel, metadataEvent }),
            queuedAt: Date.now(),
        });
    }
    return backfilled.reverse();
}

function reconcilePendingMeshCoordinatorEvents(meshId: string, events: PendingMeshCoordinatorEvent[]): PendingMeshCoordinatorEvent[] {
    const backfilled = refineTerminalEventFromLedger(meshId, events);
    // A refine:accepted event is a provisional "job accepted, result to follow" signal.
    // Once its terminal (completed/failed) counterpart for the same jobId exists — whether
    // already direct-queued into the pending store OR backfilled from the ledger here — the
    // accepted is superseded and is dropped so the coordinator isn't shown stale duplicate
    // noise alongside the terminal outcome.
    const terminalJobIds = new Set(
        [...events.filter(event => REFINE_TERMINAL_EVENTS.has(event.event)), ...backfilled]
            .map(event => readRefineJobId(event))
            .filter(Boolean),
    );
    const reconciled = terminalJobIds.size === 0
        ? events
        : events.filter(event => !(event.event === 'refine:accepted' && terminalJobIds.has(readRefineJobId(event))));
    return backfilled.length === 0 ? reconciled : [...reconciled, ...backfilled];
}

const MAX_PENDING_EVENTS_BYTES = 100 * 1024; // 100 KB — keep the pending file small
const MAX_PENDING_EVENTS_KEEP = 50;           // keep the last 50 events when trimming

function trimPendingEventsIfNeeded(path: string): void {
    try {
        if (!existsSync(path)) return;
        if (statSync(path).size <= MAX_PENDING_EVENTS_BYTES) return;
        const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
        if (lines.length <= MAX_PENDING_EVENTS_KEEP) return;
        writeFileSync(path, lines.slice(-MAX_PENDING_EVENTS_KEEP).join('\n') + '\n', 'utf-8');
    } catch { /* best-effort; if trim fails, append still proceeds */ }
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

        const fingerprint = buildPendingEventFingerprint(event);

        // G3: Write to SQLite inbox (primary path going forward)
        try {
            MeshRuntimeStore.getInstance().insertPendingEvent({
                id: randomUUID(),
                meshId: event.meshId,
                coordinatorDaemonId: event.targetCoordinatorDaemonId ?? null,
                event: event.event,
                payload: event,
                fingerprint: fingerprint || null,
                queuedAt: event.queuedAt,
            });
        } catch {
            // SQLite write failure is non-fatal; JSONL fallback below still works.
        }

        // Also write to JSONL (retained as legacy/export artifact)
        const path = getPendingEventsPath(event.meshId, event.targetCoordinatorDaemonId);
        trimPendingEventsIfNeeded(path);
        appendFileSync(path, JSON.stringify(event) + '\n', 'utf-8');
        return true;
    } catch (e: any) {
        LOG.warn('MeshEvents', `Failed to persist pending coordinator event: ${e?.message || e}`);
        return false;
    }
}

// Atomically rename the file before reading so concurrent drains can't both consume
// the same events. renameSync is atomic on POSIX (same filesystem); only one caller
// wins the rename — the other gets ENOENT and returns null, preventing duplicate delivery.
function atomicDrainFile(path: string): string | null {
    const tmpPath = `${path}.draining`;
    try {
        renameSync(path, tmpPath);
    } catch {
        return null; // another drain already renamed it, or file doesn't exist
    }
    try {
        const content = readFileSync(tmpPath, 'utf-8');
        try { unlinkSync(tmpPath); } catch { /* already cleaned up */ }
        return content;
    } catch {
        try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
        return null;
    }
}

/** Drain and return all pending coordinator events for meshId, removing them from disk. */
export function drainPendingMeshCoordinatorEvents(meshId?: string, coordinatorDaemonId?: string): PendingMeshCoordinatorEvent[] {
    if (!meshId) return [];

    // Dual-write means SQLite and JSONL hold the same events. Both stores must be
    // emptied in one drain call — draining only one leaves the other to re-deliver
    // the same events on the next call. Merge with fingerprint dedup.
    const merged: PendingMeshCoordinatorEvent[] = [];
    const seenFingerprints = new Set<string>();
    const pushUnique = (event: PendingMeshCoordinatorEvent) => {
        const fingerprint = buildPendingEventFingerprint(event);
        if (fingerprint.trim()) {
            if (seenFingerprints.has(fingerprint)) return;
            seenFingerprints.add(fingerprint);
        }
        merged.push(event);
    };

    // G3: SQLite inbox
    try {
        const store = MeshRuntimeStore.getInstance();
        if (store.pendingEventCount(meshId) > 0) {
            for (const row of store.drainPendingEvents(meshId, coordinatorDaemonId)) {
                const event = row.payload as PendingMeshCoordinatorEvent;
                if (event) pushUnique(event);
            }
        }
    } catch {
        // SQLite drain failed — JSONL below still drains
    }

    // JSONL (legacy / migration path) — always drained alongside SQLite
    const paths = coordinatorDaemonId
        ? [getPendingEventsPath(meshId, coordinatorDaemonId), getPendingEventsPath(meshId)]
        : [getPendingEventsPath(meshId)];
    for (const path of paths) {
        const content = atomicDrainFile(path);
        if (!content) continue;
        const parsed = content.split('\n').filter(Boolean).flatMap(line => {
            try { return [JSON.parse(line) as PendingMeshCoordinatorEvent]; } catch { return []; }
        });
        // If reading the shared file, filter to events that target this coordinator or are unscoped.
        const filtered = (coordinatorDaemonId && path === getPendingEventsPath(meshId))
            ? parsed.filter(e => !e.targetCoordinatorDaemonId || e.targetCoordinatorDaemonId === coordinatorDaemonId)
            : parsed;
        for (const event of filtered) pushUnique(event);
    }
    if (merged.length === 0) return [];
    // R3: when this drain is scoped to a coordinator daemon, exclude events that were already
    // direct-injected into that coordinator's live CLI session. Unscoped drains (no daemon id)
    // keep everything — they belong to consumers that never received the direct inject.
    const deliverable = coordinatorDaemonId
        ? merged.filter(event => !wasDirectDeliveredToCoordinator(coordinatorDaemonId, event))
        : merged;
    if (deliverable.length === 0) return [];
    return reconcilePendingMeshCoordinatorEvents(meshId, deliverable);
}

/** Peek at pending coordinator events without draining (non-destructive). */
export function getPendingMeshCoordinatorEvents(meshId?: string, coordinatorDaemonId?: string): readonly PendingMeshCoordinatorEvent[] {
    if (!meshId) return [];

    // Merge SQLite (primary) + JSONL (legacy) with fingerprint dedup.
    const merged: PendingMeshCoordinatorEvent[] = [];
    const seenFingerprints = new Set<string>();
    const pushUnique = (event: PendingMeshCoordinatorEvent) => {
        const fingerprint = buildPendingEventFingerprint(event);
        if (fingerprint.trim()) {
            if (seenFingerprints.has(fingerprint)) return;
            seenFingerprints.add(fingerprint);
        }
        merged.push(event);
    };

    // G3: SQLite inbox (non-destructive peek at undrained rows)
    try {
        const store = MeshRuntimeStore.getInstance();
        if (store.pendingEventCount(meshId) > 0) {
            for (const row of store.peekPendingEvents(meshId, coordinatorDaemonId)) {
                const event = row.payload as PendingMeshCoordinatorEvent;
                if (event) pushUnique(event);
            }
        }
    } catch { /* SQLite unavailable — JSONL fallback below */ }

    // JSONL (legacy)
    for (const event of readPendingMeshCoordinatorEventsFromDisk(meshId, coordinatorDaemonId)) {
        pushUnique(event);
    }

    // R3: hide events already direct-delivered to this coordinator from its status peek, so
    // mesh_status doesn't report a "pending" event the coordinator has in fact already received.
    const deliverable = coordinatorDaemonId
        ? merged.filter(event => !wasDirectDeliveredToCoordinator(coordinatorDaemonId, event))
        : merged;

    return reconcilePendingMeshCoordinatorEvents(meshId, deliverable);
}

/**
 * Test helper: purge all pending-event state for a mesh — SQLite rows
 * (including drained fingerprint history) and JSONL files.
 */
export function __clearMeshPendingEventsForTests(meshId: string): void {
    try {
        MeshRuntimeStore.getInstance().clearPendingEventsForMesh(meshId);
    } catch { /* store unavailable — nothing to clear */ }
    clearPendingMeshCoordinatorEvents(meshId);
}

/** Explicitly clear all pending coordinator events for a mesh (and coordinator if scoped). */
export function clearPendingMeshCoordinatorEvents(meshId?: string, coordinatorDaemonId?: string): void {
    if (!meshId) return;
    // Clear SQLite rows
    try { MeshRuntimeStore.getInstance().clearPendingEventsForMesh(meshId); } catch { /* store unavailable */ }
    // Clear JSONL files
    const paths = coordinatorDaemonId
        ? [getPendingEventsPath(meshId, coordinatorDaemonId), getPendingEventsPath(meshId)]
        : [getPendingEventsPath(meshId)];
    for (const path of paths) {
        if (existsSync(path)) try { unlinkSync(path); } catch { /* already removed */ }
    }
}
