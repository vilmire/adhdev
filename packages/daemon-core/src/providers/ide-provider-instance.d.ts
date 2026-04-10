/**
 * IdeProviderInstance — Runtime instance for IDE Provider
 *
 * Within a single IDE:
 * 1. Native chat (readChat via CDP)
 * 2. Extension agents (Cline, Roo Code etc)
 *
 * IDE Instance manages child Extension Instances.
 * Daemon collects all via a single IDE Instance.getState() call.
 */
import type { ProviderModule } from './contracts.js';
import type { ProviderInstance, ProviderState, InstanceContext } from './provider-instance.js';
import { ExtensionProviderInstance } from './extension-provider-instance.js';
export declare class IdeProviderInstance implements ProviderInstance {
    readonly type: string;
    readonly category: "ide";
    private provider;
    private context;
    private settings;
    private events;
    private tickErrorCount;
    private cachedChat;
    private currentStatus;
    private lastAgentStatuses;
    private generatingStartedAt;
    private tickBusy;
    private monitor;
    private historyWriter;
    private autoApproveBusy;
    private appliedEffectKeys;
    private runtimeMessages;
    private ideVersion;
    private instanceId;
    private workspace;
    private extensions;
    constructor(provider: ProviderModule, instanceKey?: string);
    init(context: InstanceContext): Promise<void>;
    onTick(): Promise<void>;
    getState(): ProviderState;
    onEvent(event: string, data?: any): void;
    dispose(): void;
    updateSettings(newSettings: Record<string, any>): void;
    /** Extension Instance add */
    addExtension(provider: ProviderModule, settings?: Record<string, any>): Promise<void>;
    /** Extension Instance remove */
    removeExtension(type: string): void;
    /** Extension Instance Import */
    getExtension(type: string): ExtensionProviderInstance | undefined;
    /** Child Extension list */
    getExtensionTypes(): string[];
    /** Query UUID instanceId */
    getInstanceId(): string;
    /** all Extension Instance list */
    getExtensionInstances(): ExtensionProviderInstance[];
    /** Set workspace from daemon launch context */
    setWorkspace(workspace: string): void;
    private readChat;
    private getReadChatScript;
    private detectAgentTransitions;
    private pushEvent;
    private applyProviderResponse;
    private appendRuntimeSystemMessage;
    private mergeConversationMessages;
    private getPersistedEffectContent;
    private getEffectDedupKey;
    private flushEvents;
    updateCdp(cdp: InstanceContext['cdp']): void;
    private canAutoApprove;
    private autoApproveViaScript;
}
