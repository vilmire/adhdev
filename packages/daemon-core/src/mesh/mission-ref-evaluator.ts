/**
 * Evaluate a mission's git refs against the mesh's default branch
 * (design 2026-11-01-mission-git-refs §3, §5).
 *
 * Refs are CLAIMS; the verdict comes only from git objects this daemon (or, as a
 * fallback, a member node) opened itself. Commit-message mission ids, branch-name
 * similarity, worker prose and PR numbers are never evidence.
 *
 * Where: the mesh host's own repositories first (decision G1), then member nodes via
 * `RemoteRefProber`. No fetch unless the caller asks (decision G2: after a Refinery
 * push or an explicit refresh).
 *
 * Invariant (enforced by test/mesh/mission-git-eval-readonly-shape.test.ts): this file
 * and mesh-mission-git-eval.ts import no mission/item WRITE API — a verdict is a
 * projection and never changes a mission's status, outcome or items. Row persistence
 * lives in mesh-mission-ref-evals-store.ts.
 */
import { containedRepoPath } from './mission-ref-input.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MissionItemRef, MissionRefGitEval, MissionRefGitMethod, MissionRefGitStatus, MissionRefGitDetail } from '@adhdev/mesh-shared';
import { GIT_NETWORK_TIMEOUT_MS } from '../git/git-locale.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { missionRefEvals } from './mesh-mission-ref-evals-store.js';
import {
    fetchDefaultBranch, probeCommitContainment, resolveBase, resolveBranchSha, type ContainmentVerdict, type ResolvedBase,
} from './mission-ref-containment.js';

/** Dedup'd refs evaluated per mission; the rest become `unknown:budget`. */
export const MAX_EVALUATED_REFS_PER_MISSION = 24;

/** Item kinds whose refs describe the work (decisions carry owner questions, not code). */
const EVALUATED_ITEM_KINDS = new Set(['remaining', 'evidence', 'live_check']);

export interface MissionRefTarget {
    itemId: string;
    refKey: string;
    kind: 'commit' | 'branch';
    value: string;
    repo?: string;
}

export interface RefProbeEntry {
    kind: 'commit' | 'branch';
    value: string;
    repo?: string;
    /** Branch refs: the SHA the caller already pinned (a branch tip is judged by this, never re-resolved). */
    pinned?: string;
}
export interface RefProbeResult extends ContainmentVerdictWire { value: string }
export interface ContainmentVerdictWire {
    sha?: string;
    status: MissionRefGitStatus;
    method?: MissionRefGitMethod;
    detail?: MissionRefGitDetail;
    baseRef?: string;
    baseSha?: string;
}

/** Asks member nodes (other daemons) whether THEY hold and have landed these refs. */
export interface RemoteRefProber {
    nodes: ReadonlyArray<{ nodeId: string; daemonId: string }>;
    /** `null` = unreachable / timed out / old daemon (never an answer). */
    probe(daemonId: string, req: { entries: RefProbeEntry[]; baseBranch: string }): Promise<RefProbeResult[] | null>;
}

export interface MissionRefEvalEnv {
    defaultBranch: string;
    /** Repository directories on THIS machine, most authoritative first. */
    localRepos: readonly string[];
    remote?: RemoteRefProber;
    /** `git fetch` the default branch in the local repos first (explicit refresh / after a Refinery push only). */
    fetch?: boolean;
    now?: () => number;
}

export function refKeyOf(ref: Pick<MissionItemRef, 'kind' | 'repo' | 'value'>): string {
    const value = ref.kind === 'commit' ? ref.value.trim().toLowerCase() : ref.value.trim();
    return `${ref.kind}:${(ref.repo ?? '').trim()}:${value}`;
}

/** Dedup'd commit/branch refs of a mission's work items. Order is stable (item order, ref order). */
export function collectMissionRefTargets(meshId: string, missionId: string): MissionRefTarget[] {
    const items = MeshRuntimeStore.getInstance().missionItems().listItems(meshId, missionId);
    const seen = new Set<string>();
    const out: MissionRefTarget[] = [];
    for (const item of items) {
        if (!EVALUATED_ITEM_KINDS.has(item.kind)) continue;
        for (const ref of item.refs) {
            if (ref.kind !== 'commit' && ref.kind !== 'branch') continue;
            // A SHA ref shorter than 7 chars is not a usable object name.
            if (ref.kind === 'commit' && !/^[0-9a-f]{7,64}$/i.test(ref.value.trim())) continue;
            const refKey = refKeyOf(ref);
            const dedupe = `${item.id}\u0000${refKey}`;
            if (seen.has(dedupe)) continue;
            seen.add(dedupe);
            out.push({ itemId: item.id, refKey, kind: ref.kind, value: ref.kind === 'commit' ? ref.value.trim().toLowerCase() : ref.value.trim(), ...(ref.repo ? { repo: ref.repo } : {}) });
        }
    }
    return out;
}

