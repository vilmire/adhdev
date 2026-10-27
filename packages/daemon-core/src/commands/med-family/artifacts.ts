/**
 * Daemon artifact commands (Task B):
 *   - `artifact_register` (alias `session_artifact_register`)
 *   - `artifact_list` (alias `session_artifact_list`)
 *   - `artifact_fetch` (aliases `artifact_read`, `session_artifact_fetch`)
 *
 * Security & ownership invariants:
 *   1. Worker callers (`bind` or `token` present) are authenticated via
 *      `resolveWorkerIdentity(store, bind, token)`. Exact `sessionId`,
 *      `taskId`, and workspace ownership are enforced against the worker's
 *      live credential and registered session/node workspace.
 *   2. Normal / assistant / coordinator callers resolve the session's trusted
 *      registered workspace from daemon runtime state (`sessionRegistry`,
 *      `instanceManager`, `cliManager`, `coordinator-registry`,
 *      `assistant-registry`, or mesh node). Arbitrary workspace paths in the
 *      command payload are never trusted, and cross-session fetches are
 *      rejected with `artifact_session_mismatch`.
 *   3. All path canonicalization, traversal/symlink containment, allowlist
 *      checks, 4 MiB size cap, 600-char preview cap, 50-artifact session cap,
 *      and read-time descriptor revalidation delegate to `ArtifactStore`.
 *   4. Registering or updating an artifact publishes a committed keyed-chat
 *      frame (`m:artifact:<artifactId>`, `kind: 'artifact'`,
 *      `attachment: ChatAttachmentMeta`) through `TranscriptProjectionService`.
 */

import * as fs from 'node:fs';
import { daemonIdsEquivalent, sessionIdsEquivalent } from '@adhdev/mesh-shared';
import { readRouterCommandIngress } from '../command-args.js';
import { hasWorkerCredentialInput, verifyArtifactCommandIngress } from './artifact-command-ingress.js';
import {
    bindAuthenticatedMcpWorkspace,
    readAuthenticatedMcpCommand,
    readAuthenticatedMcpScope,
} from '../mcp-command-ingress.js';
import { defineCommandSpecs } from '../command-registry.js';
import { unwrapMeshRelayResult } from '../mesh-relay-result.js';
import type { CommandRouterResult } from '../router.js';
import type { MedFamilyHandler } from './types.js';
import {
    toChatAttachmentMeta,
    wrapUntrustedArtifactContent,
    type ArtifactKind,
    type ArtifactProducerRole,
    type ArtifactRecord,
} from '../../artifacts/index.js';
import {
    verifyWorkerSessionBind,
    verifyWorkerTaskToken,
} from '../../mesh/worker-mcp-isolation.js';
import { classifyUnresolvedWorkerCredential, resolveWorkerIdentity } from '../../mesh/worker-report.js';
import { type ForwardedWorkerReportClaim } from '../../mesh/worker-report-forwarded.js';
import { getCoordinatorForSession } from '../../mesh/coordinator-registry.js';
import { getAssistantRegistry } from '../../assistant/assistant-registry.js';
import { publishSessionArtifactBubble } from '../../seqscribe/transcript-publisher.js';
import {
    authorizeCrossSessionArtifactAccess,
    fetchArtifactFromOriginDaemon,
    handleArtifactError,
    handleArtifactFetchOrigin,
    handleArtifactIndexForwarded,
    isSessionAuthorizedForMesh,
    listWorkerAuthorizedArtifacts,
    readWorkerAssignmentStamp,
    resolveRegisteredSessionWorkspace,
    resolveRemoteWorkerForArtifact,
    resolveRemoteWorkerTaskScopeFromHost,
    verifyLocalWorkerQueueAndLedgerFence,
} from './artifact-sharing.js';
import { getArtifactStore, getMeshRuntimeStore, type ArtifactCommandContext } from './artifact-runtime.js';

export { handleArtifactFetchOrigin, handleArtifactIndexForwarded };

export {
    getArtifactStore,
    getMeshRuntimeStore,
    setArtifactCommandRuntimeForDeps,
    type ArtifactCommandContext,
    type ArtifactCommandRuntime,
} from './artifact-runtime.js';

function trimString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function canonicalizeDir(dirPath: string): string | null {
    const trimmed = trimString(dirPath);
    if (!trimmed) return null;
    try {
        const stat = fs.statSync(trimmed);
        if (!stat.isDirectory()) return null;
        return fs.realpathSync(trimmed);
    } catch {
        return null;
    }
}

export interface ResolvedSessionAuthority {
    readonly sessionId: string;
    readonly taskId: string | null;
    readonly meshId: string | null;
    readonly missionId: string | null;
    readonly producerRole: ArtifactProducerRole;
    readonly originDaemonId: string | null;
    readonly workspaceRoot: string | null;
    readonly providerType: string;
    readonly status: string;
    readonly title: string | null;
    readonly isCoordinator?: boolean;
    readonly isRemoteWorker?: boolean;
    readonly hostDaemonId?: string | null;
    readonly remoteClaim?: ForwardedWorkerReportClaim & { nodeId?: string };
    readonly remoteInputArtifactIds?: readonly string[];
    readonly remoteInputArtifacts?: readonly ArtifactRecord[];
    readonly remoteRequestedArtifact?: ArtifactRecord | null;
    readonly originFetchGrant?: unknown;
}

