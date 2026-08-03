/**
 * Mesh Usage Store — per-mesh token/cost accounting for agent sessions.
 *
 * Storage: ~/.adhdev/mesh-usage/<meshId>.json
 * Format:  a single JSON object keyed by session id (NOT append-only JSONL)
 * Safety:  mode 0o600, atomic write via write-temp-then-rename
 *
 * ── Why a separate store and not the mesh ledger ────────────────────────────
 *
 * The obvious alternative was a new `MeshLedgerKind` on the existing ledger.
 * It was rejected on three counts, in order of weight:
 *
 *  1. RETENTION MISMATCH. The ledger is pruned at 30 days
 *     (LEDGER_JSONL_MAX_AGE_MS) and compacts to an archive under size
 *     pressure. Usage is cost data: "what did last quarter cost" is the whole
 *     point, and silently losing it on day 31 makes the feature a lie. The
 *     ledger's retention is correct for the ledger and wrong for usage.
 *
 *  2. LEDGER DILUTION. This mesh's ledger already exceeds 150k entries. Usage
 *     observations arrive per assistant turn — the highest-frequency event in
 *     the system, higher than any existing ledger kind. Appending them would
 *     accelerate rotation and push genuine task-lifecycle entries out of the
 *     retention window faster, degrading recovery and audit, which is what the
 *     ledger exists for.
 *
 *  3. SEMANTICS. Ledger entries are immutable historical facts ("this
 *     happened"). A session's usage is a mutable running total that is
 *     RE-DERIVED from the transcript on every read — the same session read
 *     twice yields one fact, not two. Append-only is the wrong shape for it;
 *     keyed upsert is the right one.
 *
 * ── Bounded growth ──────────────────────────────────────────────────────────
 *
 * The store is keyed by session id and upserted, so re-reading a live session
 * a thousand times overwrites one entry rather than appending a thousand. Size
 * is therefore O(sessions), not O(turns) — the property the ledger cannot
 * offer. Two further bounds cap it:
 *
 *   - MAX_SESSIONS_PER_MESH entries per mesh; on overflow the oldest by
 *     `lastUsageAt` are evicted, and their totals are folded into a
 *     `evicted` rollup so the mesh total stays correct even after eviction.
 *   - Sessions untouched for USAGE_MAX_AGE_MS are dropped on write, likewise
 *     folded into the rollup rather than discarded.
 *
 * The rollup means the mesh-level number never silently shrinks: detail is
 * lost on eviction, but the total is preserved.
 *
 * OSS code (AGPL-3.0). Must not import from packages/ (proprietary).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getConfigDir } from '../config/config.js';
import {
    sumSessionUsage,
    type NativeUsage,
    type SessionUsageTotals,
} from '../providers/native-history/usage-normalize.js';

const USAGE_DIR_NAME = 'mesh-usage';

/** Per-mesh session cap before oldest-first eviction into the rollup. */
export const MAX_SESSIONS_PER_MESH = 2000;

/** Sessions with no usage newer than this are folded into the rollup. */
export const USAGE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000; // 180 days

/** One session's usage plus the mesh provenance needed to aggregate it. */
export interface MeshSessionUsage extends SessionUsageTotals {
    /** Mesh node this session ran on, when known. */
    nodeId?: string;
    /** Mesh task this session was serving, when known. */
    taskId?: string;
    /** Epoch ms this record was last written. */
    updatedAt: number;
}

/** Totals folded in from evicted/expired sessions, so the mesh total survives. */
export interface EvictedUsageRollup extends NativeUsage {
    sessionCount: number;
    lastEvictedAt: number;
}

interface MeshUsageFile {
    version: 1;
    meshId: string;
    sessions: Record<string, MeshSessionUsage>;
    evicted?: EvictedUsageRollup;
}

const ZERO_ROLLUP: EvictedUsageRollup = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    sessionCount: 0,
    lastEvictedAt: 0,
};

export function getUsageDir(): string {
    const dir = join(getConfigDir(), USAGE_DIR_NAME);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
}

function getUsagePath(meshId: string): string {
    // Same sanitization the ledger uses — meshId reaches the filesystem, so a
    // traversal sequence must not survive into the path.
    const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(getUsageDir(), `${safe}.json`);
}

function emptyFile(meshId: string): MeshUsageFile {
    return { version: 1, meshId, sessions: {} };
}

