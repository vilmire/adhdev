/**
 * ADHDev Launcher — Extension Installer
 * 
 * Installs VS Code extensions via CLI commands.
 * Supports installing user-selected AI extensions.
 */

import { execSync, exec } from 'child_process';
import { IDEInfo } from './detection/ide-detector.js';

export interface ExtensionInfo {
    id: string;
    name: string;
    displayName: string;
    marketplaceId: string;
    description: string;
    category: 'ai-agent' | 'utility';
    icon: string;
    recommended: boolean;
    requiresApiKey?: boolean;
    apiKeyName?: string;
    website?: string;
    vsixUrl?: string;  // VSIX download URL (used instead of marketplace)
}

/** Available extensions catalog */
export const EXTENSION_CATALOG: ExtensionInfo[] = [
 // AI Agent extensions
    {
        id: 'roo-code',
        name: 'Roo Code',
        displayName: 'Roo Code (Roo Cline)',
        marketplaceId: 'rooveterinaryinc.roo-cline',
        description: 'Open-source AI coding assistant with multiple modes',
        category: 'ai-agent',
        icon: '🦘',
        recommended: true,
        website: 'https://roocode.com',
    },
    {
        id: 'github-copilot',
        name: 'GitHub Copilot',
        displayName: 'GitHub Copilot',
        marketplaceId: 'github.copilot',
        description: 'AI pair programmer by GitHub',
        category: 'ai-agent',
        icon: '🤖',
        recommended: true,
        requiresApiKey: true,
        apiKeyName: 'GitHub account',
        website: 'https://github.com/features/copilot',
    },
    {
        id: 'copilot-chat',
        name: 'GitHub Copilot Chat',
        displayName: 'GitHub Copilot Chat',
        marketplaceId: 'github.copilot-chat',
        description: 'Chat interface for GitHub Copilot',
        category: 'ai-agent',
        icon: '💬',
        recommended: true,
        requiresApiKey: true,
        apiKeyName: 'GitHub account',
    },
    {
        id: 'cline',
        name: 'Cline',
        displayName: 'Cline',
        marketplaceId: 'saoudrizwan.claude-dev',
        description: 'Autonomous AI coding agent in your IDE',
        category: 'ai-agent',
        icon: '🧠',
        recommended: false,
        requiresApiKey: true,
        apiKeyName: 'Anthropic/OpenAI API key',
    },
    {
        id: 'claude-code-vscode',
        name: 'Claude Code',
        displayName: 'Claude Code (Anthropic)',
        marketplaceId: 'anthropic.claude-code',
        description: 'Anthropic Claude Code agent in VS Code–compatible editors',
        category: 'ai-agent',
        icon: '🟠',
        recommended: true,
        requiresApiKey: true,
        apiKeyName: 'Anthropic account',
        website: 'https://www.anthropic.com/claude-code',
    },
    {
        id: 'continue',
        name: 'Continue',
        displayName: 'Continue',
        marketplaceId: 'continue.continue',
        description: 'Open-source AI code assistant with custom models',
        category: 'ai-agent',
        icon: '▶️',
        recommended: false,
    },
    {
        id: 'aider',
        name: 'Aider',
        displayName: 'Aider',
        marketplaceId: 'aider.aider',
        description: 'AI pair programming in your terminal',
        category: 'ai-agent',
        icon: '🔧',
        recommended: false,
        requiresApiKey: true,
        apiKeyName: 'OpenAI/Anthropic API key',
    },
];

export interface InstallResult {
    extensionId: string;
    marketplaceId: string;
    success: boolean;
    alreadyInstalled: boolean;
    error?: string;
}

/**
 * Check if an extension is already installed
 */
export function isExtensionInstalled(
    ide: IDEInfo,
    marketplaceId: string
): boolean {
    if (!ide.cliCommand) return false;

    try {
        const result = execSync(`"${ide.cliCommand}" --list-extensions`, {
            encoding: 'utf-8',
            timeout: 15000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        const installed = result
            .trim()
            .split('\n')
            .map((e) => e.trim().toLowerCase());
        return installed.includes(marketplaceId.toLowerCase());
    } catch {
        return false;
    }
}

/**
 * Install a single extension
 */
export async function installExtension(
    ide: IDEInfo,
    extension: ExtensionInfo
): Promise<InstallResult> {
    if (!ide.cliCommand) {
        return {
            extensionId: extension.id,
            marketplaceId: extension.marketplaceId,
            success: false,
            alreadyInstalled: false,
            error: `No CLI command found for ${ide.displayName}. Please install it manually.`,
        };
    }

 // Check if already installed
    const alreadyInstalled = isExtensionInstalled(ide, extension.marketplaceId);
    if (alreadyInstalled) {
        return {
            extensionId: extension.id,
            marketplaceId: extension.marketplaceId,
            success: true,
            alreadyInstalled: true,
        };
    }

 // If VSIX URL is available, download and install
    if (extension.vsixUrl) {
        try {
            const tmpDir = (await import('os')).tmpdir();
            const vsixPath = `${tmpDir}/adhdev-extension-latest.vsix`;

 // download
            const res = await fetch(extension.vsixUrl);
            if (res.ok) {
                const buffer = Buffer.from(await res.arrayBuffer());
                const fs = await import('fs');
                fs.writeFileSync(vsixPath, buffer);

 // Install VSIX
                return new Promise((resolve) => {
                    const cmd = `"${ide.cliCommand}" --install-extension "${vsixPath}" --force`;
                    exec(cmd, { timeout: 60000 }, (error, _stdout, stderr) => {
                        resolve({
                            extensionId: extension.id,
                            marketplaceId: extension.marketplaceId,
                            success: !error,
                            alreadyInstalled: false,
                            error: error ? (stderr || error.message) : undefined,
                        });
                    });
                });
            }
 // Fall back to marketplace install if VSIX download fails
        } catch (e: any) {
 // Fall back to marketplace install if VSIX download fails
        }
    }

 // Install via CLI (marketplace)
    return new Promise((resolve) => {
        const cmd = `"${ide.cliCommand}" --install-extension ${extension.marketplaceId} --force`;

        exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
            if (error) {
                resolve({
                    extensionId: extension.id,
                    marketplaceId: extension.marketplaceId,
                    success: false,
                    alreadyInstalled: false,
                    error: stderr || error.message,
                });
            } else {
                resolve({
                    extensionId: extension.id,
                    marketplaceId: extension.marketplaceId,
                    success: true,
                    alreadyInstalled: false,
                });
            }
        });
    });
}

/**
 * Install multiple extensions sequentially
 */
export async function installExtensions(
    ide: IDEInfo,
    extensions: ExtensionInfo[],
    onProgress?: (current: number, total: number, ext: ExtensionInfo, result: InstallResult) => void
): Promise<InstallResult[]> {
    const results: InstallResult[] = [];

    for (let i = 0; i < extensions.length; i++) {
        const ext = extensions[i];
        const result = await installExtension(ide, ext);
        results.push(result);
        onProgress?.(i + 1, extensions.length, ext, result);
    }

    return results;
}

/**
 * Get AI agent extensions
 */
export function getAIExtensions(): ExtensionInfo[] {
    return EXTENSION_CATALOG.filter((e) => e.category === 'ai-agent');
}



/**
 * Launch IDE after installation
 */
export function launchIDE(ide: IDEInfo, workspacePath?: string): boolean {
    if (!ide.cliCommand) return false;

    try {
        const args = workspacePath ? `"${workspacePath}"` : '';
        exec(`"${ide.cliCommand}" ${args}`, { timeout: 10000 });
        return true;
    } catch {
        return false;
    }
}
