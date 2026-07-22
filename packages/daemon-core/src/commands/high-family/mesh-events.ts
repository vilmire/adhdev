/**
 * RF-ROUTER HIGH family — mesh coordinator-event relay + interactive prompt.
 *
 * mesh_forward_event (relay a worker event to the local instance manager),
 * get_pending_mesh_events (drain queued coordinator events, optionally scoped to
 * a coordinator daemon), and interactive_prompt_response (deliver a prompt reply
 * to a running instance). Extracted verbatim from executeDaemonCommand — only
 * `this.deps` became `ctx.deps`.
 */
import {
    handleMeshForwardEvent,
    drainPendingMeshCoordinatorEvents,
    shouldHoldPendingDrainForBusyLocalCoordinator,
    resolveCoordinatorDrainDeliverability,
    getMeshV2DrainCounters,
    getMeshV2BackstopCounters,
    isMeshProtocolV2EnforceEnabled,
} from '../../mesh/mesh-events.js';
import { normalizeInteractivePromptResponse } from '../../providers/types/interactive-prompt.js';
import type { HighFamilyContext, HighFamilyHandler } from './types.js';

export const meshEventsHandlers: Record<string, HighFamilyHandler> = {
    mesh_forward_event: async (ctx: HighFamilyContext, args: any) => {
        return handleMeshForwardEvent({ instanceManager: ctx.deps.instanceManager } as any, args as Record<string, unknown>);
    },

    get_pending_mesh_events: async (ctx: HighFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        // (B3) Respect coordinatorDaemonId when the caller declares it
        // so unicast events route to the right coordinator instead of
        // being silently consumed by the first drainer.
        const coordinatorDaemonId = typeof args?.coordinatorDaemonId === 'string' && args.coordinatorDaemonId.trim()
            ? args.coordinatorDaemonId.trim()
            : undefined;
        // SELF-COORDINATOR INBOX LEVEL-DRAIN (Defect 2): the MCP self-coordinator inbox read
        // (drainCoordinatorPendingEvents) sets this so its own drain is not held while its CLI
        // is busy — the events return in ITS tool result (a lossless data-queue surface), never
        // a PTY inject. Every other drain leaves it unset and keeps the busy-coordinator hold.
        const selfCoordinatorInboxRead = args?.selfCoordinatorInboxRead === true;
        // DRAIN-WITHOUT-INJECT guard: when a LOCAL live CLI coordinator for this mesh is
        // busy (generating / modal-parked), the reconcile loop is HOLDING its terminal
        // events (drained=0) for the coordinator's next idle tick. Draining here would
        // consume those held rows (drained=1) into an MCP tool result the busy coordinator
        // never surfaces as a turn — losing the completion forever. Defer to the reconcile
        // loop: return nothing, leaving the rows undrained for its idle-tick delivery. A
        // remote pull (foreign coordinatorDaemonId) or a pure stdio MCP coordinator (no live
        // CLI session) is NOT held — see shouldHoldPendingDrainForBusyLocalCoordinator.
        // Surface whether THIS daemon has a live CLI coordinator for the mesh. The MCP
        // (LLM) coordinator's pull (drainCoordinatorPendingEvents) needs this to decide its
        // delivery surface: when there is NO live CLI coordinator (pure stdio MCP/LLM), the
        // MCP tool result is the ONLY surface, so the puller must return the drained events
        // to the LLM rather than re-forwarding them (a re-forward just re-queues with no PTY
        // to inject into — the NOTIF-DROP transcript-reconcile drain-without-inject loop).
        // When a live CLI coordinator exists, the reconcile loop owns PTY delivery and the
        // puller keeps forwarding (unchanged). NOTE: this is observational only — it does not
        // change what is drained here, so the idle full-drain and remote-pull paths are intact.
        const hasLiveCliCoordinator = meshId
            ? resolveCoordinatorDrainDeliverability(ctx.deps, meshId).hasLiveCliCoordinator
            : false;
        // DRAIN-WITHOUT-INJECT guard: when a LOCAL live CLI coordinator for this mesh is
        // busy (generating / modal-parked), the reconcile loop is HOLDING its terminal
        // events (drained=0) for the coordinator's next idle tick. Draining here would
        // consume those held rows (drained=1) into an MCP tool result the busy coordinator
        // never surfaces as a turn — losing the completion forever. Defer to the reconcile
        // loop: return nothing, leaving the rows undrained for its idle-tick delivery. A
        // remote pull (foreign coordinatorDaemonId) or a pure stdio MCP coordinator (no live
        // CLI session) is NOT held — see shouldHoldPendingDrainForBusyLocalCoordinator.
        if (meshId && shouldHoldPendingDrainForBusyLocalCoordinator(ctx.deps, meshId, coordinatorDaemonId, selfCoordinatorInboxRead)) {
            return { success: true, events: [], heldForBusyLocalCoordinator: true, hasLiveCliCoordinator };
        }
        const events = drainPendingMeshCoordinatorEvents(meshId || undefined, coordinatorDaemonId);
        // T6 (B3c): ride the live v2 enforce/backstop counters on the drain response so a
        // pure stdio MCP coordinator (which reads its inbox via this IPC call, not the
        // daemon-core mesh_status command) sees the same enforce state + quarantine /
        // last-resort-backstop tallies. Process-lifetime snapshot; the counters were just
        // updated by the drain above. Additive — omitting it keeps version-skewed pullers safe.
        const meshProtocolV2Counters = {
            enforce: isMeshProtocolV2EnforceEnabled(),
            drain: { ...getMeshV2DrainCounters() },
            backstop: { ...getMeshV2BackstopCounters() },
        };
        // SELF-COORDINATOR INBOX LEVEL-DRAIN: when the busy local coordinator drained its OWN
        // inbox (selfCoordinatorInboxRead), tell the puller these events were surfaced through
        // the caller's tool result — it must NOT re-forward them into the (busy) PTY (that is the
        // lossy path). Absent the flag, delivery is unchanged (reconcile-owned PTY / remote pull).
        return { success: true, events, hasLiveCliCoordinator, meshProtocolV2Counters, ...(selfCoordinatorInboxRead ? { surfacedForSelfCoordinator: true } : {}) };
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
        ctx.deps.instanceManager.sendEvent(sessionId, 'interactive_prompt_response', payload);
        return { success: true };
    },
};