function repoCandidates(env: MissionRefEvalEnv, repo: string | undefined): string[] {
    if (!repo) return [...env.localRepos];
    // `repo` may come from a peer: it must stay inside one of this node's repos (see mission-ref-input.ts).
    const nested = env.localRepos.map(r => containedRepoPath(r, repo))
        .filter((p): p is string => !!p && (existsSync(join(p, '.git')) || existsSync(join(p, 'HEAD'))));
    return [...nested, ...env.localRepos];
}

function resolveBaseAny(repo: string, defaultBranch: string): ResolvedBase | undefined {
    for (const name of new Set([defaultBranch, 'main', 'master'])) {
        const b = resolveBase(repo, name);
        if (b) return b;
    }
    return undefined;
}

const UNKNOWN_RANK: Record<string, number> = { shallow: 4, undeterminable: 3, gitlink_undeterminable: 3, merge_tree_failed: 3, base_missing: 2, object_missing: 1 };
function moreInformative(a: MissionRefGitDetail | undefined, b: MissionRefGitDetail | undefined): boolean {
    return (UNKNOWN_RANK[String(b?.unknownReason)] ?? 0) > (UNKNOWN_RANK[String(a?.unknownReason)] ?? 0);
}

interface TargetOutcome {
    verdict: ContainmentVerdict;
    pinnedSha?: string;
    baseRef?: string;
    baseSha?: string;
}

async function evaluateTarget(target: MissionRefTarget, pinned: string | undefined, env: MissionRefEvalEnv): Promise<TargetOutcome> {
    const { defaultBranch } = env;
    if (target.kind === 'branch' && [defaultBranch, `origin/${defaultBranch}`, `refs/heads/${defaultBranch}`].includes(target.value)) {
        // The base branch itself is trivially "contained" and says nothing about the mission's work.
        return { verdict: { status: 'unknown', detail: { unknownReason: 'base_branch_ref' } } };
    }
    const repos = repoCandidates(env, target.repo);
    let pinnedSha = pinned;
    let best: TargetOutcome | undefined;
    let sawBase = false;

    for (const repo of repos) {
        const base = resolveBaseAny(repo, defaultBranch);
        if (!base) continue;
        sawBase = true;
        if (target.kind === 'branch' && !pinnedSha) {
            const sha = resolveBranchSha(repo, target.value);
            if (!sha) { best ??= { verdict: { status: 'unknown', detail: { unknownReason: 'branch_not_found' } }, baseRef: base.name, baseSha: base.sha }; continue; }
            pinnedSha = sha;
        }
        const rev = target.kind === 'branch' ? pinnedSha! : target.value;
        const v = await probeCommitContainment(repo, base, rev, { tryCherry: target.kind === 'commit' });
        if (v.status !== 'unknown') {
            const { sha: _sha, ...verdict } = v;
            return { verdict, pinnedSha, baseRef: base.name, baseSha: base.sha };
        }
        if (!best || best.verdict.detail?.unknownReason === 'branch_not_found' || moreInformative(best.verdict.detail, v.detail)) {
            best = { verdict: { status: 'unknown', detail: v.detail }, pinnedSha, baseRef: base.name, baseSha: base.sha };
        }
    }

    // The host holds no usable answer: ask the member nodes (decision G1 fallback).
    if (env.remote && env.remote.nodes.length > 0) {
        const entry: RefProbeEntry = { kind: target.kind, value: target.value, ...(pinnedSha ? { pinned: pinnedSha } : {}), ...(target.repo ? { repo: target.repo } : {}) };
        let offline = 0;
        for (const node of env.remote.nodes) {
            const res = await env.remote.probe(node.daemonId, { entries: [entry], baseBranch: defaultBranch }).catch(() => null);
            if (!res) { offline++; continue; }
            const r = res[0];
            if (r && r.status !== 'unknown') {
                return {
                    verdict: { status: r.status, ...(r.method ? { method: r.method } : {}), detail: { ...(r.detail ?? {}), nodeId: node.nodeId } },
                    pinnedSha: pinnedSha ?? r.sha,
                    baseRef: r.baseRef ?? best?.baseRef,
                    baseSha: r.baseSha ?? best?.baseSha,
                };
            }
            if (r && !pinnedSha && target.kind === 'branch' && r.sha) pinnedSha = r.sha;
        }
        if (offline === env.remote.nodes.length && (!best || best.verdict.detail?.unknownReason === 'object_missing')) {
            return { verdict: { status: 'unknown', detail: { unknownReason: 'node_offline' } }, pinnedSha, baseRef: best?.baseRef, baseSha: best?.baseSha };
        }
    }

    if (best) return { ...best, pinnedSha: pinnedSha ?? best.pinnedSha };
    return { verdict: { status: 'unknown', detail: { unknownReason: sawBase || repos.length > 0 ? 'base_missing' : 'no_repo' } }, pinnedSha };
}

