import type { DaemonComponents } from '../boot/daemon-components.js';
import { recordQueueTaskHold } from './mesh-queue-hold-store.js';
import { spendTaskAutoLaunchSpawnBudget, recordTaskAutoLaunchDispatchFailure } from './mesh-autolaunch-spawn-budget.js';
import { recordTaskAutoLaunch } from './mesh-work-queue.js';
import { isActionableSkipReason, retractActionableSkipIfPreviouslyNotified, notifyCoordinatorOfActionableSkip, TRANSIENT_TARGET_NODE_BOOTSTRAP_PENDING_REASON } from './mesh-skip-notify.js';
import { recordAutoLaunchEvent } from './mesh-queue-observability.js';
import { autoLaunchWriteWouldClobberWinner, AUTO_LAUNCH_AWAIT_CLAIM_MS } from './mesh-autolaunch-integrity.js';
import { autoLaunchWriteWouldClobberDifficultyFloorWaitClock, handleDifficultyFloorSkip, isDifficultyFloorWaitReason } from './mesh-difficulty-floor.js';
import { isLocalAutoLaunchNode } from './mesh-candidacy-predicates.js';
import { readMeshNodeDaemonId } from './mesh-node-identity.js';
import { localCoordinatorDaemonId } from './mesh-queue-assignment.js';

/**
 * Auto-launch target resolution + ledger-write helpers — extracted from
 * mesh-queue-autolaunch.ts (pure move, no behavior change) for the file-size gate.
 * mesh-queue-autolaunch.ts imports these back and re-exports the test hook.
 */

/**
 * Resolve how a pending queue task should be auto-launched onto a node.
 *
 * - `local`: spawn directly on this daemon via router.execute('launch_cli', …, 'mesh').
 * - `remote`: forward `launch_cli` to the node's daemon via dispatchMeshCommand
 *   (mirrors what mesh_launch_session does). Requires dispatchMeshCommand AND a
 *   resolvable coordinator daemonId for relay-safe completion routing.
 * - `skip`: not launchable from here — carries the reason (e.g. a remote node with
 *   no dispatch transport, or no coordinator daemonId to stamp).
 */
export function resolveAutoLaunchTarget(components: DaemonComponents, node: any): {
    mode: 'local' | 'remote' | 'skip';
    reason?: string;
    daemonId?: string;
    coordinatorDaemonId?: string;
} {
    if (isLocalAutoLaunchNode(node)) return { mode: 'local' };

    // Remote node. Forwarding the launch is possible only with a dispatch transport
    // (cloud mode) plus a coordinator daemonId to stamp into the worker so completion
    // events route back here. Without either, fall back to a graceful skip.
    //
    // CANON-IDENTITY: read the daemonId through the normalizing helper (same defect class
    // as the dispatch guard above). A raw `node.daemonId` read misses non-top-level-camelCase
    // serialization forms (daemon_id / machine.daemonId / lastProbe.machine.daemon_id / …),
    // so a genuinely-remote node arriving in one of those forms read empty here and was
    // wrongly skipped as `remote_auto_launch_unsupported`. readMeshNodeDaemonId returns
    // undefined (falsy) when absent — equivalent to the old readNonEmptyString + !daemonId
    // guard, so local/self auto-launch is unchanged.
    const daemonId = readMeshNodeDaemonId(node ?? {});
    if (!daemonId) return { mode: 'skip', reason: 'remote_auto_launch_unsupported' };
    if (!components.dispatchMeshCommand) return { mode: 'skip', reason: 'remote_auto_launch_unsupported' };
    // CANON: stamp the canonical `daemon_mach_` coordinator anchor onto the remote
    // worker (meshCoordinatorDaemonId) so its completion forwards back under the same
    // form every other dispatch path uses — no producer-side coordinator-id skew.
    const coordinatorDaemonId = localCoordinatorDaemonId();
    if (!coordinatorDaemonId) return { mode: 'skip', reason: 'remote_auto_launch_no_coordinator_daemon_id' };
    return { mode: 'remote', daemonId, coordinatorDaemonId };
}

