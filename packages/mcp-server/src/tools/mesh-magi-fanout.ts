// MAGI fan-out planning (pure): resolve the configured kind-panel slots against the
// live mesh nodes into (node, provider) replica targets, excluding unavailable,
// unhealthy and git-stale slots, and cap the total. Split out of mesh-tools-magi.ts.

import { type MeshContext } from './mesh-tools-internal.js';
import {
    type MagiSlot,
    type LocalMeshNodeEntry,
    normalizeMeshCapabilityTags,
    meshNodeIdMatches,
    nodeSatisfiesRequiredTags,
    buildMeshNodeCapabilityTags,
    isMeshNodeHealthLaunchable,
    resolveEffectiveMeshNodeHealth,
} from '@adhdev/daemon-core';
import { resolveCoordinatorNode } from './mesh-node-identity.js';

// ─── Guards / constants ─────────────────────────

/** Hard cap on total replicas (members × n) per mesh_magi_review invocation. */
export const MAGI_MAX_REPLICAS = 12;
/** Minimum distinct (node, provider) targets a panel must resolve to. */
export const MAGI_MIN_TARGETS = 2;

export interface MagiReplicaPlan {
    slotIndex: number;
    provider: string;
    /** Resolved concrete node id (pinned slot), else undefined (tag-routed). */
    targetNodeId?: string;
    capabilityTags: string[];
    /** Tags the enqueued task hard-filters on: ['provider=<p>', ...capabilityTags]. */
    requiredTags: string[];
    /** MAGI-KIND-PANEL model axis: model override forwarded to the replica's launch (initialModel). */
    model?: string;
}

export interface MagiUnavailableSlot {
    slotIndex: number;
    provider: string;
    nodeId?: string;
    capabilityTags: string[];
    reason: string;
}

/** A slot excluded because every candidate node's health is not launch-ready. */
export interface MagiUnhealthySlot {
    slotIndex: number;
    provider: string;
    nodeId?: string;
    capabilityTags: string[];
    /** The resolved health that made the slot unhealthy (e.g. 'degraded', 'offline'). */
    health: string;
    reason: string;
}

/** Per-slot resolution detail (for the git-stale exclusion + the review response surface). */
export interface MagiSlotResolution {
    slotIndex: number;
    provider: string;
    nodeId?: string;
    capabilityTags: string[];
    /** Resolves to ≥1 live node (pinned present, or a tag match). */
    available: boolean;
    /** Representative resolved node HEAD commit (best-effort; absent when unknown). */
    headCommit?: string;
    /** True when available AND every candidate node's known HEAD differs from referenceCommit. */
    gitStale: boolean;
    /** True when available but NO candidate node's health is launch-ready (degraded/offline). */
    unhealthy: boolean;
    /** The resolved health of the (representative) candidate node — surfaced for diagnosis. */
    health?: string;
    /** Excluded from the fan-out (unavailable, unhealthy, or git-stale and not include_stale). */
    excluded: boolean;
    reason?: string;
}

export interface MagiFanoutPlan {
    replicas: MagiReplicaPlan[];
    totalRequested: number;
    totalAfterCap: number;
    droppedReplicas: number;
    distinctTargets: number;
    distinctProviders: number;
    distinctNodeTargets: number;
    enoughTargets: boolean;
    coupled: boolean;
    unavailableSlots: MagiUnavailableSlot[];
    /** Slots excluded because every candidate node's health is not launch-ready
     *  (degraded / offline). Without this gate the replica would be assigned to a node
     *  isLaunchableNode refuses, so it parks in `pending` forever — the infinite-wait defect. */
    unhealthySlots: MagiUnhealthySlot[];
    /** The commit the panel is being resolved against (coordinator HEAD); undefined when unknown. */
    referenceCommit?: string;
    /** Per-slot resolution detail, aligned to the kind-panel slot order. */
    slotResolutions: MagiSlotResolution[];
    /** Slots excluded because they are git-stale (different HEAD) and include_stale was not set. */
    staleSlots: MagiSlotResolution[];
    /** Git-stale slots that were nonetheless INCLUDED because include_stale=true (warning surface). */
    includedStaleSlots: MagiSlotResolution[];
}

