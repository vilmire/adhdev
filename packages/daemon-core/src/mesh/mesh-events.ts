import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { getMesh, getMeshByRepo } from '../config/mesh-config.js';
import { LOG } from '../logging/logger.js';
import { appendLedgerEntry, getSessionRecoveryContext } from './mesh-ledger.js';
import type { MeshLedgerKind, SessionRecoveryContext } from './mesh-ledger.js';
import { claimNextTask, updateSessionTaskStatus, enqueueTask, updateTaskStatus } from './mesh-work-queue.js';

// ---------------------------------------------------------------------------
// Remote Node Idle Session Tracking
// ---------------------------------------------------------------------------
// Tracks remote sessions that emitted 'agent:ready' so triggerMeshQueue 
// can assign tasks to them.
// ---------------------------------------------------------------------------
interface RemoteIdleSession {
    nodeId: string;
    sessionId: string;
    providerType: string;
}
const remoteIdleSessions = new Map<string, RemoteIdleSession>(); // key: `${nodeId}:${sessionId}`

// ---------------------------------------------------------------------------
// MCP coordinator pending-event queue
// ---------------------------------------------------------------------------
// When a mesh event fires but no CLI coordinator session is registered (e.g.
// the coordinator is Claude Code running via MCP), we buffer the event here.
// The MCP server drains this queue on every mesh_status / mesh_send_task poll.
// ---------------------------------------------------------------------------

export interface PendingMeshCoordinatorEvent {
    event: string;
    meshId: string;
    nodeLabel: string;
    metadataEvent: Record<string, unknown>;
    queuedAt: number;
}

const MAX_PENDING_EVENTS = 50;
const pendingMeshCoordinatorEvents: PendingMeshCoordinatorEvent[] = [];

/** Drain and return all pending coordinator events, clearing the queue. */
export function drainPendingMeshCoordinatorEvents(): PendingMeshCoordinatorEvent[] {
    return pendingMeshCoordinatorEvents.splice(0);
}

