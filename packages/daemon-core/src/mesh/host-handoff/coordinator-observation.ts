import { getSessionHostSurfaceKind, type SessionHostSurfaceKind } from '../../session-host/runtime-surface.js';

/** Unknown runtime metadata cannot be used as proof that no coordinator lives. */

export interface CoordinatorCensusRow {
    sessionId: string;
    lifecycle: string;
    surfaceKind?: SessionHostSurfaceKind;
    termination?: unknown;
    meta?: { meshCoordinatorFor?: string };
}

/** Session-host rows omit surfaceKind. Derive it before the strict census.
 * An already stamped kind is kept, including an explicit non-live kind. */
export function presentCoordinatorCensusRows<T extends CoordinatorCensusRow>(rows: T[]): T[] {
    return rows.map(row => {
        if (row.surfaceKind === 'live_runtime' || row.surfaceKind === 'recovery_snapshot' || row.surfaceKind === 'inactive_record') return row;
        return { ...row, surfaceKind: getSessionHostSurfaceKind({ lifecycle: row.lifecycle, surfaceKind: row.surfaceKind, termination: row.termination }) };
    });
}
export function classifyCoordinatorCensus<T extends CoordinatorCensusRow>(rows: T[], meshId: string, registeredIds: ReadonlySet<string>): { verified: boolean; live: T[] } {
    if (!Array.isArray(rows) || rows.some(r => !r || typeof r.sessionId !== 'string')) return { verified: false, live: [] };
    const matching = rows.filter(row => row.meta?.meshCoordinatorFor === meshId || registeredIds.has(row.sessionId));
    const unknown = matching.some(row => row.meta?.meshCoordinatorFor && row.meta.meshCoordinatorFor !== meshId
        || !['running', 'starting', 'stopping', 'interrupted', 'stopped', 'exited'].includes(row.lifecycle)
        || (['stopped', 'exited'].includes(row.lifecycle) ? row.surfaceKind === 'live_runtime' : row.surfaceKind !== 'live_runtime'));
    if (unknown) return { verified: false, live: [] };
    return { verified: true, live: matching.filter(row => row.surfaceKind === 'live_runtime' && !['stopped', 'exited'].includes(row.lifecycle)) };
}
