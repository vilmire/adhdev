import { getQueue, isTaskReadonly, buildMeshNodeCapabilityTags, nodeSatisfiesRequiredTags } from './mesh-work-queue.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { getActiveDirectDispatches } from './mesh-work-queue.js';
import { resolveProviderMaxParallel, resolveSlotMaxParallel, resolveNodeSchedulingPriority, normalizeMeshSchedulingStrategy } from '../repo-mesh-types.js';
import type { RepoMeshSchedulingStrategy, RepoMeshQuotaRoutingPolicy } from '../repo-mesh-types.js';
import { normalizeMeshNodeId, meshNodeIdMatches, daemonIdsEquivalent, sessionIdsEquivalent, normalizeNodeCapabilitySlots, isMeshTaskDifficulty, type MeshNodeIdentified, type NodeCapabilitySlot, type MeshTaskDifficulty } from '@adhdev/mesh-shared';
import { resolveNodeCapabilitySlots } from './mesh-node-slots.js';
import { quotaSpreadBonusByProvider } from './mesh-quota-routing.js';
import { hasUnterminalDirectDispatchLedgerEntry } from './mesh-events-stale.js';
import { decideSlotForModel, isModelAllowedBySlot } from './slot-model-enforcement.js';
import { loadRepoMeshJsonConfig } from '../config/mesh-json-config.js';


export function activeAssignedCount(meshId: string): number {
    return getQueue(meshId, { status: ['assigned'] as any }).length;
}

/** Active assignments that hold the one-active-per-node / global-parallel invariant
 *  (everything except read-only diagnoses, which run unbounded by the write cap). */
export function activeWriteAssignedCount(meshId: string): number {
    return getQueue(meshId, { status: ['assigned'] as any })
        .filter(task => !isTaskReadonly(task)).length;
}

/** Active read-only assignments, for the read-only safety cap. */
export function activeReadonlyAssignedCount(meshId: string): number {
    return getQueue(meshId, { status: ['assigned'] as any })
        .filter(isTaskReadonly).length;
}

export function nodeHasActiveAssignment(meshId: string, nodeId: string): boolean {
    // Canonical-form match, NOT a raw `===`: an assigned row stamped in one daemon-id
    // form (e.g. `daemon_mach_X`) must still register as this node's active work when
    // the candidate nodeId arrives bare (`mach_X`). A raw mismatch makes the node look
    // free, letting a second write task auto-launch onto an already-busy node and
    // breaking the one-write-per-node (worktree isolation) invariant.
    return getQueue(meshId, { status: ['assigned'] as any }).some(task => daemonIdsEquivalent(task.assignedNodeId, nodeId));
}

/** Active (status='assigned') task count for a node — the load metric for the
 *  fitness strategy's no-task (spread) ranking. Lower = preferred. */
export function nodeActiveLoad(meshId: string, nodeId: string): number {
    return MeshRuntimeStore.getInstance().nodeActiveAssignmentCount(meshId, nodeId);
}

/** True when any node in the mesh has an EXPLICIT capability-slot list configured
 *  (policy.slots). Legacy-derived slots don't count — only an operator (or the
 *  orchestrator, with approval) authoring slots signals intent to route by fitness. */
export function meshHasExplicitSlots(mesh: any): boolean {
    const nodes = Array.isArray(mesh?.nodes) ? mesh.nodes : [];
    return nodes.some((n: any) => normalizeNodeCapabilitySlots(n?.policy?.slots).length > 0);
}

/**
 * The mesh-wide scheduling strategy, read from the MACHINE-LOCAL stored mesh
 * policy. Resolution order:
 *   1. an EXPLICITLY stored schedulingStrategy (operator picked a mode) wins, else
 *   2. 'fitness' AUTO when the mesh has any node with explicit capability slots —
 *      configuring slots is itself the signal to route tasks by task→slot fitness
 *      (difficulty/capability), no separate strategy toggle required, else
 *   3. 'first_eligible' (strict no-change default for slot-less meshes).
 *
 * Persistence economy drops schedulingStrategy from policy when it equals the
 * first_eligible default (repo-mesh-types normalizeMeshPolicy), so an ABSENT value
 * means "unset" — safe to auto-upgrade — while a PRESENT value means the operator
 * chose it and we never override. Policy is machine-local only; this only governs
 * the final tie-break — eligibility, capacity, and priority gates are unchanged.
 */
