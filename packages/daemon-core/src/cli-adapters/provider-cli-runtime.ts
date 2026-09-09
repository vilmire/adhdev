import * as os from 'os';
import * as path from 'path';
import { LOG } from '../logging/logger.js';
import { DEFAULT_SESSION_HOST_COLS, DEFAULT_SESSION_HOST_ROWS } from '@adhdev/session-host-core';
import type { PtySpawnOptions } from './pty-transport.js';
import {
    buildCliSpawnEnv,
    findBinary,
    isScriptBinary,
    looksLikeMachOOrElf,
    shSingleQuote,
    type CliProviderModule,
} from './provider-cli-shared.js';

export interface CliSpawnPlan {
    binaryPath: string;
    allArgs: string[];
    shellCmd: string;
    shellArgs: string[];
    ptyOptions: PtySpawnOptions;
    isWin: boolean;
    useShell: boolean;
}

export function resolveCliSpawnPlan(options: {
    provider: CliProviderModule;
    runtimeSettings: Record<string, any>;
    workingDir: string;
    extraArgs: string[];
    extraEnv?: Record<string, string>;
}): CliSpawnPlan {
    const { provider, runtimeSettings, workingDir, extraArgs, extraEnv } = options;
    const { spawn: spawnConfig } = provider;
    const configuredCommand = typeof runtimeSettings.executablePath === 'string' && runtimeSettings.executablePath.trim()
        ? runtimeSettings.executablePath.trim()
        : spawnConfig.command;
    return resolveCliSpawnPlanFromParts({
        command: configuredCommand,
        baseArgs: spawnConfig.args,
        shell: spawnConfig.shell,
        baseEnv: spawnConfig.env,
        workingDir,
        extraArgs,
        extraEnv,
        diagnosticCliType: provider.type,
        diagnosticProviderVersion: provider.providerVersion,
    });
}

/**
 * Cols/rows for a PTY spawn. Defaults to the session-host terminal size; the
 * spec driver may override per-instance.
 */
export interface CliSpawnGeometry {
    cols?: number;
    rows?: number;
}

/** A `--flag` / `-f` token, as opposed to a positional or a flag's value. */
function isFlagToken(arg: unknown): arg is string {
    return typeof arg === 'string' && arg.startsWith('-') && arg !== '-' && arg !== '--';
}

/**
 * Per-arg cap for the spawn diagnostic log line below. Flags, session ids and
 * uuids are all well under this (session ids run ~60 chars); a `cli_arg`
 * prompt injection (contracts.ts `MeshCoordinatorSystemPromptInjection`,
 * mode: 'cli_arg') pushes the full mesh coordinator prompt onto argv and can
 * run to tens of KB, which is what this caps.
 */
const SPAWN_LOG_ARG_MAX_CHARS = 200;

/**
 * Render argv for the spawn diagnostic log, truncating any single argument
 * that exceeds SPAWN_LOG_ARG_MAX_CHARS so a `cli_arg`-mode prompt injection
 * cannot blow the log line up to the size of the prompt itself. Never mutates
 * the argv actually passed to spawn — only the logged string.
 */
function renderArgsForLog(args: readonly string[]): string {
    return args
        .map((arg) => {
            if (arg.length <= SPAWN_LOG_ARG_MAX_CHARS) return arg;
            const omitted = arg.length - SPAWN_LOG_ARG_MAX_CHARS;
            return `${arg.slice(0, SPAWN_LOG_ARG_MAX_CHARS)}…(+${omitted} chars)`;
        })
        .join(' ');
}

/**
 * Flags declared by `extraArgs`, normalized to their bare form so both the
 * `--flag value` and `--flag=value` spellings collapse to `--flag`.
 */
function collectDeclaredFlags(extraArgs: readonly string[]): Set<string> {
    const flags = new Set<string>();
    for (const arg of extraArgs) {
        if (!isFlagToken(arg)) continue;
        const eq = arg.indexOf('=');
        flags.add(eq > 0 ? arg.slice(0, eq) : arg);
    }
    return flags;
}

/**
 * Strip an auto-approve mode's `removeArgs` from a set of base spawn args.
 *
 * `removeArgs` names the FLAGS a mode replaces (manifests also tend to list the
 * provider's default VALUE as a second entry, e.g. grok-cli declares
 * `['--permission-mode', 'acceptEdits']`), but the value a given base-arg source
 * actually carries is not knowable from the list: claude-cli's manifest says
 * `--permission-mode acceptEdits` while its specs/4.0.json says
 * `--permission-mode default`. So a removed flag also consumes its following
 * token when that token is a value rather than another flag — matching by
 * position instead of by the listed value. A bare value entry in `removeArgs`
 * still matches a standalone token, preserving the manifest-path behaviour.
 */
