/**
 * Mesh Node Capability Tags — derive a node's capability tag set and match it
 * against a task's required tags.
 *
 * Split out of mesh-work-queue.ts (FILE-SIZE-HEADROOM). Pure move: these are
 * side-effect-free predicates over node policy/override/reporter fields — they
 * touch no queue row and no store. mesh-work-queue.ts re-exports them so every
 * existing import keeps resolving.
 */

import { MESH_CONVERGE_REFINE_TAG, resolveAutoConvergeCodeChange } from '../repo-mesh-types.js';
import { normalizeNodeCapabilitySlots } from '@adhdev/mesh-shared';
import { getMesh } from '../config/mesh-config.js';
import type { MeshTaskMode } from './mesh-work-queue.js';

export function normalizeMeshCapabilityTags(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value
        .map(tag => typeof tag === 'string' ? tag.trim() : '')
        .filter(Boolean)
        .filter(tag => {
            if (seen.has(tag)) return false;
            seen.add(tag);
            return true;
        });
}

function firstProviderPriority(policy: unknown): string | undefined {
    const raw = policy && typeof policy === 'object' && !Array.isArray(policy)
        ? (policy as Record<string, unknown>).providerPriority
        : undefined;
    if (!Array.isArray(raw)) return undefined;
    return raw.find(type => typeof type === 'string' && type.trim())?.trim();
}

/**
 * Ordered, de-duplicated provider types a node can launch, resolved from
 * `policy.slots` (the single source of truth — ORCHESTRATION_NODE_SLOTS.md) with a
 * fallback to the legacy `policy.providerPriority`. Used to advertise a
 * `provider=<type>` capability tag for EVERY provider the node supports, not just
 * providerPriority[0], so required_tags: ["provider=cursor-cli"] is satisfiable on a
 * node whose slots include cursor-cli even when it is not the first priority entry.
 *
 * Only provider NAMES are needed here, so slots are read via the dependency-light
 * normalizeNodeCapabilitySlots rather than resolveNodeCapabilitySlots (which pulls in
 * difficultyBrains) — keeping tag derivation free of scheduling-config imports.
 */
function readNodeProviderTypes(policy: unknown): string[] {
    const record = policy && typeof policy === 'object' && !Array.isArray(policy)
        ? policy as Record<string, unknown>
        : {};
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (type: unknown) => {
        const trimmed = typeof type === 'string' ? type.trim() : '';
        if (!trimmed || seen.has(trimmed)) return;
        seen.add(trimmed);
        out.push(trimmed);
    };
    for (const slot of normalizeNodeCapabilitySlots(record.slots)) push(slot.provider);
    if (Array.isArray(record.providerPriority)) {
        for (const type of record.providerPriority) push(type);
    }
    return out;
}

