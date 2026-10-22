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
    toChatAttachmentMeta,
    wrapUntrustedArtifactContent,
    type ArtifactKind,
    type ArtifactRecord,
} from '../../artifacts/index.js';
import { readMeshNodeDaemonId } from '../../mesh/mesh-node-identity.js';
import { verifyWorkerSessionBind } from '../../mesh/worker-mcp-isolation.js';
import {
    resolveForwardedWorkerIdentity,
    resolveRemoteWorkerIdentity,
    type WorkerAssignmentStamp,
} from '../../mesh/worker-report-forwarded.js';
import { currentMeshAttemptRef } from '../../providers/cli-provider-mesh-assignment.js';
import { getCoordinatorForSession } from '../../mesh/coordinator-registry.js';
import { getAssistantRegistry } from '../../assistant/assistant-registry.js';
import {
    getArtifactStore,
    getMeshRuntimeStore,
    type ArtifactCommandContext,
    type ResolvedSessionAuthority,
} from './artifacts.js';

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
            const queueEntries: any[] = meshStore.getQueue?.(meshId) ?? [];
            if (
                Array.isArray(queueEntries) &&
                queueEntries.some((entry) =>
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

export async function resolveRemoteWorkerForArtifact(
    ctx: ArtifactCommandContext,
    credential: { bind?: unknown; token?: unknown },
) {
    const selfDaemonId = trimString(ctx.deps?.statusInstanceId);
    if (!selfDaemonId) return null;
    const binding = verifyWorkerSessionBind(credential.bind);
    const meshIdHint = binding?.meshId || '';
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
        try {
            const instMgr = ctx.deps?.instanceManager as any;
            const inst = instMgr?.getInstance?.(sessionId) ?? instMgr?.get?.(sessionId);
            const state = inst?.getState?.() ?? inst;
            const settings = state?.settings && typeof state.settings === 'object' ? state.settings : undefined;
            if (!settings) return null;
            const meshId = trimString(settings.meshNodeFor);
            const ownerDaemonId = trimString(settings.meshCoordinatorDaemonId);
            if (!meshId || !ownerDaemonId) return null;
            const attemptRef = currentMeshAttemptRef(settings);
            const taskId = trimString(settings.meshActiveTaskId);
            const nodeId = trimString(settings.meshNodeId) || trimString(settings.meshLastNodeId);
            return {
                meshId,
                ownerDaemonId,
                ...(taskId ? { taskId } : {}),
                ...(attemptRef ? { attemptId: attemptRef.attemptId, generation: attemptRef.generation } : {}),
                ...(nodeId ? { nodeId } : {}),
            };
        } catch {
            return null;
        }
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
        return {
            meshId,
            ownerDaemonId: hostDaemonId,
            ...(resolvedNodeId ? { nodeId: resolvedNodeId } : {}),
        };
    };
    return resolveRemoteWorkerIdentity(credential, {
        readAssignmentStamp: readStamp,
        isSelfDaemon: (daemonId) => daemonIdsEquivalent(daemonId, selfDaemonId),
        resolveMeshHostOwner,
    });
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
              : [];
        const allowedIds = new Set(
            rawInputIds.map((id: unknown) => trimString(id)).filter((id: string) => id.length > 0),
        );
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
        const sameMission = Boolean(
            workerMissionId && recordMissionId && workerMissionId === recordMissionId,
        );
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
        return { ok: true, trustedWorkspaceRoot: record.workspaceRoot };
    }
    if (authority.isCoordinator && authority.meshId) {
        const meshStore = getMeshRuntimeStore(ctx);
        const inMesh =
            (record.meshId && record.meshId === authority.meshId) ||
            (await isSessionAuthorizedForMesh(ctx, meshStore, authority.meshId, record.sessionId));
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

export async function fetchArtifactFromOriginDaemon(
    ctx: ArtifactCommandContext,
    authority: ResolvedSessionAuthority,
    record: ArtifactRecord,
    args: any,
    isReadCommand: boolean,
): Promise<CommandRouterResult> {
    const artifactId = record.artifactId;
    if (!ctx.deps?.dispatchMeshCommand) {
        return {
            success: false,
            code: 'artifact_origin_unreachable',
            error: `Artifact "${artifactId}" resides on origin daemon "${record.originDaemonId}", and no P2P mesh transport is available`,
        };
    }
    const rawOrigin = await ctx.deps.dispatchMeshCommand(
        record.originDaemonId!,
        'artifact_fetch_origin',
        {
            meshId: record.meshId || authority.meshId || undefined,
            artifactId: record.artifactId,
            sessionId: record.sessionId,
            mode: isReadCommand ? 'read' : 'fetch',
            ...(args?.offset !== undefined ? { offset: args.offset } : {}),
            ...(args?.pageOffset !== undefined ? { pageOffset: args.pageOffset } : {}),
            ...(args?.limit !== undefined ? { limit: args.limit } : {}),
        },
    );
    const originAns = unwrapMeshRelayResult(rawOrigin, {
        command: 'artifact_fetch_origin',
        peerDaemonId: record.originDaemonId!,
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
    const rawContent = String(originAns.content ?? '');
    return {
        ...originAns,
        success: true,
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
    const rawArtifact =
        args?.artifact && typeof args.artifact === 'object' && !Array.isArray(args.artifact)
            ? (args.artifact as Record<string, unknown>)
            : null;
    if (!meshId || !sessionId || !rawArtifact || !trimString(rawArtifact.artifactId)) {
        return {
            success: false,
            code: 'invalid_arguments',
            error: 'artifact_index_forwarded: invalid payload',
        };
    }

    let nodes: any[] = [];
    try {
        const meshRes: any = await ctx.getMeshForCommand?.(meshId, undefined, { preferInline: true });
        const meshObj = meshRes?.mesh ?? meshRes ?? ctx.getCachedInlineMesh?.(meshId);
        nodes = Array.isArray(meshObj?.nodes) ? meshObj.nodes : [];
    } catch {
        nodes = [];
    }
    const nodeDaemonId = (nodeId: string) => {
        const node = nodes.find(
            (n: any) =>
                meshNodeIdMatches(n, nodeId) ||
                trimString(n?.id) === nodeId ||
                trimString(n?.nodeId) === nodeId,
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
        return {
            success: false,
            code: 'unauthenticated',
            error: resolved.refused,
            detail: `${resolved.refused}: ${resolved.detail}`,
        };
    }
    const ownerIdentity = 'live' in resolved ? resolved.live : resolved.late;

    try {
        const meshStore = getMeshRuntimeStore(ctx);
        const queueEntry = meshStore.findQueueEntryById(meshId, ownerIdentity.taskId) as Record<
            string,
            unknown
        > | null;
        const missionId =
            trimString(queueEntry?.missionId) ||
            trimString((queueEntry?.payload as Record<string, unknown> | undefined)?.missionId) ||
            trimString(rawArtifact.missionId) ||
            null;

        const store = getArtifactStore(ctx);
        const upserted = store.upsertForwardedArtifact({
            artifactId: trimString(rawArtifact.artifactId),
            sessionId: ownerIdentity.sessionId,
            taskId: ownerIdentity.taskId,
            meshId,
            missionId,
            producerRole: 'worker',
            originDaemonId: senderDaemonId,
            workspaceRoot: trimString(rawArtifact.workspaceRoot),
            relPath: trimString(rawArtifact.relPath),
            kind: trimString(rawArtifact.kind) as ArtifactKind,
            mime: trimString(rawArtifact.mime),
            sizeBytes: Number(rawArtifact.sizeBytes) || 0,
            sha256: trimString(rawArtifact.sha256),
            title: typeof rawArtifact.title === 'string' ? rawArtifact.title : null,
            previewText: typeof rawArtifact.previewText === 'string' ? rawArtifact.previewText : null,
            createdAt: Number(rawArtifact.createdAt) || Date.now(),
            updatedAt: Number(rawArtifact.updatedAt) || Date.now(),
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
        return {
            success: false,
            code: 'unauthenticated',
            error: 'artifact_fetch_origin requires an authenticated mesh peer sender',
        };
    }
    const artifactId = trimString(args?.artifactId) || trimString(args?.id);
    if (!artifactId) {
        return {
            success: false,
            code: 'invalid_arguments',
            error: 'artifactId is required',
        };
    }
    try {
        const store = getArtifactStore(ctx);
        const record = store.get(artifactId);
        if (!record) {
            return {
                success: false,
                code: 'artifact_not_found',
                error: `Artifact not found on origin daemon: ${artifactId} (artifact_not_found)`,
            };
        }
        const reqMeshId = trimString(args?.meshId);
        if (reqMeshId && record.meshId && record.meshId !== reqMeshId) {
            return {
                success: false,
                code: 'artifact_session_mismatch',
                error: `Artifact "${artifactId}" does not belong to mesh "${reqMeshId}" (artifact_session_mismatch)`,
            };
        }
        const meshIdToVerify = record.meshId || reqMeshId;
        if (meshIdToVerify) {
            const cmdRes: any = await ctx.getMeshForCommand?.(meshIdToVerify, undefined, {
                preferInline: true,
            });
            const meshObj = cmdRes?.mesh ?? cmdRes ?? ctx.getCachedInlineMesh?.(meshIdToVerify);
            if (meshObj) {
                const hostDaemonId =
                    trimString(meshObj?.meshHost?.hostDaemonId) || trimString(meshObj?.hostDaemonId);
                const nodes: any[] = Array.isArray(meshObj?.nodes) ? meshObj.nodes : [];
                const isKnownPeer =
                    (hostDaemonId && daemonIdsEquivalent(hostDaemonId, senderDaemonId)) ||
                    nodes.some((n: any) => {
                        const nd = readMeshNodeDaemonId(n) || trimString(n?.daemonId);
                        return Boolean(nd && daemonIdsEquivalent(nd, senderDaemonId));
                    });
                if (!isKnownPeer) {
                    return {
                        success: false,
                        code: 'unauthenticated',
                        error: `Sender daemon "${senderDaemonId}" is not an authorized member of mesh "${meshIdToVerify}"`,
                    };
                }
            }
        }
        const mode = trimString(args?.mode) === 'read' ? 'read' : 'fetch';
        if (mode === 'read') {
            const readOffset =
                typeof args?.offset === 'number'
                    ? args.offset
                    : typeof args?.pageOffset === 'number'
                      ? args.pageOffset
                      : undefined;
            const readLimit = typeof args?.limit === 'number' ? args.limit : undefined;
            const readRes = store.readArtifactContent(artifactId, {
                sessionId: record.sessionId,
                trustedWorkspaceRoot: record.workspaceRoot,
                ...(readOffset !== undefined ? { offset: readOffset } : {}),
                ...(readLimit !== undefined ? { limit: readLimit } : {}),
            });
            return {
                success: true,
                ...readRes,
                artifact: record,
                attachment: toChatAttachmentMeta(record),
            };
        }
        const fetched = store.fetchArtifactContent(artifactId, {
            sessionId: record.sessionId,
            trustedWorkspaceRoot: record.workspaceRoot,
        });
        return {
            success: true,
            ...fetched,
            artifact: record,
            attachment: toChatAttachmentMeta(record),
        };
    } catch (err) {
        return handleArtifactError(err);
    }
};