async function resolveCallerAuthority(
    ctx: ArtifactCommandContext,
    args: Record<string, unknown>,
    mode: 'register' | 'list' | 'fetch',
    ownerTrusted = false,
): Promise<{ ok: true; authority: ResolvedSessionAuthority } | { ok: false; result: CommandRouterResult }> {
    const rawBind = args?.bind;
    const rawToken = args?.token;
    const hasWorkerCredential = hasWorkerCredentialInput(args);

    const rawSessionId = trimString(args?.sessionId);
    const rawTargetSessionId = trimString(args?.targetSessionId);
    const rawCallerSessionId = trimString(args?.callerSessionId);

    if (rawSessionId && rawTargetSessionId && !sessionIdsEquivalent(rawSessionId, rawTargetSessionId)) {
        return {
            ok: false,
            result: {
                success: false,
                code: 'artifact_session_mismatch',
                error: `Conflicting sessionId "${rawSessionId}" and targetSessionId "${rawTargetSessionId}" (artifact_session_mismatch)`,
            },
        };
    }

    const explicitSessionId = rawSessionId || rawTargetSessionId;
    const explicitMeshId = trimString(args?.meshId);
    const routerIngress = readRouterCommandIngress(args);
    const mcp = readAuthenticatedMcpCommand(args, routerIngress?.command ?? '');
    const mcpScope = mcp.valid ? readAuthenticatedMcpScope(args, routerIngress?.command ?? '') : null;

    const coordCandidateId =
        mcp.valid && mcpScope?.sessionId
            ? mcpScope.sessionId
            : ownerTrusted
              ? rawCallerSessionId || explicitSessionId
              : '';
    const coordEntry = coordCandidateId ? getCoordinatorForSession(coordCandidateId) : undefined;
    const isVerifiedCoordinator = Boolean(
        coordEntry &&
            (ownerTrusted || (mcp.valid && mcpScope?.isCoordinator === true)) &&
            (!explicitMeshId || coordEntry.meshId === explicitMeshId) &&
            (!rawCallerSessionId || sessionIdsEquivalent(rawCallerSessionId, coordEntry.sessionId)),
    );

    if (
        rawCallerSessionId &&
        explicitSessionId &&
        !sessionIdsEquivalent(rawCallerSessionId, explicitSessionId) &&
        (!isVerifiedCoordinator || mode === 'register')
    ) {
        return {
            ok: false,
            result: {
                success: false,
                code: 'artifact_session_mismatch',
                error: `Caller session "${rawCallerSessionId}" cannot access artifacts of session "${explicitSessionId}" (artifact_session_mismatch)`,
            },
        };
    }

    const payloadWorkspace = trimString(args?.workspaceRoot) || trimString(args?.workspace);
    const selfDaemonId = trimString(ctx.deps?.statusInstanceId) || null;
    const requestedArtifactId = trimString(args?.artifactId) || trimString(args?.id);

    if (hasWorkerCredential) {
        const explicitTaskId = trimString(args?.taskId);
        const explicitAttemptId = trimString(args?.attemptId);
        const hasRawToken = typeof rawToken === 'string' && rawToken.trim().length > 0;
        const directToken = hasRawToken ? verifyWorkerTaskToken(rawToken) : null;
        if (hasRawToken && !directToken) {
            const unresolved = classifyUnresolvedWorkerCredential({ token: rawToken, bind: rawBind });
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'unauthenticated',
                    refusal: unresolved.refusal,
                    error: unresolved.detail ?? 'Valid worker task token is required (unauthenticated)',
                },
            };
        }
        const tokenTaskId = trimString(directToken?.taskId);
        const tokenAttemptId = trimString(directToken?.attemptId);
        if (explicitTaskId && tokenTaskId && explicitTaskId !== tokenTaskId) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'task_mismatch',
                    error: `Worker credential belongs to task "${tokenTaskId}", not "${explicitTaskId}" (task_mismatch)`,
                },
            };
        }
        if (explicitAttemptId && tokenAttemptId && explicitAttemptId !== tokenAttemptId) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'stale_attempt',
                    error: `Worker credential attempt "${tokenAttemptId}" does not match requested attempt "${explicitAttemptId}" (stale_attempt)`,
                },
            };
        }

        const meshStore = getMeshRuntimeStore(ctx);
        const identity = resolveWorkerIdentity(meshStore, rawBind, rawToken);
        let hasLocalWorkerRow = false;
        if (identity && trimString(identity.sessionId)) {
            try {
                const workerSid = trimString(identity.sessionId);
                hasLocalWorkerRow = Boolean(
                    meshStore.findAssignedBySession(identity.meshId, workerSid) ||
                        meshStore.findQueueEntryById(identity.meshId, identity.taskId),
                );
            } catch {
                hasLocalWorkerRow = false;
            }
        }

        if (!identity || !trimString(identity.sessionId) || !hasLocalWorkerRow) {
            const bindVerified =
                typeof rawBind === 'string' && rawBind.trim().length > 0
                    ? verifyWorkerSessionBind(rawBind)
                    : null;
            const candidateSessionId =
                trimString(directToken?.sessionId) ||
                trimString(bindVerified?.sessionId) ||
                trimString(identity?.sessionId);
            const liveStamp = candidateSessionId ? readWorkerAssignmentStamp(ctx, candidateSessionId) : null;
            const liveStampTaskId = trimString(liveStamp?.taskId);
            const liveStampAttemptId = trimString(liveStamp?.attemptId);
            if (
                liveStampTaskId &&
                ((explicitTaskId && explicitTaskId !== liveStampTaskId) ||
                    (tokenTaskId && tokenTaskId !== liveStampTaskId))
            ) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'task_mismatch',
                        error: `Worker credential task "${tokenTaskId || explicitTaskId}" does not match current session assignment "${liveStampTaskId}" (task_mismatch)`,
                    },
                };
            }
            if (
                liveStampAttemptId &&
                ((explicitAttemptId && explicitAttemptId !== liveStampAttemptId) ||
                    (tokenAttemptId && tokenAttemptId !== liveStampAttemptId))
            ) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'stale_attempt',
                        error: `Worker credential attempt "${tokenAttemptId || explicitAttemptId}" is stale for current session assignment "${liveStampAttemptId}" (stale_attempt)`,
                    },
                };
            }

            const remote = await resolveRemoteWorkerForArtifact(ctx, {
                bind: rawBind,
                token: rawToken,
                ...(explicitTaskId ? { taskId: explicitTaskId } : {}),
                ...(explicitAttemptId ? { attemptId: explicitAttemptId } : {}),
            });
            if (remote) {
                const remoteSessionId = trimString(remote.sessionId);
                if (
                    (explicitSessionId && !sessionIdsEquivalent(explicitSessionId, remoteSessionId)) ||
                    (rawCallerSessionId && !sessionIdsEquivalent(rawCallerSessionId, remoteSessionId)) ||
                    (explicitMeshId && explicitMeshId !== remote.meshId)
                ) {
                    return {
                        ok: false,
                        result: {
                            success: false,
                            code: 'artifact_session_mismatch',
                            error: `Worker credential belongs to session "${remoteSessionId}" in mesh "${remote.meshId}" (artifact_session_mismatch)`,
                        },
                    };
                }
                const remoteTaskId = trimString(remote.taskId);
                const remoteAttemptId = trimString(remote.attemptId);
                if (
                    (explicitTaskId && remoteTaskId && explicitTaskId !== remoteTaskId) ||
                    (tokenTaskId && remoteTaskId && tokenTaskId !== remoteTaskId)
                ) {
                    return {
                        ok: false,
                        result: {
                            success: false,
                            code: 'task_mismatch',
                            error: `Worker credential belongs to task "${tokenTaskId || remoteTaskId}", not "${explicitTaskId || remoteTaskId}" (task_mismatch)`,
                        },
                    };
                }
                if (
                    (explicitAttemptId && remoteAttemptId && explicitAttemptId !== remoteAttemptId) ||
                    (tokenAttemptId && remoteAttemptId && tokenAttemptId !== remoteAttemptId)
                ) {
                    return {
                        ok: false,
                        result: {
                            success: false,
                            code: 'stale_attempt',
                            error: `Worker credential attempt "${tokenAttemptId || explicitAttemptId}" does not match session attempt "${remoteAttemptId}" (stale_attempt)`,
                        },
                    };
                }
                const boundTaskId = tokenTaskId || explicitTaskId || remoteTaskId;
                const boundAttemptId = tokenAttemptId || explicitAttemptId || remoteAttemptId;
                const resolvedRemote = await resolveRegisteredSessionWorkspace(ctx, remoteSessionId, {
                    meshId: remote.meshId,
                    nodeId: remote.nodeId,
                    taskId: boundTaskId || undefined,
                    allowTrustedWorkerFallback: true,
                    allowStoredArtifactWorkspaceFallback: mode !== 'register',
                    artifactId: requestedArtifactId,
                });
                if (resolvedRemote.workspaceRoot && resolvedRemote.nodeWorkspaceRoot) {
                    const canonSession = canonicalizeDir(resolvedRemote.workspaceRoot);
                    const canonNode = canonicalizeDir(resolvedRemote.nodeWorkspaceRoot);
                    if (canonSession && canonNode && canonSession !== canonNode) {
                        return {
                            ok: false,
                            result: {
                                success: false,
                                code: 'invalid_workspace_root',
                                error: 'Worker session workspace does not match assigned node workspace (invalid_workspace_root)',
                            },
                        };
                    }
                }
                if (payloadWorkspace) {
                    const canonTrusted = resolvedRemote.workspaceRoot
                        ? canonicalizeDir(resolvedRemote.workspaceRoot)
                        : null;
                    const canonPayload = canonicalizeDir(payloadWorkspace);
                    if (!canonTrusted || !canonPayload || canonTrusted !== canonPayload) {
                        return {
                            ok: false,
                            result: {
                                success: false,
                                code: 'invalid_workspace_root',
                                error: 'Caller-supplied workspace path is not allowed or does not match session workspace (invalid_workspace_root)',
                            },
                        };
                    }
                }
                if (!resolvedRemote.workspaceRoot) {
                    return {
                        ok: false,
                        result: {
                            success: false,
                            code: 'invalid_workspace_root',
                            error: `No registered workspace found for remote worker session "${remoteSessionId}" (invalid_workspace_root)`,
                        },
                    };
                }
                const remoteClaim: ForwardedWorkerReportClaim & { nodeId?: string } = {
                    meshId: remote.meshId,
                    sessionId: remoteSessionId,
                    ...(boundTaskId ? { taskId: boundTaskId } : {}),
                    ...(boundAttemptId ? { attemptId: boundAttemptId } : {}),
                    ...(remote.nodeId ? { nodeId: remote.nodeId } : {}),
                    ...(remote.generation !== undefined ? { generation: remote.generation } : {}),
                };
                let hostScope:
                    | {
                          missionId: string | null;
                          inputArtifactIds: readonly string[];
                          inputArtifacts: readonly ArtifactRecord[];
                          requestedArtifact: ArtifactRecord | null;
                          originFetchGrant?: unknown;
                      }
                    | undefined;
                if (mode === 'list' || mode === 'fetch') {
                    const scopeRes = await resolveRemoteWorkerTaskScopeFromHost(
                        ctx,
                        remote.ownerDaemonId,
                        remoteClaim,
                        mode === 'fetch' ? requestedArtifactId || undefined : undefined,
                    );
                    if (!scopeRes.ok) return scopeRes;
                    hostScope = scopeRes.scope;
                }
                return {
                    ok: true,
                    authority: {
                        sessionId: remoteSessionId,
                        taskId: boundTaskId || null,
                        meshId: remote.meshId,
                        missionId: hostScope?.missionId ?? null,
                        producerRole: 'worker',
                        originDaemonId: selfDaemonId,
                        workspaceRoot: resolvedRemote.workspaceRoot,
                        providerType: resolvedRemote.providerType,
                        status: resolvedRemote.status,
                        title: resolvedRemote.title,
                        isRemoteWorker: true,
                        hostDaemonId: remote.ownerDaemonId,
                        remoteClaim,
                        ...(hostScope
                            ? {
                                  remoteInputArtifactIds: hostScope.inputArtifactIds,
                                  remoteInputArtifacts: hostScope.inputArtifacts,
                                  remoteRequestedArtifact: hostScope.requestedArtifact,
                                  ...(hostScope.originFetchGrant ? { originFetchGrant: hostScope.originFetchGrant } : {}),
                              }
                            : {}),
                    },
                };
            }
        }

        if (!identity || !trimString(identity.sessionId)) {
            const unresolved = classifyUnresolvedWorkerCredential({ token: rawToken, bind: rawBind });
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'unauthenticated',
                    refusal: unresolved.refusal,
                    error: unresolved.detail ?? 'Valid worker bind or task token is required (unauthenticated)',
                },
            };
        }

        const workerSessionId = trimString(identity.sessionId);
        if (
            (explicitSessionId && !sessionIdsEquivalent(explicitSessionId, workerSessionId)) ||
            (rawCallerSessionId && !sessionIdsEquivalent(rawCallerSessionId, workerSessionId)) ||
            (explicitMeshId && explicitMeshId !== identity.meshId)
        ) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'artifact_session_mismatch',
                    error: `Worker credential belongs to session "${workerSessionId}" in mesh "${identity.meshId}", not "${explicitSessionId || rawCallerSessionId}" (artifact_session_mismatch)`,
                },
            };
        }

        if (explicitTaskId && explicitTaskId !== identity.taskId) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'task_mismatch',
                    error: `Worker credential belongs to task "${identity.taskId}", not "${explicitTaskId}" (task_mismatch)`,
                },
            };
        }
        if (tokenAttemptId && identity.attemptId && tokenAttemptId !== identity.attemptId) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'stale_attempt',
                    error: `Worker credential attempt "${tokenAttemptId}" does not match resolved attempt "${identity.attemptId}" (stale_attempt)`,
                },
            };
        }

        const fenceRes = verifyLocalWorkerQueueAndLedgerFence({
            meshStore,
            identity,
            workerSessionId,
            explicitTaskId,
            explicitAttemptId: explicitAttemptId || tokenAttemptId,
            rawBind,
        });
        if (!fenceRes.ok) {
            return fenceRes;
        }

        const resolved = await resolveRegisteredSessionWorkspace(ctx, workerSessionId, {
            meshId: identity.meshId,
            nodeId: identity.nodeId,
            taskId: identity.taskId,
            allowTrustedWorkerFallback: true,
            allowStoredArtifactWorkspaceFallback: mode !== 'register',
            artifactId: requestedArtifactId,
        });

        if (resolved.workspaceRoot && resolved.nodeWorkspaceRoot) {
            const canonSession = canonicalizeDir(resolved.workspaceRoot);
            const canonNode = canonicalizeDir(resolved.nodeWorkspaceRoot);
            if (canonSession && canonNode && canonSession !== canonNode) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'invalid_workspace_root',
                        error: 'Worker session workspace does not match assigned node workspace (invalid_workspace_root)',
                    },
                };
            }
        }

        if (payloadWorkspace) {
            const canonTrusted = resolved.workspaceRoot ? canonicalizeDir(resolved.workspaceRoot) : null;
            const canonPayload = canonicalizeDir(payloadWorkspace);
            if (!canonTrusted || !canonPayload || canonTrusted !== canonPayload) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'invalid_workspace_root',
                        error: 'Caller-supplied workspace path is not allowed or does not match session workspace (invalid_workspace_root)',
                    },
                };
            }
        }

        if (!resolved.workspaceRoot) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'invalid_workspace_root',
                    error: `No registered workspace found for worker session "${workerSessionId}" (invalid_workspace_root)`,
                },
            };
        }

        let workerMissionId: string | null = null;
        try {
            const taskEntry = meshStore.findQueueEntryById(identity.meshId, identity.taskId) as Record<
                string,
                unknown
            > | null;
            workerMissionId =
                trimString(taskEntry?.missionId) ||
                trimString((taskEntry?.payload as Record<string, unknown> | undefined)?.missionId) ||
                null;
        } catch {
            workerMissionId = null;
        }

        const boundLocalAttemptId = tokenAttemptId || explicitAttemptId || identity.attemptId || fenceRes.attemptId;
        return {
            ok: true,
            authority: {
                sessionId: workerSessionId,
                taskId: identity.taskId,
                meshId: identity.meshId,
                missionId: workerMissionId,
                producerRole: 'worker',
                originDaemonId: selfDaemonId,
                workspaceRoot: resolved.workspaceRoot,
                providerType: resolved.providerType,
                status: resolved.status,
                title: resolved.title,
                remoteClaim: {
                    meshId: identity.meshId,
                    sessionId: workerSessionId,
                    taskId: identity.taskId,
                    ...(boundLocalAttemptId ? { attemptId: boundLocalAttemptId } : {}),
                    ...(identity.nodeId ? { nodeId: identity.nodeId } : {}),
                },
            },
        };
    }

    if (routerIngress?.source === 'ipc' && !ownerTrusted && !mcp.valid && (mode === 'list' || mode === 'fetch')) {
        return {
            ok: false,
            result: {
                success: false,
                code: 'COMMAND_SOURCE_REJECTED',
                error: 'Unauthenticated IPC call has no coordinator or session authority',
            },
        };
    }

    const effectiveSessionId =
        mcp.valid && mcpScope?.sessionId
            ? mode === 'list' && isVerifiedCoordinator && explicitSessionId
                ? explicitSessionId
                : mcpScope.sessionId
            : ownerTrusted
              ? explicitSessionId || (isVerifiedCoordinator ? rawCallerSessionId : '')
              : explicitSessionId;
    if (!effectiveSessionId) {
        return { ok: false, result: { success: false, code: 'invalid_arguments', error: 'sessionId is required' } };
    }

    const effectiveMeshId =
        mcp.valid
            ? mcpScope?.meshId || explicitMeshId || ''
            : ownerTrusted
              ? explicitMeshId || coordEntry?.meshId || ''
              : explicitMeshId;

    const explicitTaskId = trimString(args?.taskId);
    if (explicitTaskId) {
        if (!effectiveMeshId && !ownerTrusted) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'task_mismatch',
                    error: `Task "${explicitTaskId}" cannot be verified without an owning mesh scope (task_mismatch)`,
                },
            };
        }
        if (effectiveMeshId) {
            try {
                const meshStore = getMeshRuntimeStore(ctx);
                const queueEntry = meshStore.findQueueEntryById(effectiveMeshId, explicitTaskId) as Record<string, unknown> | null;
                const assignedSession = trimString(queueEntry?.assignedSessionId);
                const queueStatus = trimString(queueEntry?.status);
                if (assignedSession && !sessionIdsEquivalent(assignedSession, effectiveSessionId)) {
                    return {
                        ok: false,
                        result: {
                            success: false,
                            code: 'task_mismatch',
                            error: `Task "${explicitTaskId}" belongs to session "${assignedSession}", not "${effectiveSessionId}" (task_mismatch)`,
                        },
                    };
                }
                if (
                    !ownerTrusted &&
                    (!queueEntry ||
                        !assignedSession ||
                        !sessionIdsEquivalent(assignedSession, effectiveSessionId) ||
                        (queueStatus && queueStatus !== 'assigned'))
                ) {
                    return {
                        ok: false,
                        result: {
                            success: false,
                            code: 'task_mismatch',
                            error: `Task "${explicitTaskId}" is not actively assigned to session "${effectiveSessionId}" in mesh "${effectiveMeshId}" (task_mismatch)`,
                        },
                    };
                }
            } catch {
                if (!ownerTrusted) {
                    return {
                        ok: false,
                        result: {
                            success: false,
                            code: 'task_mismatch',
                            error: `Task "${explicitTaskId}" ownership could not be verified in mesh "${effectiveMeshId}" (task_mismatch)`,
                        },
                    };
                }
            }
        }
    }

    if (
        !ownerTrusted &&
        !isVerifiedCoordinator &&
        mode === 'register' &&
        (rawCallerSessionId || (explicitMeshId && !explicitTaskId))
    ) {
        return {
            ok: false,
            result: {
                success: false,
                code: 'artifact_session_mismatch',
                error: `Session "${effectiveSessionId}" cannot register artifacts via unverified caller/mesh scope without worker credentials (artifact_session_mismatch)`,
            },
        };
    }

    // `requireMeshMembership` lets a caller that cannot see the full mesh history
    // (the coordinator MCP server only knows live nodes) delegate the membership
    // decision here, fail-closed even on owner-trusted ingress.
    const requireMeshMembership = args?.requireMeshMembership === true && (mode === 'list' || mode === 'fetch');
    if (requireMeshMembership && !effectiveMeshId) {
        return {
            ok: false,
            result: {
                success: false,
                code: 'artifact_session_mismatch',
                error: `Session "${effectiveSessionId}" mesh membership cannot be verified without a meshId (artifact_session_mismatch)`,
            },
        };
    }
    if ((!ownerTrusted || requireMeshMembership) && (mode === 'list' || mode === 'fetch') && effectiveMeshId) {
        let meshStore: any = null;
        try { meshStore = getMeshRuntimeStore(ctx); } catch { meshStore = null; }
        const authorizedInMesh = await isSessionAuthorizedForMesh(ctx, meshStore, effectiveMeshId, effectiveSessionId);
        if (!authorizedInMesh) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'artifact_session_mismatch',
                    error: `Session "${effectiveSessionId}" is not an authorized member of mesh "${effectiveMeshId}" (artifact_session_mismatch)`,
                },
            };
        }
    }

    // Never allow caller-supplied meshId/nodeId/taskId to invent workspace
    // authority for an unregistered session (F4).
    const resolved = await resolveRegisteredSessionWorkspace(ctx, effectiveSessionId, {
        allowStoredArtifactWorkspaceFallback: mode !== 'register',
        artifactId: requestedArtifactId,
    });

    if (payloadWorkspace) {
        const canonTrusted = resolved.workspaceRoot ? canonicalizeDir(resolved.workspaceRoot) : null;
        const canonPayload = canonicalizeDir(payloadWorkspace);
        if (!canonTrusted || !canonPayload || canonTrusted !== canonPayload) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'invalid_workspace_root',
                    error: 'Arbitrary payload workspaceRoot is not allowed (invalid_workspace_root)',
                },
            };
        }
    }

    if (!resolved.workspaceRoot && !(isVerifiedCoordinator && mode !== 'register')) {
        return {
            ok: false,
            result: {
                success: false,
                code: 'invalid_workspace_root',
                error: `Session "${effectiveSessionId}" has no registered workspace on this daemon (invalid_workspace_root)`,
            },
        };
    }

    let producerRole: ArtifactProducerRole = 'user';
    if (isVerifiedCoordinator) {
        producerRole = 'coordinator';
    } else {
        try {
            const assistantEntry = getAssistantRegistry().read();
            if (assistantEntry?.sessionId && sessionIdsEquivalent(assistantEntry.sessionId, effectiveSessionId)) {
                producerRole = 'assistant';
            }
        } catch { /* Default to 'user'. */ }
    }

    return {
        ok: true,
        authority: {
            sessionId: effectiveSessionId,
            taskId: explicitTaskId || null,
            meshId: effectiveMeshId || null,
            missionId: trimString(args?.missionId) || null,
            producerRole,
            originDaemonId: selfDaemonId,
            workspaceRoot: resolved.workspaceRoot,
            providerType: resolved.providerType,
            status: resolved.status,
            title: resolved.title,
            isCoordinator: isVerifiedCoordinator,
        },
    };
}

