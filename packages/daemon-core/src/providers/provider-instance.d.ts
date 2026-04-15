/**
 * ProviderInstance — Provider runtime lifecycle
 *
 * provider.js = static config/scripts
 * ProviderInstance = runtime status management + lifecycle
 *
 * Daemon only collects via ProviderInstance.getState(),
 * Each Instance manages its own status.
 */
import type { ProviderResumeCapability } from './contracts.js';
import type { AcpConfigOption, AcpMode, ProviderControlSchema, ProviderSummaryMetadata } from '../shared-types.js';
import type { ChatMessage } from '../types.js';
export type ProviderStatus = 'idle' | 'generating' | 'waiting_approval' | 'error' | 'stopped' | 'starting';
export interface ProviderRuntimeWriteOwner {
    clientId: string;
    ownerType: 'agent' | 'user';
}
export interface ProviderRuntimeClient {
    clientId: string;
    type: 'daemon' | 'web' | 'local-terminal';
    readOnly: boolean;
}
export interface ProviderRuntimeInfo {
    runtimeId: string;
    runtimeKey?: string;
    displayName?: string;
    workspaceLabel?: string;
    writeOwner?: ProviderRuntimeWriteOwner | null;
    attachedClients?: ProviderRuntimeClient[];
}
export interface ActiveChatData {
    id: string;
    title: string;
    status: string;
    messages: ChatMessage[];
    activeModal: {
        message: string;
        buttons: string[];
    } | null;
    inputContent?: string;
}
/** Standardized error reasons across all provider categories */
export type ProviderErrorReason = 'not_installed' | 'auth_failed' | 'spawn_error' | 'init_failed' | 'crash' | 'timeout' | 'cdp_error' | 'disconnected';
/** Common fields shared by all provider categories */
interface ProviderStateBase {
    /** Provider type (e.g. 'gemini-cli', 'cursor', 'cline') */
    type: string;
    /** Provider Display name */
    name: string;
    /** current status */
    status: ProviderStatus;
    /** chat data */
    activeChat: ActiveChatData | null;
    /** Workspace — project path or name (all categories) */
    workspace?: string | null;
    /** Runtime info (real-time detection) */
    /** Error details (when status === 'error') */
    errorMessage?: string;
    errorReason?: ProviderErrorReason;
    /** meta */
    instanceId: string;
    providerSessionId?: string;
    lastUpdated: number;
    settings: Record<string, any>;
    /** Event queue (cleared after daemon collects) */
    pendingEvents: ProviderEvent[];
    runtime?: ProviderRuntimeInfo;
    resume?: ProviderResumeCapability;
    /** Dynamic control current values */
    controlValues?: Record<string, string | number | boolean>;
    /** Provider-declared controls schema (from provider.controls) */
    providerControls?: ProviderControlSchema[];
    /** Flexible always-visible metadata for compact/live surfaces. */
    summaryMetadata?: ProviderSummaryMetadata;
}
/** IDE provider state */
export interface IdeProviderState extends ProviderStateBase {
    category: 'ide';
    cdpConnected: boolean;
    /** IDE child Extension Instance status */
    extensions: ProviderState[];
}
/** CLI provider state */
export interface CliProviderState extends ProviderStateBase {
    category: 'cli';
    /** terminal = PTY stream, chat = parsed conversation */
    mode: 'terminal' | 'chat';
}
/** ACP provider state */
export interface AcpProviderState extends ProviderStateBase {
    category: 'acp';
    mode: 'chat';
    /** ACP config options (model/mode selection) */
    acpConfigOptions?: AcpConfigOption[];
    /** ACP available modes */
    acpModes?: AcpMode[];
}
/** Extension provider state */
export interface ExtensionProviderState extends ProviderStateBase {
    category: 'extension';
    agentStreams?: any[];
}
/** Discriminated union — switch on `.category` */
export type ProviderState = IdeProviderState | CliProviderState | AcpProviderState | ExtensionProviderState;
export interface ProviderEvent {
    event: string;
    timestamp: number;
    [key: string]: any;
}
export interface InstanceContext {
    /** CDP connection (IDE/Extension) */
    cdp?: {
        isConnected: boolean;
        evaluate(script: string, timeout?: number): Promise<unknown>;
        evaluateInWebviewFrame?(expression: string, matchFn?: (bodyPreview: string) => boolean): Promise<string | null>;
        discoverAgentWebviews?(): Promise<any[]>;
        /** Low-level CDP protocol method (e.g. Input.dispatchMouseEvent) */
        send?(method: string, params?: Record<string, unknown>): Promise<unknown>;
    };
    /** Server log transmit */
    serverConn?: {
        sendMessage(type: string, data: any): void;
    };
    /** P2P PTY output transmit */
    onPtyData?: (data: string) => void;
    /** Provider configvalue (resolved) */
    settings: Record<string, any>;
}
export interface ProviderInstance {
    /** Provider type */
    readonly type: string;
    /** Provider category */
    readonly category: 'cli' | 'ide' | 'extension' | 'acp';
    /** initialize */
    init(context: InstanceContext): Promise<void>;
    /** Tick — periodic status refresh (IDE: readChat, Extension: stream collection) */
    onTick(): Promise<void>;
    /** Return current status */
    getState(): ProviderState;
    /** Receive event (external → Instance) */
    onEvent(event: string, data?: any): void;
    /** Update settings at runtime (called when user changes settings from dashboard) */
    updateSettings?(newSettings: Record<string, any>): void;
    /** cleanup */
    dispose(): void;
}
export {};
