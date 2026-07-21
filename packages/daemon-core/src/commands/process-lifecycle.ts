import { execFileSync, type ExecFileSyncOptions } from 'child_process';
import * as path from 'path';

export interface ProcessLifecycleOptions {
    platform?: NodeJS.Platform;
    execFileSync?: typeof import('child_process').execFileSync;
}

export interface OwnedProcessInfo {
    pid: number;
    commandLine: string | null;
}

function defaultExecFileSync(): typeof import('child_process').execFileSync {
    return execFileSync;
}

function getWindowsProcessCommandLine(
    pid: number,
    exec: typeof import('child_process').execFileSync,
): string | null {
    const pidFilter = `ProcessId=${pid}`;

    try {
        const psOut = exec('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy', 'Bypass',
            '-Command',
            `(Get-CimInstance Win32_Process -Filter "${pidFilter}").CommandLine`,
        ], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        const text = String(psOut).trim();
        if (text) return text;
    } catch {
        // fall through to wmic fallback
    }

    try {
        const wmicOut = exec('wmic', [
            'process', 'where', pidFilter, 'get', 'CommandLine',
        ], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        const text = String(wmicOut).trim();
        if (text) return text;
    } catch {
        // noop
    }

    return null;
}

export function getProcessCommandLine(
    pid: number,
    options: ProcessLifecycleOptions = {},
): string | null {
    if (!Number.isFinite(pid) || pid <= 0) return null;
    const exec = options.execFileSync ?? defaultExecFileSync();
    const platform = options.platform ?? process.platform;

    if (platform === 'win32') {
        return getWindowsProcessCommandLine(pid, exec);
    }

    try {
        const text = String(exec('ps', ['-o', 'command=', '-p', String(pid)], {
            encoding: 'utf8',
            timeout: 3000,
            stdio: ['ignore', 'pipe', 'ignore'],
        })).trim();
        return text || null;
    } catch {
        return null;
    }
}

/**
 * Extract the script argument (the token after the node executable) from a
 * command line. Handles both quoted and unquoted executables/scripts.
 */
export function parseNodeScriptPath(commandLine: string | null): string | null {
    if (!commandLine) return null;
    let rest = commandLine.trim();

    // Skip the leading executable token.
    if (rest.startsWith('"')) {
        const end = rest.indexOf('"', 1);
        if (end === -1) return null;
        rest = rest.slice(end + 1).trim();
    } else {
        const idx = rest.search(/\s/);
        if (idx === -1) return null;
        rest = rest.slice(idx + 1).trim();
    }
    if (!rest) return null;

    if (rest.startsWith('"')) {
        const end = rest.indexOf('"', 1);
        return end === -1 ? rest.slice(1) : rest.slice(1, end);
    }
    const idx = rest.search(/\s/);
    return idx === -1 ? rest : rest.slice(0, idx);
}

function normalizeWindowsPath(value: string): string {
    return value.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
}

function isCommandLineUnderPrefix(commandLine: string | null, prefix: string): boolean {
    if (!commandLine) return false;
    const needle = normalizeWindowsPath(prefix);
    // Command-line paths may quote Windows separators as either single or
    // doubled backslashes; collapse doubles before matching.
    const haystack = commandLine.split('\\\\').join('\\').toLowerCase();
    return haystack.includes(needle);
}

export function killProcess(pid: number, options: ProcessLifecycleOptions = {}): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    const exec = options.execFileSync ?? defaultExecFileSync();
    const platform = options.platform ?? process.platform;

    try {
        if (platform === 'win32') {
            exec('taskkill', ['/PID', String(pid), '/T', '/F'], {
                stdio: 'ignore',
                windowsHide: true,
            });
        } else {
            process.kill(pid, 'SIGTERM');
        }
        return true;
    } catch {
        return false;
    }
}

export async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            process.kill(pid, 0);
            await new Promise((resolve) => setTimeout(resolve, 250));
        } catch {
            return true;
        }
    }
    return false;
}