interface ArtifactRegistrationRevisionState {
    latestSeq: number;
    lastConfirmedRecord: ArtifactRecord | null;
}

const registrationStateByStore = new WeakMap<object, Map<string, ArtifactRegistrationRevisionState>>();
let nextArtifactRegistrationSeq = 0;

function getStoreRegistrationStateMap(store: object): Map<string, ArtifactRegistrationRevisionState> {
    let map = registrationStateByStore.get(store);
    if (!map) {
        map = new Map();
        registrationStateByStore.set(store, map);
    }
    return map;
}

const handleArtifactRegister: MedFamilyHandler = async (ctx, args) => {
    const ingress = verifyArtifactCommandIngress(args, 'register');
    if (!ingress.ok) return ingress.result;
    const auth = await resolveCallerAuthority(ctx, ingress.recordArgs, 'register', ingress.ownerTrusted);
    if (!auth.ok) return auth.result;
    const currentIngress = verifyArtifactCommandIngress(args, 'register');
    if (!currentIngress.ok) return currentIngress.result;
    if (!bindAuthenticatedMcpWorkspace(args, auth.authority.workspaceRoot ?? '')) {
        return { success: false, code: 'artifact_session_mismatch', error: 'Artifact MCP workspace scope changed' };
    }

    const { authority } = auth;
    const rawPath = trimString(args?.path) || trimString(args?.relPath) || trimString(args?.rawPath) || trimString(args?.filePath);
    if (!rawPath) {
        return { success: false, code: 'invalid_arguments', error: 'Artifact file path is required' };
    }

    const declaredKind = (trimString(args?.kind) || trimString(args?.declaredKind) || undefined) as ArtifactKind | undefined;
    const declaredMime = trimString(args?.mime) || trimString(args?.declaredMime) || undefined;
    const title = typeof args?.title === 'string' ? args.title : undefined;

    try {
        const store = getArtifactStore(ctx);
        const stateMap = getStoreRegistrationStateMap(store);
        const registered = store.register({
            sessionId: authority.sessionId,
            taskId: authority.taskId,
            meshId: authority.meshId,
            missionId: authority.missionId,
            producerRole: authority.producerRole,
            originDaemonId: authority.originDaemonId,
            workspaceRoot: authority.workspaceRoot!,
            path: rawPath,
            declaredKind,
            declaredMime,
            title,
        });
        const artifactId = registered.record.artifactId;
        const mySeq = ++nextArtifactRegistrationSeq;
        const prevState = stateMap.get(artifactId);
        stateMap.set(artifactId, {
            latestSeq: mySeq,
            lastConfirmedRecord: prevState?.lastConfirmedRecord ?? null,
        });

        let finalRecord = registered.record;
        let finalAttachment = registered.attachment;
        if (authority.isRemoteWorker && authority.hostDaemonId && authority.remoteClaim && ctx.deps?.dispatchMeshCommand) {
            const rawForward = await ctx.deps.dispatchMeshCommand(
                authority.hostDaemonId,
                'artifact_index_forwarded',
                { ...authority.remoteClaim, artifact: registered.record },
            );
            const forwardAns = unwrapMeshRelayResult(rawForward, {
                command: 'artifact_index_forwarded',
                peerDaemonId: authority.hostDaemonId,
            });
            const currentState = stateMap.get(artifactId);
            if (forwardAns.success !== true) {
                const isStillLatestPending = !currentState || currentState.latestSeq === mySeq;
                if (!registered.isUpdate && isStillLatestPending && !currentState?.lastConfirmedRecord) {
                    try {
                        getMeshRuntimeStore(ctx)
                            .db.prepare(
                                'DELETE FROM session_artifacts WHERE artifact_id = ? AND updated_at = ? AND sha256 = ?',
                            )
                            .run(
                                registered.record.artifactId,
                                registered.record.updatedAt,
                                registered.record.sha256,
                            );
                        if (stateMap.get(artifactId)?.latestSeq === mySeq) {
                            stateMap.delete(artifactId);
                        }
                    } catch {
                        // Best-effort cleanup of unforwarded local artifact record.
                    }
                } else if (isStillLatestPending && currentState?.lastConfirmedRecord) {
                    try {
                        store.upsertForwardedArtifact(currentState.lastConfirmedRecord);
                    } catch {
                        // Best-effort restore of last host-confirmed record.
                    }
                }
                return {
                    success: false,
                    code: (typeof forwardAns.code === 'string' && forwardAns.code) || (typeof forwardAns.error === 'string' && forwardAns.error) || 'forward_failed',
                    error: typeof forwardAns.detail === 'string' ? forwardAns.detail : String(forwardAns.error || 'Failed to forward artifact metadata to host daemon'),
                };
            }
            if (forwardAns.artifact && typeof forwardAns.artifact === 'object') {
                if (!currentState || currentState.latestSeq === mySeq) {
                    const synced = store.upsertForwardedArtifact(forwardAns.artifact as ArtifactRecord);
                    finalRecord = synced.record;
                    finalAttachment = synced.attachment;
                } else {
                    const existingLocal = store.getById(artifactId);
                    if (existingLocal) {
                        finalRecord = existingLocal;
                    }
                }
            }
            const latestAfterConfirm = stateMap.get(artifactId);
            if (!latestAfterConfirm || latestAfterConfirm.latestSeq === mySeq) {
                stateMap.set(artifactId, {
                    latestSeq: latestAfterConfirm?.latestSeq ?? mySeq,
                    lastConfirmedRecord: finalRecord,
                });
            }
        } else {
            stateMap.set(artifactId, {
                latestSeq: mySeq,
                lastConfirmedRecord: finalRecord,
            });
        }

        try {
            const publishedFrame = await publishSessionArtifactBubble(authority.sessionId, {
                attachment: finalAttachment,
                providerType: authority.providerType,
                status: authority.status,
                title: authority.title,
                forceUpsert: true,
            });
            if (!publishedFrame) throw new Error('Transcript projection service is unavailable');
        } catch (pubErr) {
            const responseIngress = verifyArtifactCommandIngress(args, 'register');
            if (!responseIngress.ok) return responseIngress.result;
            const pubMessage = pubErr instanceof Error ? pubErr.message : String(pubErr);
            return {
                success: false,
                code: 'artifact_publication_failed',
                error: `Artifact registered (${finalRecord.artifactId}) but transcript bubble publication failed: ${pubMessage} (artifact_publication_failed)`,
                artifact: finalRecord,
                attachment: finalAttachment,
                artifactId: finalRecord.artifactId,
                sessionId: finalRecord.sessionId,
                taskId: finalRecord.taskId,
                isUpdate: registered.isUpdate,
                registered: true,
                published: false,
            };
        }

        const responseIngress = verifyArtifactCommandIngress(args, 'register');
        if (!responseIngress.ok) return responseIngress.result;
        return {
            success: true,
            artifact: finalRecord,
            attachment: finalAttachment,
            artifactId: finalRecord.artifactId,
            sessionId: finalRecord.sessionId,
            taskId: finalRecord.taskId,
            isUpdate: registered.isUpdate,
            registered: true,
            published: true,
            messageId: `artifact:${finalRecord.artifactId}`,
            messageKey: `m:artifact:${finalRecord.artifactId}`,
        };
    } catch (err) {
        return handleArtifactError(err);
    }
};

