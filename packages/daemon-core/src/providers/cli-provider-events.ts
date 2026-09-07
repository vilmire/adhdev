/**
 * Provider event emission + provider-response application (verbatim move out of
 * CliProviderInstance — M-FILE-SIZE-DEBT decomposition).
 *
 * Two related write paths:
 *   - pushEvent — enriches every outbound ProviderEvent with this session's
 *     identity (instance/target/provider/workspace/session) and, for a mesh
 *     worker, the task routing identity (taskId, dispatchNonce, attemptId);
 *     then emits via the context or buffers it. It also owns the terminal-event
 *     auto-detach of a direct-dispatch mesh assignment.
 *   - applyProviderResponse — folds a script-parsed provider response (session
 *     id, control values, summary metadata, declarative effects) into instance
 *     state, deduping effects by key.
 *
 * State lives ON THE HOST (the provider instance) exactly as before. Provenance
 * kept inline: TASKIDLESS taskId stamping, ARCH-REFACTOR R1 per-turn identity
 * resolution order, REDRIVE-DUP nonce echo, TURN-LEDGER Stage 5 attempt echo,
 * and the RESTART-REBOUND agent:ready detach guard.
 */

import type { ProviderEvent, InstanceContext } from './provider-instance.js';
import type { ChatMessage } from '../types.js';
import type { ProviderModule } from './contracts.js';
import { normalizeProviderSessionId } from './provider-session-id.js';
import { mergeProviderPatchState } from './provider-patch-state.js';
import { buildPersistedProviderEffectMessage, normalizeProviderEffects } from './control-effects.js';
import { getEffectDedupKey } from './cli-provider-effect-format.js';
import { type PersistableCliHistoryMessage } from './cli-provider-history-dedup.js';
import { TERMINAL_MESH_EVENTS } from './cli-provider-instance-types.js';
import type { CompletedDebouncePending } from './cli-provider-instance-types.js';

/** The narrow surface of CliProviderInstance the event path reads/writes. */
export interface ProviderEventsHost {
type: string;
workingDir: string;
instanceId: string;
provider: ProviderModule;
providerSessionId?: string;
settings: Record<string, any>;
context: InstanceContext | null;
events: ProviderEvent[];
adapter: Record<string, any>;
appliedEffectKeys: Set<string>;
controlValues: Record<string, string | number | boolean>;
summaryMetadata: unknown;
suppressIdleHistoryReplay: boolean;
runtimeMessages: Array<{ key: string; message: ChatMessage }>;
lastPersistedHistoryMessages: PersistableCliHistoryMessage[];
generatingStartedAt: number;
completedDebouncePending: CompletedDebouncePending | null;
generatingDebouncePending: { chatTitle: string; timestamp: number } | null;
isMeshWorkerSession(): boolean;
completingTurnTaskId(): string | undefined;
detachMeshAssignment(): void;
promoteProviderSessionId(sessionId: string, opts?: { authoritative?: boolean }): void;
appendRuntimeMessage(message: ChatMessage, dedupKey: string): void;
pushEvent(event: ProviderEvent): void;
}

