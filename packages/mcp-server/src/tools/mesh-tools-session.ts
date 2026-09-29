// Mesh tool implementations — session domain.
// Pure move out of mesh-tools.ts (no behavior change). Helpers are imported from the
// modules that define them; mesh-tools.ts is the tool barrel.

import {
    commandForNode,
    drainCoordinatorPendingEvents,
    findNodeWithRefresh,
    findOptionalNodeWithRefresh,
    readActiveWorkFromDaemon,
    recordMeshCoordinatorToolCall,
    refreshMeshFromDaemon,
    triggerMeshQueueAndReport,
} from './mesh-tools-internal.js';
import { IpcTransport } from '../transports/ipc.js';
import {
    SESSION_PROVIDER_METADATA_TTL_MS,
    getSessionMetadata,
    meshSessionCacheKey,
    meshSessionProviderMetadata,
    resolveMeshSessionProviderMetadata,
} from './mesh-session-metadata.js';
import { annotateRapidReadChatAdvisory } from './read-chat-polling-advisory.js';
import {
    collectPendingApprovals,
    isP2pRelayTransportFailure,
    resolveAllowSendKeysDestructive,
    resolveDelegatedWorkerAutoApprove,
    resolveDelegatedWorkerDangerousModeAllow,
    loadRepoMeshJsonConfig,
} from '@adhdev/daemon-core';
import { buildMeshReadChatCacheFallback, buildMissingNodeReadChatRecovery } from './mesh-read-chat-fallback.js';
import { buildMissingCoordinatorDaemonIdFailure } from './mesh-remote-dispatch.js';
import {
    buildQueueTriggerGuidance,
    extractLaunchPayload,
    getWorktreeBootstrapLaunchBlock,
    isMeshOwnedDelegateSession,
    missingProviderPriorityMessage,
    readProviderPriority,
    readSpawnedSessionVisibility,
} from './mesh-tools-internal-core.js';
import { compactChatPayload } from './chat-compact.js';
import {
    isIdleSessionRecord,
    isTerminalSessionRecord,
    readSessionRecordId,
    resolveSessionProviderType,
    unwrapCommandPayload,
} from './mesh-session-helpers.js';
import { isLocalControlPlaneNode, resolveCoordinatorDaemonId, resolveCoordinatorNode } from './mesh-node-identity.js';
import { recordRecoverableLaunchFailure } from './mesh-launch-failure.js';
import type {
    MeshContext,
} from './mesh-tools-internal.js';
// Node runtime is the coordinator daemon's answer only — its own status or a
// member's pushed runtime it holds (mesh-held-node-state.ts); no member is read.
import { collectMeshNodesWithRuntime, readNodeRuntime } from './mesh-held-node-state.js';
import { scheduleBackgroundDirectReconcile } from './mesh-status-background.js';
// §8 unit 6 ("mesh_read_chat remote display cutover") — the FIRST hop of the
// fixed `replica → live P2P read_chat → cached summary` order.
import { readTranscriptReplicaForDisplay } from './mesh-transcript-replica-read.js';
import { normalizeNodeCapabilitySlots, readString } from '@adhdev/mesh-shared';
// QUOTA GATE for the manual launch path. Same judgement module the auto-launch /
// queue-drain path uses (daemon-core resolveUsableProvider) — deliberately shared
// rather than reimplemented, so the two dispatch paths can never disagree about
// what "out of quota" means, and so the fail-open contract has exactly one
// definition. See mesh-quota-routing.ts.
import { evaluateProviderQuotaGate, rankProvidersByQuotaGate, type LocalMeshNodeEntry } from '@adhdev/daemon-core';
// F1: worker-protocol footer materialization on the direct-dispatch path — not
// (yet) re-exported through mesh-tools-internal.ts, imported directly like the
// quota-gate symbols above.
// GIT-GATE (owner-requested follow-up to H1): the SAME dirty/stale predicates the
// claim-time gate (mesh-queue-assignment.ts, daemon-side) and the auto-launch spawn gate
// (mesh-queue-autolaunch.ts) apply — imported rather than reimplemented so a direct
// dispatch from this MCP tool can never drift onto separate dirty/stale logic. See the
// re-export note on mesh-auto-fast-forward.ts in daemon-core's index.ts.
// C-W6c: direct-dispatch bookkeeping now drives the NEW turn ledger (C1 reducer)
// via IPC, instead of the legacy openTurnAttempt/recordTurnAck pair that
// recordDirectDispatchTask used to trigger in-process. See the design's C2
// paragraph and the C-W6c report's "direct dispatch end to end" deliverable.
import { pruneStaleDirect, recordLocal } from '../ipc/turn-commands.js';
import { ensureMeshNodeRoutes } from './mesh-node-routes.js';

/**
 * Prune orphaned staleDirect dispatch records — direct dispatches whose original node/session is
 * no longer present in the live mesh (or terminal). dry_run (default) reports exactly which
 * taskIds would be pruned without mutating anything; pass execute=true to actually remove them.
 *
 * Safety:
 *  - Only records classified as staleDirectWork by buildMeshActiveWork against the CURRENT live
 *    mesh are eligible — active/pending/assigned/generating work is never in that set.
 *  - Of those, only orphans (node/session gone) are pruned. Fresh unacknowledged dispatch
 *    failures (staleDispatchUnacknowledged: node/session still live) are explicitly preserved and
 *    reported under preservedUnacknowledged so the caller can recover them.
 *  - Pruning deletes only the legacy direct-dispatch table store rows; the append-only mesh ledger
 *    (audit history) is left intact, and a direct_dispatch_pruned ledger entry is appended on
 *    execute so the prune itself is auditable.
 */