export function stripRemovedSpawnArgs(
    baseArgs: readonly string[],
    removeArgs: readonly string[],
): string[] {
    if (removeArgs.length === 0) return [...baseArgs];
    const kept: string[] = [];
    for (let i = 0; i < baseArgs.length; i += 1) {
        const arg = baseArgs[i];
        const matched = removeArgs.some((removeArg) =>
            arg === removeArg || (removeArg.startsWith('--') && arg.startsWith(`${removeArg}=`)));
        if (!matched) {
            kept.push(arg);
            continue;
        }
        // A removed `--flag` in the space-separated form takes its value with it;
        // leaving the value behind would turn it into a stray positional.
        if (isFlagToken(arg) && arg.indexOf('=') < 0 && i + 1 < baseArgs.length && !isFlagToken(baseArgs[i + 1])) {
            i += 1;
        }
    }
    return kept;
}

/**
 * LAST-WINS ARG DEDUPE — the single chokepoint that keeps a per-launch arg from
 * colliding with the base args the spec/manifest already declared.
 *
 * The auto-approve `launch-args` strategy prepends a mode's `launchArgs` to the
 * per-launch args while the provider's own base args still carry the provider
 * default for the same flag, so grok-cli launched in `auto` mode produced
 * `--permission-mode acceptEdits --permission-mode auto`. grok's CLI is Rust/clap,
 * which rejects a repeated flag outright and the launch died; claude-cli is
 * commander.js, which silently takes the last one — same defect, no error, and so
 * it went unnoticed. Deduping here covers every provider on both spawn paths
 * rather than one manifest at a time.
 *
 * Value pairing matters: dropping only the `--permission-mode` token would leave
 * its value `acceptEdits` behind as a stray positional, which is a worse failure
 * than the duplicate. Base args are space-separated `--flag value` pairs (specs
 * and manifests both spell them that way), so a removed flag also consumes the
 * following token when that token is not itself a flag. The `--flag=value` form
 * is self-contained and consumes nothing extra.
 *
 * Only flags that `extraArgs` actually declares are removed; everything else in
 * `baseArgs` is preserved in order.
 */
export function dedupeBaseArgsAgainstExtraArgs(
    baseArgs: readonly string[],
    extraArgs: readonly string[],
): string[] {
    const declared = collectDeclaredFlags(extraArgs);
    if (declared.size === 0) return [...baseArgs];

    const kept: string[] = [];
    for (let i = 0; i < baseArgs.length; i += 1) {
        const arg = baseArgs[i];
        if (!isFlagToken(arg)) {
            kept.push(arg);
            continue;
        }
        const eq = arg.indexOf('=');
        const bare = eq > 0 ? arg.slice(0, eq) : arg;
        if (!declared.has(bare)) {
            kept.push(arg);
            continue;
        }
        // Drop the flag, and its value too when it is a separate token.
        if (eq < 0 && i + 1 < baseArgs.length && !isFlagToken(baseArgs[i + 1])) i += 1;
    }
    return kept;
}

/**
 * Core spawn-plan resolution from already-flattened spawn parts — the single
 * source of truth for binary resolution (findBinary: PATH + npm-global / Node
 * dir fallback), `{{workingDir}}` token substitution, shell wrapping
 * (script-shims / non-absolute / non-native binaries), and env sanitization +
 * TERMINAL_CWD. Both the legacy provider-module path (resolveCliSpawnPlan) and
 * the spec/FSM path (FsmDriver.buildAdapterOpts) feed into this so the two
 * spawn paths can never diverge.
 */
