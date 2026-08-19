/**
 * GRAPH-ORCHESTRATION Phase C2 — the coordinator gate contract: claim, fenced
 * release, leases, and the deadline/timeout sweep.
 *
 * Source of truth: docs/design/2026-08-18-graph-orchestration-full.md
 *   :373-423 — Coordinator gate contract. A gate is a persistent graph control
 *              node that INTENTIONALLY STOPS graph progress (refinery /
 *              approval / ci_wait / publish / deploy / custom). The daemon
 *              never executes the action and never auto-passes a gate: the
 *              only way through is a fenced `releaseMeshGraphGate`.
 *   :407-421 — claim returns a monotonically increasing lease generation and an
 *              opaque fencing token; release acquires the queue lock, rejects
 *              stale generations, checks upstream graph states, validates
 *              patches against the permitted patch surface, evaluates
 *              gate-outcome conditions, materializes downstream, clears
 *              gate-owned blocks, inserts outbox events, and commits. Replaying
 *              the same release key + digest is a no-op success; the same key
 *              with a different digest is a conflict.
 *   :425-439 — death/timeout policy. Lease expiry ≠ deadline expiry. A lapsed
 *              lease lets another coordinator claim with a HIGHER generation and
 *              does not alter the graph; the takeover is reported with
 *              `ambiguousExternalOutcome` because the previous owner may have
 *              performed the external side effect. Deadline expiry applies
 *              `on_timeout` ∈ {hold, cancel_downstream, fail_graph} — there is
 *              NO `auto_release`, and ★ elapsed time is NEVER completion
 *              evidence: the sweep can expire a gate, never release one.
 *   :185-190 — every state change and its wake/notification events commit in
 *              ONE SQLite transaction (the runner's outbox); draining happens
 *              after commit.
 *
 * Split of duties with mesh-graph-transition-runner.ts (one-directional
 * imports — the runner never imports this module):
 *   - runner: gate OPEN (declared → awaiting_coordinator) inside the terminal
 *     choke point, the settle-time gate guard, and the gate-owned block clear.
 *   - here:   the coordinator-facing verbs (claim / release / abandon) and the sweep.
 *
 * ★ `abandon` is the design's `-> cancelled` edge (:399), and it is the ONLY
 * non-release terminal a coordinator can write. It is CLOSURE, not passage:
 * downstream is cancelled, never materialized, and no outcome/evidence is
 * produced. Without it a gate whose work was cancelled stays
 * `awaiting_coordinator` forever and `classifyGraphRollup` can never roll the
 * graph — not even to `cancelled`. See `abandonMeshGraphGate` below.
 *
 * NOT HERE (by design): MCP/JSON-RPC tool exposure (phase E), failure-driven
 * rollups beyond the deadline policies (phase C3), and any daemon-executed
 * gate action — action labels are metadata only (design :390-391).
 */

import { randomUUID } from 'crypto';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { LOG } from '../logging/logger.js';
import { canonicalJson, sha256Hex } from './mesh-graph-input-binding.js';
import {
    newMeshGraphOutboxId,
    type MeshGraphGateRow,
    type MeshTaskGraphNodeRow,
} from './mesh-graph-types.js';
import { classifyGraphRollup } from './mesh-graph-derived-failure.js';
import {
    drainMeshGraphOutbox,
    graphMaterializationBlockReason,
    isTerminalEquivalent,
    maybeOpenCoordinatorGate,
    parseCoordinatorGateBlock,
    settleDownstreamNode,
} from './mesh-graph-transition-runner.js';

/** design :384 — the spec's own example lease; used when the gate spec omits `lease_seconds`. */
export const MESH_GATE_DEFAULT_LEASE_SECONDS = 900;

/** design :413 — the named outcomes; an action-specific structured label is also accepted. */
export const MESH_GATE_NAMED_OUTCOMES = ['passed', 'failed', 'rejected'] as const;

/**
 * The pending-task patch surface a release may touch (design :415, :418).
 * Everything else — `message`, routing, permissions, taskMode, model, tags,
 * gate action — is immutable by the security policy (design :294-295, :299).
 */
export const MESH_GATE_RELEASE_PATCH_KEYS = ['run_if', 'on_false', 'inputs_from', 'workspace_ref'] as const;

// ── Gate spec (node base_spec_json) ──────────────────────────────────────────

interface MeshGateSpec {
    lease_seconds?: number;
    deadline_seconds?: number;
}

function readGateSpec(node: MeshTaskGraphNodeRow | null): MeshGateSpec {
    if (!node) return {};
    try {
        const parsed = JSON.parse(node.baseSpecJson);
        return parsed && typeof parsed === 'object' ? parsed as MeshGateSpec : {};
    } catch {
        return {};
    }
}

function isoAfter(nowMs: number, seconds: number): string {
    return new Date(nowMs + seconds * 1000).toISOString();
}

// ── mesh_graph_gate_claim ─────────────────────────────────────────────────────

export interface MeshGraphGateClaimInput {
    meshId: string;
    gateId: string;
    coordinatorSessionId: string;
    /** Overrides the spec's `lease_seconds`; defaults to the spec, then to 900 (design :384). */
    leaseSeconds?: number;
    /**
     * Explicit deadline extension. The only way a reclaimed gate gets a fresh
     * deadline — reclaiming an `expired` (hold) gate without it leaves the old
     * (past) deadline in place, so the next sweep expires it again.
     */
    extendDeadlineSeconds?: number;
    nowMs?: number;
}

