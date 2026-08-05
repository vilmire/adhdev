import * as os from 'os';
import * as path from 'path';
import { LOG } from '../logging/logger.js';
import { DEFAULT_SESSION_HOST_COLS, DEFAULT_SESSION_HOST_ROWS } from '@adhdev/session-host-core';
import type { PtySpawnOptions, PtyRuntimeTransport } from './pty-transport.js';
import type { TerminalScreen } from './terminal-screen.js';
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
    const allArgs = [...(baseArgs ?? []), ...(extraArgs ?? [])].map((arg) =>
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
    // Args are provider flags and ids — never prompt or transcript text — so
    // this stays content-free.
    LOG.info(
        'CLI',
        `[${diagnosticCliType || 'cli'}] Spawning (spec v${diagnosticProviderVersion || 'unknown'}) in ${workingDir}: ${binaryPath} ${allArgs.join(' ')}`,
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

export function buildCliLoginShellRetry(plan: Pick<CliSpawnPlan, 'binaryPath' | 'allArgs'>): {
    shellCmd: string;
    shellArgs: string[];
} {
    const shellCmd = process.env.SHELL || '/bin/zsh';
    const fullCmd = [plan.binaryPath, ...plan.allArgs].map(shSingleQuote).join(' ');
    return {
        shellCmd,
        shellArgs: ['-l', '-c', fullCmd],
    };
}

export function getCliSpawnErrorHint(message: string, shellCmd: string, isWin: boolean): string | null {
    if (!isWin) return null;
    if (/error code 267|ERROR_DIRECTORY/i.test(message)) {
        return ' (working directory does not exist or is not a directory)';
    }
    if (/error code 740|elevation/i.test(message)) {
        return ' (requires administrator privileges)';
    }
    if (/error code 2|ENOENT|not found/i.test(message)) {
        return ` (executable not found: ${shellCmd})`;
    }
    return null;
}

export function respondToCliTerminalQueries(options: {
    ptyProcess: PtyRuntimeTransport | null;
    pendingTail: string;
    data: string;
    terminalScreen: TerminalScreen;
}): string {
    const { ptyProcess, pendingTail, data, terminalScreen } = options;
    if (!ptyProcess || !data) return pendingTail;

    const combined = pendingTail + data;
    const regex = /\x1b\[(\?)?6n/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(combined)) !== null) {
        const cursor = terminalScreen.getCursorPosition();
        const row = Math.max(1, (cursor.row | 0) + 1);
        const col = Math.max(1, (cursor.col | 0) + 1);
        const response = match[1]
            ? `\x1b[?${row};${col}R`
            : `\x1b[${row};${col}R`;
        ptyProcess.write(response);
    }

    const prefixes = ['\x1b[6n', '\x1b[?6n'];
    const maxLength = prefixes.reduce((n, value) => Math.max(n, value.length), 0) - 1;
    const start = Math.max(0, combined.length - maxLength);
    for (let i = start; i < combined.length; i++) {
        const suffix = combined.slice(i);
        if (prefixes.some((pattern) => suffix.length < pattern.length && pattern.startsWith(suffix))) {
            return suffix;
        }
    }
    return '';
}
