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
        idleFinishConfirm: number;
        statusActivityHold: number;
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

export function resolveCliAdapterConfig(provider: CliProviderModule): ResolvedCliAdapterConfig {
    const t = provider.timeouts || {};
    const rawKeys = provider.approvalKeys;

    return {
        timeouts: {
            ptyFlush: t.ptyFlush ?? 50,
            dialogAccept: t.dialogAccept ?? 300,
            approvalCooldown: t.approvalCooldown ?? 3000,
            generatingIdle: t.generatingIdle ?? 6000,
            idleFinish: t.idleFinish ?? 5000,
            idleFinishConfirm: t.idleFinishConfirm ?? 2000,
            statusActivityHold: t.statusActivityHold ?? 2000,
            maxResponse: t.maxResponse ?? 300000,
            shutdownGrace: t.shutdownGrace ?? 1000,
            outputSettle: t.outputSettle ?? 300,
        },
        approvalKeys: (rawKeys && typeof rawKeys === 'object') ? rawKeys : {},
        sendDelayMs: typeof provider.sendDelayMs === 'number' ? Math.max(0, provider.sendDelayMs) : 0,
        sendKey: typeof provider.sendKey === 'string' && provider.sendKey.length > 0
            ? provider.sendKey
            : '\r',
        submitStrategy: provider.submitStrategy === 'immediate' ? 'immediate' : 'wait_for_echo',
        providerResolutionMeta: {
            type: provider.type,
            name: provider.name,
            resolvedVersion: provider._resolvedVersion || null,
            resolvedOs: provider._resolvedOs || null,
            providerDir: provider._resolvedProviderDir || null,
            scriptDir: provider._resolvedScriptDir || null,
            scriptsPath: provider._resolvedScriptsPath || null,
            scriptsSource: provider._resolvedScriptsSource || null,
            versionWarning: provider._versionWarning || null,
        },
    };
}