export interface MeshGraphGateClaimResult {
    claimed: boolean;
    /** Machine-readable rejection: gate_not_found / gate_not_eligible / gate_not_awaiting / gate_lease_held / gate_terminal:<state>. */
    reason?: string;
    gate?: MeshGraphGateRow;
    leaseGeneration?: number;
    fencingToken?: string;
    leaseExpiresAt?: string;
    deadlineAt?: string;
    /**
     * design :436-439 — true when this claim took over from a previous claimant
     * that may already have performed the external side effect. The new owner
     * MUST reconcile external evidence (via the gate's operation key) before
     * retrying; the system reports the ambiguity and never blindly reruns.
     */
    ambiguousExternalOutcome?: boolean;
    previousLeaseOwnerSessionId?: string;
}

/**
 * `mesh_graph_gate_claim` core (design :407-408). Claimable states:
 * `awaiting_coordinator` (fresh), `claimed` with a LAPSED lease (takeover —
 * lease expiry never alters the graph, it only lets a live coordinator step
 * in with a higher generation), `claimed` by the SAME owner with a live lease
 * (refresh), and `expired` when the deadline policy is `hold` (explicit
 * operator reclaim, design :433-434).
 */
export function claimMeshGraphGate(input: MeshGraphGateClaimInput): MeshGraphGateClaimResult {
    const store = MeshRuntimeStore.getInstance();
    const nowMs = input.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const outboxEvents: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const result = store.transaction((): MeshGraphGateClaimResult => {
        const graphStore = store.graphStore();
        const gate = graphStore.getGate(input.gateId);
        if (!gate || gate.meshId !== input.meshId) return { claimed: false, reason: 'gate_not_found' };
        if (gate.eligibleCoordinatorSessionId && gate.eligibleCoordinatorSessionId !== input.coordinatorSessionId) {
            return { claimed: false, reason: 'gate_not_eligible' };
        }
        if (gate.state === 'released' || gate.state === 'cancelled') {
            return { claimed: false, reason: `gate_terminal:${gate.state}` };
        }
        if (gate.state === 'declared') {
            return { claimed: false, reason: 'gate_not_awaiting' };
        }

        const leaseLive = !!gate.leaseExpiresAt && gate.leaseExpiresAt > nowIso;
        const sameOwner = gate.leaseOwnerSessionId === input.coordinatorSessionId;
        const priorState = gate.state;
        let takeoverFromClaimed = false;

        if (priorState === 'claimed' && leaseLive && !sameOwner) {
            // A live foreign lease: the claimant must wait for it to lapse.
            return { claimed: false, reason: 'gate_lease_held', gate };
        }
        if (priorState === 'expired' && gate.onTimeout !== 'hold') {
            // cancel_downstream / fail_graph already fired — there is nothing to reclaim.
            return { claimed: false, reason: 'gate_terminal:expired', gate };
        }

        const node = graphStore.getNode(gate.graphId, gate.nodeId);
        const spec = readGateSpec(node);
        const leaseSeconds = input.leaseSeconds ?? spec.lease_seconds ?? MESH_GATE_DEFAULT_LEASE_SECONDS;
        const leaseExpiresAt = isoAfter(nowMs, leaseSeconds);

        let generation: number;
        let fencingToken: string;
        if (priorState === 'claimed' && sameOwner && leaseLive) {
            // Same-owner refresh: keep the generation and token, extend the expiry.
            generation = gate.leaseGeneration;
            fencingToken = gate.fencingToken!;
        } else {
            takeoverFromClaimed = priorState === 'claimed';
            generation = gate.leaseGeneration + 1;
            fencingToken = randomUUID();
        }
        const deadlineAt = input.extendDeadlineSeconds && input.extendDeadlineSeconds > 0
            ? isoAfter(nowMs, input.extendDeadlineSeconds)
            : gate.deadlineAt;

        const won = graphStore.patchGate(gate.gateId, {
            state: 'claimed',
            leaseOwnerSessionId: input.coordinatorSessionId,
            leaseGeneration: generation,
            fencingToken,
            leaseExpiresAt,
            ...(deadlineAt !== undefined ? { deadlineAt } : {}),
        }, nowIso, { leaseGeneration: gate.leaseGeneration });
        if (!won) return { claimed: false, reason: 'gate_claim_race' };

        // A reclaimed (hold-expired) gate's node re-enters awaiting/claimed work.
        if (node && node.state === 'expired') {
            graphStore.updateNodeState(gate.graphId, gate.nodeId, 'awaiting_coordinator', nowIso);
        }

        if (takeoverFromClaimed) {
            outboxEvents.push({
                kind: 'graph_gate_lease_expired',
                payload: {
                    graphId: gate.graphId, gateId: gate.gateId, ref: gate.ref,
                    previousOwnerSessionId: gate.leaseOwnerSessionId,
                    previousGeneration: gate.leaseGeneration, newGeneration: generation,
                },
            });
        }
        outboxEvents.push({
            kind: 'graph_gate_claimed',
            payload: {
                graphId: gate.graphId, gateId: gate.gateId, ref: gate.ref,
                action: gate.action, ownerSessionId: input.coordinatorSessionId,
                generation, leaseExpiresAt,
            },
        });
        for (const event of outboxEvents) {
            graphStore.insertOutboxEvent({
                id: newMeshGraphOutboxId(),
                meshId: gate.meshId,
                graphId: gate.graphId,
                kind: event.kind,
                payload: JSON.stringify(event.payload),
                status: 'pending',
                attemptCount: 0,
                createdAt: nowIso,
                updatedAt: nowIso,
            });
        }

        return {
            claimed: true,
            gate: graphStore.getGate(gate.gateId)!,
            leaseGeneration: generation,
            fencingToken,
            leaseExpiresAt,
            deadlineAt,
            ambiguousExternalOutcome: takeoverFromClaimed
                || (priorState === 'expired' && gate.leaseGeneration > 0),
            previousLeaseOwnerSessionId: gate.leaseOwnerSessionId,
        };
    });
    if (result.claimed) {
        try { drainMeshGraphOutbox(input.meshId); } catch { /* drain is best-effort; the committed state stands */ }
    }
    return result;
}

