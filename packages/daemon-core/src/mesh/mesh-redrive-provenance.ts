/**
 * REDRIVE-PROVIDER-FLIP (a) — make a redrive that changes provider explicitly legible.
 *
 * Background. When a dispatched task is delivered but never consumed, the stranded-dispatch
 * watchdog force-reclaims it (`delivered_not_consumed_redrive`, ~25-40s after dispatch) and
 * returns the row to `pending`. The re-claim that follows does NOT recompute routing — it
 * adopts whichever idle session is available — so the task can silently resume on a
 * DIFFERENT provider than the one it was originally routed to. Observed live 7-8 times over
 * 2026-08-25/26, each recovered by hand.
 *
 * The flip was already *derivable* before this module existed, but only by pulling the two
 * `task_dispatched` ledger entries for a task and diffing their `providerType` by hand. That
 * is not a measurement anyone runs by default, which is why the flips went unnoticed for a
 * day. This turns the derivation into a recorded fact at the moment it happens.
 *
 * Scope discipline: this is OBSERVABILITY ONLY. Nothing here routes, gates, ranks or retries.
 * It exists so the effect of any future change to redrive routing can be measured against a
 * baseline — deliberately landed before such a change, not alongside one.
 *
 * Pure by construction (no I/O, no clock, no store): `mesh-queue-assignment.ts` is already
 * near the file-size gate baseline, and a pure function is directly unit-testable without
 * standing up a queue, a mesh or a ledger.
 */

/** The pre-reclaim assignment snapshot preserved on the queue row by the reclaim. */
export interface MeshLastReclaimSnapshot {
    providerType?: string;
    nodeId?: string;
    sessionId?: string;
    reason: string;
    reclaimCount: number;
    at: string;
}

/** The `redriveProvenance` block folded into a `task_dispatched` ledger payload. */
export interface MeshRedriveProvenance {
    /** Reclaim reason that produced this re-dispatch, e.g. 'delivered_not_consumed_redrive'. */
    reason: string;
    /** How many times the stranded watchdog has reclaimed this row (post-reclaim count). */
    reclaimCount: number;
    /** Provider of the torn-down assignment. Absent on legacy rows that never recorded one. */
    previousProviderType?: string;
    previousNodeId?: string;
    previousSessionId?: string;
    reclaimedAt: string;
    /** The provider this re-dispatch actually resolved to. */
    providerType: string;
    /**
     * True only when both providers are known AND differ — the silent-flip signal.
     * `false` when the redrive kept the same provider (the benign, expected case);
     * absent-previous rows report `false` rather than fabricating a flip.
     */
    providerChanged: boolean;
}

function normalize(value: string | undefined): string | undefined {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed ? trimmed : undefined;
}

/**
 * Build the provenance block for a dispatch, or `null` when this dispatch is not a redrive
 * (no reclaim ever tore an assignment down for this row → an ordinary first dispatch, whose
 * ledger shape is deliberately left byte-identical to before).
 */
export function buildRedriveProvenance(
    lastReclaim: MeshLastReclaimSnapshot | undefined,
    dispatchedProviderType: string,
): MeshRedriveProvenance | null {
    if (!lastReclaim) return null;
    const previousProviderType = normalize(lastReclaim.providerType);
    const providerType = normalize(dispatchedProviderType) ?? dispatchedProviderType;
    // A flip requires BOTH sides to be known. An unknown previous provider is a legacy /
    // never-assigned row, not evidence of a change — reporting it as one would manufacture
    // exactly the false signal this record exists to avoid.
    const providerChanged = !!previousProviderType
        && !!normalize(dispatchedProviderType)
        && previousProviderType !== providerType;
    return {
        reason: lastReclaim.reason,
        reclaimCount: lastReclaim.reclaimCount,
        ...(previousProviderType ? { previousProviderType } : {}),
        ...(normalize(lastReclaim.nodeId) ? { previousNodeId: normalize(lastReclaim.nodeId) } : {}),
        ...(normalize(lastReclaim.sessionId) ? { previousSessionId: normalize(lastReclaim.sessionId) } : {}),
        reclaimedAt: lastReclaim.at,
        providerType,
        providerChanged,
    };
}

/**
 * The human-readable one-liner for a provider-changing redrive. Kept next to the builder so
 * the log text and the ledger block cannot drift apart.
 */
export function describeRedriveProviderFlip(provenance: MeshRedriveProvenance, taskId: string, meshId: string): string {
    return `Redrive of task ${taskId} on mesh ${meshId} CHANGED PROVIDER: `
        + `${provenance.previousProviderType ?? '?'} → ${provenance.providerType} `
        + `(reason ${provenance.reason}, reclaim #${provenance.reclaimCount}, `
        + `previous node=${provenance.previousNodeId ?? '?'} session=${provenance.previousSessionId ?? '?'}). `
        + `The reclaim path re-claims an idle session WITHOUT recomputing routing, so the task is now `
        + `running on a provider it was not routed to. Recorded for measurement; no behavior changed here.`;
}