export function resolveSchedulingStrategy(mesh: any): RepoMeshSchedulingStrategy {
    const raw = mesh?.policy?.schedulingStrategy;
    if (typeof raw === 'string' && raw.trim()) {
        return normalizeMeshSchedulingStrategy(raw);
    }
    // Unset → auto-fitness when slots exist, else the historical default.
    return meshHasExplicitSlots(mesh) ? 'fitness' : normalizeMeshSchedulingStrategy(undefined);
}

/**
 * Order eligible nodes for assignment per the mesh scheduling pipeline:
 *   PRIORITY (schedulingPriority desc) → TIE-BREAK (strategy).
 *
 * The caller has already applied the TAG hard-filter and is responsible for the
 * MAX-ALLOC capacity gate (the per-node launch/claim checks). This function only
 * decides the *preference order* among nodes that are otherwise eligible.
 *
 * The strategy arriving here is already normalized (resolveSchedulingStrategy →
 * normalizeMeshSchedulingStrategy), so only 'first_eligible', 'priority_only',
 * and 'fitness' are reachable — the deprecated 'least_loaded'/'round_robin'
 * aliases have already folded into 'fitness'.
 *
 * - 'first_eligible' (default): returns the input order verbatim and does NOT touch
 *   the round-robin cursor — byte-for-byte the pre-feature behavior.
 * - 'priority_only' (escape-hatch): schedulingPriority desc, then input order
 *   (load ignored).
 * - 'fitness' (the user-facing 'smart' mode): with a task in scope, task→slot
 *   fitness desc, then priority desc, then load asc, then input order. Without a
 *   task (idle-session drain ranks task-independently) fitness is inert and the
 *   ordering degrades to priority desc → load asc → round-robin rotation among
 *   full ties — byte-for-byte the former 'least_loaded' behavior (which had
 *   already absorbed the 'round_robin' rotation as its tie-break).
 *
 * `nodes` carries the original config/array index so the tie-break can fall back to
 * deterministic input order. `bumpCursor` advances the round-robin cursor exactly
 * once per scheduling pass (consulted only by the no-task 'fitness' path).
 */

export interface RankableNode { nodeId: string; node: any; index: number }

/** Test-only: resolve a mesh's effective scheduling strategy through the full
 *  LOCAL-WINS path (`.adhdev/mesh.json` distribution → strategy, else stored policy).
 *  Exposed so the repo-file overlay wiring can be exercised by a direct call. */
export function __resolveSchedulingStrategyForTests(mesh: any): RepoMeshSchedulingStrategy {
    return resolveSchedulingStrategy(mesh);
}

/** Test-only: the pure node-ordering stage (PRIORITY → TIE-BREAK). Exposed so the
 *  scheduling pipeline can be unit-tested without standing up live CLI sessions. */
export function __orderEligibleNodesForTests(
    meshId: string,
    strategy: RepoMeshSchedulingStrategy,
    nodes: RankableNode[],
    opts?: { bumpCursor?: boolean; task?: { difficulty?: string; requiredTags?: string[] }; quotaRouting?: RepoMeshQuotaRoutingPolicy | null },
): RankableNode[] {
    return orderEligibleNodes(meshId, strategy, nodes, opts);
}

/** One idle session eligible to claim a queued task, together with the resolved
 *  mesh node record it belongs to. Local candidates come from live CLI instances,
 *  remote candidates from the registered remote-idle-session store; the two arrive
 *  with their `nodeId` under different serialization forms. */
export type IdleCandidate = { nodeId: string; sessionId: string; providerType: string; origin: 'local' | 'remote'; node: any };

/**
 * Merge local + remote idle candidates into the scheduling pool with a single,
 * form-canonical node identity.
 *
 * INVARIANT: every candidate in the returned pool carries its `nodeId` in
 * CANONICAL (normalized) form, and `uniqueNodes` has exactly one entry per
 * physical node. Local and remote candidates arrive with their `nodeId` under
 * mixed forms (config `id`, wire `nodeId`, DB `node_id`). Downstream scheduling
 * keys the pool by raw-string equality (Set dedup, baseIndex, rankIndex,
 * nodeActiveLoad), so two candidates for the SAME physical node under two
 * different forms would otherwise be treated as two distinct nodes — form-drift
 * that splits a node's load and double-ranks it. Canonicalizing here (via the
 * resolved node record, which meshNodeIdMatches already matched form-agnostically)
 * makes every later `=== nodeId` comparison operate on one agreed form. Falls back
 * to the raw candidate id when the node is unresolved (an unresolved candidate
 * cannot be normalized, but also has no sibling to collide with).
 */
