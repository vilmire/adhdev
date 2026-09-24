/**
 * Refinery async-job plumbing — job handles, coordinator events, ledger entries.
 *
 * Pure move out of router-refine.ts to keep that file under the file-size gate;
 * the same functions, taking the router instance as `self`, in the same order. No
 * event name, payload shape, log string, or ledger field was changed — only
 * physical location. router-refine.ts re-exports every symbol here, so existing
 * import sites (and their tests) are unaffected.
 *
 * The concern is one slice of the refine lifecycle: turning a refine request into
 * a `MeshRefineJobHandle`, slimming a terminal result down to what a coordinator
 * event can carry, and persisting the full record to the mesh ledger.
 */
import type { DaemonCommandRouter, CommandRouterResult } from './router.js';
import { LOG } from '../logging/logger.js';
import { createInteractionId } from '../logging/debug-trace.js';
import { handleMeshForwardEvent, notifyMeshCoordinator } from '../mesh/mesh-events.js';
import { readStringValue } from '../mesh/mesh-node-identity.js';
import type { MeshRefineAsyncJobStatus, MeshRefineJobHandle } from '../mesh/mesh-refine-gates.js';

export function buildRefineJobKey(self: DaemonCommandRouter, meshId: string, nodeId: string): string {
        return `${meshId}:${nodeId}`;
    }

export function buildRefineJobHandle(self: DaemonCommandRouter, args: {
        meshId: string;
        nodeId: string;
        node?: any;
        status?: MeshRefineAsyncJobStatus;
        startedAt?: string;
        completedAt?: string;
        jobId?: string;
        interactionId?: string;
        retryOfJobId?: string;
        coordinatorDaemonId?: string;
        /** Requesting coordinator SESSION (REFINE-EVENT-SESSION-SCOPED-UNICAST). */
        coordinatorSessionId?: string;
    }): MeshRefineJobHandle {
        return {
            success: true,
            async: true,
            status: args.status || 'accepted',
            jobId: args.jobId || `refine_${createInteractionId()}`,
            interactionId: args.interactionId || createInteractionId(),
            meshId: args.meshId,
            nodeId: args.nodeId,
            targetNodeId: args.nodeId,
            targetDaemonId: readStringValue(args.node?.daemonId),
            workspace: readStringValue(args.node?.workspace),
            startedAt: args.startedAt || new Date().toISOString(),
            ...(args.completedAt ? { completedAt: args.completedAt } : {}),
            ...(args.retryOfJobId ? { retryOfJobId: args.retryOfJobId } : {}),
            ...(args.coordinatorDaemonId ? { targetCoordinatorDaemonId: args.coordinatorDaemonId } : {}),
            ...(args.coordinatorSessionId ? { targetCoordinatorSessionId: args.coordinatorSessionId } : {}),
            eventDelivery: { pendingEvents: true, ledger: true },
            evidence: {
                pendingEventsCommand: 'get_pending_mesh_events',
                ledgerCommand: 'get_mesh_ledger_slice',
                taskHistoryKind: args.status === 'completed' ? 'task_completed' : args.status === 'failed' ? 'task_failed' : 'task_dispatched',
            },
        };
    }

/**
 * QW2: extract a compact failure diagnostic from a validation summary — the first
 * failing command's name, its exit code, its failureKind, and a bounded output tail.
 * Surfaced in BOTH the slim coordinator event and the ledger blockerContext so a
 * coordinator can decide next-step without pulling and parsing the full ledger record.
 *
 * A command record carries `passed` (boolean), never `success` (see QW1) — the first
 * record with passed===false is the gate's failing command. Returns undefined when the
 * summary did not fail on a command (e.g. bootstrap-stage failure with no commandsRun
 * entry), in which case the top-level failureCode/failureKind still describe the cause.
 */
