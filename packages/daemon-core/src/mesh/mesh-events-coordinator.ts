import { existsSync } from 'fs';
import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { loadConfig } from '../config/config.js';
import { getMesh, getMeshByRepo } from '../config/mesh-config.js';
import { detectCLI } from '../detection/cli-detector.js';
import { LOG } from '../logging/logger.js';
import { appendLedgerEntry, buildTaskCompletionEvidence, getSessionRecoveryContext, isIntentionalCleanupStopEntry, readLedgerEntries } from './mesh-ledger.js';
import type { MeshLedgerKind, SessionRecoveryContext } from './mesh-ledger.js';
import { buildMeshNodeCapabilityTags, claimNextTask, updateSessionTaskStatus, enqueueTask, updateTaskStatus, getQueue, recordTaskAutoLaunch, updateDirectDispatchStatus, cleanupTerminalDirectDispatches, getActiveDirectDispatches } from './mesh-work-queue.js';
import { fastForwardMeshNode } from './mesh-fast-forward.js';
import { createSessionDelivery, markSessionDeliveriesTerminal, updateSessionDeliveryStatus, recordCompletionConflict } from './mesh-delivery-policy.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { queuePendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import type { PendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import {
    findRecentTerminalLedgerEvidence,
    hasDispatchAfterTerminal,
    hasUnterminalDirectDispatchLedgerEntry,
    buildLongGeneratingCompletionReconciliation,
} from './mesh-events-stale.js';
import {
    buildMeshSystemMessage,
    readNonEmptyString,
    readRecord,
    resolveEventSessionId,
    readRefineJobId,
    readWorkerResultMetadata,
} from './mesh-events-utils.js';

// ---------------------------------------------------------------------------
// Remote Node Idle Session Tracking
// ---------------------------------------------------------------------------
const REMOTE_IDLE_SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Workspace-to-mesh lookup cache
// ---------------------------------------------------------------------------
const meshByWorkspaceCache = new Map<string, { mesh: any; cachedAt: number }>();
const MESH_WORKSPACE_CACHE_TTL_MS = 5_000;
const IDLE_AUTO_FAST_FORWARD_THROTTLE_MS = 30 * 60 * 1000;
const idleAutoFastForwardLastAttempt = new Map<string, number>();

function getCachedMeshByWorkspace(workspace: string): any {
    const now = Date.now();
    const cached = meshByWorkspaceCache.get(workspace);
    if (cached && now - cached.cachedAt < MESH_WORKSPACE_CACHE_TTL_MS) return cached.mesh;
    const mesh = getMeshByRepo(workspace);
    meshByWorkspaceCache.set(workspace, { mesh, cachedAt: now });
    return mesh;
}

export function __resetIdleAutoFastForwardForTests(): void {
    idleAutoFastForwardLastAttempt.clear();
}

function sweepExpiredRemoteIdleSessions(): void {
    try {
        MeshRuntimeStore.getInstance().pruneExpiredRemoteIdleSessions();
    } catch { /* best-effort */ }
}

function getMeshWithCache(components: DaemonComponents, meshId: string): any | undefined {
    const localMesh = getMesh(meshId);
    if (localMesh) return localMesh;
    return components.router?.getCachedInlineMesh(meshId);
}

const INTENTIONAL_CLEANUP_STOP_SUPPRESSION_MS = 30 * 60 * 1000;

function isIntentionalCleanupStopMetadata(event: Record<string, unknown>): boolean {
    return event.intentional === true
        || event.intentionalStop === true
        || event.operatorCleanup === true
        || event.reason === 'operator_cleanup'
        || event.stopReason === 'operator_cleanup'
        || event.cleanupReason === 'operator_cleanup'
        || event.source === 'mesh_cleanup_sessions'
        || event.source === 'mesh_remove_node';
}

function hasRecentIntentionalCleanupStop(meshId: string, sessionId?: string, nodeId?: string): boolean {
    if (!sessionId && !nodeId) return false;
    const cutoff = Date.now() - INTENTIONAL_CLEANUP_STOP_SUPPRESSION_MS;
    const entries = readLedgerEntries(meshId, { tail: 200 });
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        const timestamp = new Date(entry.timestamp).getTime();
        if (!Number.isNaN(timestamp) && timestamp < cutoff) break;
        if (!isIntentionalCleanupStopEntry(entry)) continue;
        if (sessionId && entry.sessionId === sessionId) return true;
        if (!sessionId && nodeId && entry.nodeId === nodeId) return true;
    }
    return false;
}

function shouldSuppressIntentionalCleanupStop(args: {
    event: string;
    meshId: string;
    metadataEvent: Record<string, unknown>;
    sessionId?: string;
    nodeId?: string;
}): boolean {
    if (args.event !== 'agent:stopped' && args.event !== 'monitor:long_generating') return false;
    if (isIntentionalCleanupStopMetadata(args.metadataEvent)) return true;
    return hasRecentIntentionalCleanupStop(args.meshId, args.sessionId, args.nodeId);
}

const RECENT_COMPLETION_FINGERPRINT_TTL_MS = 10 * 60 * 1000;

function hasFingerprintSeen(fingerprint: string): boolean {
    try {
        return MeshRuntimeStore.getInstance().hasCompletionFingerprint(fingerprint);
    } catch {
        return false;
    }
}

function recordFingerprintSeen(fingerprint: string): void {
    try {
        const db = MeshRuntimeStore.getInstance();
        db.recordCompletionFingerprint(fingerprint, RECENT_COMPLETION_FINGERPRINT_TTL_MS);
        db.sweepExpiredFingerprints();
    } catch { /* best-effort; duplicate events are preferable to a crash */ }
}