function readNodeOverride(node: { userOverrides?: unknown } | undefined, key: 'platform' | 'arch'): string | null {
    const overrides = node?.userOverrides;
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return null;
    const value = (overrides as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Live, self-reported platform/arch the owning daemon stamped onto the node from
 * its own process.platform/process.arch via the git_status envelope. Kept on a
 * field DISTINCT from userOverrides so capability-tag derivation can prefer an
 * explicit operator override while still self-healing auto-detected nodes — and
 * so the value reflects the node's real OS rather than the coordinator's.
 */
function readNodeReporter(node: { reportedPlatform?: unknown; reportedArch?: unknown } | undefined, key: 'platform' | 'arch'): string | null {
    const value = key === 'platform' ? node?.reportedPlatform : node?.reportedArch;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function buildMeshNodeCapabilityTags(
    node: { capabilities?: unknown; policy?: unknown; isLocalWorktree?: unknown; worktreeBranch?: unknown; userOverrides?: unknown; reportedPlatform?: unknown; reportedArch?: unknown } | undefined,
    providerType?: string,
): string[] {
    // When an explicit providerType is pinned (per-provider tag set used by the
    // queue slot matcher), advertise ONLY that provider's tag — so
    // provider=codex-cli matches only when codex-cli is the launched provider.
    // When no provider is pinned (the representative tag set consulted by
    // nodeSatisfiesRequiredTags), advertise a provider= tag for EVERY provider the
    // node can launch (all policy.slots, else providerPriority), so
    // required_tags: ["provider=cursor-cli"] is satisfiable on a node whose slots
    // include cursor-cli even when it is not the first priority entry.
    const pinnedProvider = typeof providerType === 'string' && providerType.trim()
        ? providerType.trim()
        : undefined;
    const providerTags = pinnedProvider
        ? [pinnedProvider]
        : readNodeProviderTypes(node?.policy);
    const worktreeBranch = typeof node?.worktreeBranch === 'string' && node.worktreeBranch.trim()
        ? node.worktreeBranch.trim()
        : null;
    // Per-node platform/arch precedence (highest → lowest):
    //   1. userOverrides.platform/arch — an EXPLICIT operator override always wins.
    //   2. reportedPlatform/reportedArch — the live OS the owning daemon
    //      self-reported (its own process.platform/process.arch via the git_status
    //      envelope), persisted to the node record on each direct probe. This is
    //      why a Windows member advertises os=win32 even though the COORDINATOR
    //      computing these tags runs on darwin — without it the consumer reads the
    //      persistent node (operator userOverrides empty) and would fall straight
    //      through to the coordinator's own process.platform, mislabeling every
    //      node os=darwin. We prefer this LIVE value over any stale auto-stamp.
    //   3. process.platform/process.arch — last-resort fallback, correct only for
    //      the local coordinator node / local worktree nodes that have not yet
    //      been probed (their workspace lives on THIS machine anyway).
    // Vocabulary is raw process.platform/process.arch ("darwin"/"win32"/"linux",
    // "arm64"/"x64") on both the advertiser and the required_tags matcher, which
    // compares with plain string equality (nodeSatisfiesRequiredTags) — so this
    // keeps the win32/darwin/linux vocabulary the matcher already expects.
    const os = readNodeOverride(node, 'platform') ?? readNodeReporter(node, 'platform') ?? process.platform;
    const arch = readNodeOverride(node, 'arch') ?? readNodeReporter(node, 'arch') ?? process.arch;
    return normalizeMeshCapabilityTags([
        ...(Array.isArray(node?.capabilities) ? node.capabilities : []),
        `os=${os}`,
        `arch=${arch}`,
        ...providerTags.map(p => `provider=${p}`),
        // Worktree nodes automatically expose a "worktree=<branch>" tag so that
        // mesh_enqueue_task with required_tags: ["worktree=<branch>"] routes
        // only to the matching worktree node.
        ...(node?.isLocalWorktree === true && worktreeBranch ? [`worktree=${worktreeBranch}`] : []),
        // Convergence routing: advertise how this node can land its work onto base.
        //   - converge=refine: local worktree nodes (on ANY machine — refine_mesh_node
        //     now forwards to the owning daemon) can run the Refinery merge → push →
        //     cleanup against their own checkout, so they accept code_change tasks.
        //   - converge=fast_forward: non-worktree nodes (the machine itself) can only
        //     ff/push an already-converged branch; they are NOT a destination for
        //     code_change work (a worktree is created first, and that worktree node
        //     receives the task instead). Reuses the ordinary required-tags filter —
        //     the load-balancing scheduler auto-injects converge=refine for code_change
        //     so such work is hard-filtered onto refine-capable nodes.
        ...(node?.isLocalWorktree === true ? ['converge=refine'] : ['converge=fast_forward']),
    ]);
}

export function nodeSatisfiesRequiredTags(requiredTags: unknown, capabilityTags: unknown): boolean {
    const required = normalizeMeshCapabilityTags(requiredTags);
    if (required.length === 0) return true;
    const available = new Set(normalizeMeshCapabilityTags(capabilityTags));
    return required.every(tag => available.has(tag));
}

/**
 * Convergence-aware required-tags resolution (load-balancing scheduler, opt-in).
 *
 * When the mesh enables policy.autoConvergeCodeChange, a `converge=refine` required
 * tag is merged into a code_change task's required tags at enqueue time, so the
 * scheduler hard-filters the task onto refine-capable worktree nodes only (on any
 * machine — refine_mesh_node forwards to the owning daemon). Because the tag is
 * persisted on the queue entry, BOTH the eligibility scan (maybeAutoLaunchOneQueueSession)
 * and the claim transaction (claimNextQueueTask → nodeSatisfiesRequiredTags) enforce
 * it consistently.
 *
 * Strict backward compatibility — the injection is skipped (returns the explicit tags
 * unchanged) when ANY of:
 *   - the mesh does not opt in (autoConvergeCodeChange !== true), or
 *   - the task is not code_change (validation / live_debug_readonly / launch_app /
 *     convergence carry no merge cost and may run anywhere), or
 *   - the task is explicitly targeted (targetNodeId): the operator chose the node, so
 *     we do not second-guess it by filtering on convergence capability.
 * Idempotent: normalizeMeshCapabilityTags dedupes, so re-injection is a no-op.
 */
export function resolveConvergeRequiredTags(
    meshId: string,
    taskMode: MeshTaskMode | undefined,
    explicitRequiredTags: string[],
    opts?: { targetNodeId?: string },
): string[] {
    if (taskMode !== 'code_change') return explicitRequiredTags;
    if (typeof opts?.targetNodeId === 'string' && opts.targetNodeId.trim()) return explicitRequiredTags;
    let optedIn = false;
    try {
        optedIn = resolveAutoConvergeCodeChange(getMesh(meshId)?.policy as any);
    } catch {
        optedIn = false;
    }
    if (!optedIn) return explicitRequiredTags;
    return normalizeMeshCapabilityTags([...explicitRequiredTags, MESH_CONVERGE_REFINE_TAG]);
}
