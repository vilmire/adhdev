/**
 * ExtensionProviderInstance — Runtime instance for Extension Provider
 *
 * Manages IDE extensions (Cline, Roo Code, etc).
 * CDP webview discovery + agent stream collection moved here.
 */
import type { ProviderModule } from './contracts.js';
import type { ProviderInstance, ProviderState, InstanceContext } from './provider-instance.js';
export declare class ExtensionProviderInstance implements ProviderInstance {
    readonly type: string;
    readonly category: "extension";
    private provider;
    private context;
    private settings;
    private events;
    private currentStatus;
    private agentStreams;
    private messages;
    private prevMessageHashes;
    private activeModal;
    private currentModel;
    private currentMode;
    private controlValues;
    private appliedEffectKeys;
    private runtimeMessages;
    private lastAgentStatus;
    private generatingStartedAt;
    private monitor;
    private historyWriter;
    private instanceId;
    private ideType;
    private chatId;
    private chatTitle;
    private agentName;
    private extensionId;
    constructor(provider: ProviderModule);
    init(context: InstanceContext): Promise<void>;
    onTick(): Promise<void>;
    getState(): ProviderState;
    onEvent(event: string, data?: any): void;
    dispose(): void;
    updateSettings(newSettings: Record<string, any>): void;
    /** Query UUID instanceId */
    getInstanceId(): string;
    private detectTransition;
    private pushEvent;
    private applyProviderResponse;
    private appendRuntimeSystemMessage;
    /**
     * Assign stable receivedAt to extension messages.
     * Same pattern as IdeProviderInstance.readChat() prevByHash —
     * preserves first-seen timestamp across polling cycles.
     */
    private assignReceivedAt;
    private mergeConversationMessages;
    private getPersistedEffectContent;
    private getEffectDedupKey;
    private flushEvents;
    private resolveChatTitle;
    private resetStreamState;
}