function readEventTimestamp(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function buildMeshCompletionFingerprint(args: {
    meshId: string;
    event: string;
    sessionId: string;
    providerType?: string;
    providerSessionId?: string;
    timestamp?: number | null;
    finalSummary?: string;
    coordinatorDaemonId?: string;
}): string {
    const timestampPart = Number.isFinite(args.timestamp)
        ? String(args.timestamp)
        : readNonEmptyString(args.finalSummary).slice(0, 200);
    return [
        args.meshId,
        args.event,
        args.sessionId,
        args.providerType || '',
        args.providerSessionId || '',
        timestampPart,
        args.coordinatorDaemonId || '',
    ].join('::');
}

function isDuplicateMeshCompletionEvent(args: {
    meshId: string;
    event: string;
    sessionId: string;
    providerType?: string;
    providerSessionId?: string;
    timestamp?: number | null;
    finalSummary?: string;
    coordinatorDaemonId?: string;
    taskId?: string;
    nodeId?: string;
}): boolean {
    const fingerprint = buildMeshCompletionFingerprint(args);
    if (!fingerprint) return false;
    if (hasFingerprintSeen(fingerprint)) {
        if (args.taskId) {
            recordCompletionConflict({
                meshId: args.meshId,
                fingerprint,
                conflictingTaskId: args.taskId,
                conflictingSessionId: args.sessionId,
                event: args.event,
            });
        }
        return true;
    }
    recordFingerprintSeen(fingerprint);
    return false;
}

function isDuplicateMeshApprovalEvent(args: {
    meshId: string;
    sessionId: string;
    providerType?: string;
    timestamp?: number | null;
    modalMessage?: string;
    modalButtons?: unknown;
}): boolean {
    const modalButtons = Array.isArray(args.modalButtons)
        ? args.modalButtons.map(button => String(button).trim()).filter(Boolean)
        : [];
    const approvalIdentity = Number.isFinite(args.timestamp)
        ? String(args.timestamp)
        : JSON.stringify({ message: args.modalMessage || '', buttons: modalButtons });
    if (!approvalIdentity || approvalIdentity === '{"message":"","buttons":[]}') return false;
    const fingerprint = [
        args.meshId,
        'agent:waiting_approval',
        args.sessionId,
        args.providerType || '',
        approvalIdentity,
    ].join('::');
    if (hasFingerprintSeen(fingerprint)) return true;
    recordFingerprintSeen(fingerprint);
    return false;
}

function isDuplicateRefineTerminalEvent(meshId: string, eventName: string, metadataEvent: Record<string, unknown>): boolean {
    const jobId = readRefineJobId({ metadataEvent });
    const fingerprint = jobId && new Set(['refine:completed', 'refine:failed']).has(eventName) ? `${meshId}::${eventName}::${jobId}` : '';
    if (!fingerprint) return false;
    if (hasFingerprintSeen(fingerprint)) return true;
    recordFingerprintSeen(fingerprint);
    return false;
}

// ---------------------------------------------------------------------------
// Queue assignment
// ---------------------------------------------------------------------------

export function tryAssignQueueTask(
    components: DaemonComponents,
    meshId: string,
    nodeId: string,
    sessionId: string,
    providerType: string
): boolean {
    const mesh = getMeshWithCache(components, meshId);
    const node = mesh?.nodes.find((n: any) => n.id === nodeId);
    const capabilityTags = buildMeshNodeCapabilityTags(node, providerType);
    const task = claimNextTask(meshId, nodeId, sessionId, capabilityTags);
    if (!task) {
        return false;
    }

    LOG.info('MeshQueue', `Node ${nodeId} (${sessionId}) pulled task ${task.id}`);

    if (node?.daemonId && components.dispatchMeshCommand) {
        const isLocalNode = components.cliManager.adapters.has(sessionId);
        if (!isLocalNode) {
            const delivery = createSessionDelivery({
                meshId,
                nodeId,
                sessionId,
                providerType,
                taskId: task.id,
                kind: 'task',
                message: task.message,
                status: 'delivering',
            });
            components.dispatchMeshCommand(node.daemonId, 'agent_command', {
                targetSessionId: sessionId,
                cliType: providerType,
                action: 'send_chat',
                message: task.message,
            }).then(() => {
                updateSessionDeliveryStatus(delivery.id, 'delivered');
            }).catch((e: any) => {
                LOG.error('MeshQueue', `Failed to dispatch task via P2P to remote node ${nodeId}: ${e?.message}`);
                updateSessionDeliveryStatus(delivery.id, 'failed', { lastError: e?.message, incrementAttempt: true });
                updateTaskStatus(meshId, task.id, 'pending');
                try {
                    appendLedgerEntry(meshId, {
                        kind: 'dispatch_failed' as any,
                        nodeId,
                        sessionId,
                        payload: { taskId: task.id, deliveryId: delivery.id, error: e?.message, retryable: true },
                    });
                } catch { /* ledger write is best-effort */ }
            });
            return true;
        }
    }

    const delivery = createSessionDelivery({
        meshId,
        nodeId,
        sessionId,
        providerType,
        taskId: task.id,
        kind: 'task',
        message: task.message,
        status: 'delivering',
    });
    components.cliManager.handleCliCommand('agent_command', {
        targetSessionId: sessionId,
        cliType: providerType,
        action: 'send_chat',
        message: task.message,
    }).then(() => {
        updateSessionDeliveryStatus(delivery.id, 'delivered');
    }).catch((e: any) => {
        LOG.error('MeshQueue', `Failed to dispatch task locally to node ${nodeId}: ${e?.message}`);
        updateSessionDeliveryStatus(delivery.id, 'failed', { lastError: e?.message, incrementAttempt: true });
        updateTaskStatus(meshId, task.id, 'failed');
    });

    return true;
}

const autoLaunchInProgress = new Set<string>();
const autoLaunchCooldownUntil = new Map<string, number>();
const AUTO_LAUNCH_COOLDOWN_MS = 5_000;

function sweepExpiredCooldowns(): void {
    const now = Date.now();
    for (const [key, until] of autoLaunchCooldownUntil) {
        if (now >= until) autoLaunchCooldownUntil.delete(key);
    }
}

function normalizeProviderPriority(policy: unknown): string[] {
    const raw = policy && typeof policy === 'object' && !Array.isArray(policy)
        ? (policy as Record<string, unknown>).providerPriority
        : undefined;
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    return raw
        .map(type => typeof type === 'string' ? type.trim() : '')
        .filter(Boolean)
        .filter(type => {
            if (seen.has(type)) return false;
            seen.add(type);
            return true;
        });
}

function isTerminalSessionStatus(status: string): boolean {
    return ['stopped', 'failed', 'terminated', 'exited', 'closed'].includes(status);
}

function isIdleSessionState(state: any): boolean {
    const status = readNonEmptyString(state?.status).toLowerCase();
    if (isTerminalSessionStatus(status)) return false;
    return status === 'idle' || state?.activeChat?.status === 'waiting_input';
}

function isDirtyNode(node: any): boolean {
    return node?.health === 'dirty' || node?.git?.dirty === true;
}

function isLaunchableNode(node: any): boolean {
    if (!node || node.status === 'disabled' || node.status === 'removed') return false;
    const health = readNonEmptyString(node.health).toLowerCase();
    if (!health) return true;
    return health === 'online' || health === 'unknown';
}

function localAutoLaunchSkipReason(node: any): string | null {
    const daemonId = readNonEmptyString(node?.daemonId);
    const machineId = readNonEmptyString(node?.machineId);
    const appConfig = loadConfig();
    const localMachineId = readNonEmptyString(appConfig.machineId) || readNonEmptyString(appConfig.registeredMachineId);
    const cloudDaemonId = localMachineId ? `daemon_${localMachineId}` : '';
    const standaloneDaemonId = localMachineId ? `standalone_${localMachineId}` : '';

    const daemonMatchesLocal = !daemonId || daemonId === cloudDaemonId || daemonId === standaloneDaemonId;
    const machineMatchesLocal = !machineId || (localMachineId && machineId === localMachineId);

    if (node?.isLocalWorktree === true) {
        return daemonMatchesLocal && machineMatchesLocal ? null : 'remote_auto_launch_unsupported';
    }

    if (daemonId || machineId) {
        return daemonMatchesLocal && machineMatchesLocal ? null : 'remote_auto_launch_unsupported';
    }

    return null;
}

function activeAssignedCount(meshId: string): number {
    return getQueue(meshId, { status: ['assigned'] as any }).length;
}

function nodeHasActiveAssignment(meshId: string, nodeId: string): boolean {
    return getQueue(meshId, { status: ['assigned'] as any }).some(task => task.assignedNodeId === nodeId);
}

function sessionHasActiveAssignment(meshId: string, sessionId: string): boolean {
    return getQueue(meshId, { status: ['assigned'] as any }).some(task => task.assignedSessionId === sessionId);
}

function liveSessionCountForNode(components: DaemonComponents, meshId: string, nodeId: string): number {
    return components.instanceManager.getByCategory('cli').filter((inst: any) => {
        const state = inst.getState();
        const settings = state.settings as Record<string, unknown> || {};
        if (readNonEmptyString(settings.meshNodeFor) !== meshId) return false;
        const instNodeId = readNonEmptyString(settings.meshNodeId) || readNonEmptyString(settings.nodeId);
        if (instNodeId !== nodeId) return false;
        const status = readNonEmptyString(state.status).toLowerCase();
        return !isTerminalSessionStatus(status);
    }).length;
}

function recordAutoLaunchEvent(meshId: string, args: {
    phase: 'skipped' | 'started' | 'failed' | 'completed';
    taskId: string;
    nodeId?: string;
    providerType?: string;
    sessionId?: string;
    reason?: string;
    error?: string;
}) {
    try {
        appendLedgerEntry(meshId, {
            kind: 'session_auto_launch',
            nodeId: args.nodeId,
            sessionId: args.sessionId,
            providerType: args.providerType,
            payload: {
                phase: args.phase,
                taskId: args.taskId,
                reason: args.reason,
                error: args.error,
            },
        });
    } catch (e: any) {
        LOG.warn('MeshQueue', `Failed to record auto-launch ledger event: ${e?.message || e}`);
    }
}

function markAutoLaunch(meshId: string, taskId: string, args: {
    status: 'skipped' | 'started' | 'failed' | 'completed';
    reason?: string;
    nodeId?: string;
    providerType?: string;
    sessionId?: string;
    error?: string;
}) {
    recordTaskAutoLaunch(meshId, taskId, {
        status: args.status,
        reason: args.reason || args.error,
        nodeId: args.nodeId,
        providerType: args.providerType,
        sessionId: args.sessionId,
    });
    recordAutoLaunchEvent(meshId, {
        phase: args.status,
        taskId,
        nodeId: args.nodeId,
        providerType: args.providerType,
        sessionId: args.sessionId,
        reason: args.reason,
        error: args.error,
    });
}

async function resolveUsableProvider(components: DaemonComponents, nodeId: string, node: any): Promise<{ providerType?: string; reason?: string }> {
    const providerPriority = normalizeProviderPriority(node?.policy);
    if (!providerPriority.length) return { reason: 'missing_provider_priority' };
    const providerLoader = components.providerLoader;
    if (!providerLoader) return { reason: 'provider_loader_unavailable' };

    const failed: string[] = [];
    for (const requestedType of providerPriority) {
        const normalizedType = typeof providerLoader.resolveAlias === 'function'
            ? providerLoader.resolveAlias(requestedType)
            : requestedType;
        if (typeof providerLoader.isMachineProviderEnabled === 'function' && !providerLoader.isMachineProviderEnabled(normalizedType)) {
            failed.push(`${requestedType}: disabled`);
            continue;
        }
        let detected: any;
        try {
            detected = await detectCLI(normalizedType, providerLoader, { includeVersion: false });
        } catch (e: any) {
            failed.push(`${requestedType}: detect failed: ${e?.message || e}`);
            continue;
        }
        if (typeof providerLoader.setCliDetectionResults === 'function') {
            providerLoader.setCliDetectionResults([{
                id: normalizedType,
                installed: !!detected,
                path: detected?.path,
            }], false);
        }
        (components as any).onStatusChange?.();
        if (detected) return { providerType: normalizedType };
        failed.push(`${requestedType}: not detected`);
    }
    return { reason: `provider_priority_unusable: ${failed.join('; ') || nodeId}` };
}

async function maybeAutoLaunchOneQueueSession(components: DaemonComponents, meshId: string, mesh: any): Promise<boolean> {
    const queue = getQueue(meshId);
    const pending = queue.filter(task => task.status === 'pending');
    if (!pending.length) return false;

    const maxParallelTasks = Math.max(1, Math.floor(Number(mesh?.policy?.maxParallelTasks) || 2));
    for (const task of pending) {
        if (activeAssignedCount(meshId) >= maxParallelTasks) {
            markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'max_parallel_tasks_reached' });
            return false;
        }
        if (task.targetSessionId) {
            markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'target_session_constraint' });
            continue;
        }

        const candidateNodes = Array.isArray(mesh?.nodes)
            ? mesh.nodes.filter((node: any) => task.targetNodeId ? node?.id === task.targetNodeId : true)
            : [];
        if (!candidateNodes.length) {
            markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'no_matching_node', nodeId: task.targetNodeId });
            continue;
        }

        for (const node of candidateNodes) {
            const nodeId = readNonEmptyString(node?.id);
            if (!nodeId) continue;
            const launchKey = `${meshId}:${nodeId}`;
            const now = Date.now();
            const cooldownUntil = autoLaunchCooldownUntil.get(launchKey) || 0;
            if (cooldownUntil > 0 && now >= cooldownUntil) autoLaunchCooldownUntil.delete(launchKey);
            if (autoLaunchInProgress.has(launchKey)) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'auto_launch_in_progress', nodeId });
                continue;
            }
            if (now < cooldownUntil) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'auto_launch_cooldown', nodeId });
                continue;
            }
            if (isDirtyNode(node)) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'dirty_workspace', nodeId });
                continue;
            }
            if (!isLaunchableNode(node)) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'node_not_launch_ready', nodeId });
                continue;
            }
            const localSkipReason = localAutoLaunchSkipReason(node);
            if (localSkipReason) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: localSkipReason, nodeId });
                continue;
            }
            if (nodeHasActiveAssignment(meshId, nodeId)) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'node_has_active_assignment', nodeId });
                continue;
            }
            const maxConcurrentSessions = Number(node?.policy?.maxConcurrentSessions);
            if (Number.isFinite(maxConcurrentSessions) && maxConcurrentSessions >= 0 && liveSessionCountForNode(components, meshId, nodeId) >= maxConcurrentSessions) {
                markAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'max_concurrent_sessions_reached', nodeId });
                continue;
            }

            autoLaunchInProgress.add(launchKey);
            try {
                const resolved = await resolveUsableProvider(components, nodeId, node);
                if (!resolved.providerType) {
                    markAutoLaunch(meshId, task.id, { status: 'skipped', reason: resolved.reason || 'provider_unusable', nodeId });
                    continue;
                }

                markAutoLaunch(meshId, task.id, { status: 'started', nodeId, providerType: resolved.providerType });
                const launchResult: any = await components.cliManager.handleCliCommand('launch_cli', {
                    cliType: resolved.providerType,
                    dir: node.workspace,
                    settings: {
                        // Worker launch envelope: role + mesh context so worker can route completion events.
                        role: 'worker',
                        meshNodeFor: meshId,
                        meshNodeId: nodeId,
                        spawnedSessionVisibility: mesh?.policy?.spawnedSessionVisibility || 'hidden',
                        launchedByCoordinator: true,
                        autoLaunchedForQueueTaskId: task.id,
                    },
                });
                if (!launchResult?.success) {
                    const reason = launchResult?.error || 'launch_cli_failed';
                    markAutoLaunch(meshId, task.id, { status: 'failed', reason, nodeId, providerType: resolved.providerType });
                    autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS); sweepExpiredCooldowns();
                    return false;
                }
                const sessionId = readNonEmptyString(launchResult.sessionId) || readNonEmptyString(launchResult.id) || readNonEmptyString(launchResult.runtimeSessionId);
                if (!sessionId) {
                    markAutoLaunch(meshId, task.id, { status: 'failed', reason: 'launch_missing_session_id', nodeId, providerType: resolved.providerType });
                    autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS); sweepExpiredCooldowns();
                    return false;
                }
                markAutoLaunch(meshId, task.id, { status: 'completed', nodeId, providerType: resolved.providerType, sessionId });
                tryAssignQueueTask(components, meshId, nodeId, sessionId, resolved.providerType);
                return true;
            } catch (e: any) {
                markAutoLaunch(meshId, task.id, { status: 'failed', error: e?.message || String(e), nodeId });
                autoLaunchCooldownUntil.set(launchKey, Date.now() + AUTO_LAUNCH_COOLDOWN_MS);
                return false;
            } finally {
                autoLaunchInProgress.delete(launchKey);
            }
        }
    }
    return false;
}

