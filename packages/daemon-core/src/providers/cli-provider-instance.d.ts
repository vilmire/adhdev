/**
 * CliProviderInstance — Runtime instance for CLI Provider
 *
 * Lifecycle layer on top of ProviderCliAdapter.
 * collectCliData() + status transition logic from daemon-status.ts moved here.
 */
import type { ProviderModule } from './contracts.js';
import type { ProviderInstance, ProviderState, InstanceContext } from './provider-instance.js';
import { ProviderCliAdapter } from '../cli-adapters/provider-cli-adapter.js';
import type { PtyTransportFactory } from '../cli-adapters/pty-transport.js';
export declare class CliProviderInstance implements ProviderInstance {
    private provider;
    private workingDir;
    private cliArgs;
    readonly type: string;
    readonly category: "cli";
    private adapter;
    private context;
    private events;
    private lastStatus;
    private generatingStartedAt;
    private settings;
    private monitor;
    private generatingDebounceTimer;
    private generatingDebouncePending;
    private lastApprovalEventAt;
    private controlValues;
    private appliedEffectKeys;
    private historyWriter;
    private runtimeMessages;
    readonly instanceId: string;
    private suppressIdleHistoryReplay;
    private presentationMode;
    private providerSessionId?;
    private launchMode;
    private readonly startedAt;
    private onProviderSessionResolved?;
    constructor(provider: ProviderModule, workingDir: string, cliArgs?: string[], instanceId?: string, transportFactory?: PtyTransportFactory, options?: {
        providerSessionId?: string;
        launchMode?: 'new' | 'resume' | 'manual';
        onProviderSessionResolved?: (info: {
            instanceId: string;
            providerType: string;
            providerName: string;
            workspace: string;
            providerSessionId: string;
            previousProviderSessionId?: string;
        }) => void;
    });
    init(context: InstanceContext): Promise<void>;
    onTick(): Promise<void>;
    /**
     * Generic session ID probe using declarative ProviderSessionProbe config.
     * Replaces the previously duplicated probeOpenCode/Codex/Goose functions.
     */
    private probeSessionIdFromConfig;
    getState(): ProviderState;
    setPresentationMode(mode: 'terminal' | 'chat'): void;
    getPresentationMode(): 'terminal' | 'chat';
    updateSettings(newSettings: Record<string, any>): void;
    onEvent(event: string, data?: any): void;
    dispose(): void;
    private completedDebounceTimer;
    private completedDebouncePending;
    private detectStatusTransition;
    private pushEvent;
    private flushEvents;
    private applyProviderResponse;
    private getEffectDedupKey;
    private getPersistedEffectContent;
    getAdapter(): ProviderCliAdapter;
    get cliType(): string;
    get cliName(): string;
    private shouldAutoApprove;
    private recordAutoApproval;
    recordApprovalSelection(buttonText: string): void;
    private formatMarkerTimestamp;
    private maybeAppendRuntimeRecoveryMessage;
    private appendRuntimeSystemMessage;
    private mergeConversationMessages;
    private formatApprovalRequestMessage;
    private promoteProviderSessionId;
    private getProbeDirectories;
    private buildSqlPlaceholderList;
    private querySqliteText;
}
