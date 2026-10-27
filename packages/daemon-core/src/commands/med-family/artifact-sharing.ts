/**
 * Cross-session (OD-4), mesh, and cross-machine P2P (artifact_index_forwarded /
 * artifact_fetch_origin) helpers for daemon artifact commands.
 */

import { daemonIdsEquivalent, meshNodeIdMatches, sessionIdsEquivalent } from '@adhdev/mesh-shared';
import { readMeshSender } from '../mesh-sender.js';
import { unwrapMeshRelayResult } from '../mesh-relay-result.js';
import type { CommandRouterResult } from '../router.js';
import type { MedFamilyHandler } from './types.js';
import {
    ArtifactGuardError,
    MAX_ARTIFACT_BYTES,
    MAX_ARTIFACT_MCP_PAGE_BYTES,
    ORIGIN_FETCH_CHUNK_BYTES,
    type ArtifactStore,
    maxBase64EncodedBytes,
    reassembleBase64ArtifactChunks,
    toChatAttachmentMeta,
    wrapUntrustedArtifactContent,
    type ArtifactKind,
    type ArtifactRecord,
} from '../../artifacts/index.js';
import { readMeshNodeDaemonId } from '../../mesh/mesh-node-identity.js';
import { verifyWorkerSessionBind, verifyWorkerTaskToken } from '../../mesh/worker-mcp-isolation.js';
import {
    resolveForwardedWorkerIdentity,
    resolveRemoteWorkerIdentity,
    type ForwardedWorkerReportClaim,
    type WorkerAssignmentStamp,
} from '../../mesh/worker-report-forwarded.js';
import { currentMeshAttemptRef } from '../../providers/cli-provider-mesh-assignment.js';
import { getCoordinatorForSession } from '../../mesh/coordinator-registry.js';
import { getAssistantRegistry } from '../../assistant/assistant-registry.js';
import { getArtifactStore, getMeshRuntimeStore, type ArtifactCommandContext } from './artifact-runtime.js';
import type { ResolvedSessionAuthority } from './artifacts.js';
import {
    __resetOriginGrantStateForTest,
    authorizeWorkerOriginFetch,
    getHostOriginGrantPublicKey,
    mintArtifactOriginFetchGrant,
    resolveTrustedHostOriginGrantPublicKey,
    verifyActiveHostWorkerLedgerAttempt,
    verifyArtifactOriginFetchGrant,
    verifyLocalWorkerQueueAndLedgerFence,
    type ArtifactOriginFetchGrant,
} from './artifact-origin-grant.js';

export {
    __resetOriginGrantStateForTest,
    getHostOriginGrantPublicKey,
    mintArtifactOriginFetchGrant,
    resolveTrustedHostOriginGrantPublicKey,
    verifyActiveHostWorkerLedgerAttempt,
    verifyArtifactOriginFetchGrant,
    verifyLocalWorkerQueueAndLedgerFence,
    type ArtifactOriginFetchGrant,
};

function trimString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export async function resolveRegisteredSessionWorkspace(
    ctx: ArtifactCommandContext,
    sessionId: string,
    opts?: {
        meshId?: string;
        nodeId?: string;
        taskId?: string;
        allowTrustedWorkerFallback?: boolean;
        allowStoredArtifactWorkspaceFallback?: boolean;
        artifactId?: string;
    },
): Promise<{
    workspaceRoot: string | null;
    nodeWorkspaceRoot: string | null;
    providerType: string;
    status: string;
    title: string | null;
}> {
    let sessionWorkspace: string | null = null;
    let providerType = 'unknown';
    let status = 'running';
    let title: string | null = null;

    const regTarget = ctx.deps?.sessionRegistry?.get?.(sessionId);
    if (regTarget) {
        if (trimString(regTarget.workspace)) {
            sessionWorkspace = trimString(regTarget.workspace);
        }
        if (trimString(regTarget.providerType)) {
            providerType = trimString(regTarget.providerType);
        }
    }

    const instMgr = ctx.deps?.instanceManager as any;
    const inst = instMgr?.getInstance?.(sessionId) ?? instMgr?.get?.(sessionId);
    if (inst) {
        const instWorkspace =
            trimString(inst.workspace) ||
            trimString(inst.getWorkspace?.()) ||
            trimString(inst.settings?.workspace);
        if (!sessionWorkspace && instWorkspace) {
            sessionWorkspace = instWorkspace;
        }
        const instProvider = trimString(inst.providerType) || trimString(inst.type);
        if (providerType === 'unknown' && instProvider) {
            providerType = instProvider;
        }
        const instStatus = trimString(inst.status) || trimString(inst.getStatus?.());
        if (instStatus) {
            status = instStatus;
        }
        const instTitle = trimString(inst.title) || trimString(inst.settings?.title);
        if (instTitle) {
            title = instTitle;
        }
    }

    const cliMgr = ctx.deps?.cliManager as any;
    const cliSession =
        cliMgr?.getSessionByConversationId?.(sessionId) ??
        cliMgr?.getSession?.(sessionId);
    if (cliSession) {
        const cliWorkspace = trimString(cliSession.workspace) || trimString(cliSession.cwd);
        if (!sessionWorkspace && cliWorkspace) {
            sessionWorkspace = cliWorkspace;
        }
        const cliProvider = trimString(cliSession.cliType) || trimString(cliSession.providerType);
        if (providerType === 'unknown' && cliProvider) {
            providerType = cliProvider;
        }
    }

    if (!sessionWorkspace) {
        const coord = getCoordinatorForSession(sessionId);
        if (coord && trimString(coord.workspace)) {
            sessionWorkspace = trimString(coord.workspace);
            if (providerType === 'unknown' && trimString(coord.cliType)) {
                providerType = trimString(coord.cliType);
            }
        }
    }

    if (!sessionWorkspace) {
        try {
            const assistantEntry = getAssistantRegistry().read();
            if (
                assistantEntry &&
                assistantEntry.sessionId &&
                sessionIdsEquivalent(assistantEntry.sessionId, sessionId) &&
                trimString(assistantEntry.workspace)
            ) {
                sessionWorkspace = trimString(assistantEntry.workspace);
                if (providerType === 'unknown' && trimString(assistantEntry.cliType)) {
                    providerType = trimString(assistantEntry.cliType);
                }
            }
        } catch {
            // Best-effort assistant registry lookup.
        }
    }

    let nodeWorkspaceRoot: string | null = null;
    if (opts?.allowTrustedWorkerFallback) {
        const meshId = trimString(opts.meshId);
        const nodeId = trimString(opts.nodeId);
        const taskId = trimString(opts.taskId);

        if (meshId) {
            try {
                const meshStore = getMeshRuntimeStore(ctx);
                if (taskId) {
                    const queueEntry = meshStore.findQueueEntryById(meshId, taskId) as Record<string, unknown> | null;
                    const assignedSession = trimString(queueEntry?.assignedSessionId);
                    const queueStatus = trimString(queueEntry?.status);
                    if (
                        queueEntry &&
                        (!queueStatus || queueStatus === 'assigned') &&
                        (!assignedSession || sessionIdsEquivalent(assignedSession, sessionId))
                    ) {
                        const queuePayload = (queueEntry?.payload ?? {}) as Record<string, unknown>;
                        const queueWs =
                            trimString(queueEntry?.worktreePath) ||
                            trimString(queueEntry?.workspace) ||
                            trimString(queueEntry?.workspaceRoot) ||
                            trimString(queuePayload.worktreePath) ||
                            trimString(queuePayload.workspace) ||
                            trimString(queuePayload.workspaceRoot);
                        if (queueWs) {
                            nodeWorkspaceRoot = queueWs;
                        }
                    }
                }
            } catch {
                // Ignore queue lookup failures.
            }

            if (!nodeWorkspaceRoot && nodeId) {
                try {
                    const cmdRes: any = await ctx.getMeshForCommand?.(meshId);
                    const resolvedMesh =
                        cmdRes?.mesh ??
                        cmdRes ??
                        ctx.getCachedInlineMesh?.(meshId);
                    const nodes: any[] = Array.isArray(resolvedMesh?.nodes) ? resolvedMesh.nodes : [];
                    const matchedNode = nodes.find(
                        (n) => trimString(n?.id) === nodeId || trimString(n?.nodeId) === nodeId,
                    );
                    const nodeWs = trimString(matchedNode?.workspace) || trimString(matchedNode?.worktreePath);
                    if (nodeWs) {
                        nodeWorkspaceRoot = nodeWs;
                    }
                } catch {
                    // Ignore mesh lookup failures.
                }
            }
        }
    }

    if (!sessionWorkspace && !nodeWorkspaceRoot && opts?.allowStoredArtifactWorkspaceFallback) {
        try {
            const store = getArtifactStore(ctx);
            const targetArtifactId = trimString(opts.artifactId);
            if (targetArtifactId) {
                const rec = store.get(targetArtifactId);
                if (rec && sessionIdsEquivalent(rec.sessionId, sessionId) && trimString(rec.workspaceRoot)) {
                    sessionWorkspace = trimString(rec.workspaceRoot);
                    status = 'stopped';
                }
            }
            if (!sessionWorkspace && sessionId) {
                const existing = store.listBySession(sessionId, { limit: 1 });
                if (existing.length > 0 && trimString(existing[0].workspaceRoot)) {
                    sessionWorkspace = trimString(existing[0].workspaceRoot);
                    status = 'stopped';
                }
            }
        } catch {
            // Best-effort stored workspace fallback for ended sessions.
        }
    }

    return {
        workspaceRoot: sessionWorkspace ?? nodeWorkspaceRoot,
        nodeWorkspaceRoot,
        providerType,
        status,
        title,
    };
}