export function buildSchedulingPool(
    localCandidates: IdleCandidate[],
    remoteCandidates: IdleCandidate[],
): { pool: IdleCandidate[]; uniqueNodes: RankableNode[] } {
    const pool = [...localCandidates, ...remoteCandidates].map(c => ({
        ...c,
        nodeId: normalizeMeshNodeId(c.node) ?? c.nodeId,
    }));
    // Both sides are canonical now, so raw `===` in the Set dedup and the node
    // re-lookup is form-safe.
    const uniqueNodes: RankableNode[] = [...new Set(pool.map(c => c.nodeId))]
        .map((nodeId, index) => ({
            nodeId,
            node: pool.find(c => meshNodeIdMatches({ id: c.nodeId } as MeshNodeIdentified, nodeId))?.node,
            index,
        }));
    return { pool, uniqueNodes };
}

/** Test-only: the pool-canonicalization + unique-node collapse stage. Exposed so
 *  the mixed-form dedup invariant can be unit-tested without a live daemon. */
export function __buildSchedulingPoolForTests(
    localCandidates: IdleCandidate[],
    remoteCandidates: IdleCandidate[],
): { pool: IdleCandidate[]; uniqueNodes: RankableNode[] } {
    return buildSchedulingPool(localCandidates, remoteCandidates);
}

// ─────────────────────────────────────────────────────────────────────────────
// Node capability slots — task→node/slot fitness (ORCHESTRATION_NODE_SLOTS.md)
//
// A node's capability slots are the single source of truth for routing. When a
// node has explicit `policy.slots` we use them; otherwise we derive slots from the
// legacy providerPriority + the owning mesh's difficultyBrains so existing nodes
// keep working (back-compat). The fitness scorer ranks a node for a
// specific task by how well its best slot matches the task's difficulty and
// required tags — with graceful fallback so a task is never blocked by a missing
// exact match.
// ─────────────────────────────────────────────────────────────────────────────


/** The task shape the fitness scorer reads (a subset of MeshWorkQueueEntry). */
export interface FitnessTask {
    difficulty?: string;
    requiredTags?: string[];
}

/**
 * Score how well one slot fits a task. Higher = better. A slot whose difficulty
 * range contains the task's difficulty scores highest; a general-purpose slot
 * (no declared difficulty) is a valid fallback; a slot whose capability tags cover
 * the task's requiredTags gets a capability bonus. Never negative — the worst a
 * slot does is score 0 (still selectable as a last-resort fallback).
 *
 * `quotaBonus` is the QUOTA SPREAD axis (mesh-quota-routing.ts): a bounded
 * 0..spreadBonusMax headroom preference for the slot's provider, computed by
 * the CALLER from the node's reported facts and passed in as a plain number.
 * The scorer stays pure and synchronous — it never reads node facts itself and
 * can never trigger a quota fetch. The default cap (30) sits below the exact
 * difficulty-match bonus (+100), so quota can rank equally-fit slots but can
 * never overturn a difficulty match. Callers pass 0 (or omit it) when no fresh
 * quota reading exists, which reproduces the pre-feature scores exactly.
 */
export function scoreSlotForTask(slot: NodeCapabilitySlot, task: FitnessTask, quotaBonus = 0): number {
    let score = 1; // base: any slot can run the task (fallback floor)
    const diff = isMeshTaskDifficulty(task.difficulty) ? task.difficulty as MeshTaskDifficulty : undefined;
    if (diff) {
        if (slot.difficulty?.length) {
            score += slot.difficulty.includes(diff) ? 100 : 0; // exact difficulty match dominates
        } else {
            score += 20; // general-purpose slot: decent fallback for any difficulty
        }
    }
    const req = task.requiredTags?.filter(t => !!t) ?? [];
    if (req.length) {
        const cap = new Set(slot.capability ?? []);
        const covered = req.every(t => cap.has(t));
        score += covered ? 30 : 0; // capability coverage bonus (hard filter is applied elsewhere)
    }
    score += quotaBonus; // quota-headroom preference (0 when unknown/stale — see mesh-quota-routing.ts)
    return score;
}