/**
 * List Node processes whose command line places them under any of the supplied
 * prefixes. Windows-only — the versioned-prefix lifecycle this supports does not
 * exist on POSIX, so the helper is a no-op there.
 */
export function listOwnedNodeProcesses(options: {
    prefixes: readonly string[];
    excludePids?: readonly number[];
    markers?: readonly string[];
} & ProcessLifecycleOptions): OwnedProcessInfo[] {
    const platform = options.platform ?? process.platform;
    if (platform !== 'win32') return [];

    const exec = options.execFileSync ?? defaultExecFileSync();
    const prefixes = options.prefixes.map((p) => normalizeWindowsPath(p));
    const exclude = new Set((options.excludePids ?? []).filter((n) => Number.isFinite(n) && n > 0));
    // Command-line paths use Windows separators; normalize marker separators the
    // same way so a marker like "dist/cli/index.js" matches "dist\cli\index.js".
    const markers = (options.markers ?? []).map((m) => m.toLowerCase().replace(/\//g, '\\'));

    let pids: number[] = [];
    try {
        const out = String(exec('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy', 'Bypass',
            '-Command',
            'Get-Process node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id | ConvertTo-Json -Compress',
        ], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })).trim();
        if (out) {
            const parsed = JSON.parse(out);
            pids = Array.isArray(parsed) ? parsed : [parsed];
        }
    } catch {
        return [];
    }

    const results: OwnedProcessInfo[] = [];
    for (const pid of pids) {
        if (!Number.isFinite(pid) || pid <= 0 || exclude.has(pid)) continue;
        const commandLine = getProcessCommandLine(pid, { platform, execFileSync: exec });
        if (!commandLine) continue;
        const lower = commandLine.toLowerCase();
        const underPrefix = prefixes.some((prefix) => lower.includes(prefix));
        if (!underPrefix) continue;
        if (markers.length > 0 && !markers.some((marker) => lower.includes(marker))) continue;
        results.push({ pid, commandLine });
    }
    return results;
}

export async function stopOwnedProcesses(options: {
    processes: readonly OwnedProcessInfo[];
    waitMs?: number;
} & ProcessLifecycleOptions): Promise<{ stopped: number; survivors: OwnedProcessInfo[] }> {
    const waitMs = options.waitMs ?? 15_000;
    const killed = new Set<number>();

    for (const p of options.processes) {
        if (killProcess(p.pid, options)) killed.add(p.pid);
    }

    const survivors: OwnedProcessInfo[] = [];
    for (const p of options.processes) {
        if (!killed.has(p.pid)) {
            survivors.push(p);
            continue;
        }
        const exited = await waitForPidExit(p.pid, waitMs);
        if (!exited) survivors.push(p);
    }

    // A process counts as stopped only when it left the process table; a failed
    // kill or a post-kill timeout both land it in `survivors`.
    return { stopped: options.processes.length - survivors.length, survivors };
}

export async function stopOwnedProcessesForPrefixes(options: {
    prefixes: readonly string[];
    excludePids?: readonly number[];
    markers?: readonly string[];
    waitMs?: number;
    log?: (message: string) => void;
} & ProcessLifecycleOptions): Promise<{ stopped: number; survivors: OwnedProcessInfo[] }> {
    const processes = listOwnedNodeProcesses(options);
    if (processes.length === 0) return { stopped: 0, survivors: [] };

    options.log?.(`Stopping ${processes.length} owned process(es) under prefixes: ${options.prefixes.join(', ')}`);
    const result = await stopOwnedProcesses({
        processes,
        waitMs: options.waitMs,
        platform: options.platform,
        execFileSync: options.execFileSync,
    });

    if (result.survivors.length > 0) {
        options.log?.(`Could not stop ${result.survivors.length} owned process(es): ${result.survivors.map((s) => s.pid).join(', ')}`);
    }
    return result;
}
