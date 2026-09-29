// Mesh node session views: hosted/active session ids from the inline cache, the
// live session records attributed to a node, and the historical-session summary.
// Split out of mesh-node-identity.ts (re-exported there).

import {
    readObjectRecord,
    readStringValue,
    readNumberValue,
    readBooleanValue,
} from './mesh-node-record-readers.js';
import { readMeshNodeDaemonId, readMeshNodeDisplayMachineName } from './mesh-node-identity.js';
import { toIsoTimestamp } from './mesh-node-record-readers.js';
import { type WorkerMcpDeliveryReason, WORKER_MCP_DELIVERY_REASONS } from './worker-mcp-isolation.js';
import { resolveSessionTurnPresentation } from './mesh-turn-presentation.js';
import { getSessionHostSurfaceKind } from '../session-host/runtime-surface.js';
import {
    daemonIdsEquivalent,
    meshWorkspacesEquivalent,
    sessionIdsEquivalent,
    normalizeMeshNodeId,
} from '@adhdev/mesh-shared';
import * as fs from 'fs';

export function readCachedInlineMeshActiveSessions(node: any): string[] {
    const cachedStatus = readObjectRecord(node?.cachedStatus);
    const activeSession = readObjectRecord(cachedStatus.activeSession);
    const fallbackSession = Object.keys(activeSession).length
        ? activeSession
        : readObjectRecord(node?.activeSession ?? node?.active_session);
    const sessionId = readStringValue(fallbackSession.id, fallbackSession.sessionId, fallbackSession.session_id, node?.activeSessionId, node?.active_session_id, node?.sessionId, node?.session_id);
    return sessionId ? [sessionId] : [];
}

/**
 * Wider session-ownership scan used ONLY by resolveRemoteMeshSessionOwnerDaemonId: collect
 * EVERY session id a mesh node currently hosts. readCachedInlineMeshActiveSessions above only
 * surfaces the node's single primary session (cachedStatus.activeSession) — other consumers
 * depend on that one-session semantics, so it is left untouched. A worker hosting more than one
 * session exposes its non-primary sessions only through the plural live-session arrays the
 * coordinator carries: status.activeSessions / activeSessionDetails (built from live records on
 * the aggregate snapshot, see get_mesh_status), or a worker's merged session report. A
 * controlbar/modal command (invoke_provider_script / resolve_action / set_mode / …) targeting a
 * non-primary remote session resolves its owner daemon only when those plural shapes are scanned
 * too. Mirrors sessionStatusFromNodes' shape tolerance (mesh-active-work.ts): plural arrays of
 * string ids OR objects keyed by id/sessionId/session_id/runtimeSessionId/instanceId, on both
 * camelCase and snake_case, at the node root and under cachedStatus / lastProbe.
 */
export function collectMeshNodeHostedSessionIds(node: any): Set<string> {
    const ids = new Set<string>();
    for (const id of readCachedInlineMeshActiveSessions(node)) ids.add(id);
    const cachedStatus = readObjectRecord(node?.cachedStatus);
    for (const value of [
        node?.activeSessions,
        node?.active_sessions,
        node?.activeSessionDetails,
        node?.active_session_details,
        node?.sessions,
        node?.sessionDetails,
        node?.session_details,
        readObjectRecord(node?.lastProbe).sessions,
        readObjectRecord(node?.last_probe).sessions,
        cachedStatus.activeSessions,
        cachedStatus.active_sessions,
        cachedStatus.activeSessionDetails,
        cachedStatus.active_session_details,
        cachedStatus.sessions,
    ]) {
        if (!Array.isArray(value)) continue;
        for (const item of value) {
            if (typeof item === 'string') {
                const id = readStringValue(item);
                if (id) ids.add(id);
                continue;
            }
            const record = readObjectRecord(item);
            const id = readStringValue(record.id, record.sessionId, record.session_id, record.runtimeSessionId, record.instanceId);
            if (id) ids.add(id);
        }
    }
    return ids;
}