const handleArtifactList: MedFamilyHandler = async (ctx, args) => {
    const ingress = verifyArtifactCommandIngress(args, 'list');
    if (!ingress.ok) return ingress.result;
    const auth = await resolveCallerAuthority(ctx, ingress.recordArgs, 'list', ingress.ownerTrusted);
    if (!auth.ok) return auth.result;
    const currentIngress = verifyArtifactCommandIngress(args, 'list');
    if (!currentIngress.ok) return currentIngress.result;
    if (!bindAuthenticatedMcpWorkspace(args, auth.authority.workspaceRoot ?? '')) {
        return { success: false, code: 'artifact_session_mismatch', error: 'Artifact MCP workspace scope changed' };
    }

    const { authority } = auth;
    const rawLimit = args?.limit;
    const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0 ? Math.trunc(rawLimit) : undefined;
    const filterMissionId = trimString(args?.missionId);
    const hasExplicitSession = Boolean(trimString(args?.sessionId) || trimString(args?.targetSessionId));

    try {
        const store = getArtifactStore(ctx);
        let artifacts: ArtifactRecord[];
        if (filterMissionId && (authority.isCoordinator || ingress.ownerTrusted)) {
            artifacts = store.listByMission(filterMissionId, {
                ...(authority.meshId ? { meshId: authority.meshId } : {}),
                limit,
            });
        } else if (!hasExplicitSession && authority.isCoordinator && authority.meshId) {
            artifacts = store.listByMesh(authority.meshId, {
                ...(filterMissionId ? { missionId: filterMissionId } : {}),
                limit,
            });
        } else if (!hasExplicitSession && authority.producerRole === 'worker') {
            artifacts = listWorkerAuthorizedArtifacts(ctx, authority, store, { filterMissionId, limit });
        } else {
            artifacts = store.listBySession(authority.sessionId, { limit });
            if (filterMissionId) artifacts = artifacts.filter((rec) => rec.missionId === filterMissionId);
        }
        const attachments = artifacts.map((record) => toChatAttachmentMeta(record));
        return { success: true, sessionId: authority.sessionId, artifacts, attachments };
    } catch (err) {
        return handleArtifactError(err);
    }
};

