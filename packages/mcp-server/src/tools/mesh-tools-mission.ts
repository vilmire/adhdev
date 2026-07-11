// Mesh tool implementations — mission domain.
// Pure move out of mesh-tools.ts (no behavior change). Shared helpers, types, module
// state and dependency re-exports live in ./mesh-tools-internal.ts; mesh-tools.ts is a barrel.

import {
    MESH_MISSION_STATUSES,
    appendLedgerEntry,
    appendRemoteLedgerEntries,
    buildMeshLedgerReconciliationEvidence,
    buildMeshLedgerReplicaEvidence,
    commandForNode,
    computeMeshTaskStats,
    drainCoordinatorPendingEvents,
    getLedgerSummary,
    isLocalControlPlaneNode,
    listMeshMissionsForTool,
    readLedgerEntries,
    readLedgerSlice,
    getMeshMission,
    readLedgerSliceFromStore,
    readString,
    refreshMeshFromDaemon,
    requeueHeldMeshCoordinatorEvents,
    slimLedgerPayload,
    tombstoneOperatingNote,
    unwrapCommandPayload,
    upsertMeshMission,
} from './mesh-tools-internal.js';
import type {
    MeshContext,
} from './mesh-tools-internal.js';

export async function meshTaskHistory(
    ctx: MeshContext,
    args: { tail?: number; kind?: string; compact?: boolean; verbose?: boolean },
): Promise<string> {
    const { mesh } = ctx;
    // Default to the slim payload for LLM callers; verbose forces full payloads.
    const compact = args.verbose === true ? false : (args.compact ?? true);
    const pendingEvents = await drainCoordinatorPendingEvents(ctx);
    // Clamp tail so a large default/explicit value can't blow up the payload in
    // compact mode. Full (verbose) callers may request a deeper window.
    const requestedTail = typeof args.tail === 'number' && args.tail > 0 ? Math.floor(args.tail) : 20;
    // Compact: cap conservatively so even large refine-batch entries can't blow the
    // token limit. slimLedgerPayload is the primary defense (it summarizes large
    // plan/validationPlan/suggestedConfig fields); this clamp is the backstop. A deep
    // explicit request (tail > 50) is clamped harder (20) than a modest one (30).
    const compactCap = requestedTail > 50 ? 20 : 30;
    const tail = compact ? Math.min(requestedTail, compactCap) : Math.min(requestedTail, 200);
    const kind = typeof args.kind === 'string' && args.kind.trim() ? [args.kind.trim() as any] : undefined;
    const rawEntries = readLedgerEntries(mesh.id, { tail, kind });
    // Slim large payload fields so coordinator context stays lean. Verbose
    // returns the raw payloads untouched for full audit detail.
    const entries = compact
        ? rawEntries.map(e => ({
            ...e,
            payload: e.payload ? slimLedgerPayload(e.payload) : e.payload,
        }))
        : rawEntries;
    const summary = getLedgerSummary(mesh.id);
    // M7: per-task time/attempt stats for tasks visible in the returned window.
    // Derived from ledger truth at query time; incomplete evidence is flagged,
    // never estimated.
    let taskStats: unknown[] | undefined;
    try {
        const taskIds = [...new Set(rawEntries
            .map(e => (typeof e.payload?.taskId === 'string' ? e.payload.taskId : ''))
            .filter(Boolean))] as string[];
        if (taskIds.length > 0) {
            const stats = computeMeshTaskStats(mesh.id, { taskIds });
            if (stats.length > 0) taskStats = stats;
        }
    } catch { /* stats are best-effort */ }
    return JSON.stringify({
        meshId: mesh.id,
        payloadMode: compact ? 'compact' : 'full',
        entries,
        summary,
        ...(taskStats ? { taskStats } : {}),
        ...(pendingEvents.length > 0 ? { pendingCoordinatorEvents: pendingEvents } : {}),
    }, null, 2);
}