export interface MeshQueueTriggerResult {
    success: true;
    meshId: string;
    pendingBefore: number;
    assignedBefore: number;
    pendingAfter: number;
    assignedAfter: number;
    claimed: boolean;
    newlyAssignedTasks: Array<{
        id: string;
        nodeId?: string;
        sessionId?: string;
    }>;
    localIdleSessionsChecked: number;
    remoteIdleSessionsChecked: number;
    skippedSessions: Array<{
        nodeId?: string;
        sessionId?: string;
        reason: string;
        status?: string;
    }>;
    autoLaunchStarted: boolean;
    noIdleMeshSessionAvailable?: boolean;
}

function countQueueStatus(meshId: string, status: 'pending' | 'assigned'): number {
    return getQueue(meshId, { status: [status] as any }).length;
}

function getQueueStatusById(meshId: string): Map<string, string> {
    return new Map(getQueue(meshId).map(task => [task.id, task.status]));
}

export async function triggerMeshQueue(components: DaemonComponents, meshId: string): Promise<MeshQueueTriggerResult> {
    const mesh = getMeshWithCache(components, meshId);
    const pendingBefore = countQueueStatus(meshId, 'pending');
    const assignedBefore = countQueueStatus(meshId, 'assigned');
    const beforeStatus = getQueueStatusById(meshId);
    const skippedSessions: MeshQueueTriggerResult['skippedSessions'] = [];
    let localIdleSessionsChecked = 0;
    let remoteIdleSessionsChecked = 0;
    let autoLaunchStarted = false;
    if (!mesh) {
        return {
            success: true,
            meshId,
            pendingBefore,
            assignedBefore,
            pendingAfter: pendingBefore,
            assignedAfter: assignedBefore,
            claimed: false,
            newlyAssignedTasks: [],
            localIdleSessionsChecked,
            remoteIdleSessionsChecked,
            skippedSessions: [{ reason: 'mesh_not_found' }],
            autoLaunchStarted,
            noIdleMeshSessionAvailable: true,
        };
    }

    const cliInstances = components.instanceManager.getByCategory('cli');
    for (const inst of cliInstances) {
        const state = inst.getState();
        const settings = state.settings as Record<string, unknown> || {};

        const instMeshId = readNonEmptyString(settings.meshNodeFor);
        if (instMeshId !== meshId) continue;

        const nodeId = readNonEmptyString(settings.meshNodeId) || readNonEmptyString(settings.nodeId);
        if (!nodeId) continue;

        if (!isIdleSessionState(state)) {
            const status = readNonEmptyString(state.status).toLowerCase();
            skippedSessions.push({
                nodeId,
                sessionId: readNonEmptyString(state.instanceId),
                reason: isTerminalSessionStatus(status) ? 'terminal_session' : 'session_not_idle',
                status: status || undefined,
            });
            continue;
        }

        const sessionId = state.instanceId;
        const providerType = state.type || readNonEmptyString(settings.providerType);

        if (providerType) {
            localIdleSessionsChecked += 1;
            tryAssignQueueTask(components, meshId, nodeId, sessionId, providerType);
        } else {
            skippedSessions.push({
                nodeId,
                sessionId,
                reason: 'provider_type_missing',
            });
        }
    }

    let remoteSessions: Array<{ nodeId: string; sessionId: string; providerType: string }> = [];
    try {
        remoteSessions = MeshRuntimeStore.getInstance().getRemoteIdleSessions();
    } catch { /* best-effort */ }

    for (const idle of remoteSessions) {
        const node = mesh.nodes.find((n: any) => n.id === idle.nodeId);
        if (node) {
            remoteIdleSessionsChecked += 1;
            const assigned = tryAssignQueueTask(components, meshId, idle.nodeId, idle.sessionId, idle.providerType);
            if (assigned) {
                try {
                    MeshRuntimeStore.getInstance().deleteRemoteIdleSession(idle.nodeId, idle.sessionId);
                } catch { /* best-effort */ }
            }
        }
    }

    autoLaunchStarted = await maybeAutoLaunchOneQueueSession(components, meshId, mesh);
    const afterQueue = getQueue(meshId);
    const pendingAfter = afterQueue.filter(task => task.status === 'pending').length;
    const assignedAfter = afterQueue.filter(task => task.status === 'assigned').length;
    const newlyAssignedTasks = afterQueue
        .filter(task => task.status === 'assigned' && beforeStatus.get(task.id) !== 'assigned')
        .map(task => ({
            id: task.id,
            nodeId: task.assignedNodeId,
            sessionId: task.assignedSessionId,
        }));
    return {
        success: true,
        meshId,
        pendingBefore,
        assignedBefore,
        pendingAfter,
        assignedAfter,
        claimed: newlyAssignedTasks.length > 0,
        newlyAssignedTasks,
        localIdleSessionsChecked,
        remoteIdleSessionsChecked,
        skippedSessions,
        autoLaunchStarted,
        ...(pendingAfter > 0 && newlyAssignedTasks.length === 0 && localIdleSessionsChecked === 0 && remoteIdleSessionsChecked === 0 && !autoLaunchStarted
            ? { noIdleMeshSessionAvailable: true }
            : {}),
    };
}

