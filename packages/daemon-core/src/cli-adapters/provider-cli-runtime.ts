import * as os from 'os';
import * as path from 'path';
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
}): CliSpawnPlan {
    const { provider, runtimeSettings, workingDir, extraArgs } = options;
    const { spawn: spawnConfig } = provider;
    const configuredCommand = typeof runtimeSettings.executablePath === 'string' && runtimeSettings.executablePath.trim()
        ? runtimeSettings.executablePath.trim()
        : spawnConfig.command;
    const binaryPath = findBinary(configuredCommand);
    const isWin = os.platform() === 'win32';
    const allArgs = [...spawnConfig.args, ...extraArgs];

    let shellCmd: string;
    let shellArgs: string[];
    const useShellUnix = !isWin && (
        !!spawnConfig.shell
        || !path.isAbsolute(binaryPath)
        || isScriptBinary(binaryPath)
        || !looksLikeMachOOrElf(binaryPath)
    );
    const isCmdShim = isWin && /\.(cmd|bat)$/i.test(binaryPath);
    const useShellWin = !!spawnConfig.shell
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

    return {
        binaryPath,
        allArgs,
        shellCmd,
        shellArgs,
        isWin,
        useShell,
        ptyOptions: {
            cols: 80,
            rows: 24,
            cwd: workingDir,
            env: buildCliSpawnEnv(process.env, spawnConfig.env),
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