function readNonEmptyString(value: unknown): string {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function resolveEventSessionId(event: Record<string, unknown>, fallback?: unknown): string {
    return readNonEmptyString(event.targetSessionId)
        || readNonEmptyString(event.sessionId)
        || readNonEmptyString(event.instanceId)
        || readNonEmptyString(fallback);
}

const MESH_COORDINATOR_EVENTS = new Set([
    'agent:generating_started',
    'agent:generating_completed',
    'agent:waiting_approval',
    'agent:stopped',
    'agent:ready',
    'monitor:long_generating',
]);

const EVENT_TO_LEDGER_KIND: Record<string, MeshLedgerKind> = {
    'agent:generating_completed': 'task_completed',
    'agent:waiting_approval': 'task_approval_needed',
    'agent:stopped': 'task_failed',
    'monitor:long_generating': 'task_stalled',
};

function isMeshCoordinatorEvent(eventName: unknown): eventName is string {
    return typeof eventName === 'string' && MESH_COORDINATOR_EVENTS.has(eventName);
}

function formatCompletionMetadata(event: Record<string, unknown>): string {
    const parts = [
        readNonEmptyString(event.targetSessionId) ? `session_id=${readNonEmptyString(event.targetSessionId)}` : '',
        readNonEmptyString(event.providerType) ? `provider=${readNonEmptyString(event.providerType)}` : '',
        readNonEmptyString(event.providerSessionId) ? `provider_session_id=${readNonEmptyString(event.providerSessionId)}` : '',
    ].filter(Boolean);
    return parts.length > 0 ? ` (${parts.join('; ')})` : '';
}

function getMeshWithCache(components: DaemonComponents, meshId: string): any | undefined {
    const localMesh = getMesh(meshId);
    if (localMesh) return localMesh;
    return components.router?.getCachedInlineMesh(meshId);
}


export function tryAssignQueueTask(
    components: DaemonComponents,
    meshId: string,
    nodeId: string,
    sessionId: string,
    providerType: string
): boolean {
    const task = claimNextTask(meshId, nodeId, sessionId);
    if (!task) {
        return false;
    }

    LOG.info('MeshQueue', `Node ${nodeId} (${sessionId}) pulled task ${task.id}`);

    // Check if the node is remote
    const mesh = getMeshWithCache(components, meshId);
    const node = mesh?.nodes.find((n: any) => n.id === nodeId);
    
    // If the node is explicitly remote and we have a dispatch mechanism, route via P2P
    if (node?.daemonId && components.dispatchMeshCommand) {
        const isLocalNode = components.cliManager.adapters.has(sessionId);
        if (!isLocalNode) {
            components.dispatchMeshCommand(node.daemonId, 'agent_command', {
                targetSessionId: sessionId,
                cliType: providerType,
                action: 'send_chat',
                message: task.message,
            }).catch((e: any) => {
                LOG.error('MeshQueue', `Failed to dispatch task via P2P to remote node ${nodeId}: ${e?.message}`);
                updateTaskStatus(meshId, task.id, 'failed');
            });
            return true;
        }
    }

    // Local routing
    components.cliManager.handleCliCommand('agent_command', {
        targetSessionId: sessionId,
        cliType: providerType,
        action: 'send_chat',
        message: task.message,
    }).catch((e: any) => {
        LOG.error('MeshQueue', `Failed to dispatch task locally to node ${nodeId}: ${e?.message}`);
        updateTaskStatus(meshId, task.id, 'failed');
    });

    return true;
}

/**
 * Triggers a queue check for all nodes in the mesh.
 * Called when a new task is enqueued, in case nodes are already idle.
 */
export function triggerMeshQueue(components: DaemonComponents, meshId: string) {
    const mesh = getMeshWithCache(components, meshId);
    if (!mesh) return;

    // Find all CLI instances that belong to this mesh and are idle
    const cliInstances = components.instanceManager.getByCategory('cli');
    for (const inst of cliInstances) {
        const state = inst.getState();
        const settings = state.settings as Record<string, unknown> || {};
        
        const instMeshId = readNonEmptyString(settings.meshNodeFor);
        if (instMeshId !== meshId) continue;

        const nodeId = readNonEmptyString(settings.meshNodeId) || readNonEmptyString(settings.nodeId);
        if (!nodeId) continue;

        // Only genuinely idle live sessions can pull work. Restored/stopped
        // records are kept for transcript/recovery visibility, but assigning
        // queue items to them strands tasks in assigned/pending without chat.
        const status = readNonEmptyString(state.status).toLowerCase();
        if (['stopped', 'failed', 'terminated', 'exited', 'closed'].includes(status)) continue;
        if (status !== 'idle' && state.activeChat?.status !== 'waiting_input') continue;

        const sessionId = state.instanceId;
        const providerType = state.type || readNonEmptyString(settings.providerType);
        
        if (providerType) {
            // Try to assign a task to this idle node
            tryAssignQueueTask(components, meshId, nodeId, sessionId, providerType);
        }
    }

    // Also check known idle remote sessions
    for (const [key, idle] of remoteIdleSessions.entries()) {
        // Find if this node is in the same mesh
        const node = mesh.nodes.find((n: any) => n.id === idle.nodeId);
        if (node) {
            const assigned = tryAssignQueueTask(components, meshId, idle.nodeId, idle.sessionId, idle.providerType);
            if (assigned) {
                remoteIdleSessions.delete(key);
            }
        }
    }
}

function buildMeshSystemMessage(args: {
    event: string;
    nodeLabel: string;
    metadataEvent: Record<string, unknown>;
    recoveryContext?: SessionRecoveryContext | null;
}): string {
    const metadata = formatCompletionMetadata(args.metadataEvent);
    if (args.event === 'agent:generating_completed') {
        return `[System] ${args.nodeLabel} has completed its task and is now idle${metadata}. This completion came from the agent status event path; use mesh_read_chat once to review its final progress, but do not poll repeatedly.`;
    }
    if (args.event === 'agent:waiting_approval') {
        return `[System] ${args.nodeLabel} is waiting for approval to proceed${metadata}. You may use mesh_read_chat and mesh_approve to handle it.`;
    }
    if (args.event === 'agent:stopped') {
        const rc = args.recoveryContext;
        if (rc && rc.consecutiveNodeFailures > 0) {
            const parts = [
                `[System] ${args.nodeLabel} has stopped unexpectedly${metadata}.`,
                `\n\n**Recovery Context:**`,
                `- Consecutive failures on this node: ${rc.consecutiveNodeFailures}`,
                rc.taskAttemptCount > 0 ? `- This task has been attempted ${rc.taskAttemptCount} time(s)` : '',
                `- Recommendation: ${rc.advice}`,
            ];
            if (rc.retryRecommended && rc.lastTaskMessage) {
                parts.push(
                    `\n\n**Original task to retry:**`,
                    `> ${rc.lastTaskMessage.length > 300 ? rc.lastTaskMessage.slice(0, 300) + '...' : rc.lastTaskMessage}`,
                    `\nTo retry: call \`mesh_launch_session\` for this node, then \`mesh_send_task\` with the original task.`,
                );
            } else if (!rc.retryRecommended) {
                parts.push(
                    `\nDo NOT retry on this node. Consider reassigning to a different node or asking the user for guidance.`,
                );
            }
            return parts.filter(Boolean).join('\n');
        }
        return `[System] ${args.nodeLabel} has stopped${metadata}. Use mesh_read_chat once if you need to inspect its last output.`;
    }
    if (args.event === 'monitor:long_generating') {
        return `[System] ${args.nodeLabel} has been generating for a long time${metadata}. Use mesh_read_chat once for a status check, but do not poll repeatedly.`;
    }
    return '';
}

function injectMeshSystemMessage(components: DaemonComponents, args: {
    meshId: string;
    sourceInstanceId?: string;
    nodeId?: string;
    nodeLabel: string;
    event: string;
    metadataEvent: Record<string, unknown>;
}) {
    // ── Task Queue & Ledger ──
    let completedTaskForLedger: { id?: string } | null = null;
    if (args.event === 'agent:generating_completed') {
        const sessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
        const nodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
        const providerType = readNonEmptyString(args.metadataEvent.providerType);
        
        if (sessionId) {
            const completedTask = updateSessionTaskStatus(args.meshId, sessionId, 'completed');
            completedTaskForLedger = completedTask ? { id: completedTask.id } : null;
            if (nodeId && providerType) {
                // Short delay to allow completion event to propagate before pulling next
                setTimeout(() => {
                    tryAssignQueueTask(components, args.meshId, nodeId, sessionId, providerType);
                }, 500);
            }
        }
    } else if (args.event === 'agent:ready') {
        const sessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
        const nodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
        const providerType = readNonEmptyString(args.metadataEvent.providerType);
        const completedTask = sessionId
            ? updateSessionTaskStatus(args.meshId, sessionId, 'completed')
            : null;
        if (completedTask) {
            completedTaskForLedger = { id: completedTask.id };
            try {
                appendLedgerEntry(args.meshId, {
                    kind: 'task_completed',
                    nodeId: nodeId || undefined,
                    sessionId,
                    providerType: providerType || undefined,
                    payload: {
                        event: args.event,
                        nodeLabel: args.nodeLabel,
                        taskId: completedTask.id,
                        completedViaReady: true,
                        taskId: completedTask.id,
                        providerSessionId: readNonEmptyString(args.metadataEvent.providerSessionId) || undefined,
                        finalSummary: readNonEmptyString(args.metadataEvent.finalSummary) || undefined,
                    },
                });
            } catch (e: any) {
                LOG.warn('MeshLedger', `Failed to record task_completed from ready: ${e?.message || e}`);
            }
        }
        
        if (sessionId && nodeId && providerType) {
            remoteIdleSessions.set(`${nodeId}:${sessionId}`, { nodeId, sessionId, providerType });
            setTimeout(() => {
                const assigned = tryAssignQueueTask(components, args.meshId, nodeId, sessionId, providerType);
                if (assigned) {
                    remoteIdleSessions.delete(`${nodeId}:${sessionId}`);
                }
            }, 500);
        }
    } else if (args.event === 'agent:generating_started') {
        const sessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
        const nodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
        if (sessionId && nodeId) {
            remoteIdleSessions.delete(`${nodeId}:${sessionId}`);
        }
    } else if (args.event === 'agent:stopped') {
        const sessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
        const nodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
        if (sessionId && nodeId) {
            remoteIdleSessions.delete(`${nodeId}:${sessionId}`);
        }
        if (sessionId) {
            updateSessionTaskStatus(args.meshId, sessionId, 'failed');
        }
    }

    const ledgerKind = EVENT_TO_LEDGER_KIND[args.event];
    if (ledgerKind) {
        try {
            appendLedgerEntry(args.meshId, {
                kind: ledgerKind,
                nodeId: readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId) || undefined,
                sessionId: resolveEventSessionId(args.metadataEvent, args.sourceInstanceId) || undefined,
                providerType: readNonEmptyString(args.metadataEvent.providerType) || undefined,
                payload: {
                    event: args.event,
                    nodeLabel: args.nodeLabel,
                    taskId: completedTaskForLedger?.id || undefined,
                    providerSessionId: readNonEmptyString(args.metadataEvent.providerSessionId) || undefined,
                    finalSummary: readNonEmptyString(args.metadataEvent.finalSummary) || undefined,
                },
            });
        } catch (e: any) {
            LOG.warn('MeshLedger', `Failed to record ${ledgerKind}: ${e?.message || e}`);
        }
    }

    // ── Recovery Context: enrich agent:stopped with retry intelligence ──
    let recoveryContext: SessionRecoveryContext | null = null;
    if (args.event === 'agent:stopped') {
        try {
            // Resolve maxTaskRetries from mesh policy
            const mesh = getMesh(args.meshId);
            const maxRetries = mesh?.policy?.maxTaskRetries ?? 1;

            recoveryContext = getSessionRecoveryContext(args.meshId, {
                sessionId: resolveEventSessionId(args.metadataEvent, args.sourceInstanceId) || undefined,
                nodeId: readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId) || undefined,
                maxRetries,
            });
            recoveryContext.failedProviderType = readNonEmptyString(args.metadataEvent.providerType) || null;

            // Record recovery_attempted if retry is recommended
            if (recoveryContext.retryRecommended && recoveryContext.consecutiveNodeFailures > 0) {
                appendLedgerEntry(args.meshId, {
                    kind: 'recovery_attempted',
                    nodeId: recoveryContext.failedNodeId || undefined,
                    sessionId: recoveryContext.failedSessionId || undefined,
                    providerType: recoveryContext.failedProviderType || undefined,
                    payload: {
                        consecutiveFailures: recoveryContext.consecutiveNodeFailures,
                        taskAttemptCount: recoveryContext.taskAttemptCount,
                        retryRecommended: recoveryContext.retryRecommended,
                        advice: recoveryContext.advice,
                    },
                });

                // Auto-Recovery (Phase 5): Automatically re-enqueue the task and re-launch the session
                if (recoveryContext.lastTaskMessage && recoveryContext.failedNodeId && recoveryContext.failedProviderType) {
                    const autoNodeId = recoveryContext.failedNodeId;
                    try {
                        const task = enqueueTask(args.meshId, recoveryContext.lastTaskMessage, {
                            targetNodeId: autoNodeId
                        });
                        LOG.info('MeshRecovery', `Auto-requeued failed task: ${task.id} for node ${autoNodeId}`);

                        const node = mesh?.nodes.find(n => n.id === autoNodeId);
                        if (node) {
                            components.cliManager.handleCliCommand('launch_cli', {
                                cliType: recoveryContext.failedProviderType,
                                dir: node.workspace,
                                settings: {
                                    meshNodeFor: args.meshId,
                                    meshNodeId: node.id,
                                    spawnedSessionVisibility: mesh?.policy?.spawnedSessionVisibility || 'hidden',
                                    launchedByCoordinator: true,
                                }
                            }).catch((e: any) => LOG.error('MeshRecovery', `Failed to auto-relaunch session for ${node.id}: ${e?.message}`));
                        }
                    } catch (e: any) {
                        LOG.warn('MeshRecovery', `Failed to execute auto-recovery: ${e?.message}`);
                    }
                }
            }

            LOG.info('MeshRecovery', `Recovery context for ${args.nodeLabel}: ${recoveryContext.advice}`);
        } catch (e: any) {
            LOG.warn('MeshRecovery', `Failed to build recovery context: ${e?.message || e}`);
        }
    }

    const coordinatorInstances = components.instanceManager.getByCategory('cli').filter((inst) => {
        const instState = inst.getState();
        if (instState.settings?.meshCoordinatorFor !== args.meshId) return false;
        if (args.sourceInstanceId && instState.instanceId === args.sourceInstanceId) return false;
        return true;
    });

    if (coordinatorInstances.length === 0) {
        // No CLI coordinator session found — buffer for MCP-based coordinators.
        if (pendingMeshCoordinatorEvents.length < MAX_PENDING_EVENTS) {
            pendingMeshCoordinatorEvents.push({
                event: args.event,
                meshId: args.meshId,
                nodeLabel: args.nodeLabel,
                metadataEvent: {
                    ...args.metadataEvent,
                    ...(recoveryContext ? { recoveryContext } : {}),
                },
                queuedAt: Date.now(),
            });
            LOG.info('MeshEvents', `Queued ${args.event} for MCP coordinator (mesh ${args.meshId})`);
        }
        return { success: true, forwarded: 0 };
    }

    const messageText = buildMeshSystemMessage({
        event: args.event,
        nodeLabel: args.nodeLabel,
        metadataEvent: args.metadataEvent,
        recoveryContext,
    });
    if (!messageText) return { success: false, error: 'unsupported mesh event' };

    for (const coord of coordinatorInstances) {
        const coordState = coord.getState();
        LOG.info('MeshEvents', `Forwarding mesh event to coordinator ${coordState.instanceId}`);
        coord.onEvent('send_message', { input: { text: messageText, textFallback: messageText } });
    }
    return { success: true, forwarded: coordinatorInstances.length };
}

