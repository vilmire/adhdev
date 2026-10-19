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
import { sessionIdsEquivalent } from '@adhdev/mesh-shared';
import { defineCommandSpecs } from '../command-registry.js';
import type { CommandRouterDeps, CommandRouterResult } from '../router.js';
import type { MedFamilyContext, MedFamilyHandler } from './types.js';
import {
    ArtifactGuardError,
    ArtifactStore,
    toChatAttachmentMeta,
    type ArtifactKind,
} from '../../artifacts/index.js';
import { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import {
    findWorkerTaskTokenForSession,
    verifyWorkerSessionBind,
} from '../../mesh/worker-mcp-isolation.js';
import { classifyUnresolvedWorkerCredential, resolveWorkerIdentity } from '../../mesh/worker-report.js';
import { getCoordinatorForSession } from '../../mesh/coordinator-registry.js';
import { getAssistantRegistry } from '../../assistant/assistant-registry.js';
import { publishSessionArtifactBubble } from '../../seqscribe/transcript-publisher.js';

export type ArtifactCommandContext = Pick<
    MedFamilyContext,
    'deps' | 'getMeshForCommand' | 'getCachedInlineMesh'
>;

export interface ArtifactCommandRuntime {
    readonly artifactStore?: ArtifactStore;
    readonly meshRuntimeStore?: MeshRuntimeStore;
}

const runtimeByDeps = new WeakMap<CommandRouterDeps, ArtifactCommandRuntime>();

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

function getMeshRuntimeStore(ctx: ArtifactCommandContext): MeshRuntimeStore {
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

interface ResolvedSessionAuthority {
    readonly sessionId: string;
    readonly taskId: string | null;
    readonly workspaceRoot: string | null;
    readonly providerType: string;
    readonly status: string;
    readonly title: string | null;
}

async function resolveRegisteredSessionWorkspace(
    ctx: ArtifactCommandContext,
    sessionId: string,
    opts?: {
        meshId?: string;
        nodeId?: string;
        taskId?: string;
        allowTrustedWorkerFallback?: boolean;
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
                    const resolvedMesh =
                        (await ctx.getMeshForCommand?.(meshId))?.mesh ??
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

    return {
        workspaceRoot: sessionWorkspace ?? nodeWorkspaceRoot,
        nodeWorkspaceRoot,
        providerType,
        status,
        title,
    };
}

async function resolveCallerAuthority(
    ctx: ArtifactCommandContext,
    args: Record<string, unknown>,
    mode: 'register' | 'list' | 'fetch',
): Promise<{ ok: true; authority: ResolvedSessionAuthority } | { ok: false; result: CommandRouterResult }> {
    const rawBind = args?.bind;
    const rawToken = args?.token;
    const hasWorkerCredential =
        (typeof rawBind === 'string' && rawBind.trim().length > 0) ||
        (typeof rawToken === 'string' && rawToken.trim().length > 0) ||
        (rawBind !== undefined && rawBind !== null) ||
        (rawToken !== undefined && rawToken !== null);

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
    if (rawCallerSessionId && explicitSessionId && !sessionIdsEquivalent(rawCallerSessionId, explicitSessionId)) {
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

    if (hasWorkerCredential) {
        const meshStore = getMeshRuntimeStore(ctx);
        const identity = resolveWorkerIdentity(meshStore, rawBind, rawToken);
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

        if (mode === 'register' && !resolved.workspaceRoot) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'invalid_workspace_root',
                    error: `No registered workspace found for worker session "${workerSessionId}" (invalid_workspace_root)`,
                },
            };
        }

        return {
            ok: true,
            authority: {
                sessionId: workerSessionId,
                taskId: identity.taskId,
                workspaceRoot: resolved.workspaceRoot,
                providerType: resolved.providerType,
                status: resolved.status,
                title: resolved.title,
            },
        };
    }

    if (!explicitSessionId) {
        return {
            ok: false,
            result: {
                success: false,
                code: 'invalid_arguments',
                error: 'sessionId is required',
            },
        };
    }

    const explicitMeshId = trimString(args?.meshId);
    const explicitTaskId = trimString(args?.taskId);
    if (explicitMeshId && explicitTaskId) {
        try {
            const meshStore = getMeshRuntimeStore(ctx);
            const queueEntry = meshStore.findQueueEntryById(explicitMeshId, explicitTaskId) as Record<
                string,
                unknown
            > | null;
            const assignedSession = trimString(queueEntry?.assignedSessionId);
            if (assignedSession && !sessionIdsEquivalent(assignedSession, explicitSessionId)) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'task_mismatch',
                        error: `Task "${explicitTaskId}" belongs to session "${assignedSession}", not "${explicitSessionId}" (task_mismatch)`,
                    },
                };
            }
        } catch {
            // Best-effort check against queue entry ownership.
        }
    }

    // Never allow caller-supplied meshId/nodeId/taskId to invent workspace
    // authority for an unregistered session (F4).
    const resolved = await resolveRegisteredSessionWorkspace(ctx, explicitSessionId);

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

    if (mode === 'register' && !resolved.workspaceRoot) {
        return {
            ok: false,
            result: {
                success: false,
                code: 'invalid_workspace_root',
                error: `Session "${explicitSessionId}" has no registered workspace on this daemon (invalid_workspace_root)`,
            },
        };
    }

    return {
        ok: true,
        authority: {
            sessionId: explicitSessionId,
            taskId: explicitTaskId || null,
            workspaceRoot: resolved.workspaceRoot,
            providerType: resolved.providerType,
            status: resolved.status,
            title: resolved.title,
        },
    };
}

