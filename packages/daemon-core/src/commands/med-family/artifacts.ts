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
import { hasWorkerCredentialInput, verifyArtifactCommandIngress } from './artifact-command-ingress.js';
import { bindAuthenticatedMcpWorkspace } from '../mcp-command-ingress.js';
import { defineCommandSpecs } from '../command-registry.js';
import { unwrapMeshRelayResult } from '../mesh-relay-result.js';
import type { CommandRouterDeps, CommandRouterResult } from '../router.js';
import type { MedFamilyContext, MedFamilyHandler } from './types.js';
import {
    ArtifactStore,
    toChatAttachmentMeta,
    wrapUntrustedArtifactContent,
    type ArtifactKind,
    type ArtifactProducerRole,
    type ArtifactRecord,
} from '../../artifacts/index.js';
import { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import {
    findWorkerTaskTokenForSession,
    verifyWorkerSessionBind,
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
    resolveRegisteredSessionWorkspace,
    resolveRemoteWorkerForArtifact,
} from './artifact-sharing.js';

export { handleArtifactFetchOrigin, handleArtifactIndexForwarded };

export type ArtifactCommandContext = Pick<
    MedFamilyContext,
    'deps' | 'getMeshForCommand' | 'getCachedInlineMesh'
>;

export interface ArtifactCommandRuntime {
    readonly artifactStore?: ArtifactStore;
    readonly meshRuntimeStore?: MeshRuntimeStore;
}

const ARTIFACT_RUNTIME_BY_DEPS_KEY = Symbol.for('adhdev.daemon-core.artifactCommandRuntimeByDeps');
function getRuntimeByDepsMap(): WeakMap<CommandRouterDeps, ArtifactCommandRuntime> {
    const g = globalThis as Record<symbol, WeakMap<CommandRouterDeps, ArtifactCommandRuntime> | undefined>;
    let map = g[ARTIFACT_RUNTIME_BY_DEPS_KEY];
    if (!map) {
        map = new WeakMap<CommandRouterDeps, ArtifactCommandRuntime>();
        Object.defineProperty(globalThis, ARTIFACT_RUNTIME_BY_DEPS_KEY, {
            value: map,
            writable: false,
            enumerable: false,
            configurable: false,
        });
    }
    return map;
}
const runtimeByDeps = getRuntimeByDepsMap();

/** Optional test/embedding injection hook for custom store instances per router deps. */
export function setArtifactCommandRuntimeForDeps(
    deps: CommandRouterDeps,
    runtime: ArtifactCommandRuntime | null,
): void {
    if (!runtime) {
        runtimeByDeps.delete(deps);
        return;
    }
    runtimeByDeps.set(deps, runtime);
}

export function getMeshRuntimeStore(ctx: ArtifactCommandContext): MeshRuntimeStore {
    const injected = ctx.deps ? runtimeByDeps.get(ctx.deps)?.meshRuntimeStore : undefined;
    return injected ?? MeshRuntimeStore.getInstance();
}

export function getArtifactStore(ctx: ArtifactCommandContext): ArtifactStore {
    if (ctx.deps) {
        const existing = runtimeByDeps.get(ctx.deps)?.artifactStore;
        if (existing) return existing;
    }
    const meshStore = getMeshRuntimeStore(ctx);
    const store = new ArtifactStore(meshStore.db);
    if (ctx.deps) {
        const prev = runtimeByDeps.get(ctx.deps) ?? {};
        runtimeByDeps.set(ctx.deps, { ...prev, artifactStore: store });
    }
    return store;
}

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
    const coordCandidateId = rawCallerSessionId || explicitSessionId;
    const coordEntry = coordCandidateId ? getCoordinatorForSession(coordCandidateId) : undefined;
    const isVerifiedCoordinator = Boolean(
        coordEntry &&
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
            const remote = await resolveRemoteWorkerForArtifact(ctx, { bind: rawBind, token: rawToken });
            if (remote) {
                const remoteSessionId = trimString(remote.sessionId);
                if (explicitSessionId && !sessionIdsEquivalent(explicitSessionId, remoteSessionId)) {
                    return {
                        ok: false,
                        result: {
                            success: false,
                            code: 'artifact_session_mismatch',
                            error: `Worker credential belongs to session "${remoteSessionId}", not "${explicitSessionId}" (artifact_session_mismatch)`,
                        },
                    };
                }
                const explicitTaskId = trimString(args?.taskId);
                if (explicitTaskId && remote.taskId && explicitTaskId !== remote.taskId) {
                    return {
                        ok: false,
                        result: {
                            success: false,
                            code: 'task_mismatch',
                            error: `Worker credential belongs to task "${remote.taskId}", not "${explicitTaskId}" (task_mismatch)`,
                        },
                    };
                }
                const resolvedRemote = await resolveRegisteredSessionWorkspace(ctx, remoteSessionId, {
                    meshId: remote.meshId,
                    nodeId: remote.nodeId,
                    taskId: remote.taskId,
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
                return {
                    ok: true,
                    authority: {
                        sessionId: remoteSessionId,
                        taskId: remote.taskId ?? null,
                        meshId: remote.meshId,
                        missionId: null,
                        producerRole: 'worker',
                        originDaemonId: selfDaemonId,
                        workspaceRoot: resolvedRemote.workspaceRoot,
                        providerType: resolvedRemote.providerType,
                        status: resolvedRemote.status,
                        title: resolvedRemote.title,
                        isRemoteWorker: true,
                        hostDaemonId: remote.ownerDaemonId,
                        remoteClaim: {
                            meshId: remote.meshId,
                            sessionId: remoteSessionId,
                            ...(remote.taskId ? { taskId: remote.taskId } : {}),
                            ...(remote.attemptId ? { attemptId: remote.attemptId } : {}),
                            ...(remote.nodeId ? { nodeId: remote.nodeId } : {}),
                            ...(remote.generation !== undefined ? { generation: remote.generation } : {}),
                        },
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
        if (explicitSessionId && !sessionIdsEquivalent(explicitSessionId, workerSessionId)) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'artifact_session_mismatch',
                    error: `Worker credential belongs to session "${workerSessionId}", not "${explicitSessionId}" (artifact_session_mismatch)`,
                },
            };
        }

        const explicitTaskId = trimString(args?.taskId);
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

        let queueAssignedAttemptId = '';
        let queueTaskAttemptId = '';
        try {
            const assigned = meshStore.findAssignedBySession(identity.meshId, workerSessionId) as Record<
                string,
                unknown
            > | null;
            if (assigned) {
                const assignedId = trimString(assigned.id);
                if (assignedId && assignedId !== identity.taskId) {
                    return {
                        ok: false,
                        result: {
                            success: false,
                            code: 'task_mismatch',
                            error: `Worker session "${workerSessionId}" is assigned to task "${assignedId}", not "${identity.taskId}" (task_mismatch)`,
                        },
                    };
                }
                const assignedStatus = trimString(assigned.status);
                if (assignedStatus && assignedStatus !== 'assigned') {
                    return {
                        ok: false,
                        result: {
                            success: false,
                            code: 'stale_attempt',
                            error: `Task "${identity.taskId}" is no longer actively assigned (stale_attempt)`,
                        },
                    };
                }
                queueAssignedAttemptId =
                    trimString(assigned.attemptId) ||
                    trimString((assigned.payload as Record<string, unknown> | undefined)?.attemptId);
                if (queueAssignedAttemptId && identity.attemptId && queueAssignedAttemptId !== identity.attemptId) {
                    return {
                        ok: false,
                        result: {
                            success: false,
                            code: 'stale_attempt',
                            error: `Worker credential attempt "${identity.attemptId}" does not match assigned attempt "${queueAssignedAttemptId}" (stale_attempt)`,
                        },
                    };
                }
            }

            const taskEntry = meshStore.findQueueEntryById(identity.meshId, identity.taskId) as Record<
                string,
                unknown
            > | null;
            if (!taskEntry) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'unauthenticated',
                        error: `Worker task "${identity.taskId}" has no active queue assignment (unauthenticated)`,
                    },
                };
            }

            const taskStatus = trimString(taskEntry.status);
            if (taskStatus !== 'assigned') {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'stale_attempt',
                        error: `Task "${identity.taskId}" is not in assigned state (status="${taskStatus || 'unknown'}") (stale_attempt)`,
                    },
                };
            }
            const taskAssignedSession = trimString(taskEntry.assignedSessionId);
            if (!taskAssignedSession || !sessionIdsEquivalent(taskAssignedSession, workerSessionId)) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'artifact_session_mismatch',
                        error: `Task "${identity.taskId}" is assigned to session "${taskAssignedSession}", not "${workerSessionId}" (artifact_session_mismatch)`,
                    },
                };
            }
            queueTaskAttemptId =
                trimString(taskEntry.attemptId) ||
                trimString((taskEntry.payload as Record<string, unknown> | undefined)?.attemptId);
            if (queueTaskAttemptId && identity.attemptId && queueTaskAttemptId !== identity.attemptId) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'stale_attempt',
                        error: `Worker credential attempt "${identity.attemptId}" is stale for task "${identity.taskId}" (current attempt "${queueTaskAttemptId}") (stale_attempt)`,
                    },
                };
            }
            if (
                queueAssignedAttemptId &&
                queueTaskAttemptId &&
                queueAssignedAttemptId !== queueTaskAttemptId
            ) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'stale_attempt',
                        error: `Queue attempt mismatch between assigned row ("${queueAssignedAttemptId}") and task row ("${queueTaskAttemptId}") (stale_attempt)`,
                    },
                };
            }
            if (!assigned || trimString(assigned.id) !== identity.taskId) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'unauthenticated',
                        error: `Worker session "${workerSessionId}" has no active queue assignment for task "${identity.taskId}" (unauthenticated)`,
                    },
                };
            }
        } catch {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'unauthenticated',
                    error: 'Authoritative queue assignment store is unavailable (unauthenticated)',
                },
            };
        }

        // Fence worker credentials against the authoritative turn attempt ledger (fail-closed).
        try {
            const turns = meshStore.turnStore?.();
            if (!turns) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'unauthenticated',
                        error: 'Authoritative turn attempt ledger is unavailable (unauthenticated)',
                    },
                };
            }

            const latestAttempt = turns.findLatestAttemptForTask?.(identity.meshId, identity.taskId) ?? null;
            if (latestAttempt) {
                if (latestAttempt.terminal) {
                    return {
                        ok: false,
                        result: {
                            success: false,
                            code: 'stale_attempt',
                            error: `Latest attempt "${latestAttempt.attemptId}" for task "${identity.taskId}" is already terminal (stale_attempt)`,
                        },
                    };
                }
                if (
                    !latestAttempt.sessionId ||
                    !sessionIdsEquivalent(latestAttempt.sessionId, workerSessionId)
                ) {
                    return {
                        ok: false,
                        result: {
                            success: false,
                            code: 'artifact_session_mismatch',
                            error: `Latest attempt "${latestAttempt.attemptId}" belongs to session "${latestAttempt.sessionId ?? ''}", not "${workerSessionId}" (artifact_session_mismatch)`,
                        },
                    };
                }
            }

            const credAttempt = identity.attemptId
                ? (turns.getAttempt?.(identity.attemptId) ?? null)
                : latestAttempt;

            if (
                !credAttempt ||
                credAttempt.meshId !== identity.meshId ||
                credAttempt.taskId !== identity.taskId
            ) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'unauthenticated',
                        error: `Worker credential has no active turn attempt in ledger for task "${identity.taskId}" (unauthenticated)`,
                    },
                };
            }

            if (credAttempt.terminal) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'stale_attempt',
                        error: `Worker credential attempt "${credAttempt.attemptId}" is terminal (stale_attempt)`,
                    },
                };
            }

            if (!credAttempt.sessionId || !sessionIdsEquivalent(credAttempt.sessionId, workerSessionId)) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'artifact_session_mismatch',
                        error: `Worker credential attempt "${credAttempt.attemptId}" belongs to session "${credAttempt.sessionId ?? ''}", not "${workerSessionId}" (artifact_session_mismatch)`,
                    },
                };
            }

            if (!latestAttempt || latestAttempt.attemptId !== credAttempt.attemptId) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'stale_attempt',
                        error: `Worker credential attempt "${credAttempt.attemptId}" was superseded by attempt "${latestAttempt?.attemptId ?? 'none'}" (stale_attempt)`,
                    },
                };
            }

            if (queueAssignedAttemptId && queueAssignedAttemptId !== latestAttempt.attemptId) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'stale_attempt',
                        error: `Assigned queue attempt "${queueAssignedAttemptId}" does not match current ledger attempt "${latestAttempt.attemptId}" (stale_attempt)`,
                    },
                };
            }

            if (queueTaskAttemptId && queueTaskAttemptId !== latestAttempt.attemptId) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'stale_attempt',
                        error: `Task queue attempt "${queueTaskAttemptId}" does not match current ledger attempt "${latestAttempt.attemptId}" (stale_attempt)`,
                    },
                };
            }

            if (latestAttempt.attemptNo > 0 && !identity.attemptId) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'stale_attempt',
                        error: `Retry attempt "${latestAttempt.attemptId}" requires an attempt-scoped worker credential (stale_attempt)`,
                    },
                };
            }

            if (typeof rawBind === 'string' && rawBind.trim().length > 0 && latestAttempt.attemptNo > 0) {
                const liveTok = findWorkerTaskTokenForSession(
                    identity.meshId,
                    identity.taskId,
                    workerSessionId,
                );
                if (liveTok && liveTok.attemptId !== latestAttempt.attemptId) {
                    return {
                        ok: false,
                        result: {
                            success: false,
                            code: 'stale_attempt',
                            error: `Worker bind resolves to superseded attempt "${liveTok.attemptId ?? 'unscoped'}" instead of "${latestAttempt.attemptId}" (stale_attempt)`,
                        },
                    };
                }
                if (!liveTok) {
                    const binding = verifyWorkerSessionBind(rawBind);
                    const acceptedAtMs =
                        typeof latestAttempt.acceptedAt === 'number' ? latestAttempt.acceptedAt : NaN;
                    if (binding && Number.isFinite(acceptedAtMs) && binding.mintedAtMs < acceptedAtMs) {
                        return {
                            ok: false,
                            result: {
                                success: false,
                                code: 'stale_attempt',
                                error: `Worker bind was minted before retry attempt "${latestAttempt.attemptId}" without a fresh attempt token (stale_attempt)`,
                            },
                        };
                    }
                }
            }
        } catch {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'unauthenticated',
                    error: 'Failed to verify worker credential against turn attempt ledger (unauthenticated)',
                },
            };
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
            },
        };
    }

    const effectiveSessionId = explicitSessionId || (isVerifiedCoordinator ? rawCallerSessionId : '');
    if (!effectiveSessionId) {
        return {
            ok: false,
            result: {
                success: false,
                code: 'invalid_arguments',
                error: 'sessionId is required',
            },
        };
    }

    const explicitTaskId = trimString(args?.taskId);
    if (explicitTaskId) {
        if (!explicitMeshId && !ownerTrusted) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'task_mismatch',
                    error: `Task "${explicitTaskId}" cannot be verified without an owning mesh scope (task_mismatch)`,
                },
            };
        }
        if (explicitMeshId) {
            try {
                const meshStore = getMeshRuntimeStore(ctx);
                const queueEntry = meshStore.findQueueEntryById(explicitMeshId, explicitTaskId) as Record<
                    string,
                    unknown
                > | null;
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
                            error: `Task "${explicitTaskId}" is not actively assigned to session "${effectiveSessionId}" in mesh "${explicitMeshId}" (task_mismatch)`,
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
                            error: `Task "${explicitTaskId}" ownership could not be verified in mesh "${explicitMeshId}" (task_mismatch)`,
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

    if (!ownerTrusted && (mode === 'list' || mode === 'fetch') && explicitMeshId) {
        let meshStore: any = null;
        try {
            meshStore = getMeshRuntimeStore(ctx);
        } catch {
            meshStore = null;
        }
        const authorizedInMesh = await isSessionAuthorizedForMesh(
            ctx,
            meshStore,
            explicitMeshId,
            effectiveSessionId,
        );
        if (!authorizedInMesh) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'artifact_session_mismatch',
                    error: `Session "${effectiveSessionId}" is not an authorized member of mesh "${explicitMeshId}" (artifact_session_mismatch)`,
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
    if (isVerifiedCoordinator || getCoordinatorForSession(effectiveSessionId)) {
        producerRole = 'coordinator';
    } else {
        try {
            const assistantEntry = getAssistantRegistry().read();
            if (assistantEntry?.sessionId && sessionIdsEquivalent(assistantEntry.sessionId, effectiveSessionId)) {
                producerRole = 'assistant';
            }
        } catch {
            // Default to 'user'.
        }
    }

    return {
        ok: true,
        authority: {
            sessionId: effectiveSessionId,
            taskId: explicitTaskId || null,
            meshId: explicitMeshId || coordEntry?.meshId || null,
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
    const rawPath =
        trimString(args?.path) ||
        trimString(args?.relPath) ||
        trimString(args?.rawPath) ||
        trimString(args?.filePath);
    if (!rawPath) {
        return {
            success: false,
            code: 'invalid_arguments',
            error: 'Artifact file path is required',
        };
    }

    const declaredKind = (trimString(args?.kind) || trimString(args?.declaredKind) || undefined) as
        | ArtifactKind
        | undefined;
    const declaredMime = trimString(args?.mime) || trimString(args?.declaredMime) || undefined;
    const title = typeof args?.title === 'string' ? args.title : undefined;

    try {
        const store = getArtifactStore(ctx);
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

        let finalRecord = registered.record;
        let finalAttachment = registered.attachment;
        if (
            authority.isRemoteWorker &&
            authority.hostDaemonId &&
            authority.remoteClaim &&
            ctx.deps?.dispatchMeshCommand
        ) {
            const rawForward = await ctx.deps.dispatchMeshCommand(
                authority.hostDaemonId,
                'artifact_index_forwarded',
                {
                    ...authority.remoteClaim,
                    artifact: registered.record,
                },
            );
            const forwardAns = unwrapMeshRelayResult(rawForward, {
                command: 'artifact_index_forwarded',
                peerDaemonId: authority.hostDaemonId,
            });
            if (forwardAns.success !== true) {
                return {
                    success: false,
                    code:
                        (typeof forwardAns.code === 'string' && forwardAns.code) ||
                        (typeof forwardAns.error === 'string' && forwardAns.error) ||
                        'forward_failed',
                    error:
                        typeof forwardAns.detail === 'string'
                            ? forwardAns.detail
                            : String(forwardAns.error || 'Failed to forward artifact metadata to host daemon'),
                };
            }
            if (forwardAns.artifact && typeof forwardAns.artifact === 'object') {
                const synced = store.upsertForwardedArtifact(forwardAns.artifact as ArtifactRecord);
                finalRecord = synced.record;
                finalAttachment = synced.attachment;
            }
        }

        try {
            const publishedFrame = await publishSessionArtifactBubble(authority.sessionId, {
                attachment: finalAttachment,
                providerType: authority.providerType,
                status: authority.status,
                title: authority.title,
                forceUpsert: true,
            });
            if (!publishedFrame) {
                throw new Error('Transcript projection service is unavailable');
            }
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
    const limit =
        typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.trunc(rawLimit)
            : undefined;
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
        } else {
            artifacts = store.listBySession(authority.sessionId, { limit });
            if (filterMissionId) {
                artifacts = artifacts.filter((rec) => rec.missionId === filterMissionId);
            }
        }
        const attachments = artifacts.map((record) => toChatAttachmentMeta(record));
        return {
            success: true,
            sessionId: authority.sessionId,
            artifacts,
            attachments,
        };
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
                error: `Artifact not found: ${artifactId} (artifact_not_found)`,
            };
        }

        const accessCheck = await authorizeCrossSessionArtifactAccess(ctx, authority, record);
        if (!accessCheck.ok) return accessCheck.result;
        const { trustedWorkspaceRoot } = accessCheck;

        const selfDaemonId = trimString(ctx.deps?.statusInstanceId);
        const isRemoteOrigin = Boolean(
            record.originDaemonId &&
                selfDaemonId &&
                !daemonIdsEquivalent(record.originDaemonId, selfDaemonId),
        );

        if (isRemoteOrigin) {
            return fetchArtifactFromOriginDaemon(ctx, authority, record, args, isReadCommand);
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