/**
 * The slot order provider selection walks: CAPACITY first, then task→slot fitness.
 *
 * Capacity is the primary key because the selection loop returns the first slot
 * whose CLI is detected — see the SATURATED-SLOT STARVATION note at the call site.
 * Saturated slots are ordered last rather than dropped, so when every slot is at
 * its cap the resulting selection (and the wait/notify semantics the downstream
 * SLOT MODEL GUARD derives from it) is identical to the pre-fix behaviour.
 *
 * Shared by production and the test hook so a regression in either sort key is
 * observable from the test.
 */
export function orderSlotsForProviderSelection(
    slots: NodeCapabilitySlot[],
    meshId: string,
    nodeId: string,
    node: any,
    task: FitnessTask,
    quotaBonusByProvider?: Record<string, number>,
): NodeCapabilitySlot[] {
    return [...slots].sort((a, b) => {
        const capDelta = Number(slotHasCapacity(meshId, nodeId, node, b))
            - Number(slotHasCapacity(meshId, nodeId, node, a));
        if (capDelta !== 0) return capDelta; // slots with headroom first
        return scoreSlotForTask(b, task, quotaBonusByProvider?.[b.provider] ?? 0)
            - scoreSlotForTask(a, task, quotaBonusByProvider?.[a.provider] ?? 0);
    });
}

/** Best (slot, score) for a task on a node, or null when the node has no slots. */
export function bestSlotForTask(node: any, task: FitnessTask, meshId?: string, quotaBonusByProvider?: Record<string, number>): { slot: NodeCapabilitySlot; score: number } | null {
    const slots = resolveNodeCapabilitySlots(node, meshId);
    if (!slots.length) return null;
    let best: { slot: NodeCapabilitySlot; score: number } | null = null;
    for (const slot of slots) {
        const score = scoreSlotForTask(slot, task, quotaBonusByProvider?.[slot.provider] ?? 0);
        if (!best || score > best.score) best = { slot, score };
    }
    return best;
}

/** Node-level fitness for a task = its best slot's score (0 when the node has no slots). */
export function nodeFitnessForTask(node: any, task: FitnessTask, meshId?: string, quotaBonusByProvider?: Record<string, number>): number {
    return bestSlotForTask(node, task, meshId, quotaBonusByProvider)?.score ?? 0;
}

/**
 * Does `slot` accept tasks of `difficulty`? Mirrors scoreSlotForTask's two
 * positive-difficulty branches: an exact difficulty-list match, or a
 * general-purpose slot (no difficulty list) which accepts any difficulty.
 * An absent/invalid difficulty is covered by NOTHING.
 */
export function slotCoversTaskDifficulty(slot: NodeCapabilitySlot | undefined, difficulty: string | undefined): boolean {
    if (!slot) return false;
    if (!isMeshTaskDifficulty(difficulty)) return false;
    if (!slot.difficulty?.length) return true; // general-purpose slot: fallback for any difficulty
    return slot.difficulty.includes(difficulty as MeshTaskDifficulty);
}

/**
 * Resolve one launch axis (model / thinkingLevel) between the value stamped on
 * the task at enqueue and the winning slot's own value.
 *
 * MODEL-SOURCE precedence (defect 0fcec9f1): the difficulty→brain preset fills
 * task.model at enqueue (mesh-work-queue.ts), so "task.model always wins" let
 * a preset silently override the difficulty-matched slot — and with the
 * fail-closed slot-model guard it BLOCKED the task on every node whose slots
 * never declared the preset model (observed: difficulty:'easy' preset to
 * 'haiku' blocked on sonnet-slot nodes). The modelSource marker restores the
 * distinction:
 *   - 'explicit' task value → task value wins, always. A slot must never
 *     override what the user chose.
 *   - 'preset' task value + the winning slot covers the task's difficulty →
 *     the SLOT's value wins. The preset is only the mesh's convenience
 *     default; the operator's slot declaration is the authority on what runs
 *     on that node.
 *   - 'preset' task value but no covering slot (or the slot declares nothing
 *     for this axis) → the preset value stands; the fail-closed guard
 *     downstream decides run/wait/notify on it exactly as before (no
 *     regression on nodes whose slots don't cover the difficulty).
 *   - no task value → the slot fills the blank (unchanged).
 *
 * BACKWARD COMPAT: rows enqueued before modelSource existed have no marker and
 * are treated as 'explicit' — never let a slot override a value that MIGHT be
 * a user's choice. Same convention as quotaShowAccountEmailSetByUser.
 */