export async function meshLedgerQuery(
    ctx: MeshContext,
    args: { kind?: string; since?: string; node?: string; tail?: number },
): Promise<string> {
    const { mesh } = ctx;
    const pendingEvents = await drainCoordinatorPendingEvents(ctx);
    // kind accepts one kind or a comma-separated list; normalize to the array the
    // ledger reader expects. Empty tokens are dropped.
    const kind = typeof args.kind === 'string' && args.kind.trim()
        ? (args.kind.split(',').map(k => k.trim()).filter(Boolean) as any[])
        : undefined;
    // since accepts ISO-8601 or epoch-ms; readLedgerEntries parses via new Date(),
    // which handles both an ISO string and a numeric ms value (as string or number).
    const since = typeof args.since === 'string' && args.since.trim()
        ? args.since.trim()
        : (typeof args.since === 'number' ? String(args.since) : undefined);
    const node = typeof args.node === 'string' && args.node.trim() ? args.node.trim() : undefined;
    // tail default 50, clamped to 500 (read-only query axis — deeper than the
    // compact task_history window since it isn't payload-heavy by default).
    const requestedTail = typeof args.tail === 'number' && args.tail > 0 ? Math.floor(args.tail) : 50;
    const tail = Math.min(requestedTail, 500);
    const entries = readLedgerEntries(mesh.id, { tail, kind, since, node });
    const summary = getLedgerSummary(mesh.id);
    return JSON.stringify({
        meshId: mesh.id,
        query: {
            ...(kind ? { kind } : {}),
            ...(since ? { since } : {}),
            ...(node ? { node } : {}),
            tail,
        },
        count: entries.length,
        entries,
        summary,
        ...(pendingEvents.length > 0 ? { pendingCoordinatorEvents: pendingEvents } : {}),
    }, null, 2);
}

export async function meshRecordNote(
    ctx: MeshContext,
    args: { text?: string; category?: string },
): Promise<string> {
    const { mesh } = ctx;
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) {
        return JSON.stringify({ success: false, error: 'text required' }, null, 2);
    }
    const category = args.category === 'provider_quirk' || args.category === 'pattern_to_avoid' || args.category === 'recovery_lesson'
        ? args.category
        : undefined;
    const createdAt = new Date().toISOString();
    // sourceCoordinator: best-effort identity of the recording coordinator so a
    // future coordinator can attribute the note. Session id is the most precise;
    // fall back to the daemon/hostname.
    const sourceCoordinator = ctx.coordinatorSessionId || ctx.localDaemonId || ctx.coordinatorHostname || undefined;
    const entry = appendLedgerEntry(mesh.id, {
        kind: 'coordinator_operating_note',
        ...(sourceCoordinator ? { sessionId: sourceCoordinator } : {}),
        payload: {
            text,
            ...(category ? { category } : {}),
            createdAt,
            ...(sourceCoordinator ? { sourceCoordinator } : {}),
        },
    });
    return JSON.stringify({
        success: true,
        meshId: mesh.id,
        noteId: entry.id,
        recorded: { text, category: category ?? null, createdAt },
        note: 'Recorded to the mesh ledger. Future coordinators on this mesh will see it under "## Operating Notes" at launch.',
    }, null, 2);
}

export async function meshForgetNote(
    ctx: MeshContext,
    args: { note_id?: string; noteId?: string; text?: string; reason?: string },
): Promise<string> {
    const { mesh } = ctx;
    const noteId = readString(args.note_id) || readString(args.noteId) || undefined;
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!noteId && !text) {
        return JSON.stringify({ success: false, error: 'note_id or text required' }, null, 2);
    }
    try {
        const { tombstone, matched } = tombstoneOperatingNote(mesh.id, {
            ...(noteId ? { noteId } : {}),
            ...(text ? { text } : {}),
            ...(typeof args.reason === 'string' && args.reason.trim() ? { reason: args.reason.trim() } : {}),
        });
        return JSON.stringify({
            success: true,
            meshId: mesh.id,
            tombstoneId: tombstone.id,
            forgot: { noteId: noteId ?? null, text: text || null, matched },
            note: matched > 0
                ? `Retracted ${matched} operating note(s). Future coordinators on this mesh will no longer see them at launch. History is preserved (append-only tombstone).`
                : 'No live operating note matched — recorded a tombstone anyway so any matching note appended later is also suppressed.',
        }, null, 2);
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e?.message || String(e) }, null, 2);
    }
}

