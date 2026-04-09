/**
 * CLI AI Agent Detector
 * 
 * Dynamic CLI detection based on Provider.
 * Reads spawn.command from cli/acp categories via ProviderLoader to check installation.
 * 
 * Uses parallel execution for fast detection across many providers.
 */

import { exec } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { existsSync } from 'fs';
import type { ProviderLoader } from '../providers/provider-loader.js';

export interface CLIInfo {
    id: string;
    displayName: string;
    icon: string;
    command: string;
    versionCommand?: string;
    installed: boolean;
    version?: string;
    path?: string;
    category?: string;
}

function parseVersion(raw: string): string {
    const match = raw.match(/v?(\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.]+)?)/);
    return match ? match[1] : raw.split('\n')[0].slice(0, 100);
}

function shellQuote(value: string): string {
    if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(value)) return value;
    return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function expandHome(value: string): string {
    const trimmed = value.trim();
    if (!trimmed.startsWith('~')) return trimmed;
    return path.join(os.homedir(), trimmed.slice(1));
}

function isExplicitCommandPath(command: string): boolean {
    const trimmed = command.trim();
    return path.isAbsolute(trimmed) || trimmed.includes('/') || trimmed.includes('\\') || trimmed.startsWith('~');
}

function resolveCommandPath(command: string): string | null {
    const trimmed = command.trim();
    if (!trimmed) return null;
    if (isExplicitCommandPath(trimmed)) {
        const expanded = expandHome(trimmed);
        const candidate = path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
        return existsSync(candidate) ? candidate : null;
    }
    return null;
}

/** Run a shell command with timeout, returning stdout or null on failure */
function execAsync(cmd: string, timeoutMs = 5000): Promise<string | null> {
    return new Promise((resolve) => {
        const child = exec(cmd, { encoding: 'utf-8', timeout: timeoutMs }, (err, stdout) => {
            if (err || !stdout?.trim()) {
                resolve(null);
            } else {
                resolve(stdout.trim());
            }
        });
        // Safety: kill on timeout
        child.on('error', () => resolve(null));
    });
}

/**
 * Detect all CLI/ACP agents (parallel)
 * @param providerLoader ProviderLoader instance (dynamic list creation)
 */
export async function detectCLIs(
    providerLoader?: ProviderLoader,
    options?: { includeVersion?: boolean },
): Promise<CLIInfo[]> {
    const platform = os.platform();
    const whichCmd = platform === 'win32' ? 'where' : 'which';
    const includeVersion = options?.includeVersion !== false;

    // Provider-based dynamic list creation, fallback is empty array
    const cliList = providerLoader
        ? providerLoader.getCliDetectionList()
        : [];

    // Run all `which` checks in parallel
    const results = await Promise.all(
        cliList.map(async (cli): Promise<CLIInfo> => {
            try {
                const explicitPath = resolveCommandPath(cli.command);
                const pathResult = explicitPath || await execAsync(`${whichCmd} ${shellQuote(cli.command)}`);
                if (!pathResult) return { ...cli, installed: false };

                const firstPath = explicitPath || pathResult.split('\n')[0];

                // Get version (parallel with other checks)
                let version: string | undefined;
                if (includeVersion) {
                    const versionCommands = [
                        `"${firstPath}" --version`,
                        `"${firstPath}" -V`,
                        `"${firstPath}" -v`,
                        cli.versionCommand,
                    ].filter((v): v is string => !!v);
                    try {
                        for (const versionCommand of versionCommands) {
                            const versionResult = await execAsync(versionCommand, 3000);
                            if (versionResult) {
                                version = parseVersion(versionResult);
                                break;
                            }
                        }
                    } catch { }
                }

                return { ...cli, installed: true, version, path: firstPath };
            } catch {
                return { ...cli, installed: false };
            }
        })
    );

    return results;
}

/** Detect specific CLI — only probes the one requested provider */
export async function detectCLI(
    cliId: string,
    providerLoader?: ProviderLoader,
    options?: { includeVersion?: boolean },
): Promise<CLIInfo | null> {
    const resolvedId = providerLoader ? providerLoader.resolveAlias(cliId) : cliId;

    if (providerLoader) {
        const cliList = providerLoader.getCliDetectionList();
        const target = cliList.find((c) => c.id === resolvedId);
        if (target) {
            const platform = os.platform();
            const whichCmd = platform === 'win32' ? 'where' : 'which';
            try {
                const explicitPath = resolveCommandPath(target.command);
                const pathResult = explicitPath || await execAsync(`${whichCmd} ${shellQuote(target.command)}`);
                if (!pathResult) return null;
                const firstPath = explicitPath || pathResult.split('\n')[0];
                let version: string | undefined;
                if (options?.includeVersion !== false) {
                    const versionCommands = [
                        `"${firstPath}" --version`,
                        `"${firstPath}" -V`,
                        `"${firstPath}" -v`,
                        target.versionCommand,
                    ].filter((v): v is string => !!v);
                    try {
                        for (const versionCommand of versionCommands) {
                            const versionResult = await execAsync(versionCommand, 3000);
                            if (versionResult) {
                                version = parseVersion(versionResult);
                                break;
                            }
                        }
                    } catch { }
                }
                return { ...target, installed: true, version, path: firstPath };
            } catch {
                return null;
            }
        }
    }

    // Fallback: full scan for unknown provider IDs
    const all = await detectCLIs(providerLoader, options);
    return all.find((c) => c.id === resolvedId && c.installed) || null;
}