export function handleArtifactError(err: unknown): CommandRouterResult {
    if (err instanceof ArtifactGuardError) {
        return {
            success: false,
            code: err.code,
            error: err.message,
        };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
        success: false,
        code: 'artifact_command_failed',
        error: message,
    };
}

export async function isSessionAuthorizedForMesh(
    ctx: ArtifactCommandContext,
    meshStore: any,
    meshId: string,
    sessionId: string,
): Promise<boolean> {
    if (!meshId || !sessionId) return false;
    try {
        const coord = getCoordinatorForSession(sessionId);
        if (coord) {
            if (coord.meshId !== meshId) return false;
            return true;
        }
    } catch {
        // Continue to store/mesh membership checks.
    }

    if (meshStore) {
        try {
            const assigned = meshStore.findAssignedBySession?.(meshId, sessionId);
            if (assigned) return true;
        } catch {
            // Continue.
        }
        try {
            // Every queue row of the mesh, terminal ones included, so a worker whose
            // session has since stopped still counts as a member of the mesh it ran in.
            const queueHeads: any[] = meshStore.getQueueHeads?.(meshId) ?? [];
            if (
                Array.isArray(queueHeads) &&
                queueHeads.some((entry) =>
                    sessionIdsEquivalent(trimString(entry?.assignedSessionId), sessionId),
                )
            ) {
                return true;
            }
        } catch {
            // Continue.
        }
    }

    const matchesMeshNodes = (mesh: any): boolean => {
        if (!mesh || !Array.isArray(mesh.nodes)) return false;
        return mesh.nodes.some((node: any) => {
            const nodeSid = trimString(node?.sessionId);
            const activeSid = trimString(node?.activeSessionId);
            const coordSid = trimString(node?.coordinatorSessionId);
            if (
                (nodeSid && sessionIdsEquivalent(nodeSid, sessionId)) ||
                (activeSid && sessionIdsEquivalent(activeSid, sessionId)) ||
                (coordSid && sessionIdsEquivalent(coordSid, sessionId))
            ) {
                return true;
            }
            const sessions = Array.isArray(node?.sessions) ? node.sessions : [];
            if (
                sessions.some((s: any) =>
                    sessionIdsEquivalent(trimString(typeof s === 'string' ? s : s?.sessionId), sessionId),
                )
            ) {
                return true;
            }
            const delegated = Array.isArray(node?.delegatedSessions) ? node.delegatedSessions : [];
            return delegated.some((s: any) =>
                sessionIdsEquivalent(trimString(typeof s === 'string' ? s : s?.sessionId), sessionId),
            );
        });
    };

    try {
        const cachedMesh = ctx.getCachedInlineMesh?.(meshId);
        if (matchesMeshNodes(cachedMesh)) return true;
    } catch {
        // Continue.
    }

    try {
        const resolved: any = await ctx.getMeshForCommand?.(meshId);
        if (matchesMeshNodes(resolved?.mesh ?? resolved)) return true;
    } catch {
        // Continue.
    }

    try {
        const store = getArtifactStore(ctx);
        const existing = store.listBySession(sessionId, { limit: 10 });
        if (existing.some((rec) => rec.meshId === meshId)) return true;
    } catch {
        // Continue.
    }

    return false;
}

