/**
 * AcpProviderInstance — ACP (Agent Client Protocol) Provider runtime instance
 *
 * Spawns ACP agent process and communicates via the official ACP SDK.
 * Uses ClientSideConnection + ndJsonStream for structured protocol communication.
 *
 * ACP spec: https://agentclientprotocol.com
 * ACP SDK: @agentclientprotocol/sdk@0.16.1
 *
 * lifecycle:
 * 1. init() → Spawn agent process + ACP initialize handshake
 * 2. onTick() → no-op (ACP event based)
 * 3. getState() → ProviderState return (dashboard for display)
 * 4. onEvent('send_message') → session/prompt transmit
 * 5. dispose() → kill process
 */
import type { ProviderModule, ContentBlock } from './contracts.js';
import type { ProviderInstance, AcpProviderState, InstanceContext } from './provider-instance.js';
export declare class AcpProviderInstance implements ProviderInstance {
    private cliArgs;
    readonly type: string;
    readonly category: "acp";
    private readonly log;
    private provider;
    private context;
    private settings;
    private events;
    private monitor;
    private process;
    private connection;
    private sessionId;
    private messages;
    private currentStatus;
    private lastStatus;
    private generatingStartedAt;
    private agentCapabilities;
    private currentModel;
    private currentMode;
    private activeToolCalls;
    private stopReason;
    private partialContent;
    /** Rich content blocks accumulated during streaming */
    private partialBlocks;
    /** Tool calls collected during current turn */
    private turnToolCalls;
    private errorMessage;
    private errorReason;
    private stderrBuffer;
    private spawnedAt;
    private configOptions;
    private availableModes;
    /** Static config mode — agent doesn't support config/* methods */
    private useStaticConfig;
    /** Current config selections (for spawnArgBuilder) */
    private selectedConfig;
    private workingDir;
    private instanceId;
    constructor(provider: ProviderModule, workingDir: string, cliArgs?: string[]);
    init(context: InstanceContext): Promise<void>;
    onTick(): Promise<void>;
    getState(): AcpProviderState;
    onEvent(event: string, data?: any): void;
    getInstanceId(): string;
    private parseConfigOptions;
    private parseModes;
    setConfigOption(category: string, value: string): Promise<void>;
    setMode(modeId: string): Promise<void>;
    /** Static config: kill process and restart with new args */
    private restartWithNewConfig;
    /** Update settings at runtime (called when user changes settings from dashboard) */
    updateSettings(newSettings: Record<string, any>): void;
    dispose(): void;
    private spawnAgent;
    private createClient;
    private initialize;
    private createSession;
    sendPrompt(text: string, contentBlocks?: ContentBlock[]): Promise<void>;
    private cancelSession;
    private permissionResolvers;
    resolvePermission(approved: boolean): Promise<void>;
    private handleSessionUpdate;
    /** Handle legacy session/update formats (pre-standardization compat) */
    private handleLegacyUpdate;
    /** Map SDK ToolCallStatus to internal status */
    private mapToolCallStatus;
    /** Truncate content for transport (text: 2000 chars, images preserved) */
    private truncateContent;
    /** Build ContentBlock[] from current partial state */
    private buildPartialBlocks;
    /** Finalize streaming content into an assistant message */
    private finalizeAssistantMessage;
    /** Convert ACP ToolCallContent[] to our ToolCallContent[] */
    private convertToolCallContent;
    private detectStatusTransition;
    private pushEvent;
    private appendSystemMessage;
    private flushEvents;
    get cliType(): string;
    get cliName(): string;
    /** ACP Agent capabilities (available after initialize) */
    getCapabilities(): Record<string, any>;
}
