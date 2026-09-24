/**
 * RF-ROUTER HIGH family — mesh coordinator-event relay + interactive prompt.
 *
 * mesh_forward_event (a worker event reported in-process / by command — it takes
 * the same evidence / notice path as a local provider event), get_pending_mesh_events
 * (the MCP-only coordinator inbox: undelivered own `turn.notify` notices of this
 * daemon, rendered and claimed — wiring-unification C2), and
 * interactive_prompt_response (deliver a prompt reply to a running instance).
 */
import { handleMeshForwardEvent } from '../../mesh/mesh-events.js';
import { meshNoticeRuntime } from '../../mesh/turn-ledger/deliver.js';
import { normalizeInteractivePromptResponse } from '../../providers/types/interactive-prompt.js';
import type { HighFamilyContext, HighFamilyHandler } from './types.js';
import { defineCommandSpecs } from '../command-registry.js';
import { componentsNotReadyResult, isDaemonComponentsNotReady } from '../daemon-components-port.js';

export const meshEventsHandlers: Record<string, HighFamilyHandler> = {
    mesh_forward_event: async (ctx: HighFamilyContext, args: any) => {
        // WORKTREE-BOOTSTRAP-COORD-STATE: a forwarded worktree_bootstrap_complete/_failed
        // stamps the terminal bootstrap state into the coordinator's inline mesh view
        // and re-fires the queue (which reads getCachedInlineMesh) — both router
        // methods are bound here because the handler only has `ctx.deps`.
        // The REAL components (S7-attached): a relayed agent:ready / generating_completed
        // claims through tryAssignQueueTask, which needs the turn ledger a hand-built
        // `{ instanceManager, router }` shim never had (rc.39 ledger-less claim class).
        let components;
        try {
            components = ctx.components();
        } catch (e) {
            if (isDaemonComponentsNotReady(e)) return componentsNotReadyResult(e);
            throw e;
        }
        const result = handleMeshForwardEvent(components, args as Record<string, unknown>);
        return { ...result };
    },

    /**
     * The MCP-only coordinator inbox (C2). Returns the undelivered own
     * `turn.notify` notices addressed to this daemon, rendered, and CLAIMS them
     * (`delivered:<writer>:<seq>`) so the `turn.deliver` cursor passes them
     * without submitting. Field name `pendingCoordinatorEvents` on the MCP side
     * is unchanged (C2 naming decision).
     *
     * A daemon that hosts an injectable CLI coordinator for the mesh leaves the
     * notices to the cursor — unless the caller IS that coordinator reading its
     * own inbox (`selfCoordinatorInboxRead`), in which case surfacing them in the
     * tool result is lossless and faster than waiting for its idle edge.
     * A read addressed to another coordinator daemon (the pre-C remote pull)
     * returns nothing: cross-machine notices travel by topic replication.
     */
    get_pending_mesh_events: async (ctx: HighFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        const runtime = meshNoticeRuntime.current();
        if (!meshId || !runtime) {
            return { success: true, events: [], hasLiveCliCoordinator: false, source: 'turn.notify', ...(runtime ? {} : { unavailable: 'turn ledger not booted' }) };
        }
        const selfCoordinatorInboxRead = args?.selfCoordinatorInboxRead === true;
        const coordinatorDaemonId = typeof args?.coordinatorDaemonId === 'string' && args.coordinatorDaemonId.trim()
            ? args.coordinatorDaemonId.trim()
            : '';
        const hasLiveCliCoordinator = runtime.hasLiveCliCoordinator(meshId);
        const addressedElsewhere = coordinatorDaemonId !== '' && !runtime.isSelfDaemon(coordinatorDaemonId);
        if (addressedElsewhere || (hasLiveCliCoordinator && !selfCoordinatorInboxRead)) {
            return {
                success: true,
                events: [],
                hasLiveCliCoordinator,
                source: 'turn.notify',
                ...(addressedElsewhere ? { replicatedNotAddressed: true } : { deliveredByCursor: true }),
            };
        }
        const ack = args?.ack !== false;
        const events = runtime.readNotices(meshId, {
            ack,
            ...(typeof args?.sessionId === 'string' && args.sessionId.trim() ? { surfacedSessionId: args.sessionId.trim() } : {}),
        });
        return {
            success: true,
            events,
            hasLiveCliCoordinator,
            // The notices were surfaced through THIS tool result (and claimed): the
            // MCP client must not re-forward them.
            surfacedForSelfCoordinator: true,
            source: 'turn.notify',
            ...(runtime.replicationPending(meshId) ? { replication: 'pending' as const } : {}),
        };
    },

    interactive_prompt_response: async (ctx: HighFamilyContext, args: any) => {
        const sessionId = typeof args?.targetSessionId === 'string' && args.targetSessionId.trim()
            ? args.targetSessionId.trim()
            : typeof args?.sessionId === 'string' && args.sessionId.trim()
                ? args.sessionId.trim()
                : '';
        if (!sessionId) return { success: false, error: 'targetSessionId required' };
        const rawResponse = args?.response ?? args;
        const instance = ctx.deps.instanceManager.getInstance(sessionId);
        if (!instance) return { success: false, error: `No running instance for session ${sessionId}` };
        // mesh_answer_question (mission f1d25e11) sends a coordinator-friendly answer array
        // that is resolved against the AUTHORITATIVE active prompt inside the instance
        // (resolveInteractivePromptResponse). Forward that shape RAW. The legacy strict
        // (questionId-keyed) form is still validated here so a malformed dashboard-local
        // answer is rejected before it reaches the instance.
        const isFriendlyArrayForm = rawResponse
            && typeof rawResponse === 'object'
            && Array.isArray((rawResponse as { answers?: unknown }).answers);
        const payload = isFriendlyArrayForm
            ? rawResponse
            : normalizeInteractivePromptResponse(rawResponse);
        // STALE-PROMPT-ANSWER guard (rc.20 rebind option fidelity): when the session
        // HOLDS a prompt, an answer naming a different promptId (e.g. the pre-restart
        // id the coordinator still carries after a daemon rebind) must be rejected
        // VISIBLY. Previously this returned success:true and the mismatch surfaced
        // only as a daemon log line — the coordinator believed the question answered
        // while the picker stayed parked (or a later index-based retry bound to the
        // wrong option row). Fail closed with the active promptId so the caller can
        // re-answer against it. No answer is applied and no default/index fallback
        // is taken on this path.
        const heldPrompt = (() => {
            try {
                const state = instance.getState?.() as {
                    activeInteractivePrompt?: { promptId?: unknown } | null;
                    activeChat?: { activeInteractivePrompt?: { promptId?: unknown } | null };
                } | undefined;
                return state?.activeChat?.activeInteractivePrompt ?? state?.activeInteractivePrompt ?? null;
            } catch {
                return null;
            }
        })();
        const heldPromptId = typeof heldPrompt?.promptId === 'string' && heldPrompt.promptId.trim()
            ? heldPrompt.promptId.trim()
            : '';
        const incomingPromptId = typeof (payload as { promptId?: unknown })?.promptId === 'string'
            ? ((payload as { promptId: string }).promptId).trim()
            : '';
        if (heldPromptId && incomingPromptId && incomingPromptId !== heldPromptId) {
            return {
                success: false,
                error: `Stale promptId "${incomingPromptId}" — the session's active question is "${heldPromptId}". The answer was NOT applied; re-answer with mesh_answer_question against the active promptId.`,
                waitingChoice: true,
                promptId: heldPromptId,
                stalePromptId: incomingPromptId,
            };
        }
        // SILENT-SUCCESS DEFECT (2026-08-20 live): this used to be
        // `sendEvent(...); return { success: true }`. sendEvent is
        // fire-and-forget (returns void), so success was reported BEFORE the
        // answer was resolved against the held prompt and before a single key
        // reached the PTY. Every downstream failure — an unknown option label
        // (resolveInteractivePromptResponse throws), an adapter with no answer
        // support, a provider scheme with no answer path, a rejected key
        // injection — was caught and logged only. The coordinator, trusting
        // `success: true`, moved on while the picker stayed parked
        // (`awaiting_choice` for ~5 minutes, until the owner noticed).
        //
        // Prefer the awaitable path when the instance exposes it: it resolves
        // labels/indexes against the AUTHORITATIVE held prompt and awaits the
        // key injection, so a failure is a real error with the live option list
        // attached. Instances that predate it fall back to the legacy
        // fire-and-forget event, which is reported honestly as un-verified.
        const applyAnswer = (instance as unknown as {
            applyInteractivePromptResponse?: (data: unknown) => Promise<{ promptId: string; answers: Record<string, unknown> }>;
        }).applyInteractivePromptResponse;
        if (typeof applyAnswer !== 'function') {
            ctx.deps.instanceManager.sendEvent(sessionId, 'interactive_prompt_response', payload);
            return {
                success: true,
                delivered: true,
                submitted: false,
                note: 'Answer was FORWARDED to the session but delivery could not be verified on this provider instance (legacy path). Confirm the session left awaiting_choice before treating the question as answered.',
            };
        }
        try {
            const applied = await applyAnswer.call(instance, payload);
            // Honest contract: the keystrokes were dispatched to the PTY and
            // the held prompt was cleared. We do NOT claim the TUI redrew and
            // committed — that is only observable on a later status tick.
            return {
                success: true,
                delivered: true,
                submitted: true,
                promptId: applied.promptId,
                answers: applied.answers,
                note: 'Answer resolved against the active prompt and the submit keystrokes were dispatched to the TUI. Verify the session left awaiting_choice on the next status read.',
            };
        } catch (e: any) {
            const describeActive = (instance as unknown as {
                describeActiveInteractivePrompt?: () => unknown;
            }).describeActiveInteractivePrompt;
            const active = typeof describeActive === 'function' ? describeActive.call(instance) : null;
            const errorMessage = e?.message || String(e);
            // SCREEN-MISMATCH RETRY LOOP (live defect, 2026-09-18): "focused
            // question does not match" / "review page does not match" mean the
            // TUI on screen isn't the page the answer was built against — a
            // parse/timing mismatch, not a bad label or index. The old advice
            // ("re-answer using a label or 1-based index") sent the caller
            // straight back into the SAME rejected answer every time, since
            // the label/index was never the problem — an infinite loop with no
            // recovery but abandoning the task. Re-reading status lets the
            // caller see the actual on-screen question before retrying instead
            // of blindly repeating a call that is guaranteed to fail the same
            // way.
            const isScreenMismatch = /does not match the active interactive prompt/.test(errorMessage);
            return {
                success: false,
                delivered: false,
                submitted: false,
                error: errorMessage,
                ...(active ? { activePrompt: active, waitingChoice: true } : {}),
                nextStep: isScreenMismatch
                    ? 'The on-screen question did not match what mesh_answer_question expected — retrying the same label/index will fail identically. Re-read the session status to see the CURRENT on-screen question, then re-answer only if it still matches activePrompt.'
                    : active
                        ? 'The question is STILL open. Re-answer with mesh_answer_question using a label or 1-based index from activePrompt.questions[].options.'
                        : 'The question was not answered. Re-read the session status to see whether a prompt is still open.',
            };
        }
    },
};

export const meshEventsSpecs = defineCommandSpecs('high', meshEventsHandlers, {
    // mesh_answer_question (mission f1d25e11): the answer must reach the OWNING worker
    // session's live instance — its activeInteractivePrompt and adapter live only there.
    interactive_prompt_response: { forwardToOwner: true, fastFlush: true, meshSender: 'session_coordinator' },
    // A worker daemon's event about its own node: the sender must own the node the
    // payload names on this daemon's roster (nodeId / workspace are claims).
    mesh_forward_event: { meshSender: 'node_owner' },
}, { meshSender: 'authenticated_peer' });
