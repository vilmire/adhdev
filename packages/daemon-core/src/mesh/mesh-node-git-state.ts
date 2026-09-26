/**
 * Coordinator-held last-known git state per mesh node.
 *
 * The coordinator daemon is the ONE place a dashboard reads mesh topology from,
 * so it must always hold every node's latest git/submodule state and answer a
 * `mesh_status` from it instantly — never by waiting on a live P2P probe to a
 * remote machine while the dashboard's 30s command deadline runs out.
 *
 * Inputs (all write here, never the request path):
 *   - `member_push`       — a member daemon pushes its own git state on change and
 *                            on a heartbeat (`mesh_node_git_report`,
 *                            mesh-node-state-pusher.ts on the member side).
 *   - `coordinator_probe` — the coordinator's own background freshness probe
 *                            (mesh-node-git-refresher.ts), only when a node's
 *                            observation is older than the stale threshold.
 *
 * Persistence: a table in the EXISTING mesh-runtime.db (MeshRuntimeStore), so a
 * coordinator restart still answers with the last-known state (marked with its
 * age) instead of an empty graph. Not meshes.json (config — per-minute git writes
 * would churn it and its write lock) and not a seqscribe topic (fleet.status is an
 * allow-listed counters-only ring; mesh.<id>.events is a metadata-class log a
 * cloud peer may hold — branch names / commit subjects must not enter either).
 * This data never leaves the daemons: mesh_status travels over P2P only, and the
 * status_report allow-list (RoutingSessionEntry) does not carry it.
 */
import type { Database as DatabaseHandle } from 'better-sqlite3';
import { LOG } from '../logging/logger.js';
import {
    computeMeshNodeFactsSignature,
    computeMeshNodeRuntimeSignature,
    sanitizeMeshNodeRuntimeSummary,
    type MeshNodeRuntimeSummary,
} from './mesh-node-runtime-summary.js';

export type MeshNodeGitObservationSource = 'member_push' | 'coordinator_probe';

export interface MeshNodeGitStateEntry {
    meshId: string;
    nodeId: string;
    workspace: string;
    /** Last observed git status (reporter* envelope keys stripped). */
    git: Record<string, unknown> | null;
    /** Epoch ms the observation was made on the node (or received, when the node did not say). */
    observedAt: number | null;
    source: MeshNodeGitObservationSource | null;
    /** Content signature of `git` — changes only when something a viewer can see changed. */
    signature: string | null;
    /** Epoch ms the coordinator last started a background probe for this node. */
    lastAttemptAt: number | null;
    /** Set on the first failed refresh after a success; cleared by the next observation. */
    unreachableSince: number | null;
    lastFailureAt: number | null;
    lastFailureReason: string | null;
    /**
     * Content-free runtime summary (sessions / build / upgrade marker / facts incl.
     * quota — mesh-node-runtime-summary.ts), held beside the git state so
     * mesh_status answers it without a per-daemon get_status_metadata call.
     */
    runtime: MeshNodeRuntimeSummary | null;
    runtimeObservedAt: number | null;
    runtimeSource: MeshNodeGitObservationSource | null;
    runtimeSignature: string | null;
    /** Epoch ms the coordinator last started a background runtime probe (not persisted). */
    runtimeLastAttemptAt: number | null;
    /** Epoch ms of the last failed background runtime probe (not persisted). */
    runtimeLastFailureAt: number | null;
}

export interface MeshNodeGitStatePersistence {
    load(meshId: string): MeshNodeGitStateEntry[];
    save(entry: MeshNodeGitStateEntry): void;
}

const SIGNATURE_GIT_KEYS = [
    'isGitRepo', 'branch', 'headCommit', 'upstream', 'upstreamStatus', 'ahead', 'behind',
    'staged', 'modified', 'untracked', 'deleted', 'renamed', 'hasConflicts', 'stashCount', 'error',
] as const;

function readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Drop the member's reporter* envelope keys (platform / versions / facts ride the
 * probe envelope and are persisted separately by the probe path) so the stored
 * snapshot is the git status shape only.
 */
export function sanitizeObservedGit(git: unknown): Record<string, unknown> | null {
    const record = readRecord(git);
    if (!record) return null;
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
        if (key.startsWith('reporter')) continue;
        next[key] = value;
    }
    return next;
}

/** Stable content signature of a git snapshot (ignores check timestamps). */
export function computeMeshNodeGitSignature(git: Record<string, unknown> | null | undefined): string {
    const record = readRecord(git);
    if (!record) return 'none';
    const head: Record<string, unknown> = {};
    for (const key of SIGNATURE_GIT_KEYS) head[key] = record[key] ?? null;
    const submodules = Array.isArray(record.submodules)
        ? record.submodules.map((entry) => {
            const sub = readRecord(entry) ?? {};
            return [sub.path ?? null, sub.commit ?? null, sub.dirty ?? null, sub.outOfSync ?? null, sub.error ?? null];
        })
        : [];
    return JSON.stringify([head, submodules]);
}

