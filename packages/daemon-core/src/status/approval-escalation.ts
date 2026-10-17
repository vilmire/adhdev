/**
 * Worker permission policy — auto-approve OFF: the coordinator sees a delegated
 * worker's permission request FIRST; the owner's push is an escalation.
 *
 * A coordinator-delegated worker (`launchedByCoordinator` + `meshNodeFor`)
 * already reaches its coordinator through the turn ledger the moment it parks
 * on an approval. This gate holds the SERVER leg of that worker's
 * `agent:waiting_approval` status_event (the owner push / webhook leg) for
 * `OWNER_APPROVAL_ESCALATION_MS`. If the very same episode is still pending,
 * live and unresolved when the window ends, the event is sent once — that is
 * the escalation. If the episode resolved, was replaced, or the session ended,
 * the held event is retired and never sent.
 *
 * What it does NOT change:
 *  - the dashboard (P2P) leg — Inbox/session state stays real time;
 *  - non-delegated sessions — sent immediately as before;
 *  - hide/mute — the escalated payload is re-projected at send time, so a
 *    muted/hidden worker stays silent exactly as the server gate decides today;
 *  - the content boundary — the payload is the same allow-listed projection
 *    (80-character modalMessage push exception unchanged).
 * One push per episode: a repeated waiting_approval for an episode that was
 * already escalated (stall nudge, repaint) is dropped.
 */

import { LOG } from '../logging/logger.js';

/** Coordinator-first window before an unresolved worker approval is pushed to the owner. */
export const OWNER_APPROVAL_ESCALATION_MS = 60_000;

type SessionStateLike = {
    status?: unknown;
    settings?: Record<string, unknown> | null;
    activeChat?: {
        status?: unknown;
        activeModal?: { message?: unknown; buttons?: unknown } | null;
        providerApproval?: {
            type?: unknown; lifecycle?: unknown; evidence?: unknown; actionable?: unknown; modalKey?: unknown; resolvedAt?: unknown;
        } | null;
    } | null;
} | null | undefined;

export function isCoordinatorFirstSession(settings: Record<string, unknown> | null | undefined): boolean {
    return settings?.launchedByCoordinator === true && typeof settings.meshNodeFor === 'string' && !!settings.meshNodeFor.trim();
}

/**
 * The identity of the approval episode a session is CURRENTLY parked on, or
 * null when it is not parked on a live, unresolved permission request. A
 * lifecycle-aware adapter is identified by its modalKey; a legacy adapter by
 * its modal text + buttons.
 */
export function currentApprovalEpisodeKey(state: SessionStateLike): string | null {
    if (!state) return null;
    const waiting = state.status === 'waiting_approval' || state.activeChat?.status === 'waiting_approval';
    if (!waiting) return null;
    const approval = state.activeChat?.providerApproval;
    if (approval) {
        if (approval.lifecycle !== 'pending' || approval.resolvedAt != null || approval.evidence !== 'live') return null;
        return typeof approval.modalKey === 'string' && approval.modalKey ? `modal:${approval.modalKey}` : null;
    }
    const modal = state.activeChat?.activeModal;
    if (!modal || !Array.isArray(modal.buttons) || modal.buttons.length === 0) return null;
    return `legacy:${JSON.stringify([String(modal.message ?? ''), modal.buttons.map(String)])}`;
}

export interface ApprovalEscalationGateDeps {
    readState(sessionId: string): SessionStateLike;
    /** Re-project and send the held raw event on escalation. */
    escalate(sessionId: string, rawEvent: Record<string, unknown>): void;
    delayMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

export interface ApprovalEscalationGate {
    /** True when the server leg must NOT send this event now (held or duplicate). */
    hold(rawEvent: Record<string, unknown>): boolean;
    /** Drop any held event for a session (terminated). */
    retire(sessionId: string): void;
    dispose(): void;
    readonly heldCount: number;
}

const MAX_ESCALATED_REMEMBERED = 512;

export function createApprovalEscalationGate(deps: ApprovalEscalationGateDeps): ApprovalEscalationGate {
    const delayMs = deps.delayMs ?? OWNER_APPROVAL_ESCALATION_MS;
    const setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; });
    const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    const held = new Map<string, { key: string; raw: Record<string, unknown>; timer: unknown }>();
    const escalated = new Set<string>();

    const fire = (sessionId: string) => {
        const entry = held.get(sessionId);
        if (!entry) return;
        held.delete(sessionId);
        let currentKey: string | null = null;
        try { currentKey = currentApprovalEpisodeKey(deps.readState(sessionId)); } catch { currentKey = null; }
        if (currentKey !== entry.key) {
            LOG.info('StatusEvent', `approval escalation retired session=${sessionId} (resolved or replaced before escalation)`);
            return;
        }
        escalated.add(`${sessionId}\u0000${entry.key}`);
        while (escalated.size > MAX_ESCALATED_REMEMBERED) {
            const oldest = escalated.values().next().value;
            if (oldest === undefined) break;
            escalated.delete(oldest);
        }
        LOG.info('StatusEvent', `approval escalated to owner session=${sessionId} after ${Math.round(delayMs / 1000)}s unresolved`);
        deps.escalate(sessionId, entry.raw);
    };

    return {
        hold(rawEvent) {
            if (rawEvent.event !== 'agent:waiting_approval') return false;
            const sessionId = typeof rawEvent.targetSessionId === 'string' ? rawEvent.targetSessionId.trim() : '';
            if (!sessionId) return false;
            let state: SessionStateLike;
            try { state = deps.readState(sessionId); } catch { return false; }
            if (!state || !isCoordinatorFirstSession(state.settings ?? null)) return false;
            const key = currentApprovalEpisodeKey(state);
            // No identifiable live episode: fail open to the previous behaviour.
            if (!key) return false;
            if (escalated.has(`${sessionId}\u0000${key}`)) return true;
            const existing = held.get(sessionId);
            if (existing?.key === key) { existing.raw = rawEvent; return true; }
            if (existing) clearTimer(existing.timer);
            held.set(sessionId, { key, raw: rawEvent, timer: setTimer(() => fire(sessionId), delayMs) });
            return true;
        },
        retire(sessionId) {
            const entry = held.get(sessionId);
            if (entry) { clearTimer(entry.timer); held.delete(sessionId); }
            for (const k of [...escalated]) if (k.startsWith(`${sessionId}\u0000`)) escalated.delete(k);
        },
        dispose() {
            for (const entry of held.values()) clearTimer(entry.timer);
            held.clear();
            escalated.clear();
        },
        get heldCount() { return held.size; },
    };
}