function readUsageFile(meshId: string): MeshUsageFile {
    const path = getUsagePath(meshId);
    if (!existsSync(path)) return emptyFile(meshId);
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as MeshUsageFile;
        if (!parsed || typeof parsed !== 'object' || !parsed.sessions) return emptyFile(meshId);
        return parsed;
    } catch {
        // A truncated/corrupt file must not take the caller down; usage is
        // derived data and rebuilds from the transcripts on the next read.
        return emptyFile(meshId);
    }
}

function writeUsageFile(meshId: string, file: MeshUsageFile): void {
    const path = getUsagePath(meshId);
    const tmp = `${path}.tmp`;
    // Write-then-rename: a crash mid-write leaves the previous good file intact
    // rather than a half-written one that would parse as empty and lose totals.
    writeFileSync(tmp, JSON.stringify(file), { encoding: 'utf-8', mode: 0o600 });
    try {
        renameSync(tmp, path);
    } catch (e) {
        try { unlinkSync(tmp); } catch { /* best-effort */ }
        throw e;
    }
}

function foldIntoRollup(rollup: EvictedUsageRollup, entry: MeshSessionUsage): void {
    rollup.inputTokens += entry.inputTokens;
    rollup.outputTokens += entry.outputTokens;
    rollup.cacheReadTokens += entry.cacheReadTokens;
    rollup.cacheCreationTokens += entry.cacheCreationTokens;
    if (entry.reasoningTokens) {
        rollup.reasoningTokens = (rollup.reasoningTokens ?? 0) + entry.reasoningTokens;
    }
    if (entry.costUsd !== undefined) {
        rollup.costUsd = (rollup.costUsd ?? 0) + entry.costUsd;
    }
    rollup.sessionCount += 1;
    rollup.lastEvictedAt = Math.max(rollup.lastEvictedAt, entry.updatedAt);
}

/**
 * Apply the age and count bounds, folding everything dropped into the rollup.
 * Runs on every write so the file can never grow without limit.
 */
function enforceBounds(file: MeshUsageFile, now: number): void {
    const rollup: EvictedUsageRollup = file.evicted
        ? { ...ZERO_ROLLUP, ...file.evicted }
        : { ...ZERO_ROLLUP };
    let changed = false;

    for (const [sessionId, entry] of Object.entries(file.sessions)) {
        const age = now - (entry.lastUsageAt || entry.updatedAt || 0);
        if (age > USAGE_MAX_AGE_MS) {
            foldIntoRollup(rollup, entry);
            delete file.sessions[sessionId];
            changed = true;
        }
    }

    const ids = Object.keys(file.sessions);
    if (ids.length > MAX_SESSIONS_PER_MESH) {
        // Evict oldest-first by last observed usage, so the live sessions a
        // coordinator is actually watching are the ones that survive.
        const ordered = ids
            .map((id) => ({ id, at: file.sessions[id].lastUsageAt || file.sessions[id].updatedAt || 0 }))
            .sort((a, b) => a.at - b.at);
        const dropCount = ids.length - MAX_SESSIONS_PER_MESH;
        for (let i = 0; i < dropCount; i += 1) {
            const { id } = ordered[i];
            foldIntoRollup(rollup, file.sessions[id]);
            delete file.sessions[id];
            changed = true;
        }
    }

    if (changed || file.evicted) file.evicted = rollup;
}

/**
 * Upsert one session's usage totals for a mesh.
 *
 * Keyed by `providerSessionId`, so repeatedly recording a live session's
 * growing totals replaces the entry rather than accumulating rows. Returns the
 * stored record.
 */
export function recordSessionUsage(
    meshId: string,
    usage: SessionUsageTotals,
    context?: { nodeId?: string; taskId?: string },
    now: number = Date.now(),
): MeshSessionUsage {
    const file = readUsageFile(meshId);
    const entry: MeshSessionUsage = {
        ...usage,
        ...(context?.nodeId ? { nodeId: context.nodeId } : {}),
        ...(context?.taskId ? { taskId: context.taskId } : {}),
        updatedAt: now,
    };
    file.sessions[usage.providerSessionId] = entry;
    enforceBounds(file, now);
    writeUsageFile(meshId, file);
    return entry;
}