/**
 * Resolve the owning-node attribution for a mesh node record so a coordinator can
 * stamp the TRUE owner onto a synthetic session entry instead of letting the
 * dashboard fall back to the coordinator's own daemonId. Returns whichever of the
 * owning node's `daemonId` / display machine name could be read from the node's
 * (possibly multi-serialization-path) shape; both may be undefined for a node that
 * never carried machine identity.
 */
export function resolveMeshNodeAttribution(node: unknown): { daemonId?: string; machineName?: string } {
    const record = readObjectRecord(node);
    return {
        daemonId: readMeshNodeDaemonId(record),
        machineName: readMeshNodeDisplayMachineName(record),
    };
}

export function readCachedInlineMeshActiveSessionDetails(node: any): Array<Record<string, unknown>> {
    const cachedStatus = readObjectRecord(node?.cachedStatus);
    const activeSession = readObjectRecord(cachedStatus.activeSession);
    const fallbackSession = Object.keys(activeSession).length
        ? activeSession
        : readObjectRecord(node?.activeSession ?? node?.active_session);
    const sessionId = readStringValue(
        fallbackSession.id,
        fallbackSession.sessionId,
        fallbackSession.session_id,
        node?.activeSessionId,
        node?.active_session_id,
        node?.sessionId,
        node?.session_id,
    );
    if (!sessionId) return [];
    return [{
        sessionId,
        providerType: readStringValue(
            fallbackSession.providerType,
            fallbackSession.provider_type,
            fallbackSession.cliType,
            fallbackSession.cli_type,
            fallbackSession.provider,
            node?.providerType,
            node?.provider_type,
        ),
        state: readStringValue(fallbackSession.status, fallbackSession.state, fallbackSession.lifecycle),
        chatStatus: readStringValue(fallbackSession.chatStatus, fallbackSession.chat_status),
        lifecycle: readStringValue(fallbackSession.lifecycle),
        title: readStringValue(fallbackSession.title, fallbackSession.displayName, fallbackSession.display_name) ?? null,
        workspace: readStringValue(fallbackSession.workspace, node?.workspace) ?? null,
        role: readStringValue(fallbackSession.role) ?? null,
        isSelfCoordinator: fallbackSession.isSelfCoordinator === true || fallbackSession.is_self_coordinator === true,
        createdAt: readStringValue(fallbackSession.createdAt, fallbackSession.created_at) ?? null,
        startedAt: readStringValue(fallbackSession.startedAt, fallbackSession.started_at) ?? null,
        lastActivityAt: readStringValue(fallbackSession.lastActivityAt, fallbackSession.last_activity_at) ?? null,
        recoveryState: readStringValue(fallbackSession.recoveryState, fallbackSession.recovery_state) ?? null,
        // [T2] Carry the worker-computed last-message preview through the cached inline-mesh
        // active-session entry. The worker's get_status_metadata slim now ships these
        // (mesh-tools.ts), and this is the surface the coordinator's inbox-preview path reads
        // (buildDaemonMetadataUpdateForSubscription → stampLocalAssistantPreviewOnCachedEntry).
        // Without carrying them here, the coordinator could only derive the preview from a live
        // in-process instance it doesn't host for a remote worker, so the inbox stuck on the
        // dispatched user task. Only present when the worker reported them.
        ...(readStringValue(fallbackSession.lastMessagePreview, fallbackSession.last_message_preview)
            ? { lastMessagePreview: readStringValue(fallbackSession.lastMessagePreview, fallbackSession.last_message_preview) } : {}),
        ...(readStringValue(fallbackSession.lastMessageRole, fallbackSession.last_message_role)
            ? { lastMessageRole: readStringValue(fallbackSession.lastMessageRole, fallbackSession.last_message_role) } : {}),
        ...(readNumberValue(fallbackSession.lastMessageAt, fallbackSession.last_message_at) !== undefined
            ? { lastMessageAt: readNumberValue(fallbackSession.lastMessageAt, fallbackSession.last_message_at) } : {}),
        // RESTORE-STICK: carry the worker's AUTHORITATIVE dashboard hide/mute state and the
        // raw per-session user override (userHidden/userMuted) through the cached inline-mesh
        // active-session entry. The worker's mesh_status slim (mcp-server mesh-tools-status.ts)
        // now ships these from its own status/builders resolution, which already honors a
        // manual restore/un-mute. Without carrying them here, the coordinator's cloud snapshot
        // append re-derives hide/mute purely from mesh policy and overwrites the user's manual
        // un-hide every snapshot — the restore flickered visible then re-hid.
        ...(readBooleanValue(fallbackSession.surfaceHidden) !== undefined
            ? { surfaceHidden: readBooleanValue(fallbackSession.surfaceHidden) } : {}),
        ...(readBooleanValue(fallbackSession.muted) !== undefined
            ? { muted: readBooleanValue(fallbackSession.muted) } : {}),
        ...(readBooleanValue(fallbackSession.userHidden, fallbackSession.user_hidden) !== undefined
            ? { userHidden: readBooleanValue(fallbackSession.userHidden, fallbackSession.user_hidden) } : {}),
        ...(readBooleanValue(fallbackSession.userMuted, fallbackSession.user_muted) !== undefined
            ? { userMuted: readBooleanValue(fallbackSession.userMuted, fallbackSession.user_muted) } : {}),
        isCached: true,
    }];
}

