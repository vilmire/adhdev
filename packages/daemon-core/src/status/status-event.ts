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
import { TURN_WIRE_EVENT_NAMES, projectTurnWireEvent, type TurnWireEvent } from '../mesh/turn-ledger/bus-projection.js';
import type { TurnBusEvent } from '../mesh/turn-ledger/types.js';

/** The two wire names `turn-ledger/bus-projection.ts` now solely produces from a
 *  committed turn (wiring-unification C1/C5). A `provider_event` still carrying
 *  one of these is the legacy completion emission the C-W5 follow-up retires from
 *  the wire, kept around only because `mesh-event-forwarding.ts` and quota refresh
 *  have not yet fully migrated off the provider bus (see the two callers' own
 *  comments) — `projectServerStatusEvent` must not double-push it. */
const TURN_SOURCED_WIRE_NAMES: ReadonlySet<string> = new Set(TURN_WIRE_EVENT_NAMES);

export type StatusEventHideMute = { surfaceHidden: boolean; muted: boolean };
export type ResolveStatusEventHideMute = (sessionId: string) => StatusEventHideMute | undefined;

/**
 * Non-content session identity stamped onto a turn-sourced `status_event`
 * (`agent:generating_completed` / `agent:stopped`). These are the fields the
 * pre-C-W5c `provider_event` completion carried after each instance's
 * `pushEvent` enrichment (cli-provider-events.ts `pushEvent`,
 * acp/ide/extension-provider-instance.ts `pushEvent`): the provider type, the
 * provider-native session id, and the instance's workspace. Identifiers only —
 * never chat content.
 */
export type StatusEventSessionMeta = { providerType?: string; providerSessionId?: string; workspaceName?: string };
export type ResolveStatusEventSessionMeta = (sessionId: string) => StatusEventSessionMeta | undefined;

type StatusEventInstanceManager = {
    getInstance?(sessionId: string): { getState?(): ProviderState | undefined } | undefined;
} | null | undefined;
type StatusEventSessionRegistry = {
    get(sessionId: string): { parentSessionId?: string | null } | undefined;
} | null | undefined;