export async function meshPruneStaleDirect(
    ctx: MeshContext,
    args: { execute?: boolean; dry_run?: boolean; include_terminal?: boolean } = {},
): Promise<string> {
    await refreshMeshFromDaemon(ctx);
    // DRY-RUN-SILENTLY-IGNORED (same class as mesh_fast_forward_node): dry_run
    // is a veto, not a trigger, so `dry_run:false` alone silently previews when
    // the caller meant to execute. Refuse that shape rather than no-op.
    if (args.dry_run === false && args.execute !== true) {
        return JSON.stringify({
            success: false,
            code: 'dry_run_false_requires_execute',
            executed: false,
            error: 'dry_run:false alone does not execute — it only declines to veto. Pass execute:true to actually prune.',
            nextAction: 'Re-run mesh_cleanup_sessions(mode: "prune_stale_direct", execute: true) to prune, or omit dry_run to preview.',
        }, null, 2);
    }
    // execute must be explicit; dry_run is the default unless execute===true.
    const execute = args.execute === true && args.dry_run !== true;
    const includeTerminal = args.include_terminal === true;

    // C-W9c: the whole prune core (inputs, decision, deletion, audit record, and
    // closing each prunable dispatch's open mesh_direct turn-ledger attempt) now
    // runs in the daemon — one round trip instead of reading records/queue over
    // IPC and reconstructing the closeDispatches closure over turn_cancel here.
    const result = await pruneStaleDirect(ctx.transport, {
        meshId: ctx.mesh.id,
        execute,
        includeTerminal,
        source: 'mesh_prune_stale_direct',
    });

    const { prunable, prunedCount, preservedUnacknowledged, preservedLedgerOnly, preservedNotOrphan } = result;

    const summarize = (records: typeof prunable) => records.map(r => ({
        taskId: r.taskId as string,
        nodeId: r.nodeId as string | undefined,
        sessionId: r.sessionId as string | undefined,
        status: r.status as string | undefined,
        terminal: r.terminal === true,
        staleReason: r.staleReason as string | undefined,
        taskTitle: r.taskTitle as string | undefined,
        createdAt: r.createdAt as string | undefined,
    }));

    return JSON.stringify({
        success: true,
        mode: result.mode,
        meshId: ctx.mesh.id,
        includeTerminal,
        candidateCount: result.candidateCount,
        prunableCount: prunable.length,
        prunedCount,
        prunable: summarize(prunable),
        preserved: {
            unacknowledgedCount: preservedUnacknowledged.length,
            ledgerOnlyCount: preservedLedgerOnly.length,
            notOrphanCount: preservedNotOrphan.length,
            unacknowledged: summarize(preservedUnacknowledged),
            ledgerOnly: summarize(preservedLedgerOnly),
            notOrphan: summarize(preservedNotOrphan),
        },
        note: execute
            ? `Pruned ${prunedCount} orphaned direct dispatch record(s) from the active staleDirect surface. The append-only mesh ledger audit history is preserved; a direct_dispatch_pruned entry records this prune.`
            : 'Dry run — nothing was deleted. Re-run with execute=true to prune the listed orphaned records. Fresh unacknowledged dispatch failures (node/session still live) and ledger-only audit entries are always preserved.',
    }, null, 2);
}

/**
 * E-T0 (design §7.1) — deposit an urgent memo into a delegated worker's
 * mailbox. Routed to whichever daemon owns `node_id` via `findNodeWithRefresh`
 * + `commandForNode` — the SAME resolution `meshSendTask` (mesh-tools-send-task.ts) uses, because
 * a worker's owning daemon is not necessarily this coordinator's own (a mesh
 * spans machines). The receiving daemon's `deposit_worker_mailbox` low-family
 * handler is the actual gate (flag check + "does this daemon know this task");
 * this function is a thin dispatch wrapper around it.
 */
export async function meshNotifyWorker(
    ctx: MeshContext,
    args: { node_id?: string; task_id?: string; message?: string },
): Promise<string> {
    const nodeId = readString(args.node_id);
    const taskId = readString(args.task_id);
    const message = readString(args.message);
    if (!nodeId || !taskId || !message) {
        return JSON.stringify({
            success: false,
            error: 'invalid_input',
            detail: 'node_id, task_id and message are all required',
        });
    }

    let node;
    try {
        node = await findNodeWithRefresh(ctx, nodeId);
    } catch (e: any) {
        return JSON.stringify({ success: false, error: 'node_not_found', detail: e?.message || String(e) });
    }

    const result = unwrapCommandPayload(await commandForNode(ctx, node, 'deposit_worker_mailbox', {
        meshId: ctx.mesh.id,
        taskId,
        text: message,
    }));

    if (result?.success !== true) {
        return JSON.stringify({
            success: false,
            error: result?.error || 'unknown_error',
            ...(result?.detail ? { detail: result.detail } : {}),
        });
    }
    return JSON.stringify({
        success: true,
        messageId: result.messageId,
        pending: result.pending,
        note: "Delivered on the worker's next MCP tool response (E-T0 mailbox piggyback) — not instantaneous. "
            + 'If the worker is deep in a long generation turn without calling a tool, it will not see this until it does.',
    });
}

export async function meshReadChat(
    ctx: MeshContext,
    args: { node_id: string; session_id: string; provider_session_id?: string; tail?: number; compact?: boolean },
): Promise<string> {
    const node = await findOptionalNodeWithRefresh(ctx, args.node_id);
    if (!node) {
        return JSON.stringify(await buildMissingNodeReadChatRecovery(ctx, args), null, 2);
    }

    // The drain marks rows `drained=1`. For an MCP-only coordinator (no live CLI
    // to inject into) the drained completions are the coordinator's ONLY copy, so
    // discarding the result here consumed them unseen (found by the 2026-09-23
    // C-W3 delivery audit). Attach them to every return path, as mesh_status does.
    // Phase C replaces this piggyback with the IPC `turn.notify` read + ack.
    const pendingCoordinatorEvents = await drainCoordinatorPendingEvents(ctx, { nodeIds: [args.node_id] });
    const withPending = (rendered: string): string => attachPendingCoordinatorEvents(rendered, pendingCoordinatorEvents);

    const cached = await resolveMeshSessionProviderMetadata(ctx, args.node_id, args.session_id);
    const providerSessionId = typeof args.provider_session_id === 'string' && args.provider_session_id.trim()
        ? args.provider_session_id.trim()
        : cached?.providerSessionId;
    // Local vs remote (the replica hop below) is the coordinator daemon's answer.
    await ensureMeshNodeRoutes(ctx);
    const isLocalNode = isLocalControlPlaneNode(ctx, node);

    // ── §8 unit 6: replica hop (design §4 roster id 3) ──────────────────────
    // Fixed fallback order `replica → live P2P read_chat → cached summary`.
    // REMOTE nodes only: a local node's read_chat is an in-process call against
    // the provider source, which the roster keeps as-is. `readTranscriptReplica
    // ForDisplay` never throws and returns null for every non-answer, so the
    // two hops below are reached unchanged.
    let replicaFallbackReason: string | null = null;
    let providerSessionWarning: Record<string, unknown> = {};
    // An EXPLICIT provider_session_id asks for one provider conversation. The replica is
    // keyed by (owner daemon, runtime session) and always holds that session's CURRENT
    // conversation, so it can only answer when its snapshot names the same provider
    // session; otherwise the read falls through to the live read_chat (which honours
    // providerSessionId) and says so — never a silent answer for a different conversation.
    const requestedProviderSessionId = typeof args.provider_session_id === 'string' && args.provider_session_id.trim()
        ? args.provider_session_id.trim()
        : undefined;
    if (!isLocalNode && ctx.transport instanceof IpcTransport && node.daemonId) {
        const replica = await readTranscriptReplicaForDisplay(ctx.transport, {
            ownerDaemonId: node.daemonId,
            rawSessionId: args.session_id,
        });
        const replicaProviderSessionId = typeof replica.payload?.providerSessionId === 'string' ? replica.payload.providerSessionId : '';
        if (replica.payload && requestedProviderSessionId && replicaProviderSessionId !== requestedProviderSessionId) {
            replicaFallbackReason = 'provider_session_mismatch';
            providerSessionWarning = {
                providerSessionWarning: `The transcript replica holds provider session '${replicaProviderSessionId || 'unknown'}', not the requested '${requestedProviderSessionId}'; read the live session instead.`,
            };
        } else if (replica.payload) {
            return withPending(renderMeshReadChatPayload(replica.payload, args));
        } else {
            replicaFallbackReason = replica.fallbackReason;
        }
    }

    let result: any;
    try {
        result = await commandForNode(ctx, node, 'read_chat', {
            sessionId: args.session_id,
            targetSessionId: args.session_id,
            workspace: node.workspace,
            ...(cached?.providerType ? { agentType: cached.providerType, providerType: cached.providerType } : {}),
            ...(providerSessionId ? { providerSessionId } : {}),
            tailLimit: args.tail ?? 10,
        });
    } catch (e: any) {
        // Local read_chat and non-transport (provider/logic) failures keep the existing
        // throw so genuine errors still surface. The cache fallback covers ONLY a remote
        // P2P transport failure (saturated/unreachable peer) — read_chat had no catch and
        // hard-failed at the 30s timeout instead of surfacing the coordinator's cached
        // summary. See buildMeshReadChatCacheFallback.
        if (isLocalNode || !isP2pRelayTransportFailure(e)) throw e;
        return withPending(await buildMeshReadChatCacheFallback(ctx, args, node, e));
    }
    return withPending(renderMeshReadChatPayload({ ...(unwrapCommandPayload(result) as Record<string, any>), ...providerSessionWarning }, args, {
        fallbackReason: replicaFallbackReason,
    }));
}