async function maybeAutoFastForwardIdleNode(components: DaemonComponents, args: {
    meshId: string;
    nodeId: string;
    sessionId?: string;
    providerType?: string;
}): Promise<void> {
    const mesh = getMeshWithCache(components, args.meshId);
    const node = mesh?.nodes?.find((candidate: any) => candidate?.id === args.nodeId || candidate?.nodeId === args.nodeId);
    const workspace = readNonEmptyString(node?.workspace);
    if (!workspace) return;
    if (!existsSync(workspace)) return;

    const throttleKey = `${args.meshId}:${args.nodeId}`;
    const now = Date.now();
    const lastAttempt = idleAutoFastForwardLastAttempt.get(throttleKey) || 0;
    if (now - lastAttempt < IDLE_AUTO_FAST_FORWARD_THROTTLE_MS) return;
    idleAutoFastForwardLastAttempt.set(throttleKey, now);

    const submoduleIgnorePaths = Array.isArray(node?.policy?.submoduleIgnorePaths)
        ? node.policy.submoduleIgnorePaths.filter((value: unknown): value is string => typeof value === 'string')
        : undefined;
    try {
        const dryRun = await fastForwardMeshNode({
            meshId: args.meshId,
            nodeId: args.nodeId,
            workspace,
            execute: false,
            dryRun: true,
            updateSubmodules: false,
            submoduleIgnorePaths,
            trigger: 'idle_auto',
        });
        if (!dryRun || dryRun.code !== 'fast_forward_available' || dryRun.allowed !== true) return;
        await fastForwardMeshNode({
            meshId: args.meshId,
            nodeId: args.nodeId,
            workspace,
            execute: true,
            dryRun: false,
            updateSubmodules: false,
            submoduleIgnorePaths,
            trigger: 'idle_auto',
        });
    } catch (e: any) {
        LOG.warn('MeshFastForward', `Idle auto fast-forward check failed for ${args.nodeId}: ${e?.message || e}`);
    }
}

