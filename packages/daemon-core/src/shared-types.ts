/**
 * ADHDev Shared Types — Cross-package type definitions
 *
 * Types used across daemon-core, web-core, and downstream consumers.
 * Import via: import type { ... } from '@adhdev/daemon-core/types'
 *
 * IMPORTANT: This file must remain runtime-free (types only).
 */

import type {
    StatusResponse,
    ChatMessage,
    ExtensionInfo,
    SystemInfo,
    DetectedIde,
    AgentEntry,
} from './types.js';
import type {
    SessionAttachedClient as CoreSessionAttachedClient,
    SessionWriteOwner as CoreSessionWriteOwner,
    SessionHostRecord as CoreSessionHostRecord,
    SessionHostLogEntry as CoreSessionHostLogEntry,
    SessionHostRequestTrace as CoreSessionHostRequestTrace,
    SessionHostRuntimeTransition as CoreSessionHostRuntimeTransition,
    SessionHostDiagnostics as CoreSessionHostDiagnostics,
} from '@adhdev/session-host-core';
// Dependency-free leaf (mesh-shared never imports daemon-core) — type-only,
// same convention as mesh/node-facts.ts.
import type { MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';

export type {
    StatusResponse,
    ChatMessage,
    ExtensionInfo,
    SystemInfo,
    DetectedIde,
    AgentEntry,
};

// Re-export provider types (except ProviderErrorReason which is defined below)
export type {
    ProviderState,
    ProviderStatus,
    ActiveChatData,
    IdeProviderState,
    CliProviderState,
    AcpProviderState,
    ExtensionProviderState,
    ProviderEvent,
} from './providers/provider-instance.js';

// Re-export ProviderErrorReason (defined in this file, imported by provider-instance)
export type { ProviderErrorReason } from './providers/provider-instance.js';

// Local import for use in Managed*Entry types below
import type { ActiveChatData as _ActiveChatData, ProviderErrorReason as _ProviderErrorReason } from './providers/provider-instance.js';
import type { WorkspaceEntry } from './config/workspaces.js';
import type { AutoApproveModesConfig, ProviderMeshCoordinatorConfig, ProviderResumeCapability } from './providers/contracts.js';
import type {
    GitCompactSummary,
    GitDiffSummary,
    GitFailureReason,
    GitRepoIdentity,
    GitRepoStatus,
    GitSnapshot,
    GitSnapshotCompareSummary,
    GitSnapshotReason,
    GitWorkspaceUpdate,
    WorkspaceGitSubscriptionParams,
} from './git/git-types.js';
import type { InteractivePrompt } from './providers/types/interactive-prompt.js';

export type {
    GitCommandName,
    GitCompactSummary,
    GitDiffSummary,
    GitFailureReason,
    GitFileChange,
    GitFileChangeStatus,
    GitRepoIdentity,
    GitRepoStatus,
    GitSnapshot,
    GitSnapshotCompareSummary,
    GitSnapshotReason,
    GitWorkspaceUpdate,
    WorkspaceGitSubscriptionParams,
} from './git/git-types.js';

export interface SessionActiveChatData extends Omit<_ActiveChatData, 'messages'> {
    messages?: _ActiveChatData['messages'];
}

// Re-export WorkspaceEntry for downstream consumers
export type { WorkspaceEntry } from './config/workspaces.js';

// ─── Managed Entry Types (reporter → server/web) ────────────────────
// These define the shape of data sent by DaemonStatusReporter
// and consumed by web-core and downstream consumers.

/** Agent stream snapshot carried by flattened UI entries. */
export interface AgentSessionStream {
    sessionId?: string;
    instanceId?: string;
    parentSessionId?: string | null;
    agentType: string;
    agentName: string;
    extensionId: string;
    transport?: SessionTransport;
    status: string;
    title?: string;
    messages: ChatMessage[];
    inputContent: string;
    model?: string;
    activeModal: { message: string; buttons: string[] } | null;
}

export interface ReadChatCursor {
    tailLimit?: number;
}

export interface ReadChatSyncResult {
    messages: ChatMessage[];
    status: string;
    title?: string;
    activeModal?: { message: string; buttons: string[] } | null;
    activeInteractivePrompt?: InteractivePrompt | null;
    /**
     * Chat source provenance from ChatSourceMachine (A2). Carries the
     * selected source, transition cause, lock state, and legacy
     * fallbackReason — opaque to the daemon-core, consumed by web-core
     * for the source debug badge and SourceTimeline (A3).
     */
    messageSource?: Record<string, unknown>;
}

export interface ProviderSummaryItem {
    id: string;
    value: string;
    label?: string;
    shortValue?: string;
    icon?: string;
    order?: number;
}

export interface ProviderSummaryMetadata {
    items: ProviderSummaryItem[];
}

/**
 * Wire-subset session-host types.
 *
 * These are the shapes daemon-core / web-core see over the wire — a subset of the
 * authoritative types owned by @adhdev/session-host-core (which additionally carry
 * transport / category / launchCommand / buffer and stricter union typing on wire
 * scalars). They are DERIVED from the SSOT via Pick/Omit so shared fields cannot
 * drift; only the deliberate wire looseness (string-typed `type`/`lifecycle`,
 * optional `meta`) is re-applied here.
 */
export type SessionHostAttachedClient = Omit<CoreSessionAttachedClient, 'type'> & {
    /** Widened over the wire — the raw client-type string is not re-validated here. */
    type: string;
};

export type SessionHostWriteOwner = CoreSessionWriteOwner;

export type SessionHostRecord = Pick<
    CoreSessionHostRecord,
    | 'sessionId'
    | 'runtimeKey'
    | 'displayName'
    | 'workspaceLabel'
    | 'providerType'
    | 'workspace'
    | 'lifecycle'
    | 'surfaceKind'
    | 'osPid'
    | 'lastActivityAt'
    | 'createdAt'
    | 'startedAt'
> & {
    writeOwner: SessionHostWriteOwner | null;
    attachedClients: SessionHostAttachedClient[];
    /** Optional over the wire — omitted when the record carries no metadata. */
    meta?: Record<string, unknown>;
};

export type SessionHostLogEntry = Omit<CoreSessionHostLogEntry, 'data'>;

export type SessionHostRequestTrace = Omit<CoreSessionHostRequestTrace, 'type'> & {
    /** Widened over the wire — the request-type union is not re-validated here. */
    type: string;
};

export type SessionHostRuntimeTransition = Omit<CoreSessionHostRuntimeTransition, 'lifecycle'> & {
    /** Widened over the wire — the lifecycle union is not re-validated here. */
    lifecycle?: string;
};

export type SessionHostDiagnosticsSnapshot = Omit<
    CoreSessionHostDiagnostics,
    | 'supportedRequestTypes'
    | 'sessions'
    | 'liveRuntimes'
    | 'recoverySnapshots'
    | 'inactiveRecords'
    | 'recentLogs'
    | 'recentRequests'
    | 'recentTransitions'
> & {
    sessions?: SessionHostRecord[];
    liveRuntimes?: SessionHostRecord[];
    recoverySnapshots?: SessionHostRecord[];
    inactiveRecords?: SessionHostRecord[];
    recentLogs: SessionHostLogEntry[];
    recentRequests: SessionHostRequestTrace[];
    recentTransitions: SessionHostRuntimeTransition[];
};

export type TransportTopic = 'session.chat_tail' | 'session.runtime_output' | 'machine.runtime' | 'session_host.diagnostics' | 'session.modal' | 'daemon.metadata' | 'workspace.git';

export interface SessionChatTailSubscriptionParams extends ReadChatCursor {
    targetSessionId: string;
    historySessionId?: string;
}

export interface SessionRuntimeOutputSubscriptionParams {
    targetSessionId: string;
}

export interface MachineRuntimeSubscriptionParams {
    intervalMs?: number;
}

export interface SessionModalSubscriptionParams {
    targetSessionId: string;
}

export interface DaemonMetadataSubscriptionParams {
    includeSessions?: boolean;
}

export interface SessionHostDiagnosticsSubscriptionParams {
    includeSessions?: boolean;
    limit?: number;
    intervalMs?: number;
}

export interface SessionChatTailUpdate extends ReadChatSyncResult {
    topic: 'session.chat_tail';
    key: string;
    sessionId: string;
    historySessionId?: string;
    interactionId?: string;
    seq: number;
    timestamp: number;
    error?: string;
}

export interface SessionRuntimeOutputUpdate {
    topic: 'session.runtime_output';
    key: string;
    sessionId: string;
    seq: number;
    timestamp: number;
}

export interface MachineRuntimeUpdate {
    topic: 'machine.runtime';
    key: string;
    machine: MachineInfo;
    seq: number;
    timestamp: number;
}

export interface SessionHostDiagnosticsUpdate {
    topic: 'session_host.diagnostics';
    key: string;
    diagnostics: SessionHostDiagnosticsSnapshot;
    seq: number;
    timestamp: number;
}

export interface SessionModalUpdate {
    topic: 'session.modal';
    key: string;
    sessionId: string;
    status: string;
    title?: string;
    modalMessage?: string;
    modalButtons?: string[];
    interactionId?: string;
    seq: number;
    timestamp: number;
}

export interface DaemonMetadataUpdate {
    topic: 'daemon.metadata';
    key: string;
    daemonId: string;
    status: StatusReportPayload;
    userName?: string;
    seq: number;
    timestamp: number;
    /**
     * Per-mesh state-change revision counters (meshId → monotonically increasing
     * integer), bumped whenever the daemon's mesh graph/queue/mission state for that
     * mesh changes (onMeshStateChange). Lets the dashboard replace its client-side
     * mesh_status polling with an event-driven background refresh: when the revision
     * for the mesh it is viewing advances, it re-fetches the aggregate mesh_status
     * (SWR, keeping the current graph on screen). This is a lightweight nudge — the
     * full aggregate snapshot is fetched on demand, not embedded here, so the
     * daemon.metadata payload stays small. Optional/absent for daemons/builds that
     * don't emit it (the client then keeps its polling fallback).
     */
    meshStateRevisions?: Record<string, number>;
}

export interface TopicUpdateEnvelopeMap {
    'session.chat_tail': SessionChatTailUpdate;
    'session.runtime_output': SessionRuntimeOutputUpdate;
    'machine.runtime': MachineRuntimeUpdate;
    'session_host.diagnostics': SessionHostDiagnosticsUpdate;
    'session.modal': SessionModalUpdate;
    'daemon.metadata': DaemonMetadataUpdate;
    'workspace.git': GitWorkspaceUpdate;
}

export type TopicUpdateEnvelope = TopicUpdateEnvelopeMap[TransportTopic];

export interface SubscribeRequestMap {
    'session.chat_tail': SessionChatTailSubscriptionParams;
    'session.runtime_output': SessionRuntimeOutputSubscriptionParams;
    'machine.runtime': MachineRuntimeSubscriptionParams;
    'session_host.diagnostics': SessionHostDiagnosticsSubscriptionParams;
    'session.modal': SessionModalSubscriptionParams;
    'daemon.metadata': DaemonMetadataSubscriptionParams;
    'workspace.git': WorkspaceGitSubscriptionParams;
}

export type SubscribeRequest =
    { [K in TransportTopic]: { type: 'subscribe'; topic: K; key: string; params: SubscribeRequestMap[K] } }[TransportTopic];

export type UnsubscribeRequest =
    { [K in TransportTopic]: { type: 'unsubscribe'; topic: K; key: string } }[TransportTopic];

export type StandaloneWsStatusPayload = StatusReportPayload;

export type SessionTransport = 'cdp-page' | 'cdp-webview' | 'pty' | 'acp';

export type SessionKind = 'workspace' | 'agent';

export type SessionCapability =
    | 'read_chat'
    | 'send_message'
    | 'new_session'
    | 'list_sessions'
    | 'switch_session'
    | 'resolve_action'
    | 'open_panel'
    | 'terminal_io'
    | 'resize_terminal'
    | 'change_model'
    | 'set_mode'
    | 'set_thought_level'
    | 'delete_notification'
    | 'mark_notification_unread';

import type { RuntimeWriteOwner, RuntimeAttachedClient, SessionStatus } from './shared-types-extra.js';
import type { MessageInputSupport } from './providers/provider-input-support.js';
export type { RuntimeWriteOwner, RuntimeAttachedClient, SessionStatus } from './shared-types-extra.js';
export type { MessageInputSupport, InputMediaStrategyDescriptor, InputAttachmentStrategy, InputMediaType } from './providers/provider-input-support.js';

export interface SessionEntry {
    id: string;
    parentId: string | null;
    providerType: string;
    providerName?: string;
    providerSessionId?: string;
    kind: SessionKind;
    transport: SessionTransport;
    status: SessionStatus;
    /**
     * Stage 6 unified turn presentation (mesh-owned sessions with a turn
     * attempt). Authoritative execution status/identity/evidence timestamps
     * from the turn reducer projection; absent for non-mesh sessions.
     */
    turn?: import('./mesh/mesh-turn-presentation.js').SessionTurnPresentation;
    title: string;
    workspace?: string | null;
    git?: GitCompactSummary;
    runtimeKey?: string;
    runtimeDisplayName?: string;
    runtimeWorkspaceLabel?: string;
    runtimeLifecycle?: string | null;
    runtimeSurfaceKind?: 'live_runtime' | 'recovery_snapshot' | 'inactive_record';
    /** CLI only: active presentation mode */
    mode?: 'terminal' | 'chat';
    runtimeWriteOwner?: RuntimeWriteOwner | null;
    runtimeAttachedClients?: RuntimeAttachedClient[];
    runtimeRestoredFromStorage?: boolean;
    runtimeRecoveryState?: string | null;
    resume?: ProviderResumeCapability;
    activeChat: SessionActiveChatData | null;
    activeInteractivePrompt?: InteractivePrompt | null;
    capabilities?: SessionCapability[];
    /** Effective message input/media support for this session. Defaults fail-closed to text-only. */
    messageInput?: MessageInputSupport;
    cdpConnected?: boolean;
    /** Dynamic control current values (generic key-value) */
    controlValues?: Record<string, string | number | boolean>;
    /** Provider-declared controls schema (transmitted once, cached by frontend) */
    providerControls?: ProviderControlSchema[];
    /** Flexible always-visible metadata for compact/live surfaces. */
    summaryMetadata?: ProviderSummaryMetadata;
    errorMessage?: string;
    errorReason?: _ProviderErrorReason;
    lastMessagePreview?: string;
    lastMessageRole?: string;
    lastMessageAt?: number;
    lastMessageHash?: string;
    lastUpdated?: number;
    unread?: boolean;
    lastSeenAt?: number;
    inboxBucket?: RecentSessionBucket;
    completionMarker?: string;
    seenCompletionMarker?: string;
    surfaceHidden?: boolean;
    /**
     * User (or coordinator-policy) muted: suppress attention side-effects
     * (notifications, toasts, completion audio) for this session WITHOUT removing
     * it from the inbox list. Distinct from surfaceHidden (which collapses it from
     * the list). Daemon-owned, in-memory; rides the status snapshot.
     */
    muted?: boolean;
    settings?: Record<string, any>;
    /**
     * True owning-daemon id for a session a coordinator synthesises into its own
     * status snapshot (mesh delegated sessions). The dashboard attributes the session
     * to this daemon instead of the snapshot daemon so the worker node — not the
     * coordinator — is shown as its machine.
     */
    ownerDaemonId?: string;
    /** True owning-machine display name fallback when the owning daemon is not aggregated. */
    ownerMachineName?: string;
    /** Set when this session is acting as a mesh coordinator for the given mesh. */
    coordinator?: { meshId: string; role: 'coordinator' };
    meshQueueStats?: {
        total?: number;
        active?: number;
        historical?: number;
        pending: number;
        assigned: number;
        completed: number;
        failed: number;
        cancelled?: number;
        activeCounts?: {
            pending: number;
            assigned: number;
        };
        historicalCounts?: {
            completed: number;
            failed: number;
            cancelled: number;
        };
        activeAssignments?: Array<{
            id: string;
            nodeId?: string;
            sessionId?: string;
            message: string;
        }>;
    };
}

/**
 * Compact session metadata stored in UserSessionDO and reused by server-side
 * status/convenience APIs. This intentionally excludes rich UI-only fields.
 */
export interface CompactSessionEntry {
    id: string;
    parentId: string | null;
    providerType: string;
    providerName: string;
    providerSessionId?: string;
    kind: SessionKind;
    transport: SessionTransport;
    status: SessionStatus;
    /** Stage 6 unified turn presentation — see SessionEntry.turn. */
    turn?: import('./mesh/mesh-turn-presentation.js').SessionTurnPresentation;
    title: string;
    workspace: string | null;
    git?: GitCompactSummary;
    cdpConnected?: boolean;
    runtimeKey?: string;
    runtimeDisplayName?: string;
    runtimeWorkspaceLabel?: string;
    runtimeWriteOwner?: RuntimeWriteOwner | null;
    runtimeAttachedClients?: RuntimeAttachedClient[];
    lastMessagePreview?: string;
    lastMessageRole?: string;
    lastMessageAt?: number;
    lastMessageHash?: string;
    lastUpdated?: number;
    unread?: boolean;
    lastSeenAt?: number;
    inboxBucket?: RecentSessionBucket;
    completionMarker?: string;
    seenCompletionMarker?: string;
    surfaceHidden?: boolean;
    muted?: boolean;
    controlValues?: Record<string, string | number | boolean>;
    providerControls?: ProviderControlSchema[];
    summaryMetadata?: ProviderSummaryMetadata;
    settings?: Record<string, any>;
    meshQueueStats?: {
        total?: number;
        active?: number;
        historical?: number;
        pending: number;
        assigned: number;
        completed: number;
        failed: number;
        cancelled?: number;
        activeCounts?: {
            pending: number;
            assigned: number;
        };
        historicalCounts?: {
            completed: number;
            failed: number;
            cancelled: number;
        };
        activeAssignments?: Array<{
            id: string;
            nodeId?: string;
            sessionId?: string;
            message: string;
        }>;
    };
}

export type VersionUpdateReason =
    | 'force_update_below'
    | 'major_minor_mismatch'
    | 'patch_mismatch'
    | 'daemon_ahead';

export type ReleaseChannel = 'stable' | 'preview';
export type NpmUpdateTag = 'latest' | 'next';

export interface VersionUpdatePolicy {
    channel: ReleaseChannel;
    npmTag: NpmUpdateTag;
    targetVersion: string;
    minVersion?: string;
    updateCommand: string;
}

/** Available provider information */
export interface AvailableProviderInfo {
    type: string;
    name: string;
    category: 'ide' | 'extension' | 'cli' | 'acp';
    displayName: string;
    icon: string;
    installed?: boolean;
    detectedPath?: string | null;
    /** Machine-local opt-in activation state. Undefined means older daemon payload. */
    enabled?: boolean;
    /** Machine-local readiness state for opt-in providers. */
    machineStatus?: 'disabled' | 'enabled_unchecked' | 'not_detected' | 'detected';
    /** Last machine-local command detection/runnable check result. */
    lastDetection?: MachineProviderCheckResult;
    /** Last end-to-end ADHDev verification result, when available. */
    lastVerification?: MachineProviderCheckResult;
    /** Provider-declared Repo Mesh coordinator/MCP behavior. */
    meshCoordinator?: ProviderMeshCoordinatorConfig;
    /** Provider-declared auto-approve choices shown by session launch UIs. */
    autoApproveModes?: AutoApproveModesConfig;
    /** BRAIN-ROUTING: suggested model values for the new-session model dropdown. */
    modelOptions?: string[];
    /** BRAIN-ROUTING: reasoning-effort values for the new-session thinking dropdown. */
    thinkingLevelOptions?: string[];
    /**
     * Provider trust classification — derived from the on-disk layer the
     * manifest came from and the shape of the manifest. Dashboards use
     * this to render a trust badge and gate activation of
     * `external-untrusted` providers behind a confirm modal.
     */
    trust?: ProviderTrust;
    /** Daemon-side human-readable description of the trust value. */
    trustDescription?: string;
    /** True when activation needs a user-side confirmation step. */
    requiresConfirmation?: boolean;
    /** Which on-disk layer the manifest lives in. */
    sourceLayer?: 'user' | 'upstream' | 'external';
    /** For external providers, the source-name namespace it came from. */
    sourceName?: string | null;
    /** Manifest-declared version, e.g. "1.2.1". */
    providerVersion?: string;
    /** Underlying executable name (CLI/binary providers). */
    binary?: string;
    /** Lifecycle label from the manifest: "Stable", "Beta", … */
    status?: string;
    /** One-line provider description from the manifest. */
    details?: string;
    /** Manifest-declared links: homepage, docs, repo, … */
    links?: Record<string, string>;
}

export type ProviderTrust =
    | 'user-custom'
    | 'trusted'
    | 'trusted-with-scripts'
    | 'external-safe'
    | 'external-untrusted';

export interface MachineProviderCheckResult {
    ok: boolean;
    stage?: 'detection' | 'runnable' | 'verification';
    checkedAt?: string;
    message?: string;
    command?: string;
    path?: string | null;
}

/** ACP config option (model/mode/thought_level selection) */
export interface AcpConfigOption {
    category: 'model' | 'mode' | 'thought_level' | 'other';
    configId: string;
    currentValue?: string;
    options: { value: string; name: string; description?: string; group?: string }[];
}

/** ACP mode */
export interface AcpMode {
    id: string;
    name: string;
    description?: string;
}

// ─── Provider Controls Schema (daemon → frontend) ──────────────────
// Serializable subset of ProviderControlDef — used for dynamic UI rendering

/** Provider control schema transmitted to frontend */
export interface ProviderControlSchema {
    id: string;
    type: 'select' | 'toggle' | 'cycle' | 'slider' | 'action' | 'display';
    label: string;
    icon?: string;
    placement: 'bar' | 'header' | 'menu';
    /** Static options (for select/cycle) */
    options?: { value: string; label: string; description?: string; group?: string }[];
    /** Dynamic options — frontend should call listScript to load */
    dynamic?: boolean;
    /** Script name to list options */
    listScript?: string;
    /** Script name to change value (value-based controls) */
    setScript?: string;
    /** Field name in readChat result for current value */
    readFrom?: string;
    /** Default value */
    defaultValue?: string | number | boolean;
    /** Script name to invoke (action type) */
    invokeScript?: string;
    /** How to display action result */
    resultDisplay?: 'toast' | 'inline' | 'none';
    /** Optional confirmation title shown before invoking the action */
    confirmTitle?: string;
    /** Optional confirmation message shown before invoking the action */
    confirmMessage?: string;
    /** Optional confirmation button label */
    confirmLabel?: string;
    /** Slider range */
    min?: number;
    max?: number;
    step?: number;
    /** Sort order */
    order?: number;
    /** Hide this control even if it would otherwise render */
    hidden?: boolean;
    /**
     * FSM state ids in which this control should be visible. When omitted the
     * control is always visible. Mirrors the daemon's click-time enforcement so
     * the bar hides controls the daemon would silently drop. Uses raw FSM state
     * ids (e.g. 'idle', 'busy'), not the derived dashboard status.
     */
    visibleWhenState?: string[];
}

// ─── Common Sub-Types (used across StatusReportPayload, BaseDaemonData, etc.) ──

/** Machine hardware/OS info (reported by daemon, displayed by web) */
export interface MachineInfo {
    hostname: string;
    platform: string;
    arch?: string;
    cpus?: number;
    totalMem?: number;
    freeMem?: number;
    /** macOS: reclaimable-inclusive; prefer for UI used% */
    availableMem?: number;
    loadavg?: number[];
    uptime?: number;
    release?: string;
    /**
     * Provider plan quota, cache-only (see quota/refresh.ts — never a live
     * fetch). Undefined until the machine's 15-minute refresh loop has ticked
     * at least once; absent from the object entirely rather than an empty map,
     * so "never reported" stays distinguishable from "reported and empty".
     */
    quota?: Record<string, MeshNodeFactsProviderQuota>;
    /** Operator-set machine label (config machineNickname), self-reported. */
    machineNickname?: string | null;
}

/** Detected IDE on a machine */
export interface DetectedIdeInfo {
    type: string;
    id?: string;
    name: string;
    running: boolean;
    path?: string;
}

export type { RecentSessionBucket, TerminalBackendStatus } from './shared-types-extra.js';
import type { RecentSessionBucket } from './shared-types-extra.js';
import type { TerminalBackendStatus } from './shared-types-extra.js';

export interface RecentLaunchEntry {
    id: string;
    providerType: string;
    providerName: string;
    kind: 'ide' | 'cli' | 'acp';
    providerSessionId?: string;
    title?: string;
    workspace?: string | null;
    summaryMetadata?: ProviderSummaryMetadata;
    lastLaunchedAt: number;
}

/** Compact machine payload broadcast by UserSessionDO to cloud dashboards. */
export interface CompactDaemonEntry {
    id: string;
    type?: string;
    machineId?: string;
    platform?: string;
    hostname?: string;
    nickname?: string;
    p2p?: StatusReportPayload['p2p'];
    cdpConnected?: boolean;
    timestamp?: number;
    version?: string;
    serverVersion?: string;
    versionMismatch?: boolean;
    versionUpdateRequired?: boolean;
    versionUpdateReason?: VersionUpdateReason;
    releaseChannel?: ReleaseChannel;
    updateChannel?: ReleaseChannel;
    updatePolicy?: VersionUpdatePolicy;
    updateCommand?: string;
    terminalBackend?: TerminalBackendStatus;
    detectedIdes?: DetectedIdeInfo[];
    availableProviders?: AvailableProviderInfo[];
    sessions?: CompactSessionEntry[];
}

/** Minimal daemon list payload returned by the cloud server REST API. */
export interface CloudDaemonSummaryEntry {
    id: string;
    type?: string;
    machineId?: string;
    platform?: string;
    hostname?: string;
    nickname?: string;
    p2p?: StatusReportPayload['p2p'];
    /** Live seqscribe health telemetry; aggregate counters and booleans only. */
    seqscribe?: SeqscribeStatusSummary;
    cdpConnected?: boolean;
    timestamp?: number;
    version?: string;
    serverVersion?: string;
    versionMismatch?: boolean;
    versionUpdateRequired?: boolean;
    versionUpdateReason?: VersionUpdateReason;
    releaseChannel?: ReleaseChannel;
    updateChannel?: ReleaseChannel;
    updatePolicy?: VersionUpdatePolicy;
    updateCommand?: string;
    terminalBackend?: TerminalBackendStatus;
}

/** Minimal daemon bootstrap payload used by dashboard WS to initiate P2P. */
export interface DashboardBootstrapDaemonEntry extends Partial<CloudDaemonSummaryEntry> {
    id: string;
    p2p?: StatusReportPayload['p2p'];
    timestamp?: number;
}

export type DaemonStatusEventName =
    | 'agent:generating_started'
    | 'agent:waiting_approval'
    // A question picker (AskUserQuestion / InteractivePrompt) parks the agent
    // awaiting a human decision — distinct from an approval modal, but equally a
    // state the user must answer before work continues. Relayed to the server so
    // push notifications fire (owner requirement: coordinator sessions must be
    // pinged for pending questions).
    | 'agent:waiting_choice'
    | 'agent:generating_completed'
    | 'agent:stopped'
    | 'monitor:no_progress'
    // Legacy alias for 'monitor:no_progress' — kept so older daemons that still
    // emit it remain type-compatible with consumers during rollout.
    | 'monitor:long_generating';

/** Minimal daemon-originated event payload relayed through the server. */
export interface DaemonStatusEventPayload {
    event: DaemonStatusEventName;
    timestamp: number;
    targetSessionId?: string;
    providerType?: string;
    providerSessionId?: string;
    workspaceName?: string;
    duration?: number;
    elapsedSec?: number;
    modalMessage?: string;
    modalButtons?: string[];
    /**
     * The target session's dashboard visibility at the moment the event fired.
     *
     * These make the event SELF-DESCRIBING for the server's push-suppression gate.
     * The gate used to join this event against the last `status_report` snapshot,
     * but the two travel on different channels: the event fires synchronously on
     * the PTY output tick, while the snapshot is throttled (5s), deduped (up to
     * ~5min) and periodic (30s). A coordinator-spawned worker that reaches an
     * approval/choice modal before its first snapshot lands is simply absent from
     * the server's map — and the gate fails OPEN, so the push leaked to the owner.
     *
     * Both are plain booleans (non-content), so forwarding them does not widen the
     * server content boundary — see buildCloudStatusReportPayload, which already
     * forwards the same two fields on the snapshot path.
     */
    surfaceHidden?: boolean;
    muted?: boolean;
}

export type DashboardStatusEventName =
    | DaemonStatusEventName
    | 'daemon:disconnect'
    | 'team:session_viewed'
    | 'team:view_request'
    | 'team:view_request_approved'
    | 'team:view_request_rejected';

/** Sanitized event payload delivered to dashboard clients. */
export interface DashboardStatusEventPayload {
    event: DashboardStatusEventName;
    timestamp: number;
    daemonId?: string;
    providerType?: string;
    targetSessionId?: string;
    providerSessionId?: string;
    workspaceName?: string;
    duration?: number;
    elapsedSec?: number;
    modalMessage?: string;
    modalButtons?: string[];
    requestId?: string;
    requesterName?: string;
    targetName?: string;
    orgId?: string;
    permission?: string;
    shareUrl?: string;
    shareToken?: string;
    viewerName?: string;
}

/**
 * Routing-only session metadata sent to the cloud server over the WS control plane.
 *
 * ── Content boundary ──────────────────────────────────────────────────────
 * The server is a signaling/routing plane: it MUST NOT receive user chat
 * content. This type is deliberately a *narrow, hand-listed* shape rather
 * than `Pick<CompactSessionEntry, ...>` or an `Omit<...>`, so that adding a
 * content-bearing field to `CompactSessionEntry` (which the P2P path uses)
 * can never silently widen what the server sees.
 *
 * Excluded on purpose — these ride the P2P DataChannel only:
 *   title, summaryMetadata, lastMessagePreview, lastMessageRole,
 *   lastMessageAt, lastMessageHash, activeChat, git, runtime* labels,
 *   controlValues, providerControls, meshQueueStats.activeAssignments[].message
 *
 * Anything added here must be non-content: identifiers, enums, booleans, and
 * counters only. Never free text authored by the user or the agent.
 */
export interface RoutingSessionEntry {
    id: string;
    parentId: string | null;
    providerType: string;
    providerName: string;
    kind: SessionKind;
    transport: SessionTransport;
    status: SessionStatus;
    /** Workspace path — routing/identity, not chat content. */
    workspace: string | null;
    cdpConnected?: boolean;
    /** Lets the server gate push notifications for coordinator-hidden sessions. */
    surfaceHidden?: boolean;
    /** Lets the server suppress push notifications for user-muted sessions. */
    muted?: boolean;
}

/**
 * P2P connection-transport telemetry (daemon → server).
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * When ICE selects a `host`/`srflx`/`prflx` candidate pair the peers talk
 * DIRECTLY and the bandwidth cost is zero. When it falls back to a `relay`
 * pair every byte traverses the TURN server and is BILLED. That direct/relay
 * ratio is the single largest variable in bandwidth cost, and it was
 * previously only ever written to a local `console.log` — never aggregated.
 *
 * ── Why it rides the existing status_report ───────────────────────────────
 * The account is at ~89% of its Durable Object request quota, so this
 * deliberately adds NO new endpoint and NO new periodic transmission. These
 * are a handful of extra integers on the `p2p` object of a report that is
 * already being sent, so the request-count delta is exactly zero.
 *
 * ── Content boundary ──────────────────────────────────────────────────────
 * Every field here is a counter or an enum-derived tally. There is no peer
 * identifier, no address, no free text. `relay`/`direct` are per-transport
 * peer counts, not a per-peer list, which also keeps the payload flat as the
 * peer count grows.
 */
export interface P2PStatusSummary {
    available: boolean;
    state: string;
    peers: number;
    screenshotActive?: boolean;
    /** Currently-connected peers on a direct (host/srflx/prflx) candidate pair. */
    direct?: number;
    /** Currently-connected peers on a TURN `relay` candidate pair — the billed path. */
    relay?: number;
    /**
     * Connected peers whose candidate pair could not be read (getStats/
     * getSelectedCandidatePair unavailable). Tracked separately so an
     * unobservable peer is never silently miscounted as direct — which would
     * understate relay cost.
     */
    unknownTransport?: number;
    /**
     * Cumulative count of connections established over a DIRECT pair since this
     * daemon process started. Monotonic; resets on daemon restart. Needed
     * because instantaneous counts alone cannot express a success *rate*.
     */
    directTotal?: number;
    /** Cumulative connections established over a TURN relay pair since process start. */
    relayTotal?: number;
}

/**
 * seqscribe replication health (daemon → server).
 *
 * Fleet-wide aggregates only: no topic names (they embed session and mesh ids),
 * no peer or writer ids, nothing derived from an entry payload. The counters
 * that would otherwise change every tick are bucketed so the status_report
 * dedup hash still collapses an idle daemon's reports — see
 * `summarizeSeqscribeStats` in seqscribe/stats.ts for the full rationale.
 */
export interface SeqscribeStatusSummary {
    /** Topics defined on this node. */
    topics: number;
    /** Peers currently attached (any state). */
    peers: number;
    /** Peers in the `ready` state — i.e. actually syncing. */
    peersReady: number;
    /** Bucketed max pending rows across topics (0 = none). */
    pendingBucket: number;
    /** Bucketed max consumer lag in rows (0 = none). */
    consumerLagBucket: number;
    /** Bucketed max peer send-queue depth (0 = none). */
    queueBucket: number;
    /** Bucketed oldest finality certificate age (0 = fresh or nothing certified). */
    fgenAgeBucket: number;
    /** Whether any topic holds quarantined entries. */
    quarantined: boolean;
    /** Whether a fleet secret is configured and certificates can be verified. */
    authority: boolean;

    // ── Phase 2 Stage 2+3: mesh dual-write shadow + parity ──────────────────
    // Same bucket/boolean discipline as the fields above. See
    // seqscribe/stats.ts SeqscribeStatusSummary for the full field docs.
    /** Whether the mesh dual-write shadow leg is armed. */
    dualWrite?: boolean;
    /** Bucketed count of shadow appends that failed (0 = none). */
    dualWriteFailedBucket?: number;
    /** Bucketed count of shadow records dropped by load-shedding (0 = none). */
    dualWriteDroppedBucket?: number;
    /** Bucketed count of records mirrored late by the parity backfill (0 = none). */
    dualWriteBackfilledBucket?: number;
    /** Bucketed count of parity mismatches observed since boot (0 = none). */
    parityMismatchBucket?: number;
    /** Whether at least one parity comparison has run. */
    parityRan?: boolean;
    /** Bucketed count of `missing_in_shadow` mismatches (0 = none). */
    parityMissingInShadowBucket?: number;
    /** Bucketed count of `extra_in_shadow` mismatches (0 = none). */
    parityExtraInShadowBucket?: number;
    /** Bucketed count of `field_mismatch` mismatches (0 = none). */
    parityFieldMismatchBucket?: number;
}

/**
 * Beacon staleness / sole-copy advisory (design §7.1, mission b60d70b8).
 *
 * ★★ LOCAL AND P2P ONLY — NEVER THE SERVER STATUS PATH.
 *
 * This is the one seqscribe shape that deliberately carries TOPIC NAMES and
 * PEER WRITER IDS, because "which topic is how far ahead" is the feature
 * itself; erasing the topic axis leaves nothing (§7.1.4). CLAUDE.md's approved
 * "Beacon vector exception" covers the BEACON BOARD path — the daemon PUT/GET
 * against the server DO. It does NOT widen the status path, whose daemon-side
 * allow-list (`seqscribe/stats.ts`) still excludes topic names outright.
 *
 * So this type may appear on:
 *   - `StatusReportPayload` (the P2P rich payload — never projected to the server)
 *   - `get_status_metadata` (a local read)
 *
 * and must never be added to `SeqscribeStatusSummary`,
 * `CloudStatusReportPayload`, or `buildCloudSeqscribeSummary`. The regression
 * that pins this is `test/status/cloud-status-content-boundary.test.ts`, which
 * plants a canary here and asserts it does not reach the server frame.
 *
 * Field docs live on the producing types in `seqscribe/beacon-diagnostics.ts`;
 * this is the structural mirror so web packages can type the payload without a
 * value import from daemon-core.
 *
 * ── ★ No elapsed-time fields on this wire shape ────────────────────────────
 * The in-process type (`BeaconDiagnostics`) carries `boardAgeMs` /
 * `lastSeenAgeMs`, which are convenient for a local reader. They are
 * DELIBERATELY ABSENT here, and `toBeaconDiagnosticsSummary` strips them.
 *
 * Every status frame is deduped by hashing the payload minus `timestamp`
 * (`sendP2PPayload`, and the server path's own hash). An age recomputed on each
 * report changes on every tick, so carrying one would make each frame unique,
 * defeat the dedup, and turn an idle daemon into a constant transmitter — the
 * same failure `seqscribe/stats.ts` buckets its counters to avoid, and the one
 * §7.1.2 depends on NOT happening (a Beacon that made idle daemons chatty would
 * break the status dedup floor it was designed to leave alone).
 *
 * Absolute instants (`boardAt`, `lastSeen`) are stable between reports and let
 * the consumer derive age at render time, which is where it is actually wanted.
 */
export interface BeaconDiagnosticsSummary {
    /** This node's beacon id (= its seqscribe writerId). */
    node: string;
    /** Peers seen on the last board, worst-lag first. */
    peers: Array<{
        node: string;
        behind: number;
        topics: Array<{ node: string; topic: string; behind: number }>;
        /** ISO-8601 instant — NOT an elapsed age. See the note above. */
        lastSeen: string;
    }>;
    /** Max `behind` across all peers/topics — the headline number for a badge. */
    maxBehind: number;
    /**
     * Positions this node may hold alone. ★ `verdict: 'unknown'` is a real
     * answer, not a missing one — see `soleCopyDeferred`.
     */
    soleCopy: Array<{
        topic: string;
        writer: string;
        localSeq: number;
        bestPeerSeq: number | null;
        unreplicated: number;
        verdict: 'sole-copy' | 'replicated' | 'unknown';
        unknownReason?: 'truncated' | 'no-board';
    }>;
    /** Peer reports the server dropped to fit the frame budget. */
    truncated: number;
    /**
     * True when `truncated > 0`. ★ While this is true every sole-copy verdict
     * is `'unknown'` by construction (§7.1.2.1) — a consumer must not render a
     * "safely replicated" affordance from a deferred judgement.
     */
    soleCopyDeferred: boolean;
    /** Topics the last GET asked about. */
    topicScope: string[];
    /**
     * ISO-8601 board capture time, or null before the first successful GET.
     *
     * A stable instant, not an age — see the dedup note above. A consumer that
     * wants "how old" computes it against its own clock at render time.
     */
    boardAt: string | null;
    /**
     * ★ ADVISORY ONLY — never a correctness gate (§5.7a). Keys are 64-hex
     * digests; the upstream reader selects the raw max seq across writers.
     */
    keyStaleAdvisory: Array<{
        topic: string;
        key: string;
        latestKnown: unknown;
        haveLocally: boolean;
    }>;
}

/**
 * One peer-authored `fleet.status` ring entry after the receiving daemon has
 * re-applied the fixed-key content boundary.
 *
 * Structurally mirrors `FleetStatusEntry` in status/reporter.ts. It is repeated
 * here because `StatusReportPayload` is the shared wire-type module and must not
 * import its producer. Keep the two in lock-step: identifiers, enums, booleans
 * and counters only — never machine nicknames, session arrays, dynamic maps or
 * any other free text.
 */
export interface FleetStatusPeerEntry {
    daemonId: string;
    at: string;
    onlineState: 'online' | 'reconnecting' | 'offline';
    p2pActive: boolean;
    sessionCounts: {
        ideCount: number;
        cliCount: number;
        acpCount: number;
        idleCount: number;
        generatingCount: number;
        waitingApprovalCount: number;
        erroredCount: number;
    };
    seqscribe?: SeqscribeStatusSummary;
}

/** Content-free receive-side validation counters for the SUB consumer. */
export interface FleetStatusPeerViewDiagnostics {
    /** Live peer subscriptions currently feeding the view. */
    subscribedPeers: number;
    /** Tail rows observed before schema or peer-identity validation. */
    receivedEntries: number;
    /** Schema-valid rows whose daemonId was compared with the serving peer. */
    comparedEntries: number;
    /** Compared rows whose daemon identity matched the serving peer. */
    matchedEntries: number;
    /** Compared rows rejected because the serving peer claimed another daemon. */
    mismatchedEntries: number;
    /** Rows rejected by the fixed-key schema projection. */
    invalidEntries: number;
    /** Times a peer's latest-only local snapshot was installed or replaced. */
    viewReplacements: number;
}

/**
 * Phase 4 Stage 2 receive surface: latest `fleet.status` entry per SUB peer.
 *
 * ★ LOCAL AND P2P ONLY. This is received peer state, not server routing state.
 * It may appear on the rich P2P StatusReportPayload and get_status_metadata,
 * but never on CloudStatusReportPayload or its fixed-key builder.
 */
export interface FleetStatusPeerView {
    peers: FleetStatusPeerEntry[];
    diagnostics: FleetStatusPeerViewDiagnostics;
}

/** Minimal daemon->cloud status payload used for routing, fallback, and server APIs. */
export interface CloudStatusReportPayload {
    sessions: RoutingSessionEntry[];
    p2p?: StatusReportPayload['p2p'];
    /** seqscribe replication health — counters and buckets only. */
    seqscribe?: SeqscribeStatusSummary;
    timestamp: number;
}

// ─── Status Report Payload (daemon → server) ────────────────────────
// Full payload shape sent via WebSocket status_report

export interface StatusReportPayload {
    /** Unique daemon instance identifier */
    instanceId: string;
    /** Daemon version (metadata/full snapshots only) */
    version?: string;
    /** Machine info */
    machine: MachineInfo;
    /** Machine nickname (user-set) */
    machineNickname?: string | null;
    /** Timestamp */
    timestamp: number;
    /** Detected IDEs on this machine (metadata snapshot only) */
    detectedIdes?: DetectedIdeInfo[];
    /** P2P state */
    p2p?: P2PStatusSummary;
    /** Canonical daemon runtime sessions */
    sessions: SessionEntry[];
    /** Saved workspaces */
    workspaces?: WorkspaceEntry[];
    defaultWorkspaceId?: string | null;
    defaultWorkspacePath?: string | null;
    terminalSizingMode?: 'measured' | 'fit';
    recentLaunches?: RecentLaunchEntry[];
    terminalBackend?: TerminalBackendStatus;
    /** Available providers (present in StatusSnapshot, optional in raw payload) */
    availableProviders?: AvailableProviderInfo[];
    /**
     * Beacon staleness / sole-copy advisory (mission b60d70b8).
     *
     * ★ P2P ONLY. Despite this interface's "daemon → server" header, the
     * SERVER-bound frame is not this object — it is
     * `CloudStatusReportPayload`, built by `buildCloudStatusReportPayload`
     * (status/reporter.ts), which is a fixed-key allow-list that re-lists every
     * field it forwards. This field is therefore structurally unable to reach
     * the server, and that is exactly why it may live here: the P2P DataChannel
     * is the rich path, and topic names + peer writer ids are permitted there.
     *
     * Absent when no beacon is armed (standalone never arms one) or before the
     * first board arrives — absent stays distinguishable from "fresh and empty".
     */
    beacon?: BeaconDiagnosticsSummary;
    /**
     * Latest fixed-key fleet.status entry received from each seqscribe SUB peer.
     *
     * ★ P2P ONLY, alongside `beacon`. `buildCloudStatusReportPayload` does not
     * accept or forward this field, so the always-on server routing/push path is
     * unchanged and cannot acquire peer-received state by accidental spread.
     */
    fleetStatusPeerView?: FleetStatusPeerView;
}