/** Merge drained coordinator events into a JSON tool result (no-op when empty or non-JSON). */
function attachPendingCoordinatorEvents(rendered: string, events: any[]): string {
    if (!Array.isArray(events) || events.length === 0) return rendered;
    try {
        const parsed = JSON.parse(rendered);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return rendered;
        return JSON.stringify({ ...parsed, pendingCoordinatorEvents: events }, null, 2);
    } catch {
        return rendered;
    }
}

/**
 * The compact/full renderer, shared by BOTH mesh_read_chat sources (live
 * `read_chat` and the §8 unit 6 replica). Extracted rather than duplicated
 * precisely because the design's acceptance item is "compact/full parity":
 * with one renderer, a replica-sourced payload cannot drift from a live one in
 * how it is compacted, advisory-annotated or serialized — only in the payload
 * FIELDS, which `mapTranscriptViewToReadChatPayload`'s allow-list governs
 * and the adapter tests pin.
 */
function renderMeshReadChatPayload(
    source: Record<string, any>,
    args: { node_id: string; session_id: string; tail?: number; compact?: boolean },
    opts: { fallbackReason?: string | null } = {},
): string {
    const payload = annotateRapidReadChatAdvisory(source, {
        key: `mesh:${args.node_id}:${args.session_id}`,
        toolName: 'mesh_read_chat',
        completionCallbackExpected: true,
    });
    // Single-source-of-truth telemetry (design §5.6): why this read did NOT
    // come from the replica. Only stamped when the replica hop actually ran
    // and declined — absent on a local node (never attempted) and on a
    // replica-sourced payload (which carries `transcriptReadSource: 'replica'`
    // from the adapter instead).
    const sourceTelemetry = opts.fallbackReason
        ? { transcriptReadSource: 'legacy_read_chat', transcriptFallbackReason: opts.fallbackReason }
        : {};
    // Default compact=true to keep coordinator context lean.
    // Pass compact=false explicitly only when full transcript detail is needed for debugging.
    const useCompact = args.compact !== false;
    if (useCompact) {
        const compactPayload = compactChatPayload(payload, {
            nodeId: args.node_id,
            sessionId: args.session_id,
            limit: args.tail ?? 10,
            // Carry the daemon's Stage 6 turn projection (attemptId/turnStage/
            // authority/terminal outcome) so the slim response stays at parity
            // with daemon read_chat and mesh_status. Non-content scalars only.
            preserveTurn: true,
        });
        return JSON.stringify(
            {
                ...compactPayload,
                ...(payload.transcriptReadSource ? { transcriptReadSource: payload.transcriptReadSource } : {}),
                ...(payload.transcriptReadSource === 'replica'
                    ? { omittedBefore: payload.omittedBefore === true, stale: payload.stale === true }
                    : {}),
                ...sourceTelemetry,
                ...(payload.providerSessionWarning ? { providerSessionWarning: payload.providerSessionWarning } : {}),
                ...(payload.pollingAdvisory ? { pollingAdvisory: payload.pollingAdvisory } : {}),
            },
            null,
            2,
        );
    }
    // compact:false still honours `tail`: keep only the last N messages (a replica payload
    // is the whole retained transcript; a live read already asked for tailLimit=N, so this
    // is a no-op there) and say how many were left out.
    const tail = typeof args.tail === 'number' && Number.isInteger(args.tail) && args.tail > 0 ? args.tail : undefined;
    const messages = Array.isArray(payload.messages) ? payload.messages : undefined;
    const tailed = tail !== undefined && messages && messages.length > tail
        ? { messages: messages.slice(-tail), tailOmittedMessageCount: messages.length - tail }
        : {};
    return JSON.stringify({ ...payload, ...tailed, ...sourceTelemetry }, null, 2);
}

export async function meshReadDebug(
    ctx: MeshContext,
    args: { node_id: string; session_id: string; provider_session_id?: string; tail?: number; delivery?: 'daemon_file' | 'inline' },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    const cached = await resolveMeshSessionProviderMetadata(ctx, args.node_id, args.session_id);
    const providerSessionId = typeof args.provider_session_id === 'string' && args.provider_session_id.trim()
        ? args.provider_session_id.trim()
        : cached?.providerSessionId;
    const delivery = args.delivery === 'inline' ? undefined : 'daemon_file';
    const result = await commandForNode(ctx, node, 'get_chat_debug_bundle', {
        sessionId: args.session_id,
        targetSessionId: args.session_id,
        workspace: node.workspace,
        ...(cached?.providerType ? { agentType: cached.providerType, providerType: cached.providerType } : {}),
        ...(providerSessionId ? { providerSessionId } : {}),
        tailLimit: args.tail ?? 40,
        ...(delivery ? { delivery } : {}),
    });
    const payload = unwrapCommandPayload(result);
    return JSON.stringify(payload, null, 2);
}

