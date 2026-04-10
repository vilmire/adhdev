/**
 * CLI AI Agent Detector
 *
 * Dynamic CLI detection based on Provider.
 * Reads spawn.command from cli/acp categories via ProviderLoader to check installation.
 *
 * Uses parallel execution for fast detection across many providers.
 */
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
/**
 * Detect all CLI/ACP agents (parallel)
 * @param providerLoader ProviderLoader instance (dynamic list creation)
 */
export declare function detectCLIs(providerLoader?: ProviderLoader, options?: {
    includeVersion?: boolean;
}): Promise<CLIInfo[]>;
/** Detect specific CLI — only probes the one requested provider */
export declare function detectCLI(cliId: string, providerLoader?: ProviderLoader, options?: {
    includeVersion?: boolean;
}): Promise<CLIInfo | null>;
