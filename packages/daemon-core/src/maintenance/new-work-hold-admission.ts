import type { DaemonComponents } from '../boot/daemon-components.js';
import { isTrustedOwnerIngress, readRouterCommandIngress } from '../commands/command-args.js';
import { MeshRuntimeStore } from '../mesh/mesh-runtime-store.js';
import {
    buildNewWorkHeldRefusal,
    evaluateNewWorkHold,
    formatNewWorkHeldMessage,
    NewWorkHeldError,
    type NewWorkHoldRefusal,
} from './new-work-hold.js';

export const NEW_WORK_HOLD_EXEMPT_COMMANDS: ReadonlySet<string> = new Set([
    'maintenance_new_work_hold_set',
    'maintenance_new_work_hold_extend',
    'maintenance_new_work_hold_release',
    'maintenance_new_work_hold_status',
    'maintenance_new_work_hold',
    'new_work_hold_set',
    'new_work_hold_extend',
    'new_work_hold_release',
    'new_work_hold_status',
    'new_work_hold',
    'worker_report_completion',
    'worker_progress_update',
    'worker_bridge_delivery',
    'worker_bridge_capabilities',
    'worker_bridge_status',
    'mesh_forward_event',
    'get_pending_mesh_events',
    'get_mesh_ledger_slice',
    'mesh_status',
    'mesh_status_view',
    'get_status_metadata',
    'read_chat',
    'read_terminal',
    'get_runtime_snapshot',
    'interactive_prompt_response',
    'pty_input',
    'stop_cli',
    'stop_ide',
    'session_host_stop_session',
    'session_host_send_signal',
    'session_host_get_diagnostics',
    'session_host_list_sessions',
]);

export const ROUTER_MAINTENANCE_EXEMPT_COMMANDS: ReadonlySet<string> = new Set([
    'get_status_metadata',
    'cooperative_maintenance_actor_control',
    'cooperative_maintenance_actor_drain',
    'cooperative_maintenance_mcp_poll',
    'cooperative_maintenance_mcp_reply',
    'cooperative_maintenance_actor_observe',
    'cooperative_maintenance_observe',
    'cooperative_maintenance_status',
    'worker_report_completion',
    'worker_progress_update',
    'worker_bridge_delivery',
    'worker_bridge_capabilities',
    'worker_bridge_status',
    ...NEW_WORK_HOLD_EXEMPT_COMMANDS,
]);

export function isRouterCommandMaintenanceExempt(command: string): boolean {
    return ROUTER_MAINTENANCE_EXEMPT_COMMANDS.has(command);
}

/**
 * Router commands gated by the daemon-owned new-work hold (S1).
 *
 * Per-daemon scope: each daemon enforces its own new-work hold at its local S1
 * router boundary, S2 queue claim, H1 auto-launch, H2 session input, and
 * `startSession` choke point. A remote daemon's auto-launch or forwarded
 * `launch_cli` is governed by that remote daemon's own hold state when the
 * command arrives there.
 */
export const NEW_WORK_HOLD_GATED_COMMANDS: ReadonlySet<string> = new Set([
    'launch_cli',
    'launch_mesh_coordinator',
    'launch_ide',
    'restart_session',
    'session_host_resume_session',
    'session_host_restart_session',
    'launch_assistant',
    'assistant_project_send',
    'assistant_remote_project',
    'refine_mesh_node',
    'batch_refine_mesh_nodes',
    'agent_command',
    'send_chat',
]);

function readOptionalString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface RunningWorkContinuationCheck {
    sessionId?: string | null;
    nodeId?: string | null;
    agentType?: string | null;
    workspaceDir?: string | null;
    taskId?: string | null;
    attemptId?: string | null;
    isMeshOrCoordinatorFollowUp?: boolean;
    sessionSettings?: Record<string, unknown> | null;
    instanceManager?: {
        getInstance?(id: string): { getState?(): { settings?: Record<string, unknown> } } | undefined;
    } | null;
    cliManager?: {
        findMeshNodeAdapter?(agentType: string, nodeId: string, dir?: string): { key: string } | null;
    } | null;
}

/**
 * Determines whether a prompt/command targeting a worker session is a
 * continuation of already-running work (same task / attempt continuation)
 * rather than new work (F7).
 *
 * Called ONLY while a hold is active, so the normal unheld path pays zero cost.
 */
