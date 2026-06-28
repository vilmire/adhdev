// MAGI (Multi-Agent Ground-truth Insight) activity reconstruction for mesh_status.
//
// MAGI cross-verification runs are persisted in the mesh ledger as `magi_dispatched`
// (fan-out enqueued) and `magi_synthesis` (collected + synthesized) entries, keyed by
// consensusGroupId. This module reconstructs the latest per-group activity from a
// ledger window and folds it into a BOUNDED mesh_status section so a coordinator (and
// the web dashboard's extractMagiActivity) can read the synthesis fields — the
// needs_verification counts, independence banner, and git skew — without re-running
// collection. Mirrors mesh-refine-status.ts (buildMeshAsyncRefineJobs / summarize…).
//
// Pure: operates on a ledger-entry array. No I/O, no Node/DOM APIs.

import type { MeshLedgerEntry } from './mesh-ledger.js';
import type { MagiGitSkew } from '@adhdev/mesh-shared';

export type MeshMagiActivityStatus = 'running' | 'synthesized';

/** A bounded needs_verification preview item (claim text + category only). */
export interface MeshMagiNeedsVerificationItem {
    claim: string;
    category: string;
}

export interface MeshMagiActivitySummary {
    consensusGroupId: string;
    status: MeshMagiActivityStatus;
    missionId?: string;
    panel?: string;
    question?: string;
    replicaCount?: number;
    answered?: number;
    missing?: number;
    staleReplicas?: number;
    needsVerificationCount?: number;
    agreedCount?: number;
    independenceBanner?: string | null;
    gitSkew?: MagiGitSkew;
    /** Bounded sample of the needs_verification clusters (claim + category). */
    needsVerification?: MeshMagiNeedsVerificationItem[];
    openQuestions?: string[];
    lastLedgerKind?: string;
    lastUpdatedAt?: string;
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function readNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Cap on inlined needs_verification preview items per group (keeps the payload bounded). */
export const MAGI_NEEDS_VERIFICATION_PREVIEW_CAP = 8;

function summarizeNeedsVerification(synthesis: Record<string, unknown> | undefined): MeshMagiNeedsVerificationItem[] | undefined {
    const list = Array.isArray(synthesis?.needsVerification) ? synthesis!.needsVerification : undefined;
    if (!list) return undefined;
    const items: MeshMagiNeedsVerificationItem[] = [];
    for (const raw of list.slice(0, MAGI_NEEDS_VERIFICATION_PREVIEW_CAP)) {
        const r = readRecord(raw);
        const claim = readString(r?.claim);
        if (!claim) continue;
        items.push({ claim, category: readString(r?.category) || 'needs_verification' });
    }
    return items;
}

function mergeGroup(
    groups: Map<string, MeshMagiActivitySummary>,
    patch: Partial<MeshMagiActivitySummary> & { consensusGroupId?: string },
): void {
    const consensusGroupId = readString(patch.consensusGroupId);
    if (!consensusGroupId) return;
    const previous = groups.get(consensusGroupId);
    // synthesized is terminal-ish and must not be downgraded back to running by an
    // out-of-order dispatch entry.
    const status: MeshMagiActivityStatus = patch.status === 'synthesized' || previous?.status === 'synthesized'
        ? 'synthesized'
        : 'running';
    const definedPatch = Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== undefined),
    ) as Partial<MeshMagiActivitySummary>;
    groups.set(consensusGroupId, { ...previous, ...definedPatch, consensusGroupId, status });
}

/**
 * Reconstruct per-consensusGroup MAGI activity from a ledger window. The newest
 * `magi_synthesis` for a group supplies the synthesis fields; a `magi_dispatched`
 * with no later synthesis stays `running`. Deduped by consensusGroupId, newest first.
 */