// ── mesh_graph_gate_release ───────────────────────────────────────────────────

/** One permitted pending-task patch (design :415). `node` is a ref or nodeId of a DIRECT downstream node. */
export interface MeshGraphGateReleasePatch {
    node: string;
    baseSpecPatch: Record<string, unknown>;
}

export interface MeshGraphGateReleaseInput {
    meshId: string;
    gateId: string;
    fencingToken: string;
    leaseGeneration: number;
    idempotencyKey: string;
    /** `passed` | `failed` | `rejected` | an action-specific structured label (design :413). */
    outcome: string;
    /** Action-specific structured result — exposed to downstream as `/result/...`. */
    result?: unknown;
    /** Evidence references/digests — exposed to downstream as `/evidence/...`. */
    evidence?: unknown;
    patches?: MeshGraphGateReleasePatch[];
    nowMs?: number;
}

export interface MeshGraphGateReleaseResult {
    released: boolean;
    /** True when the same idempotency key + digest had already committed — a replayed release. */
    duplicate: boolean;
    gate?: MeshGraphGateRow;
    materializedNodeIds: string[];
    /**
     * How many graph nodes point at this gate (its direct downstream edges), i.e. how
     * much this gate was gating. Reported so the caller can tell the two very different
     * meanings of `materializedNodeIds: []` apart: a gate with dependents that
     * materialized none of them (they were skipped or still blocked) versus a gate with
     * NO dependents at all — a TERMINAL gate, which materializes nothing by construction
     * and is a legitimate end of a graph, not an anomaly.
     *
     * `undefined` on a replayed (duplicate) release: that path returns before the edges
     * are read, and a replay's downstream was already advanced by the original release.
     */
    downstreamNodeCount?: number;
    /**
     * True when THIS release completed the graph (every node terminal-equivalent). A
     * graph may legitimately end at a gate, so this distinguishes "the approval was the
     * final act of a plan that did real work" from a gate that simply gated nothing.
     * `undefined` on a replayed release, which performs no rollup.
     */
    graphCompleted?: boolean;
}

/**
 * `mesh_graph_gate_release` core (design :409-421). The whole release — fence
 * validation, upstream check, patch validation/application, downstream
 * materialization, block clearing, outbox events — commits as ONE queue-lock
 * transaction; a validation failure throws and rolls EVERYTHING back, so the
 * gate stays `claimed` and downstream stays blocked.
 */