export function extractValidationFailureDiagnostics(
    validationSummary: Record<string, unknown> | undefined,
): { firstFailedCommand?: string; exitCode?: unknown; failureKind?: unknown; outputTail?: string } | undefined {
    if (!validationSummary || typeof validationSummary !== 'object') return undefined;
    const commandsRun = Array.isArray(validationSummary.commandsRun)
        ? (validationSummary.commandsRun as Array<Record<string, unknown>>)
        : [];
    const failed = commandsRun.find(c => c.passed === false);
    const summaryFailureKind = validationSummary.failureKind;
    if (!failed) {
        // No per-command failure (bootstrap failure, spawn resolution before any
        // command ran, etc.) — still surface the summary-level failureKind so the
        // event isn't blank.
        return summaryFailureKind !== undefined ? { failureKind: summaryFailureKind } : undefined;
    }
    const firstFailedCommand = typeof failed.displayCommand === 'string' ? failed.displayCommand
        : typeof failed.command === 'string'
            ? [failed.command, ...(Array.isArray(failed.args) ? failed.args : [])].join(' ').trim()
            : undefined;
    const rawOutput = [failed.stderr, failed.stdout, failed.output]
        .filter(s => typeof s === 'string' && (s as string).length > 0)
        .join('\n');
    const outputTail = rawOutput.length > 600 ? rawOutput.slice(-600) : rawOutput;
    return {
        ...(firstFailedCommand ? { firstFailedCommand } : {}),
        ...(failed.exitCode !== undefined ? { exitCode: failed.exitCode } : {}),
        ...(failed.failureKind !== undefined ? { failureKind: failed.failureKind }
            : summaryFailureKind !== undefined ? { failureKind: summaryFailureKind } : {}),
        ...(outputTail ? { outputTail } : {}),
    };
}

/**
 * Slim the terminal-stage refine result down to the fields a coordinator needs to
 * decide next-step, dropping the heavy per-command / per-entry detail.
 *
 * The full `CommandRouterResult` (with `validationSummary.commandsRun[]` carrying
 * per-command stdout/stderr, `rejectedCommands`, `suggestions`, `suggestedConfig`,
 * the full `patchEquivalence`, and `submoduleReachability.entries[]`/`.unreachable[]`)
 * routinely exceeds 70KB and overflows the coordinator token limit when surfaced as a
 * coordinator event payload. The full detail is still persisted verbatim to the ledger
 * (`appendRefineJobLedger`) and `terminalRefineJobs`, so slimming only the EVENT loses
 * nothing — the coordinator can pull the full record on demand via
 * `evidence.ledgerCommand` / `taskHistoryKind`.
 */
export function slimRefineEventResult(result: Record<string, unknown>): Record<string, unknown> {
        const slim: Record<string, unknown> = {};
        // Top-level scalars the coordinator branches on.
        for (const key of [
            'success', 'code', 'error', 'convergenceStatus', 'blockedReason',
            'branch', 'into', 'terminalKind', 'nextStep', 'finalBranchConvergenceState',
            // QW4: merge conflict paths; QW5: cleanup branch-ref / residue warnings.
            'conflictPaths', 'branchRefWarning', 'residueWarning', 'branchRefDeleted',
            // GHOST-FAILURE: merge-landing facts. The coordinator sees ONLY this slim
            // result; without these it cannot tell a pre-merge failure (nothing landed)
            // from a post-merge one (the change IS on origin) without a manual git check.
            'merged', 'mergedLocal', 'pushed', 'mergedSha', 'postMergeWarning', 'refineLanding',
            // ★REBASE-FAILURE-CLASSIFY: the coordinator sees ONLY this slim result. Without
            // these it cannot tell "the rebase hit conflicts" from "the rebase refused to
            // start on a dirty worktree" — the exact confusion that nearly produced a
            // manual re-push of an already-merged branch on 2026-08-20. `rebaseStderr` is
            // git's own words, bounded by buildRefineRebaseFailureError's excerpt limit.
            'rebaseFailureDetail', 'rebaseConflict', 'rebaseStderr',
        ] as const) {
            if (result[key] !== undefined) slim[key] = result[key];
        }
        // Mapped subset of the unreachable-submodule commits (path + autoPublishAllowed),
        // not the full commit records.
        if (Array.isArray(result.unreachableSubmoduleCommits)) {
            slim.unreachableSubmoduleCommits = (result.unreachableSubmoduleCommits as Array<Record<string, unknown>>)
                .map(e => ({ path: e?.path, autoPublishAllowed: e?.autoPublishAllowed }));
        }
        // Reduced validation summary — status + failure classification + config source
        // + a count of commands run (drop the full commandsRun/rejectedCommands/
        // suggestions/suggestedConfig detail).
        if (result.validationSummary && typeof result.validationSummary === 'object') {
            const vs = result.validationSummary as Record<string, unknown>;
            // QW2: attach compact failure diagnostics (first failing command + exit code
            // + failureKind + bounded output tail) so a coordinator can decide next-step
            // straight from the event without pulling the full ledger record.
            const diagnostics = vs.status === 'failed'
                ? extractValidationFailureDiagnostics(vs)
                : undefined;
            slim.validationSummary = {
                status: vs.status,
                failureCode: vs.failureCode,
                failureKind: vs.failureKind,
                configSource: vs.configSource,
                configSourceType: vs.configSourceType,
                commandsRunCount: Array.isArray(vs.commandsRun) ? vs.commandsRun.length : undefined,
                ...(diagnostics ? { failure: diagnostics } : {}),
            };
        }
        // Reduce patch-equivalence to just its verdict.
        if (result.patchEquivalence && typeof result.patchEquivalence === 'object') {
            const pe = result.patchEquivalence as Record<string, unknown>;
            slim.patchEquivalence = { status: pe.status, equivalent: pe.equivalent };
        }
        // Reduce submodule reachability to counts; drop the full entries/unreachable arrays.
        if (result.submoduleReachability && typeof result.submoduleReachability === 'object') {
            const sr = result.submoduleReachability as Record<string, unknown>;
            slim.submoduleReachability = {
                checked: Array.isArray(sr.entries) ? sr.entries.length : undefined,
                unreachable: Array.isArray(sr.unreachable) ? sr.unreachable.length : undefined,
            };
        }
        return slim;
}