function nonEmpty(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

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
 * Resolve the non-content identity of the session a turn committed on, from
 * the live provider instance — the same values the legacy `provider_event`
 * completion carried:
 *   - providerType      ← `state.type` (every instance's `pushEvent` stamped
 *                          `providerType: this.type`)
 *   - providerSessionId ← `state.providerSessionId` (CLI `pushEvent` stamped
 *                          `host.providerSessionId`)
 *   - workspaceName     ← `state.workspace` (CLI/ACP `workingDir`, IDE
 *                          `workspace`), or the parent IDE's workspace for an
 *                          extension session (extension `pushEvent` stamped
 *                          `parent.workspaceName`)
 *
 * An extension session is a child of its IDE instance and is not in the
 * instance manager's own map, so it is found through the registry's
 * `parentSessionId` and the parent state's `extensions` list.
 *
 * Returns undefined when the session has no local instance (a remote mesh
 * worker hosted elsewhere); the event then carries none of these fields.
 */
export function createInstanceSessionMetaResolver(
    instanceManager: StatusEventInstanceManager,
    sessionRegistry?: StatusEventSessionRegistry,
): ResolveStatusEventSessionMeta {
    const readState = (sessionId: string): ProviderState | undefined => {
        const getInstance = instanceManager?.getInstance;
        if (typeof getInstance !== 'function') return undefined;
        try {
            return getInstance.call(instanceManager, sessionId)?.getState?.();
        } catch {
            return undefined;
        }
    };
    return (sessionId) => {
        if (!sessionId) return undefined;
        let state = readState(sessionId);
        let workspace: unknown = state?.workspace;
        if (!state) {
            let parentId: string | undefined;
            try {
                parentId = nonEmpty(sessionRegistry?.get(sessionId)?.parentSessionId);
            } catch {
                parentId = undefined;
            }
            const parent = parentId ? readState(parentId) : undefined;
            const children = parent && parent.category === 'ide' && Array.isArray(parent.extensions) ? parent.extensions : [];
            state = children.find((child) => child?.instanceId === sessionId);
            if (!state) return undefined;
            workspace = parent?.workspace;
        }
        const meta: StatusEventSessionMeta = {};
        const providerType = nonEmpty(state.type);
        if (providerType) meta.providerType = providerType;
        const providerSessionId = nonEmpty(state.providerSessionId);
        if (providerSessionId) meta.providerSessionId = providerSessionId;
        const workspaceName = nonEmpty(workspace);
        if (workspaceName) meta.workspaceName = workspaceName;
        return meta;
    };
}

/**
 * Per-turn wall-clock start, for the `duration` a turn-sourced
 * `agent:generating_completed` carries. The legacy producers sent
 * `Math.round((completedAt - generatingStartedAt) / 1000)` — whole seconds from
 * the first generating edge to completion, approval waits included — and
 * `agent:stopped` never carried a duration. Here the start is the ledger's
 * `turn{phase:'started'}` (re-armed on a reclaim's fresh start; suspension /
 * resume do not reset it) and the end is the `committed` bus event.
 *
 * Bounded: an entry is dropped at commit or when its session terminates, and
 * the map never holds more than `maxEntries` (oldest evicted first), so a turn
 * whose commit never arrives cannot grow it.
 */
export interface TurnDurationTracker {
    /** Feed every `turn` bus event; returns whole seconds at a `committed` phase whose start was seen. */
    observe(event: TurnBusEvent & { at: number }): number | undefined;
    /** Drop every open turn of a terminated session. */
    forgetSession(sessionId: string): void;
    readonly size: number;
}

export function createTurnDurationTracker(maxEntries = 256): TurnDurationTracker {
    const starts = new Map<string, { sessionId: string; at: number }>();
    return {
        observe(event) {
            if (!event.attemptId || typeof event.at !== 'number' || !Number.isFinite(event.at)) return undefined;
            if (event.phase === 'started') {
                starts.delete(event.attemptId);
                starts.set(event.attemptId, { sessionId: event.sessionId, at: event.at });
                while (starts.size > maxEntries) {
                    const oldest = starts.keys().next().value;
                    if (oldest === undefined) break;
                    starts.delete(oldest);
                }
                return undefined;
            }
            if (event.phase !== 'committed') return undefined;
            const start = starts.get(event.attemptId);
            starts.delete(event.attemptId);
            if (!start || event.at < start.at) return undefined;
            return Math.round((event.at - start.at) / 1000);
        },
        forgetSession(sessionId) {
            for (const [attemptId, start] of starts) {
                if (start.sessionId === sessionId) starts.delete(attemptId);
            }
        },
        get size() {
            return starts.size;
        },
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

    // `agent:generating_completed` / `agent:stopped` are now projected SOLELY
    // from a committed `turn` bus event (`projectTurnStatusEvent`, below). A
    // `provider_event` still carrying one of these names is the legacy
    // completion bag some producers still push onto the bus for other
    // consumers (mesh evidence-building, quota refresh) that have not yet
    // fully migrated off it — it must never also reach the wire here, or a
    // single completion would push `status_event` twice.
    if (TURN_SOURCED_WIRE_NAMES.has(eventName)) {
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
 * Project a committed `turn` bus event onto `status_event` (wiring-unification
 * C1/C5). `agent:generating_completed` / `agent:stopped` are no longer events
 * anyone emits directly — `bus-projection.ts`'s `projectTurnWireEvent` is the
 * SOLE place those two literals are produced from a ledger commit, and this is
 * the only consumer that turns that projection into the wire payload. Unlike
 * `projectServerStatusEvent` (an allow-list over an untyped `Record`),
 * `TurnWireEvent` is already a closed, content-free shape by construction — no
 * modalMessage/modalButtons exist on it, so there is nothing to drop. The
 * session identity and duration the legacy completion carried are added from
 * the injected resolvers, each copied individually (identifiers and a number).
 *
 * Returns null for a non-`committed` phase (started/suspended/resumed/progress
 * travel as their own bus kinds — input_state, modal, … — not status_event).
 */
export function projectTurnStatusEvent(
    event: TurnBusEvent,
    at: number,
    resolveHideMute?: ResolveStatusEventHideMute,
    extras?: {
        /** Session identity (providerType / providerSessionId / workspaceName). */
        resolveSessionMeta?: ResolveStatusEventSessionMeta;
        /** Whole seconds from turn start to this commit, when the start was observed. */
        durationSec?: number;
    },
): DaemonStatusEventPayload | null {
    const wire: TurnWireEvent | null = projectTurnWireEvent(event, at);
    if (!wire) return null;
    const payload: DaemonStatusEventPayload = {
        event: wire.event,
        timestamp: wire.timestamp,
        targetSessionId: wire.sessionId,
    };
    // Allow-list, field by field — never a spread of whatever the resolver returned.
    const meta = extras?.resolveSessionMeta?.(wire.sessionId);
    if (meta) {
        const providerType = nonEmpty(meta.providerType);
        if (providerType) payload.providerType = providerType;
        const providerSessionId = nonEmpty(meta.providerSessionId);
        if (providerSessionId) payload.providerSessionId = providerSessionId;
        const workspaceName = nonEmpty(meta.workspaceName);
        if (workspaceName) payload.workspaceName = workspaceName;
    }
    // The legacy producers put `duration` on completion only, never on stop.
    if (
        wire.event === 'agent:generating_completed'
        && typeof extras?.durationSec === 'number'
        && Number.isFinite(extras.durationSec)
        && extras.durationSec >= 0
    ) {
        payload.duration = extras.durationSec;
    }
    if (resolveHideMute) {
        const hideMute = resolveHideMute(wire.sessionId);
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
    /** Live instance lookup for the hide/mute stamp and the turn-event session identity. */
    instanceManager?: { getInstance?(sessionId: string): { getState?(): ProviderState | undefined } | undefined } | null;
    /** Parent lookup so an IDE extension session (not in the instance map) resolves through its IDE. */
    sessionRegistry?: StatusEventSessionRegistry;
    /** Dashboard delivery: cloud P2P DataChannel, standalone WS broadcast. */
    sendDashboard(payload: P2PStatusEventPayload): void;
    /** Server delivery (push / webhook / audit). Cloud only; standalone has no server leg. */
    sendServer?(payload: DaemonStatusEventPayload): void;
    /**
     * Also project committed `turn` bus events (the ledger's commit) onto
     * `status_event`. ON by default (wiring-unification C-W5 follow-up,
     * 2026-09-24): `agent:generating_completed` / `agent:stopped` are now
     * projected SOLELY from here — `projectServerStatusEvent` rejects those two
     * names when they arrive via `provider_event` (see `TURN_SOURCED_WIRE_NAMES`
     * above), so a completion can never push `status_event` twice even though a
     * few producers still push the legacy names onto `provider_event` for OTHER
     * consumers (`mesh-event-forwarding.ts`'s evidence builder, quota refresh's
     * `agent:stopped` trigger) that have not yet migrated off that bus kind. Pass
     * `false` only for a test that wants the pre-C-W5 behaviour.
     */
    turnCommits?: boolean;
}

/**
 * Subscribe the status-event projection to the bus. Returns the unsubscribe.
 * Each delivery leg runs in its own try/catch so a dead transport on one side
 * never swallows the other.
 */
export function createStatusEventEmitter(bus: Pick<SessionLifecycleBus, 'on'>, deps: StatusEventEmitterDeps): Unsubscribe {
    const resolveHideMute = createInstanceHideMuteResolver(deps.instanceManager);
    const resolveSessionMeta = createInstanceSessionMetaResolver(deps.instanceManager, deps.sessionRegistry);
    const durations = createTurnDurationTracker();
    const unsubProviderEvent = bus.on('provider_event', (e) => {
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
    // Turn-ledger commits (wiring-unification C1/C5): the SOLE source of
    // `agent:generating_completed` / `agent:stopped` on this wire (ON by
    // default — see StatusEventEmitterDeps.turnCommits above). No P2P
    // enrichment applies — a committed turn carries no interactivePrompt.
    const unsubTurn = deps.turnCommits === false ? () => {} : bus.on('turn', (e) => {
        const durationSec = durations.observe(e);
        const serverEvent = projectTurnStatusEvent(e, e.at, resolveHideMute, { resolveSessionMeta, durationSec });
        if (!serverEvent) return;
        LOG.debug('StatusEvent', `${serverEvent.event} (turn ledger commit, session=${serverEvent.targetSessionId})`);
        try {
            deps.sendDashboard(serverEvent as P2PStatusEventPayload);
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
    }, { name: 'host.status-event.turn' });
    const unsubTerminated = deps.turnCommits === false ? () => {} : bus.on('terminated', (e) => {
        durations.forgetSession(e.sessionId);
    }, { name: 'host.status-event.turn-duration-evict' });
    return () => {
        unsubProviderEvent();
        unsubTurn();
        unsubTerminated();
    };
}
