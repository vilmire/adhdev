/**
 * ProviderInstance — Provider runtime lifecycle
 *
 * provider.js = static config/scripts
 * ProviderInstance = runtime status management + lifecycle
 *
 * Daemon only collects via ProviderInstance.getState(),
 * Each Instance manages its own status.
 */

import type { ProviderModule, ProviderSettingDef, ProviderResumeCapability } from './contracts.js';
import type { AcpConfigOption, AcpMode, ProviderControlSchema, ProviderSummaryMetadata, SessionCapability } from '../shared-types.js';
import type { MessageInputSupport } from './provider-input-support.js';
import type { ChatMessage } from '../types.js';
import type { InteractivePrompt } from './types/interactive-prompt.js';

// ─── ProviderState — Discriminated union by category ─────────────

export type ProviderStatus = 'idle' | 'generating' | 'waiting_approval' | 'waiting_choice' | 'error' | 'stopped' | 'starting';

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
    lifecycle?: string | null;
    surfaceKind?: 'live_runtime' | 'recovery_snapshot' | 'inactive_record';
    writeOwner?: ProviderRuntimeWriteOwner | null;
    attachedClients?: ProviderRuntimeClient[];
    restoredFromStorage?: boolean;
    recoveryState?: string | null;
}

export interface ActiveChatData {
    id: string;
    title: string;
    status: string;
    messages: ChatMessage[];
    activeModal: { message: string; buttons: string[] } | null;
    activeInteractivePrompt?: InteractivePrompt | null;
    inputContent?: string;
}

/** Standardized error reasons across all provider categories */
export type ProviderErrorReason =
    | 'not_installed'   // CLI/ACP binary not found
    | 'auth_failed'     // Authentication/API key error
    | 'billing_failed'  // Subscription/payment/account-entitlement error (NOT retryable — the account itself is the problem)
    | 'quota_exceeded'  // Usage window/quota exhausted while the account is otherwise fine — retryable once the window resets
    | 'spawn_error'     // Process spawn failure
    | 'init_failed'     // Initialization/handshake failure
    | 'parse_error'     // Provider parser/adapter script failure
    | 'crash'           // Unexpected process crash
    | 'timeout'         // Operation timeout
    | 'cdp_error'       // CDP connection failure (IDE)
    | 'disconnected';   // Connection lost

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
    activeInteractivePrompt?: InteractivePrompt | null;
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
    sessionCapabilities?: SessionCapability[];
    messageInput?: MessageInputSupport;
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
    /**
     * Queued outbound coordinator messages not yet written to the PTY
     * (ProviderCliAdapter pendingOutboundQueue). The daemon-restart idle-gate
     * treats a non-zero count as restart-blocking so a restart never silently
     * drops a queued message.
     */
    pendingOutboundCount?: number;
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

export interface HotChatSessionState {
    id: string;
    status?: unknown;
    unread?: unknown;
    inboxBucket?: unknown;
    lastMessageAt?: unknown;
    runtimeLifecycle?: unknown;
    runtimeSurfaceKind?: unknown;
    runtimeRestoredFromStorage?: unknown;
    runtimeRecoveryState?: unknown;
}

export interface SessionModalState {
    id: string;
    status?: unknown;
    title?: unknown;
    activeModal?: unknown;
}

// ─── ProviderInstance interface ─────────────────

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
 /** Immediate provider-originated status/event emission. Used to avoid waiting for status polling. */
    emitProviderEvent?: (event: ProviderEvent) => void;
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

    /**
     * MESH-STALL-WATCH (feature 1: STALL detection). Status-agnostic stall
     * watchdog for coordinator-spawned mesh worker sessions, invoked from the
     * ProviderInstanceManager's existing tick loop (no separate timer). Fires ONE
     * informational monitor:no_progress event when a live worker's raw PTY output
     * has been unchanged past the stall threshold. Optional — only CLI instances
     * (which own a PTY / lastOutputAt clock) implement it; a no-op elsewhere.
     */
    checkMeshWorkerStall?(now?: number): void;

 /** Return current status */
    getState(): ProviderState;

    /**
     * Return the cheap session metadata needed to decide whether chat-tail
     * subscriptions should be flushed. Implementations must avoid rich transcript
     * parsing here; callers use this on P2P hot flush paths.
     */
    getHotChatSessionState?(): HotChatSessionState | HotChatSessionState[] | null;

    /**
     * Return the cheap modal metadata for a single session subscription. This is
     * used on P2P topic flushes and must not invoke rich chat/transcript parsing.
     */
    getSessionModalState?(sessionId?: string): SessionModalState | null;

 /** Receive event (external → Instance) */
    onEvent(event: string, data?: any): void;

 /** Update settings at runtime (called when user changes settings from dashboard) */
    updateSettings?(newSettings: Record<string, any>): void;

    /** Stamp a direct-dispatch mesh task assignment so generating_completed
     *  events route back to the originating coordinator. Cleared by
     *  detachMeshAssignment when the task reaches a terminal state. */
    attachMeshAssignment?(assignment: { meshId: string; nodeId?: string; taskId?: string; dispatchNonce?: number; attemptId?: string; coordinatorDaemonId?: string; coordinatorSessionId?: string }): void;
    detachMeshAssignment?(): void;

    /** Refresh static provider definition/scripts without restarting the live runtime. */
    refreshProviderDefinition?(provider: ProviderModule): void;

    /**
     * Record that a human is actively attending this session by hand right now
     * (foreground tab selection, controlbar use, manual approval, terminal
     * input). Provider-common signal that suppresses auto-approve for a short
     * window so the user can drive the session manually; background mesh worker
     * sessions never receive it, so their delegated auto-approve is unaffected.
     *
     * `opts.passive` marks a view-only action (select_session / open_panel). A
     * delegated worker session ignores passive stamps so a coordinator merely
     * watching its panel does not suppress its delegated auto-approve; explicit
     * input still attends. Foreground sessions attend on passive views too.
     */
    noteManualInteraction?(now?: number, opts?: { passive?: boolean }): void;

 /** cleanup */
    dispose(): void;
}
