/**
 * Launch-time helpers of the FSM driver: workspace pre-trust and the PTY
 * spawn plan. Split out of fsm-driver.ts (file-size gate); both run once per
 * driver and read only the spec + driver options.
 */
import { resolveCliSpawnPlanFromParts, stripRemovedSpawnArgs } from '../../cli-adapters/provider-cli-runtime.js';
import { DEFAULT_SESSION_HOST_COLS, DEFAULT_SESSION_HOST_ROWS } from '@adhdev/session-host-core';
import type { TerminalAdapterOpts } from './adapter.js';
import type { CliSpecV4 } from './fsm-types.js';
import type { SpecDriverOpts } from './fsm-driver-types.js';
import { applyPreLaunchTrust } from './pre-launch-trust.js';
import { applyKimiWorkspaceTrust } from '../kimi-workspace-trust.js';
import { applyGrokWorkspaceTrust } from '../grok-workspace-trust.js';
import { applyCodexWorkspaceTrust } from '../codex-workspace-trust.js';
import { applyPreLaunchTrustForClaude } from '../claude-workspace-trust.js';
import { LOG } from '../../logging/logger.js';

/** Pre-trust the workspace before spawning so a first-run folder-trust
 *  prompt never appears (best-effort; failures fall back to the FSM's
 *  trust-modal detection). Only runs for specs that declare it. */
export function applySpecPreLaunchTrust(spec: CliSpecV4, opts: SpecDriverOpts, specTag: string): void {
    const trust = spec.pre_launch_trust;
    if (!trust) return;
    if (opts.resolvedTrustPlan) {
        applyPreLaunchTrust(trust, opts.resolvedTrustPlan);
    } else if ('scheme' in trust
        && trust.scheme === 'kimi_workspace_file') {
        // Kimi has no worker-private HOME yet. Keep its current
        // KIMI_CODE_HOME/os.homedir() behavior until that isolation work lands.
        applyKimiWorkspaceTrust(opts.workingDir);
    } else if ('scheme' in trust
        && trust.scheme === 'grok_toml_file') {
        // ★grok GAINED a worker-private HOME on 2026-09-18 (its
        // harness-compat layer imports the owner's HOME-scoped
        // cursor/claude MCP config, so a workspace-scoped config alone
        // isolated nothing). The store must therefore follow the HOME
        // the worker will actually read: `grokHome()` resolves
        // `GROK_HOME` first and `os.homedir()` otherwise, and
        // `os.homedir()` is the DAEMON's home, not the worker's. Passing
        // the launch env makes a delegated worker's grant land in its own
        // private `~/.grok/trusted_folders.toml`, and — the reason this
        // matters in both directions — keeps a worker's automatic grant
        // OUT of the owner's personal store.
        //
        // Unlike the array stores below this is still NOT a leak risk
        // that warrants failing closed: grok's writer appends one scoped
        // `[folders."<realpath>"]` table and refuses over-broad roots, so
        // it can never widen an unrelated grant the way pushing into a
        // shared trustedWorkspaces array could. A non-delegated launch
        // has no HOME override and keeps its prior behavior exactly.
        //
        // ★Measured: an untrusted folder does NOT stall grok. Headless
        // runs completed in a private HOME with no trust store at all,
        // in both a git and a non-git workspace. Folder trust in grok
        // gates HOOK/PLUGIN execution, not the session — so this is a
        // correctness/containment fix, not a stall fix.
        applyGrokWorkspaceTrust(opts.workingDir, {
            ...process.env,
            ...(opts.extraEnv || {}),
        });
    } else if ('scheme' in trust
        && trust.scheme === 'codex_toml_file') {
        // ★Same env-following rationale as grok directly above, with one
        // codex-specific twist: codex names its own config-root variable
        // (`CODEX_HOME`), so a delegated launch does NOT repoint HOME —
        // `cli-delegated-launch` deliberately skips the HOME export for
        // config-root providers. `codexHome()` therefore resolves
        // CODEX_HOME FIRST, which is the variable that actually points
        // at the worker's private root. Passing the launch env is what
        // makes a delegated worker's grant land in its own store and
        // keeps it OUT of the owner's `~/.codex/config.toml`.
        //
        // The delegated path normally arrives with a resolved plan and
        // is handled by applyPreLaunchTrust above; this branch is the
        // non-delegated launch (user-run codex), where CODEX_HOME is
        // absent and the grant correctly targets the user's own store.
        applyCodexWorkspaceTrust(opts.workingDir, {
            ...process.env,
            ...(opts.extraEnv || {}),
        });
    } else if ('scheme' in trust
        && trust.scheme === 'claude_json_projects') {
        // See applyPreLaunchTrustForClaude's doc comment (claude-workspace-trust.ts).
        applyPreLaunchTrustForClaude(opts.workingDir, opts.extraEnv);
    } else {
        // Fail closed for array stores: resolving `~` here would use the
        // daemon's real HOME and recreate the worker trust leak.
        //
        // ★The context below is load-bearing, not decoration. This line
        // used to read only "skipping array trust without a resolved
        // launch plan", and when every delegated antigravity worker
        // started hanging on the folder-trust prompt (AGY-WORKER-TRUST-
        // STALL) it was the ONLY signal in the log — with no provider,
        // no workspace and no delegated/user marker, it could not be
        // tied to a session without reading the source. Anything that
        // makes this branch fire is by construction a worker that will
        // now sit on an unanswerable prompt, so it must name itself.
        const delegated = typeof opts.extraEnv?.HOME === 'string'
            && opts.extraEnv.HOME.trim() !== '';
        LOG.warn(
            'pre-launch-trust',
            `[${specTag}] skipping array trust without a resolved launch plan`
            + ` (provider=${spec.id || 'unknown'},`
            + ` workspace=${opts.workingDir},`
            + ` launch=${delegated ? 'delegated-worker' : 'user'})`
            + ' — the CLI will show its folder-trust prompt and the session may stall.',
        );
    }
}

