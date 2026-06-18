/**
 * ADHDev — IDE Detector (canonical implementation)
 * 
 * Detects installed IDEs on the user's local machine.
 * Supports macOS, Windows, and Linux.
 * 
 * Migrated from @adhdev/core — this is now the single source of truth.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);
import { existsSync, statSync } from 'fs';
import { platform, homedir } from 'os';
import * as path from 'path';
import type { ProviderLoader } from '../providers/provider-loader.js';
import { isKnownWin32GuiExe, readWin32IdeVersionFromDisk } from './win32-ide-version.js';

// ─── Types ──────────────────────────────────────

export interface IDEInfo {
    id: string;
    name: string;
    displayName: string;
    installed: boolean;
    path: string | null;
    cliCommand: string | null;
    version: string | null;
    icon: string;
    notes?: string;
}

export interface IDEDefinition {
    id: string;
    name: string;
    displayName: string;
    icon: string;
    cli: string;
    paths: {
        darwin?: string[];
        win32?: string[];
        linux?: string[];
        [key: string]: string[] | undefined;
    };
}

// No builtin IDE definitions — provider.js registered via registerToDetector() is the single source of truth
// To add new IDE: create providers in ~/.adhdev/providers/ide/{name}/provider.js
const BUILTIN_IDE_DEFINITIONS: IDEDefinition[] = [];

// ─── Runtime Registry ───────────────────────────
const registeredIDEs = new Map<string, IDEDefinition>();

export function registerIDEDefinition(def: IDEDefinition): void {
    registeredIDEs.set(def.id, def);
}

function getMergedDefinitions(): IDEDefinition[] {
    const merged = new Map<string, IDEDefinition>();
    for (const def of BUILTIN_IDE_DEFINITIONS) {
        merged.set(def.id, def);
    }
    for (const [id, def] of registeredIDEs) {
        merged.set(id, def);
    }
    return [...merged.values()];
}

function findCliCommand(command: string): string | null {
    const trimmed = String(command || '').trim();
    if (!trimmed) return null;
    if (path.isAbsolute(trimmed) || trimmed.includes('/') || trimmed.includes('\\') || trimmed.startsWith('~')) {
        const candidate = trimmed.startsWith('~')
            ? path.join(homedir(), trimmed.slice(1))
            : trimmed;
        const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(candidate);
        return existsSync(resolved) ? resolved : null;
    }
    const isWin = platform() === 'win32';
    const paths = (process.env.PATH || '').split(isWin ? ';' : ':');
    const exes = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];
    for (const p of paths) {
        if (!p) continue;
        for (const ext of exes) {
            const fullPath = path.join(p, trimmed + ext);
            try {
                if (existsSync(fullPath)) {
                    const stat = statSync(fullPath);
                    if (stat.isFile() && (isWin || (stat.mode & 0o111))) {
                        return fullPath;
                    }
                }
            } catch { }
        }
    }
    return null;
}

/**
 * Resolve an IDE version on demand (NOT at boot).
 *
 * Order of preference, all spawn-free where possible:
 *  1. win32: read the bundled product.json/package.json next to the exe.
 *  2. Otherwise spawn `<cli> --version` — but ONLY when the binary is not a
 *     known GUI executable (the #4 guard), so we never boot an IDE window.
 *
 * `win32ProcessNames` is provider.json `processNames.win32` (type → exe names),
 * used to recognise GUI executables. Callers that have a ProviderLoader can
 * pass `providerLoader.getWinProcessNames()`.
 */
export async function getIdeVersion(
    cliCommand: string,
    win32ProcessNames: Record<string, string[]> = {},
): Promise<string | null> {
    if (platform() === 'win32') {
        const fromDisk = readWin32IdeVersionFromDisk(cliCommand);
        if (fromDisk) return fromDisk;
        // Refuse to spawn a known GUI exe — it would launch the IDE window.
        if (isKnownWin32GuiExe(cliCommand, win32ProcessNames)) return null;
    }
    try {
        const { stdout } = await execAsync(`"${cliCommand}" --version`, {
            encoding: 'utf-8',
            timeout: 10000,
        });
        return stdout.trim().split('\n')[0] || null;
    } catch {
        return null;
    }
}

function checkPathExists(paths: string[]): string | null {
    const home = homedir();
    for (const p of paths) {
        const normalized = p.startsWith('~')
            ? path.join(home, p.slice(1))
            : p;
        if (normalized.includes('*')) {
            // Wildcard expansion: replace `*` with the current user's home folder name
            // e.g. "C:\Users\*\AppData\..." → "C:\Users\vilmi\AppData\..."
            const username = home.split(/[\\/]/).pop() || '';
            const resolved = normalized.replace('*', username);
            if (existsSync(resolved)) return resolved;
        } else {
            if (existsSync(normalized)) return normalized;
        }
    }
    return null;
}

export async function detectIDEs(providerLoader?: ProviderLoader): Promise<IDEInfo[]> {
    const os = platform() as 'darwin' | 'win32' | 'linux';
    const results: IDEInfo[] = [];

    for (const def of getMergedDefinitions()) {
        const cliPath = findCliCommand(providerLoader?.getIdeCliCommand(def.id, def.cli) || def.cli);
        const appPath = checkPathExists(providerLoader?.getIdePathCandidates(def.id, def.paths[os] || []) || []);

        let resolvedCli = cliPath;

        if (!resolvedCli && appPath && os === 'darwin') {
            const bundledCli = `${appPath}/Contents/Resources/app/bin/${def.cli}`;
            if (existsSync(bundledCli)) resolvedCli = bundledCli;
        }

        if (!resolvedCli && appPath && os === 'win32') {
            const { dirname } = await import('path');
            const appDir = dirname(appPath);
            const candidates = [
                `${appDir}\\\\bin\\\\${def.cli}.cmd`,
                `${appDir}\\\\bin\\\\${def.cli}`,
                `${appDir}\\\\${def.cli}.cmd`,
                `${appDir}\\\\${def.cli}.exe`,
                `${appDir}\\\\resources\\\\app\\\\bin\\\\${def.cli}.cmd`,
            ];
            for (const c of candidates) {
                if (existsSync(c)) {
                    resolvedCli = c;
                    break;
                }
            }
        }

        const installed = os === 'darwin'
            ? !!(resolvedCli || appPath)
            : !!resolvedCli;
        // Boot-time IDE detection must NOT spawn `<cli> --version`. On Windows
        // the resolved "CLI" is frequently the GUI Electron exe (case-insensitive
        // FS matches `...\cursor\cursor.exe` against `Cursor.exe`), and running it
        // with `--version` boots the IDE window. `installed` is decided purely by
        // existsSync above, and the dashboard drops `version` anyway — the only
        // real version consumer is provider-loader.resolve() at CDP attach time,
        // which fetches the version lazily. So leave it null here.
        const version: string | null = null;

        results.push({
            id: def.id,
            name: def.name,
            displayName: def.displayName,
            installed,
            path: appPath || cliPath,
            cliCommand: resolvedCli || null,
            version,
            icon: def.icon,
        });
    }

    return results;
}
