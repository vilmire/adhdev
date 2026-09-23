// ---------------------------------------------------------------------------
// mesh-tuned-env — clamped, env-overridable millisecond tunables
// ---------------------------------------------------------------------------
// Moved out of mesh-reconcile-acked-hold.ts when that module was deleted
// (wiring-unification C4, C-W4): the acked-hold deadlines became TurnPolicy
// fields (turn-ledger/policy.ts), but the generic resolver is still used by
// the auto-fast-forward cadence and the refine resume/closeout windows.
// Read at call time so tests can tune a value per case.
// ---------------------------------------------------------------------------

import { readNonEmptyString } from './mesh-events-utils.js';

/** `process.env[envName]` as an integer in [min, max], else `def`. */
export function resolveTunedReconcileMs(envName: string, def: number, min: number, max: number): number {
    const raw = readNonEmptyString(process.env[envName]);
    if (raw) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed >= min && parsed <= max) return parsed;
    }
    return def;
}