export function isRunningWorkContinuation(params: RunningWorkContinuationCheck): boolean {
    let sessionId = readOptionalString(params.sessionId);
    if (!sessionId && params.nodeId && params.cliManager?.findMeshNodeAdapter) {
        const resolved = params.cliManager.findMeshNodeAdapter(
            readOptionalString(params.agentType) || '',
            params.nodeId,
            readOptionalString(params.workspaceDir) || undefined,
        );
        if (resolved?.key) sessionId = resolved.key;
    }
    const incomingTaskId = readOptionalString(params.taskId);
    const incomingAttemptId = readOptionalString(params.attemptId);

    const settings = params.sessionSettings
        ?? (sessionId ? params.instanceManager?.getInstance?.(sessionId)?.getState?.()?.settings : undefined);
    const sessionTaskId = readOptionalString(settings?.meshActiveTaskId);
    const sessionAttemptId = readOptionalString(settings?.meshActiveAttemptId);
    const sessionHasActiveBinding = Boolean(sessionTaskId || sessionAttemptId);

    const activeTaskIds = new Set<string>();
    const activeAttemptIds = new Set<string>();
    if (sessionTaskId) activeTaskIds.add(sessionTaskId);
    if (sessionAttemptId) activeAttemptIds.add(sessionAttemptId);

    try {
        const db = MeshRuntimeStore.getInstance().db;
        if (sessionId) {
            const openAttempts = db.prepare(
                `SELECT attempt_id, task_id
                 FROM turn_attempts
                 WHERE session_id = ?
                   AND terminal_outcome IS NULL
                   AND state IN ('delivered', 'consumed', 'generating', 'suspended', 'finalizing')`,
            ).all(sessionId) as Array<{ attempt_id?: unknown; task_id?: unknown }>;
            for (const row of openAttempts) {
                const attId = readOptionalString(row.attempt_id);
                const tId = readOptionalString(row.task_id);
                if (attId) activeAttemptIds.add(attId);
                if (tId) activeTaskIds.add(tId);
            }

            const assignedTasks = db.prepare(
                `SELECT id
                 FROM mesh_queue
                 WHERE assigned_session_id = ?
                   AND status = 'assigned'`,
            ).all(sessionId) as Array<{ id?: unknown }>;
            for (const row of assignedTasks) {
                const tId = readOptionalString(row.id);
                if (tId) activeTaskIds.add(tId);
            }
        } else if (incomingAttemptId) {
            const openAttempt = db.prepare(
                `SELECT attempt_id, session_id, task_id
                 FROM turn_attempts
                 WHERE attempt_id = ?
                   AND terminal_outcome IS NULL
                   AND state IN ('delivered', 'consumed', 'generating', 'suspended', 'finalizing')
                 LIMIT 1`,
            ).get(incomingAttemptId) as { attempt_id?: unknown; session_id?: unknown; task_id?: unknown } | undefined;
            if (openAttempt) {
                const attId = readOptionalString(openAttempt.attempt_id);
                const tId = readOptionalString(openAttempt.task_id);
                if (attId) activeAttemptIds.add(attId);
                if (tId) activeTaskIds.add(tId);
            }
        }
    } catch {
        // Best-effort DB lookup; session settings above remain authoritative when DB is unavailable.
    }

    if (incomingAttemptId) {
        if (!activeAttemptIds.has(incomingAttemptId)) return false;
        if (incomingTaskId && activeTaskIds.size > 0 && !activeTaskIds.has(incomingTaskId)) return false;
        return true;
    }

    if (incomingTaskId) {
        return activeTaskIds.has(incomingTaskId);
    }

    if (params.isMeshOrCoordinatorFollowUp && sessionHasActiveBinding) {
        return true;
    }

    return false;
}

/** Resolve session-only admission from the existing instance, never widen missing scope. */
export function resolveNewWorkHoldSessionMeshId(
    args: Record<string, unknown> | null | undefined,
    instanceManager?: Pick<DaemonComponents['instanceManager'], 'getInstance'> | null,
): string | undefined {
    const meshContext = isPlainRecord(args?.meshContext) ? args.meshContext : null;
    const explicit = readOptionalString(args?.meshId) ?? readOptionalString(args?.mesh_id)
        ?? readOptionalString(meshContext?.meshId);
    if (explicit) return explicit;
    const sessionId = readOptionalString(args?.targetSessionId) ?? readOptionalString(args?.sessionId)
        ?? readOptionalString(args?.instanceId);
    const settings = sessionId ? instanceManager?.getInstance(sessionId)?.getState().settings : undefined;
    return readOptionalString(settings?.meshNodeFor) ?? readOptionalString(settings?.meshCoordinatorFor) ?? undefined;
}

/**
 * S1: DaemonCommandRouter admission check for new-work hold.
 *
 * Refuses new-work commands (`launch_cli`, `launch_mesh_coordinator`, `launch_ide`,
 * `restart_session`, `session_host_resume_session`, `session_host_restart_session`,
 * `launch_assistant`, `assistant_project_send`, `assistant_remote_project` send,
 * `refine_mesh_node` / `batch_refine_mesh_nodes` execute, and `agent_command` /
 * `send_chat` new-task dispatches) while a hold is active.
 *
 * Explicit exemptions:
 * 1. Direct owner chat (`send_chat` / `agent_command` with verified owner ingress
 *    and no coordinator `meshContext` / `meshAttemptRef`).
 * 2. Coordinator follow-ups to already-running workers (matching active `taskId` /
 *    `meshAttemptRef` / active task binding on the target session).
 * 3. In-flight worker completion/progress/approval/stop/read-only commands.
 */