export function releaseMeshGraphGate(input: MeshGraphGateReleaseInput): MeshGraphGateReleaseResult {
    const store = MeshRuntimeStore.getInstance();
    const nowMs = input.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const result = store.transaction((): MeshGraphGateReleaseResult => {
        const graphStore = store.graphStore();
        const gate = graphStore.getGate(input.gateId);
        if (!gate || gate.meshId !== input.meshId) throw new Error(`gate_not_found: no gate '${input.gateId}'`);

        const releaseDigest = sha256Hex(canonicalJson({
            outcome: input.outcome,
            result: input.result ?? null,
            evidence: input.evidence ?? null,
            patches: input.patches ?? [],
        }));

        // Idempotency (design :420-421): same key + same digest is a no-op
        // success; same key + different digest is a conflict.
        if (gate.releaseIdempotencyKey === input.idempotencyKey) {
            if (gate.releaseEvidenceDigest === releaseDigest) {
                return { released: true, duplicate: true, gate, materializedNodeIds: [] };
            }
            throw new Error(
                `gate_release_conflict: idempotency key '${input.idempotencyKey}' already committed `
                + `with a different release digest (gate '${input.gateId}')`,
            );
        }
        if (gate.state === 'released') {
            throw new Error(`gate_already_released: gate '${input.gateId}' was released under a different idempotency key`);
        }
        if (gate.state !== 'claimed') {
            throw new Error(`gate_not_claimed: gate '${input.gateId}' is '${gate.state}' — only a claimed gate can be released`);
        }
        // Fencing (design :417): a stale generation or wrong token can never release.
        if (input.fencingToken !== gate.fencingToken || input.leaseGeneration !== gate.leaseGeneration) {
            throw new Error(
                `stale_fence: gate '${input.gateId}' is at lease generation ${gate.leaseGeneration}; `
                + `the presented token/generation (${input.leaseGeneration}) is stale`,
            );
        }
        // ★ An EXPIRED lease cannot release (design :812). Elapsed time is never
        // completion evidence: the work must be reclaimed with a fresh generation.
        if (gate.leaseExpiresAt && gate.leaseExpiresAt <= nowIso) {
            throw new Error(
                `gate_lease_expired: gate '${input.gateId}' lease expired at ${gate.leaseExpiresAt} — `
                + `reclaim the gate (higher generation) and reconcile external evidence before releasing`,
            );
        }

        const node = graphStore.getNode(gate.graphId, gate.nodeId);
        if (!node) throw new Error(`graph_node_not_found: gate '${input.gateId}' backs a missing node '${gate.nodeId}'`);
        const nodes = graphStore.listNodes(gate.graphId);
        const edges = graphStore.listEdges(gate.graphId);
        const byId = new Map(nodes.map(n => [n.nodeId, n]));

        // Upstream check (design :417): the gate's own predecessors must still
        // be satisfied — a release cannot resurrect an unsettled gate.
        const incoming = edges.filter(e => e.toNodeId === node.nodeId);
        const upstreamSettled = incoming.every(e => {
            const sourceState = byId.get(e.fromNodeId)?.state;
            return sourceState === 'completed' || sourceState === 'released'
                || (sourceState === 'skipped' && e.omitOnSkip);
        });
        if (!upstreamSettled) {
            throw new Error(`gate_upstream_unsettled: gate '${input.gateId}' has unsatisfied predecessors`);
        }

        // Patch validation + application (design :415, :418): only DIRECT
        // downstream nodes, only still-pending tasks (an assigned task is
        // immutable — task_already_claimed), only the whitelisted spec keys.
        const directDownstream = new Set(edges.filter(e => e.fromNodeId === node.nodeId).map(e => e.toNodeId));
        for (const patch of input.patches ?? []) {
            const target = nodes.find(n => n.nodeId === patch.node || n.ref === patch.node);
            if (!target || !directDownstream.has(target.nodeId)) {
                throw new Error(`gate_patch_not_downstream: '${patch.node}' is not a direct downstream node of gate '${input.gateId}'`);
            }
            for (const key of Object.keys(patch.baseSpecPatch)) {
                if (!(MESH_GATE_RELEASE_PATCH_KEYS as readonly string[]).includes(key)) {
                    throw new Error(`gate_patch_forbidden: key '${key}' is outside the permitted release patch surface (design :294-299)`);
                }
            }
            if (target.queueTaskId) {
                const entry = store.findQueueEntryById(target.meshId, target.queueTaskId);
                if (entry && entry.status !== 'pending') {
                    throw new Error(
                        `task_already_claimed: gate release cannot patch node '${target.nodeId}' — queue task `
                        + `'${target.queueTaskId}' is '${entry.status}' and immutable (design :334)`,
                    );
                }
            }
            const rawSpec = (() => { try { return JSON.parse(target.baseSpecJson); } catch { return {}; } })();
            graphStore.updateNodeBaseSpec(
                target.graphId,
                target.nodeId,
                JSON.stringify({ ...(rawSpec && typeof rawSpec === 'object' ? rawSpec : {}), ...patch.baseSpecPatch }),
                nowIso,
            );
            const inMap = byId.get(target.nodeId);
            if (inMap) inMap.materializationVersion += 1;
        }

        // Commit the release itself (CAS on the generation we fenced against).
        const won = graphStore.patchGate(gate.gateId, {
            state: 'released',
            releaseOutcome: input.outcome,
            releaseEvidenceJson: canonicalJson({ result: input.result ?? null, evidence: input.evidence ?? null }),
            releaseEvidenceDigest: releaseDigest,
            releaseIdempotencyKey: input.idempotencyKey,
        }, nowIso, { leaseGeneration: gate.leaseGeneration });
        if (!won) throw new Error(`stale_fence: gate '${input.gateId}' moved under the release (generation race)`);
        graphStore.updateNodeState(gate.graphId, node.nodeId, 'released', nowIso);
        const mapped = byId.get(node.nodeId);
        if (mapped) mapped.state = 'released';

        // Downstream advancement: materialize / skip exactly what the release
        // unblocks, clearing this gate's holds; wake at most once.
        const materializedNodeIds = advanceReleasedGateDownstream(store, gate, node, nowIso);

        // Rollup: a released gate is terminal-equivalent (design :423) — a graph
        // may legitimately END at a gate. Restore `active` when other gates wait.
        const freshNodes = graphStore.listNodes(gate.graphId);
        const graph = graphStore.getGraph(gate.graphId);
        let graphCompleted = false;
        if (graph && freshNodes.every(isTerminalEquivalent)) {
            graphStore.updateGraphStatus(gate.graphId, 'completed', nowIso, true);
            insertGateOutbox(graphStore, gate.meshId, gate.graphId, 'graph_completed', { graphId: gate.graphId }, nowIso);
            graphCompleted = true;
        } else if (graph?.status === 'waiting_gate') {
            const stillWaiting = graphStore.listGatesByGraph(gate.graphId)
                .some(g => g.gateId !== gate.gateId && (g.state === 'awaiting_coordinator' || g.state === 'claimed'));
            if (!stillWaiting) graphStore.updateGraphStatus(gate.graphId, 'active', nowIso);
        }

        insertGateOutbox(graphStore, gate.meshId, gate.graphId, 'graph_gate_released', {
            graphId: gate.graphId, gateId: gate.gateId, nodeId: node.nodeId, ref: gate.ref,
            action: gate.action, outcome: input.outcome, releaseDigest,
            generation: gate.leaseGeneration, materializedNodeIds,
        }, nowIso);
        if (materializedNodeIds.length > 0) {
            insertGateOutbox(graphStore, gate.meshId, gate.graphId, 'queue_wake', {
                meshId: gate.meshId, reason: 'graph_gate_released', graphId: gate.graphId, gateId: gate.gateId,
            }, nowIso);
        }
        return {
            released: true,
            duplicate: false,
            gate: graphStore.getGate(gate.gateId)!,
            materializedNodeIds,
            // Read from the edge set this release already walked — a gate with an empty
            // directDownstream is terminal, and terminal gates materialize nothing by design.
            downstreamNodeCount: directDownstream.size,
            graphCompleted,
        };
    });
    try { drainMeshGraphOutbox(input.meshId); } catch { /* drain is best-effort; the committed state stands */ }
    return result;
}