export function readWorkerAssignmentStamp(
    ctx: ArtifactCommandContext,
    sessionId: string,
): {
    meshId: string;
    ownerDaemonId: string;
    taskId?: string;
    attemptId?: string;
    nodeId?: string;
    generation?: number;
} | null {
    try {
        const instMgr = ctx.deps?.instanceManager as any;
        const inst = instMgr?.getInstance?.(sessionId) ?? instMgr?.get?.(sessionId);
        const state = inst?.getState?.() ?? inst;
        const settings = state?.settings && typeof state.settings === 'object' ? state.settings : undefined;
        if (!settings) return null;
        const meshId = trimString(settings.meshNodeFor);
        const ownerDaemonId = trimString(settings.meshCoordinatorDaemonId);
        const attemptRef = currentMeshAttemptRef(settings);
        const attemptId =
            attemptRef?.attemptId ||
            trimString(settings.meshActiveAttemptId) ||
            trimString(settings.meshAttemptId);
        const generation =
            attemptRef?.generation ??
            (typeof settings.meshActiveAttemptGeneration === 'number' && Number.isSafeInteger(settings.meshActiveAttemptGeneration)
                ? settings.meshActiveAttemptGeneration
                : typeof settings.meshAttemptGeneration === 'number' && Number.isSafeInteger(settings.meshAttemptGeneration)
                  ? settings.meshAttemptGeneration
                  : undefined);
        const taskId = trimString(settings.meshActiveTaskId) || trimString(settings.meshTaskId);
        const nodeId = trimString(settings.meshNodeId) || trimString(settings.meshLastNodeId);
        return {
            meshId,
            ownerDaemonId,
            ...(taskId ? { taskId } : {}),
            ...(attemptId ? { attemptId } : {}),
            ...(generation !== undefined ? { generation } : {}),
            ...(nodeId ? { nodeId } : {}),
        };
    } catch {
        return null;
    }
}

export async function resolveRemoteWorkerForArtifact(
    ctx: ArtifactCommandContext,
    credential: { bind?: unknown; token?: unknown; taskId?: unknown; attemptId?: unknown },
) {
    const selfDaemonId = trimString(ctx.deps?.statusInstanceId);
    if (!selfDaemonId) return null;
    const binding = verifyWorkerSessionBind(credential.bind);
    const directToken = verifyWorkerTaskToken(credential.token);
    const meshIdHint = binding?.meshId || directToken?.meshId || '';
    let resolvedMeshRecord: any = null;
    if (meshIdHint) {
        try {
            const cmdMesh: any = await ctx.getMeshForCommand?.(meshIdHint);
            resolvedMeshRecord = cmdMesh?.mesh ?? cmdMesh ?? ctx.getCachedInlineMesh?.(meshIdHint);
        } catch {
            resolvedMeshRecord = ctx.getCachedInlineMesh?.(meshIdHint);
        }
    }
    const readStamp = (sessionId: string): WorkerAssignmentStamp | null => {
        const raw = readWorkerAssignmentStamp(ctx, sessionId);
        if (!raw || !raw.meshId || !raw.ownerDaemonId) return null;
        return raw;
    };
    const resolveMeshHostOwner = (
        meshId: string,
        sessionId: string,
        nodeId?: string,
    ): WorkerAssignmentStamp | null => {
        const mesh = resolvedMeshRecord ?? ctx.getCachedInlineMesh?.(meshId);
        if (!mesh) return null;
        const hostDaemonId =
            trimString(mesh?.meshHost?.hostDaemonId) ||
            trimString(mesh?.hostDaemonId);
        if (!hostDaemonId || daemonIdsEquivalent(hostDaemonId, selfDaemonId)) return null;
        const nodes: any[] = Array.isArray(mesh?.nodes) ? mesh.nodes : [];
        const matchedNode = nodes.find((n: any) => {
            if (
                nodeId &&
                (meshNodeIdMatches(n, nodeId) ||
                    trimString(n?.id) === nodeId ||
                    trimString(n?.nodeId) === nodeId)
            ) {
                return true;
            }
            const activeSid = trimString(n?.activeSessionId) || trimString(n?.sessionId);
            return Boolean(activeSid && sessionIdsEquivalent(activeSid, sessionId));
        });
        if (!matchedNode) return null;
        const nodeDaemon = readMeshNodeDaemonId(matchedNode) || trimString(matchedNode?.daemonId);
        if (nodeDaemon && !daemonIdsEquivalent(nodeDaemon, selfDaemonId)) return null;
        const resolvedNodeId = trimString(matchedNode?.id) || trimString(matchedNode?.nodeId) || nodeId;
        const raw = readWorkerAssignmentStamp(ctx, sessionId);
        return {
            meshId,
            ownerDaemonId: hostDaemonId,
            ...(raw?.taskId ? { taskId: raw.taskId } : {}),
            ...(raw?.attemptId ? { attemptId: raw.attemptId } : {}),
            ...(raw?.generation !== undefined ? { generation: raw.generation } : {}),
            ...(resolvedNodeId ? { nodeId: resolvedNodeId } : raw?.nodeId ? { nodeId: raw.nodeId } : {}),
        };
    };
    return resolveRemoteWorkerIdentity(credential, {
        readAssignmentStamp: readStamp,
        isSelfDaemon: (daemonId) => daemonIdsEquivalent(daemonId, selfDaemonId),
        resolveMeshHostOwner,
    });
}

export interface RemoteWorkerHostTaskScope {
    readonly missionId: string | null;
    readonly inputArtifactIds: readonly string[];
    readonly inputArtifacts: readonly ArtifactRecord[];
    readonly requestedArtifact: ArtifactRecord | null;
    readonly originFetchGrant?: ArtifactOriginFetchGrant | null;
}