export async function meshReconcileLedger(
    ctx: MeshContext,
    args: { node_ids?: string[]; limit?: number; after_id?: string; since?: string; import_entries?: boolean },
): Promise<string> {
    await refreshMeshFromDaemon(ctx);
    const requestedNodeIds = Array.isArray(args.node_ids)
        ? new Set(args.node_ids.map(id => typeof id === 'string' ? id.trim() : '').filter(Boolean))
        : null;
    const nodes = ctx.mesh.nodes.filter(node => !requestedNodeIds || requestedNodeIds.has(node.id));
    const replicas: any[] = [];
    const shouldImport = args.import_entries !== false;
    const queryArgs = {
        meshId: ctx.mesh.id,
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        ...(typeof args.after_id === 'string' && args.after_id.trim() ? { afterId: args.after_id.trim() } : {}),
        ...(typeof args.since === 'string' && args.since.trim() ? { since: args.since.trim() } : {}),
    };

    for (const node of nodes) {
        try {
            if (isLocalControlPlaneNode(ctx, node) || !node.daemonId) {
                // G4: Use SQLite mesh_event_ledger (bounded slice) as the local P2P reconcile read path.
                // readLedgerSlice (JSONL) is retained for per-daemon P2P export; coordinator local reads use SQLite.
                const slice = readLedgerSliceFromStore(ctx.mesh.id, queryArgs);
                replicas.push(buildMeshLedgerReplicaEvidence({
                    nodeId: node.id,
                    daemonId: node.daemonId,
                    transport: 'local',
                    slice,
                    status: 'local',
                }));
                continue;
            }

            const result = await commandForNode(ctx, node, 'get_mesh_ledger_slice', queryArgs);
            const payload = unwrapCommandPayload(result);
            if (payload?.success === false) {
                throw new Error(payload.error || 'remote get_mesh_ledger_slice failed');
            }
            const slice = payload?.slice ?? payload;
            if (slice?.protocol !== 'adhdev.mesh.ledger.slice.v1' || !Array.isArray(slice.entries)) {
                throw new Error('remote daemon returned an invalid ledger slice payload');
            }
            const importResult = shouldImport
                ? appendRemoteLedgerEntries(ctx.mesh.id, slice.entries)
                : { accepted: 0, skippedDuplicate: 0, rejectedInvalid: 0, entries: [] };
            replicas.push(buildMeshLedgerReplicaEvidence({
                nodeId: node.id,
                daemonId: node.daemonId,
                transport: 'p2p_datachannel',
                slice,
                importResult,
            }));
            if (shouldImport && importResult.accepted > 0) {
                appendLedgerEntry(ctx.mesh.id, {
                    kind: 'ledger_replicated',
                    nodeId: node.id,
                    payload: {
                        protocol: 'adhdev.mesh.ledger.slice.v1',
                        imported: importResult.accepted,
                        skippedDuplicate: importResult.skippedDuplicate,
                        rejectedInvalid: importResult.rejectedInvalid,
                        nextAfterId: slice.cursor?.nextAfterId ?? null,
                        via: 'p2p_datachannel',
                    },
                });
            }
        } catch (e: any) {
            replicas.push(buildMeshLedgerReplicaEvidence({
                nodeId: node.id,
                daemonId: node.daemonId,
                transport: node.daemonId ? 'p2p_datachannel' : 'local',
                status: 'failed',
                error: e?.message ?? String(e),
            }));
        }
    }

    const evidence = buildMeshLedgerReconciliationEvidence(ctx.mesh.id, replicas);
    appendLedgerEntry(ctx.mesh.id, {
        kind: 'ledger_reconciled',
        payload: {
            protocol: evidence.protocol,
            sourceOfTruth: evidence.sourceOfTruth,
            totals: evidence.totals,
            convergence: evidence.convergence,
        },
    });
    return JSON.stringify({ success: true, evidence }, null, 2);
}

