/**
 * ADHDev — IDE Detector (canonical implementation)
 * 
 * Detects installed IDEs on the user's local machine.
 * Supports macOS, Windows, and Linux.
 * 
 * Migrated from @adhdev/core — this is now the single source of truth.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { platform, homedir } from 'os';

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
    try {
        const result = execSync(
            platform() === 'win32' ? `where ${command}` : `which ${command}`,
            { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        return result.split('\n')[0] || null;
    } catch {
        return null;
    }
}

function getIdeVersion(cliCommand: string): string | null {
    try {
        const result = execSync(`"${cliCommand}" --version`, {
            encoding: 'utf-8',
            timeout: 10000,
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        return result.split('\n')[0] || null;
    } catch {
        return null;
    }
}

function checkPathExists(paths: string[]): string | null {
    const home = homedir();
    for (const p of paths) {
        if (p.includes('*')) {
            // Wildcard expansion: replace `*` with the current user's home folder name
            // e.g. "C:\Users\*\AppData\..." → "C:\Users\vilmi\AppData\..."
            const username = home.split(/[\\/]/).pop() || '';
            const resolved = p.replace('*', username);
            if (existsSync(resolved)) return resolved;
        } else {
            if (existsSync(p)) return p;
        }
    }
    return null;
}

export async function detectIDEs(): Promise<IDEInfo[]> {
    const os = platform() as 'darwin' | 'win32' | 'linux';
    const results: IDEInfo[] = [];

    for (const def of getMergedDefinitions()) {
        const cliPath = findCliCommand(def.cli);
        const appPath = checkPathExists(def.paths[os] || []);
        const installed = !!(cliPath || appPath);

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

        const version = resolvedCli ? getIdeVersion(resolvedCli) : null;

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
