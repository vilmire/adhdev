// Turn-ledger bookkeeping for a direct dispatch (mesh_send_task): open the
// `mesh_direct` attempt before the send, record delivered / dispatch_failed after
// it, and the idle-dispatch acknowledgement-risk fields. Bookkeeping only — the
// transport delivery happens independently around these calls.

import type { MeshContext } from './mesh-tools-internal.js';
import { turnObserve, TurnIpcCommandError } from '../ipc/turn-commands.js';
import { sanitizeRefusalCode } from '@adhdev/mesh-shared';
import { classifySessionBusyWithTask } from '@adhdev/daemon-core';

/**
 * DISPATCH-ACK-RISK-STALE — compute the dispatch-acknowledgement risk fields for a
 * direct (mesh_send_task --session_id) dispatch to an idle session.
 *
 * Before the NOTIF-DROP / CANON-A fix, ANY dispatch to an idle session was flagged
 * `dispatchAcknowledgementRisk:true` because a fast completion could race ahead of the
 * dispatch row and be swallowed by the prior-terminal providerSessionId dedup gate
 * (mesh-event-forwarding.ts). Now that the dispatch row is atomically pre-recorded BEFORE
 * inject, a successful pre-record makes sessionHasActiveAssignment=TRUE at completion time,
 * so the dedup gate is skipped and the completion is delivered — there is NO residual loss
 * risk. The stale warning made coordinators do needless verification polling.
 *
 * Risk is therefore true ONLY when the session was idle AND the dispatch row did not
 * persist (pre-record failed / was rolled back) — the one case where the dedup gate can
 * still swallow the completion. Returns the fields to spread into the success response, or
 * an empty object when there is no risk to surface.
 */
export function computeIdleDispatchAckRisk(
    sessionWasIdle: boolean,
    dispatchPreRecorded: boolean,
    sessionId: string,
): Record<string, unknown> {
    if (!sessionWasIdle || dispatchPreRecorded) return {};
    return {
        dispatchAcknowledgementRisk: true,
        dispatchAcknowledgementRiskReason: 'idle_dispatch_prerecord_failed',
        dispatchAcknowledgementNote: `Session '${sessionId}' was idle at dispatch time and the dispatch row could not be pre-recorded, so its completion may be deduplicated as a prior turn and lost. Use mesh_status to verify; if the session remains idle or the completion never lands, launch a fresh session and retry.`,
    };
}

/**
 * The outcome of opening a direct dispatch's `mesh_direct` attempt.
 *
 *   opened      — the ledger opened it; `attemptRef` rides in meshContext.
 *   refused     — the ledger ANSWERED and said no: the target session already holds
 *                 an open mesh attempt (`session_busy_with_task`). The dispatch must
 *                 NOT be sent — sending it is exactly what left task 14147d9b
 *                 (2026-10-06) as an attempt-less `assigned` queue row that no reclaim
 *                 owned and that blocked write autolaunch on its node for days.
 *   unavailable — the ledger could not be asked or could not answer (mid-boot, not
 *                 armed, transport down, any other failure). Best-effort: the dispatch
 *                 goes ahead uncorrelated, as it always has.
 */
export type DirectDispatchAttemptOpen =
    | { kind: 'opened'; attemptRef: { attemptId: string; generation: number } }
    | { kind: 'refused'; code: 'session_busy_with_task'; currentTaskId?: string; currentAttemptId?: string; detail: string }
    | { kind: 'unavailable' };

/**
 * C-W6c: open a `mesh_direct` attempt in the NEW turn ledger (C1 reducer) for a
 * direct dispatch. Bookkeeping only — the transport delivery
 * (`sendDirectAgentTask`'s `agent_command`) happens independently around this
 * helper, and only when this does not return `refused`.
 *
 * See {@link DirectDispatchAttemptOpen}: a ledger REFUSAL (the session already
 * holds an open attempt) is distinguished from the ledger being UNAVAILABLE —
 * the former stops the dispatch, the latter lets it continue uncorrelated.
 */
export async function openDirectDispatchAttempt(
    ctx: MeshContext,
    opts: { taskId: string; nodeId?: string; sessionId: string; providerType?: string },
): Promise<DirectDispatchAttemptOpen> {
    try {
        const accepted = await turnObserve(ctx.transport, {
            evidence: {
                eventId: opts.taskId,
                at: Date.now(),
                source: 'dispatch',
                sessionId: opts.sessionId,
                taskId: opts.taskId,
                observedBy: ctx.localDaemonId ?? 'mcp-server',
                kind: 'dispatch_accepted',
                scope: 'mesh_direct',
                messageId: opts.taskId,
                meshId: ctx.mesh.id,
                ...(opts.nodeId ? { nodeId: opts.nodeId } : {}),
                ...(opts.providerType ? { providerType: opts.providerType } : {}),
            },
        });
        return { kind: 'opened', attemptRef: accepted.attemptRef };
    } catch (e) {
        if (e instanceof TurnIpcCommandError && e.code === 'session_busy_with_task') {
            // The refusal message carries the busy-dispatch machine token
            // (`session_busy_with_task[task=<id> attempt=<id|->]`) — read it back with
            // the same classifier the worker-side refusal uses.
            const busy = classifySessionBusyWithTask(e.message);
            const currentTaskId = busy && busy.currentTaskId !== 'unknown' ? busy.currentTaskId : undefined;
            const currentAttemptId = busy?.currentAttemptId;
            return {
                kind: 'refused',
                code: 'session_busy_with_task',
                ...(currentTaskId ? { currentTaskId } : {}),
                ...(currentAttemptId ? { currentAttemptId } : {}),
                detail: e.message,
            };
        }
        LOG_DIRECT_DISPATCH_TURN_OBSERVE_FAILURE(e, 'dispatch_accepted');
        return { kind: 'unavailable' };
    }
}