function handleArtifactError(err: unknown): CommandRouterResult {
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

const handleArtifactRegister: MedFamilyHandler = async (ctx, args) => {
    const auth = await resolveCallerAuthority(ctx, args ?? {}, 'register');
    if (!auth.ok) return auth.result;

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
            workspaceRoot: authority.workspaceRoot!,
            path: rawPath,
            declaredKind,
            declaredMime,
            title,
        });

        try {
            const publishedFrame = await publishSessionArtifactBubble(authority.sessionId, {
                attachment: registered.attachment,
                providerType: authority.providerType,
                status: authority.status,
                title: authority.title,
                forceUpsert: true,
            });
            if (!publishedFrame) {
                throw new Error('Transcript projection service is unavailable');
            }
        } catch (pubErr) {
            const pubMessage = pubErr instanceof Error ? pubErr.message : String(pubErr);
            return {
                success: false,
                code: 'artifact_publication_failed',
                error: `Artifact registered (${registered.record.artifactId}) but transcript bubble publication failed: ${pubMessage} (artifact_publication_failed)`,
                artifact: registered.record,
                attachment: registered.attachment,
                artifactId: registered.record.artifactId,
                sessionId: registered.record.sessionId,
                taskId: registered.record.taskId,
                isUpdate: registered.isUpdate,
                registered: true,
                published: false,
            };
        }

        return {
            success: true,
            artifact: registered.record,
            attachment: registered.attachment,
            artifactId: registered.record.artifactId,
            sessionId: registered.record.sessionId,
            taskId: registered.record.taskId,
            isUpdate: registered.isUpdate,
            registered: true,
            published: true,
            messageId: `artifact:${registered.record.artifactId}`,
            messageKey: `m:artifact:${registered.record.artifactId}`,
        };
    } catch (err) {
        return handleArtifactError(err);
    }
};

const handleArtifactList: MedFamilyHandler = async (ctx, args) => {
    const auth = await resolveCallerAuthority(ctx, args ?? {}, 'list');
    if (!auth.ok) return auth.result;

    const { authority } = auth;
    const rawLimit = args?.limit;
    const limit =
        typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.trunc(rawLimit)
            : undefined;

    try {
        const store = getArtifactStore(ctx);
        const artifacts = store.listBySession(authority.sessionId, { limit });
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

const handleArtifactFetch: MedFamilyHandler = async (ctx, args) => {
    const auth = await resolveCallerAuthority(ctx, args ?? {}, 'fetch');
    if (!auth.ok) return auth.result;

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
        const fetched = store.fetchArtifactContent(artifactId, {
            sessionId: authority.sessionId,
            ...(authority.workspaceRoot ? { trustedWorkspaceRoot: authority.workspaceRoot } : {}),
        });
        const record = store.get(artifactId);
        return {
            success: true,
            ...fetched,
            ...(record ? { artifact: record, attachment: toChatAttachmentMeta(record) } : {}),
        };
    } catch (err) {
        return handleArtifactError(err);
    }
};

export const artifactHandlers: Record<string, MedFamilyHandler> = {
    artifact_register: handleArtifactRegister,
    session_artifact_register: handleArtifactRegister,
    artifact_list: handleArtifactList,
    session_artifact_list: handleArtifactList,
    artifact_fetch: handleArtifactFetch,
    artifact_read: handleArtifactFetch,
    session_artifact_fetch: handleArtifactFetch,
};

export const artifactSpecs = defineCommandSpecs(
    'med',
    artifactHandlers,
    {},
    {
        sources: ['ipc', 'standalone', 'p2p'],
        session: { scope: 'optional', aliasSessionId: true },
    },
);
