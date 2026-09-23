// Mesh tool implementations — mission domain.
// Pure move out of mesh-tools.ts (no behavior change). Shared helpers, types, module
// state and dependency re-exports live in ./mesh-tools-internal.ts; mesh-tools.ts is a barrel.
//
// MIGRATION STATUS (wiring-unification Phase C, workstream C-W6 —
// docs/design/2026-09-23-wiring-unification.md §5 C2 "MCP server" paragraph):
// the mission-CRUD functions below (meshMissionUpsert / meshMissionUpsertBulk /
// meshMissionList) now call `missionUpsert`/`missionQuery` over IPC
// (`../ipc/turn-commands.js`) instead of the in-process `upsertMeshMission`/
// `getMeshMission`/`listMeshMissionsForTool`. This is the file the C-W6 brief
// and pre-work report both name as the one place mission CRUD's "no home in
// the six commands" gap was closed (turn-ipc.ts's `mission_upsert`/
// `mission_query` decision, 2026-09-23).
//
// NOT migrated in this pass — each is either genuinely out of the 8-command
// surface today or independently broken by concurrent C-W3/C-W4 deletions,
// not something this file's migration should paper over with a guess:
//   - meshRecordNote / meshForgetNote: write/tombstone `coordinator_operating_note`
//     ledger entries carrying a free-text `text` field. That is CONTENT — it
//     cannot go through `mesh_record`'s scalar ProjectedScalars allow-list (see
//     turn-ipc.ts's file header) and has no IPC command of its own yet. A
//     REQUESTED EDIT for the owner: route operating notes through
//     `mesh.<id>.handoff` (C10-1's precedent for free-text mission/graph state)
//     with a dedicated IPC command, or an explicit decision to keep this one
//     in-process as a deliberate carve-out. Left calling `appendLedgerEntry`/
//     `tombstoneOperatingNote` (still live daemon-core exports) unchanged.
//   - meshReconcileLedger: P2P ledger-slice reconciliation
//     (`readLedgerSliceFromStore`/`appendRemoteLedgerEntries`/
//     `buildMeshLedgerReplicaEvidence`) — C7-6 parity-system territory, a
//     different workstream. Left unchanged.
//   - meshTaskHistory / meshLedgerQuery: general ledger browsing by arbitrary
//     `kind`/`since`/`node` filters — `turn_query`'s shape
//     (`{meshId, taskId?, attemptId?, sessionId?, state?, since?, tail?}`) has
//     no free-form kind-list or node filter, so this is a real API mismatch,
//     not a mechanical rename. Left on `readLedgerEntries` (still live).

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
    readLedgerSliceFromStore,
    readString,
    refreshMeshFromDaemon,
    slimLedgerPayload,
    tombstoneOperatingNote,
    unwrapCommandPayload,
} from './mesh-tools-internal.js';
import type {
    MeshContext,
} from './mesh-tools-internal.js';
import { missionUpsert, missionQuery, TurnIpcCommandError } from '../ipc/turn-commands.js';
import type { MeshMissionStatusValue } from '@adhdev/mesh-shared';

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
    args: {
        text?: string;
        category?: string;
        pinned?: boolean;
        ttl_days?: number;
        expiresAt?: string;
        supersedes?: string;
        subject_key?: string;
    },
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
    // Operating-notes lifecycle: pinned notes always ride the prompt and never
    // expire. An optional ttl_days (or explicit expiresAt) sets a read-side
    // expiry; ttl_days is resolved to an absolute expiresAt at record time so the
    // note ages deterministically regardless of when it is later injected.
    const pinned = args.pinned === true ? true : undefined;
    let expiresAt: string | undefined;
    if (typeof args.expiresAt === 'string' && !Number.isNaN(new Date(args.expiresAt).getTime())) {
        expiresAt = new Date(args.expiresAt).toISOString();
    } else if (typeof args.ttl_days === 'number' && Number.isFinite(args.ttl_days) && args.ttl_days > 0) {
        expiresAt = new Date(new Date(createdAt).getTime() + args.ttl_days * 24 * 60 * 60 * 1000).toISOString();
    }
    // Phase 2 (b)/(c): supersedes retires an earlier note (by its note_id or a
    // shared subject_key); subject_key groups same-subject notes for read-side
    // folding. Both optional and lossless — absent means supersede nothing / fold
    // only by a leading [tag] prefix.
    const supersedes = typeof args.supersedes === 'string' && args.supersedes.trim() ? args.supersedes.trim() : undefined;
    const subjectKey = typeof args.subject_key === 'string' && args.subject_key.trim() ? args.subject_key.trim() : undefined;
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
            ...(pinned ? { pinned } : {}),
            ...(expiresAt ? { expiresAt } : {}),
            ...(supersedes ? { supersedes } : {}),
            ...(subjectKey ? { subjectKey } : {}),
        },
    });
    return JSON.stringify({
        success: true,
        meshId: mesh.id,
        noteId: entry.id,
        recorded: {
            text,
            category: category ?? null,
            createdAt,
            pinned: pinned ?? false,
            expiresAt: expiresAt ?? null,
            supersedes: supersedes ?? null,
            subjectKey: subjectKey ?? null,
        },
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
        // MISSION-UPSERT-SILENT-CREATE: a note_id is a specific, singular target — unlike
        // text (which can legitimately match zero notes, e.g. retracting-by-content when
        // nothing currently matches that wording). A caller that supplied note_id and got
        // matched:0 almost always passed a truncated/wrong id (the tombstone is still
        // recorded either way — see tombstoneOperatingNote's doc comment — but the caller
        // needs to know their id did NOT hit a live note). success:false here means "the id
        // you gave didn't match anything", distinct from the try/catch failure path below.
        const idTargetMissed = Boolean(noteId) && matched === 0;
        return JSON.stringify({
            success: !idTargetMissed,
            meshId: mesh.id,
            tombstoneId: tombstone.id,
            forgot: { noteId: noteId ?? null, text: text || null, matched },
            ...(idTargetMissed ? { code: 'note_not_found' } : {}),
            note: matched > 0
                ? `Retracted ${matched} operating note(s). Future coordinators on this mesh will no longer see them at launch. History is preserved (append-only tombstone).`
                : idTargetMissed
                    ? `No live operating note matched note_id '${noteId}' — likely a truncated/wrong id (this tool requires an exact match). A tombstone was still recorded so any matching note appended later is also suppressed, but nothing was actually retracted. Use mesh_task_history or mesh_record_note's returned noteId to get the full id.`
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

    // OFFLINE-NODE-BLOCKING: the ledger fan-out issues one `get_mesh_ledger_slice` per
    // node. Run them concurrently with per-node error isolation (Promise.allSettled) so a
    // single dead node no longer serializes the rest, AND stamp the read-only slice probe
    // with the status-origin marker ({ statusProbe: true }) so the daemon-cloud relay grants
    // the SHORT connect-wait budget — an offline (powered-off) node is rejected in ~2s with
    // PEER_NOT_CONNECTED instead of sinking into the 90s connect deadline. Order-preserving:
    // results are collected back in `nodes` order so the aggregated evidence is unchanged.
    const reconcileNode = async (node: (typeof nodes)[number]): Promise<any> => {
        try {
            if (isLocalControlPlaneNode(ctx, node) || !node.daemonId) {
                // G4: Use SQLite mesh_event_ledger (bounded slice) as the local P2P reconcile read path.
                // readLedgerSlice (JSONL) is retained for per-daemon P2P export; coordinator local reads use SQLite.
                const slice = readLedgerSliceFromStore(ctx.mesh.id, queryArgs);
                return buildMeshLedgerReplicaEvidence({
                    nodeId: node.id,
                    daemonId: node.daemonId,
                    transport: 'local',
                    slice,
                    status: 'local',
                });
            }

            const result = await commandForNode(ctx, node, 'get_mesh_ledger_slice', queryArgs, { statusProbe: true });
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
            return buildMeshLedgerReplicaEvidence({
                nodeId: node.id,
                daemonId: node.daemonId,
                transport: 'p2p_datachannel',
                slice,
                importResult,
            });
        } catch (e: any) {
            return buildMeshLedgerReplicaEvidence({
                nodeId: node.id,
                daemonId: node.daemonId,
                transport: node.daemonId ? 'p2p_datachannel' : 'local',
                status: 'failed',
                error: e?.message ?? String(e),
            });
        }
    };

    const settled = await Promise.allSettled(nodes.map(reconcileNode));
    settled.forEach((outcome, idx) => {
        if (outcome.status === 'fulfilled') {
            replicas.push(outcome.value);
        } else {
            // reconcileNode swallows its own errors, so a rejection here is unexpected —
            // fall back to a failed-replica marker rather than dropping the node silently.
            const node = nodes[idx];
            replicas.push(buildMeshLedgerReplicaEvidence({
                nodeId: node.id,
                daemonId: node.daemonId,
                transport: node.daemonId ? 'p2p_datachannel' : 'local',
                status: 'failed',
                error: outcome.reason?.message ?? String(outcome.reason),
            }));
        }
    });

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

function isMeshMissionStatusValue(value: string | undefined): value is MeshMissionStatusValue {
    return value !== undefined && (MESH_MISSION_STATUSES as readonly string[]).includes(value);
}

/** Maps a thrown TurnIpcCommandError (daemon_required / turn_ledger_unavailable / ledger_not_owner) onto this tool's JSON error shape. */
function missionIpcErrorResult(e: unknown): { success: false; code?: string; error: string } {
    const message = (e as any)?.message || String(e);
    // A domain refusal the daemon's mission store raised (it reaches the client
    // as the IPC error's message, under the transport fallback code) wins over
    // the transport code: `mission_not_found` is actionable, `turn_ledger_unavailable` is not.
    const domainCode = message.includes('mission_title_required') ? 'mission_title_required'
        : message.includes('invalid_mission_status') ? 'invalid_mission_status'
        : message.includes('mission_not_found') ? 'mission_not_found'
        : undefined;
    if (domainCode) return { success: false, code: domainCode, error: message };
    if (e instanceof TurnIpcCommandError) return { success: false, code: e.code, error: message };
    return { success: false, error: message };
}

export async function meshMissionUpsert(
    ctx: MeshContext,
    args: { mission_id?: string; missionId?: string; mission_ids?: unknown; missionIds?: unknown; title?: string; goal?: string; status?: string },
): Promise<string> {
    // Bulk mode: mission_ids[] + status applies one status to many missions (stale
    // cleanup). Takes precedence over the single mission_id path. title/goal are ignored;
    // each mission keeps its own title (missionUpsert needs a non-empty title, so we
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
        const statusArg = readString(args.status) || undefined;
        if (statusArg !== undefined && !isMeshMissionStatusValue(statusArg)) {
            return JSON.stringify({
                success: false,
                code: 'invalid_mission_status',
                error: `invalid_mission_status: '${statusArg}' (valid: ${MESH_MISSION_STATUSES.join(', ')})`,
            });
        }
        const { mission } = await missionUpsert(ctx.transport, {
            meshId: ctx.mesh.id,
            id: readString(args.mission_id) || readString(args.missionId) || undefined,
            title,
            goal: typeof args.goal === 'string' ? args.goal : undefined,
            status: statusArg,
        });
        return JSON.stringify({
            success: true,
            mission,
            nextAction: 'Attach tasks with mesh_enqueue_task mission_id and depends_on. mesh_status shows live task aggregates for this mission.',
        });
    } catch (e: any) {
        return JSON.stringify(missionIpcErrorResult(e));
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
 * `missionUpsert` requires a non-empty title, so we look up the existing record (via
 * `missionQuery`) and re-supply its title while changing only the status. Primary use:
 * the one-time cleanup of accumulated stale missions.
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
    if (!isMeshMissionStatusValue(status)) {
        // Per-mission results (the pre-IPC shape): every listed mission is
        // reported as refused with the same code, and nothing is written.
        const error = `invalid_mission_status: '${status}' (valid: ${MESH_MISSION_STATUSES.join(', ')})`;
        const results = missionIds.map((id) => ({ id, ok: false, code: 'invalid_mission_status', error }));
        return JSON.stringify({
            success: false,
            mode: 'bulk',
            code: 'invalid_mission_status',
            error,
            requestedStatus: status,
            applied: 0,
            failed: results.length,
            results,
        });
    }
    // One missionQuery(id) + one missionUpsert per id — same two IPC round trips
    // per mission the in-process version did as two function calls; run serially
    // (not Promise.all) so a slow daemon-side write can't reorder onto a stale
    // read for a later id in the same batch.
    const results: Array<{ id: string; ok: boolean; status?: string; error?: string; code?: string }> = [];
    for (const id of missionIds) {
        try {
            const { missions } = await missionQuery(ctx.transport, { meshId: ctx.mesh.id, id });
            const existing = missions[0];
            if (!existing) {
                results.push({ id, ok: false, error: 'mission_not_found' });
                continue;
            }
            const { mission: updated } = await missionUpsert(ctx.transport, {
                meshId: ctx.mesh.id,
                id,
                title: existing.title,
                status,
            });
            results.push({ id, ok: true, status: updated.status });
        } catch (e: any) {
            const errResult = missionIpcErrorResult(e);
            results.push({ id, ok: false, error: errResult.error, ...(errResult.code ? { code: errResult.code } : {}) });
        }
    }
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

// NOT migrated to `missionQuery` (see file-header migration-status note):
// `missionQuery`'s landed response is `{missions: MeshMissionRecordWire[]}`
// only — no `verbose`/`includeMagi`/`withStats`/`limit`/`truncated`/
// `overflowIds`/`historyFold`, all of which `listMeshMissionsForTool` (still a
// live daemon-core export) computes today. Widening `missionQuery`'s wire
// contract is a mesh-shared change outside a same-file swap and would touch
// an already-tested, already-landed contract other callers may rely on — a
// REQUESTED EDIT for the mesh-shared/turn-ipc.ts owner, not something to
// guess at here. Left on the in-process read; only the write path
// (meshMissionUpsert/meshMissionUpsertBulk, above) moved.
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
    // OFFLINE-NODE-BLOCKING: the review inbox is read from a single hardcoded node
    // (nodes[0]). If that node is offline (powered off) the read-only `get_mesh_review_inbox`
    // relay would otherwise sink into the 90s connect deadline. Stamp the status-origin
    // marker ({ statusProbe: true }) so the daemon-cloud relay grants the SHORT connect-wait
    // budget and an offline nodes[0] fails fast (~2s) instead of hanging the inbox read.
    const result = await commandForNode(ctx, ctx.mesh.nodes[0], 'get_mesh_review_inbox', {
        meshId,
        inlineMesh: ctx.mesh,
    }, { statusProbe: true });
    return JSON.stringify(result, null, 2);
}
