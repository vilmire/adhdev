/**
 * Mesh Node Capability Tags — derive a node's capability tag set and match it
 * against a task's required tags.
 *
 * Split out of mesh-work-queue.ts (FILE-SIZE-HEADROOM). Pure move: these are
 * side-effect-free predicates over node policy/override/reporter fields — they
 * touch no queue row and no store. mesh-work-queue.ts re-exports them so every
 * existing import keeps resolving.
 */

import { normalizeNodeCapabilitySlots } from '@adhdev/mesh-shared';

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

/**
 * Ordered, de-duplicated provider types a node can launch, resolved from
 * `policy.slots` (the single source of truth — node capability slots design, 2026-07-09) with a
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
    ]);
}

export function nodeSatisfiesRequiredTags(requiredTags: unknown, capabilityTags: unknown): boolean {
    const required = normalizeMeshCapabilityTags(requiredTags);
    if (required.length === 0) return true;
    const available = new Set(normalizeMeshCapabilityTags(capabilityTags));
    return required.every(tag => available.has(tag));
}

/**
 * ★PROVIDER-PIN-BYPASS — the provider types a task's required_tags PIN it to.
 *
 * `nodeSatisfiesRequiredTags(tags, buildMeshNodeCapabilityTags(node))` — the
 * one-argument, representative form — answers "could SOME provider on this node
 * satisfy the pin?". That is the right question for a NODE filter, and it is what
 * the auto-launch candidate scan asks. It is the
 * WRONG question for a path that then has to pick a concrete provider, because the
 * representative tag set advertises `provider=<type>` for EVERY slot the node
 * declares (see buildMeshNodeCapabilityTags above). A node whose slots are
 * [claude-cli, antigravity-cli] satisfies `provider=antigravity-cli` — and a caller
 * that reads that as "yes" and then resolves the provider independently (e.g. from
 * providerPriority[0]) lands the task on claude-cli while believing the pin held.
 *
 * ★That is not hypothetical. Live (2026-09-21, task 1c225a59, node Jupiter):
 * required_tags ["provider=antigravity-cli"] → auto_launch correctly SKIPPED
 * (`task_difficulty_floor_unavailable:medium`, the antigravity slot being easy-only)
 * → the enqueue-and-push accelerator then dispatched to `claude-cli`, the node's
 * providerPriority[0], and the ledger recorded the pin as honored.
 *
 * So: any path that selects a provider must intersect its candidates with THIS set
 * rather than re-deriving one and trusting the node-level predicate. Returns the
 * pinned types in tag order; an EMPTY array means "no provider pin" — every other
 * tag axis (os=/arch=/worktree=/converge=) is a node property, not a provider
 * choice, and leaves provider selection unconstrained.
 */
export function providerPinsFromRequiredTags(requiredTags: unknown): string[] {
    const out: string[] = [];
    for (const tag of normalizeMeshCapabilityTags(requiredTags)) {
        if (!tag.startsWith('provider=')) continue;
        const type = tag.slice('provider='.length).trim();
        if (type && !out.includes(type)) out.push(type);
    }
    return out;
}

/**
 * ★PROVIDER-PIN-BYPASS — narrow a provider-selection candidate list to what the
 * task's required_tags allow, preserving the caller's own preference order.
 *
 * No pin → the list is returned unchanged, so an UNPINNED task keeps exactly its
 * previous routing (the over-correction guard: pinning must never become a filter
 * that unpinned work has to pass). A pin that nothing in `candidates` satisfies
 * returns an EMPTY array — the caller must treat that as "I cannot honor this pin"
 * and decline, never as "no constraint".
 */
export function filterProvidersByRequiredTags(candidates: unknown, requiredTags: unknown): string[] {
    const list = Array.isArray(candidates)
        ? candidates.map(c => typeof c === 'string' ? c.trim() : '').filter(Boolean)
        : [];
    const pins = providerPinsFromRequiredTags(requiredTags);
    if (pins.length === 0) return list;
    return list.filter(type => pins.includes(type));
}