export function buildMeshMagiActivity(args: {
    meshId?: string;
    ledgerEntries?: MeshLedgerEntry[];
}): MeshMagiActivitySummary[] {
    const groups = new Map<string, MeshMagiActivitySummary>();

    for (const entry of args.ledgerEntries || []) {
        const payload = readRecord(entry.payload);
        if (payload?.source !== 'magi') continue;
        const consensusGroupId = readString(payload.consensusGroupId);
        if (!consensusGroupId) continue;

        if (entry.kind === 'magi_synthesis') {
            const synthesis = readRecord(payload.synthesis);
            mergeGroup(groups, {
                consensusGroupId,
                status: 'synthesized',
                missionId: readString(payload.missionId),
                panel: readString(payload.panel),
                question: readString(payload.question),
                replicaCount: readNumber(synthesis?.replicasExpected) ?? readNumber(payload.replicaCount),
                answered: readNumber(synthesis?.replicasAnswered),
                missing: readNumber(synthesis?.replicasMissing),
                staleReplicas: readNumber(payload.staleReplicas) ?? readNumber(synthesis?.staleReplicas),
                needsVerificationCount: Array.isArray(synthesis?.needsVerification) ? synthesis!.needsVerification.length : undefined,
                agreedCount: Array.isArray(synthesis?.agreed) ? synthesis!.agreed.length : undefined,
                independenceBanner: synthesis && 'independenceBanner' in synthesis ? (synthesis.independenceBanner as string | null) : undefined,
                gitSkew: readRecord(synthesis?.gitSkew) as unknown as MagiGitSkew | undefined,
                needsVerification: summarizeNeedsVerification(synthesis),
                openQuestions: Array.isArray(synthesis?.openQuestions) ? (synthesis!.openQuestions as string[]).slice(0, 10) : undefined,
                lastLedgerKind: entry.kind,
                lastUpdatedAt: entry.timestamp,
            });
        } else if (entry.kind === 'magi_dispatched') {
            mergeGroup(groups, {
                consensusGroupId,
                status: 'running',
                missionId: readString(payload.missionId),
                panel: readString(payload.panel),
                question: readString(payload.question),
                replicaCount: readNumber(payload.replicaCount),
                lastLedgerKind: entry.kind,
                lastUpdatedAt: entry.timestamp,
            });
        }
    }

    return Array.from(groups.values()).sort((a, b) => {
        const at = new Date(a.lastUpdatedAt || '').getTime();
        const bt = new Date(b.lastUpdatedAt || '').getTime();
        return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
    });
}

/** Synthesized groups older than this (relative to the newest activity in the set) are
 *  folded out of the active list — already-resolved historical runs that should not keep
 *  inflating mesh_status. 6h covers a long working session. */
export const STALE_MAGI_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Cap on recent synthesized groups kept in the active list even if all are fresh. */
export const RECENT_MAGI_CAP = 6;

export interface MeshMagiActivitySummaryFold {
    total: number;
    byStatus: Record<string, number>;
    /** Synthesized groups dropped from the active list as stale historical residue. */
    staleSynthesized: number;
    /** Bounded set of recent/active groups (running first, then recent synthesized). */
    groups: MeshMagiActivitySummary[];
}

function activityTime(g: MeshMagiActivitySummary): number {
    const t = new Date(g.lastUpdatedAt || '').getTime();
    return Number.isFinite(t) ? t : 0;
}

/**
 * Bound the MAGI activity list for mesh_status: running groups are always kept; synthesized
 * groups are kept only when recent (within STALE_MAGI_WINDOW_MS of the newest activity AND
 * among the RECENT_MAGI_CAP most-recent). Freshness is measured relative to the newest group
 * (not wall-clock) so the result is deterministic for a given input. Mirrors
 * summarizeMeshAsyncRefineJobs.
 */
export function summarizeMeshMagiActivity(
    activity: MeshMagiActivitySummary[],
): MeshMagiActivitySummaryFold {
    const running: MeshMagiActivitySummary[] = [];
    const synthesized: MeshMagiActivitySummary[] = [];
    for (const g of activity) {
        if (g.status === 'synthesized') synthesized.push(g);
        else running.push(g);
    }

    let newest = 0;
    for (const g of activity) newest = Math.max(newest, activityTime(g));
    const cutoff = newest - STALE_MAGI_WINDOW_MS;

    const synthesizedByRecency = [...synthesized].sort((a, b) => activityTime(b) - activityTime(a));
    const freshSynthesized = synthesizedByRecency
        .filter(g => activityTime(g) >= cutoff)
        .slice(0, RECENT_MAGI_CAP);

    const byStatus: Record<string, number> = {};
    for (const g of [...running, ...freshSynthesized]) {
        byStatus[g.status] = (byStatus[g.status] ?? 0) + 1;
    }

    // Running first (most actionable), then recent synthesized — both newest-first.
    const runningByRecency = [...running].sort((a, b) => activityTime(b) - activityTime(a));
    return {
        total: running.length + freshSynthesized.length,
        byStatus,
        staleSynthesized: synthesized.length - freshSynthesized.length,
        groups: [...runningByRecency, ...freshSynthesized],
    };
}

/** Latest persisted synthesis activity for one consensusGroupId, or undefined. */
export function getMeshMagiActivityByGroup(
    ledgerEntries: MeshLedgerEntry[],
    consensusGroupId: string,
): MeshMagiActivitySummary | undefined {
    const key = readString(consensusGroupId);
    if (!key) return undefined;
    return buildMeshMagiActivity({ ledgerEntries }).find(g => g.consensusGroupId === key);
}