/**
 * MESH-READ-TERMINAL (feature 2: RAW terminal read). Read the CURRENT rendered
 * PTY viewport (live screen) of a delegated worker session on a mesh node.
 *
 * OWNERSHIP DOUBLE-CHECK (defense-in-depth, per mission 6938892f class):
 *   1. MCP side (here): resolve the session record from the node's live session
 *      list and require isMeshOwnedDelegateSession(session, meshId, nodeId) —
 *      mesh/session/node identity must match, so a cross-mesh or coordinator-own
 *      session id cannot be read.
 *   2. daemon side (read_terminal → getTerminalScreenSnapshot): gated on
 *      isMeshWorkerSession(). isMeshWorkerSession alone is a broad "delegated"
 *      gate, so the MCP-side identity match is what blocks cross-mesh access.
 *
 * The read_terminal daemon verb is in MESH_FORWARDABLE_SESSION_COMMANDS, so when
 * the worker is a REMOTE node the coordinator's daemon forwards it to the owning
 * worker daemon (which holds the live viewport) instead of returning
 * 'Session not found'.
 */
export async function meshReadTerminal(
    ctx: MeshContext,
    args: { node_id: string; session_id: string; max_bytes?: number },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    // OWNERSHIP DOUBLE-CHECK (MCP side): the session must be a mesh-owned delegate
    // of THIS mesh + node. Resolve it from the node's runtime as the coordinator
    // answers it (readNodeRuntime); a miss or a non-owned/cross-mesh record is
    // refused before any command is issued.
    const { probe: ownershipProbe } = await readNodeRuntime(ctx, node);
    const record = ownershipProbe.sessions.find((s) => readSessionRecordId(s) === args.session_id);
    if (record && !isMeshOwnedDelegateSession(record, ctx.mesh.id, args.node_id)) {
        return JSON.stringify({
            success: false,
            error: 'session is not a mesh-owned delegate of this mesh/node — mesh_read_terminal is scoped to sessions this coordinator spawned',
            nodeId: args.node_id,
            sessionId: args.session_id,
        }, null, 2);
    }

    const cached = await resolveMeshSessionProviderMetadata(ctx, args.node_id, args.session_id);
    const result = await commandForNode(ctx, node, 'read_terminal', {
        sessionId: args.session_id,
        targetSessionId: args.session_id,
        workspace: node.workspace,
        ...(cached?.providerType ? { agentType: cached.providerType, providerType: cached.providerType } : {}),
        ...(typeof args.max_bytes === 'number' && Number.isFinite(args.max_bytes) ? { maxBytes: args.max_bytes } : {}),
    });
    const payload = unwrapCommandPayload(result);
    return JSON.stringify(payload, null, 2);
}

const MESH_SEND_KEYS_DESTRUCTIVE = new Set(['CTRL_C', 'ESC']);

/**
 * MESH-SEND-KEYS (feature 3: key injection). Inject a structured key sequence into
 * a delegated worker session's live PTY.
 *
 * OWNERSHIP DOUBLE-CHECK (per mission 6938892f class, same as mesh_read_terminal):
 *   1. MCP side (here): the session must be isMeshOwnedDelegateSession of THIS
 *      mesh + node — blocks cross-mesh / coordinator-own PTY writes.
 *   2. daemon side (send_keys → injectKeys): gated on isMeshWorkerSession().
 *
 * DESTRUCTIVE DOUBLE GATE (owner-approved): CTRL_C/ESC require BOTH
 * confirm_destructive=true (per-call) AND mesh/node policy allowSendKeysDestructive
 * (opt-in). delegatedWorkerAutoApprove does NOT grant this — it is tool-consent,
 * not PTY-input authority, so a Ctrl-C could otherwise bypass it and kill the
 * worker.
 *
 * The daemon layer independently enforces the submit-race recheck and the
 * actionable-modal fail-closed refusal. Every attempt is AUDITED to the ledger
 * (key enums + result), NEVER the literal text body.
 *
 * send_keys is in MESH_FORWARDABLE_SESSION_COMMANDS so a remote-worker target is
 * forwarded to the owning daemon (which holds the live PTY).
 */
export async function meshSendKeys(
    ctx: MeshContext,
    args: {
        node_id: string;
        session_id: string;
        sequence: Array<{ text?: string; key?: string }>;
        confirm_destructive?: boolean;
        allow_modal_override?: boolean;
    },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);
    const items = Array.isArray(args.sequence) ? args.sequence : [];
    if (items.length === 0) {
        return JSON.stringify({ success: false, error: 'sequence (non-empty array of {text}|{key}) required' }, null, 2);
    }

    // OWNERSHIP DOUBLE-CHECK (MCP side): resolve the session from the node's
    // runtime as the coordinator answers it (readNodeRuntime); refuse a non-owned /
    // cross-mesh record before writing anything.
    const { probe: sendKeysProbe } = await readNodeRuntime(ctx, node);
    const record = sendKeysProbe.sessions.find((s) => readSessionRecordId(s) === args.session_id);
    if (record && !isMeshOwnedDelegateSession(record, ctx.mesh.id, args.node_id)) {
        return JSON.stringify({
            success: false,
            error: 'session is not a mesh-owned delegate of this mesh/node — mesh_send_keys is scoped to sessions this coordinator spawned',
            nodeId: args.node_id,
            sessionId: args.session_id,
        }, null, 2);
    }

    // DESTRUCTIVE DOUBLE GATE.
    const requestedKeys = items
        .map((it) => (it && typeof it.key === 'string' ? it.key : ''))
        .filter(Boolean);
    const hasDestructive = requestedKeys.some((k) => MESH_SEND_KEYS_DESTRUCTIVE.has(k));
    const auditKeys = requestedKeys.slice(0, 64);
    const recordAudit = async (result: string, extra: Record<string, unknown> = {}) => {
        try {
            await recordLocal(ctx.transport, { meshId: ctx.mesh.id,
                kind: 'key_injection',
                nodeId: args.node_id,
                sessionId: args.session_id,
                payload: {
                    keys: auditKeys, // key ENUMS only — never the literal text body
                    hasDestructive,
                    confirmDestructive: args.confirm_destructive === true,
                    result,
                    ...extra,
                },
            });
        } catch { /* ledger append is best-effort */ }
    };

    if (hasDestructive) {
        const policyAllows = resolveAllowSendKeysDestructive(ctx.mesh.policy, node.policy);
        if (args.confirm_destructive !== true || !policyAllows) {
            await recordAudit('refused', { refused: 'destructive_gate', policyAllows });
            return JSON.stringify({
                success: false,
                error: 'destructive key (CTRL_C/ESC) requires BOTH confirm_destructive=true AND mesh policy allowSendKeysDestructive=true',
                refused: 'destructive_gate',
                confirmDestructive: args.confirm_destructive === true,
                policyAllowsDestructive: policyAllows,
            }, null, 2);
        }
    }

    const cached = await resolveMeshSessionProviderMetadata(ctx, args.node_id, args.session_id);
    const result = await commandForNode(ctx, node, 'send_keys', {
        sessionId: args.session_id,
        targetSessionId: args.session_id,
        workspace: node.workspace,
        ...(cached?.providerType ? { agentType: cached.providerType, providerType: cached.providerType } : {}),
        sequence: items,
        confirm_destructive: args.confirm_destructive === true,
        allow_modal_override: args.allow_modal_override === true,
    });
    const payload = unwrapCommandPayload(result) as Record<string, unknown>;
    // Audit the daemon's verdict (injected / refused). The daemon result carries no
    // literal text either, so it is safe to reflect keys/result here.
    if (payload?.success === true) {
        await recordAudit('injected', { submits: payload.submits === true });
    } else {
        await recordAudit('refused', { refused: readString(payload?.refused) || 'error' });
    }
    return JSON.stringify(payload, null, 2);
}

