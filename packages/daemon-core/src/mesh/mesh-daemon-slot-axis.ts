/**
 * DAEMON-AXIS SLOT CONCURRENCY — resolve the set of mesh nodes that share one
 * physical daemon machine, so `maxParallel` is charged per MACHINE rather than
 * per NODE.
 *
 * ## Why the axis moved
 *
 * `maxParallel` bounds a physical resource: how many instances of a provider CLI
 * may run at once on one machine. That budget is set by CPU, memory, the upstream
 * account's rate limit and the single on-disk CLI auth file — all machine-scoped.
 * A mesh NODE is a *branch isolation* unit (one workspace/worktree), not a machine.
 *
 * Charging the cap per node made the two coincide only by accident, and cloning a
 * worktree silently MULTIPLIED the resource budget: three worktrees of the same
 * repo on one laptop each carried their own `claude-cli/opus maxParallel: 1`, so
 * three opus processes ran concurrently against a cap that says one. That is the
 * observed defect (tasks T1/T2/T4, three distinct nodeIds, one machine, assigned
 * within one second of each other).
 *
 * ## What this module does NOT change
 *
 * Slot DECLARATION stays per node (`node.policy.slots`) — an operator still
 * configures a node and a worktree clone still inherits its source node's slots.
 * Only the COUNTING axis moves. A daemon's effective cap is the cap declared by
 * the node being claimed for; sibling nodes' declarations are not summed (summing
 * would re-multiply the budget by worktree count, which is the bug).
 *
 * ## How a node maps to a daemon
 *
 * Preference order, first hit wins:
 *   1. the node's own `daemonId` / `machineId`, reduced to its machine core via
 *      `machineCoreFromDaemonId` so the interchangeable `mach_X` /
 *      `daemon_mach_X` / `standalone_mach_X` forms are ONE key (the canon-identity
 *      defect class — a raw string compare here would split one machine into three
 *      budgets and re-open the over-subscription);
 *   2. for a worktree clone with no id of its own, the machine key of the node it
 *      was cloned from, followed transitively (a clone of a clone). This mirrors
 *      the rule already stated in mesh-quota-routing: "a worktree clone shares the
 *      source node's owning daemon and upstream accounts";
 *   3. otherwise the LOCAL daemon bucket — consistent with `isLocalAutoLaunchNode`,
 *      which already treats a node carrying neither id as this machine's.
 *
 * Step 3 is what keeps REMOTE nodes separate: MainPC/MoltBook/Jupiter each report
 * their own `daemonId`, so they resolve to distinct keys at step 1 and never share
 * a budget. Only genuinely unidentified nodes — which are local by the existing
 * convention — land in the local bucket together.
 */
import { machineCoreFromDaemonId, meshNodeIdMatches, normalizeMeshNodeId, type MeshNodeIdentified } from '@adhdev/mesh-shared';
import { readMeshNodeDaemonId, readMeshNodeMachineId } from './mesh-node-identity.js';

/** Bucket for nodes that declare no machine identity at all. Distinct from any
 *  real `mach_<hex>` core, so it can never collide with an identified daemon. */
const LOCAL_DAEMON_KEY = '__local_daemon__';

/**
 * ## Starvation guard — why READ-ONLY tasks cannot take the last slot
 *
 * Moving the cap to the daemon axis makes a slot budget CONTENDED for the first
 * time. Before, five read-only diagnoses landing on five worktree nodes each held
 * their own `opus: 1`; now they compete for a single one. That is the intended fix,
 * but it creates a new failure mode: read-only work is cheap to dispatch, unbounded
 * by the write cap (it has its own larger global budget — see
 * resolveMaxReadonlyParallelTasks), and typically fans out. A batch of them can hold
 * every slot on a machine continuously, and a write task then waits forever. This is
 * not hypothetical — the 2026-08-17 audit fan-out held five concurrent claude
 * sessions on one machine.
 *
 * Two designs were considered:
 *
 *   - a PRIORITY PENALTY (rank read-only last) only reorders the queue. Under
 *     sustained read-only arrival the write task is still never scheduled, because
 *     there is no point at which a slot is guaranteed free for it. It bounds nothing.
 *   - a RESERVATION structurally bounds the harm: read-only work may not occupy the
 *     LAST free slot of a capped budget, so one slot is always reachable by a write
 *     task within one task-completion. This is the design implemented here.
 *
 * The reservation applies ONLY when the cap is 2 or more. At `maxParallel: 1`
 * reserving the single slot would forbid read-only work outright on that slot —
 * strictly worse than today and not what the owner asked for. At a cap of 1 the
 * slot is contended but each task still releases it on completion, so read-only and
 * write simply take turns.
 *
 * This mirrors the existing global convention (write and read-only already carry
 * separate global budgets) rather than introducing a second, unrelated policy knob.
 */