function runIdleMaintenanceThenAssignQueue(components: DaemonComponents, args: {
    meshId: string;
    nodeId: string;
    sessionId: string;
    providerType: string;
}): void {
    setImmediate(() => {
        maybeAutoFastForwardIdleNode(components, args)
            .finally(() => {
                try {
                    tryAssignQueueTask(components, args.meshId, args.nodeId, args.sessionId, args.providerType);
                } catch (e: any) {
                    LOG.warn('MeshQueue', `Failed to assign idle queue task after maintenance for ${args.nodeId}: ${e?.message || e}`);
                }
            });
    });
}

// ---------------------------------------------------------------------------
// Core event injection
// ---------------------------------------------------------------------------

const MESH_COORDINATOR_EVENTS = new Set([
    'agent:generating_started',
    'agent:generating_completed',
    'agent:waiting_approval',
    'agent:stopped',
    'agent:ready',
    'monitor:long_generating',
    'refine:accepted',
    'refine:completed',
    'refine:failed',
]);

const EVENT_TO_LEDGER_KIND: Record<string, MeshLedgerKind> = {
    'agent:generating_completed': 'task_completed',
    'agent:waiting_approval': 'task_approval_needed',
    'agent:stopped': 'task_failed',
    'monitor:long_generating': 'task_stalled',
};

export function isMeshCoordinatorEvent(eventName: unknown): eventName is string {
    return typeof eventName === 'string' && MESH_COORDINATOR_EVENTS.has(eventName);
}