export function buildSpecAdapterOpts(spec: CliSpecV4, opts: SpecDriverOpts): TerminalAdapterOpts {
    // Single-source spawn resolution: route the spec's binary/args/env
    // through the shared spawn planner (resolveCliSpawnPlanFromParts,
    // inherited from the legacy ProviderCliAdapter engine deleted in
    // 48e5ed1a). This gives the spec/FSM path
    // findBinary (PATH + npm-global / Node-dir fallback so an off-PATH
    // `codex`/`claude` resolves), `{{workingDir}}` token substitution, shell
    // wrapping for script-shims / non-absolute / non-native binaries, and a
    // sanitized env with TERMINAL_CWD — none of which it had when it passed
    // `spec.binary` straight to the PTY.
    const cols = opts.cols ?? DEFAULT_SESSION_HOST_COLS;
    const rows = opts.rows ?? DEFAULT_SESSION_HOST_ROWS;
    // PERMISSION-MODE-DUPLICATE: the spec's own base args are subject to the
    // selected auto-approve mode's removeArgs, exactly as the manifest's
    // spawn.args are in applyAutoApproveModeLaunchArgs. Without this the two
    // sources both contribute a `--permission-mode`.
    const specSpawnArgs = stripRemovedSpawnArgs(
        spec.spawn_args ?? [],
        opts.removeSpawnArgs ?? [],
    );
    const plan = resolveCliSpawnPlanFromParts({
        command: spec.binary,
        baseArgs: specSpawnArgs,
        baseEnv: spec.env ?? {},
        workingDir: opts.workingDir,
        extraArgs: opts.extraCliArgs ?? [],
        extraEnv: opts.extraEnv ?? {},
        geometry: { cols, rows },
        // CliSpecV4 is the FSM runtime spec (specs/4.0.json), not the
        // provider manifest, so it carries no `type`/`providerVersion` —
        // `id`/`name` is the identity this path has of its own.
        //
        // ★SPAWN-LOG-VERSION: the manifest version is NOT unavailable here,
        // as this comment previously asserted; it is simply not on the spec.
        // route.ts holds the resolved manifest and now threads it down (see
        // SpecDriverOpts.manifestProviderVersion), which is what ends the
        // `Spawning (spec vunknown)` line this path logged for every CLI.
        diagnosticCliType: spec.id || spec.name,
        diagnosticProviderVersion: opts.manifestProviderVersion,
    });
    return {
        binary: plan.shellCmd,
        args: plan.shellArgs,
        cwd: plan.ptyOptions.cwd,
        // plan.ptyOptions.env is already a complete, sanitized environment —
        // pass it verbatim, do not overlay process.env (see envIsComplete).
        env: plan.ptyOptions.env,
        envIsComplete: true,
        cols,
        rows,
        transportFactory: opts.transportFactory,
    };
}