export function queueRefineJobEvent(self: DaemonCommandRouter, event: 'refine:accepted' | 'refine:completed' | 'refine:failed', handle: MeshRefineJobHandle, result?: Record<string, unknown>): void {
        const slimResult = result ? slimRefineEventResult(result) : undefined;
        const metadataEvent = {
            source: 'refine_mesh_node_async_job',
            jobId: handle.jobId,
            interactionId: handle.interactionId,
            meshId: handle.meshId,
            nodeId: handle.targetNodeId,
            targetDaemonId: handle.targetDaemonId,
            workspace: handle.workspace,
            status: handle.status,
            startedAt: handle.startedAt,
            completedAt: handle.completedAt,
            retryOfJobId: handle.retryOfJobId,
            ...(slimResult ? { result: slimResult } : {}),
        };
        const eventPayload = {
            event,
            meshId: handle.meshId,
            nodeLabel: handle.targetNodeId,
            nodeId: handle.targetNodeId,
            workspace: handle.workspace,
            metadataEvent: {
                ...metadataEvent,
                // REFINE-EVENT-SESSION-SCOPED-UNICAST: mirror the session INSIDE
                // metadataEvent too. handleMeshForwardEvent reads the coordinator session
                // anchor from `metadataEvent.meshCoordinatorSessionId` (a top-level field
                // alone is dropped when the event crosses a machine boundary), so this is
                // what survives the P2P relay for a remote-executing refine.
                ...(handle.targetCoordinatorSessionId
                    ? { meshCoordinatorSessionId: handle.targetCoordinatorSessionId }
                    : {}),
            },
            queuedAt: Date.now(),
            ...(handle.targetCoordinatorDaemonId ? { targetCoordinatorDaemonId: handle.targetCoordinatorDaemonId } : {}),
            // THE FIX: address the terminal event to the requesting coordinator SESSION,
            // not just its daemon. stampPendingEventV2 folds this into the v2 unicast
            // `intendedFor`, so identityDeliversTo's both-sides-session branch excludes a
            // sibling coordinator session on the same daemon. Absent (legacy requester) →
            // session-less intendedFor → daemon-level delivery exactly as before.
            ...(handle.targetCoordinatorSessionId ? { targetCoordinatorSessionId: handle.targetCoordinatorSessionId } : {}),
        };
        // The REAL components (S7-attached), never an `{ instanceManager }` look-alike.
        // Inside the boot window there are none yet → the notice-queue fallback below.
        const components = self.attachedComponentsOrNull();
        if (components) {
            const forwarded = handleMeshForwardEvent(
                components,
                {
                    event,
                    meshId: handle.meshId,
                    nodeId: handle.targetNodeId,
                    workspace: handle.workspace,
                    jobId: handle.jobId,
                    interactionId: handle.interactionId,
                    status: handle.status,
                    targetDaemonId: handle.targetDaemonId,
                    startedAt: handle.startedAt,
                    completedAt: handle.completedAt,
                    retryOfJobId: handle.retryOfJobId,
                    // RC32: carry the return address through the forward payload too (it
                    // already rode the queued eventPayload below). Sessionless refine has
                    // no live worker session, so injectMeshSystemMessage can only recover
                    // the coordinator anchor from this relayed field — without it the
                    // re-queued event self-fallbacks to THIS (the executing/worker)
                    // daemon and the real coordinator's drain excludes it.
                    ...(handle.targetCoordinatorDaemonId ? { targetCoordinatorDaemonId: handle.targetCoordinatorDaemonId } : {}),
                    // REFINE-EVENT-SESSION-SCOPED-UNICAST: carry the SESSION half of the
                    // return address across the relay as well. buildRelayMetadataEvent
                    // reads meshCoordinatorSessionId (falling back to
                    // targetCoordinatorSessionId), so both spellings are supplied.
                    ...(handle.targetCoordinatorSessionId
                        ? {
                            targetCoordinatorSessionId: handle.targetCoordinatorSessionId,
                            meshCoordinatorSessionId: handle.targetCoordinatorSessionId,
                        }
                        : {}),
                    ...(slimResult ? { result: slimResult } : {}),
                },
            );
            if (forwarded?.success === true) return;
            LOG.warn('Mesh', `[Refinery] Failed to forward async refine event ${event}: ${forwarded?.error || 'unknown error'}`);
        }
        notifyMeshCoordinator(eventPayload);
    }