export async function resolveRemoteWorkerTaskScopeFromHost(
    ctx: ArtifactCommandContext,
    hostDaemonId: string,
    remoteClaim: ForwardedWorkerReportClaim & { nodeId?: string },
    requestedArtifactId?: string,
): Promise<{ ok: true; scope: RemoteWorkerHostTaskScope } | { ok: false; result: CommandRouterResult }> {
    if (!hostDaemonId || !ctx.deps?.dispatchMeshCommand) {
        return {
            ok: false,
            result: {
                success: false,
                code: 'artifact_origin_unreachable',
                error: `Host daemon "${hostDaemonId || 'unknown'}" is unreachable for remote worker task authorization (artifact_origin_unreachable)`,
            },
        };
    }
    try {
        const rawScope = await ctx.deps.dispatchMeshCommand(hostDaemonId, 'artifact_index_forwarded', {
            ...remoteClaim,
            resolveScopeOnly: true,
            ...(requestedArtifactId ? { artifactId: requestedArtifactId } : {}),
        });
        const scopeAns = unwrapMeshRelayResult(rawScope, {
            command: 'artifact_index_forwarded',
            peerDaemonId: hostDaemonId,
        });
        if (scopeAns.success !== true) {
            return {
                ok: false,
                result: {
                    success: false,
                    code:
                        (typeof scopeAns.code === 'string' && scopeAns.code) ||
                        (typeof scopeAns.error === 'string' && scopeAns.error) ||
                        'unauthenticated',
                    error:
                        typeof scopeAns.detail === 'string'
                            ? scopeAns.detail
                            : String(scopeAns.error || 'Failed to resolve remote worker task scope from host daemon'),
                },
            };
        }
        const missionId = trimString(scopeAns.missionId) || null;
        const inputArtifactIds = Array.isArray(scopeAns.inputArtifactIds)
            ? scopeAns.inputArtifactIds.map((id: unknown) => trimString(id)).filter((id: string) => id.length > 0)
            : [];
        const inputArtifacts = Array.isArray(scopeAns.inputArtifacts)
            ? (scopeAns.inputArtifacts.filter((a: unknown) => a && typeof a === 'object') as ArtifactRecord[])
            : [];
        const requestedArtifact =
            scopeAns.requestedArtifact && typeof scopeAns.requestedArtifact === 'object'
                ? (scopeAns.requestedArtifact as ArtifactRecord)
                : null;
        const originFetchGrant =
            scopeAns.originFetchGrant && typeof scopeAns.originFetchGrant === 'object'
                ? (scopeAns.originFetchGrant as ArtifactOriginFetchGrant)
                : null;
        return {
            ok: true,
            scope: {
                missionId,
                inputArtifactIds,
                inputArtifacts,
                requestedArtifact,
                ...(originFetchGrant ? { originFetchGrant } : {}),
            },
        };
    } catch (err) {
        return {
            ok: false,
            result: {
                success: false,
                code: 'artifact_origin_unreachable',
                error: err instanceof Error ? err.message : String(err),
            },
        };
    }
}

export async function authorizeCrossSessionArtifactAccess(
    ctx: ArtifactCommandContext,
    authority: ResolvedSessionAuthority,
    record: ArtifactRecord,
): Promise<{ ok: true; trustedWorkspaceRoot: string | null } | { ok: false; result: CommandRouterResult }> {
    const artifactId = record.artifactId;
    if (sessionIdsEquivalent(record.sessionId, authority.sessionId)) {
        return { ok: true, trustedWorkspaceRoot: authority.workspaceRoot || record.workspaceRoot };
    }
    if (authority.producerRole === 'worker') {
        const meshStore = getMeshRuntimeStore(ctx);
        const taskEntry =
            authority.meshId && authority.taskId
                ? (meshStore.findQueueEntryById(authority.meshId, authority.taskId) as Record<string, unknown> | null)
                : null;
        const taskPayload = (taskEntry?.payload ?? {}) as Record<string, unknown>;
        const workerMissionId =
            trimString(taskEntry?.missionId) || trimString(taskPayload.missionId) || authority.missionId || '';
        const rawInputIds = Array.isArray(taskEntry?.inputArtifactIds)
            ? taskEntry.inputArtifactIds
            : Array.isArray(taskPayload.inputArtifactIds)
              ? taskPayload.inputArtifactIds
              : (authority.remoteInputArtifactIds ?? []);
        const allowedIds = new Set(rawInputIds.map((id: unknown) => trimString(id)).filter((id: string) => id.length > 0));
        let recordMissionId = trimString(record.missionId);
        if (!recordMissionId && record.taskId) {
            try {
                const prodEntry = meshStore.findQueueEntryById(
                    record.meshId || authority.meshId || '',
                    record.taskId,
                ) as Record<string, unknown> | null;
                recordMissionId =
                    trimString(prodEntry?.missionId) ||
                    trimString((prodEntry?.payload as Record<string, unknown> | undefined)?.missionId);
            } catch {
                recordMissionId = '';
            }
        }
        const sameMission = Boolean(workerMissionId && recordMissionId && workerMissionId === recordMissionId);
        const sameMesh = !record.meshId || !authority.meshId || record.meshId === authority.meshId;
        if (!sameMission || !sameMesh || !allowedIds.has(artifactId)) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'artifact_access_denied',
                    error: `Worker session "${authority.sessionId}" is not authorized to read artifact "${artifactId}" (OD-4 requires same mission and inclusion in inputArtifactIds) (artifact_access_denied)`,
                },
            };
        }
        return { ok: true, trustedWorkspaceRoot: record.workspaceRoot || null };
    }
    if (authority.isCoordinator && authority.meshId) {
        const meshStore = getMeshRuntimeStore(ctx);
        // A record bound to a mesh must match authority's mesh exactly; the session-based
        // fallback applies only to records that carry no mesh binding at all.
        const inMesh = record.meshId
            ? record.meshId === authority.meshId
            : await isSessionAuthorizedForMesh(ctx, meshStore, authority.meshId, record.sessionId);
        if (!inMesh) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'artifact_session_mismatch',
                    error: `Artifact "${artifactId}" does not belong to mesh "${authority.meshId}" (artifact_session_mismatch)`,
                },
            };
        }
        return { ok: true, trustedWorkspaceRoot: record.workspaceRoot };
    }
    return {
        ok: false,
        result: {
            success: false,
            code: 'artifact_session_mismatch',
            error: `Artifact ${artifactId} belongs to session "${record.sessionId}", not "${authority.sessionId}" (artifact_session_mismatch)`,
        },
    };
}

export { ORIGIN_FETCH_CHUNK_BYTES, reassembleBase64ArtifactChunks };

export function chunkArtifactBytesBase64(content: string): string[] {
    const buf = Buffer.from(content, 'utf8');
    if (buf.length === 0) return [];
    const chunks: string[] = [];
    for (let i = 0; i < buf.length; i += ORIGIN_FETCH_CHUNK_BYTES) {
        chunks.push(buf.subarray(i, i + ORIGIN_FETCH_CHUNK_BYTES).toString('base64'));
    }
    return chunks;
}

