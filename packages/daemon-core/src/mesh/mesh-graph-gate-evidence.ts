/**
 * mesh-graph-gate-evidence — G4: convergence evidence for coordinator gates.
 *
 * Measured live 2026-08-24: of 7 gates stuck awaiting_coordinator for 3 days,
 * at least 2 refinery gates guarded work that had ALREADY landed on
 * origin/main days earlier — the coordinator finished the landing out-of-band
 * and never released the gate. The design forbids auto-release (elapsed time
 * and even external evidence never release a gate), so this module only
 * ATTACHES evidence at the moments a coordinator looks at a gate: "the
 * upstream commits are already reachable from origin/main — verify and
 * release with this evidence instead of re-running the action."
 *
 * Boundaries:
 *   - Never mutates gate/graph/queue state. Never inside a DB transaction —
 *     callers (the gate-claim MCP tool, the opt-in graph-view augmentation)
 *     run it after their own store reads complete.
 *   - No network: reachability is checked against the LOCAL origin/main ref
 *     (no fetch), which is exactly the honesty the evidence needs — a lagging
 *     local ref yields reachedMain:false, never a false positive.
 *   - Fail-soft everywhere: missing workspace, no commit artifacts, malformed
 *     envelopes, git errors, timeouts → partial or null evidence, never a
 *     throw into the caller.
 */
import { execFileSync } from 'node:child_process';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { getMesh } from '../config/mesh-config.js';
import type { MeshGraphGateRow } from './mesh-graph-types.js';
import { resolveRootDefaultBranch } from './mesh-onboarding-plan.js';

export interface GateCommitEvidence {
    sha: string;
    repo?: string;
    /** Source graph ref of the worker task whose envelope reported this commit. */
    fromRef?: string;
    /** true/false when git answered; 'unknown' on any git failure or timeout. */
    reachedMain: boolean | 'unknown';
}

export interface GateConvergenceEvidence {
    workspace: string;
    probedAt: string;
    /** Honesty marker: checked against local refs, no fetch was performed. */
    probedAgainst: string;
    commits: GateCommitEvidence[];
    /** true = every probed commit is reachable; null = no commits to probe. */
    allReachedMain: boolean | null;
    /** Present exactly when allReachedMain === true — the actionable hint. */
    hint?: string;
}

const GIT_PROBE_TIMEOUT_MS = 3_000;
/** Bounded work per gate: a gate rarely has more than a handful of upstream commits. */
const MAX_PROBE_COMMITS = 12;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

