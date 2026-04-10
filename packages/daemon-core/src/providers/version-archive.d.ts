/**
 * Provider Version Detection & Archiving
 *
 * Detects installed versions for all provider categories (IDE, CLI, ACP, Extension).
 * Archives version history to ~/.adhdev/version-history.json for compatibility tracking.
 *
 * Usage:
 *   const archive = new VersionArchive();
 *   const results = await detectAllVersions(providerLoader, archive);
 */
import type { ProviderLoader } from './provider-loader.js';
export interface ProviderVersionInfo {
    type: string;
    name: string;
    category: string;
    installed: boolean;
    version: string | null;
    path: string | null;
    binary: string | null;
    detectedAt: string;
    /**
     * Set when the detected version is NOT listed in provider.json testedVersions.
     * Means scripts may not work correctly with this version.
     */
    warning?: string;
}
export interface VersionHistoryEntry {
    version: string;
    detectedAt: string;
    os: string;
}
export interface VersionHistory {
    [providerType: string]: VersionHistoryEntry[];
}
export declare class VersionArchive {
    private history;
    constructor();
    private load;
    /** Record a detected version (deduplicates same version) */
    record(type: string, version: string): void;
    /** Get version history for a provider */
    getHistory(type: string): VersionHistoryEntry[];
    /** Get latest known version for a provider */
    getLatest(type: string): string | null;
    /** Get full archive */
    getAll(): VersionHistory;
    private save;
}
/**
 * Detect versions for all loaded providers
 */
export declare function detectAllVersions(loader: ProviderLoader, archive?: VersionArchive): Promise<ProviderVersionInfo[]>;