/**
 * The member-node side of the fallback: judge `entries` against THIS machine's repositories
 * only (no further relay, no persistence). Answers `mesh_ref_containment_probe`.
 */
export async function probeRefsLocally(entries: readonly RefProbeEntry[], env: Pick<MissionRefEvalEnv, 'defaultBranch' | 'localRepos'>): Promise<RefProbeResult[]> {
    const out: RefProbeResult[] = [];
    for (const [i, e] of entries.slice(0, MAX_EVALUATED_REFS_PER_MISSION).entries()) {
        const target: MissionRefTarget = { itemId: `probe-${i}`, refKey: refKeyOf(e), kind: e.kind, value: e.value, ...(e.repo ? { repo: e.repo } : {}) };
        const o = await evaluateTarget(target, e.pinned, { defaultBranch: env.defaultBranch, localRepos: env.localRepos });
        out.push({
            value: e.value,
            ...(o.pinnedSha ? { sha: o.pinnedSha } : {}),
            status: o.verdict.status,
            ...(o.verdict.method ? { method: o.verdict.method } : {}),
            ...(o.verdict.detail ? { detail: o.verdict.detail } : {}),
            ...(o.baseRef ? { baseRef: o.baseRef } : {}),
            ...(o.baseSha ? { baseSha: o.baseSha } : {}),
        });
    }
    return out;
}

/**
 * Evaluate and persist every commit/branch ref of one mission. Returns the stored rows.
 * Reads the mission's items; writes only `mesh_mission_ref_evals`.
 */
export async function evaluateMissionRefs(meshId: string, missionId: string, env: MissionRefEvalEnv): Promise<MissionRefGitEval[]> {
    const now = env.now ?? Date.now;
    const store = missionRefEvals();
    const targets = collectMissionRefTargets(meshId, missionId);
    const existing = new Map(store.list(meshId, missionId).map(e => [`${e.itemId}\u0000${e.refKey}`, e]));

    if (env.fetch) {
        for (const repo of new Set(env.localRepos)) fetchDefaultBranch(repo, env.defaultBranch, GIT_NETWORK_TIMEOUT_MS);
    }

    const keep = new Set<string>();
    const fallbackBaseRef = `origin/${env.defaultBranch}`;
    for (const [index, target] of targets.entries()) {
        // The git probes are synchronous child processes: let the daemon's event loop breathe between refs.
        await new Promise<void>(resolve => setImmediate(resolve));
        keep.add(`${target.itemId}\u0000${target.refKey}`);
        const prior = existing.get(`${target.itemId}\u0000${target.refKey}`);
        const outcome: TargetOutcome = index >= MAX_EVALUATED_REFS_PER_MISSION
            ? { verdict: { status: 'unknown', detail: { unknownReason: 'budget' } } }
            : await evaluateTarget(target, prior?.pinnedSha, env);
        store.upsert(meshId, missionId, {
            itemId: target.itemId,
            refKey: target.refKey,
            kind: target.kind,
            value: target.value,
            ...(target.repo ? { repo: target.repo } : {}),
            ...(outcome.pinnedSha ? { pinnedSha: outcome.pinnedSha } : {}),
            baseRef: outcome.baseRef ?? prior?.baseRef ?? fallbackBaseRef,
            ...(outcome.baseSha ? { baseSha: outcome.baseSha } : {}),
            status: outcome.verdict.status,
            ...(outcome.verdict.method ? { method: outcome.verdict.method } : {}),
            ...(outcome.verdict.detail ? { detail: outcome.verdict.detail } : {}),
            evaluatedAt: new Date(now()).toISOString(),
        });
    }
    store.deleteStale(meshId, missionId, keep);
    return store.list(meshId, missionId);
}