/**
 * PROVIDER-TYPE-HONORED + QUOTA GATE for an explicitly requested launch type.
 *
 * An explicit type is validated ONLY against the node's capability slots
 * (policy.slots) — the single authoritative capability list (node capability
 * slots design, 2026-07-09). When the node declares slots and none names the
 * requested provider, fail closed instead of proceeding: silently resolving to
 * providerPriority[0] was the exact bug (mesh_launch_session(type:"cursor-cli")
 * spawned claude-cli). providerPriority is deliberately NOT consulted — it is an
 * ordered PREFERENCE hint, not a capability whitelist, so a node that declares
 * only providerPriority (no slots) keeps the contract that an explicit type may
 * name any provider (the daemon-side launch is the real gate). Provider names are
 * compared raw — slots store canonical provider types.
 *
 * An explicitly requested provider is an operator OVERRIDE, so a measured quota
 * block does not fail the launch closed — it is surfaced as a WARNING on an
 * otherwise normal launch. Fail-closing here would contradict the contract above
 * and would leave an operator no way to run a provider whose snapshot is wrong.
 * But launching SILENTLY is what produced the 403: the caller could not tell an
 * exhausted provider from a healthy one. Fail-open is inherited unchanged — only
 * a fresh measured block warns at all.
 */
function checkRequestedLaunchType(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    nodeId: string,
    requestedType: string,
): { quotaWarning: Record<string, unknown> | null } | string {
    const slotProviders = normalizeNodeCapabilitySlots((node.policy as any)?.slots).map(s => s.provider);
    if (slotProviders.length && !slotProviders.includes(requestedType)) {
        return JSON.stringify({
            success: false,
            code: 'mesh_provider_type_unsupported',
            error: `Node '${nodeId}' does not support provider '${requestedType}'. Its capability slots (policy.slots) declare: ${slotProviders.join(', ')}. Configure a slot for '${requestedType}' via mesh_node_slots (action "set"), or launch with one of the supported types.`,
            nodeId,
            requestedType,
            supportedProviders: slotProviders,
        }, null, 2);
    }
    const explicitBlock = evaluateProviderQuotaGate(node, requestedType, ctx.mesh.policy?.quotaRouting ?? null);
    if (!explicitBlock) return { quotaWarning: null };
    return {
        quotaWarning: {
            quotaWarning: `Provider '${requestedType}' on node '${nodeId}' is quota-gated (${explicitBlock.reason}; ${explicitBlock.window} window at ${explicitBlock.remainingPercent}% remaining, threshold ${explicitBlock.thresholdPercent}%). Launching anyway because the type was requested explicitly — the session may fail immediately if the provider rejects on quota.`,
            quotaBlock: {
                providerType: requestedType,
                reason: explicitBlock.reason,
                window: explicitBlock.window,
                remainingPercent: explicitBlock.remainingPercent,
                thresholdPercent: explicitBlock.thresholdPercent,
            },
        },
    };
}

/**
 * No explicit type: probe the node's providerPriority and pick the first detected
 * provider the quota gate clears.
 *
 * OFFLINE-NODE-BLOCKING: probe each candidate provider until one is detected. Two
 * guards keep an OFFLINE target node from serializing a ~90s × providers stall
 * (~270s for a 3-provider priority list):
 *   (a) `detect_provider` is read-only, so stamp it with the status-origin marker
 *       ({ statusProbe: true }) — the daemon-cloud relay then grants the SHORT
 *       connect-wait budget so a probe to an unconnected peer gives up in ~2s
 *       instead of the 90s connect deadline.
 *   (b) short-circuit on the FIRST transport-level failure. A per-provider
 *       "not detected" comes back as a RESOLVED { detected: false } payload (try
 *       the next provider); a THROW means the node itself is unreachable (peer not
 *       connected / offline / relay timeout) — every remaining provider would fail
 *       identically, so break immediately and fail fast with a node-unreachable error.
 *
 * QUOTA GATE (manual-launch path). The auto-launch/queue-drain path
 * (daemon-core resolveUsableProvider) has always run the gate; this path used to
 * consult detect_provider (PATH/install probe) alone and never read nodeFacts, so
 * a provider whose account was measurably out of quota was launched anyway and
 * died immediately (kimi at 1% weekly → 403). Structured exactly like the
 * auto-launch loop: enumerate EVERY detected candidate first, then let the gate
 * split and rank them, so a gated first choice falls THROUGH to the node's next
 * provider instead of failing the launch.
 *
 * FAIL-OPEN is inherited from evaluateProviderQuotaGate unchanged: a missing
 * snapshot, a stale one, quota tracking switched off, 'expired-token' and every
 * other transient failure kind are NEVER blocked — they merely sort into the
 * unknown group and stay launchable. Only a FRESH measured block diverts. That is
 * what keeps a single-provider node off the self-healing deadlock: a CLI owning
 * its own token refresh must still launch when its token has expired, or the
 * token can never be refreshed. See mesh-quota-routing.ts's module header.
 */