function replicaCountFor(slot: MagiSlot, defaultN: number | undefined, globalN?: number): number {
    const n = slot.n ?? defaultN ?? globalN ?? 1;
    return Math.max(1, Math.floor(n));
}

/** Best-effort HEAD commit sha off a live node's git status (GitRepoStatus.headCommit). */
export function nodeHeadCommit(node: any): string | undefined {
    const h = node?.git?.headCommit;
    return typeof h === 'string' && h.trim() ? h.trim() : undefined;
}

/**
 * Canonical, order-independent key of a node's submodule gitlinks
 * (GitSubmoduleStatus[] on node.git.submodules — path + commit). Two nodes on the
 * same root HEAD but different submodule pointers (the oss/adhdev-providers case,
 * where the submodule carries the actual fix code) must NOT be treated as the same
 * base. Returns undefined when the node carries NO submodule telemetry at all
 * (missing / non-array / empty) — so the caller only compares submodule keys when
 * BOTH sides advertise submodules, and a node without submodule telemetry is never
 * silently excluded (mirrors the missing-HEAD "can't prove → fresh" rule). An empty
 * array is telemetry-absent (no submodules reported), NOT "a repo with zero
 * submodules", so it too yields undefined and falls back to root-HEAD-only compare.
 */
function nodeSubmoduleKey(node: any): string | undefined {
    const subs = node?.git?.submodules;
    if (!Array.isArray(subs) || subs.length === 0) return undefined;
    const parts = subs
        .map((s: any) => {
            const path = typeof s?.path === 'string' ? s.path.trim() : '';
            const commit = typeof s?.commit === 'string' ? s.commit.trim() : '';
            return path && commit ? `${path}@${commit}` : undefined;
        })
        .filter((p: string | undefined): p is string => !!p)
        .sort((a: string, b: string) => a.localeCompare(b));
    return parts.length > 0 ? parts.join(',') : undefined;
}

/**
 * Whether a candidate node shares the same base as the coordinator reference.
 * Root HEAD must match. Submodule gitlinks are additionally compared ONLY when the
 * reference AND the candidate both carry submodule telemetry — if either side lacks
 * it, we fall back to root-HEAD-only (the pre-fingerprint behavior), so telemetry
 * absence never causes a silent exclusion. A candidate with no known HEAD can't be
 * proven stale and is treated as fresh by the caller (this helper is only consulted
 * once the candidate HEAD is known to match the reference HEAD).
 */
function candidateMatchesReferenceBase(
    candidateHead: string,
    candidateSubKey: string | undefined,
    referenceCommit: string,
    referenceSubKey: string | undefined,
): boolean {
    if (candidateHead !== referenceCommit) return false;
    // Only diff submodule gitlinks when BOTH sides advertise them.
    if (referenceSubKey !== undefined && candidateSubKey !== undefined) {
        return candidateSubKey === referenceSubKey;
    }
    return true;
}

/**
 * Fix B fallback: a node's drift from its OWN upstream (GitCompactSummary.behind/ahead).
 * Used only when no coordinator reference commit is known — a node that reports it is
 * behind/ahead of its upstream is provably on different code than the panel baseline even
 * though we cannot diff explicit HEADs. Returns {behind:0,ahead:0} when the node carries no
 * drift telemetry, so a node with no counters is never proven stale (mirrors the
 * missing-HEAD "can't prove → fresh" rule).
 */
function nodeGitDrift(node: any): { behind: number; ahead: number } {
    const git = node?.git;
    const behind = git && typeof git.behind === 'number' && Number.isFinite(git.behind) ? Math.max(0, git.behind) : 0;
    const ahead = git && typeof git.ahead === 'number' && Number.isFinite(git.ahead) ? Math.max(0, git.ahead) : 0;
    return { behind, ahead };
}
function nodeHasGitDrift(node: any): boolean {
    const { behind, ahead } = nodeGitDrift(node);
    return behind > 0 || ahead > 0;
}

/**
 * Resolve a kind-panel's slots against the live mesh nodes into a concrete fan-out
 * plan: expand each available slot to its replica count, clamp the total to the guard
 * cap (drop logged, never silent), assess (node, provider) target diversity, and
 * flag a panel that collapses to a single provider/machine. Pure.
 */