/**
 * P2pRelayFailureCode values (`p2p-relay-failure.ts`) that mean the worker was
 * never reached at all — as opposed to a `mesh_logic_or_provider_failure`-class
 * code, which (despite the transport-shaped name) covers an application-level
 * refusal the worker DID answer with. Used to decide `dispatch_failed.workerAbsent`
 * for a direct dispatch the same way the queue-claim path's message-text sniff
 * does (mesh-queue-dispatch.ts `handleDispatchFailure`), but on the STRUCTURED
 * code `sendDirectAgentTask` already classifies rather than re-parsing prose.
 */
export const P2P_TRANSPORT_ABSENCE_CODES: ReadonlySet<string> = new Set([
    'p2p_unavailable', 'p2p_timeout', 'p2p_not_connected', 'p2p_datachannel_closed', 'p2p_no_route', 'p2p_daemon_offline',
]);

/**
 * C-W6c: record a `delivered` or `dispatch_failed` evidence for a direct
 * dispatch's attempt (best-effort — see openDirectDispatchAttempt's note).
 * Called AFTER the transport actually confirmed/refused the send, exactly
 * the causal stage the legacy `recordTurnAck({kind:'delivered'})` used to
 * attest to.
 */
export async function observeDirectDispatchOutcome(
    ctx: MeshContext,
    attemptRef: { attemptId: string; generation: number } | null,
    opts: { taskId: string; sessionId: string }
        & ({ outcome: 'delivered'; via: 'local' | 'p2p' }
            | {
                outcome: 'dispatch_failed'; workerAbsent: boolean;
                /**
                 * Live-gap fix (2026-09-25): a worker refusal (`{success:false, code, error}`,
                 * unwrapped via `unwrapMeshRelayResult` at the call site) previously collapsed
                 * to `{workerAbsent:false, reason:'rejected_by_worker'}` with nothing else — the
                 * coordinator could see THAT the worker refused but never WHY. `refusalCode` is
                 * the worker's own short code (sanitized — see `sanitizeRefusalCode`); `nodeId`
                 * + `refusalDetail` are for the LOCAL WARN line only (never sent as evidence —
                 * evidence is content-free by construction, see turn-evidence.ts).
                 */
                refusalCode?: string; refusalDetail?: string; nodeId?: string;
            }),
): Promise<void> {
    if (!attemptRef) return;
    try {
        if (opts.outcome === 'delivered') {
            await turnObserve(ctx.transport, {
                evidence: {
                    eventId: `${opts.taskId}:delivered`,
                    at: Date.now(),
                    source: 'dispatch',
                    sessionId: opts.sessionId,
                    attemptRef,
                    observedBy: ctx.localDaemonId ?? 'mcp-server',
                    kind: 'delivered',
                    messageId: opts.taskId,
                    outcome: 'delivered',
                    via: opts.via,
                },
            });
        } else {
            const refusalCode = opts.workerAbsent ? undefined : sanitizeRefusalCode(opts.refusalCode);
            await turnObserve(ctx.transport, {
                evidence: {
                    eventId: `${opts.taskId}:dispatch_failed`,
                    at: Date.now(),
                    source: 'dispatch',
                    sessionId: opts.sessionId,
                    attemptRef,
                    observedBy: ctx.localDaemonId ?? 'mcp-server',
                    kind: 'dispatch_failed',
                    workerAbsent: opts.workerAbsent,
                    reason: 'rejected_by_worker',
                    ...(refusalCode ? { refusalCode } : {}),
                },
            });
            // (4) one WARN line on the owner, local-only — never in the replicated
            // evidence above. Detail text is exactly what the transport/worker
            // answer already carried into the JSON response returned to the
            // coordinator (see the call site); logging it here just makes it
            // visible in the owner daemon's own operator-facing log too.
            if (!opts.workerAbsent) {
                process.stderr.write(
                    `[adhdev-mesh] dispatch to ${opts.nodeId ?? 'unknown-node'} refused by worker: `
                    + `${refusalCode ?? opts.refusalCode ?? 'unknown'}`
                    + (opts.refusalDetail ? ` — ${opts.refusalDetail}` : '')
                    + '\n',
                );
            }
        }
    } catch (e) {
        LOG_DIRECT_DISPATCH_TURN_OBSERVE_FAILURE(e, opts.outcome);
    }
}

/** Best-effort diagnostic — never thrown, matches the file's existing `/* best-effort *\/` convention. */
function LOG_DIRECT_DISPATCH_TURN_OBSERVE_FAILURE(e: unknown, stage: string): void {
    const detail = e instanceof TurnIpcCommandError ? `${e.code}: ${e.message}` : String((e as Error)?.message ?? e);
    process.stderr.write(`[adhdev-mesh] direct-dispatch turnObserve(${stage}) failed (best-effort, dispatch continues): ${detail}\n`);
}