export function handleMeshForwardEvent(components: DaemonComponents, payload: Record<string, unknown>) {
    const eventName = readNonEmptyString(payload.event);
    if (!isMeshCoordinatorEvent(eventName)) {
        return { success: false, error: 'unsupported mesh event' };
    }
    const meshId = readNonEmptyString(payload.meshId);
    if (!meshId) return { success: false, error: 'meshId required' };

    const nodeId = readNonEmptyString(payload.nodeId);
    const workspace = readNonEmptyString(payload.workspace);
    const nodeLabel = nodeId ? `Node '${nodeId}'` : workspace ? `Agent at ${workspace}` : 'Remote agent';
    return injectMeshSystemMessage(components, {
        meshId,
        nodeId,
        nodeLabel,
        event: eventName,
        metadataEvent: {
            targetSessionId: readNonEmptyString(payload.targetSessionId) || readNonEmptyString(payload.sessionId) || readNonEmptyString(payload.instanceId),
            providerType: readNonEmptyString(payload.providerType),
            providerSessionId: readNonEmptyString(payload.providerSessionId),
            finalSummary: readNonEmptyString(payload.finalSummary) || readNonEmptyString(payload.summary),
        },
    });
}

export function setupMeshEventForwarding(components: DaemonComponents) {
    components.instanceManager.onEvent((event) => {
        // We only care about lightweight Repo Mesh coordinator control/status hints.
        if (!isMeshCoordinatorEvent(event.event)) return;

        const instanceId = readNonEmptyString(event.instanceId);
        if (!instanceId) return;

        // Try to find the workspace and mesh metadata of the sub-agent.
        const sourceInstance = components.instanceManager.getInstance(instanceId);
        if (!sourceInstance || sourceInstance.category !== 'cli') return;
        const state = sourceInstance.getState();
        const workspace = readNonEmptyString(state.workspace);
        if (!workspace) return;
        const settings = state.settings && typeof state.settings === 'object' ? state.settings as Record<string, unknown> : {};

        // Coordinator sessions must never inject events into themselves.
        // A coordinator instance carries meshCoordinatorFor but not meshNodeFor/launchedByCoordinator.
        if (readNonEmptyString(settings.meshCoordinatorFor)) return;

        const meshIdFromRuntime = readNonEmptyString(settings.meshNodeFor);

        // Only forward events for sessions that were explicitly launched as mesh-node delegates
        // (meshNodeFor set by mesh_launch_session) or that carry the launchedByCoordinator flag.
        // Do NOT fall back to workspace-based mesh lookup: that would pick up coordinator sessions
        // and any other CLI session that happens to share the same workspace, causing spurious
        // system-message injection into the coordinator's own conversation.
        const isMeshDelegate = Boolean(meshIdFromRuntime || settings.launchedByCoordinator);
        if (!isMeshDelegate) return;

        const mesh = meshIdFromRuntime ? getMeshWithCache(components, meshIdFromRuntime) : getMeshByRepo(workspace);
        const meshId = meshIdFromRuntime || readNonEmptyString(mesh?.id);
        if (!meshId) return;

        // Determine node label. Inline/cloud meshes may be unavailable here, so preserve runtime node id.
        const targetNode = mesh?.nodes?.find((n: any) => n.workspace === workspace);
        const runtimeNodeId = readNonEmptyString(settings.meshNodeId);
        const resolvedNodeId = targetNode?.id || runtimeNodeId;
        const nodeLabel = targetNode
            ? `Node '${targetNode.id}'`
            : runtimeNodeId
                ? `Node '${runtimeNodeId}'`
                : `Agent at ${workspace}`;

        injectMeshSystemMessage(components, {
            meshId,
            sourceInstanceId: instanceId,
            nodeId: resolvedNodeId,
            nodeLabel,
            event: event.event,
            metadataEvent: event,
        });
    });
}