/**
 * A pushed/probed snapshot read WITHOUT an upstream fetch reports
 * `upstreamStatus: 'unchecked'` even though the remote-tracking ref was fetched
 * minutes ago. Read raw, that flips a clean `main` to blocked_review
 * (default_branch_upstream_unverified) between upstream refreshes, and churns
 * the signature fresh↔unchecked. Carry the previous verified freshness forward
 * while it is recent and names the same upstream; ahead/behind in `next` are
 * already computed against that same local tracking ref.
 */
export const UPSTREAM_FRESHNESS_CARRY_MAX_AGE_MS = 10 * 60_000;

export function carryUpstreamFreshness(
    prev: Record<string, unknown> | null | undefined,
    next: Record<string, unknown>,
    now: number,
    maxAgeMs: number = UPSTREAM_FRESHNESS_CARRY_MAX_AGE_MS,
): Record<string, unknown> {
    if (next.upstreamStatus !== 'unchecked' || !prev || !next.upstream) return next;
    if (prev.upstream !== next.upstream) return next;
    if (prev.upstreamStatus !== 'fresh' && prev.upstreamStatus !== 'stale') return next;
    const fetchedAt = typeof prev.upstreamFetchedAt === 'number' ? prev.upstreamFetchedAt : null;
    if (fetchedAt === null || now - fetchedAt > maxAgeMs) return next;
    return {
        ...next,
        upstreamStatus: prev.upstreamStatus,
        upstreamFetchedAt: fetchedAt,
        ...(prev.upstreamStatus === 'stale' && typeof prev.upstreamFetchError === 'string' ? { upstreamFetchError: prev.upstreamFetchError } : {}),
    };
}

function emptyEntry(meshId: string, nodeId: string, workspace: string): MeshNodeGitStateEntry {
    return {
        meshId,
        nodeId,
        workspace,
        git: null,
        observedAt: null,
        source: null,
        signature: null,
        lastAttemptAt: null,
        unreachableSince: null,
        lastFailureAt: null,
        lastFailureReason: null,
        runtime: null,
        runtimeObservedAt: null,
        runtimeSource: null,
        runtimeSignature: null,
        runtimeLastAttemptAt: null,
        runtimeLastFailureAt: null,
    };
}

export class MeshNodeGitStateStore {
    private readonly entries = new Map<string, MeshNodeGitStateEntry>();
    private readonly loadedMeshes = new Set<string>();

    constructor(
        private readonly persistence: MeshNodeGitStatePersistence | null = null,
        private readonly now: () => number = Date.now,
    ) {}

    private key(meshId: string, nodeId: string): string {
        return `${meshId}\u0000${nodeId}`;
    }

    private ensureLoaded(meshId: string): void {
        if (this.loadedMeshes.has(meshId)) return;
        this.loadedMeshes.add(meshId);
        if (!this.persistence) return;
        try {
            for (const entry of this.persistence.load(meshId)) {
                const key = this.key(entry.meshId, entry.nodeId);
                if (!this.entries.has(key)) this.entries.set(key, entry);
            }
        } catch (error: any) {
            LOG.warn('MeshNodeGitState', `load failed for mesh ${meshId}: ${error?.message || error}`);
        }
    }

    private persist(entry: MeshNodeGitStateEntry): void {
        if (!this.persistence) return;
        try {
            this.persistence.save(entry);
        } catch (error: any) {
            LOG.warn('MeshNodeGitState', `save failed for ${entry.meshId}/${entry.nodeId}: ${error?.message || error}`);
        }
    }

    get(meshId: string, nodeId: string): MeshNodeGitStateEntry | undefined {
        if (!meshId || !nodeId) return undefined;
        this.ensureLoaded(meshId);
        return this.entries.get(this.key(meshId, nodeId));
    }

    private upsertBase(meshId: string, nodeId: string, workspace: string): MeshNodeGitStateEntry {
        this.ensureLoaded(meshId);
        const key = this.key(meshId, nodeId);
        let entry = this.entries.get(key);
        if (!entry) {
            entry = emptyEntry(meshId, nodeId, workspace);
            this.entries.set(key, entry);
        }
        if (workspace) entry.workspace = workspace;
        return entry;
    }