export function resolveLaunchAxis(
    taskValue: string | undefined,
    taskSource: 'explicit' | 'preset' | undefined,
    slotValue: string | undefined,
    slotCoversDifficulty: boolean,
): string | undefined {
    const stamped = (typeof taskValue === 'string' && taskValue.trim()) ? taskValue.trim() : undefined;
    if (!stamped) return slotValue;
    if (taskSource !== 'preset') return stamped;
    return (slotCoversDifficulty && slotValue) ? slotValue : stamped;
}

export function orderEligibleNodes(
    meshId: string,
    strategy: RepoMeshSchedulingStrategy,
    nodes: RankableNode[],
    opts?: { bumpCursor?: boolean; task?: FitnessTask; quotaRouting?: RepoMeshQuotaRoutingPolicy | null },
): RankableNode[] {
    if (strategy === 'first_eligible' || nodes.length <= 1) {
        return nodes;
    }

    // Fitness strategy: rank by task→slot fit first (when a task is in scope —
    // auto-launch drains per-task), then fall through to priority/load/rotation for
    // ties. Without a task (idle-session drain ranks task-independently) fitness is
    // inert and the generic path below applies — priority/load/rotation, i.e. the
    // former least_loaded ('spread') behavior fitness subsumes. The QUOTA SPREAD
    // axis rides the fitness score here: each node's per-provider headroom bonus is
    // computed once per pass from its reported facts (fail-open: missing/stale quota
    // scores the pre-feature 0) and folded in via nodeFitnessForTask.
    if (strategy === 'fitness' && opts?.task) {
        const task = opts.task;
        const bonusCache = new Map<string, Record<string, number>>();
        const bonusFor = (c: RankableNode): Record<string, number> => {
            let bonus = bonusCache.get(c.nodeId);
            if (!bonus) {
                bonus = quotaSpreadBonusByProvider(c.node, opts.quotaRouting);
                bonusCache.set(c.nodeId, bonus);
            }
            return bonus;
        };
        return [...nodes].sort((a, b) => {
            const fitDelta = nodeFitnessForTask(b.node, task, meshId, bonusFor(b)) - nodeFitnessForTask(a.node, task, meshId, bonusFor(a));
            if (fitDelta !== 0) return fitDelta; // higher fitness first
            const prioDelta = resolveNodeSchedulingPriority(b.node?.policy) - resolveNodeSchedulingPriority(a.node?.policy);
            if (prioDelta !== 0) return prioDelta;
            const loadDelta = nodeActiveLoad(meshId, a.nodeId) - nodeActiveLoad(meshId, b.nodeId);
            if (loadDelta !== 0) return loadDelta;
            return a.index - b.index;
        });
    }

    const priorityOf = (n: { node: any }) => resolveNodeSchedulingPriority(n.node?.policy);

    // Round-robin rotation offset: rotate the deterministic input order by a
    // per-mesh cursor so the tie-break winner among equal (priority, load) nodes
    // cycles across passes. The cursor advances once per scheduling pass. Only the
    // no-task 'fitness' path (the former 'spread' behavior) uses the rotation.
    let rotation = 0;
    if (strategy === 'fitness') {
        const cursor = opts?.bumpCursor
            ? MeshRuntimeStore.getInstance().bumpSchedulerCursor(meshId)
            : MeshRuntimeStore.getInstance().getSchedulerCursor(meshId);
        rotation = ((cursor % nodes.length) + nodes.length) % nodes.length;
    }

    // Rotation rank: position of each node after rotating input order by `rotation`.
    // For 'priority_only' rotation is 0, so this is just the input index.
    const rotationRank = (index: number) => (index - rotation + nodes.length) % nodes.length;

    return [...nodes].sort((a, b) => {
        const prioDelta = priorityOf(b) - priorityOf(a); // higher priority first
        if (prioDelta !== 0) return prioDelta;
        if (strategy === 'fitness') {
            const loadDelta = nodeActiveLoad(meshId, a.nodeId) - nodeActiveLoad(meshId, b.nodeId);
            if (loadDelta !== 0) return loadDelta;
        }
        return rotationRank(a.index) - rotationRank(b.index);
    });
}


