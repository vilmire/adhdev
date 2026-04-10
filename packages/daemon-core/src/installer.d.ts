/**
 * ADHDev Launcher — Extension Installer
 *
 * Installs VS Code extensions via CLI commands.
 * Supports installing user-selected AI extensions.
 */
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
    vsixUrl?: string;
}
/** Available extensions catalog */
export declare const EXTENSION_CATALOG: ExtensionInfo[];
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
export declare function isExtensionInstalled(ide: IDEInfo, marketplaceId: string): boolean;
/**
 * Install a single extension
 */
export declare function installExtension(ide: IDEInfo, extension: ExtensionInfo): Promise<InstallResult>;
/**
 * Install multiple extensions sequentially
 */
export declare function installExtensions(ide: IDEInfo, extensions: ExtensionInfo[], onProgress?: (current: number, total: number, ext: ExtensionInfo, result: InstallResult) => void): Promise<InstallResult[]>;
/**
 * Get AI agent extensions
 */
export declare function getAIExtensions(): ExtensionInfo[];
/**
 * Launch IDE after installation
 */
export declare function launchIDE(ide: IDEInfo, workspacePath?: string): boolean;
