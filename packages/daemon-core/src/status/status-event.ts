/**
 * status-event — the one projection of provider events onto the `status_event`
 * wire, shared by both hosts (wiring-unification B5, plan §3.3).
 *
 * Moved verbatim out of `DaemonStatusReporter` (status/reporter.ts), where the
 * projection was a private cloud-only method: standalone had no producer at all,
 * so a tool-approval modal never reached a standalone dashboard as an event.
 *
 * ★ CONTENT BOUNDARY (CLAUDE.md "Server content boundary" + "Push notification
 * exception"). `projectServerStatusEvent` is an ALLOW-LIST: it builds a fresh
 * object field by field and drops every `provider:*` event wholesale. The only
 * agent-authored text it carries is `modalMessage` / `modalButtons` — the
 * approval-push exception, already decided. Never rewrite it as a spread plus
 * deletes. `projectP2PStatusEvent` extends the server copy with the structured
 * AskUserQuestion payload, which is P2P / local only and must never reach the
 * server-bound object.
 *
 * `createStatusEventEmitter` subscribes to the bus's transitional
 * `provider_event` and hands each projection to the host's transport: cloud
 * sends the P2P copy over the DataChannel and the server copy over its WS;
 * standalone broadcasts the P2P copy over its dashboard WS and has no server leg.
 */

import { LOG } from '../logging/logger.js';
import type { DaemonStatusEventPayload, P2PStatusEventPayload } from '../shared-types.js';
import type { ProviderState } from '../providers/provider-instance.js';
import type { SessionLifecycleBus, Unsubscribe } from '../sessions/lifecycle-bus.js';
import { resolveMuted, resolveSurfaceHidden } from './builders.js';

export type StatusEventHideMute = { surfaceHidden: boolean; muted: boolean };
export type ResolveStatusEventHideMute = (sessionId: string) => StatusEventHideMute | undefined;

/** The event names the server accepts on `status_event`; anything else is dropped. */
export function toDaemonStatusEventName(value: unknown): DaemonStatusEventPayload['event'] | null {
    switch (value) {
        case 'agent:generating_started':
        case 'agent:waiting_approval':
        case 'agent:waiting_choice':
        case 'agent:generating_completed':
        case 'agent:stopped':
        case 'monitor:no_progress':
            return value;
        default:
            return null;
    }
}

/**
 * Resolve the target session's dashboard visibility at event time, straight
 * from the live provider instance's `settings` — the same source of truth
 * `buildSessionEntries` uses for the snapshot path (builders.ts), so an event
 * and a snapshot emitted for the same session always agree.
 *
 * Returns undefined when the session has no local instance (a genuinely remote
 * mesh worker hosted by a different daemon, or an event with no targetSessionId).
 * The event then omits the flags and the server falls back to its snapshot join.
 */
export function createInstanceHideMuteResolver(
    instanceManager: { getInstance?(sessionId: string): { getState?(): ProviderState | undefined } | undefined } | null | undefined,
): ResolveStatusEventHideMute {
    return (sessionId) => {
        if (!sessionId) return undefined;
        const getInstance = instanceManager?.getInstance;
        if (typeof getInstance !== 'function') return undefined;
        let state: ProviderState | undefined;
        try {
            state = getInstance.call(instanceManager, sessionId)?.getState?.();
        } catch {
            return undefined;
        }
        const settings = (state as { settings?: Record<string, any> } | undefined)?.settings;
        if (!settings) return undefined;
        return {
            surfaceHidden: resolveSurfaceHidden(settings),
            // Status-gated exactly as builders.ts does: pass the session's live status so a
            // one-shot silent-idle arm mutes only the idle/completion frame and never an
            // approval/choice frame in the same turn.
            muted: resolveMuted(settings, (state as { status?: string } | undefined)?.status),
        };
    };
}

/**
 * Server-bound projection. Allow-list: every field is copied individually and
 * type-checked; `provider:*` events are dropped whole (arbitrary text).
 */