    /**
     * Record an observed git state. Returns `changed` when the visible content
     * differs from what was held (or the node recovered from unreachable) —
     * callers push a mesh-state revision only then, so a heartbeat that merely
     * re-confirms the same state does not make every dashboard refetch.
     */
    recordObservation(args: {
        meshId: string;
        nodeId: string;
        workspace: string;
        git: unknown;
        source: MeshNodeGitObservationSource;
        observedAt?: number;
    }): { changed: boolean; entry: MeshNodeGitStateEntry | null } {
        const rawGit = sanitizeObservedGit(args.git);
        if (!args.meshId || !args.nodeId || !rawGit) return { changed: false, entry: null };
        const entry = this.upsertBase(args.meshId, args.nodeId, args.workspace);
        // Older members push un-fetched reads ('unchecked'): keep the verified freshness.
        const git = carryUpstreamFreshness(entry.git, rawGit, this.now());
        const signature = computeMeshNodeGitSignature(git);
        const recovered = entry.unreachableSince !== null;
        const changed = signature !== entry.signature || recovered;
        const observedAt = typeof args.observedAt === 'number' && Number.isFinite(args.observedAt)
            ? Math.min(args.observedAt, this.now())
            : this.now();
        // Never let an older report (a delayed push racing a probe) roll the held state back.
        if (entry.observedAt !== null && observedAt < entry.observedAt && !recovered) {
            return { changed: false, entry };
        }
        entry.git = git;
        entry.observedAt = observedAt;
        entry.source = args.source;
        entry.signature = signature;
        entry.unreachableSince = null;
        entry.lastFailureAt = null;
        entry.lastFailureReason = null;
        this.persist(entry);
        return { changed, entry };
    }

    recordProbeAttempt(meshId: string, nodeId: string, workspace: string, at: number = this.now()): void {
        if (!meshId || !nodeId) return;
        const entry = this.upsertBase(meshId, nodeId, workspace);
        entry.lastAttemptAt = at;
    }

    /** Returns `changed` when this failure is the transition into unreachable. */
    recordProbeFailure(meshId: string, nodeId: string, workspace: string, reason: string, at: number = this.now()): { changed: boolean } {
        if (!meshId || !nodeId) return { changed: false };
        const entry = this.upsertBase(meshId, nodeId, workspace);
        const changed = entry.unreachableSince === null;
        if (entry.unreachableSince === null) entry.unreachableSince = at;
        entry.lastFailureAt = at;
        entry.lastFailureReason = reason.slice(0, 200);
        this.persist(entry);
        return { changed };
    }

    /**
     * Record an observed runtime summary (member push or the coordinator's
     * background get_status_metadata probe). Re-sanitized here: the allow-list is
     * enforced at ingest, whatever the sender did. `changed` = visible content
     * changed; `factsChanged` = the facts bundle (quota / build) changed — the
     * part the dashboard renders, so only that publishes a mesh-state revision.
     */
    recordRuntimeObservation(args: {
        meshId: string;
        nodeId: string;
        workspace: string;
        runtime: unknown;
        source: MeshNodeGitObservationSource;
        observedAt?: number;
    }): { changed: boolean; factsChanged: boolean; entry: MeshNodeGitStateEntry | null } {
        const runtime = sanitizeMeshNodeRuntimeSummary(args.runtime);
        if (!args.meshId || !args.nodeId || !runtime) return { changed: false, factsChanged: false, entry: null };
        const entry = this.upsertBase(args.meshId, args.nodeId, args.workspace);
        const observedAt = typeof args.observedAt === 'number' && Number.isFinite(args.observedAt)
            ? Math.min(args.observedAt, this.now())
            : this.now();
        if (entry.runtimeObservedAt !== null && observedAt < entry.runtimeObservedAt) {
            return { changed: false, factsChanged: false, entry };
        }
        const signature = computeMeshNodeRuntimeSignature(runtime);
        const changed = signature !== entry.runtimeSignature;
        const factsChanged = computeMeshNodeFactsSignature(runtime) !== computeMeshNodeFactsSignature(entry.runtime);
        entry.runtime = runtime;
        entry.runtimeObservedAt = observedAt;
        entry.runtimeSource = args.source;
        entry.runtimeSignature = signature;
        entry.runtimeLastFailureAt = null;
        this.persist(entry);
        return { changed, factsChanged, entry };
    }

    recordRuntimeProbeAttempt(meshId: string, nodeId: string, workspace: string, at: number = this.now()): void {
        if (!meshId || !nodeId) return;
        this.upsertBase(meshId, nodeId, workspace).runtimeLastAttemptAt = at;
    }

    recordRuntimeProbeFailure(meshId: string, nodeId: string, workspace: string, at: number = this.now()): void {
        if (!meshId || !nodeId) return;
        this.upsertBase(meshId, nodeId, workspace).runtimeLastFailureAt = at;
    }

    /** Test/diagnostic helper. */
    size(): number {
        return this.entries.size;
    }
}

