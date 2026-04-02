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
export async function detectCLIs(providerLoader?: ProviderLoader): Promise<CLIInfo[]> {
    const platform = os.platform();
    const whichCmd = platform === 'win32' ? 'where' : 'which';

    // Provider-based dynamic list creation, fallback is empty array
    const cliList = providerLoader
        ? providerLoader.getCliDetectionList()
        : [];

    // Run all `which` checks in parallel
    const results = await Promise.all(
        cliList.map(async (cli): Promise<CLIInfo> => {
            try {
                const pathResult = await execAsync(`${whichCmd} ${cli.command}`);
                if (!pathResult) return { ...cli, installed: false };

                const firstPath = pathResult.split('\n')[0];

                // Get version (parallel with other checks)
                let version: string | undefined;
                try {
                    const versionCommands = [
                        cli.versionCommand,
                        `${cli.command} --version`,
                        `${cli.command} -V`,
                        `${cli.command} -v`,
                    ].filter((v): v is string => !!v);
                    for (const versionCommand of versionCommands) {
                        const versionResult = await execAsync(versionCommand, 3000);
                        if (versionResult) {
                            version = parseVersion(versionResult);
                            break;
                        }
                    }
                } catch { }

                return { ...cli, installed: true, version, path: firstPath };
            } catch {
                return { ...cli, installed: false };
            }
        })
    );

    return results;
}

/** Detect specific CLI */
export async function detectCLI(cliId: string, providerLoader?: ProviderLoader): Promise<CLIInfo | null> {
    // Resolve alias
    const resolvedId = providerLoader ? providerLoader.resolveAlias(cliId) : cliId;
    const all = await detectCLIs(providerLoader);
    return all.find((c) => c.id === resolvedId && c.installed) || null;
}