async function executeArtifactFetchOrRead(
    ctx: ArtifactCommandContext,
    args: any,
    isReadCommand: boolean,
): Promise<CommandRouterResult> {
    const ingress = verifyArtifactCommandIngress(args, 'fetch');
    if (!ingress.ok) return ingress.result;
    const auth = await resolveCallerAuthority(ctx, ingress.recordArgs, 'fetch', ingress.ownerTrusted);
    if (!auth.ok) return auth.result;
    const currentIngress = verifyArtifactCommandIngress(args, 'fetch');
    if (!currentIngress.ok) return currentIngress.result;
    if (!bindAuthenticatedMcpWorkspace(args, auth.authority.workspaceRoot ?? '')) {
        return { success: false, code: 'artifact_session_mismatch', error: 'Artifact MCP workspace scope changed' };
    }

    const { authority } = auth;
    const artifactId = trimString(args?.artifactId) || trimString(args?.id);
    if (!artifactId) {
        return { success: false, code: 'invalid_arguments', error: 'artifactId is required' };
    }

    try {
        const store = getArtifactStore(ctx);
        const localRecord = store.get(artifactId);
        const record = localRecord ?? authority.remoteRequestedArtifact ?? null;
        if (!record) {
            return {
                success: false,
                code: 'artifact_not_found',
                error: `Artifact not found: ${artifactId} (artifact_not_found)`,
            };
        }

        const accessCheck = await authorizeCrossSessionArtifactAccess(ctx, authority, record);
        if (!accessCheck.ok) return accessCheck.result;
        const { trustedWorkspaceRoot } = accessCheck;

        const selfDaemonId = trimString(ctx.deps?.statusInstanceId);
        const effectiveOriginDaemonId =
            trimString(record.originDaemonId) ||
            (!localRecord && authority.isRemoteWorker ? trimString(authority.hostDaemonId) : '');
        const isRemoteOrigin = Boolean(
            (!localRecord && authority.isRemoteWorker && effectiveOriginDaemonId) ||
                (effectiveOriginDaemonId && selfDaemonId && !daemonIdsEquivalent(effectiveOriginDaemonId, selfDaemonId)),
        );

        if (isRemoteOrigin) {
            return fetchArtifactFromOriginDaemon(
                ctx,
                authority,
                effectiveOriginDaemonId && effectiveOriginDaemonId !== record.originDaemonId
                    ? { ...record, originDaemonId: effectiveOriginDaemonId }
                    : record,
                args,
                isReadCommand,
            );
        }

        if (isReadCommand) {
            const readOffset =
                typeof args?.offset === 'number'
                    ? args.offset
                    : typeof args?.pageOffset === 'number'
                      ? args.pageOffset
                      : undefined;
            const readLimit = typeof args?.limit === 'number' ? args.limit : undefined;
            const readRes = store.readArtifactContent(artifactId, {
                sessionId: record.sessionId,
                ...(trustedWorkspaceRoot ? { trustedWorkspaceRoot } : {}),
                ...(readOffset !== undefined ? { offset: readOffset } : {}),
                ...(readLimit !== undefined ? { limit: readLimit } : {}),
            });
            return {
                success: true,
                ...readRes,
                content: wrapUntrustedArtifactContent(readRes.content),
                artifact: record,
                attachment: toChatAttachmentMeta(record),
            };
        }

        const fetched = store.fetchArtifactContent(artifactId, {
            sessionId: record.sessionId,
            ...(trustedWorkspaceRoot ? { trustedWorkspaceRoot } : {}),
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
}

const handleArtifactFetch: MedFamilyHandler = async (ctx, args) =>
    executeArtifactFetchOrRead(ctx, args, false);

const handleArtifactRead: MedFamilyHandler = async (ctx, args) =>
    executeArtifactFetchOrRead(ctx, args, true);

export const artifactHandlers: Record<string, MedFamilyHandler> = {
    artifact_register: handleArtifactRegister,
    session_artifact_register: handleArtifactRegister,
    artifact_list: handleArtifactList,
    session_artifact_list: handleArtifactList,
    artifact_fetch: handleArtifactFetch,
    artifact_read: handleArtifactRead,
    session_artifact_fetch: handleArtifactFetch,
    artifact_index_forwarded: handleArtifactIndexForwarded,
    artifact_fetch_origin: handleArtifactFetchOrigin,
};

/** Transport rejection precedes the router's topic/log/forwarding side effects. */
export function rejectUntrustedArtifactIngress(command: string, args: unknown): CommandRouterResult | null {
    if (command === 'artifact_index_forwarded' || command === 'artifact_fetch_origin') return null;
    const handler = artifactHandlers[command];
    if (!handler) return null;
    const mode = handler === handleArtifactRegister ? 'register' : handler === handleArtifactList ? 'list' : 'fetch';
    const ingress = verifyArtifactCommandIngress(args, mode);
    return ingress.ok ? null : ingress.result;
}

export const artifactSpecs = defineCommandSpecs(
    'med',
    artifactHandlers,
    {
        artifact_index_forwarded: { sources: ['mesh'], meshSender: 'roster' },
        artifact_fetch_origin: { sources: ['mesh'], meshSender: 'roster' },
    },
    {
        sources: ['ipc', 'standalone', 'p2p'],
        session: { scope: 'optional', aliasSessionId: true },
    },
);