export function readonlySlotBudget(cap: number): number {
    if (!Number.isFinite(cap) || cap <= 1) return Math.max(0, Math.floor(cap));
    return Math.floor(cap) - 1;
}

/**
 * The effective cap for one claim, given the declared cap and whether the claiming
 * task is read-only. Write tasks always see the full cap; read-only tasks see the
 * reserved budget. Returns undefined for an undeclared (uncapped) cap — an uncapped
 * slot stays uncapped for both kinds.
 */
export function effectiveSlotCap(cap: number | undefined, isReadonly: boolean): number | undefined {
    if (cap === undefined || !Number.isFinite(cap)) return undefined;
    return isReadonly ? readonlySlotBudget(cap) : Math.floor(cap);
}

/** Follow `clonedFromNodeId` at most this far. A cycle (A cloned-from B, B
 *  cloned-from A) can only arise from corrupted config, but it must not hang the
 *  claim path, so the walk is bounded as well as visited-set guarded. */
const MAX_CLONE_CHAIN = 16;

function readNonEmpty(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/** The machine core declared directly on a node, ignoring any clone lineage. */
function directDaemonKey(node: unknown): string | undefined {
    if (!node || typeof node !== 'object') return undefined;
    const record = node as Record<string, unknown>;
    const declared = readNonEmpty(readMeshNodeDaemonId(record)) || readNonEmpty(readMeshNodeMachineId(record));
    if (!declared) return undefined;
    return machineCoreFromDaemonId(declared);
}

/**
 * The daemon-machine key for one node — the value that must be equal for two nodes
 * to share a `maxParallel` budget. Never returns empty: an unidentifiable node
 * falls back to the local bucket rather than to a unique key, because a unique key
 * would silently restore per-node counting for exactly the nodes we cannot verify.
 */
export function resolveNodeDaemonKey(node: unknown, allNodes: readonly unknown[] = []): string {
    const direct = directDaemonKey(node);
    if (direct) return direct;

    // Worktree clone with no declared id: inherit the source node's machine.
    const seen = new Set<string>();
    let current = node as Record<string, unknown> | undefined;
    for (let hop = 0; hop < MAX_CLONE_CHAIN && current; hop++) {
        const sourceId = readNonEmpty(current.clonedFromNodeId) || readNonEmpty(current.cloned_from_node_id);
        if (!sourceId) break;
        const sourceKey = normalizeMeshNodeId({ id: sourceId } as MeshNodeIdentified);
        if (!sourceKey || seen.has(sourceKey)) break;
        seen.add(sourceKey);
        const source = allNodes.find(candidate =>
            candidate !== current
            && candidate
            && typeof candidate === 'object'
            && meshNodeIdMatches(candidate as MeshNodeIdentified, sourceId),
        ) as Record<string, unknown> | undefined;
        if (!source) break;
        const sourceDaemon = directDaemonKey(source);
        if (sourceDaemon) return sourceDaemon;
        current = source;
    }

    return LOCAL_DAEMON_KEY;
}

/**
 * Every nodeId in the mesh that shares a daemon machine with `nodeId` — including
 * `nodeId` itself, which is always present even when the mesh list is unavailable
 * (a degraded read must never widen a cap by dropping the node being claimed for).
 *
 * The returned ids are raw node ids as stored on `assigned_node_id`; callers match
 * them with the same equivalence comparator used elsewhere, not a raw `===`.
 */
export function resolveDaemonSiblingNodeIds(nodeId: string, nodes: readonly unknown[] | undefined): string[] {
    const self = readNonEmpty(nodeId);
    const list = Array.isArray(nodes) ? nodes : [];
    if (!self || list.length === 0) return self ? [self] : [];

    const selfNode = list.find(candidate =>
        candidate && typeof candidate === 'object' && meshNodeIdMatches(candidate as MeshNodeIdentified, self),
    );
    // A node absent from the mesh list cannot be grouped; charge it alone rather
    // than dropping it into the local bucket with unrelated nodes.
    if (!selfNode) return [self];

    const selfKey = resolveNodeDaemonKey(selfNode, list);
    const out: string[] = [self];
    const seen = new Set<string>([normalizeMeshNodeId({ id: self } as MeshNodeIdentified) || self]);
    for (const candidate of list) {
        if (!candidate || typeof candidate !== 'object') continue;
        if (resolveNodeDaemonKey(candidate, list) !== selfKey) continue;
        const id = normalizeMeshNodeId(candidate as MeshNodeIdentified);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}