/** All retained per-session usage records for a mesh, newest usage first. */
export function readSessionUsage(meshId: string): MeshSessionUsage[] {
    const file = readUsageFile(meshId);
    return Object.values(file.sessions).sort(
        (a, b) => (b.lastUsageAt || b.updatedAt || 0) - (a.lastUsageAt || a.updatedAt || 0),
    );
}

/** Aggregate view of one mesh's usage. */
export interface MeshUsageSummary {
    meshId: string;
    /** Mesh-wide totals: retained sessions PLUS the evicted rollup. */
    total: NativeUsage;
    /** Retained sessions only, so callers can tell detail from rollup. */
    retained: NativeUsage & { sessionCount: number };
    /** Totals from sessions aged/evicted out; undefined when none. */
    evicted?: EvictedUsageRollup;
    /** Per-node breakdown over retained sessions. */
    byNode: Array<NativeUsage & { nodeId: string; sessionCount: number }>;
    /**
     * How many retained sessions carried a provider-reported cost. A mesh total
     * built from partial coverage under-reports, and callers must be able to
     * say so rather than presenting it as complete.
     */
    costCoverage: { withCost: number; total: number };
}

/**
 * Summarize a mesh's usage: overall totals, the retained/evicted split, and a
 * per-node breakdown.
 *
 * The evicted rollup is added into `total` so the headline number stays correct
 * across eviction, while `retained` exposes only what still has per-session
 * detail behind it.
 */
export function summarizeMeshUsage(meshId: string): MeshUsageSummary {
    const file = readUsageFile(meshId);
    const sessions = Object.values(file.sessions);
    const retained = sumSessionUsage(sessions);

    const total: NativeUsage = {
        inputTokens: retained.inputTokens,
        outputTokens: retained.outputTokens,
        cacheReadTokens: retained.cacheReadTokens,
        cacheCreationTokens: retained.cacheCreationTokens,
        ...(retained.reasoningTokens !== undefined ? { reasoningTokens: retained.reasoningTokens } : {}),
        ...(retained.costUsd !== undefined ? { costUsd: retained.costUsd } : {}),
    };
    if (file.evicted) {
        total.inputTokens += file.evicted.inputTokens;
        total.outputTokens += file.evicted.outputTokens;
        total.cacheReadTokens += file.evicted.cacheReadTokens;
        total.cacheCreationTokens += file.evicted.cacheCreationTokens;
        if (file.evicted.reasoningTokens) {
            total.reasoningTokens = (total.reasoningTokens ?? 0) + file.evicted.reasoningTokens;
        }
        if (file.evicted.costUsd !== undefined) {
            total.costUsd = (total.costUsd ?? 0) + file.evicted.costUsd;
        }
    }

    const nodeBuckets = new Map<string, SessionUsageTotals[]>();
    for (const entry of sessions) {
        const nodeId = entry.nodeId || 'unassigned';
        const bucket = nodeBuckets.get(nodeId);
        if (bucket) bucket.push(entry);
        else nodeBuckets.set(nodeId, [entry]);
    }
    const byNode = Array.from(nodeBuckets.entries()).map(([nodeId, entries]) => {
        const sum = sumSessionUsage(entries);
        return {
            nodeId,
            inputTokens: sum.inputTokens,
            outputTokens: sum.outputTokens,
            cacheReadTokens: sum.cacheReadTokens,
            cacheCreationTokens: sum.cacheCreationTokens,
            ...(sum.reasoningTokens !== undefined ? { reasoningTokens: sum.reasoningTokens } : {}),
            ...(sum.costUsd !== undefined ? { costUsd: sum.costUsd } : {}),
            sessionCount: sum.sessionCount,
        };
    }).sort((a, b) => b.outputTokens - a.outputTokens);

    return {
        meshId,
        total,
        retained: {
            inputTokens: retained.inputTokens,
            outputTokens: retained.outputTokens,
            cacheReadTokens: retained.cacheReadTokens,
            cacheCreationTokens: retained.cacheCreationTokens,
            ...(retained.reasoningTokens !== undefined ? { reasoningTokens: retained.reasoningTokens } : {}),
            ...(retained.costUsd !== undefined ? { costUsd: retained.costUsd } : {}),
            sessionCount: retained.sessionCount,
        },
        ...(file.evicted ? { evicted: file.evicted } : {}),
        byNode,
        costCoverage: retained.costCoverage,
    };
}