export function admitRouterCommandUnderNewWorkHold(
    command: string,
    normalizedArgs: Record<string, unknown>,
    revealedMeshIds: readonly string[] = [],
    components?: DaemonComponents | null,
): NewWorkHoldRefusal | null {
    if (NEW_WORK_HOLD_EXEMPT_COMMANDS.has(command)) return null;
    if (!NEW_WORK_HOLD_GATED_COMMANDS.has(command)) return null;

    if (command === 'refine_mesh_node' || command === 'batch_refine_mesh_nodes') {
        const isExecute = normalizedArgs.execute === true
            && normalizedArgs.dryRun !== true
            && normalizedArgs.dry_run !== true;
        if (!isExecute) return null;
    }

    if (command === 'assistant_remote_project') {
        if (readOptionalString(normalizedArgs.op) !== 'send') return null;
    }

    if (command === 'agent_command') {
        const action = readOptionalString(normalizedArgs.action);
        if (action && action !== 'send_chat') {
            return null;
        }
    }

    const targetMeshIds = revealedMeshIds.length > 0 ? revealedMeshIds : [resolveNewWorkHoldSessionMeshId(normalizedArgs, components?.instanceManager)];
    for (const meshId of targetMeshIds) {
        const evalResult = evaluateNewWorkHold({ meshId, components });
        if (!evalResult.held) continue;

        if (command === 'send_chat' || command === 'agent_command') {
            const meshCtx = isPlainRecord(normalizedArgs.meshContext) ? normalizedArgs.meshContext : null;
            const incomingTaskId = readOptionalString(meshCtx?.taskId) ?? readOptionalString(normalizedArgs.taskId);
            const incomingAttemptId = readOptionalString(meshCtx?.attemptId)
                ?? readOptionalString(normalizedArgs.meshAttemptRef)
                ?? readOptionalString(normalizedArgs.attemptId);
            const isCoordinatorTaskDispatch = Boolean(
                meshCtx ||
                incomingAttemptId ||
                incomingTaskId ||
                normalizedArgs.origin === 'mesh' ||
                normalizedArgs.origin === 'coordinator',
            );
            const ingress = readRouterCommandIngress(normalizedArgs);
            const isOwnerDirectChat = Boolean(
                !isCoordinatorTaskDispatch &&
                (ingress?.source === 'p2p' || ingress?.source === 'standalone') &&
                ingress?.inProcess !== true &&
                isTrustedOwnerIngress(normalizedArgs, ingress.source),
            );
            if (isOwnerDirectChat) {
                return null;
            }

            const targetSessionId = readOptionalString(normalizedArgs.targetSessionId)
                ?? readOptionalString(normalizedArgs.sessionId)
                ?? readOptionalString(normalizedArgs.instanceId);
            const targetNodeId = readOptionalString(meshCtx?.nodeId) ?? readOptionalString(normalizedArgs.nodeId);
            const agentType = readOptionalString(normalizedArgs.agentType) ?? readOptionalString(normalizedArgs.cliType);
            const workspaceDir = readOptionalString(normalizedArgs.dir) ?? readOptionalString(normalizedArgs.workspace);

            if (isRunningWorkContinuation({
                sessionId: targetSessionId,
                nodeId: targetNodeId,
                agentType,
                workspaceDir,
                taskId: incomingTaskId,
                attemptId: incomingAttemptId,
                isMeshOrCoordinatorFollowUp: isCoordinatorTaskDispatch,
                instanceManager: components?.instanceManager,
                cliManager: components?.cliManager,
            })) {
                return null;
            }
        }

        return buildNewWorkHeldRefusal(evalResult.hold, {
            command,
            surface: 'router_command',
        });
    }

    return null;
}

/**
 * Session-start choke-point guard (F4): called inside `startSession` / `launchCli`
 * next to `withMaintenanceAdmission` so any session start (`launch_cli`,
 * `restart_session`, `launch_assistant`, `launch_mesh_coordinator`,
 * `dev-cli-debug`, or Refinery-triggered session) is refused when held.
 */
export function assertNewWorkHoldAdmission(options?: {
    meshId?: string | null;
    settings?: Record<string, unknown> | null;
    command?: string;
    surface?: NewWorkHoldRefusal['surface'];
    components?: DaemonComponents | null;
}): void {
    const meshId = readOptionalString(options?.meshId)
        ?? readOptionalString(options?.settings?.meshNodeFor)
        ?? readOptionalString(options?.settings?.meshCoordinatorFor)
        ?? undefined;
    const evalResult = evaluateNewWorkHold({ meshId, components: options?.components });
    if (!evalResult.held) return;
    const refusal = buildNewWorkHeldRefusal(evalResult.hold, {
        command: options?.command ?? 'start_session',
        surface: options?.surface ?? 'router_command',
    });
    const message = formatNewWorkHeldMessage({
        holdId: evalResult.hold.holdId || 'active',
        revision: evalResult.hold.revision,
        expiresAt: evalResult.hold.expiresAt || 0,
        phase: evalResult.hold.phase,
        reason: evalResult.hold.reason,
    }, options?.command ? `Command '${options.command}' refused while new-work hold is active` : 'Session start refused while new-work hold is active');
    throw new NewWorkHeldError({ ...refusal, error: message });
}