export async function appendRefineJobLedger(self: DaemonCommandRouter, kind: 'task_dispatched' | 'task_completed' | 'task_failed', handle: MeshRefineJobHandle, result?: Record<string, unknown>): Promise<void> {
        try {
            const { buildLedgerOriginatingCoordinatorStamp } = await import('../mesh/mesh-ledger.js');
            const { meshRecord } = await import('../mesh/mesh-record.js');
            // B2a: on dispatch, stamp the originating coordinator so a later completion
            // emit can restore `dispatchedBy` and route the terminal event back (unicast).
            // Refine jobs carry only a coordinator DAEMON id (no session), which is enough
            // to route to the daemon-level coordinator. Absent → omitted (v1 entry).
            const originatingStamp = kind === 'task_dispatched'
                ? buildLedgerOriginatingCoordinatorStamp({ coordinatorDaemonId: handle.targetCoordinatorDaemonId })
                : undefined;
            // ★REFINE-RESUME-LIVENESS: stamp WHICH PROCESS owns this execution. The boot
            // resume scan's `isRunning` reads an in-memory map that a restart empties, so
            // it structurally cannot see an execution still running in the OLD process —
            // which is how a restart mid-refine produced a ghost second execution of the
            // same jobId on 2026-08-20. The stamp gives the next boot something real to
            // check instead of a timeout proxy (see mesh-refine-executor-liveness.ts).
            const executorStamp = kind === 'task_dispatched'
                ? (await import('../mesh/mesh-refine-executor-liveness.js')).buildRefineExecutorStamp()
                : undefined;
            meshRecord(handle.meshId, kind, {
                nodeId: handle.targetNodeId,
                payload: {
                    source: 'refine_mesh_node_async_job',
                    refineJob: {
                        jobId: handle.jobId,
                        interactionId: handle.interactionId,
                        status: handle.status,
                        meshId: handle.meshId,
                        nodeId: handle.targetNodeId,
                        targetDaemonId: handle.targetDaemonId,
                        targetCoordinatorDaemonId: handle.targetCoordinatorDaemonId,
                        workspace: handle.workspace,
                        startedAt: handle.startedAt,
                        completedAt: handle.completedAt,
                        retryOfJobId: handle.retryOfJobId,
                        ...(executorStamp ? { executor: executorStamp } : {}),
                    },
                    async: true,
                    retryOfJobId: handle.retryOfJobId,
                    ...(originatingStamp ? { originatingCoordinator: originatingStamp } : {}),
                    ...(result ? {
                        success: result.success === true,
                        result,
                        finalBranchConvergenceState: result.finalBranchConvergenceState,
                        ...(result.blockerContext ? { blockerContext: result.blockerContext } : {}),
                    } : {}),
                },
            }, { local: true });
        } catch (e: any) {
            LOG.warn('Mesh', `[Refinery] Failed to append async refine ledger entry: ${e?.message || e}`);
        }
    }
