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
/** Per-session cooldown so a worker can escalate to the owner at most once per window. */
export const OWNER_APPROVAL_SESSION_COOLDOWN_MS = 120_000;

type ProviderApprovalLike = {
    type?: unknown; lifecycle?: unknown; status?: unknown; evidence?: unknown; actionable?: unknown; modalKey?: unknown; resolvedAt?: unknown;
} | null;

type SessionStateLike = {
    status?: unknown;
    settings?: Record<string, unknown> | null;
    providerApproval?: ProviderApprovalLike;
    activeChat?: {
        status?: unknown;
        activeModal?: { message?: unknown; buttons?: unknown } | null;
        providerApproval?: ProviderApprovalLike;
    } | null;
} | null | undefined;

export function isCoordinatorFirstSession(settings: Record<string, unknown> | null | undefined): boolean {
    return settings?.launchedByCoordinator === true && typeof settings.meshNodeFor === 'string' && !!settings.meshNodeFor.trim();
}

/**
 * The identity of the approval episode a session is CURRENTLY parked on, or
 * null when it is not parked on a live, unmasked, unresolved permission request
 * with a non-empty modalKey.
 */
export function currentApprovalEpisodeKey(state: SessionStateLike): string | null {
    if (!state) return null;
    if (state.status === 'generating' || state.activeChat?.status === 'generating') return null;
    const waiting = state.status === 'waiting_approval' || state.activeChat?.status === 'waiting_approval';
    if (!waiting) return null;
    const approval = state.activeChat?.providerApproval ?? state.providerApproval;
    if (!approval) return null;
    const pending = approval.lifecycle === 'pending' || approval.status === 'awaiting_approval';
    if (!pending || approval.resolvedAt != null || approval.evidence !== 'live') return null;
    const modalKey = typeof approval.modalKey === 'string' ? approval.modalKey.trim() : '';
    return modalKey ? `modal:${modalKey}` : null;
}