async function detectLaunchProviderType(ctx: MeshContext, node: LocalMeshNodeEntry, nodeId: string): Promise<{ providerType: string } | string> {
    const providerPriority = readProviderPriority(node.policy);
    if (!providerPriority.length) {
        return JSON.stringify({ success: false, error: missingProviderPriorityMessage(nodeId) });
    }
    const failed: string[] = [];
    const detectedCandidates: string[] = [];
    let unreachableError: string | null = null;
    for (const providerType of providerPriority) {
        let detectedPayload: any;
        try {
            const detectedResult = await commandForNode(ctx, node, 'detect_provider', { providerType }, { statusProbe: true });
            detectedPayload = unwrapCommandPayload(detectedResult);
        } catch (e: any) {
            // Transport/connection failure: the node is unreachable, not the provider
            // missing. Stop probing the rest of the priority list.
            unreachableError = e?.message || String(e);
            break;
        }
        if (detectedPayload?.success && detectedPayload?.detected) {
            if (!detectedCandidates.includes(providerType)) detectedCandidates.push(providerType);
            continue;
        }
        failed.push(`${providerType}: ${detectedPayload?.error || 'not detected'}`);
    }
    if (detectedCandidates.length) {
        const ranked = rankProvidersByQuotaGate(node, detectedCandidates, ctx.mesh.policy?.quotaRouting ?? null);
        if (ranked.clear.length) return { providerType: ranked.clear[0] };
        // Every detected provider is measurably out of quota. This is a WAIT,
        // not a configuration error: the windows reset on their own, so the
        // response says so rather than presenting the node as broken. Reported
        // distinctly from "not detected" so a coordinator can tell "no quota
        // right now" from "nothing installed".
        const detail = ranked.gated.map(g => `${g.providerType}: ${g.block.reason}`).join('; ');
        return JSON.stringify({
            success: false,
            code: 'mesh_all_providers_quota_gated',
            error: `Every detected provider on node '${nodeId}' is quota-gated (${detail}). This is a WAIT, not a misconfiguration — the quota windows reset on their own.`,
            nodeId,
            gated: ranked.gated.map(g => ({
                providerType: g.providerType,
                reason: g.block.reason,
                window: g.block.window,
                remainingPercent: g.block.remainingPercent,
                thresholdPercent: g.block.thresholdPercent,
            })),
            nextAction: `Enqueue the work (mesh_enqueue_task) so the drain claims it when a window resets, or launch on a node whose providers still have quota. Retrying mesh_launch_session immediately will hit the same gate.`,
        }, null, 2);
    }
    if (unreachableError) {
        return JSON.stringify({ success: false, error: `Node '${nodeId}' is unreachable — cannot detect a provider (${unreachableError}). The node's daemon may be offline; retry once it reconnects.` });
    }
    return JSON.stringify({ success: false, error: `No usable provider detected for node '${nodeId}' from providerPriority: ${failed.join('; ')}` });
}

/**
 * Worker sessions are coordinator-dispatched; a human shouldn't have to approve
 * each one. Resolve the auto-approve policy (node override → mesh policy →
 * default true) for the launch settings envelope, where it wins over the global
 * per-provider-type autoApprove config via the settingsOverride merge. The
 * ENABLE decision stays 100% machine-local (no repoConfig influence).
 *
 * MODE alignment with the auto-launch path: the MCP process has NO provider
 * loader, so it cannot validate a repo-requested mode ID against the live
 * provider spec. The requested mode ID is stamped as `autoApproveMode` with
 * `delegatedWorkerDangerousModeAllow`; the DAEMON-side adapter
 * (cli-provider-instance.shouldAutoApprove → resolveProviderAutoApproveMode)
 * validates it against the real spec, fails closed on an unknown ID and
 * downgrades a dangerous mode when the machine has not opted in. The repo config
 * is consulted only when the ENABLE gate resolved to on.
 */
function resolveLaunchAutoApprove(ctx: MeshContext, node: LocalMeshNodeEntry, providerType: string) {
    const autoApprove = resolveDelegatedWorkerAutoApprove(ctx.mesh.policy, node.policy);
    const dangerousModeAllow = resolveDelegatedWorkerDangerousModeAllow(ctx.mesh.policy, node.policy);
    let autoApproveMode: string | undefined;
    if (autoApprove !== false) {
        try {
            const ws = typeof node.workspace === 'string' && node.workspace.trim() ? node.workspace.trim() : '';
            if (ws) {
                const repo = loadRepoMeshJsonConfig(ws);
                const repoMode = repo.sourceType === 'repo_file'
                    ? repo.config?.providerDefaults?.autoApproveModes?.[providerType]
                    : undefined;
                if (typeof repoMode === 'string' && repoMode.trim()) autoApproveMode = repoMode.trim();
            }
        } catch { /* graceful: no repo config → daemon uses provider default */ }
    }
    return { autoApprove, autoApproveMode, dangerousModeAllow };
}

/**
 * MESH-LAUNCH-DUP-GUARD: an enqueue auto-launch (queue task → daemon spawns a
 * worker) races a manual mesh_launch_session for the same node/worktree. Without
 * this guard the manual call unconditionally issues a second launch_cli, leaving
 * an empty duplicate worker session alongside the one doing the work. If a
 * non-terminal mesh-owned worker session for THIS mesh+node already exists (idle
 * OR still booting/generating), it is returned idempotently instead.
 *
 * PROVIDER-MISMATCH-REUSE: only a live session whose provider matches the
 * resolved request is reused — otherwise mesh_launch_session(type:"claude-cli")
 * against a node with an idle antigravity worker handed back the antigravity
 * session. A definite mismatch (both sides known and unequal) falls through to a
 * fresh launch.
 *
 * A failed status read fails open (launch rather than block): a duplicate is
 * recoverable (mesh_cleanup_sessions); a blocked launch on a transient error is
 * worse for the coordinator flow.
 */
