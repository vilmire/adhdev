import { appendFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { LOG } from '../logging/logger.js';
import { getLedgerDir, readLedgerEntries, appendLedgerEntry } from './mesh-ledger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { buildMeshSystemMessage, readNonEmptyString, readRecord, resolveEventSessionId, readMeshCompletionSummary } from './mesh-events-utils.js';
import { expandDaemonIdForms } from '@adhdev/mesh-shared';

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
    /**
     * When set, this event is intended for a specific coordinator SESSION on the
     * target daemon (the session that originally dispatched the work). PHASE 2 inject
     * strict-matches the live coordinator by this session id so a sibling coordinator
     * session on the same daemon does not receive another coordinator's completion.
     * Absent on legacy / version-skewed events → daemon-level broadcast (no regression).
     * Rides inside the event payload, so it survives the SQLite payload round-trip and
     * the JSONL file without a dedicated column; it is NOT a drain-scoping key.
     */
    targetCoordinatorSessionId?: string;
}

const REFINE_TERMINAL_EVENTS = new Set(['refine:completed', 'refine:failed']);

/** Normalise a coordinator-daemon-id argument (single id, list, or undefined) into a
 *  de-duplicated list of non-empty strings, EXPANDED to every equivalent daemon-id
 *  form (bare `mach_X` ≡ `daemon_mach_X` ≡ `standalone_mach_X`).
 *
 *  A coordinator resolves its own id through one path (status instanceId, the config-
 *  form node daemonId, or the bare machineId) but a worker stamps a completion's
 *  `coordinator_daemon_id` through another, so the two are routinely in DIFFERENT
 *  forms of the SAME machine. The scope filter is an exact-string match, so without
 *  expansion a `daemon_mach_X`-scoped completion is silently skipped by a coordinator
 *  that only knows itself as bare `mach_X` (the base-node completion-surface bug).
 *  Expanding here fixes every drain/peek/surface caller uniformly. The first ORIGINAL
 *  id stays at [0] so per-daemon JSONL file naming keeps its primary; expansion stays
 *  within one machine core so a different coordinator's events are never claimed. */
function normalizeCoordinatorDaemonIds(
    coordinatorDaemonId?: string | null | ReadonlyArray<string>,
): string[] {
    return expandDaemonIdForms(coordinatorDaemonId);
}

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

// CANON-B / DUPNOTIF: terminal completion events that the coordinator surfaces as a
// notification. The native completion path (handleMeshCoordinatorEvent) and the transcript
// reconciliation fallback (reconcileDirectDispatchCompletionFromTranscript) BOTH queue one of
// these for the same finished task — with DIFFERENT timestamps — so a timestamp-bearing
// fingerprint lets both surface and the coordinator notifies twice. When the event carries a
// taskId we anchor the fingerprint on the taskId (dropping the timestamp), collapsing the two
// paths into a single surface. A weakness marker keeps a tentative false-idle completion
// distinct from the genuine completion that supersedes it, so the genuine one is never
// swallowed by the earlier weak one.
const TERMINAL_COMPLETION_EVENTS = new Set(['agent:generating_completed', 'agent:stopped']);

function isWeakCompletionMetadata(metadata: Record<string, unknown>): boolean {
    const evidenceLevel = readNonEmptyString(metadata.evidenceLevel);
    if (evidenceLevel === 'insufficient' || evidenceLevel === 'weak') return true;
    if (metadata.reviewRecommended === true) return true;
    const diag = readRecord(metadata.completionDiagnostic);
    return diag?.finalAssistantPresent === false || diag?.blockReason === 'missing_final_assistant';
}

