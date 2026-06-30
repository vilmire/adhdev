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
    computeMeshMissionStats,
    computeMeshTaskStats,
    drainCoordinatorPendingEvents,
    getLedgerSummary,
    isLocalControlPlaneNode,
    listMeshMissionSummaries,
    readLedgerEntries,
    readLedgerSlice,
    readLedgerSliceFromStore,
    readString,
    refreshMeshFromDaemon,
    slimLedgerPayload,
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

export async function meshMissionUpsert(
    ctx: MeshContext,
    args: { mission_id?: string; missionId?: string; title: string; goal?: string; status?: string },
): Promise<string> {
    try {
        const mission = upsertMeshMission(ctx.mesh.id, {
            id: readString(args.mission_id) || readString(args.missionId) || undefined,
            title: args.title,
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

export async function meshMissionList(
    ctx: MeshContext,
    args: { status?: string | string[]; verbose?: boolean; include_magi?: boolean; includeMagi?: boolean } = {},
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
        const missions = listMeshMissionSummaries(ctx.mesh.id, {
            statuses,
            verbose: args.verbose === true,
            includeMagi,
        }).map(mission => {
            try {
                return { ...mission, stats: computeMeshMissionStats(ctx.mesh.id, mission.id) };
            } catch {
                return mission;
            }
        });
        return JSON.stringify({
            success: true,
            count: missions.length,
            ...(statuses ? { statusFilter: statuses } : {}),
            ...(includeMagi ? { includeMagi: true } : { magiCompletedHidden: true }),
            missions,
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