/**
 * The release-time downstream walk (design :419): clear THIS gate's holds,
 * settle each newly-unblocked worker through the runner's one settle path
 * (which re-checks run_if over the gate outcome, inputs_from, other gates, and
 * the materialization CAS), propagate skips to a fixed point, and open any
 * follow-on gate whose predecessors are now satisfied.
 */
function advanceReleasedGateDownstream(
    store: MeshRuntimeStore,
    gate: MeshGraphGateRow,
    gateNode: MeshTaskGraphNodeRow,
    nowIso: string,
): string[] {
    const graphStore = store.graphStore();
    const nodes = graphStore.listNodes(gate.graphId);
    const edges = graphStore.listEdges(gate.graphId);
    const byId = new Map(nodes.map(n => [n.nodeId, n]));
    const mappedGate = byId.get(gateNode.nodeId);
    if (mappedGate) mappedGate.state = 'released';

    const materialized: string[] = [];
    let frontier = new Set([gateNode.nodeId]);
    for (let pass = 0; pass < nodes.length + 1 && frontier.size > 0; pass += 1) {
        const nextFrontier = new Set<string>();
        const downstreamIds = new Set(edges.filter(e => frontier.has(e.fromNodeId)).map(e => e.toNodeId));
        for (const targetId of downstreamIds) {
            const target = byId.get(targetId);
            if (!target) continue;
            if (target.kind === 'coordinator_gate') {
                maybeOpenCoordinatorGate(store, target, edges, byId, nowIso);
                continue;
            }
            if (target.kind !== 'worker_task' || !target.queueTaskId) continue;
            if (target.state !== 'declared' && target.state !== 'blocked') continue;
            clearReleasedGateHold(store, target, gate.gateId);
            const outcome = settleDownstreamNode(store, target, edges, byId, nowIso);
            if (outcome.kind === 'materialized') {
                materialized.push(target.nodeId);
                insertGateOutbox(graphStore, target.meshId, target.graphId, 'graph_node_materialized', {
                    graphId: target.graphId, nodeId: target.nodeId, ref: target.ref,
                    taskId: target.queueTaskId, gateId: gate.gateId,
                    materializationVersion: target.materializationVersion,
                    digest: outcome.digest, receipts: outcome.receipts,
                }, nowIso);
            } else if (outcome.kind === 'skipped') {
                nextFrontier.add(target.nodeId);
                insertGateOutbox(graphStore, target.meshId, target.graphId, 'graph_node_skipped', {
                    graphId: target.graphId, nodeId: target.nodeId, ref: target.ref,
                    taskId: target.queueTaskId, gateId: gate.gateId, reason: outcome.reason,
                }, nowIso);
            } else if (outcome.kind === 'error') {
                insertGateOutbox(graphStore, target.meshId, target.graphId, 'graph_node_materialization_failed', {
                    graphId: target.graphId, nodeId: target.nodeId, ref: target.ref,
                    taskId: target.queueTaskId, gateId: gate.gateId, blockedReason: outcome.blockedReason,
                }, nowIso);
            } else {
                // deferred — the gate is released but other inputs are not
                // settled. Never leave the row claimable: if clearing this
                // gate's hold left it unblocked, re-arm the generic graph hold.
                const entry = store.findQueueEntryById(target.meshId, target.queueTaskId);
                if (entry && entry.status === 'pending' && !entry.blockedReason) {
                    entry.blockedReason = graphMaterializationBlockReason(target.nodeId, target.materializationVersion);
                    store.updateQueueEntry(entry);
                }
            }
        }
        frontier = nextFrontier;
    }
    return materialized;
}

/** Clear only THIS gate's hold from a downstream row; a different gate's hold (or a foreign block) stays. */
function clearReleasedGateHold(store: MeshRuntimeStore, target: MeshTaskGraphNodeRow, gateId: string): void {
    if (!target.queueTaskId) return;
    const entry = store.findQueueEntryById(target.meshId, target.queueTaskId);
    if (!entry || entry.status !== 'pending') return;
    const hold = parseCoordinatorGateBlock(entry.blockedReason);
    if (hold && hold.gateId === gateId) {
        delete entry.blockedReason;
        store.updateQueueEntry(entry);
    }
}