export async function meshRequeueHeldEvents(
    ctx: MeshContext,
    args: { filter?: { task_id?: string; taskId?: string; node_id?: string; nodeId?: string; event?: string; reason?: string; since?: string } },
): Promise<string> {
    const { mesh } = ctx;
    const raw = args.filter && typeof args.filter === 'object' ? args.filter : undefined;
    const filter = raw
        ? {
            ...(readString(raw.task_id) || readString(raw.taskId) ? { taskId: (readString(raw.task_id) || readString(raw.taskId)) } : {}),
            ...(readString(raw.node_id) || readString(raw.nodeId) ? { nodeId: (readString(raw.node_id) || readString(raw.nodeId)) } : {}),
            ...(readString(raw.event) ? { event: readString(raw.event) } : {}),
            ...(readString(raw.reason) ? { reason: readString(raw.reason) } : {}),
            ...(readString(raw.since) ? { since: readString(raw.since) } : {}),
        }
        : undefined;

    const result = requeueHeldMeshCoordinatorEvents(mesh.id, filter && Object.keys(filter).length > 0 ? filter : undefined);

    const note = result.matched === 0
        ? 'No recoverable held events matched. Nothing to requeue.'
        : `${result.requeued} held event(s) restored to the pending queue`
            + (result.dedupSuppressed > 0 ? ` (${result.dedupSuppressed} collapsed onto still-live duplicates)` : '')
            + (result.alreadyRequeued > 0 ? `; ${result.alreadyRequeued} already recovered by a prior pass` : '')
            + (result.unrecoverable > 0 ? `; ${result.unrecoverable} had no restorable original event` : '')
            + '. A coordinator will drain them on its next poll.';

    return JSON.stringify({ success: true, ...result, note }, null, 2);
}

export async function meshMissionUpsert(
    ctx: MeshContext,
    args: { mission_id?: string; missionId?: string; mission_ids?: unknown; missionIds?: unknown; title?: string; goal?: string; status?: string },
): Promise<string> {
    // Bulk mode: mission_ids[] + status applies one status to many missions (stale
    // cleanup). Takes precedence over the single mission_id path. title/goal are ignored;
    // each mission keeps its own title (upsertMeshMission needs a non-empty title, so we
    // re-supply the existing one per mission).
    const bulkIds = normalizeMissionIdList(args.mission_ids ?? args.missionIds);
    if (bulkIds.length > 0) {
        return meshMissionUpsertBulk(ctx, bulkIds, readString(args.status));
    }

    try {
        const title = readString(args.title);
        if (!title) {
            return JSON.stringify({
                success: false,
                code: 'mission_title_required',
                error: 'mission_title_required: single-mission upsert needs a non-empty title. For a bulk status transition pass mission_ids (array) + status instead.',
            });
        }
        const mission = upsertMeshMission(ctx.mesh.id, {
            id: readString(args.mission_id) || readString(args.missionId) || undefined,
            title,
            goal: typeof args.goal === 'string' ? args.goal : undefined,
            status: readString(args.status) || undefined,
        });
        return JSON.stringify({
            success: true,
            mission,
            nextAction: 'Attach tasks with mesh_enqueue_task mission_id and depends_on. mesh_status shows live task aggregates for this mission.',
        });
    } catch (e: any) {
        const message = e?.message || String(e);
        const code = message.includes('mission_title_required') ? 'mission_title_required'
            : message.includes('invalid_mission_status') ? 'invalid_mission_status'
            : undefined;
        return JSON.stringify({ success: false, ...(code ? { code } : {}), error: message });
    }
}

/** Coerce a mission_ids input into a de-duplicated list of non-empty string ids. */
function normalizeMissionIdList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    for (const raw of value) {
        const id = typeof raw === 'string' ? raw.trim() : '';
        if (id) seen.add(id);
    }
    return [...seen];
}

/**
 * G3 (step ②) — bulk mission status transition. Applies `status` to every id in
 * `missionIds`, returning a per-mission result so a partial failure (unknown id,
 * invalid status) never silently drops the rest. Each mission keeps its own title —
 * upsertMeshMission requires a non-empty title, so we look up the existing record and
 * re-supply its title while changing only the status. Primary use: the one-time cleanup
 * of accumulated stale missions.
 */
