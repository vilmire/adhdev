import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { getMesh, getMeshByRepo } from '../config/mesh-config.js';
import { LOG } from '../logging/logger.js';
import { appendLedgerEntry, getSessionRecoveryContext } from './mesh-ledger.js';
import type { MeshLedgerKind, SessionRecoveryContext } from './mesh-ledger.js';
import { claimNextTask, updateSessionTaskStatus, enqueueTask } from './mesh-work-queue.js';

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

const MESH_COORDINATOR_EVENTS = new Set([
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

export function tryAssignQueueTask(
    components: { cliManager: any },
    meshId: string,
    nodeId: string,
    sessionId: string,
    providerType: string
): boolean {
    const task = claimNextTask(meshId, nodeId, sessionId);
    if (!task) return false;

    LOG.info('MeshQueue', `Node ${nodeId} (${sessionId}) pulled task ${task.id}`);
    
    components.cliManager.handleCliCommand('agent_command', {
        targetSessionId: sessionId,
        cliType: providerType,
        action: 'send_chat',
        message: task.message,
    }).catch((e: any) => {
        LOG.error('MeshQueue', `Failed to dispatch task to node ${nodeId}: ${e?.message}`);
    });

    return true;
}

/**
 * Triggers a queue check for all nodes in the mesh.
 * Called when a new task is enqueued, in case nodes are already idle.
 */
export function triggerMeshQueue(components: { instanceManager: any; cliManager: any }, meshId: string) {
    const mesh = getMesh(meshId);
    if (!mesh) return;

    // Find all CLI instances that belong to this mesh and are idle
    const cliInstances = components.instanceManager.getByCategory('cli');
    for (const inst of cliInstances) {
        const state = inst.getState();
        const settings = state.settings as Record<string, unknown> || {};
        
        const instMeshId = readNonEmptyString(settings.meshNodeFor);
        if (instMeshId !== meshId && !settings.launchedByCoordinator) continue;

        const nodeId = readNonEmptyString(settings.meshNodeId) || readNonEmptyString(settings.nodeId);
        if (!nodeId) continue;

        // Is it idle? (online and waiting for input)
        if (state.status !== 'idle' && state.status !== 'stopped' && state.activeChat?.status !== 'waiting_input') continue;

        const sessionId = state.instanceId;
        const providerType = state.type || readNonEmptyString(settings.providerType);
        
        if (providerType) {
            // Try to assign a task to this idle node
            tryAssignQueueTask(components, meshId, nodeId, sessionId, providerType);
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
    nodeLabel: string;
    event: string;
    metadataEvent: Record<string, unknown>;
}) {
    // ── Task Queue & Ledger ──
    if (args.event === 'agent:generating_completed') {
        const sessionId = readNonEmptyString(args.metadataEvent.targetSessionId);
        const nodeId = readNonEmptyString(args.metadataEvent.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
        const providerType = readNonEmptyString(args.metadataEvent.providerType);
        
        if (sessionId) {
            updateSessionTaskStatus(args.meshId, sessionId, 'completed');
            if (nodeId && providerType) {
                // Short delay to allow completion event to propagate before pulling next
                setTimeout(() => {
                    tryAssignQueueTask(components, args.meshId, nodeId, sessionId, providerType);
                }, 500);
            }
        }
    } else if (args.event === 'agent:ready') {
        const sessionId = readNonEmptyString(args.metadataEvent.targetSessionId);
        const nodeId = readNonEmptyString(args.metadataEvent.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
        const providerType = readNonEmptyString(args.metadataEvent.providerType);
        
        if (sessionId && nodeId && providerType) {
            setTimeout(() => {
                tryAssignQueueTask(components, args.meshId, nodeId, sessionId, providerType);
            }, 500);
        }
    } else if (args.event === 'agent:stopped') {
        const sessionId = readNonEmptyString(args.metadataEvent.targetSessionId);
        if (sessionId) {
            updateSessionTaskStatus(args.meshId, sessionId, 'failed');
        }
    }

    const ledgerKind = EVENT_TO_LEDGER_KIND[args.event];
    if (ledgerKind) {
        try {
            appendLedgerEntry(args.meshId, {
                kind: ledgerKind,
                nodeId: readNonEmptyString(args.metadataEvent.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId) || undefined,
                sessionId: readNonEmptyString(args.metadataEvent.targetSessionId) || undefined,
                providerType: readNonEmptyString(args.metadataEvent.providerType) || undefined,
                payload: {
                    event: args.event,
                    nodeLabel: args.nodeLabel,
                    providerSessionId: readNonEmptyString(args.metadataEvent.providerSessionId) || undefined,
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
                sessionId: readNonEmptyString(args.metadataEvent.targetSessionId) || undefined,
                nodeId: readNonEmptyString(args.metadataEvent.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId) || undefined,
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
        nodeLabel,
        event: eventName,
        metadataEvent: {
            targetSessionId: readNonEmptyString(payload.targetSessionId) || readNonEmptyString(payload.sessionId),
            providerType: readNonEmptyString(payload.providerType),
            providerSessionId: readNonEmptyString(payload.providerSessionId),
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

        const mesh = meshIdFromRuntime ? getMesh(meshIdFromRuntime) : getMeshByRepo(workspace);
        const meshId = meshIdFromRuntime || readNonEmptyString(mesh?.id);
        if (!meshId) return;

        // Determine node label. Inline/cloud meshes may be unavailable here, so preserve runtime node id.
        const targetNode = mesh?.nodes?.find((n: any) => n.workspace === workspace);
        const runtimeNodeId = readNonEmptyString(settings.meshNodeId);
        const nodeLabel = targetNode
            ? `Node '${targetNode.id}'`
            : runtimeNodeId
                ? `Node '${runtimeNodeId}'`
                : `Agent at ${workspace}`;

        injectMeshSystemMessage(components, {
            meshId,
            sourceInstanceId: instanceId,
            nodeLabel,
            event: event.event,
            metadataEvent: event,
        });
    });
}