export function listWorkerAuthorizedArtifacts(
    ctx: ArtifactCommandContext,
    authority: ResolvedSessionAuthority,
    store: ArtifactStore,
    options?: { filterMissionId?: string; limit?: number },
): ArtifactRecord[] {
    const own = store.listBySession(authority.sessionId, { limit: options?.limit });
    const meshStore = getMeshRuntimeStore(ctx);
    const taskEntry =
        authority.meshId && authority.taskId
            ? (meshStore.findQueueEntryById(authority.meshId, authority.taskId) as Record<
                  string,
                  unknown
              > | null)
            : null;
    const taskPayload = (taskEntry?.payload ?? {}) as Record<string, unknown>;
    const workerMissionId =
        trimString(taskEntry?.missionId) ||
        trimString(taskPayload.missionId) ||
        authority.missionId ||
        '';
    const rawInputIds = Array.isArray(taskEntry?.inputArtifactIds)
        ? taskEntry.inputArtifactIds
        : Array.isArray(taskPayload.inputArtifactIds)
          ? taskPayload.inputArtifactIds
          : (authority.remoteInputArtifactIds ?? []);
    const remoteArtifactById = new Map(
        (authority.remoteInputArtifacts ?? []).map((rec) => [rec.artifactId, rec] as const),
    );
    const seen = new Set<string>(own.map((rec) => rec.artifactId));
    const merged: ArtifactRecord[] = [...own];
    for (const rawId of rawInputIds) {
        const id = trimString(rawId);
        if (!id || seen.has(id)) continue;
        const record = store.get(id) ?? remoteArtifactById.get(id);
        if (!record) continue;
        let recordMissionId = trimString(record.missionId);
        if (!recordMissionId && record.taskId) {
            try {
                const prodEntry = meshStore.findQueueEntryById(
                    record.meshId || authority.meshId || '',
                    record.taskId,
                ) as Record<string, unknown> | null;
                recordMissionId =
                    trimString(prodEntry?.missionId) ||
                    trimString((prodEntry?.payload as Record<string, unknown> | undefined)?.missionId);
            } catch {
                recordMissionId = '';
            }
        }
        const sameMission = Boolean(workerMissionId && recordMissionId && workerMissionId === recordMissionId);
        const sameMesh = !record.meshId || !authority.meshId || record.meshId === authority.meshId;
        if (sameMission && sameMesh) {
            seen.add(id);
            merged.push(record);
        }
    }
    const filtered = options?.filterMissionId
        ? merged.filter((rec) => rec.missionId === options.filterMissionId)
        : merged;
    return options?.limit !== undefined ? filtered.slice(0, options.limit) : filtered;
}

export async function fetchArtifactFromOriginDaemon(
    ctx: ArtifactCommandContext,
    authority: ResolvedSessionAuthority,
    record: ArtifactRecord,
    args: any,
    isReadCommand: boolean,
): Promise<CommandRouterResult> {
    const artifactId = record.artifactId;
    const originDaemonId = trimString(record.originDaemonId) || trimString(authority.hostDaemonId);
    if (!originDaemonId || !ctx.deps?.dispatchMeshCommand) {
        return {
            success: false,
            code: 'artifact_origin_unreachable',
            error: `Artifact "${artifactId}" resides on origin daemon "${originDaemonId}", and no P2P mesh transport is available`,
        };
    }
    let originFetchGrant = authority.originFetchGrant as ArtifactOriginFetchGrant | undefined;
    let effectiveAttemptId = trimString(authority.remoteClaim?.attemptId) || trimString(originFetchGrant?.requesterAttemptId);
    if (!originFetchGrant && authority.producerRole === 'worker' && authority.originDaemonId && authority.taskId) {
        const meshIdForGrant = record.meshId || authority.meshId || '';
        const latestAttempt = meshIdForGrant
            ? getMeshRuntimeStore(ctx).turnStore().findLatestAttemptForTask(meshIdForGrant, authority.taskId)
            : null;
        const attemptIdForGrant = effectiveAttemptId || latestAttempt?.attemptId || '';
        effectiveAttemptId = attemptIdForGrant;
        if (meshIdForGrant && attemptIdForGrant) {
            originFetchGrant = mintArtifactOriginFetchGrant({
                meshId: meshIdForGrant,
                hostDaemonId: authority.originDaemonId,
                originDaemonId,
                artifactId: record.artifactId,
                requesterSessionId: authority.sessionId,
                requesterTaskId: authority.taskId,
                requesterAttemptId: attemptIdForGrant,
            });
        }
    }
    const requesterTaskId = authority.taskId || trimString(originFetchGrant?.requesterTaskId);
    let rawOrigin: unknown;
    try {
        rawOrigin = await ctx.deps.dispatchMeshCommand(
            originDaemonId,
            'artifact_fetch_origin',
            {
                meshId: record.meshId || authority.meshId || undefined,
                artifactId: record.artifactId,
                sessionId: record.sessionId,
                requesterSessionId: authority.sessionId,
                requesterRole: authority.isCoordinator ? 'coordinator' : authority.producerRole,
                ...(requesterTaskId ? { requesterTaskId } : {}),
                ...(authority.missionId ? { requesterMissionId: authority.missionId } : {}),
                ...(effectiveAttemptId ? { requesterAttemptId: effectiveAttemptId } : {}),
                ...(authority.remoteClaim?.nodeId ? { requesterNodeId: authority.remoteClaim.nodeId } : {}),
                ...(authority.remoteClaim?.generation !== undefined ? { requesterGeneration: authority.remoteClaim.generation } : {}),
                ...(originFetchGrant ? { originFetchGrant } : {}),
                mode: isReadCommand ? 'read' : 'fetch',
                asChunks: true,
                ...(args?.offset !== undefined ? { offset: args.offset } : {}),
                ...(args?.pageOffset !== undefined ? { pageOffset: args.pageOffset } : {}),
                ...(args?.limit !== undefined ? { limit: args.limit } : {}),
            },
        );
    } catch (err) {
        return {
            success: false,
            code: 'artifact_origin_unreachable',
            error: err instanceof Error ? err.message : String(err),
        };
    }
    const originAns = unwrapMeshRelayResult(rawOrigin, {
        command: 'artifact_fetch_origin',
        peerDaemonId: originDaemonId,
    });
    if (originAns.success !== true) {
        return {
            success: false,
            code:
                (typeof originAns.code === 'string' && originAns.code) ||
                (typeof originAns.error === 'string' && originAns.error) ||
                'artifact_origin_fetch_failed',
            error: String(originAns.error || 'Failed to fetch artifact from origin daemon'),
        };
    }
    const rawMaxBytes = isReadCommand ? MAX_ARTIFACT_MCP_PAGE_BYTES : MAX_ARTIFACT_BYTES;
    const encoding =
        typeof originAns.encoding === 'string'
            ? originAns.encoding
            : record.kind === 'image'
              ? 'base64'
              : 'utf8';
    const isBase64Encoded = encoding === 'base64' || record.kind === 'image';
    const transportMaxBytes = isBase64Encoded ? maxBase64EncodedBytes(rawMaxBytes) : rawMaxBytes;
    if (
        (typeof originAns.sizeBytes === 'number' && originAns.sizeBytes > MAX_ARTIFACT_BYTES) ||
        (typeof originAns.totalBytes === 'number' && originAns.totalBytes > MAX_ARTIFACT_BYTES) ||
        (isReadCommand && typeof originAns.pageBytes === 'number' && originAns.pageBytes > MAX_ARTIFACT_MCP_PAGE_BYTES)
    ) {
        return {
            success: false,
            code: 'artifact_too_large',
            error: `Artifact content exceeds ${rawMaxBytes} bytes limit (artifact_too_large)`,
        };
    }
    let rawContent = '';
    if (Array.isArray(originAns.chunks) && originAns.chunks.length > 0) {
        const reassembled = reassembleBase64ArtifactChunks(originAns.chunks, transportMaxBytes);
        if (!reassembled.ok) {
            return {
                success: false,
                code: reassembled.code,
                error: reassembled.error,
            };
        }
        rawContent = reassembled.content;
    } else if (typeof originAns.content === 'string') {
        if (Buffer.byteLength(originAns.content, 'utf8') > transportMaxBytes) {
            return {
                success: false,
                code: 'artifact_too_large',
                error: `Artifact content exceeds ${rawMaxBytes} bytes limit (artifact_too_large)`,
            };
        }
        rawContent = originAns.content;
    }
    let decodedByteLength = Buffer.byteLength(rawContent, 'utf8');
    if (isBase64Encoded && rawContent.length > 0) {
        decodedByteLength = Buffer.from(rawContent, 'base64').byteLength;
        if (decodedByteLength > rawMaxBytes || decodedByteLength > MAX_ARTIFACT_BYTES) {
            return {
                success: false,
                code: 'artifact_too_large',
                error: `Decoded image artifact content (${decodedByteLength} bytes) exceeds ${rawMaxBytes} bytes limit (artifact_too_large)`,
            };
        }
    }
    const sha256Changed = Boolean(originAns.sha256Changed);
    return {
        success: true,
        artifactId: record.artifactId,
        sessionId: record.sessionId,
        relPath: record.relPath,
        kind: record.kind,
        mime: record.mime,
        title: record.title,
        encoding,
        sizeBytes: typeof originAns.sizeBytes === 'number' ? originAns.sizeBytes : record.sizeBytes,
        ...(isReadCommand
            ? {
                  totalBytes: typeof originAns.totalBytes === 'number' ? originAns.totalBytes : record.sizeBytes,
                  offset: typeof originAns.offset === 'number' ? originAns.offset : 0,
                  pageBytes:
                      typeof originAns.pageBytes === 'number'
                          ? originAns.pageBytes
                          : decodedByteLength,
                  hasMore: Boolean(originAns.hasMore),
                  nextOffset: typeof originAns.nextOffset === 'number' ? originAns.nextOffset : null,
              }
            : {}),
        sha256: typeof originAns.sha256 === 'string' ? originAns.sha256 : record.sha256,
        registeredSha256:
            typeof originAns.registeredSha256 === 'string' ? originAns.registeredSha256 : record.sha256,
        sha256Changed,
        hashChanged: Boolean(originAns.hashChanged ?? sha256Changed),
        content: isReadCommand ? wrapUntrustedArtifactContent(rawContent) : rawContent,
        artifact: record,
        attachment: toChatAttachmentMeta(record),
    };
}