// ── mesh_graph_gate_abandon (design :399 — the `-> cancelled` edge) ───────────

export interface MeshGraphGateAbandonInput {
    meshId: string;
    gateId: string;
    /** Free-form operator reason, recorded on the gate node and the cancelled downstream rows. */
    reason: string;
    /**
     * Who is abandoning. Recorded for provenance. Deliberately NOT matched
     * against `leaseOwnerSessionId`: the whole point of abandon is to close a
     * gate whose owner is gone.
     */
    coordinatorSessionId?: string;
    /**
     * A LIVE foreign lease is refused by default — the holder may be mid-action
     * on an external side effect, and abandoning under them would strand it.
     * Set true to abandon anyway (an operator who knows the holder is dead).
     */
    force?: boolean;
    nowMs?: number;
}

export interface MeshGraphGateAbandonResult {
    abandoned: boolean;
    /** gate_not_found / gate_already_abandoned / gate_terminal:<state> / gate_lease_held / gate_abandon_race. */
    reason?: string;
    gate?: MeshGraphGateRow;
    /** Downstream worker nodes cancelled by this abandon. */
    cancelledNodeIds: string[];
    /** Their still-pending queue placeholders, now `cancelled`. */
    cancelledTaskIds: string[];
    /** The graph status this abandon rolled the graph to, when it rolled at all. */
    graphStatus?: string;
}

/** The block/cancel reason an abandoned gate stamps on the work it closes. */
export function coordinatorGateAbandonedReason(gateId: string): string {
    return `coordinator_gate_abandoned:${gateId}`;
}

/**
 * ★ Abandon a gate that can never be opened — the ONLY non-release terminal a
 * coordinator can write, and deliberately NOT a pass.
 *
 * WHY THIS EXISTS. Cancelling the tasks behind a gate leaves the gate itself
 * `awaiting_coordinator` forever: `applyGraphCancelCascade` skips gate nodes by
 * design (C3 owns workers, C2 owns gates), the deadline sweep skips gates with
 * no `deadline_at` (and `deadline_seconds` is optional), and
 * `classifyGraphRollup` returns null while ANY gate is unsettled. The graph
 * could therefore reach no terminal state at all — not even `cancelled`. The
 * `cancelled` gate state was in the enum and in the design's own state diagram
 * (:399 `awaiting_coordinator -> cancelled`) from the start; this is its writer.
 *
 * ★ HOW IT DIFFERS FROM RELEASE — the invariant this must never break:
 *   - release is PASSAGE: it materializes downstream, clears gate holds, and
 *     exposes `outcome`/`result`/`evidence` to downstream bindings.
 *   - abandon is CLOSURE: it materializes NOTHING. Downstream held work is
 *     cancelled, never opened. There is no outcome, no evidence, no patch
 *     surface. Nothing downstream of an abandoned gate can ever run.
 * Making abandon materialize downstream would be exactly backwards, and making
 * it settle the gate as `released` would let "give up" masquerade as "approved".
 *
 * ★ IT IS NOT A TIMEOUT PATH. The sweep still cannot pass a gate; abandon is an
 * EXPLICIT operator/coordinator act with a recorded reason. It does not consult
 * the deadline, and elapsed time never triggers it.
 *
 * ★ FENCING IS NOT BYPASSED — it is scoped. Abandon requires no fencing token
 * because it grants no passage, but a LIVE foreign lease still refuses
 * (`gate_lease_held`) unless `force` is set: the holder may be mid-action. The
 * CAS on `leaseGeneration` still guards the write, so a concurrent claim/release
 * that moved the row loses the race (`gate_abandon_race`) instead of being
 * silently overwritten.
 */