async function findReusableWorkerSession(ctx: MeshContext, node: LocalMeshNodeEntry, nodeId: string, providerType: string): Promise<string | null> {
    try {
        // The coordinator's answer (readNodeRuntime): its own status for its
        // nodes, the member's pushed runtime for another daemon's.
        const { probe } = await readNodeRuntime(ctx, node);
        const existing = probe.sessions.find(session => {
            if (isTerminalSessionRecord(session)) return false;
            if (!isMeshOwnedDelegateSession(session, ctx.mesh.id, nodeId)) return false;
            if (providerType) {
                const sessionProviderType = resolveSessionProviderType(session);
                if (sessionProviderType && sessionProviderType !== providerType) return false;
            }
            return true;
        });
        const existingSessionId = existing ? readSessionRecordId(existing) : '';
        if (!existingSessionId) return null;
        const existingProviderType = resolveSessionProviderType(existing) || providerType || undefined;
        const existingStatus = typeof existing?.status === 'string' ? existing.status : 'unknown';
        return JSON.stringify({
            success: true,
            duplicate: true,
            launched: false,
            reused: true,
            sessionId: existingSessionId,
            nodeId,
            ...(existingProviderType ? { resolvedProviderType: existingProviderType, providerType: existingProviderType } : {}),
            sessionStatus: existingStatus,
            idle: isIdleSessionRecord(existing),
            reason: 'mesh_launch_session_duplicate_guard',
            warning: `Node '${nodeId}' already has a live mesh-owned worker session ('${existingSessionId}', status '${existingStatus}'). Returning it instead of launching an empty duplicate (likely an enqueue auto-launch already spawned it).`,
            nextAction: `Use session '${existingSessionId}' for mesh_send_task/mesh_read_chat. If you intentionally need a second concurrent session on this node, retry mesh_launch_session with force=true.`,
        }, null, 2);
    } catch {
        return null;
    }
}

/**
 * Cache the launched session's provider metadata and record the launch in the
 * ledger — SKIPPED when the daemon already recorded it (LAUNCH-ACCOUNTING single
 * writer: the daemon appends session_launched in its launch_cli funnel and
 * answers `ledgerLaunchRecorded: true`; appending here too would double-count).
 * The append here covers a daemon whose own best-effort record failed.
 */
async function recordLaunchedSession(ctx: MeshContext, nodeId: string, providerType: string, launchPayload: any): Promise<string | undefined> {
    const runtimeSessionId = typeof launchPayload?.sessionId === 'string'
        ? launchPayload.sessionId
        : typeof launchPayload?.id === 'string'
            ? launchPayload.id
            : typeof launchPayload?.runtimeSessionId === 'string'
                ? launchPayload.runtimeSessionId
                : '';
    const providerSessionId = typeof launchPayload?.providerSessionId === 'string' && launchPayload.providerSessionId.trim()
        ? launchPayload.providerSessionId.trim() as string
        : undefined;
    if (runtimeSessionId) {
        meshSessionProviderMetadata.set(meshSessionCacheKey(nodeId, runtimeSessionId), {
            providerType,
            ...(providerSessionId ? { providerSessionId } : {}),
            expiresAt: Date.now() + SESSION_PROVIDER_METADATA_TTL_MS,
        });
    }
    if (launchPayload?.ledgerLaunchRecorded !== true) {
        try {
            await recordLocal(ctx.transport, { meshId: ctx.mesh.id,
                kind: 'session_launched',
                nodeId,
                sessionId: runtimeSessionId || undefined,
                providerType,
                payload: { providerSessionId, source: 'mesh_launch_session_coordinator_fallback' },
            });
        } catch { /* ledger append is best-effort */ }
    }
    return providerSessionId;
}

export async function meshLaunchSession(
    ctx: MeshContext,
    args: { node_id: string; type?: string; force?: boolean },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);
    const bootstrapBlock = getWorktreeBootstrapLaunchBlock(node, ctx.mesh.policy);
    if (bootstrapBlock) return JSON.stringify(bootstrapBlock, null, 2);

    const requestedType = typeof args.type === 'string' && args.type.trim() ? args.type.trim() : '';
    // Set when an EXPLICITLY requested provider is quota-blocked: the launch still
    // proceeds (operator override) but the response carries the warning.
    let explicitTypeQuotaWarning: Record<string, unknown> | null = null;
    let resolvedProviderType: string;
    if (requestedType) {
        const checked = checkRequestedLaunchType(ctx, node, args.node_id, requestedType);
        if (typeof checked === 'string') return checked;
        explicitTypeQuotaWarning = checked.quotaWarning;
        resolvedProviderType = requestedType;
    } else {
        const detected = await detectLaunchProviderType(ctx, node, args.node_id);
        if (typeof detected === 'string') return detected;
        resolvedProviderType = detected.providerType;
    }

    const coordinatorNode = resolveCoordinatorNode(ctx);
    const coordinatorDaemonId = resolveCoordinatorDaemonId(ctx);
    const spawnedSessionVisibility = readSpawnedSessionVisibility(ctx.mesh.policy);
    const approval = resolveLaunchAutoApprove(ctx, node, resolvedProviderType);
    await ensureMeshNodeRoutes(ctx);
    const isLocalNode = isLocalControlPlaneNode(ctx, node);
    if (node.daemonId && !isLocalNode && !coordinatorDaemonId) {
        return JSON.stringify(buildMissingCoordinatorDaemonIdFailure(ctx, node, resolvedProviderType), null, 2);
    }

    // Placed AFTER provider resolution + the coordinator-id fail-closed check so an
    // unlaunchable node never burns a status relay. force=true bypasses the guard
    // for a deliberate additional session.
    if (args.force !== true) {
        const reused = await findReusableWorkerSession(ctx, node, args.node_id, resolvedProviderType);
        if (reused) return reused;
    }

    let result: any;
    try {
        result = await commandForNode(ctx, node, 'launch_cli', {
            cliType: resolvedProviderType,
            dir: node.workspace,
            settings: {
                // Worker launch envelope (A5): structured metadata so worker sessions
                // know their role and can route completion events back correctly.
                role: 'worker',
                meshNodeFor: ctx.mesh.id,
                meshNodeId: args.node_id,
                // LAUNCH-ACCOUNTING: path discriminator for the daemon-side
                // session_launched funnel (cli-manager launch_cli).
                meshLaunchSource: 'mesh_launch_session',
                spawnedSessionVisibility,
                // Delegated worker auto-approval (see resolveLaunchAutoApprove). Lands in
                // settingsOverride and beats the global per-provider autoApprove; the
                // adapter prefers a stamped mode ID (validated daemon-side) and fails
                // closed on an unknown one.
                autoApprove: approval.autoApprove,
                ...(approval.autoApproveMode ? { autoApproveMode: approval.autoApproveMode } : {}),
                delegatedWorkerDangerousModeAllow: approval.dangerousModeAllow,
                ...(coordinatorDaemonId ? { meshCoordinatorDaemonId: coordinatorDaemonId } : {}),
                // (3) Stamp the originating coordinator SESSION at launch too, so a worker
                // launched via mesh_launch_session routes its completions back to the exact
                // coordinator session (multi-coordinator). Absent → daemon-level fallback.
                ...(ctx.coordinatorSessionId ? { meshCoordinatorSessionId: ctx.coordinatorSessionId } : {}),
                ...(coordinatorNode?.id ? { meshCoordinatorNodeId: coordinatorNode.id } : {}),
                launchedByCoordinator: true,
            }
        });
    } catch (e: any) {
        return JSON.stringify(await recordRecoverableLaunchFailure(ctx, node, resolvedProviderType, e), null, 2);
    }
    const launchPayload = extractLaunchPayload(result);
    if (launchPayload?.success === false || result?.success === false) {
        const launchError = new Error(launchPayload?.error || result?.error || 'launch_cli rejected the session launch');
        return JSON.stringify(await recordRecoverableLaunchFailure(ctx, node, resolvedProviderType, launchError), null, 2);
    }
    const providerSessionId = await recordLaunchedSession(ctx, args.node_id, resolvedProviderType, launchPayload);

    // Tell daemon to trigger queue processing so the new session immediately picks up pending tasks.
    // Surface the trigger result so coordinators can distinguish "session launched"
    // from "queued work actually claimed by that session".
    const queueTrigger = await triggerMeshQueueAndReport(ctx);

    return JSON.stringify({
        ...launchPayload,
        resolvedProviderType,
        ...(providerSessionId ? { providerSessionId } : {}),
        ...(explicitTypeQuotaWarning ?? {}),
        queueTrigger,
        ...buildQueueTriggerGuidance(queueTrigger),
    }, null, 2);
}