export function pushEvent(host: ProviderEventsHost, event: ProviderEvent): void {
    const enrichedEvent: ProviderEvent = {
        ...event,
        instanceId: typeof event.instanceId === 'string' && event.instanceId.trim()
            ? event.instanceId
            : host.instanceId,
        targetSessionId: typeof event.targetSessionId === 'string' && event.targetSessionId.trim()
            ? event.targetSessionId
            : host.instanceId,
        providerType: typeof event.providerType === 'string' && event.providerType.trim()
            ? event.providerType
            : host.type,
        workspaceName: typeof event.workspaceName === 'string' && event.workspaceName.trim()
            ? event.workspaceName
            : host.workingDir,
        // Carry the workspace under BOTH `workspace` and `workspaceName` so the
        // downstream mesh forward/merge path — which reads `workspace` — can
        // propagate it to the coordinator snapshot. Without `workspace` the live
        // event path delivers an empty workspace and the dashboard falls back to
        // the generic "Terminal (Mesh Node)" title.
        workspace: typeof event.workspace === 'string' && event.workspace.trim()
            ? event.workspace
            : host.workingDir,
        providerSessionId: typeof event.providerSessionId === 'string' && event.providerSessionId.trim()
            ? event.providerSessionId
            : host.providerSessionId,
    };
    // TASKIDLESS: stamp the mesh task primary key on lifecycle events emitted by
    // a mesh worker session. The consumer (updateDirectDispatchStatus) was switched
    // to key on task_id (CANON-B), but the producer never carried it — so every
    // forwarded metadataEvent.taskId arrived undefined and the coordinator fell back
    // to a session_id match, which can flip a sibling dispatch row. Surface it here so
    // updateDirectDispatchStatus hits the exact PK row and the session_id fallback is
    // never exercised. Non-mesh sessions get no taskId (regression guard) —
    // isMeshWorkerSession() gates the injection.
    //
    // ARCH-REFACTOR R1 (per-turn identity): resolution order is
    //   (1) an explicit taskId already on the event — the debounce-flush completion
    //       path stamps the taskId captured at the generating→idle transition (the
    //       turn that actually produced this completion);
    //   (2) the per-turn binding (engine.currentTurnTaskId) for synchronously-emitted
    //       events whose turn is still the current one;
    //   (3) the legacy session scalar (settings.meshActiveTaskId) as a last-resort
    //       backward-compat alias.
    // The scalar is last because it is last-write-wins: a second task attaching while
    // this turn was still running overwrites it, which is the exact NOTIF-MISDELIVER /
    // TASK-MSG-MISROUTE race this refactor removes.
    if (host.isMeshWorkerSession()) {
        const existingTaskId = typeof enrichedEvent.taskId === 'string' && enrichedEvent.taskId.trim()
            ? enrichedEvent.taskId
            : undefined;
        if (!existingTaskId) {
            const resolved = host.completingTurnTaskId();
            if (resolved) enrichedEvent.taskId = resolved;
        }
        // REDRIVE-DUP: echo the dispatch nonce this session's active task was stamped with
        // so the coordinator's generating_started handler can reject a stale (reclaimed)
        // dispatch and stop this worker before it double-executes the reclaimed task.
        if (enrichedEvent.dispatchNonce === undefined && typeof host.settings.meshActiveDispatchNonce === 'number') {
            enrichedEvent.dispatchNonce = host.settings.meshActiveDispatchNonce;
        }
        // TURN-LEDGER (Stage 5): echo the attempt identity alongside the nonce so the
        // coordinator's reducer correlates this event to (taskId, attemptId, session).
        if (enrichedEvent.attemptId === undefined && typeof host.settings.meshActiveAttemptId === 'string' && host.settings.meshActiveAttemptId) {
            enrichedEvent.attemptId = host.settings.meshActiveAttemptId;
        }
    }
    if (host.context?.emitProviderEvent) {
        host.context.emitProviderEvent(enrichedEvent);
    } else {
        host.events.push(enrichedEvent);
    }
    // Auto-detach a direct-dispatch mesh assignment once the dispatched
    // task reaches a terminal state. Leaving meshNodeFor pinned would
    // route this session's next unrelated turn (a dashboard chat) into
    // the coordinator as if it were the completion of another task.
    // We schedule after the emit so the originating coordinator still
    // observes the completion event with its routing marker intact.
    //
    // RESTART-REBOUND agent:ready guard (post-restart completion wedge):
    // agent:ready is a queue-CLAIM signal, not task-terminal evidence — and
    // it re-fires after a daemon restart (agentReadyEmitted is per-process),
    // potentially on the SAME first-idle frame that just armed this task's
    // debounced completion. Detaching here would strip meshActiveTaskId /
    // meshActiveAttemptId / meshActiveDispatchNonce before the completion
    // flush emits, dropping the completion envelope-less. So agent:ready
    // may only detach when NO turn is in flight and NO completion is
    // pending; generating_completed / agent:stopped stay unconditional —
    // they ARE the terminal evidence. A genuine agent:ready with no active
    // task is unaffected (meshActiveTaskId falsy → no detach either way).
    if (TERMINAL_MESH_EVENTS.has(event.event) && host.settings.meshActiveTaskId) {
        const readyWithTurnInFlight = event.event === 'agent:ready'
            && (host.generatingStartedAt !== 0
                || host.completedDebouncePending !== null
                || host.generatingDebouncePending !== null);
        if (!readyWithTurnInFlight) {
            try { host.detachMeshAssignment(); } catch { /* best-effort */ }
        }
    }
}

