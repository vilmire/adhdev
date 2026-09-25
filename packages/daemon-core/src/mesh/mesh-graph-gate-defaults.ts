/**
 * Coordinator-gate lifecycle defaults (the 2026-09-25 graph orchestration simplification D3).
 *
 * A leaf module so BOTH the transition runner (which stamps `deadline_at` when a
 * gate opens) and mesh-graph-gates.ts (the sweep's lazy backfill for gates that
 * opened before this default existed) read one definition — the runner must not
 * import mesh-graph-gates.ts (one-directional imports, see that file's header).
 *
 * WHY A DEFAULT DEADLINE. `deadline_seconds` used to be optional with no default,
 * so a gate nobody released sat `awaiting_coordinator` forever (measured on the
 * preview mesh 2026-09: stranded gates were a top cancellation cause). The
 * default policy is `hold`: expiry only flags the gate `expired` and pages the
 * coordinator once — ★ elapsed time is still never completion evidence, the
 * gate is never released by the sweep.
 */

/** Default gate deadline when the gate spec carries no `deadline_seconds`: 24 h. */
export const MESH_GATE_DEFAULT_DEADLINE_SECONDS = 24 * 60 * 60;

/** Env override for {@link MESH_GATE_DEFAULT_DEADLINE_SECONDS}; `0` disables the default. */
export const MESH_GATE_DEFAULT_DEADLINE_ENV = 'ADHDEV_GRAPH_GATE_DEFAULT_DEADLINE_S';

/** Default `on_timeout` for a gate declared without one (already the plan/store default). */
export const MESH_GATE_DEFAULT_ON_TIMEOUT = 'hold' as const;

/**
 * The effective default deadline in seconds, or `null` when disabled.
 * A malformed / negative env value falls back to the 24 h constant.
 */
export function resolveDefaultGateDeadlineSeconds(env: NodeJS.ProcessEnv = process.env): number | null {
    const raw = env[MESH_GATE_DEFAULT_DEADLINE_ENV];
    if (raw !== undefined && raw.trim() !== '') {
        const parsed = Number(raw.trim());
        if (Number.isFinite(parsed) && parsed >= 0) {
            return parsed === 0 ? null : Math.max(1, Math.floor(parsed));
        }
    }
    return MESH_GATE_DEFAULT_DEADLINE_SECONDS;
}