export const handleArtifactIndexForwarded: MedFamilyHandler = async (ctx, args) => {
    const senderDaemonId = readMeshSender(args);
    const meshId = trimString(args?.meshId);
    const sessionId = trimString(args?.sessionId);
    const taskId = trimString(args?.taskId) || undefined;
    const attemptId = trimString(args?.attemptId) || undefined;
    const generation =
        typeof args?.generation === 'number' && Number.isSafeInteger(args.generation)
            ? args.generation
            : undefined;
    const resolveScopeOnly = args?.resolveScopeOnly === true;
    const rawArtifact =
        args?.artifact && typeof args.artifact === 'object' && !Array.isArray(args.artifact)
            ? (args.artifact as Record<string, unknown>)
            : null;
    if (!meshId || !sessionId || (!resolveScopeOnly && (!rawArtifact || !trimString(rawArtifact.artifactId)))) {
        return {
            success: false,
            code: 'invalid_arguments',
            error: 'artifact_index_forwarded: invalid payload',
        };
    }

    let nodes: any[] = [];
    let meshObj: any = null;
    try {
        const meshRes: any = await ctx.getMeshForCommand?.(meshId, undefined, { preferInline: true });
        meshObj = meshRes?.mesh ?? meshRes ?? ctx.getCachedInlineMesh?.(meshId);
        nodes = Array.isArray(meshObj?.nodes) ? meshObj.nodes : [];
    } catch {
        nodes = [];
    }
    const nodeDaemonId = (nodeId: string) => {
        const node = nodes.find(
            (n: any) => meshNodeIdMatches(n, nodeId) || trimString(n?.id) === nodeId || trimString(n?.nodeId) === nodeId,
        );
        return node ? readMeshNodeDaemonId(node) || trimString(node?.daemonId) : undefined;
    };

    const selfDaemonId = trimString(ctx.deps?.statusInstanceId);
    const isSelfDaemon = selfDaemonId ? (d: string) => daemonIdsEquivalent(d, selfDaemonId) : undefined;
    const resolved = resolveForwardedWorkerIdentity(
        {
            meshId,
            sessionId,
            ...(taskId ? { taskId } : {}),
            ...(attemptId ? { attemptId } : {}),
            ...(generation !== undefined ? { generation } : {}),
        },
        { senderDaemonId, nodeDaemonId },
        Date.now(),
        isSelfDaemon,
    );
    if ('refused' in resolved) {
        const refusalCode =
            resolved.refused === 'attempt_mismatch' || resolved.refused === 'generation_mismatch'
                ? 'stale_attempt'
                : resolved.refused === 'task_mismatch'
                  ? 'task_mismatch'
                  : 'unauthenticated';
        return {
            success: false,
            code: refusalCode,
            error: resolved.refused,
            detail: `${resolved.refused}: ${resolved.detail}`,
        };
    }
    if (!('live' in resolved)) {
        return { success: false, code: 'stale_attempt', error: 'Worker task attempt is no longer active (stale_attempt)' };
    }
    const ownerIdentity = resolved.live;

    try {
        const meshStore = getMeshRuntimeStore(ctx);
        const ledgerCheck = verifyActiveHostWorkerLedgerAttempt(meshStore, {
            meshId,
            taskId: ownerIdentity.taskId,
            sessionId: ownerIdentity.sessionId,
            attemptId: attemptId || ownerIdentity.attemptId,
        });
        if (!ledgerCheck.ok) {
            return { success: false, code: ledgerCheck.code, error: ledgerCheck.error };
        }
        const queueEntry = meshStore.findQueueEntryById(meshId, ownerIdentity.taskId) as Record<string, unknown> | null;
        if (!queueEntry) {
            return {
                success: false,
                code: 'unauthenticated',
                error: `Worker task "${ownerIdentity.taskId}" has no active queue assignment on host (unauthenticated)`,
            };
        }
        const queueStatus = trimString(queueEntry.status);
        if (queueStatus && queueStatus !== 'assigned') {
            return {
                success: false,
                code: 'stale_attempt',
                error: `Task "${ownerIdentity.taskId}" is not in assigned state on host (stale_attempt)`,
            };
        }
        const assignedSession = trimString(queueEntry.assignedSessionId);
        if (assignedSession && !sessionIdsEquivalent(assignedSession, ownerIdentity.sessionId)) {
            return {
                success: false,
                code: 'artifact_session_mismatch',
                error: `Task "${ownerIdentity.taskId}" is assigned to "${assignedSession}", not "${ownerIdentity.sessionId}" (artifact_session_mismatch)`,
            };
        }
        const queuePayload = (queueEntry.payload ?? {}) as Record<string, unknown>;
        const missionId =
            trimString(queueEntry.missionId) ||
            trimString(queuePayload.missionId) ||
            null;

        const store = getArtifactStore(ctx);
        if (resolveScopeOnly) {
            const rawInputIds = Array.isArray(queueEntry.inputArtifactIds)
                ? queueEntry.inputArtifactIds
                : Array.isArray(queuePayload.inputArtifactIds)
                  ? queuePayload.inputArtifactIds
                  : [];
            const inputArtifactIds = rawInputIds.map((id: unknown) => trimString(id)).filter((id: string) => id.length > 0);
            const resolveRecMission = (rec: ArtifactRecord): string => {
                const direct = trimString(rec.missionId);
                if (direct) return direct;
                if (!rec.taskId) return '';
                try {
                    const pe = meshStore.findQueueEntryById(rec.meshId || meshId, rec.taskId) as Record<string, unknown> | null;
                    return trimString(pe?.missionId) || trimString((pe?.payload as Record<string, unknown> | undefined)?.missionId);
                } catch {
                    return '';
                }
            };
            const inputArtifacts: ArtifactRecord[] = [];
            const allowedSet = new Set(inputArtifactIds);
            for (const id of inputArtifactIds) {
                const rec = store.get(id);
                if (!rec) continue;
                const recMissionId = resolveRecMission(rec);
                const sameMission = Boolean(missionId && recMissionId && missionId === recMissionId);
                const sameMesh = !rec.meshId || rec.meshId === meshId;
                if (sameMission && sameMesh) {
                    inputArtifacts.push({
                        ...rec,
                        ...(recMissionId ? { missionId: recMissionId } : {}),
                        originDaemonId: rec.originDaemonId || selfDaemonId || null,
                    });
                }
            }
            let requestedArtifact: ArtifactRecord | null = null;
            const reqArtifactId = trimString(args?.artifactId);
            if (reqArtifactId) {
                const reqRec = store.get(reqArtifactId);
                if (!reqRec) {
                    return { success: false, code: 'artifact_not_found', error: `Artifact not found: ${reqArtifactId} (artifact_not_found)` };
                }
                const reqMissionId = resolveRecMission(reqRec);
                const isAllowed =
                    sessionIdsEquivalent(reqRec.sessionId, ownerIdentity.sessionId) ||
                    (Boolean(missionId && reqMissionId && missionId === reqMissionId) &&
                        (!reqRec.meshId || reqRec.meshId === meshId) &&
                        allowedSet.has(reqArtifactId));
                if (!isAllowed) {
                    return {
                        success: false,
                        code: 'artifact_access_denied',
                        error: `Worker session "${ownerIdentity.sessionId}" is not authorized to access artifact "${reqArtifactId}" (artifact_access_denied)`,
                    };
                }
                requestedArtifact = {
                    ...reqRec,
                    ...(reqMissionId ? { missionId: reqMissionId } : {}),
                    originDaemonId: reqRec.originDaemonId || selfDaemonId || null,
                };
            }
            const originFetchGrant =
                requestedArtifact && selfDaemonId && requestedArtifact.originDaemonId
                    ? mintArtifactOriginFetchGrant({
                          meshId,
                          hostDaemonId: selfDaemonId,
                          originDaemonId: requestedArtifact.originDaemonId,
                          artifactId: requestedArtifact.artifactId,
                          requesterSessionId: ownerIdentity.sessionId,
                          requesterTaskId: ownerIdentity.taskId,
                          requesterAttemptId: ledgerCheck.attemptId,
                      })
                    : undefined;
            return {
                success: true,
                missionId,
                inputArtifactIds,
                inputArtifacts,
                requestedArtifact,
                ...(originFetchGrant ? { originFetchGrant } : {}),
            };
        }

        const hostNow = Date.now();
        const maxForwardedTimestamp = hostNow + 60_000;
        const rawCreated = Number(rawArtifact!.createdAt);
        const clampedCreatedAt = Number.isFinite(rawCreated) && rawCreated > 0 ? Math.min(Math.trunc(rawCreated), maxForwardedTimestamp) : hostNow;
        const rawUpdated = Number(rawArtifact!.updatedAt);
        const clampedUpdatedAt =
            Number.isFinite(rawUpdated) && rawUpdated > 0 ? Math.max(clampedCreatedAt, Math.min(Math.trunc(rawUpdated), maxForwardedTimestamp)) : clampedCreatedAt;
        const upserted = store.upsertForwardedArtifact({
            artifactId: trimString(rawArtifact!.artifactId),
            sessionId: ownerIdentity.sessionId,
            taskId: ownerIdentity.taskId,
            meshId,
            missionId,
            producerRole: 'worker',
            originDaemonId: senderDaemonId,
            workspaceRoot: trimString(rawArtifact!.workspaceRoot),
            relPath: trimString(rawArtifact!.relPath),
            kind: trimString(rawArtifact!.kind) as ArtifactKind,
            mime: trimString(rawArtifact!.mime),
            sizeBytes: Number(rawArtifact!.sizeBytes) || 0,
            sha256: trimString(rawArtifact!.sha256),
            title: typeof rawArtifact!.title === 'string' ? rawArtifact!.title : null,
            previewText: typeof rawArtifact!.previewText === 'string' ? rawArtifact!.previewText : null,
            createdAt: clampedCreatedAt,
            updatedAt: clampedUpdatedAt,
        });
        return {
            success: true,
            artifact: upserted.record,
            attachment: upserted.attachment,
            artifactId: upserted.record.artifactId,
            sessionId: upserted.record.sessionId,
            taskId: upserted.record.taskId,
            isUpdate: upserted.isUpdate,
        };
    } catch (err) {
        return handleArtifactError(err);
    }
};

