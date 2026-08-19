// ---------------------------------------------------------------------------
// mesh-refine-worker-cap — REFINE-GATE-WORKER-CAP: bound the CPU fan-out of
// gate child processes (vitest) when the REFINERY runs them.
//
// Same RCA as mesh-refine-concurrency.ts (2026-08-18, verdict D): the machine
// saturation came from two overlapping refine pipelines, and inside each
// pipeline the spike came from vitest forking one worker per core (9 on the
// 10-core host) PER gate run. The concurrency cap stops pipelines overlapping;
// this cap shrinks what a SINGLE running pipeline can burst to.
//
// Why a child ENV VAR and not CLI-flag injection:
//   - Gates are repo-configured commands — commonly `npm run test` / `npm run
//     build`, where vitest sits behind an npm-script indirection. Rewriting
//     argv cannot reach through that, but process env propagates to any depth
//     of child processes.
//   - vitest honors VITEST_MAX_WORKERS natively (resolved.maxWorkers), so the
//     cap applies however vitest ends up being invoked, with zero argv
//     mangling and no change to the recorded displayCommand.
//
// Why this cannot slow down CI: this env is assembled ONLY by the Refinery
// validation/bootstrap gate runner (mesh-refine-gates.ts execFileAsync sites).
// CI runs the repo's npm scripts directly, never through the daemon's gate
// runner, so CI parallelism is untouched by construction.
//
// An explicit VITEST_MAX_WORKERS already in the daemon's own env wins — the
// operator's setting is never overridden. A repo can also pin per-command via
// the command's configured `env` (spread AFTER this cap at the call site).
// ---------------------------------------------------------------------------

export const REFINE_VITEST_MAX_WORKERS_ENV = 'ADHDEV_REFINE_VITEST_MAX_WORKERS';
export const DEFAULT_REFINE_VITEST_MAX_WORKERS = 2;

/**
 * The configured cap, or null when the cap is disabled (env set to 0 / a
 * negative / unparseable-with-explicit-intent value is NOT disabled — only an
 * explicit '0' disables; unparseable falls back to the default, matching the
 * never-silently-uncapped rule of the concurrency cap).
 */
export function resolveRefineVitestMaxWorkers(env: NodeJS.ProcessEnv = process.env): number | null {
    const raw = env[REFINE_VITEST_MAX_WORKERS_ENV];
    if (raw === undefined || raw.trim() === '') return DEFAULT_REFINE_VITEST_MAX_WORKERS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_REFINE_VITEST_MAX_WORKERS;
    if (parsed === 0) return null; // explicit opt-out
    return Math.max(1, parsed);
}

/**
 * Extra env for a gate child process: `{ VITEST_MAX_WORKERS: '<cap>' }`, or
 * `{}` when the cap is disabled or the operator already set VITEST_MAX_WORKERS
 * in the daemon's environment.
 */
export function refineGateChildEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
    if (env.VITEST_MAX_WORKERS) return {};
    const cap = resolveRefineVitestMaxWorkers(env);
    if (cap === null) return {};
    return { VITEST_MAX_WORKERS: String(cap) };
}