function isCommitReachable(workspace: string, sha: string, defaultBranch: string): boolean | 'unknown' {
    try {
        execFileSync('git', ['merge-base', '--is-ancestor', sha, `origin/${defaultBranch}`], {
            cwd: workspace,
            timeout: GIT_PROBE_TIMEOUT_MS,
            stdio: ['ignore', 'ignore', 'ignore'],
        });
        return true;
    } catch (e: any) {
        // Exit 1 is git's defined "not an ancestor" answer; everything else
        // (unknown sha, not a repo, timeout, missing origin/<defaultBranch>) is 'unknown'.
        return e && typeof e.status === 'number' && e.status === 1 ? false : 'unknown';
    }
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** The mesh's base workspace — where origin/main is meaningful for this repo. */
function resolveMeshBaseWorkspace(meshId: string): string | undefined {
    try {
        const mesh = getMesh(meshId) as { nodes?: Array<{ workspace?: unknown }> } | undefined;
        return readString(mesh?.nodes?.[0]?.workspace);
    } catch {
        return undefined;
    }
}

interface UpstreamCommitRef { sha: string; repo?: string; fromRef?: string; }

/**
 * Commits reported by the completion envelopes of the gate's upstream worker
 * nodes (edges into the gate's graph node → source worker nodes → latest
 * `mesh_task_outputs` version → `artifacts.commits[].sha`).
 */
function collectUpstreamCommits(gate: MeshGraphGateRow): UpstreamCommitRef[] {
    const graphStore = MeshRuntimeStore.getInstance().graphStore();
    const upstreamNodeIds = new Set(
        graphStore.listEdges(gate.graphId)
            // eslint-disable-next-line no-restricted-syntax -- GRAPH node UUIDs from the same graph store (mesh_task_graph_nodes.nodeId), single canonical form — not mesh machine/daemon ids
            .filter(edge => edge.toNodeId === gate.nodeId)
            .map(edge => edge.fromNodeId),
    );
    if (upstreamNodeIds.size === 0) return [];
    const commits: UpstreamCommitRef[] = [];
    const seen = new Set<string>();
    for (const node of graphStore.listNodes(gate.graphId)) {
        if (node.kind !== 'worker_task' || !upstreamNodeIds.has(node.nodeId) || !node.queueTaskId) continue;
        const output = graphStore.getLatestOutput(node.queueTaskId);
        if (!output) continue;
        let envelope: Record<string, unknown>;
        try {
            const parsed = JSON.parse(output.envelopeJson);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
            envelope = parsed as Record<string, unknown>;
        } catch { continue; }
        const artifacts = envelope.artifacts as { commits?: unknown } | undefined;
        const rawCommits = Array.isArray(artifacts?.commits) ? artifacts!.commits : [];
        for (const raw of rawCommits) {
            const sha = readString((raw as Record<string, unknown>)?.sha);
            if (!sha || !SHA_PATTERN.test(sha) || seen.has(sha.toLowerCase())) continue;
            seen.add(sha.toLowerCase());
            commits.push({
                sha,
                ...(readString((raw as Record<string, unknown>)?.repo) ? { repo: readString((raw as Record<string, unknown>)?.repo) } : {}),
                ...(node.ref ? { fromRef: node.ref } : {}),
            });
            if (commits.length >= MAX_PROBE_COMMITS) return commits;
        }
    }
    return commits;
}

/**
 * Build the convergence evidence for one gate, or null when nothing can be
 * said (unknown gate, no base workspace, no upstream commit artifacts).
 *
 * `defaultBranch` generalizes the previously hardcoded `origin/main`, via
 * {@link resolveRootDefaultBranch} — `mesh.defaultBranch` → local (no-fetch)
 * `origin/HEAD` symref → current checkout. On a `main`-default mesh this
 * resolves to `'main'` and the probe stays byte-identical to the prior
 * behavior.
 */
export async function collectGateConvergenceEvidence(meshId: string, gateId: string): Promise<GateConvergenceEvidence | null> {
    try {
        const graphStore = MeshRuntimeStore.getInstance().graphStore();
        const gate = graphStore.getGate(gateId);
        if (!gate || gate.meshId !== meshId) return null;
        const workspace = resolveMeshBaseWorkspace(meshId);
        if (!workspace) return null;
        const upstream = collectUpstreamCommits(gate);
        if (upstream.length === 0) return null;
        const mesh = getMesh(meshId) as { defaultBranch?: string } | undefined;
        const defaultBranch = await resolveRootDefaultBranch(workspace, mesh);
        const commits: GateCommitEvidence[] = upstream.map(ref => ({
            ...ref,
            reachedMain: isCommitReachable(workspace, ref.sha, defaultBranch),
        }));
        const allReachedMain = commits.every(c => c.reachedMain === true);
        return {
            workspace,
            probedAt: new Date().toISOString(),
            probedAgainst: `local origin/${defaultBranch} (no fetch)`,
            commits,
            allReachedMain,
            ...(allReachedMain
                ? {
                    hint: `Every upstream commit is already reachable from origin/${defaultBranch} — the guarded work `
                        + 'appears to have landed. Verify, then RELEASE this gate with these commits as evidence instead '
                        + 'of re-running the action. (Evidence never auto-releases a gate; the decision is yours.)',
                }
                : {}),
        };
    } catch {
        return null;
    }
}