export function projectServerStatusEvent(
    event: Record<string, unknown>,
    resolveHideMute?: ResolveStatusEventHideMute,
): DaemonStatusEventPayload | null {
    const eventName = toDaemonStatusEventName(event.event);
    if (!eventName) return null;

    // Provider UI effects can carry arbitrary text content and are not required
    // for server-side routing, push, or dashboard session targeting.
    if (eventName.startsWith('provider:')) {
        return null;
    }

    const payload: DaemonStatusEventPayload = {
        event: eventName,
        timestamp: typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
            ? event.timestamp
            : Date.now(),
    };

    if (typeof event.targetSessionId === 'string' && event.targetSessionId.trim()) {
        payload.targetSessionId = event.targetSessionId.trim();
    }
    const providerType = typeof event.providerType === 'string' && event.providerType.trim()
        ? event.providerType.trim()
        : (typeof event.ideType === 'string' && event.ideType.trim() ? event.ideType.trim() : '');
    if (providerType) {
        payload.providerType = providerType;
    }
    if (typeof event.providerSessionId === 'string' && event.providerSessionId.trim()) {
        payload.providerSessionId = event.providerSessionId.trim();
    }
    if (typeof event.workspaceName === 'string' && event.workspaceName.trim()) {
        payload.workspaceName = event.workspaceName.trim();
    }
    if (typeof event.duration === 'number' && Number.isFinite(event.duration)) {
        payload.duration = event.duration;
    }
    if (typeof event.elapsedSec === 'number' && Number.isFinite(event.elapsedSec)) {
        payload.elapsedSec = event.elapsedSec;
    }
    if (typeof event.modalMessage === 'string' && event.modalMessage.trim()) {
        payload.modalMessage = event.modalMessage;
    }
    if (Array.isArray(event.modalButtons)) {
        const modalButtons = event.modalButtons
            .filter((button): button is string => typeof button === 'string' && button.trim().length > 0);
        if (modalButtons.length > 0) {
            payload.modalButtons = modalButtons;
        }
    }

    // Stamp the target session's visibility so the server's push-suppression
    // gate does not have to join against a snapshot that may not have arrived
    // yet. Booleans only — no content. See DaemonStatusEventPayload.
    if (payload.targetSessionId && resolveHideMute) {
        const hideMute = resolveHideMute(payload.targetSessionId);
        if (hideMute) {
            payload.surfaceHidden = hideMute.surfaceHidden;
            payload.muted = hideMute.muted;
        }
    }

    return payload;
}

/**
 * Enrich the dashboard copy with the structured AskUserQuestion payload. The
 * dashboard hydrates `activeInteractivePrompt` from these fields (web-core
 * EventManager.hydrateInteractivePromptFromEvent) so the STRUCTURED picker
 * renders even when the rich status sync is degraded.
 *
 * Dashboard-only by design: `interactivePrompt` is agent-authored free text, so
 * it must NOT join the server-bound payload built above.
 */
export function projectP2PStatusEvent(rawEvent: Record<string, unknown>, serverEvent: DaemonStatusEventPayload): P2PStatusEventPayload {
    const payload: P2PStatusEventPayload = { ...serverEvent };
    if (rawEvent.interactivePrompt && typeof rawEvent.interactivePrompt === 'object' && !Array.isArray(rawEvent.interactivePrompt)) {
        payload.interactivePrompt = rawEvent.interactivePrompt as P2PStatusEventPayload['interactivePrompt'];
    }
    if (typeof rawEvent.promptId === 'string' && rawEvent.promptId.trim()) {
        payload.promptId = rawEvent.promptId.trim();
    }
    if (rawEvent.multiSelect === true) {
        payload.multiSelect = true;
    }
    return payload;
}

export interface StatusEventEmitterDeps {
    /** Live instance lookup for the hide/mute stamp. */
    instanceManager?: { getInstance?(sessionId: string): { getState?(): ProviderState | undefined } | undefined } | null;
    /** Dashboard delivery: cloud P2P DataChannel, standalone WS broadcast. */
    sendDashboard(payload: P2PStatusEventPayload): void;
    /** Server delivery (push / webhook / audit). Cloud only; standalone has no server leg. */
    sendServer?(payload: DaemonStatusEventPayload): void;
}

/**
 * Subscribe the status-event projection to the bus. Returns the unsubscribe.
 * Each delivery leg runs in its own try/catch so a dead transport on one side
 * never swallows the other.
 */
export function createStatusEventEmitter(bus: Pick<SessionLifecycleBus, 'on'>, deps: StatusEventEmitterDeps): Unsubscribe {
    const resolveHideMute = createInstanceHideMuteResolver(deps.instanceManager);
    return bus.on('provider_event', (e) => {
        const raw = e.event as unknown as Record<string, unknown>;
        const serverEvent = projectServerStatusEvent(raw, resolveHideMute);
        if (!serverEvent) return;
        LOG.debug('StatusEvent', `${String(raw.event)} (${String(raw.providerType || raw.ideType || '')})`);
        try {
            deps.sendDashboard(projectP2PStatusEvent(raw, serverEvent));
        } catch (error) {
            LOG.warn('StatusEvent', `dashboard delivery failed: ${(error as Error)?.message ?? error}`);
        }
        if (deps.sendServer) {
            try {
                deps.sendServer(serverEvent);
            } catch (error) {
                LOG.warn('StatusEvent', `server delivery failed: ${(error as Error)?.message ?? error}`);
            }
        }
    }, { name: 'host.status-event' });
}
