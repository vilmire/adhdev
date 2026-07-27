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

/** Minimal daemon->cloud status payload used for routing, fallback, and server APIs. */
export interface CloudStatusReportPayload {
    sessions: CompactSessionEntry[];
    p2p?: StatusReportPayload['p2p'];
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
    p2p?: { available: boolean; state: string; peers: number; screenshotActive?: boolean };
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
}
