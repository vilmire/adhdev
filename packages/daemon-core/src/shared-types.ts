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
import type { KeyedDocDelta, MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';
import type { ProviderControlDef } from './providers/provider-control-contracts.js';

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
import type { AutoApproveModesConfig, LaunchableProviderCategory, ProviderCategory, ProviderResumeCapability } from './providers/contracts.js';
import type { ProviderMeshCoordinatorConfig } from './providers/mesh-coordinator-contracts.js';
import type {
    GitCompactSummary,
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

export type TransportTopic = 'session.runtime_output' | 'machine.runtime' | 'session_host.diagnostics' | 'daemon.metadata' | 'workspace.git' | 'mesh.status';

/** `mesh.status`: the coordinator's held mesh_status view of ONE mesh (the dashboard mesh view's only lane). */
export interface MeshStatusSubscriptionParams {
    meshId: string;
}

export interface SessionRuntimeOutputSubscriptionParams {
    targetSessionId: string;
}

export interface MachineRuntimeSubscriptionParams {
    intervalMs?: number;
}

export interface DaemonMetadataSubscriptionParams {
    includeSessions?: boolean;
}

export interface SessionHostDiagnosticsSubscriptionParams {
    includeSessions?: boolean;
    limit?: number;
    intervalMs?: number;
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

/**
 * `daemon.metadata` — the ONE dashboard lane for daemon + session state
 * (cloud P2P and standalone WS alike; data-path audit 2026-09-29 P0-3).
 *
 * Wire protocol: the first frame after a (re)subscribe is a `snapshot`
 * (the full state); every later frame is a `delta` carrying only what changed
 * since the last frame DELIVERED to that subscription — changed daemon-level
 * fields, changed session fields keyed by session id, explicit removals. An
 * unchanged daemon sends nothing at all. A failed send drops the baseline, so
 * the next frame is a snapshot again (no gap can go unnoticed).
 *
 * Consumers never see a delta: web-core's SubscriptionManager folds each delta
 * into the held snapshot and hands handlers the materialized
 * {@link DaemonMetadataUpdate}.
 */
export interface DaemonMetadataUpdate {
    topic: 'daemon.metadata';
    key: string;
    mode: 'snapshot';
    /** The daemon's dashboard wire version (stamped on every keyed snapshot frame). */
    wireVersion?: number;
    daemonId: string;
    status: StatusReportPayload;
    userName?: string;
    seq: number;
    timestamp: number;
}

/**
 * `daemon.metadata` later frames: only what changed since the last frame
 * delivered to this subscription — the daemon-level `status` field by field and
 * sessions keyed by id (mesh-shared keyed-doc-delta.ts, DAEMON_METADATA_DOC_SPEC,
 * the same engine as `mesh.status`). An unchanged daemon sends nothing.
 */
export interface DaemonMetadataDelta {
    topic: 'daemon.metadata';
    key: string;
    mode: 'delta';
    daemonId: string;
    seq: number;
    timestamp: number;
    delta: KeyedDocDelta;
}

export type DaemonMetadataWireUpdate = DaemonMetadataUpdate | DaemonMetadataDelta;

/**
 * `mesh.status` first frame: the coordinator's `mesh_status` result for the
 * subscribed mesh — the same body the `mesh_status` command returns.
 */
export interface MeshStatusSnapshotUpdate {
    topic: 'mesh.status';
    key: string;
    mode: 'snapshot';
    /** The daemon's dashboard wire version (stamped on every keyed snapshot frame). */
    wireVersion?: number;
    meshId: string;
    status: Record<string, unknown>;
    seq: number;
    timestamp: number;
}

/**
 * `mesh.status` later frames: only what changed since the last frame delivered
 * to this subscription — keyed per node (`nodes`), per queue task
 * (`queue.tasks`) and per mission (`missions`); see mesh-shared
 * keyed-doc-delta.ts (MESH_STATUS_DOC_SPEC). An unchanged mesh sends nothing.
 */
export interface MeshStatusDeltaUpdate {
    topic: 'mesh.status';
    key: string;
    mode: 'delta';
    meshId: string;
    delta: KeyedDocDelta;
    seq: number;
    timestamp: number;
}

export type MeshStatusWireUpdate = MeshStatusSnapshotUpdate | MeshStatusDeltaUpdate;

export interface TopicUpdateEnvelopeMap {
    'session.runtime_output': SessionRuntimeOutputUpdate;
    'machine.runtime': MachineRuntimeUpdate;
    'session_host.diagnostics': SessionHostDiagnosticsUpdate;
    'daemon.metadata': DaemonMetadataWireUpdate;
    'workspace.git': GitWorkspaceUpdate;
    'mesh.status': MeshStatusWireUpdate;
}

/**
 * The daemon's answer to a subscribe whose `wireVersion` differs from its own
 * (mesh-shared protocol/dashboard-wire-version.ts): no state is served — the
 * page reloads (daemon newer) or asks for a daemon update (daemon older).
 */
export interface TopicProtocolMismatchUpdate {
    topic: TransportTopic;
    key: string;
    mode: 'protocol_mismatch';
    daemonWireVersion: number;
    /** The version the page stated (null = it stated none — a pre-versioning page). */
    pageWireVersion: number | null;
    seq: 0;
    timestamp: number;
}

export type TopicUpdateEnvelope = TopicUpdateEnvelopeMap[TransportTopic] | TopicProtocolMismatchUpdate;

export interface SubscribeRequestMap {
    'session.runtime_output': SessionRuntimeOutputSubscriptionParams;
    'machine.runtime': MachineRuntimeSubscriptionParams;
    'session_host.diagnostics': SessionHostDiagnosticsSubscriptionParams;
    'daemon.metadata': DaemonMetadataSubscriptionParams;
    'workspace.git': WorkspaceGitSubscriptionParams;
    'mesh.status': MeshStatusSubscriptionParams;
}

/** `wireVersion`: the dashboard wire version the page speaks (mesh-shared DASHBOARD_WIRE_VERSION). */
export type SubscribeRequest =
    { [K in TransportTopic]: { type: 'subscribe'; topic: K; key: string; params: SubscribeRequestMap[K]; wireVersion?: number } }[TransportTopic];

export type UnsubscribeRequest =
    { [K in TransportTopic]: { type: 'unsubscribe'; topic: K; key: string } }[TransportTopic];

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
    /**
     * Launch provenance — provider, model, thinking level and where each came
     * from (Phase E). Full record: P2P / local only, never the server WS.
     */
    launch?: import('@adhdev/mesh-shared').SessionLaunchRecord;
    /** The model in force, derived from `launch` (identifier). */
    model?: string;
    /** Where the model came from, derived from `launch` (enum). */
    modelSource?: import('@adhdev/mesh-shared').ModelAxisSource;
    /** The thinking level in force, derived from `launch`. */
    thinkingLevel?: string;
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
    meshQueueStats?: SessionMeshQueueStats;
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
    /**
     * Launch provenance — provider, model, thinking level and where each came
     * from (Phase E). Full record: P2P / local only, never the server WS.
     */
    launch?: import('@adhdev/mesh-shared').SessionLaunchRecord;
    /** The model in force, derived from `launch` (identifier). */
    model?: string;
    /** Where the model came from, derived from `launch` (enum). */
    modelSource?: import('@adhdev/mesh-shared').ModelAxisSource;
    /** The thinking level in force, derived from `launch`. */
    thinkingLevel?: string;
    settings?: Record<string, any>;
    meshQueueStats?: SessionMeshQueueStats;
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
    category: ProviderCategory;
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

/**
 * Provider control schema transmitted to the frontend. Every ProviderControlDef
 * field is serializable, so the wire schema IS the definition — one type, not a
 * hand-synced copy.
 */
export type ProviderControlSchema = ProviderControlDef;

/** A mesh coordinator session's queue counters (SessionEntry / CompactSessionEntry). */
export interface SessionMeshQueueStats {
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
    kind: LaunchableProviderCategory;
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
    | 'monitor:no_progress';

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

/**
 * P2P-plane enrichment of DaemonStatusEventPayload for `agent:waiting_choice`.
 *
 * Carries the FULL structured AskUserQuestion payload so the dashboard can
 * hydrate `activeInteractivePrompt` from the event itself
 * (web-core EventManager.hydrateInteractivePromptFromEvent) instead of relying
 * solely on the P2P rich status sync — when that sync is degraded the session
 * otherwise falls back to the raw approval banner, which cannot submit a
 * checkbox picker (MULTISELECT-REMOTE-DEADLOCK).
 *
 * P2P DataChannel ONLY. `interactivePrompt` is agent-authored free text
 * (question text, option labels/descriptions), so it must NEVER join the
 * server-bound DaemonStatusEventPayload above: emitStatusEvent also hands that
 * object to the cloud server, which spreads it into webhook dispatch to
 * EXTERNAL endpoints (server DaemonConnection.handleStatusEvent) — and the
 * server's own dashboard relay re-projects through its own allow-list
 * (UserSession.buildDashboardStatusEvent) that strips unlisted fields anyway,
 * so server-side carriage would leak without ever reaching a dashboard. The
 * type-narrowing guards that populate these fields mirror
 * buildRelayMetadataEvent (mesh/mesh-event-delivery.ts).
 */
export interface P2PStatusEventPayload extends DaemonStatusEventPayload {
    interactivePrompt?: InteractivePrompt;
    /** Prompt id of `interactivePrompt`, surfaced flat for dedup/routing. */
    promptId?: string;
    /** Whether the FIRST question of `interactivePrompt` is multi-select. */
    multiSelect?: boolean;
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
    /**
     * NOTE: `providerSessionId` and `workspaceName` are deliberately NOT declared
     * here, even though the daemon-side `DaemonStatusEventPayload` carries both.
     *
     * This interface describes what the SERVER relay actually emits, and
     * `UserSession.buildDashboardStatusEvent` — the sole producer of this type —
     * copies neither. Declaring them made the type claim a guarantee no producer
     * honours: on the WS path they are always `undefined`.
     *
     * The dashboard consumer that reads them
     * (web-core `useDashboardPendingLaunch`, via the `StatusEventPayload`
     * intersection in `managers/EventManager.ts`, which re-declares both on top
     * of this type) is fed from BOTH transports, and on the P2P path the fields
     * are genuinely present — `buildP2PStatusEvent` extends the server payload,
     * which does carry them. So the consumer is correct to look for them; it is
     * only this WS-relay type that must not promise them. Its checks are
     * written to skip gracefully when either field is absent, which is exactly
     * the WS behaviour.
     *
     * Both fields are non-content identifiers, so ADDING them to
     * `buildDashboardStatusEvent` would be permitted by the content boundary and
     * would tighten pending-launch matching on the WS path. That is a deliberate
     * product change (it also needs `providerSessionId` on the server's
     * `UserSessionPushEvent`, which does not declare it today) — not something to
     * do implicitly to satisfy a type. Removing the over-declaration is the
     * change that makes the type match reality; widening the relay is a separate,
     * intentional decision.
     */
    duration?: number;
    elapsedSec?: number;
    modalMessage?: string;
    modalButtons?: string[];
    /**
     * MULTISELECT-REMOTE-DEADLOCK: the FULL structured AskUserQuestion payload
     * carried by `agent:waiting_choice` (every question's header/question/
     * multiSelect, every option's label/description/preview). status-transition.ts
     * has always emitted it — it was simply absent from this interface, so the
     * dashboard could not consume it without an `as any`.
     *
     * It is the authoritative signal for answering a question: the dashboard
     * hydrates `activeInteractivePrompt` from it so the STRUCTURED picker renders
     * even when the P2P rich status sync (previously the only carrier of that
     * field) is degraded. Without it the session fell back to the raw
     * single-select approval banner, which cannot submit a checkbox picker.
     *
     * P2P-plane only — this is agent-authored content and must NOT be added to
     * the server-bound projection. The push path keeps using the
     * already-approved `modalMessage`/`modalButtons` reduction instead. See
     * buildServerStatusEvent in status/reporter.ts, which is an allow-list.
     */
    interactivePrompt?: InteractivePrompt;
    /** Prompt id of `interactivePrompt`, surfaced flat for dedup/routing. */
    promptId?: string;
    /** Whether the FIRST question of `interactivePrompt` is multi-select. */
    multiSelect?: boolean;
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
    /**
     * The session's model — an IDENTIFIER (`claude-opus-4-1`, `gpt-5.6-sol`),
     * passed through `sanitizeModelIdentifier` at every layer; a label or any
     * free text is dropped. Phase E.
     */
    model?: string;
    /** Where that model came from — an enum (`MODEL_AXIS_SOURCES`), allow-listed at every layer. */
    modelSource?: import('@adhdev/mesh-shared').ModelAxisSource;
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

    // ── §8 unit 2: transcript single-observation publisher ─────────────────
    // Same bucket/boolean discipline as the fields above. See
    // seqscribe/stats.ts SeqscribeStatusSummary for the full field docs.
    /** Whether the transcript publisher is configured (mode != off). */
    transcriptPublish?: boolean;
    /** Bucketed count of complete revisions handed to the publish sink (0 = none). */
    transcriptPublishedBucket?: number;
    /** Bucketed count of publish-sink failures (0 = none). */
    transcriptPublishFailedBucket?: number;
    /** Bucketed count of stable-hash observations that produced no new revision (0 = none). */
    transcriptDedupedBucket?: number;
    /** Bucketed count of `projection_oversize` rejections (0 = none). */
    transcriptOversizedBucket?: number;
    /** Bucketed count of sessions dropped at MAX_TRACKED_SESSIONS (0 = none). */
    transcriptDroppedBucket?: number;
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
     * Cloud daemon's screenshot budget (remote view toolbar). Dashboard lane
     * only (`daemon.metadata`); never on the server frame.
     */
    screenshotUsage?: { dailyUsedMinutes: number; dailyBudgetMinutes: number; budgetExhausted: boolean } | null;
    /**
     * Provider channel staleness (the machine-detail badge): provider types whose
     * pinned version is behind the channel, and types the channel has that this
     * daemon has not installed. Dashboard lane only (`daemon.metadata`); never on
     * the server frame. Absent until the daemon's first staleness probe answers.
     */
    providerChannelStaleness?: { staleTypes: string[]; newTypes: string[] };
}