function injectMeshSystemMessage(components: DaemonComponents, args: {
    meshId: string;
    sourceInstanceId?: string;
    nodeId?: string;
    nodeLabel: string;
    event: string;
    metadataEvent: Record<string, unknown>;
}) {
    const eventSessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
    const eventNodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);

    const sourceSession = args.sourceInstanceId
        ? components.instanceManager.getInstance(args.sourceInstanceId)
        : undefined;
    const workerCoordinatorDaemonId = readNonEmptyString(
        (sourceSession?.getState()?.settings as Record<string, unknown>)?.meshCoordinatorDaemonId,
    );
    const localDaemonId = readNonEmptyString(loadConfig().machineId);
    const intentionalCleanupStop = shouldSuppressIntentionalCleanupStop({
        event: args.event,
        meshId: args.meshId,
        metadataEvent: args.metadataEvent,
        sessionId: eventSessionId || undefined,
        nodeId: eventNodeId || undefined,
    });
    if (intentionalCleanupStop) {
        if (eventSessionId && eventNodeId) {
            try {
                MeshRuntimeStore.getInstance().deleteRemoteIdleSession(eventNodeId, eventSessionId);
            } catch { /* best-effort */ }
        }
        LOG.info('MeshEvents', `Suppressed ${args.event} for intentionally cleanup-stopped session ${eventSessionId || '(unknown session)'}`);
        return { success: true, forwarded: 0, suppressed: true, intentionalCleanupStop: true };
    }

    if (args.event === 'monitor:long_generating') {
        const reconciledCompletion = buildLongGeneratingCompletionReconciliation({
            meshId: args.meshId,
            nodeId: args.nodeId,
            nodeLabel: args.nodeLabel,
            metadataEvent: args.metadataEvent,
            sourceInstanceId: args.sourceInstanceId,
        });
        if (reconciledCompletion?.source === 'long_generating_reconciliation') {
            LOG.info('MeshEvents', `Reconciled long-generating monitor to completion for session ${eventSessionId || '(unknown session)'}`);
            return injectMeshSystemMessage(components, {
                ...args,
                event: 'agent:generating_completed',
                metadataEvent: reconciledCompletion,
            });
        }
        if (reconciledCompletion?.source === 'long_generating_terminal_ledger_suppression') {
            LOG.info('MeshEvents', `Suppressed long-generating monitor because terminal ledger evidence already exists for session ${eventSessionId || '(unknown session)'}`);
            return {
                success: true,
                forwarded: 0,
                suppressed: true,
                terminalLedgerEvidence: true,
                terminalLedgerKind: reconciledCompletion.terminalLedgerKind,
            };
        }
    }

    if (isDuplicateRefineTerminalEvent(args.meshId, args.event, args.metadataEvent)) {
        LOG.info('MeshEvents', `Suppressed duplicate ${args.event} for refine job ${readRefineJobId({ metadataEvent: args.metadataEvent })}`);
        return { success: true, forwarded: 0, suppressed: true, duplicateRefineTerminalEvent: true };
    }

    const eventTimestamp = readEventTimestamp(args.metadataEvent.timestamp);
    if (args.event === 'agent:waiting_approval' && eventSessionId) {
        const duplicateApproval = isDuplicateMeshApprovalEvent({
            meshId: args.meshId,
            sessionId: eventSessionId,
            providerType: readNonEmptyString(args.metadataEvent.providerType) || undefined,
            timestamp: eventTimestamp,
            modalMessage: readNonEmptyString(args.metadataEvent.modalMessage) || undefined,
            modalButtons: args.metadataEvent.modalButtons,
        });
        if (duplicateApproval) {
            LOG.info('MeshEvents', `Suppressed duplicate approval event for mesh ${args.meshId} session ${eventSessionId}`);
            return { success: true, forwarded: 0, suppressed: true, duplicateApproval: true };
        }
    }
    if (args.event === 'agent:generating_completed' && eventSessionId) {
        const terminal = findRecentTerminalLedgerEvidence({
            meshId: args.meshId,
            sessionId: eventSessionId,
            nodeId: eventNodeId || undefined,
        });
        if (terminal?.kind === 'task_completed' && !sessionHasActiveAssignment(args.meshId, eventSessionId)) {
            const newDispatchAfterTerminal = hasDispatchAfterTerminal(args.meshId, eventSessionId, terminal.id);
            if (!newDispatchAfterTerminal) {
                const terminalProviderSessionId = readNonEmptyString(terminal.payload.providerSessionId);
                const terminalFinalSummary = readNonEmptyString(terminal.payload.finalSummary);
                const eventProviderSessionId = readNonEmptyString(args.metadataEvent.providerSessionId);
                const eventFinalSummary = readNonEmptyString(args.metadataEvent.finalSummary);
                if (
                    (terminalProviderSessionId && terminalProviderSessionId === eventProviderSessionId)
                    || (terminalFinalSummary && terminalFinalSummary === eventFinalSummary)
                    || args.metadataEvent.source === 'long_generating_reconciliation'
                ) {
                    LOG.info('MeshEvents', `Suppressed duplicate completion with existing terminal ledger evidence for mesh ${args.meshId} session ${eventSessionId}`);
                    return { success: true, forwarded: 0, suppressed: true, duplicateCompletion: true, terminalLedgerEvidence: true };
                }
            }
        }
        const duplicateCompletion = isDuplicateMeshCompletionEvent({
            meshId: args.meshId,
            event: args.event,
            sessionId: eventSessionId,
            providerType: readNonEmptyString(args.metadataEvent.providerType) || undefined,
            providerSessionId: readNonEmptyString(args.metadataEvent.providerSessionId) || undefined,
            timestamp: eventTimestamp,
            finalSummary: readNonEmptyString(args.metadataEvent.finalSummary) || undefined,
            coordinatorDaemonId: workerCoordinatorDaemonId || undefined,
            taskId: readNonEmptyString(args.metadataEvent.taskId) || undefined,
            nodeId: eventNodeId || undefined,
        });
        if (duplicateCompletion) {
            LOG.info('MeshEvents', `Suppressed duplicate completion for mesh ${args.meshId} session ${eventSessionId}`);
            return { success: true, forwarded: 0, suppressed: true, duplicateCompletion: true };
        }
    }
    if (args.event === 'agent:stopped' && eventSessionId) {
        const duplicateStopped = isDuplicateMeshCompletionEvent({
            meshId: args.meshId,
            event: args.event,
            sessionId: eventSessionId,
            providerType: readNonEmptyString(args.metadataEvent.providerType) || undefined,
            providerSessionId: readNonEmptyString(args.metadataEvent.providerSessionId) || undefined,
            timestamp: eventTimestamp,
            finalSummary: readNonEmptyString(args.metadataEvent.finalSummary) || undefined,
            coordinatorDaemonId: workerCoordinatorDaemonId || undefined,
            taskId: readNonEmptyString(args.metadataEvent.taskId) || undefined,
            nodeId: eventNodeId || undefined,
        });
        if (duplicateStopped) {
            LOG.info('MeshEvents', `Suppressed duplicate stopped event for mesh ${args.meshId} session ${eventSessionId}`);
            return { success: true, forwarded: 0, suppressed: true, duplicateStopped: true };
        }
    }

    function markSessionTerminal(sessionId: string, outcome: 'completed' | 'failed', occurredAtMs?: number | null): { id?: string } | null {
        const task = updateSessionTaskStatus(args.meshId, sessionId, outcome, {
            occurredAt: occurredAtMs != null ? new Date(occurredAtMs).toISOString() : undefined,
        });
        updateDirectDispatchStatus(args.meshId, sessionId, outcome);
        markSessionDeliveriesTerminal(args.meshId, sessionId, outcome);
        setImmediate(() => cleanupTerminalDirectDispatches());
        return task ? { id: task.id } : null;
    }

    let completedTaskForLedger: { id?: string } | null = null;
    if (args.event === 'agent:generating_completed') {
        const sessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
        const nodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
        const providerType = readNonEmptyString(args.metadataEvent.providerType);

        if (sessionId) {
            completedTaskForLedger = markSessionTerminal(sessionId, 'completed', eventTimestamp);
            if (nodeId && providerType) {
                runIdleMaintenanceThenAssignQueue(components, { meshId: args.meshId, nodeId, sessionId, providerType });
            }
        }
    } else if (args.event === 'agent:ready') {
        const sessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
        const nodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
        const providerType = readNonEmptyString(args.metadataEvent.providerType);
        const providerSessionId = readNonEmptyString(args.metadataEvent.providerSessionId) || undefined;
        const finalSummary = readNonEmptyString(args.metadataEvent.finalSummary) || undefined;
        const workerResult = readWorkerResultMetadata(args.metadataEvent);
        const hasCompletionEvidence = !!finalSummary || !!workerResult;
        if (sessionId && hasCompletionEvidence) {
            completedTaskForLedger = markSessionTerminal(sessionId, 'completed');
            if (completedTaskForLedger) {
                try {
                    appendLedgerEntry(args.meshId, {
                        kind: 'task_completed',
                        nodeId: nodeId || undefined,
                        sessionId,
                        providerType: providerType || undefined,
                        payload: {
                            event: args.event,
                            nodeLabel: args.nodeLabel,
                            taskId: completedTaskForLedger.id,
                            completedViaReady: true,
                            providerSessionId,
                            finalSummary,
                            workerResult,
                            evidence: buildTaskCompletionEvidence({
                                event: 'agent:ready',
                                nodeId,
                                sessionId,
                                providerType: providerType || undefined,
                                providerSessionId,
                                finalSummary,
                                workerResult,
                            }),
                        },
                    });
                } catch (e: any) {
                    LOG.warn('MeshLedger', `Failed to record task_completed from ready: ${e?.message || e}`);
                }
            }
        }

        if (sessionId && nodeId && providerType) {
            sweepExpiredRemoteIdleSessions();
            try {
                MeshRuntimeStore.getInstance().setRemoteIdleSession(nodeId, sessionId, providerType, Date.now() + REMOTE_IDLE_SESSION_TTL_MS);
            } catch { /* best-effort */ }
            setImmediate(() => {
                maybeAutoFastForwardIdleNode(components, { meshId: args.meshId, nodeId, sessionId, providerType })
                    .finally(() => {
                        try {
                            const assigned = tryAssignQueueTask(components, args.meshId, nodeId, sessionId, providerType);
                            if (assigned) MeshRuntimeStore.getInstance().deleteRemoteIdleSession(nodeId, sessionId);
                        } catch (e: any) {
                            LOG.warn('MeshQueue', `Failed to assign idle queue task after maintenance for ${nodeId}: ${e?.message || e}`);
                        }
                    });
            });
        }
    } else if (args.event === 'agent:generating_started') {
        const sessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
        const nodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
        if (sessionId && nodeId) {
            try {
                MeshRuntimeStore.getInstance().deleteRemoteIdleSession(nodeId, sessionId);
            } catch { /* best-effort */ }
        }
        if (sessionId) {
            updateDirectDispatchStatus(args.meshId, sessionId, 'acked');
            const activeDeliveries = ((): { id: string }[] => {
                try { return MeshRuntimeStore.getInstance().getActiveSessionDeliveries(args.meshId, sessionId); }
                catch { return []; }
            })();
            for (const d of activeDeliveries) {
                updateSessionDeliveryStatus(d.id, 'acked');
            }
        }
    } else if (args.event === 'agent:stopped') {
        const sessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId);
        const nodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId);
        if (sessionId && nodeId) {
            try {
                MeshRuntimeStore.getInstance().deleteRemoteIdleSession(nodeId, sessionId);
            } catch { /* best-effort */ }
        }
        if (sessionId) {
            completedTaskForLedger = markSessionTerminal(sessionId, 'failed');
        }
    }

    const ledgerKind = EVENT_TO_LEDGER_KIND[args.event];
    if (ledgerKind) {
        try {
            const ledgerNodeId = readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId) || undefined;
            const ledgerSessionId = resolveEventSessionId(args.metadataEvent, args.sourceInstanceId) || undefined;
            const ledgerProviderType = readNonEmptyString(args.metadataEvent.providerType) || undefined;
            const providerSessionId = readNonEmptyString(args.metadataEvent.providerSessionId) || undefined;
            const finalSummary = readNonEmptyString(args.metadataEvent.finalSummary) || undefined;
            const workerResult = readWorkerResultMetadata(args.metadataEvent);
            const completionEvidence = ledgerKind === 'task_completed' && ledgerNodeId && ledgerSessionId
                ? buildTaskCompletionEvidence({
                    event: 'agent:generating_completed',
                    nodeId: ledgerNodeId,
                    sessionId: ledgerSessionId,
                    providerType: ledgerProviderType,
                    providerSessionId,
                    finalSummary,
                    workerResult,
                })
                : undefined;
            appendLedgerEntry(args.meshId, {
                kind: ledgerKind,
                nodeId: ledgerNodeId,
                sessionId: ledgerSessionId,
                providerType: ledgerProviderType,
                payload: {
                    event: args.event,
                    nodeLabel: args.nodeLabel,
                    taskId: completedTaskForLedger?.id || undefined,
                    providerSessionId,
                    finalSummary,
                    workerResult,
                    completionDiagnostic: args.metadataEvent.completionDiagnostic && typeof args.metadataEvent.completionDiagnostic === 'object'
                        ? args.metadataEvent.completionDiagnostic
                        : undefined,
                    evidence: completionEvidence,
                    // B2: evidenceLevel lets coordinator know when completion evidence is insufficient.
                    ...(completionEvidence
                        ? completionEvidence.workerResult.source === 'default'
                            ? { evidenceLevel: 'insufficient', reviewRecommended: true }
                            : { evidenceLevel: 'sufficient' }
                        : {}),
                },
            });
        } catch (e: any) {
            LOG.warn('MeshLedger', `Failed to record ${ledgerKind}: ${e?.message || e}`);
        }
    }

    let recoveryContext: SessionRecoveryContext | null = null;
    if (args.event === 'agent:stopped') {
        try {
            const mesh = getMesh(args.meshId);
            const maxRetries = mesh?.policy?.maxTaskRetries ?? 1;

            recoveryContext = getSessionRecoveryContext(args.meshId, {
                sessionId: resolveEventSessionId(args.metadataEvent, args.sourceInstanceId) || undefined,
                nodeId: readNonEmptyString(args.nodeId) || readNonEmptyString(args.metadataEvent.meshNodeId) || undefined,
                maxRetries,
            });
            recoveryContext.failedProviderType = readNonEmptyString(args.metadataEvent.providerType) || null;

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

                if (recoveryContext.lastTaskMessage && recoveryContext.failedNodeId && recoveryContext.failedProviderType) {
                    const autoNodeId = recoveryContext.failedNodeId;
                    try {
                        const task = enqueueTask(args.meshId, recoveryContext.lastTaskMessage, {
                            targetNodeId: autoNodeId
                        });
                        LOG.info('MeshRecovery', `Auto-requeued failed task: ${task.id} for node ${autoNodeId}`);

                        const node = mesh?.nodes.find((n: any) => n.id === autoNodeId);
                        if (node) {
                            components.cliManager.handleCliCommand('launch_cli', {
                                cliType: recoveryContext.failedProviderType,
                                dir: node.workspace,
                                settings: {
                                    role: 'worker',
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

    const messageText = buildMeshSystemMessage({
        event: args.event,
        nodeLabel: args.nodeLabel,
        metadataEvent: args.metadataEvent,
        recoveryContext,
    });
    if (!messageText) return { success: false, error: 'unsupported mesh event' };

    const coordinatorInstances = components.instanceManager.getByCategory('cli').filter((inst) => {
        const instState = inst.getState();
        if (instState.settings?.meshCoordinatorFor !== args.meshId) return false;
        if (args.sourceInstanceId && instState.instanceId === args.sourceInstanceId) return false;
        if (workerCoordinatorDaemonId && localDaemonId && workerCoordinatorDaemonId !== localDaemonId) return false;
        return true;
    });

    const isRefineTerminalEvent = new Set(['refine:completed', 'refine:failed']).has(args.event);

    if (coordinatorInstances.length === 0) {
        if (queuePendingMeshCoordinatorEvent({
                event: args.event,
                meshId: args.meshId,
                nodeLabel: args.nodeLabel,
                nodeId: args.nodeId || undefined,
                workspace: readNonEmptyString(args.metadataEvent.workspace),
                metadataEvent: {
                    ...args.metadataEvent,
                    ...(recoveryContext ? { recoveryContext } : {}),
                },
                coordinatorMessage: messageText,
                queuedAt: Date.now(),
                ...(workerCoordinatorDaemonId ? { targetCoordinatorDaemonId: workerCoordinatorDaemonId } : {}),
            })) {
            LOG.info('MeshEvents', `Queued ${args.event} for MCP coordinator (mesh ${args.meshId}${workerCoordinatorDaemonId ? `, coordinator daemon ${workerCoordinatorDaemonId}` : ''})`);
        }
        return { success: true, forwarded: 0 };
    }

    const allCoordinatorsGenerating = isRefineTerminalEvent && coordinatorInstances.every((inst) => {
        const s = inst.getState();
        const status = readNonEmptyString(s.status).toLowerCase();
        const activeChatStatus = readNonEmptyString(s.activeChat?.status).toLowerCase();
        return status === 'generating' || status === 'streaming' || status === 'long_generating'
            || activeChatStatus === 'generating' || activeChatStatus === 'streaming';
    });

    if (!isRefineTerminalEvent || allCoordinatorsGenerating) {
        if (queuePendingMeshCoordinatorEvent({
                event: args.event,
                meshId: args.meshId,
                nodeLabel: args.nodeLabel,
                nodeId: args.nodeId || undefined,
                workspace: readNonEmptyString(args.metadataEvent.workspace),
                metadataEvent: {
                    ...args.metadataEvent,
                    ...(recoveryContext ? { recoveryContext } : {}),
                },
                coordinatorMessage: messageText,
                queuedAt: Date.now(),
                ...(workerCoordinatorDaemonId ? { targetCoordinatorDaemonId: workerCoordinatorDaemonId } : {}),
            })) {
            if (allCoordinatorsGenerating) {
                LOG.info('MeshEvents', `Queued ${args.event} for generating CLI coordinator (mesh ${args.meshId}) — will be delivered via get_pending_mesh_events when coordinator returns to idle`);
            } else {
                LOG.info('MeshEvents', `Queued ${args.event} for MCP coordinator (mesh ${args.meshId})`);
            }
        }
    }

    if (allCoordinatorsGenerating) {
        return { success: true, forwarded: 0, bufferedForGeneratingCoordinator: true };
    }

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
    const relayModalMessage = readNonEmptyString(payload.modalMessage);
    const relayModalButtons = Array.isArray(payload.modalButtons)
        ? (payload.modalButtons as unknown[]).filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
        : null;

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
            jobId: readNonEmptyString(payload.jobId),
            interactionId: readNonEmptyString(payload.interactionId),
            status: readNonEmptyString(payload.status),
            targetDaemonId: readNonEmptyString(payload.targetDaemonId),
            startedAt: readNonEmptyString(payload.startedAt),
            completedAt: readNonEmptyString(payload.completedAt),
            retryOfJobId: readNonEmptyString(payload.retryOfJobId),
            ...(relayModalMessage ? { modalMessage: relayModalMessage } : {}),
            ...(relayModalButtons && relayModalButtons.length > 0 ? { modalButtons: relayModalButtons } : {}),
            ...(payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result) ? { result: payload.result } : {}),
            ...(payload.completionDiagnostic && typeof payload.completionDiagnostic === 'object' && !Array.isArray(payload.completionDiagnostic) ? { completionDiagnostic: payload.completionDiagnostic } : {}),
            ...(payload.workerResult && typeof payload.workerResult === 'object' && !Array.isArray(payload.workerResult) ? { workerResult: payload.workerResult } : {}),
            ...(payload.meshWorkerResult && typeof payload.meshWorkerResult === 'object' && !Array.isArray(payload.meshWorkerResult) ? { meshWorkerResult: payload.meshWorkerResult } : {}),
            ...(payload.structuredResult && typeof payload.structuredResult === 'object' && !Array.isArray(payload.structuredResult) ? { structuredResult: payload.structuredResult } : {}),
            ...(payload.timestamp !== undefined ? { timestamp: payload.timestamp } : {}),
            intentional: payload.intentional === true,
            intentionalStop: payload.intentionalStop === true,
            operatorCleanup: payload.operatorCleanup === true,
            reason: readNonEmptyString(payload.reason),
            stopReason: readNonEmptyString(payload.stopReason),
            cleanupReason: readNonEmptyString(payload.cleanupReason),
            source: readNonEmptyString(payload.source),
        },
    });
}

export function setupMeshEventForwarding(components: DaemonComponents) {
    components.instanceManager.onEvent((event) => {
        if (!isMeshCoordinatorEvent(event.event)) return;

        const instanceId = readNonEmptyString(event.instanceId);
        if (!instanceId) return;

        const sourceInstance = components.instanceManager.getInstance(instanceId);
        if (!sourceInstance || sourceInstance.category !== 'cli') return;
        const state = sourceInstance.getState();
        const workspace = readNonEmptyString(state.workspace);
        if (!workspace) return;
        const settings = state.settings && typeof state.settings === 'object' ? state.settings as Record<string, unknown> : {};

        const coordinatorMeshId = readNonEmptyString(settings.meshCoordinatorFor);
        let meshIdFromDirectDispatch = '';
        if (coordinatorMeshId) {
            try {
                const hasActiveDispatch =
                    getActiveDirectDispatches(coordinatorMeshId).some(d => d.sessionId === instanceId)
                    || hasUnterminalDirectDispatchLedgerEntry(coordinatorMeshId, instanceId);
                if (hasActiveDispatch) meshIdFromDirectDispatch = coordinatorMeshId;
            } catch { /* best-effort */ }
            if (!meshIdFromDirectDispatch) return;
        }

        const meshIdFromRuntime = readNonEmptyString(settings.meshNodeFor) || meshIdFromDirectDispatch;

        const isMeshDelegate = Boolean(meshIdFromRuntime || settings.launchedByCoordinator);
        if (!isMeshDelegate) return;

        const mesh = meshIdFromRuntime ? getMeshWithCache(components, meshIdFromRuntime) : getCachedMeshByWorkspace(workspace);
        const meshId = meshIdFromRuntime || readNonEmptyString(mesh?.id);
        if (!meshId) return;

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