export interface ApprovalEscalationGateDeps {
    readState(sessionId: string): SessionStateLike;
    /** Re-project and send the held raw event on escalation. Return false when delivery was rejected. */
    escalate(sessionId: string, rawEvent: Record<string, unknown>): boolean | void;
    delayMs?: number;
    cooldownMs?: number;
    now?: () => number;
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
/** Re-check cadence while a still-waiting session's episode key is momentarily unreadable. */
const ESCALATION_RECHECK_MS = 5_000;
const ESCALATION_MAX_RECHECKS = 6;

function stillWaiting(state: SessionStateLike): boolean {
    return !!state && (state.status === 'waiting_approval' || state.activeChat?.status === 'waiting_approval');
}

/**
 * Rebuild the escalated event from the CURRENT validated episode in `state`
 * rather than forwarding stale fields from `entry.raw` (which may have been
 * captured while `approvalEvidence: 'unavailable'` or an earlier episode key).
 */
function buildEscalatedEvent(
    rawEvent: Record<string, unknown>,
    state: SessionStateLike,
): Record<string, unknown> {
    const approval = state?.activeChat?.providerApproval ?? state?.providerApproval;
    const activeModal = state?.activeChat?.activeModal;
    const rebuilt: Record<string, unknown> = { ...rawEvent };
    if (approval) {
        const modalKey = typeof approval.modalKey === 'string' ? approval.modalKey.trim() : '';
        if (modalKey) {
            rebuilt.modalKey = modalKey;
        } else {
            delete rebuilt.modalKey;
        }
        if (approval.evidence === 'live' || approval.evidence === 'cached' || approval.evidence === 'unavailable') {
            rebuilt.approvalEvidence = approval.evidence;
        } else {
            delete rebuilt.approvalEvidence;
        }
    }
    if (activeModal) {
        if (typeof activeModal.message === 'string' && activeModal.message.trim()) {
            rebuilt.modalMessage = activeModal.message;
        }
        if (Array.isArray(activeModal.buttons)) {
            const buttons = activeModal.buttons.filter(
                (button): button is string => typeof button === 'string' && button.trim().length > 0,
            );
            if (buttons.length > 0) {
                rebuilt.modalButtons = buttons;
            }
        }
    }
    return rebuilt;
}

export function createApprovalEscalationGate(deps: ApprovalEscalationGateDeps): ApprovalEscalationGate {
    const delayMs = deps.delayMs ?? OWNER_APPROVAL_ESCALATION_MS;
    const cooldownMs = deps.cooldownMs ?? OWNER_APPROVAL_SESSION_COOLDOWN_MS;
    const setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; });
    const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    const now = deps.now ?? (() => Date.now());
    // firstHeldAt caps the total hold per session: a modal that keeps minting new
    // episode keys (a tall diff scrolling its buttons in and out) must not keep
    // restarting the window and starve the owner push.
    const held = new Map<string, { key: string; pendingKeys: Set<string>; raw: Record<string, unknown>; timer: unknown; firstHeldAt: number; rechecks: number }>();
    const escalated = new Set<string>();
    const lastEscalatedAt = new Map<string, number>();

    const fire = (sessionId: string) => {
        const entry = held.get(sessionId);
        if (!entry) return;
        let state: SessionStateLike = null;
        let currentKey: string | null = null;
        try { state = deps.readState(sessionId); currentKey = currentApprovalEpisodeKey(state); } catch { currentKey = null; }
        if (!currentKey) {
            // Still parked but the episode is momentarily unreadable (an
            // evidence:'unavailable' repaint): look again shortly instead of
            // dropping the escalation for good.
            if (stillWaiting(state) && entry.rechecks < ESCALATION_MAX_RECHECKS) {
                entry.rechecks += 1;
                entry.timer = setTimer(() => fire(sessionId), ESCALATION_RECHECK_MS);
                return;
            }
            held.delete(sessionId);
            LOG.info('StatusEvent', `approval escalation retired session=${sessionId} (resolved before escalation)`);
            return;
        }
        if (escalated.has(`${sessionId}\u0000${currentKey}`)) {
            held.delete(sessionId);
            return;
        }
        const nowMs = now();
        const lastAt = lastEscalatedAt.get(sessionId);
        if (lastAt !== undefined && nowMs - lastAt < cooldownMs) {
            const cooldownRemaining = Math.max(1, cooldownMs - (nowMs - lastAt));
            entry.key = currentKey;
            entry.pendingKeys.add(currentKey);
            entry.timer = setTimer(() => fire(sessionId), cooldownRemaining);
            return;
        }
        const rebuilt = buildEscalatedEvent(entry.raw, state);
        LOG.info('StatusEvent', `approval escalated to owner session=${sessionId} after ${Math.round(delayMs / 1000)}s unresolved`);
        let delivered = false;
        try {
            delivered = deps.escalate(sessionId, rebuilt) !== false;
        } catch (error) {
            LOG.warn('StatusEvent', `approval escalation delivery failed session=${sessionId}: ${(error as Error)?.message ?? error}`);
            delivered = false;
        }
        if (!delivered) {
            if (entry.rechecks < ESCALATION_MAX_RECHECKS) {
                entry.rechecks += 1;
                entry.key = currentKey;
                entry.pendingKeys.add(currentKey);
                entry.timer = setTimer(() => fire(sessionId), ESCALATION_RECHECK_MS);
            } else {
                held.delete(sessionId);
            }
            return;
        }
        held.delete(sessionId);
        // Mark the episode (and any coalesced replaced episodes from this window)
        // as escalated ONLY after a successful delivery attempt.
        for (const k of entry.pendingKeys) {
            if (k) escalated.add(`${sessionId}\u0000${k}`);
        }
        if (entry.key) escalated.add(`${sessionId}\u0000${entry.key}`);
        escalated.add(`${sessionId}\u0000${currentKey}`);
        lastEscalatedAt.set(sessionId, nowMs);
        while (escalated.size > MAX_ESCALATED_REMEMBERED) {
            const oldest = escalated.values().next().value;
            if (oldest === undefined) break;
            escalated.delete(oldest);
        }
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
            if (key && escalated.has(`${sessionId}\u0000${key}`)) return true;
            const existing = held.get(sessionId);
            if (existing) {
                if (key) existing.pendingKeys.add(key);
                if (!key || existing.key === key) {
                    existing.raw = rawEvent;
                    return true;
                }
                if (!existing.key && key) {
                    existing.key = key;
                    existing.raw = rawEvent;
                    return true;
                }
            }
            const nowMs = now();
            const firstHeldAt = existing?.firstHeldAt ?? nowMs;
            const pendingKeys = existing?.pendingKeys ?? new Set<string>();
            if (key) pendingKeys.add(key);
            if (existing) clearTimer(existing.timer);
            const lastAt = lastEscalatedAt.get(sessionId);
            const cooldownRemaining = lastAt !== undefined ? Math.max(0, lastAt + cooldownMs - nowMs) : 0;
            const holdRemaining = Math.max(0, firstHeldAt + delayMs - nowMs);
            const waitMs = Math.max(holdRemaining, cooldownRemaining);
            held.set(sessionId, {
                key: key ?? '',
                pendingKeys,
                raw: rawEvent,
                firstHeldAt,
                rechecks: 0,
                timer: setTimer(() => fire(sessionId), waitMs),
            });
            return true;
        },
        retire(sessionId) {
            const entry = held.get(sessionId);
            if (entry) { clearTimer(entry.timer); held.delete(sessionId); }
            for (const k of [...escalated]) if (k.startsWith(`${sessionId}\u0000`)) escalated.delete(k);
            lastEscalatedAt.delete(sessionId);
        },
        dispose() {
            for (const entry of held.values()) clearTimer(entry.timer);
            held.clear();
            escalated.clear();
            lastEscalatedAt.clear();
        },
        get heldCount() { return held.size; },
    };
}