/**
 * Item 3 (MCP usage audit): re-read `resolveWorkerMcpIsolation`'s outcome —
 * stamped onto session meta as `workerMcpDelivered`/`workerMcpDeliveryReason`
 * by `launchCli` (cli-manager.ts) at launch time — for the mesh_status /
 * mesh_list_nodes session entry. `undefined` (not a worker launch, or launched
 * before this field existed) omits the key entirely rather than guessing.
 * `reason` is validated against the enum so a stale/foreign value on an old
 * session record cannot leak as if it were current vocabulary.
 */
function readWorkerMcpDeliveryFromMeta(meta: Record<string, unknown>): { delivered: boolean; reason?: WorkerMcpDeliveryReason } | undefined {
    const delivered = readBooleanValue(meta.workerMcpDelivered);
    if (delivered === undefined) return undefined;
    const rawReason = readStringValue(meta.workerMcpDeliveryReason);
    const reason = rawReason && (WORKER_MCP_DELIVERY_REASONS as readonly string[]).includes(rawReason)
        ? (rawReason as WorkerMcpDeliveryReason)
        : undefined;
    return { delivered, ...(reason ? { reason } : {}) };
}

export function summarizeMeshSessionRecord(record: any): Record<string, unknown> {
    const meta = readObjectRecord(record?.meta);
    const workerMcp = readWorkerMcpDeliveryFromMeta(meta);
    const isSelfCoordinator = Boolean(readStringValue(meta.meshCoordinatorFor));
    let chatStatus = readStringValue(record?.chatStatus, record?.activeChat?.status, meta.chatStatus, meta.sessionStatus);
    const state = readLiveMeshSessionState(record);
    const statusNote = isSelfCoordinator && (!chatStatus || chatStatus === 'idle' || state === 'idle')
        ? 'Coordinator self status is sampled from the session host and may read idle while the coordinator is generating this response.'
        : null;
    // TURN-PRESENTATION (Stage 6): a session with a mesh turn attempt presents the
    // reducer-projected status here (same authority as read_chat / session_status /
    // dashboard); the sampled chatStatus remains the shadow-comparison input and the
    // fallback when no attempt exists.
    const sessionId = readStringValue(record?.sessionId) || 'unknown';
    const turn = resolveSessionTurnPresentation({
        sessionId: sessionId === 'unknown' ? undefined : sessionId,
        providerStatus: chatStatus || state,
        providerType: readStringValue(record?.providerType) || undefined,
        surface: 'mesh_status',
    });
    if (turn.authority === 'turn_reducer') chatStatus = turn.status;
    return {
        sessionId,
        providerType: readStringValue(record?.providerType),
        state,
        chatStatus,
        ...(turn.authority === 'turn_reducer' ? { turn, attemptId: turn.attemptId, turnStage: turn.stage } : {}),
        lifecycle: readStringValue(record?.lifecycle),
        surfaceKind: getSessionHostSurfaceKind(record as any),
        recoveryState: readStringValue(meta.runtimeRecoveryState) ?? null,
        workspace: readStringValue(record?.workspace) ?? null,
        title: readStringValue(record?.displayName, record?.workspaceLabel) ?? null,
        role: isSelfCoordinator ? 'coordinator' : readStringValue(meta.meshRole, meta.role) ?? null,
        isSelfCoordinator,
        statusNote,
        createdAt: toIsoTimestamp(record?.createdAt ?? record?.created_at),
        startedAt: toIsoTimestamp(record?.startedAt ?? record?.started_at ?? record?.spawnedAtMs ?? record?.spawned_at_ms),
        lastActivityAt: toIsoTimestamp(record?.updatedAt ?? record?.lastActivityAt ?? record?.last_activity_at),
        isCached: false,
        ...(workerMcp ? { workerMcp } : {}),
    };
}