export function abandonMeshGraphGate(input: MeshGraphGateAbandonInput): MeshGraphGateAbandonResult {
    const store = MeshRuntimeStore.getInstance();
    const nowMs = input.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const result = store.transaction((): MeshGraphGateAbandonResult => {
        const graphStore = store.graphStore();
        const gate = graphStore.getGate(input.gateId);
        if (!gate || gate.meshId !== input.meshId) {
            return { abandoned: false, reason: 'gate_not_found', cancelledNodeIds: [], cancelledTaskIds: [] };
        }
        if (gate.state === 'cancelled') {
            // Idempotent: abandoning an abandoned gate is a no-op success, so a
            // retried cleanup never has to distinguish "I did it" from "it was done".
            return { abandoned: true, reason: 'gate_already_abandoned', gate, cancelledNodeIds: [], cancelledTaskIds: [] };
        }
        if (gate.state === 'released') {
            // A released gate already let its downstream run. Abandoning it would
            // claim closure over work that is in flight or finished.
            return { abandoned: false, reason: `gate_terminal:${gate.state}`, gate, cancelledNodeIds: [], cancelledTaskIds: [] };
        }
        if (!input.force && gate.state === 'claimed' && gate.leaseExpiresAt && gate.leaseExpiresAt > nowIso) {
            return { abandoned: false, reason: 'gate_lease_held', gate, cancelledNodeIds: [], cancelledTaskIds: [] };
        }

        const abandonReason = `${coordinatorGateAbandonedReason(gate.gateId)}:${input.reason}`;
        const won = graphStore.patchGate(gate.gateId, {
            state: 'cancelled',
            // Drop the lease: an abandoned gate has no owner and no live fence.
            leaseOwnerSessionId: null,
            fencingToken: null,
            leaseExpiresAt: null,
        }, nowIso, { leaseGeneration: gate.leaseGeneration });
        if (!won) {
            return { abandoned: false, reason: 'gate_abandon_race', gate, cancelledNodeIds: [], cancelledTaskIds: [] };
        }

        const node = graphStore.getNode(gate.graphId, gate.nodeId);
        if (node && node.state !== 'cancelled') {
            graphStore.updateNodeState(gate.graphId, gate.nodeId, 'cancelled', nowIso, { failureReason: abandonReason });
        }

        // ★ Downstream is CANCELLED, never materialized. Reuse the same subtree
        // walk `cancel_downstream` uses so abandon and the timeout policy agree
        // on what "everything this gate was gating" means.
        const cancelledNodeIds = node ? cancelGateDownstreamSubtree(store, node, nowIso, abandonReason) : [];
        const cancelledTaskIds: string[] = [];
        for (const nodeId of cancelledNodeIds) {
            const target = graphStore.getNode(gate.graphId, nodeId);
            if (target?.queueTaskId) cancelledTaskIds.push(target.queueTaskId);
        }

        // Rollup: with this gate settled, the graph may now be able to reach a
        // terminal state it could not reach before — that is the whole point.
        const graph = graphStore.getGraph(gate.graphId);
        let graphStatus: string | undefined;
        const rolled = classifyGraphRollup(graphStore.listNodes(gate.graphId));
        if (graph && rolled && graph.status !== rolled) {
            graphStore.updateGraphStatus(gate.graphId, rolled, nowIso, true);
            graphStatus = rolled;
            insertGateOutbox(graphStore, gate.meshId, gate.graphId,
                rolled === 'completed' ? 'graph_completed' : rolled === 'failed' ? 'graph_failed' : 'graph_cancelled',
                { graphId: gate.graphId, status: rolled }, nowIso);
        } else if (graph?.status === 'waiting_gate') {
            // Other gates still hold the graph; drop back to `active` only when
            // this was the last one waiting.
            const stillWaiting = graphStore.listGatesByGraph(gate.graphId)
                .some(g => g.gateId !== gate.gateId && (g.state === 'awaiting_coordinator' || g.state === 'claimed'));
            if (!stillWaiting) {
                graphStore.updateGraphStatus(gate.graphId, 'active', nowIso);
                graphStatus = 'active';
            }
        }

        insertGateOutbox(graphStore, gate.meshId, gate.graphId, 'graph_gate_abandoned', {
            graphId: gate.graphId, gateId: gate.gateId, nodeId: gate.nodeId, ref: gate.ref,
            action: gate.action, priorState: gate.state, reason: input.reason,
            ...(input.coordinatorSessionId ? { coordinatorSessionId: input.coordinatorSessionId } : {}),
            ...(input.force ? { force: true } : {}),
            ...(cancelledNodeIds.length > 0 ? { cancelledNodeIds } : {}),
        }, nowIso);
        // ★ Deliberately NO `queue_wake`: abandon opens nothing, so there is
        // nothing for the scheduler to pick up.

        return {
            abandoned: true,
            gate: graphStore.getGate(gate.gateId)!,
            cancelledNodeIds,
            cancelledTaskIds,
            ...(graphStatus ? { graphStatus } : {}),
        };
    });
    if (result.abandoned) {
        try { drainMeshGraphOutbox(input.meshId); } catch { /* drain is best-effort; the committed state stands */ }
    }
    return result;
}

// ── Deadline / timeout sweep (design :425-439) ────────────────────────────────

export interface MeshGraphGateSweepResult {
    /** Gates the deadline policy moved to `expired` in this sweep. */
    expiredGateIds: string[];
    /** Claimed gates whose LEASE lapsed — reported for observability only; the graph is never altered by a lease lapse. */
    expiredLeaseGateIds: string[];
}

/**
 * Apply the deadline policy to every gate of one mesh whose `deadline_at`
 * passed. ★ There is NO auto-release path (design :431-432): the sweep can
 * only EXPIRE a gate — `hold` retains downstream blocks for an explicit
 * reclaim, `cancel_downstream` cancels the downstream subtree's pending work,
 * `fail_graph` fails the whole graph. A lapsed lease is merely reported; only
 * a new claim (higher fencing generation) acts on it.
 */
