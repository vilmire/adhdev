/**
 * Contract versioning — scoped consumer use guards (design §15, RN-02, AC13).
 *
 * A multi-stage consumer (Refinery landing) acquires a guard for the exact
 * namespace + UNITS it depends on, rechecks eligibility at the guard's
 * linearization point, performs its external side effect, then finishes the
 * guard. While a guard is active — or its outcome is UNKNOWN after a crash —
 * acceptance of a proposal that changes one of those units is refused
 * (`use_guard_conflict`). That deliberately sacrifices availability rather than
 * claiming distributed atomicity.
 *
 * RN-02 specifics:
 *   - scoped: only proposals whose changed units intersect the guard's units
 *     conflict; unrelated units and other namespaces never stall;
 *   - crash convergence: a guard left `active` by a previous process
 *     incarnation becomes `unknown` at boot; it is released ONLY by a
 *     reconciliation probe that checks the actual target branch (landed →
 *     finished, not landed → released). A timer alone never releases it.
 */

import { ContractRefusal, type ContractHeadVector, type ContractUsePurpose } from './contract-types.js';
import { inTxn, newId, type ContractCtx } from './contract-context.js';

export type ContractGuardState = 'active' | 'finished' | 'released' | 'unknown';

export interface ContractUseGuard {
    guardId: string;
    namespaceId: string;
    /** Empty = every unit of the namespace. */
    units: string[];
    resultKeys: string[];
    purpose: ContractUsePurpose;
    vector: ContractHeadVector;
    state: ContractGuardState;
    externalRef: Record<string, string> | null;
}

interface GuardRow {
    guard_id: string; namespace_id: string; units_json: string; result_keys_json: string; purpose: string;
    vector_json: string; state: string; external_ref_json: string | null;
}

function toGuard(r: GuardRow): ContractUseGuard {
    const parse = <T>(s: string | null, d: T): T => { try { return s ? JSON.parse(s) as T : d; } catch { return d; } };
    return {
        guardId: r.guard_id,
        namespaceId: r.namespace_id,
        units: parse<string[]>(r.units_json, []),
        resultKeys: parse<string[]>(r.result_keys_json, []),
        purpose: r.purpose as ContractUsePurpose,
        vector: parse<ContractHeadVector>(r.vector_json, {} as ContractHeadVector),
        state: r.state as ContractGuardState,
        externalRef: parse<Record<string, string> | null>(r.external_ref_json, null),
    };
}

export function getUseGuard(ctx: ContractCtx, guardId: string): ContractUseGuard | null {
    const r = ctx.db.prepare('SELECT * FROM contract_use_guards WHERE guard_id = ?').get(guardId) as GuardRow | undefined;
    return r ? toGuard(r) : null;
}

/** Active or unknown guards of `namespaceId` that overlap `changedUnits`. */
export function overlappingOpenGuards(ctx: ContractCtx, namespaceId: string, changedUnits: readonly string[]): ContractUseGuard[] {
    if (changedUnits.length === 0) return [];
    const changed = new Set(changedUnits);
    const rows = ctx.db.prepare(`SELECT * FROM contract_use_guards WHERE namespace_id = ? AND state IN ('active', 'unknown')`).all(namespaceId) as GuardRow[];
    return rows.map(toGuard).filter(g => g.units.length === 0 || g.units.some(u => changed.has(u)));
}

export function insertUseGuard(ctx: ContractCtx, input: {
    namespaceId: string; units: readonly string[]; resultKeys: readonly string[]; purpose: ContractUsePurpose; vector: ContractHeadVector; processIncarnation: number;
}): ContractUseGuard {
    const guardId = newId(ctx, 'guard');
    const now = ctx.rt.nowMs();
    ctx.db.prepare(`INSERT INTO contract_use_guards (guard_id, namespace_id, units_json, result_keys_json, purpose, vector_json, state,
        process_incarnation, external_ref_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?)`)
        .run(guardId, input.namespaceId, JSON.stringify([...new Set(input.units)].sort()), JSON.stringify([...input.resultKeys]),
            input.purpose, JSON.stringify(input.vector), input.processIncarnation, now, now);
    return getUseGuard(ctx, guardId)!;
}

function setState(ctx: ContractCtx, guardId: string, from: readonly ContractGuardState[], to: ContractGuardState, externalRef?: Record<string, string>): ContractUseGuard {
    return inTxn(ctx, () => {
        const g = getUseGuard(ctx, guardId);
        if (!g) throw new ContractRefusal('not_found');
        if (!from.includes(g.state)) throw new ContractRefusal('invalid_input');
        const ref = externalRef ? { ...(g.externalRef ?? {}), ...externalRef } : g.externalRef;
        ctx.db.prepare('UPDATE contract_use_guards SET state = ?, external_ref_json = ?, updated_at = ? WHERE guard_id = ?')
            .run(to, ref ? JSON.stringify(ref) : null, ctx.rt.nowMs(), guardId);
        return getUseGuard(ctx, guardId)!;
    });
}

/** Record the external intent (e.g. branch/commit/target) BEFORE the side effect, so a crash can be reconciled. */
export function recordGuardIntent(ctx: ContractCtx, guardId: string, externalRef: Record<string, string>): ContractUseGuard {
    return setState(ctx, guardId, ['active'], 'active', externalRef);
}

export function finishUseGuard(ctx: ContractCtx, guardId: string, outcome: 'published' | 'aborted', externalRef?: Record<string, string>): ContractUseGuard {
    return setState(ctx, guardId, ['active'], outcome === 'published' ? 'finished' : 'released', externalRef);
}

/** The side effect's outcome cannot be established (exception mid-publication, lost response). */
export function markUseGuardUnknown(ctx: ContractCtx, guardId: string, externalRef?: Record<string, string>): ContractUseGuard {
    return setState(ctx, guardId, ['active', 'unknown'], 'unknown', externalRef);
}

/**
 * RN-02 crash convergence: ask the actual target whether the guarded
 * publication landed. Only a definite answer moves the guard; `indeterminate`
 * keeps blocking conflicting acceptance.
 */
export function reconcileUnknownUseGuard(
    ctx: ContractCtx,
    guardId: string,
    probe: (externalRef: Record<string, string> | null) => 'landed' | 'not_landed' | 'indeterminate',
): ContractUseGuard {
    const g = getUseGuard(ctx, guardId);
    if (!g) throw new ContractRefusal('not_found');
    if (g.state !== 'unknown') return g;
    let verdict: 'landed' | 'not_landed' | 'indeterminate';
    try { verdict = probe(g.externalRef); } catch { verdict = 'indeterminate'; }
    if (verdict === 'landed') return setState(ctx, guardId, ['unknown'], 'finished');
    if (verdict === 'not_landed') return setState(ctx, guardId, ['unknown'], 'released');
    return g;
}

export function listUseGuards(ctx: ContractCtx, filter: { namespaceId?: string; states?: readonly ContractGuardState[] } = {}): ContractUseGuard[] {
    const rows = ctx.db.prepare('SELECT * FROM contract_use_guards').all() as GuardRow[];
    return rows.map(toGuard).filter(g => (!filter.namespaceId || g.namespaceId === filter.namespaceId)
        && (!filter.states || filter.states.includes(g.state)));
}