export function resolveCliSpawnPlanFromParts(options: {
    /** Raw command from the spec/provider (`binary` / `spawn.command`), or an
     *  operator-configured executable path override. */
    command: string;
    /** Base launch args declared by the spec/provider (`spawn_args` /
     *  `spawn.args`). */
    baseArgs?: string[];
    /** When true, always wrap the launch in a login shell. */
    shell?: boolean;
    /** Base env declared by the spec/provider (`env` / `spawn.env`). */
    baseEnv?: Record<string, string>;
    workingDir: string;
    /** Per-launch extra args (e.g. resume session id) appended after baseArgs. */
    extraArgs?: string[];
    extraEnv?: Record<string, string>;
    geometry?: CliSpawnGeometry;
    /** Provider type + manifest version, for the spawn diagnostic below. Optional
     *  so no caller is forced to thread it, but every real launch path should
     *  pass it — a spawn line without identity is far less useful. */
    diagnosticCliType?: string;
    diagnosticProviderVersion?: string;
}): CliSpawnPlan {
    const { command, baseArgs, shell, baseEnv, workingDir, extraArgs, extraEnv, geometry, diagnosticCliType, diagnosticProviderVersion } = options;
    const binaryPath = findBinary(command);
    const isWin = os.platform() === 'win32';
    // LAST-WINS ARG DEDUPE: a per-launch flag overrides the base args' spelling of
    // the same flag instead of appearing twice. See dedupeBaseArgsAgainstExtraArgs.
    const dedupedBaseArgs = dedupeBaseArgsAgainstExtraArgs(baseArgs ?? [], extraArgs ?? []);
    const allArgs = [...dedupedBaseArgs, ...(extraArgs ?? [])].map((arg) =>
        typeof arg === 'string' ? arg.replace(/\{\{workingDir\}\}/g, workingDir) : arg,
    );

    let shellCmd: string;
    let shellArgs: string[];
    const useShellUnix = !isWin && (
        !!shell
        || !path.isAbsolute(binaryPath)
        || isScriptBinary(binaryPath)
        || !looksLikeMachOOrElf(binaryPath)
    );
    const isCmdShim = isWin && /\.(cmd|bat)$/i.test(binaryPath);
    const useShellWin = !!shell
        || isCmdShim
        || !path.isAbsolute(binaryPath)
        || isScriptBinary(binaryPath);
    const useShell = isWin ? useShellWin : useShellUnix;

    if (useShell) {
        shellCmd = isWin ? 'cmd.exe' : (process.env.SHELL || '/bin/zsh');
        if (isWin) {
            shellArgs = ['/c', binaryPath, ...allArgs];
        } else {
            const fullCmd = [binaryPath, ...allArgs].map(shSingleQuote).join(' ');
            shellArgs = ['-l', '-c', fullCmd];
        }
    } else {
        shellCmd = binaryPath;
        shellArgs = allArgs;
    }

    const env = buildCliSpawnEnv(process.env, { ...(baseEnv || {}), ...(extraEnv || {}) });
    // Some CLI agents, notably Hermes, route their tools through TERMINAL_CWD
    // rather than process.cwd(). Keep the generic ADHDev launch workspace as
    // the single source of truth so PTY cwd and tool cwd cannot diverge.
    env.TERMINAL_CWD = workingDir;

    // Log the ACTUAL argv and the manifest version that produced it, here at the
    // shared chokepoint rather than in any one caller. A resume that hands the
    // CLI a wrong-shaped session id fails inside the provider ("Session <id> not
    // found") with nothing on our side to compare against. Diagnosing the kimi
    // resume defect cost two round-trips for exactly this reason: the argv was
    // invisible, and once it was visible the argv alone still could not
    // distinguish "our expansion is wrong" from "this machine is pinned to an
    // older spec" — a daemon resolves providers from the content-addressed
    // channel store, whose pin only advances on check_provider_updates, so the
    // repo checkout and ~/.adhdev/providers/.upstream can both show a fix the
    // running daemon does not have.
    //
    // This lives here because the legacy provider-module path and the spec/FSM
    // path both funnel through this function: logging in ProviderCliAdapter
    // alone covered kimi but silently missed codex, which spawns via FsmDriver.
    //
    // NOT content-free: args are usually just provider flags and ids, but a
    // `cli_arg`-mode system-prompt injection (contracts.ts
    // MeshCoordinatorSystemPromptInjection, mode: 'cli_arg') pushes the full
    // mesh coordinator prompt onto argv for that CLI, and it lands here whole.
    // renderArgsForLog truncates any single arg over SPAWN_LOG_ARG_MAX_CHARS
    // so a prompt-sized arg cannot blow this line — and the log file — up to
    // the size of the prompt itself; short args (flags, ids) pass through
    // unchanged.
    LOG.info(
        'CLI',
        `[${diagnosticCliType || 'cli'}] Spawning (spec v${diagnosticProviderVersion || 'unknown'}) in ${workingDir}: ${binaryPath} ${renderArgsForLog(allArgs)}`,
    );

    return {
        binaryPath,
        allArgs,
        shellCmd,
        shellArgs,
        isWin,
        useShell,
        ptyOptions: {
            cols: geometry?.cols ?? DEFAULT_SESSION_HOST_COLS,
            rows: geometry?.rows ?? DEFAULT_SESSION_HOST_ROWS,
            cwd: workingDir,
            env,
        },
    };
}