async function meshMissionUpsertBulk(
    ctx: MeshContext,
    missionIds: string[],
    status: string | undefined,
): Promise<string> {
    if (!status) {
        return JSON.stringify({
            success: false,
            code: 'bulk_status_required',
            error: 'bulk mission upsert (mission_ids) requires a status to apply to every listed mission.',
        });
    }
    const results = missionIds.map((id) => {
        try {
            const existing = getMeshMission(ctx.mesh.id, id);
            if (!existing) return { id, ok: false, error: 'mission_not_found' };
            const updated = upsertMeshMission(ctx.mesh.id, {
                id,
                title: existing.title,
                status,
            });
            return { id, ok: true, status: updated.status };
        } catch (e: any) {
            const message = e?.message || String(e);
            const code = message.includes('invalid_mission_status') ? 'invalid_mission_status' : undefined;
            return { id, ok: false, error: message, ...(code ? { code } : {}) };
        }
    });
    const applied = results.filter(r => r.ok).length;
    const failed = results.length - applied;
    return JSON.stringify({
        success: failed === 0,
        mode: 'bulk',
        requestedStatus: status,
        applied,
        failed,
        results,
        nextAction: failed === 0
            ? `Applied status '${status}' to ${applied} mission(s).`
            : `${applied} applied, ${failed} failed — see results[] for per-mission errors.`,
    });
}

export async function meshMissionList(
    ctx: MeshContext,
    args: {
        status?: string | string[];
        verbose?: boolean;
        include_magi?: boolean;
        includeMagi?: boolean;
        include_stats?: boolean;
        includeStats?: boolean;
        limit?: number;
    } = {},
): Promise<string> {
    try {
        const rawStatuses = Array.isArray(args.status)
            ? args.status
            : typeof args.status === 'string' && args.status.trim()
                ? [args.status]
                : [];
        const invalid = rawStatuses.filter(s => !MESH_MISSION_STATUSES.includes(s as any));
        if (invalid.length > 0) {
            return JSON.stringify({
                success: false,
                code: 'invalid_mission_status',
                error: `invalid status filter: ${invalid.join(', ')} (valid: ${MESH_MISSION_STATUSES.join(', ')})`,
            });
        }
        const statuses = rawStatuses.length > 0 ? (rawStatuses as any[]) : undefined;
        const includeMagi = (args.include_magi ?? args.includeMagi) === true;
        const verbose = args.verbose === true;
        // stats are ledger-scanned per mission — off by default so a list view stays
        // bounded. verbose or explicit include_stats opts in. The `tasks` aggregate on
        // each mission already carries progress for the common list case.
        const withStats = verbose || (args.include_stats ?? args.includeStats) === true;
        const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
            ? Math.floor(args.limit)
            : undefined;
        const result = listMeshMissionsForTool(ctx.mesh.id, {
            statuses,
            verbose,
            includeMagi,
            withStats,
            limit,
        });
        return JSON.stringify({
            success: true,
            count: result.missions.length,
            matched: result.matched,
            ...(result.truncated ? { truncated: true, overflowIds: result.overflowIds } : {}),
            ...(statuses ? { statusFilter: statuses } : {}),
            ...(includeMagi ? { includeMagi: true } : { magiCompletedHidden: true }),
            ...(withStats ? {} : { statsHidden: true }),
            missions: result.missions,
            ...(result.historyFold ? { historyFold: result.historyFold } : {}),
        }, null, 2);
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e?.message || String(e) });
    }
}

export async function meshReviewInbox(
    ctx: MeshContext,
    args: { mesh_id?: string } = {},
): Promise<string> {
    await refreshMeshFromDaemon(ctx);
    const meshId = (args.mesh_id ?? ctx.mesh.id).trim();
    const result = await commandForNode(ctx, ctx.mesh.nodes[0], 'get_mesh_review_inbox', {
        meshId,
        inlineMesh: ctx.mesh,
    });
    return JSON.stringify(result, null, 2);
}