// ─── mesh-runtime.db persistence ─────────────────────────────────────────────

export function ensureMeshNodeGitStateSchema(db: DatabaseHandle): void {
    db.exec(`
        -- Coordinator-held last-known git state per mesh node (mesh-node-git-state.ts).
        -- One row per (mesh, node); REPLACEd on every observation / failure.
        CREATE TABLE IF NOT EXISTS mesh_node_git_state (
            mesh_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            workspace TEXT NOT NULL DEFAULT '',
            git_json TEXT,
            observed_at INTEGER,
            source TEXT,
            signature TEXT,
            unreachable_since INTEGER,
            last_failure_at INTEGER,
            last_failure_reason TEXT,
            runtime_json TEXT,
            runtime_observed_at INTEGER,
            runtime_source TEXT,
            runtime_signature TEXT,
            PRIMARY KEY (mesh_id, node_id)
        );
    `);
    // Runtime columns were added after the table shipped (git-only rows exist on
    // coordinators that ran the earlier build) — add them in place when missing.
    const columns = new Set((db.prepare('PRAGMA table_info(mesh_node_git_state)').all() as Array<{ name: string }>).map((c) => c.name));
    for (const [name, type] of [['runtime_json', 'TEXT'], ['runtime_observed_at', 'INTEGER'], ['runtime_source', 'TEXT'], ['runtime_signature', 'TEXT']] as const) {
        if (!columns.has(name)) db.exec(`ALTER TABLE mesh_node_git_state ADD COLUMN ${name} ${type}`);
    }
}

function readNullableNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function createDbMeshNodeGitStatePersistence(getDb: () => DatabaseHandle): MeshNodeGitStatePersistence {
    return {
        load(meshId) {
            const rows = getDb().prepare(
                'SELECT mesh_id, node_id, workspace, git_json, observed_at, source, signature, unreachable_since, last_failure_at, last_failure_reason, runtime_json, runtime_observed_at, runtime_source, runtime_signature FROM mesh_node_git_state WHERE mesh_id = ?',
            ).all(meshId) as Array<Record<string, unknown>>;
            return rows.map((row) => {
                let git: Record<string, unknown> | null = null;
                try { git = readRecord(JSON.parse(String(row.git_json ?? 'null'))); } catch { git = null; }
                const source = row.source === 'member_push' || row.source === 'coordinator_probe' ? row.source : null;
                let runtime: MeshNodeRuntimeSummary | null = null;
                try { runtime = sanitizeMeshNodeRuntimeSummary(JSON.parse(String(row.runtime_json ?? 'null'))); } catch { runtime = null; }
                const runtimeSource = row.runtime_source === 'member_push' || row.runtime_source === 'coordinator_probe' ? row.runtime_source : null;
                return {
                    meshId: String(row.mesh_id),
                    nodeId: String(row.node_id),
                    workspace: typeof row.workspace === 'string' ? row.workspace : '',
                    git,
                    observedAt: readNullableNumber(row.observed_at),
                    source,
                    signature: typeof row.signature === 'string' ? row.signature : (git ? computeMeshNodeGitSignature(git) : null),
                    lastAttemptAt: null,
                    unreachableSince: readNullableNumber(row.unreachable_since),
                    lastFailureAt: readNullableNumber(row.last_failure_at),
                    lastFailureReason: typeof row.last_failure_reason === 'string' ? row.last_failure_reason : null,
                    runtime,
                    runtimeObservedAt: runtime ? readNullableNumber(row.runtime_observed_at) : null,
                    runtimeSource: runtime ? runtimeSource : null,
                    runtimeSignature: runtime ? (typeof row.runtime_signature === 'string' ? row.runtime_signature : computeMeshNodeRuntimeSignature(runtime)) : null,
                    runtimeLastAttemptAt: null,
                    runtimeLastFailureAt: null,
                };
            });
        },
        save(entry) {
            getDb().prepare(`
                INSERT OR REPLACE INTO mesh_node_git_state
                    (mesh_id, node_id, workspace, git_json, observed_at, source, signature, unreachable_since, last_failure_at, last_failure_reason,
                     runtime_json, runtime_observed_at, runtime_source, runtime_signature)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                entry.meshId,
                entry.nodeId,
                entry.workspace || '',
                entry.git ? JSON.stringify(entry.git) : null,
                entry.observedAt,
                entry.source,
                entry.signature,
                entry.unreachableSince,
                entry.lastFailureAt,
                entry.lastFailureReason,
                entry.runtime ? JSON.stringify(entry.runtime) : null,
                entry.runtimeObservedAt,
                entry.runtimeSource,
                entry.runtimeSignature,
            );
        },
    };
}
