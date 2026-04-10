/**
 * ADHDev — IDE Detector (canonical implementation)
 *
 * Detects installed IDEs on the user's local machine.
 * Supports macOS, Windows, and Linux.
 *
 * Migrated from @adhdev/core — this is now the single source of truth.
 */
import type { ProviderLoader } from '../providers/provider-loader.js';
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
export declare function registerIDEDefinition(def: IDEDefinition): void;
export declare function detectIDEs(providerLoader?: ProviderLoader): Promise<IDEInfo[]>;