export function flushEvents(host: ProviderEventsHost): ProviderEvent[] {
    const events = [...host.events];
    host.events = [];
    return events;
}

export function applyProviderResponse(host: ProviderEventsHost, data: any, options: { phase: 'immediate' | 'turn_completed' }): void {
    if (!data || typeof data !== 'object') return;

    const patchedProviderSessionId = normalizeProviderSessionId(
        host.provider,
        typeof data.providerSessionId === 'string' ? data.providerSessionId : '',
    );
    if (patchedProviderSessionId) {
        // A provider-response id is authoritative when it carries an
        // explicit `new_session` marker (the CLI genuinely started a new
        // conversation). Without that marker it's just an observed id and
        // must not hijack an existing binding (see promoteProviderSessionId).
        host.promoteProviderSessionId(patchedProviderSessionId, {
            authoritative: data.sessionEvent === 'new_session',
        });
    }

    if (data.sessionEvent === 'new_session') {
        host.runtimeMessages = [];
        host.lastPersistedHistoryMessages = [];
        host.suppressIdleHistoryReplay = false;
        host.adapter.clearHistory();
    }

    const patchedState = mergeProviderPatchState({
        providerControls: host.provider.controls,
        data,
        currentControlValues: host.controlValues,
        currentSummaryMetadata: host.summaryMetadata,
    });
    host.controlValues = patchedState.controlValues;
    host.summaryMetadata = patchedState.summaryMetadata;

    const effects = normalizeProviderEffects(data);
    for (const effect of effects) {
        const effectWhen = effect.when || 'immediate';
        if (effectWhen === 'turn_completed' && options.phase !== 'turn_completed') continue;
        if (effectWhen === 'immediate' && options.phase === 'turn_completed') continue;

        const effectKey = getEffectDedupKey(effect);
        if (host.appliedEffectKeys.has(effectKey)) continue;
        host.appliedEffectKeys.add(effectKey);

        if (effect.persist !== false) {
            const persistedMessage = buildPersistedProviderEffectMessage(effect);
            if (persistedMessage) host.appendRuntimeMessage(persistedMessage, effectKey);
        }

        if (effect.type === 'message' && effect.message) {
            const content = typeof effect.message.content === 'string'
                ? effect.message.content
                : JSON.stringify(effect.message.content);
            host.pushEvent({
                event: 'provider:message',
                timestamp: Date.now(),
                content,
                role: effect.message.role || 'system',
                kind: effect.message.kind,
                senderName: effect.message.senderName,
            });
        } else if (effect.type === 'toast' && effect.toast) {
            host.pushEvent({
                event: 'provider:toast',
                effectId: effect.id || effectKey,
                timestamp: Date.now(),
                message: effect.toast.message,
                level: effect.toast.level || 'info',
            });
        } else if (effect.type === 'notification' && effect.notification) {
            host.pushEvent({
                event: 'provider:notification',
                effectId: effect.id || effectKey,
                timestamp: Date.now(),
                title: effect.notification.title,
                message: effect.notification.body,
                content: typeof effect.notification.bubbleContent === 'string'
                    ? effect.notification.bubbleContent
                    : effect.notification.body,
                level: effect.notification.level || 'info',
                channels: effect.notification.channels || ['toast'],
                preferenceKey: effect.notification.preferenceKey,
            });
        }
    }

    if (host.appliedEffectKeys.size > 200) {
        host.appliedEffectKeys = new Set(Array.from(host.appliedEffectKeys).slice(-100));
    }
}