export function markAutoLaunch(meshId: string, taskId: string, args: {
    status: 'skipped' | 'started' | 'failed' | 'completed';
    reason?: string;
    nodeId?: string;
    providerType?: string;
    sessionId?: string;
    error?: string;
    // LEDGER-TASK-TRACEABILITY (D): resolved execution profile for started/completed.
    model?: string;
    thinkingLevel?: string;
    /**
     * SPAWN-CAP-TRANSPORT-AWARE: set by the launch paths at the moment a session is known
     * to exist (or cannot be proven NOT to exist), to spend one unit of the task's durable
     * spawn budget. Never set on the pre-dispatch 'started' record — see
     * recordTaskAutoLaunch for why intent is the wrong thing to charge for.
     */
    spendSpawnBudget?: boolean;
    /**
     * SPAWN-CAP-TRANSPORT-AWARE: set when the launch dispatch died in this coordinator's
     * own transport (no session created anywhere). Recorded on its own durable axis so the
     * park page can name the real failure mode instead of blaming the target node.
     */
    dispatchFailedInTransport?: boolean;
}) {
    const reason = args.reason || args.error;
    if (args.status === 'skipped' && reason) recordQueueTaskHold(meshId, taskId, reason, args.nodeId);
    const difficultyFloorSkip = args.status === 'skipped' && isDifficultyFloorWaitReason(reason);
    if (difficultyFloorSkip) {
        handleDifficultyFloorSkip({ meshId, taskId, reason: reason!, nodeId: args.nodeId, coordinatorDaemonId: localCoordinatorDaemonId() });
    } else if (!autoLaunchWriteWouldClobberWinner(meshId, taskId, args, AUTO_LAUNCH_AWAIT_CLAIM_MS) && !autoLaunchWriteWouldClobberDifficultyFloorWaitClock(meshId, taskId, args.status, reason)) {
        recordTaskAutoLaunch(meshId, taskId, {
            status: args.status,
            reason,
            nodeId: args.nodeId,
            providerType: args.providerType,
            sessionId: args.sessionId,
        }, { spendSpawnBudget: args.spendSpawnBudget });
    } else if (args.spendSpawnBudget) {
        // The clobber guards protect the `autoLaunch` FIELD (which launch owns the record),
        // NOT the spawn budget. A suppressed write still represents a session that came into
        // existence, so the budget must be spent regardless — otherwise a racing launch pair
        // could spawn two sessions and be charged for one, the exact undercount the runaway
        // defense cannot afford. Spend it without touching the protected field.
        spendTaskAutoLaunchSpawnBudget(meshId, taskId);
    }
    if (args.dispatchFailedInTransport) recordTaskAutoLaunchDispatchFailure(meshId, taskId);
    recordAutoLaunchEvent(meshId, {
        phase: args.status,
        taskId,
        nodeId: args.nodeId,
        providerType: args.providerType,
        sessionId: args.sessionId,
        reason: args.reason,
        error: args.error,
        ...(args.model ? { model: args.model } : {}),
        ...(args.thinkingLevel ? { thinkingLevel: args.thinkingLevel } : {}),
    });
    // Fix (1): actively notify the coordinator of a non-self-resolving skip; re-arm the
    // notification on any non-skip transition (started/completed) so a later genuine skip
    // re-notifies.
    if (args.status === 'skipped') {
        if (isActionableSkipReason(args.reason)) {
            notifyCoordinatorOfActionableSkip(meshId, taskId, args.reason, args.nodeId);
        } else if (!difficultyFloorSkip && args.reason === TRANSIENT_TARGET_NODE_BOOTSTRAP_PENDING_REASON) {
            // FALSE-BLOCKER-CLONE-QUEUE (stale-event clear): the unmatch is now known to be a
            // self-resolving clone/bootstrap window — retract any earlier actionable blocker we
            // paged for this same task. Other transient/back-pressure reasons (cooldown, caps)
            // intentionally do NOT retract: they can mask a still-standing real blocker.
            retractActionableSkipIfPreviouslyNotified(meshId, taskId);
        }
    } else {
        // started/completed: the task is progressing — re-arm the de-dup ledger and retract
        // any still-undelivered stale blocker for it.
        retractActionableSkipIfPreviouslyNotified(meshId, taskId);
    }
}

export const __markAutoLaunchForTests = markAutoLaunch;
