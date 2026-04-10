import type { CliProviderModule } from './provider-cli-shared.js';
export interface ProviderResolutionMeta {
    type: string;
    name: string;
    resolvedVersion: string | null;
    resolvedOs: string | null;
    providerDir: string | null;
    scriptDir: string | null;
    scriptsPath: string | null;
    scriptsSource: string | null;
    versionWarning: string | null;
}
export interface ResolvedCliAdapterConfig {
    timeouts: {
        ptyFlush: number;
        dialogAccept: number;
        approvalCooldown: number;
        generatingIdle: number;
        idleFinish: number;
        maxResponse: number;
        shutdownGrace: number;
        outputSettle: number;
    };
    approvalKeys: Record<number, string>;
    sendDelayMs: number;
    sendKey: string;
    submitStrategy: 'wait_for_echo' | 'immediate';
    providerResolutionMeta: ProviderResolutionMeta;
}
export declare function resolveCliAdapterConfig(provider: CliProviderModule): ResolvedCliAdapterConfig;