export function sweepMeshGraphGateTimeouts(meshId: string, nowMs?: number): MeshGraphGateSweepResult {
    const store = MeshRuntimeStore.getInstance();
    const now = nowMs ?? Date.now();
    const nowIso = new Date(now).toISOString();
    const result = store.transaction((): MeshGraphGateSweepResult => {
        const graphStore = store.graphStore();
        const candidates = graphStore.listGatesByMesh(meshId, ['awaiting_coordinator', 'claimed']);
        const expiredLeaseGateIds = candidates
            .filter(g => g.state === 'claimed' && g.leaseExpiresAt && g.leaseExpiresAt <= nowIso)
            .map(g => g.gateId);
        const expiredGateIds: string[] = [];
        for (const gate of candidates) {
            if (!gate.deadlineAt || gate.deadlineAt > nowIso) continue;
            const node = graphStore.getNode(gate.graphId, gate.nodeId);
            const won = graphStore.patchGate(gate.gateId, { state: 'expired' }, nowIso, { leaseGeneration: gate.leaseGeneration });
            if (!won) continue;
            if (node && node.state !== 'expired') {
                graphStore.updateNodeState(gate.graphId, gate.nodeId, 'expired', nowIso);
            }
            let cancelledNodeIds: string[] = [];
            if (gate.onTimeout === 'cancel_downstream' && node) {
                cancelledNodeIds = cancelGateDownstreamSubtree(store, node, nowIso);
            } else if (gate.onTimeout === 'fail_graph') {
                graphStore.updateGraphStatus(gate.graphId, 'failed', nowIso, true);
            }
            // `hold` deliberately does nothing else: downstream blocks are
            // RETAINED and an operator/later coordinator may reclaim (design :433-434).
            insertGateOutbox(graphStore, gate.meshId, gate.graphId, 'graph_gate_expired', {
                graphId: gate.graphId, gateId: gate.gateId, nodeId: gate.nodeId, ref: gate.ref,
                action: gate.action, policy: gate.onTimeout, deadlineAt: gate.deadlineAt,
                urgent: true, ...(cancelledNodeIds.length > 0 ? { cancelledNodeIds } : {}),
            }, nowIso);
            expiredGateIds.push(gate.gateId);
        }
        return { expiredGateIds, expiredLeaseGateIds };
    });
    if (result.expiredGateIds.length > 0) {
        try { drainMeshGraphOutbox(meshId); } catch { /* drain is best-effort; the committed state stands */ }
    }
    if (result.expiredGateIds.length > 0 || result.expiredLeaseGateIds.length > 0) {
        LOG.info('MeshGraph', `Gate sweep for mesh ${meshId}: expired=[${result.expiredGateIds.join(',')}] lease-lapsed=[${result.expiredLeaseGateIds.join(',')}]`);
    }
    return result;
}

/** Nodes the release/expire paths must never cancel — terminal or terminal-equivalent. */
function isCancelExempt(state: MeshTaskGraphNodeRow['state']): boolean {
    return state === 'completed' || state === 'released' || state === 'skipped'
        || state === 'cancelled' || state === 'failed' || state === 'expired';
}

/**
 * `cancel_downstream` (and abandon): mark every non-terminal descendant node
 * `cancelled` and cancel its STILL-PENDING queue placeholder with a gate-owned
 * reason. An already-assigned/running row is not force-flipped here — the
 * derived-failure cascade for in-flight work is phase C3's contract.
 *
 * `reason` distinguishes the two callers: a deadline expiry stamps
 * `coordinator_gate_timeout:<nodeId>`, an explicit abandon stamps
 * `coordinator_gate_abandoned:<gateId>:<operator reason>`. They must stay
 * distinguishable — one is elapsed time, the other is a decision.
 */
function cancelGateDownstreamSubtree(
    store: MeshRuntimeStore,
    gateNode: MeshTaskGraphNodeRow,
    nowIso: string,
    reason = `coordinator_gate_timeout:${gateNode.nodeId}`,
): string[] {
    const graphStore = store.graphStore();
    const nodes = graphStore.listNodes(gateNode.graphId);
    const edges = graphStore.listEdges(gateNode.graphId);
    const byId = new Map(nodes.map(n => [n.nodeId, n]));
    const cancelled: string[] = [];
    const visited = new Set([gateNode.nodeId]);
    let frontier = [gateNode.nodeId];
    while (frontier.length > 0) {
        const next: string[] = [];
        for (const id of frontier) {
            for (const edge of edges.filter(e => e.fromNodeId === id)) {
                if (visited.has(edge.toNodeId)) continue;
                visited.add(edge.toNodeId);
                const target = byId.get(edge.toNodeId);
                if (!target || isCancelExempt(target.state)) continue;
                graphStore.updateNodeState(target.graphId, target.nodeId, 'cancelled', nowIso, {
                    failureReason: reason,
                });
                if (target.queueTaskId) {
                    const entry = store.findQueueEntryById(target.meshId, target.queueTaskId);
                    if (entry && entry.status === 'pending') {
                        entry.status = 'cancelled';
                        entry.blockedReason = reason;
                        store.updateQueueEntry(entry);
                    }
                }
                cancelled.push(target.nodeId);
                next.push(target.nodeId);
            }
        }
        frontier = next;
    }
    return cancelled;
}

/** One outbox row inside the caller's transaction (design :185-190). */
function insertGateOutbox(
    graphStore: ReturnType<MeshRuntimeStore['graphStore']>,
    meshId: string,
    graphId: string,
    kind: string,
    payload: Record<string, unknown>,
    nowIso: string,
): void {
    graphStore.insertOutboxEvent({
        id: newMeshGraphOutboxId(),
        meshId,
        graphId,
        kind,
        payload: JSON.stringify(payload),
        status: 'pending',
        attemptCount: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
    });
}

/** Re-exported for tests/tools: the block a gate places on downstream rows. */
export { coordinatorGateBlockReason } from './mesh-graph-transition-runner.js';