export function buildPendingEventFingerprint(event: PendingMeshCoordinatorEvent): string {
    const metadata = readRecord(event.metadataEvent) || {};
    // Bootstrap events are node-scoped: dedup by meshId+event+nodeId only.
    // They carry no sessionId/taskId/timestamp — using those fields would produce
    // an empty fingerprint that defeats dedup entirely.
    if (event.event === 'worktree_bootstrap_complete' || event.event === 'worktree_bootstrap_failed') {
        return [event.meshId, event.event, event.nodeId || ''].join('::');
    }
    // DUPNOTIF: a terminal completion carrying a taskId is deduped by taskId (+ weakness),
    // NOT by timestamp — the native and transcript-reconciliation paths timestamp the same
    // completion differently, and only taskId is stable across both.
    if (TERMINAL_COMPLETION_EVENTS.has(event.event)) {
        const terminalTaskId = readNonEmptyString(metadata.taskId) || readNonEmptyString(readRecord(metadata.payload)?.taskId);
        if (terminalTaskId) {
            return [
                event.meshId,
                event.event,
                terminalTaskId,
                isWeakCompletionMetadata(metadata) ? 'weak' : 'genuine',
            ].join('::');
        }
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

// NOTE: the former R3 "direct-delivered" marker (markMeshCoordinatorEventDirectDelivered /
// wasDirectDeliveredToCoordinator) was removed when spontaneous PTY direct-inject was retired.
// Delivery is now queue-drain-only: an event is consumed by exactly one drainer via the atomic
// SQLite drained=1 marking, so there is no PTY-vs-poll double-delivery left to dedup against.
// The dormant mesh_direct_delivered_events table / store helpers remain (harmless) but unused.

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

function readPendingMeshCoordinatorEventsFromDisk(meshId?: string, coordinatorDaemonId?: string | ReadonlyArray<string>): PendingMeshCoordinatorEvent[] {
    if (!meshId) return [];
    const daemonIds = normalizeCoordinatorDaemonIds(coordinatorDaemonId);
    const primaryDaemonId = daemonIds[0];
    // Read coordinator-scoped file first; fall back to legacy shared file.
    const paths = primaryDaemonId
        ? [getPendingEventsPath(meshId, primaryDaemonId), getPendingEventsPath(meshId)]
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
            const filtered = (primaryDaemonId && path === getPendingEventsPath(meshId))
                ? parsed.filter(e => !e.targetCoordinatorDaemonId || daemonIds.includes(e.targetCoordinatorDaemonId))
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
        // C1 (data safety): this trim discards the OLDEST queued lines to keep the file
        // bounded. An undelivered terminal completion among them would otherwise lose its
        // worker summary silently (the JSONL is the only copy when the SQLite dual-write
        // failed). Before dropping, mirror any meaningful (coordinator-facing / summary-
        // bearing) dropped event into the ledger so it stays auditable and recoverable,
        // and LOG.warn so the drop is observable instead of silent.
        const dropped = lines.slice(0, lines.length - MAX_PENDING_EVENTS_KEEP);
        for (const line of dropped) {
            let event: PendingMeshCoordinatorEvent | undefined;
            try { event = JSON.parse(line) as PendingMeshCoordinatorEvent; } catch { continue; }
            if (!event || !event.meshId) continue;
            const finalSummary = readMeshCompletionSummary(event.metadataEvent || {});
            // "Meaningful" = would have been delivered to a coordinator (carries a message)
            // or carries worker output worth preserving. Silent lifecycle events are not
            // logged — losing them on trim is harmless (they re-drive nothing once stale).
            if (!readNonEmptyString(event.coordinatorMessage) && !finalSummary) continue;
            try {
                appendLedgerEntry(event.meshId, {
                    kind: 'event_held',
                    ...(event.nodeId ? { nodeId: event.nodeId } : {}),
                    payload: {
                        event: event.event,
                        reason: 'pending_trim_dropped',
                        recoverable: true,
                        nodeLabel: event.nodeLabel,
                        ...(event.workspace ? { workspace: event.workspace } : {}),
                        targetCoordinatorDaemonId: event.targetCoordinatorDaemonId ?? null,
                        queuedAt: event.queuedAt,
                        ...(finalSummary ? { finalSummary } : {}),
                    },
                });
                LOG.warn('MeshEvents', `Pending-events trim dropping undelivered ${event.event} for mesh ${event.meshId} — recorded to ledger (recoverable)`);
            } catch (e: any) {
                LOG.warn('MeshEvents', `Failed to ledger-record trim-dropped ${event.event} for mesh ${event.meshId}: ${e?.message || e}`);
            }
        }
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
        let sqliteOk = false;
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
            sqliteOk = true;
        } catch {
            // SQLite write failure is non-fatal; JSONL fallback below still works.
        }

        // Also write to JSONL (retained as legacy/export artifact). Best-effort once
        // SQLite (the primary store) has the event: a JSONL append failure (disk full,
        // permissions) must NOT report the whole persist as failed when SQLite holds it.
        try {
            const path = getPendingEventsPath(event.meshId, event.targetCoordinatorDaemonId);
            trimPendingEventsIfNeeded(path);
            appendFileSync(path, JSON.stringify(event) + '\n', 'utf-8');
        } catch (e: any) {
            if (!sqliteOk) throw e; // neither store has it — surface as a real failure
            LOG.warn('MeshEvents', `JSONL append failed for mesh ${event.meshId}; SQLite holds the event: ${e?.message || e}`);
        }
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

// Selectively drain a JSONL pending-events file: atomically claim it (rename), then
// consume only the lines whose parsed event matches `predicate` and rewrite the
// remaining (kept) lines back to the original path. Unparseable lines are kept
// untouched. Returns the consumed events. The rename makes claiming exclusive —
// only one concurrent caller wins, so there is no double-consume of the same lines.
function selectiveDrainFile(
    path: string,
    predicate: (event: PendingMeshCoordinatorEvent) => boolean,
): PendingMeshCoordinatorEvent[] {
    const tmpPath = `${path}.draining`;
    try {
        renameSync(path, tmpPath);
    } catch {
        return []; // another drain claimed it, or the file doesn't exist
    }
    let content: string;
    try {
        content = readFileSync(tmpPath, 'utf-8');
    } catch {
        try { unlinkSync(tmpPath); } catch { /* best-effort */ }
        return [];
    }

    const consumed: PendingMeshCoordinatorEvent[] = [];
    const keptLines: string[] = [];
    for (const line of content.split('\n')) {
        if (!line) continue;
        let parsed: PendingMeshCoordinatorEvent | undefined;
        try { parsed = JSON.parse(line) as PendingMeshCoordinatorEvent; } catch { parsed = undefined; }
        if (parsed && predicate(parsed)) {
            consumed.push(parsed);
        } else {
            keptLines.push(line); // non-matching or unparseable → leave queued
        }
    }

    try {
        if (keptLines.length > 0) {
            writeFileSync(path, keptLines.join('\n') + '\n', 'utf-8');
        }
        unlinkSync(tmpPath);
    } catch {
        // If the rewrite/cleanup fails, restore the claimed file so no events are
        // lost — the next drain retries the whole file.
        try { if (existsSync(tmpPath) && !existsSync(path)) renameSync(tmpPath, path); } catch { /* best-effort */ }
        return [];
    }
    return consumed;
}

/**
 * Drain and return pending coordinator events for meshId, removing the drained
 * ones from both the SQLite inbox and the JSONL legacy file.
 *
 * When `opts.onlyEvents` is supplied, ONLY events whose name is in that set are
 * drained; every other event stays queued (undrained in SQLite, rewritten back to
 * the JSONL file). The reconcile loop uses this to force-drain terminal/force-inject
 * events into a *generating* coordinator while leaving non-force progress events for
 * the coordinator's next idle transition. The atomic SQLite drained=1 marking and the
 * atomic JSONL rename keep force-drain and a concurrent full drain from double-consuming.
 */
export function drainPendingMeshCoordinatorEvents(
    meshId?: string,
    coordinatorDaemonId?: string | ReadonlyArray<string>,
    opts?: { onlyEvents?: ReadonlySet<string> },
): PendingMeshCoordinatorEvent[] {
    if (!meshId) return [];

    // A daemon may answer to more than one coordinator-id form (its canonical
    // status id like `standalone_<machineId>` AND the bare machineId). Normalise
    // to a list so both the SQLite IN-filter and the JSONL targeting predicate
    // accept any of them.
    const daemonIds = normalizeCoordinatorDaemonIds(coordinatorDaemonId);
    const primaryDaemonId = daemonIds[0];

    const onlyEvents = opts?.onlyEvents;
    const matchesFilter = (eventName: string): boolean => !onlyEvents || onlyEvents.has(eventName);

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
            for (const row of store.drainPendingEvents(meshId, daemonIds.length > 0 ? daemonIds : undefined, onlyEvents ? { onlyEvents } : undefined)) {
                const event = row.payload as PendingMeshCoordinatorEvent;
                if (event) pushUnique(event);
            }
        }
    } catch (e: any) {
        // SQLite drain failed — JSONL below still drains. Surface it: a silent
        // failure here means the JSONL copy is emptied while the SQLite rows
        // survive undrained, so the next drain re-delivers the same events to the
        // coordinator (duplicate refine:completed etc.) with no diagnostic trail.
        LOG.warn('MeshEvents', `SQLite pending-event drain failed for mesh ${meshId}; JSONL fallback only: ${e?.message || e}`);
    }

    // JSONL (legacy / migration path) — always drained alongside SQLite.
    // The scoped per-daemon file is keyed by a single id; use the primary. The
    // shared (unscoped) file's targeting predicate accepts ANY of this daemon's ids.
    const paths = primaryDaemonId
        ? [getPendingEventsPath(meshId, primaryDaemonId), getPendingEventsPath(meshId)]
        : [getPendingEventsPath(meshId)];
    for (const path of paths) {
        const isSharedFile = !!primaryDaemonId && path === getPendingEventsPath(meshId);
        // Targeting predicate for the shared (unscoped) file: only this coordinator's
        // events (or legacy untargeted ones) are eligible.
        const targets = (e: PendingMeshCoordinatorEvent): boolean =>
            !isSharedFile || !e.targetCoordinatorDaemonId || daemonIds.includes(e.targetCoordinatorDaemonId);

        if (onlyEvents) {
            // Selective JSONL drain: consume only matching events, rewrite the rest back.
            for (const event of selectiveDrainFile(path, e => targets(e) && matchesFilter(e.event))) {
                pushUnique(event);
            }
            continue;
        }
        const content = atomicDrainFile(path);
        if (!content) continue;
        const parsed = content.split('\n').filter(Boolean).flatMap(line => {
            try { return [JSON.parse(line) as PendingMeshCoordinatorEvent]; } catch { return []; }
        });
        // If reading the shared file, filter to events that target this coordinator or are unscoped.
        const filtered = isSharedFile ? parsed.filter(targets) : parsed;
        for (const event of filtered) pushUnique(event);
    }
    if (merged.length === 0) return [];
    // (Former R3 direct-delivered dedup removed.) Spontaneous PTY direct-inject no
    // longer exists — delivery is now queue-drain-only (reconcile loop or MCP pull),
    // so an event is consumed by exactly one drainer via the atomic SQLite drained=1
    // marking. There is no PTY-vs-poll double path left to dedup against.
    return reconcilePendingMeshCoordinatorEvents(meshId, merged);
}

/** Peek at pending coordinator events without draining (non-destructive). */
export function getPendingMeshCoordinatorEvents(meshId?: string, coordinatorDaemonId?: string | ReadonlyArray<string>): readonly PendingMeshCoordinatorEvent[] {
    if (!meshId) return [];
    const daemonIds = normalizeCoordinatorDaemonIds(coordinatorDaemonId);

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
            for (const row of store.peekPendingEvents(meshId, daemonIds.length > 0 ? daemonIds : undefined)) {
                const event = row.payload as PendingMeshCoordinatorEvent;
                if (event) pushUnique(event);
            }
        }
    } catch { /* SQLite unavailable — JSONL fallback below */ }

    // JSONL (legacy)
    for (const event of readPendingMeshCoordinatorEventsFromDisk(meshId, daemonIds)) {
        pushUnique(event);
    }

    // (Former R3 direct-delivered filter removed — no PTY direct-inject path exists
    // anymore, so a peeked pending event has genuinely not yet been consumed.)
    return reconcilePendingMeshCoordinatorEvents(meshId, merged);
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