/** Active assignments on a (node, provider) — pre-launch guard for the per-(node,
 *  provider) maxParallel cap. The authoritative enforcement is in the claim
 *  transaction; this only avoids spawning a session that would fail the claim. */
export function activeProviderAssignedCount(meshId: string, nodeId: string, providerType: string): number {
    return getQueue(meshId, { status: ['assigned'] as any })
        .filter(task => daemonIdsEquivalent(task.assignedNodeId, nodeId) && task.assignedProviderType === providerType).length;
}

/**
 * Active assignments charged to ONE SLOT — the (provider, model) pair — on this node.
 *
 * The slot is the unit `maxParallel` bounds (see resolveSlotMaxParallel), so a task
 * running claude-cli/opus must not consume the claude-cli/sonnet slot's budget.
 *
 * BACK-COMPAT: rows claimed before `assignedModel` existed (or by an older daemon)
 * carry no model. Such a row is counted against EVERY slot of its provider — the
 * conservative direction. Ignoring it instead would let a pre-upgrade opus task go
 * unnoticed and allow a second one past a cap of 1, which is precisely the
 * over-subscription this change exists to prevent.
 */
function activeSlotAssignedCount(
    meshId: string,
    nodeId: string,
    providerType: string,
    slot: NodeCapabilitySlot,
): number {
    return getQueue(meshId, { status: ['assigned'] as any }).filter(task => {
        if (!daemonIdsEquivalent(task.assignedNodeId, nodeId)) return false;
        if (task.assignedProviderType !== providerType) return false;
        const assignedModel = (task as any).assignedModel;
        if (typeof assignedModel !== 'string' || !assignedModel.trim()) return true; // legacy row
        return isModelAllowedBySlot(assignedModel, slot);
    }).length;
}

/**
 * Remaining-capacity verdict for one slot on a node, applying BOTH axes:
 *
 *   - the SLOT cap (provider, model) — an independent budget per slot, so idle
 *     headroom on a sibling slot never flows into a saturated one;
 *   - the PROVIDER cap (summed across that provider's slots) — still meaningful
 *     because same-provider slots share one CLI, one auth and one upstream rate
 *     limit, so an operator who wrote opus:1 + sonnet:3 also implied claude-cli:4.
 *
 * Stricter wins (a claim must satisfy both). Keeping the provider axis can only ever
 * refuse MORE than before, never less, so no existing configuration is silently
 * widened by this change.
 */
export function slotCapacityRemaining(
    meshId: string,
    nodeId: string,
    node: any,
    slot: NodeCapabilitySlot,
): { available: boolean; slotCap?: number; providerCap?: number } {
    const providerType = typeof slot.provider === 'string' ? slot.provider.trim() : '';
    if (!providerType) return { available: false };
    const slots = resolveNodeCapabilitySlots(node, meshId);

    const slotCap = resolveSlotMaxParallel(slots, providerType, slot.model, isModelAllowedBySlot);
    if (slotCap !== undefined && activeSlotAssignedCount(meshId, nodeId, providerType, slot) >= slotCap) {
        return { available: false, slotCap };
    }
    const providerCap = resolveProviderMaxParallel(slots, providerType);
    if (providerCap !== undefined && activeProviderAssignedCount(meshId, nodeId, providerType) >= providerCap) {
        return { available: false, slotCap, providerCap };
    }
    return { available: true, slotCap, providerCap };
}

/**
 * Does `slot` currently have capacity for one more task on this node?
 *
 * Capacity is per SLOT — its own (provider, model) budget — and additionally bounded
 * by the provider-wide pool (see slotCapacityRemaining). A slot with no declared cap,
 * on a provider with no declared cap, is uncapped and always available.
 *
 * It must stay per-slot for the two consumers to agree: the SLOT MODEL GUARD decides
 * run/wait/notify from it, and provider SELECTION ranks slots with headroom first. If
 * this reverted to a provider-summed reading, a saturated opus slot would still look
 * "available" while its provider pool had room, and selection would rank it ahead of an
 * idle sibling — reintroducing the starvation that made a second provider unreachable.
 *
 * The authoritative enforcement remains the atomic claim transaction; being approximate
 * here is safe in the right direction — if this says "available" and the claim then
 * refuses, the task simply stays queued and retries.
 */