function liveSessionRecordMatchesMeshNode(record: any, meshId: string, nodeId: string, nodeWorkspace = '', nodeIsMissingLocalWorktree = false): boolean {
    const recordNodeId = readStringValue(record?.meta?.meshNodeId);
    // A session's stamped meshNodeId and the node's id can carry interchangeable
    // daemon-id forms (bare `mach_X` vs `daemon_mach_X`) — compare under the
    // canonical machine core, not raw `!==` (CANON-IDENTITY class).
    if (!recordNodeId || !daemonIdsEquivalent(recordNodeId, nodeId)) return false;
    if (nodeIsMissingLocalWorktree) return false;
    const recordWorkspace = readStringValue(record?.workspace);
    // Normalized compare (shared WTCLAIM rule): a base node and a co-located worktree
    // clone differ ONLY by workspace root, so a separator/case-skewed exact compare
    // could wrongly keep a sibling worktree's session attached to this node.
    if (nodeWorkspace && recordWorkspace && !meshWorkspacesEquivalent(recordWorkspace, nodeWorkspace)) return false;
    const recordMeshId = readStringValue(record?.meta?.meshNodeFor);
    return !recordMeshId || recordMeshId === meshId;
}

function liveSessionRecordMatchesMeshWorkspace(record: any, meshId: string, workspace: string): boolean {
    const recordWorkspace = readStringValue(record?.workspace);
    if (!recordWorkspace || !workspace || !meshWorkspacesEquivalent(recordWorkspace, workspace)) return false;

    const recordMeshId = readStringValue(record?.meta?.meshNodeFor);
    if (recordMeshId) return recordMeshId === meshId;

    return record?.meta?.launchedByCoordinator === true || !!readStringValue(record?.meta?.meshNodeId);
}

export function readLiveMeshNodeWorkspace(args: {
    meshId: string;
    nodeId: string;
    liveSessionRecords: any[];
    allowCoordinatorSession?: boolean;
}): string {
    const directNodeWorkspace = args.liveSessionRecords.find((record) => (
        liveSessionRecordMatchesMeshNode(record, args.meshId, args.nodeId)
        && readStringValue(record?.workspace)
    ));
    if (directNodeWorkspace) {
        return readStringValue(directNodeWorkspace.workspace) || '';
    }

    if (args.allowCoordinatorSession) {
        const coordinatorWorkspace = args.liveSessionRecords.find((record) => (
            readStringValue(record?.meta?.meshCoordinatorFor) === args.meshId
            && readStringValue(record?.workspace)
        ));
        if (coordinatorWorkspace) {
            return readStringValue(coordinatorWorkspace.workspace) || '';
        }
    }

    return '';
}