export const handleArtifactFetchOrigin: MedFamilyHandler = async (ctx, args) => {
    const senderDaemonId = readMeshSender(args);
    if (!senderDaemonId) {
        return { success: false, code: 'unauthenticated', error: 'artifact_fetch_origin requires an authenticated mesh peer sender' };
    }
    const artifactId = trimString(args?.artifactId) || trimString(args?.id);
    if (!artifactId) {
        return { success: false, code: 'invalid_arguments', error: 'artifactId is required' };
    }
    try {
        const store = getArtifactStore(ctx);
        const record = store.get(artifactId);
        if (!record) {
            return { success: false, code: 'artifact_not_found', error: `Artifact not found on origin daemon: ${artifactId} (artifact_not_found)` };
        }
        // A forwarded (metadata-only) record carries a peer-supplied workspaceRoot/relPath.
        // This daemon may only serve bytes for records that originate on THIS daemon.
        const ownDaemonId = trimString(ctx.deps?.statusInstanceId);
        const recordOrigin = trimString(record.originDaemonId);
        if (!ownDaemonId || (recordOrigin && !daemonIdsEquivalent(recordOrigin, ownDaemonId))) {
            return { success: false, code: 'artifact_not_found', error: `Artifact not found on origin daemon: ${artifactId} (artifact_not_found)` };
        }
        const reqMeshId = trimString(args?.meshId);
        if (reqMeshId && record.meshId && record.meshId !== reqMeshId) {
            return { success: false, code: 'artifact_session_mismatch', error: `Artifact "${artifactId}" does not belong to mesh "${reqMeshId}" (artifact_session_mismatch)` };
        }
        const meshIdToVerify = record.meshId || reqMeshId;
        if (!meshIdToVerify) {
            return { success: false, code: 'unauthenticated', error: `Artifact "${artifactId}" has no mesh binding for cross-daemon origin fetch (unauthenticated)` };
        }
        const cmdRes: any = await ctx.getMeshForCommand?.(meshIdToVerify, undefined, { preferInline: true });
        const meshObj = cmdRes?.mesh ?? cmdRes ?? ctx.getCachedInlineMesh?.(meshIdToVerify);
        if (!meshObj) {
            return { success: false, code: 'unauthenticated', error: `Mesh "${meshIdToVerify}" is not available to authorize origin fetch (unauthenticated)` };
        }
        const hostDaemonId = trimString(meshObj?.meshHost?.hostDaemonId) || trimString(meshObj?.hostDaemonId);
        const nodes: any[] = Array.isArray(meshObj?.nodes) ? meshObj.nodes : [];
        const isKnownPeer =
            (hostDaemonId && daemonIdsEquivalent(hostDaemonId, senderDaemonId)) ||
            nodes.some((n: any) => {
                const nd = readMeshNodeDaemonId(n) || trimString(n?.daemonId);
                return Boolean(nd && daemonIdsEquivalent(nd, senderDaemonId));
            });
        if (!isKnownPeer) {
            return { success: false, code: 'unauthenticated', error: `Sender daemon "${senderDaemonId}" is not an authorized member of mesh "${meshIdToVerify}"` };
        }
        const selfDaemonId = trimString(ctx.deps?.statusInstanceId);
        const isSelfHost = Boolean(hostDaemonId && selfDaemonId && daemonIdsEquivalent(hostDaemonId, selfDaemonId));
        const isSenderHost = Boolean(hostDaemonId && daemonIdsEquivalent(hostDaemonId, senderDaemonId));
        const requesterRole = trimString(args?.requesterRole);
        if (isSelfHost || !isSenderHost || requesterRole === 'worker') {
            const denial = authorizeWorkerOriginFetch({
                args,
                record,
                meshIdToVerify,
                hostDaemonId,
                selfDaemonId,
                senderDaemonId,
                isSelfHost,
                nodes,
                meshObj,
                getMeshStore: () => getMeshRuntimeStore(ctx),
            });
            if (denial) return denial;
        }
        const boundArtifactId = record.artifactId;
        const rawMode = trimString(args?.mode);
        const mode =
            rawMode === 'fetch'
                ? 'fetch'
                : rawMode === 'read' ||
                    args?.asChunks === true ||
                    typeof args?.offset === 'number' ||
                    typeof args?.pageOffset === 'number' ||
                    typeof args?.limit === 'number'
                  ? 'read'
                  : 'fetch';
        if (mode === 'read') {
            const readOffset =
                typeof args?.offset === 'number'
                    ? args.offset
                    : typeof args?.pageOffset === 'number'
                      ? args.pageOffset
                      : undefined;
            const readLimit = typeof args?.limit === 'number' ? args.limit : undefined;
            const readRes = store.readArtifactContent(boundArtifactId, {
                sessionId: record.sessionId,
                trustedWorkspaceRoot: record.workspaceRoot,
                ...(readOffset !== undefined ? { offset: readOffset } : {}),
                ...(readLimit !== undefined ? { limit: readLimit } : {}),
            });
            return {
                success: true,
                artifactId: readRes.artifactId,
                sessionId: readRes.sessionId,
                relPath: readRes.relPath,
                kind: readRes.kind,
                mime: readRes.mime,
                title: readRes.title,
                encoding: readRes.encoding,
                sizeBytes: readRes.sizeBytes,
                totalBytes: readRes.totalBytes,
                offset: readRes.offset,
                pageBytes: readRes.pageBytes,
                hasMore: readRes.hasMore,
                nextOffset: readRes.nextOffset,
                sha256: readRes.sha256,
                registeredSha256: readRes.registeredSha256,
                sha256Changed: readRes.sha256Changed,
                hashChanged: readRes.hashChanged,
                chunks: chunkArtifactBytesBase64(readRes.content),
                chunkByteSize: ORIGIN_FETCH_CHUNK_BYTES,
                artifact: record,
                attachment: toChatAttachmentMeta(record),
            };
        }
        const fetched = store.fetchArtifactContent(boundArtifactId, {
            sessionId: record.sessionId,
            trustedWorkspaceRoot: record.workspaceRoot,
        });
        return {
            success: true,
            artifactId: fetched.artifactId,
            sessionId: fetched.sessionId,
            relPath: fetched.relPath,
            kind: fetched.kind,
            mime: fetched.mime,
            title: fetched.title,
            encoding: fetched.encoding,
            sizeBytes: fetched.sizeBytes,
            sha256: fetched.sha256,
            registeredSha256: fetched.registeredSha256,
            sha256Changed: fetched.sha256Changed,
            hashChanged: fetched.hashChanged,
            chunks: chunkArtifactBytesBase64(fetched.content),
            chunkByteSize: ORIGIN_FETCH_CHUNK_BYTES,
            artifact: record,
            attachment: toChatAttachmentMeta(record),
        };
    } catch (err) {
        return handleArtifactError(err);
    }
};