export function slotHasCapacity(meshId: string, nodeId: string, node: any, slot: NodeCapabilitySlot): boolean {
    return slotCapacityRemaining(meshId, nodeId, node, slot).available;
}

export function sessionHasActiveAssignment(meshId: string, sessionId: string): boolean {
    if (getQueue(meshId, { status: ['assigned'] as any }).some(task => sessionIdsEquivalent(task.assignedSessionId, sessionId))) {
        return true;
    }
    // Direct dispatches (mesh_send_task) are tracked in mesh_direct_dispatches, not the
    // work queue. A session completing a still-active direct dispatch IS an active
    // assignment — without this, findRecentTerminalLedgerEvidence dedup wrongly suppresses
    // the canonical agent:generating_completed for direct-dispatch tasks (validation/general),
    // so the coordinator polling get_pending_mesh_events never observes task_completed and the
    // session goes silently idle. This check runs before markSessionTerminal marks the
    // dispatch terminal, so the in-flight dispatch is still observable here.
    try {
        if (getActiveDirectDispatches(meshId).some(d => sessionIdsEquivalent(d.sessionId, sessionId))) return true;
        if (hasUnterminalDirectDispatchLedgerEntry(meshId, sessionId)) return true;
    } catch { /* best-effort — fall through to false */ }
    return false;
}



/**
 * Test hook: the SLOT MODEL GUARD decision the assignment path would reach for a
 * task on a node, using the same live capacity computation as production.
 * Mirrors the production call site so a test can assert run/wait/notify without
 * spawning a session.
 */
export function __decideSlotForModelForTests(
    meshId: string,
    nodeId: string,
    node: any,
    task: { model?: string; modelSource?: 'explicit' | 'preset'; difficulty?: string; requiredTags?: string[] },
): ReturnType<typeof decideSlotForModel> {
    const best = bestSlotForTask(node, task as FitnessTask, meshId);
    // Mirror the production call site's MODEL-SOURCE precedence
    // (resolveLaunchAxis): an explicit model wins; a preset-stamped one yields
    // to the difficulty-covering slot's own model.
    const requestedModel = resolveLaunchAxis(
        task.model,
        task.modelSource,
        best?.slot?.model,
        slotCoversTaskDifficulty(best?.slot, task.difficulty),
    );
    return decideSlotForModel({
        requestedModel,
        slots: resolveNodeCapabilitySlots(node, meshId).map(slot => ({
            slot,
            available: slotHasCapacity(meshId, nodeId, node, slot),
        })),
    });
}

/**
 * Test hook: the per-slot capacity verdict (slot cap AND provider cap) the SLOT MODEL
 * GUARD and provider selection both consume. Exposed so a test can pin the per-slot
 * accounting without spawning sessions.
 */
export function __slotHasCapacityForTests(
    meshId: string,
    nodeId: string,
    node: any,
    slot: NodeCapabilitySlot,
): boolean {
    return slotHasCapacity(meshId, nodeId, node, slot);
}

/**
 * Test hook: the slot ORDER resolveUsableProvider walks when picking a provider,
 * exposed so a test can assert selection without a live providerLoader / CLI
 * detection. Mirrors that function's sort exactly (capacity first, then fitness
 * incl. the quota-spread bonus), so a regression in either key is caught here.
 */
export function __orderSlotsForProviderSelectionForTests(
    meshId: string,
    nodeId: string,
    node: any,
    task: { difficulty?: string; requiredTags?: string[] },
    quotaRouting?: RepoMeshQuotaRoutingPolicy | null,
): NodeCapabilitySlot[] {
    return orderSlotsForProviderSelection(
        resolveNodeCapabilitySlots(node, meshId),
        meshId,
        nodeId,
        node,
        task as FitnessTask,
        quotaSpreadBonusByProvider(node, quotaRouting ?? null),
    );
}

/** Test hook: the pure task→slot fitness scorer, including the quota-spread
 *  axis, exposed so tests can pin the bonus ordering/cap without a live daemon. */
export function __scoreSlotForTaskForTests(
    slot: NodeCapabilitySlot,
    task: { difficulty?: string; requiredTags?: string[] },
    quotaBonus = 0,
): number {
    return scoreSlotForTask(slot, task, quotaBonus);
}