export function buildMagiFanoutPlan(
    slots: MagiSlot[],
    nodes: LocalMeshNodeEntry[],
    opts: { n?: number; defaultN?: number; maxReplicas?: number; referenceCommit?: string; referenceSubmoduleKey?: string; includeStale?: boolean } = {},
): MagiFanoutPlan {
    const cap = Math.max(1, Math.floor(opts.maxReplicas ?? MAGI_MAX_REPLICAS));
    const slotList = Array.isArray(slots) ? slots : [];
    const defaultN = opts.defaultN;
    const referenceCommit = typeof opts.referenceCommit === 'string' && opts.referenceCommit.trim() ? opts.referenceCommit.trim() : undefined;
    const referenceSubmoduleKey = typeof opts.referenceSubmoduleKey === 'string' && opts.referenceSubmoduleKey.trim() ? opts.referenceSubmoduleKey.trim() : undefined;
    const includeStale = opts.includeStale === true;
    const replicas: MagiReplicaPlan[] = [];
    const unavailableSlots: MagiUnavailableSlot[] = [];
    const unhealthySlots: MagiUnhealthySlot[] = [];
    const slotResolutions: MagiSlotResolution[] = [];
    const targetKeys = new Set<string>();
    const providerSet = new Set<string>();
    const nodeTargetSet = new Set<string>();
    let totalRequested = 0;

    slotList.forEach((slot, slotIndex) => {
        const provider = slot.provider;
        const model = typeof slot.model === 'string' && slot.model.trim() ? slot.model.trim() : undefined;
        const capabilityTags = normalizeMeshCapabilityTags(slot.capabilityTags);
        const requiredTags = normalizeMeshCapabilityTags([`provider=${provider}`, ...capabilityTags]);
        const count = replicaCountFor(slot, defaultN, opts.n);

        // Resolve availability against the mesh, and gather the candidate node(s) so we
        // can assess git staleness against the reference commit.
        let targetNodeId: string | undefined;
        let candidateNodes: any[] = [];
        if (slot.nodeId) {
            const node = nodes.find(n => meshNodeIdMatches(n as any, slot.nodeId!));
            if (node) { targetNodeId = (node as any).id; candidateNodes = [node]; }
        } else {
            // Match against each node's OWN advertised tags (provider derived from its
            // policy.providerPriority), NOT a provider we inject — passing `provider`
            // here would synthesize a provider= tag and make the filter always pass.
            // Mirrors the queue's availability check (mesh-tools-queue.ts).
            candidateNodes = nodes.filter(n => nodeSatisfiesRequiredTags(requiredTags, buildMeshNodeCapabilityTags(n)));
        }
        const available = candidateNodes.length > 0;

        if (!available) {
            unavailableSlots.push({
                slotIndex,
                provider,
                nodeId: slot.nodeId,
                capabilityTags,
                reason: slot.nodeId
                    ? `pinned node '${slot.nodeId}' is not a member of this mesh`
                    : `no mesh node satisfies required tags [${requiredTags.join(', ')}]`,
            });
            slotResolutions.push({ slotIndex, provider, nodeId: slot.nodeId, capabilityTags, available: false, gitStale: false, unhealthy: false, excluded: true, reason: 'unavailable' });
            return;
        }

        // Health gate (PRIMARY FIX). A slot is available by capability tags, but a node
        // whose P2P/git health is not launch-ready (degraded / offline) is refused by the
        // daemon's auto-launch gate (isLaunchableNode → node_health_not_launchable): the replica
        // task would be assigned yet never launch, parking in `pending` forever with no
        // re-assignment or cancellation — the MAGI infinite-wait defect. So exclude such a
        // slot UP FRONT, exactly as the git-stale gate does. Prefer routing to a launch-ready
        // candidate when the pool is mixed; only exclude when EVERY candidate is unhealthy.
        // 'unknown'/'online' (and absent health) pass — we never exclude on missing telemetry
        // (mirrors the missing-HEAD "can't prove → fresh" rule), so a mesh whose nodes carry
        // no health telemetry behaves exactly as before this gate.
        const launchableCandidates = candidateNodes.filter(n => isMeshNodeHealthLaunchable(n));
        if (launchableCandidates.length === 0) {
            const health = resolveEffectiveMeshNodeHealth(candidateNodes[0]);
            unhealthySlots.push({
                slotIndex,
                provider,
                nodeId: targetNodeId ?? slot.nodeId,
                capabilityTags,
                health,
                reason: slot.nodeId
                    ? `pinned node '${slot.nodeId}' health is '${health}' (not launch-ready)`
                    : `no launch-ready node satisfies required tags [${requiredTags.join(', ')}] — all candidates are '${health}'`,
            });
            slotResolutions.push({
                slotIndex, provider, nodeId: targetNodeId ?? slot.nodeId, capabilityTags,
                available: true, gitStale: false, unhealthy: true, health, excluded: true,
                reason: `node_unhealthy: ${health}`,
            });
            return;
        }
        // Narrow the candidate pool to launch-ready nodes for all downstream resolution
        // (git-staleness, target pinning) so a mixed pool routes to a healthy node.
        if (slot.nodeId && launchableCandidates[0]) targetNodeId = (launchableCandidates[0] as any).id;
        candidateNodes = launchableCandidates;

        // Git staleness vs the reference commit. A slot is git-stale only when a
        // reference commit is known AND every candidate node with a known HEAD differs
        // from it (a node with no known HEAD can't be proven stale → treated as fresh,
        // so we never silently exclude on missing telemetry). Prefer routing to a fresh
        // candidate when one exists.
        let headCommit: string | undefined;
        let gitStale = false;
        if (referenceCommit) {
            const freshCandidate = candidateNodes.find(n => {
                const h = nodeHeadCommit(n);
                // No known HEAD → can't be proven stale → fresh (never exclude on missing
                // telemetry). Otherwise same-base iff root HEAD matches AND — when both the
                // reference and this candidate advertise submodules — the submodule gitlinks
                // match too. Two nodes on the same root HEAD but different oss/adhdev-providers
                // pointer are NOT the same base.
                if (!h) return true;
                return candidateMatchesReferenceBase(h, nodeSubmoduleKey(n), referenceCommit, referenceSubmoduleKey);
            });
            if (freshCandidate) {
                headCommit = nodeHeadCommit(freshCandidate);
                if (slot.nodeId) targetNodeId = (freshCandidate as any).id;
                gitStale = false;
            } else {
                headCommit = nodeHeadCommit(candidateNodes[0]);
                gitStale = true;
            }
        } else {
            // Fix B (stale-gate fallback): the coordinator carries no git HEAD telemetry, so
            // there is no reference commit to diff against. Previously this passed EVERY
            // candidate as fresh (gitStale stays false), so a node sitting behind/ahead of its
            // own upstream silently joined the panel on different code. When drift counters ARE
            // present, use them: prefer a candidate with zero drift; if none is clean but some
            // candidate reports drift, mark the slot git-stale (default-excluded like the
            // HEAD-diff path). A candidate with no drift telemetry at all is still treated as
            // fresh — we never exclude on missing data.
            const freshCandidate = candidateNodes.find(n => !nodeHasGitDrift(n));
            if (freshCandidate && candidateNodes.some(nodeHasGitDrift)) {
                // Mixed pool: route to the clean candidate, leave the slot fresh.
                headCommit = nodeHeadCommit(freshCandidate);
                if (slot.nodeId) targetNodeId = (freshCandidate as any).id;
                gitStale = false;
            } else if (!freshCandidate && candidateNodes.some(nodeHasGitDrift)) {
                // Every candidate reports drift → provably stale relative to its upstream.
                headCommit = nodeHeadCommit(candidateNodes[0]);
                gitStale = true;
            } else {
                // No drift telemetry on any candidate → cannot prove staleness; treat as fresh.
                headCommit = nodeHeadCommit(candidateNodes.find(n => nodeHeadCommit(n)) ?? candidateNodes[0]);
            }
        }

        const resolution: MagiSlotResolution = {
            slotIndex,
            provider,
            nodeId: targetNodeId ?? slot.nodeId,
            capabilityTags,
            available: true,
            ...(headCommit ? { headCommit } : {}),
            gitStale,
            // Candidate pool was already narrowed to launch-ready nodes above, so an
            // included slot is health-launchable by construction.
            unhealthy: false,
            health: resolveEffectiveMeshNodeHealth(candidateNodes[0]),
            excluded: false,
        };

        // Default-exclude a git-stale slot (it would investigate different code than
        // the reference); include_stale=true overrides but the caller surfaces a warning.
        if (gitStale && !includeStale) {
            resolution.excluded = true;
            if (referenceCommit) {
                // Same root HEAD but a differing submodule gitlink is the extended-fingerprint
                // case — name the submodule drift so the surface is not misleading.
                resolution.reason = headCommit && headCommit === referenceCommit
                    ? `git-stale: node HEAD ${headCommit} matches reference but submodule gitlink(s) differ from reference base`
                    : `git-stale: node HEAD ${headCommit ?? '(unknown)'} differs from reference ${referenceCommit}`;
            } else {
                resolution.reason = `git-stale: node reports drift from its upstream (behind/ahead) and no coordinator reference commit is known`;
            }
            slotResolutions.push(resolution);
            return;
        }

        totalRequested += count;
        const targetKey = targetNodeId ? `node:${targetNodeId}` : `tags:${[...requiredTags].sort().join(',')}`;
        targetKeys.add(`${targetKey}|${provider}`);
        providerSet.add(provider);
        nodeTargetSet.add(targetKey);
        slotResolutions.push(resolution);
        for (let i = 0; i < count; i++) {
            replicas.push({ slotIndex, provider, targetNodeId, capabilityTags, requiredTags, ...(model ? { model } : {}) });
        }
    });

    // Clamp to the guard cap (drop the tail; the caller logs the drop).
    const droppedReplicas = Math.max(0, replicas.length - cap);
    const capped = droppedReplicas > 0 ? replicas.slice(0, cap) : replicas;

    const distinctProviders = providerSet.size;
    const distinctNodeTargets = nodeTargetSet.size;
    // enoughTargets / coupled are computed over INCLUDED targets only — i.e. AFTER the
    // health gate AND the git-stale exclusion (unhealthy/stale slots never add to
    // targetKeys) — so the ≥2-independent-target guard re-checks post-exclusion and never
    // silently degrades to N=1.
    const staleSlots = slotResolutions.filter(m => m.gitStale && m.excluded);
    const includedStaleSlots = slotResolutions.filter(m => m.gitStale && !m.excluded);
    return {
        replicas: capped,
        totalRequested,
        totalAfterCap: capped.length,
        droppedReplicas,
        distinctTargets: targetKeys.size,
        distinctProviders,
        distinctNodeTargets,
        enoughTargets: targetKeys.size >= MAGI_MIN_TARGETS,
        coupled: distinctProviders < 2 || distinctNodeTargets < 2,
        unavailableSlots,
        unhealthySlots,
        ...(referenceCommit ? { referenceCommit } : {}),
        slotResolutions,
        staleSlots,
        includedStaleSlots,
    };
}

/**
 * The commit the panel is resolved against for git-staleness: the coordinator node's
 * HEAD (the code the investigation question originates from). Members on a different
 * HEAD would investigate different code and are excluded by default. Undefined when the
 * coordinator node carries no git HEAD telemetry → staleness is simply not computed.
 */
export function resolveMagiReferenceCommit(ctx: MeshContext): string | undefined {
    const node = resolveCoordinatorNode(ctx);
    return nodeHeadCommit(node);
}

/**
 * The coordinator node's submodule-gitlink key, paired with the reference commit above
 * to form the base fingerprint (root HEAD + sorted submodule gitlinks). Undefined when
 * the coordinator carries no submodule telemetry → submodule drift is simply not diffed
 * (root-HEAD-only comparison, the pre-fingerprint behavior).
 */
export function resolveMagiReferenceSubmoduleKey(ctx: MeshContext): string | undefined {
    const node = resolveCoordinatorNode(ctx);
    return nodeSubmoduleKey(node);
}