export async function meshApprove(
    ctx: MeshContext,
    args: { node_id: string; session_id: string; action: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id); // membership check

    const cached = getSessionMetadata(meshSessionCacheKey(args.node_id, args.session_id));
    const providerSessionId = cached?.providerSessionId;
    const result = await commandForNode(ctx, node, 'resolve_action', {
        sessionId: args.session_id,
        targetSessionId: args.session_id,
        workspace: node.workspace,
        ...(cached?.providerType ? { agentType: cached.providerType, providerType: cached.providerType } : {}),
        ...(providerSessionId ? { providerSessionId } : {}),
        action: args.action === 'reject' ? 'reject' : 'approve',
    });
    return JSON.stringify(result, null, 2);
}

/**
 * mesh_answer_question — answer a delegated session's AskUserQuestion (waiting_choice).
 *
 * The counterpart to mesh_approve (mission f1d25e11): a multi-choice QUESTION is NOT a
 * yes/no approval and cannot be resolved with resolve_action. It is answered by driving the
 * chosen option(s) into the provider TUI via the daemon's existing interactive_prompt_response
 * machinery (high-family handler → setInteractivePromptResponse → buildClaudeInteractiveTuiAnswerSteps).
 *
 * This handler is a thin forwarder: it passes the coordinator's promptId + friendly answer
 * array straight to the owning daemon, which resolves the option labels/indexes against its
 * AUTHORITATIVE active prompt (resolveInteractivePromptResponse). interactive_prompt_response is
 * in MESH_FORWARDABLE_SESSION_COMMANDS so it reaches a REMOTE worker's owning daemon.
 */
export async function meshAnswerQuestion(
    ctx: MeshContext,
    args: { node_id: string; session_id: string; promptId: string; answers: unknown },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id); // membership check
    if (!args.promptId || typeof args.promptId !== 'string') {
        return JSON.stringify({ success: false, error: 'promptId is required (from the agent:waiting_choice event).' }, null, 2);
    }
    if (!Array.isArray(args.answers)) {
        return JSON.stringify({ success: false, error: 'answers must be an array (one entry per question).' }, null, 2);
    }
    const result = await commandForNode(ctx, node, 'interactive_prompt_response', {
        targetSessionId: args.session_id,
        sessionId: args.session_id,
        workspace: node.workspace,
        response: {
            promptId: args.promptId,
            answers: args.answers,
        },
    });
    return JSON.stringify(result, null, 2);
}

/**
 * mesh_list_pending_approvals — read-only mesh-wide approval inbox.
 *
 * mesh_approve resolves a SINGLE (node_id, session_id) action; before this tool there was
 * no way to enumerate which sessions are currently blocked awaiting an approval decision —
 * the coordinator had to page mesh_status and eyeball each node's sessions. This lists every
 * session in `awaiting_approval` across the mesh so a coordinator (or the UI approvals inbox)
 * can see the full pending set and drive a follow-up mesh_approve for each.
 *
 * No new store or DB: it reuses the exact derivation mesh_status/mesh_view_queue already run
 * (buildMeshActiveWork over the live-session-decorated nodes + queue + ledger + direct
 * dispatches), then filters to `status === 'awaiting_approval'` via collectPendingApprovals.
 * Read-only — probes node status but mutates no approval/session state.
 */
export async function meshListPendingApprovals(
    ctx: MeshContext,
    _args: Record<string, unknown> = {},
): Promise<string> {
    await recordMeshCoordinatorToolCall(ctx, 'mesh_list_pending_approvals');
    await refreshMeshFromDaemon(ctx);

    // Node/session decoration is the coordinator daemon's answer (its own status
    // + members' pushed runtime) — no member is read. The direct-dispatch transcript reconcile is a WRITE-side nudge the response
    // does not need (mesh-status-background.ts) — kicked in the background,
    // same as mesh_status/mesh_view_queue, instead of blocking this read.
    const probeOpts = _args?.refresh === true ? { refresh: true } : undefined;
    const liveNodes = await collectMeshNodesWithRuntime(ctx, probeOpts);
    // C-W9a: active work computed in the daemon.
    const activeWorkView = await readActiveWorkFromDaemon(ctx, { nodes: liveNodes, recordTail: 200, includeInputs: true });
    scheduleBackgroundDirectReconcile(ctx, liveNodes, activeWorkView.directDispatches, activeWorkView.records);

    const activeWorkEvidence = activeWorkView.activeWork!;

    const approvals = collectPendingApprovals(activeWorkEvidence.activeWork);

    return JSON.stringify({
        count: approvals.length,
        approvals,
        ...(approvals.length === 0
            ? { note: 'No sessions are currently awaiting an approval decision.' }
            : { nextStep: 'Resolve each with mesh_approve(node_id, session_id, action: "approve" | "reject").' }),
    }, null, 2);
}

export async function meshCleanupSessions(
    ctx: MeshContext,
    args: { node_id: string; mode: string; session_ids?: string[]; dry_run?: boolean },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    const result = await commandForNode(ctx, node, 'cleanup_mesh_sessions', {
        meshId: ctx.mesh.id,
        nodeId: args.node_id,
        mode: args.mode,
        sessionIds: args.session_ids,
        dryRun: args.dry_run === true,
        inlineMesh: ctx.mesh,
    });
    return JSON.stringify(result, null, 2);
}
