// ---------------------------------------------------------------------------
// mesh-refine-env-sanitize — REFINE-GATE-ENV-SANITIZE: strip ADHDEV_* env vars
// from Refinery gate command children.
//
// Why: gate commands (validation.commands / the legacy validation.bootstrap-
// Commands loop) are spawned by execFileAsync with `{ ...process.env, ... }`
// in mesh-refine-gates.ts — the RUNNING DAEMON's own environment, verbatim.
// Any ADHDEV_* runtime flag the daemon process was booted with (applied at
// startup via config.envOverrides — e.g. a worker-MCP canary
// ADHDEV_WORKER_MCP=on) is inherited by the spawned test/build process, even
// though it has nothing to do with running that command.
//
// Measured impact (2026-08-30, mission M-MESH-INFRA-0829): a daemon canaried
// with ADHDEV_WORKER_MCP=on made
// cli-provider-startup-grace-generating-miss.test.ts throw inside
// CliProviderInstance's completion path (a call chain gated on
// isWorkerMcpEnabled(), which defaults to reading process.env — see
// runtime-defaults.ts), blocking the fleet's landing pipeline via Refinery's
// fast:ci suite. Restarting the daemon does NOT clear this: an upgrade spawns
// the new daemon from the old one's process, so the polluted env is
// inherited across restarts too.
//
// Fix: strip every ADHDEV_*-prefixed key from the child env before layering
// the CI default / worker-cap / per-command overrides on top (unchanged at
// the mesh-refine-gates.ts call sites). Everything else (PATH, HOME, NODE_*,
// CI, ...) passes through untouched.
//
// Allow-list decision: audited every script `npm run ci` / .adhdev/refine.json
// actually spawns as a gate (submodule-sync, file-sizes, boundaries, canon-
// identity, docs:verify, vendor-drift x2, provider-channel-drift, lint,
// build, typecheck, test:*, smoke:server) and every test file that inspects
// an ADHDEV_* var (worker-mcp, build-channel, provider-channel, config-dir,
// debug-bundle-dir, ghostty-vt-binding, coordinator-mcp-*) — none of them
// read theirs from the ambient daemon env; the tests that care already save/
// delete/restore the var themselves per case (see e.g.
// test/mesh/worker-mailbox.test.ts, test/commands/mesh-coordinator-track-
// identity.test.ts). So the allow-list starts EMPTY: no ADHDEV_* var is
// currently known to be legitimately required by a gate child. A future gate
// that genuinely needs one should either add it here with a comment naming
// which gate/test needs it, or set it via the command's own configured `env`
// in refine.json (spread AFTER this sanitize at the call site, so an
// explicit per-command value always wins over the strip).
// ---------------------------------------------------------------------------

const ADHDEV_ENV_PREFIX = 'ADHDEV_';

/**
 * ADHDEV_*-prefixed env keys a gate child may keep despite the strip. Empty
 * by design — see the module comment's audit. Add an entry only alongside a
 * comment naming the gate/test that genuinely needs it.
 */
export const REFINE_GATE_ENV_ALLOWLIST: ReadonlySet<string> = new Set<string>([]);

/**
 * Returns a shallow copy of `env` with every ADHDEV_*-prefixed key removed,
 * except those listed in {@link REFINE_GATE_ENV_ALLOWLIST}. Non-ADHDEV keys
 * (PATH, HOME, CI, NODE_*, ...) are always preserved untouched.
 */
export function sanitizeRefineGateChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const sanitized: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(env)) {
        if (key.startsWith(ADHDEV_ENV_PREFIX) && !REFINE_GATE_ENV_ALLOWLIST.has(key)) continue;
        sanitized[key] = value;
    }
    return sanitized;
}
