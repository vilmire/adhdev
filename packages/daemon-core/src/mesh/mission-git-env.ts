/**
 * Builds the evaluation environment for a mesh's mission refs
 * (design 2026-11-01-mission-git-refs §3.1): which repositories on THIS machine to open
 * first (decision G1: the host evaluates itself), and which member daemons to ask when
 * none of them can answer.
 */
import { withMeshDirectDispatch } from '../commands/command-args.js';
import { existsSync } from 'node:fs';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import type { MissionRefEvalEnv, RefProbeEntry, RefProbeResult, RemoteRefProber } from './mission-ref-evaluator.js';

const PROBE_TIMEOUT_MS = 20_000;

export type MeshCommandDispatcher = (daemonId: string, cmd: string, args: Record<string, unknown>) => Promise<unknown>;

interface NodeLike {
    id?: string;
    daemonId?: string;
    workspace?: string;
    repoRoot?: string;
    worktreeBranch?: string;
    status?: string;
}

function nodesOf(mesh: unknown): NodeLike[] {
    const nodes = (mesh as { nodes?: unknown } | null | undefined)?.nodes;
    return Array.isArray(nodes) ? nodes.filter((n): n is NodeLike => !!n && typeof n === 'object' && (n as NodeLike).status !== 'removed') : [];
}

const isLocal = (node: NodeLike, selfDaemonId: string | undefined): boolean =>
    !node.daemonId || !selfDaemonId || daemonIdsEquivalent(node.daemonId, selfDaemonId);

/** Repositories of this mesh's local nodes: base checkouts before worktrees, deduplicated, existing only. */
export function localRepoDirsOfMesh(mesh: unknown, selfDaemonId: string | undefined): string[] {
    const nodes = nodesOf(mesh).filter(n => isLocal(n, selfDaemonId));
    const ordered = [...nodes.filter(n => !n.worktreeBranch), ...nodes.filter(n => !!n.worktreeBranch)];
    const out: string[] = [];
    for (const n of ordered) {
        for (const dir of [n.repoRoot, n.workspace]) {
            if (typeof dir === 'string' && dir && !out.includes(dir) && existsSync(dir)) out.push(dir);
        }
    }
    return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), ms);
        p.then(v => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
    });
}

function toRemoteProber(mesh: unknown, meshId: string, selfDaemonId: string | undefined, dispatch: MeshCommandDispatcher, rosterEvidence: Record<string, unknown>): RemoteRefProber | undefined {
    const seen = new Set<string>();
    const nodes: Array<{ nodeId: string; daemonId: string }> = [];
    for (const n of nodesOf(mesh)) {
        if (isLocal(n, selfDaemonId) || !n.daemonId || seen.has(n.daemonId)) continue;
        seen.add(n.daemonId);
        nodes.push({ nodeId: n.id ?? n.daemonId, daemonId: n.daemonId });
    }
    if (nodes.length === 0) return undefined;
    return {
        nodes,
        async probe(daemonId: string, req: { entries: RefProbeEntry[]; baseBranch: string }): Promise<RefProbeResult[] | null> {
            const raw = await withTimeout(
                dispatch(daemonId, 'mesh_ref_containment_probe', withMeshDirectDispatch({ ...rosterEvidence, meshId, entries: req.entries, baseBranch: req.baseBranch })),
                PROBE_TIMEOUT_MS,
            );
            const { findMeshRelayAnswer } = await import('../commands/mesh-relay-result.js');
            const answer = findMeshRelayAnswer(raw);
            if (!answer || answer.success !== true || !Array.isArray(answer.results)) return null;
            return answer.results as RefProbeResult[];
        },
    };
}

export function buildMissionRefEvalEnv(input: {
    meshId: string;
    mesh: unknown;
    selfDaemonId?: string;
    /** Relay to member daemons; absent → host-local evaluation only. */
    dispatch?: MeshCommandDispatcher;
    /** Roster evidence for the receiving daemon (`rosterEvidenceExtra`). */
    rosterEvidence?: Record<string, unknown>;
    fetch?: boolean;
}): MissionRefEvalEnv {
    const mesh = input.mesh as { defaultBranch?: unknown } | null | undefined;
    const defaultBranch = typeof mesh?.defaultBranch === 'string' && mesh.defaultBranch.trim() ? mesh.defaultBranch.trim() : 'main';
    const remote = input.dispatch ? toRemoteProber(input.mesh, input.meshId, input.selfDaemonId, input.dispatch, input.rosterEvidence ?? {}) : undefined;
    return {
        defaultBranch,
        localRepos: localRepoDirsOfMesh(input.mesh, input.selfDaemonId),
        ...(remote ? { remote } : {}),
        ...(input.fetch ? { fetch: true } : {}),
    };
}