export function collectLiveMeshSessionRecords(args: {
    meshId: string;
    node: any;
    nodeId: string;
    liveSessionRecords: any[];
    allowCoordinatorSession?: boolean;
}): any[] {
    const nodeWorkspace = readStringValue(args.node?.workspace);
    const nodeIsMissingLocalWorktree = args.node?.isLocalWorktree === true
        && !!nodeWorkspace
        && !fs.existsSync(nodeWorkspace);
    const matches = args.liveSessionRecords.filter((record) => {
        const recordNodeId = readStringValue(record?.meta?.meshNodeId);
        if (recordNodeId && !daemonIdsEquivalent(recordNodeId, args.nodeId)) return false;
        if (liveSessionRecordMatchesMeshNode(record, args.meshId, args.nodeId, nodeWorkspace || '', nodeIsMissingLocalWorktree)) return true;
        if (nodeIsMissingLocalWorktree) return false;
        return !!nodeWorkspace && liveSessionRecordMatchesMeshWorkspace(record, args.meshId, nodeWorkspace);
    });

    if (args.allowCoordinatorSession) {
        for (const record of args.liveSessionRecords) {
            if (readStringValue(record?.meta?.meshCoordinatorFor) !== args.meshId) continue;
            const sessionId = readStringValue(record?.sessionId);
            if (sessionId && matches.some((entry) => sessionIdsEquivalent(readStringValue(entry?.sessionId), sessionId))) continue;
            matches.push(record);
        }
    }

    return matches;
}

export function buildHistoricalMeshSessions(args: {
    meshId: string;
    nodes: any[];
    liveSessionRecords: any[];
}): { count: number; sessions: Record<string, unknown>[]; instruction: string } | undefined {
    const liveNodeIds = new Set<string>();
    const liveWorkspaces = new Set<string>();
    const missingLocalWorktreeNodeIds = new Set<string>();
    for (const node of args.nodes || []) {
        const nodeId = normalizeMeshNodeId(node);
        const workspace = readStringValue(node?.workspace);
        if (nodeId) liveNodeIds.add(nodeId);
        if (workspace) liveWorkspaces.add(workspace);
        if (nodeId && node?.isLocalWorktree === true && workspace && !fs.existsSync(workspace)) {
            missingLocalWorktreeNodeIds.add(nodeId);
        }
    }

    const sessions: Record<string, unknown>[] = [];
    for (const record of args.liveSessionRecords || []) {
        const meta = readObjectRecord(record?.meta);
        const recordMeshId = readStringValue(meta.meshNodeFor, meta.meshCoordinatorFor);
        if (recordMeshId !== args.meshId) continue;
        const recordNodeId = readStringValue(meta.meshNodeId);
        const workspace = readStringValue(record?.workspace);
        const removedNode = !!recordNodeId && (!liveNodeIds.has(recordNodeId) || missingLocalWorktreeNodeIds.has(recordNodeId));
        const orphanedWorkspace = !!workspace && !liveWorkspaces.has(workspace) && meta.meshCoordinatorFor !== args.meshId;
        if (!removedNode && !orphanedWorkspace) continue;
        sessions.push({
            ...summarizeMeshSessionRecord(record),
            classification: removedNode ? 'removedNode' : 'orphanedSession',
            historical: true,
            meshNodeId: recordNodeId || null,
            reason: removedNode
                ? 'Session is tagged to a mesh node that is no longer in live membership.'
                : 'Session workspace is no longer attached to a live mesh node.',
        });
    }
    if (sessions.length === 0) return undefined;
    return {
        count: sessions.length,
        sessions: sessions.slice(0, 5),
        instruction: 'These sessions are separated from normal node activeSessions because their mesh node/workspace is no longer live. Use mesh_cleanup_sessions only if cleanup is intended.',
    };
}


export function readLiveMeshSessionState(record: any): string | undefined {
    return readStringValue(
        record?.meta?.sessionStatus,
        record?.meta?.status,
        record?.meta?.providerStatus,
        record?.status,
        record?.state,
        record?.lifecycle,
    );
}
