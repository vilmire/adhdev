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
    source?: unknown; type?: unknown; lifecycle?: unknown; status?: unknown; evidence?: unknown; actionable?: unknown; modalKey?: unknown; resolvedAt?: unknown;
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
 *
 * When a provider instance (such as an IDE or legacy CLI adapter snapshot) is
 * live in `waiting_approval` without a `providerApproval` object on `getState()`,
 * falls back to the `modalKey` minted on the held `fallbackRawEvent` so a live
 * approval is never silently dropped.
 */
export function currentApprovalEpisodeKey(
    state: SessionStateLike,
    fallbackRawEvent?: Record<string, unknown> | null,
): string | null {
    if (!state) return null;
    if (state.status === 'generating' || state.activeChat?.status === 'generating') return null;
    const waiting = state.status === 'waiting_approval' || state.activeChat?.status === 'waiting_approval';
    if (!waiting) return null;
    const approval = state.activeChat?.providerApproval ?? state.providerApproval;
    if (!approval) {
        const rawModalKey = typeof fallbackRawEvent?.modalKey === 'string' ? fallbackRawEvent.modalKey.trim() : '';
        if (!rawModalKey) return null;
        if (fallbackRawEvent?.approvalEvidence && fallbackRawEvent.approvalEvidence !== 'live') return null;
        return `modal:${rawModalKey}`;
    }
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
 * The held episode is still open even though this frame does not read as waiting:
 * a buttonless repaint projects `generating` with the approval pending under the same
 * key (evidence 'unavailable'). The daemon does not re-emit agent:waiting_approval for
 * that episode when the buttons come back, so dropping the hold here would lose the
 * owner escalation for good.
 */
function heldEpisodeStillOpen(state: SessionStateLike, heldKey: string): boolean {
    if (!state || !heldKey) return false;
    const approval = state.activeChat?.providerApproval ?? state.providerApproval;
    if (!approval || approval.lifecycle !== 'pending' || approval.resolvedAt != null) return false;
    const modalKey = typeof approval.modalKey === 'string' ? approval.modalKey.trim() : '';
    return !!modalKey && `modal:${modalKey}` === heldKey;
}

/** Re-check budget while the held episode is provably still open (≈5 min at 5 s). */
const ESCALATION_MAX_OPEN_EPISODE_RECHECKS = 60;

/**
 * A wait on a human acting OUTSIDE the terminal (FSM `waiting_external`: browser
 * sign-in, 2FA) projects to `waiting_approval` with no modal and no buttons. It is
 * not an approval to press, so the modal-keyed rules above never identify it — yet
 * the owner must still hear about it, once per wait. The daemon marks such events
 * `waitKind: 'external'`; the gate keys the whole wait as one status-only episode,
 * escalates it once, and forgets it when the session stops waiting so a later wait
 * escalates again.
 */
const STATUS_ONLY_KEY = 'status_only:waiting_external';
const STATUS_ONLY_RESOLVE_POLL_MS = 1_000;

function episodeKeyFor(state: SessionStateLike, rawEvent: Record<string, unknown> | null | undefined): string | null {
    const key = currentApprovalEpisodeKey(state, rawEvent);
    if (key) return key;
    return rawEvent?.waitKind === 'external' && stillWaiting(state) ? STATUS_ONLY_KEY : null;
}

/**
 * Rebuild the escalated event from the CURRENT validated episode in `state`
 * rather than forwarding stale fields from `entry.raw` (which may have been
 * captured while `approvalEvidence: 'unavailable'` or an earlier episode key).
 * Episode-specific fields are cleared first so an empty current modal never
 * inherits an earlier episode's command or buttons.
 */
function buildEscalatedEvent(
    rawEvent: Record<string, unknown>,
    state: SessionStateLike,
): Record<string, unknown> {
    const approval = state?.activeChat?.providerApproval ?? state?.providerApproval;
    const hasActiveModalProp = Boolean(state?.activeChat && 'activeModal' in state.activeChat);
    const activeModal = state?.activeChat?.activeModal;
    const rebuilt: Record<string, unknown> = { ...rawEvent };
    delete rebuilt.modalMessage;
    delete rebuilt.modalButtons;
    delete rebuilt.modalKey;
    delete rebuilt.approvalEvidence;

    // A resolved or stale record is not this episode: never lend its key or evidence.
    if (approval && approval.lifecycle === 'pending' && approval.resolvedAt == null) {
        const modalKey = typeof approval.modalKey === 'string' ? approval.modalKey.trim() : '';
        if (modalKey) {
            rebuilt.modalKey = modalKey;
        }
        if (approval.evidence === 'live' || approval.evidence === 'cached' || approval.evidence === 'unavailable') {
            rebuilt.approvalEvidence = approval.evidence;
        }
    } else if (stillWaiting(state) && state?.status !== 'generating' && state?.activeChat?.status !== 'generating') {
        const fallbackKey = typeof rawEvent.modalKey === 'string' ? rawEvent.modalKey.trim() : '';
        if (fallbackKey) rebuilt.modalKey = fallbackKey;
        const rawEvidence = rawEvent.approvalEvidence;
        rebuilt.approvalEvidence = (rawEvidence === 'live' || rawEvidence === 'cached' || rawEvidence === 'unavailable')
            ? rawEvidence
            : 'live';
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
    } else if (!hasActiveModalProp) {
        const rawKey = typeof rawEvent.modalKey === 'string' ? rawEvent.modalKey.trim() : '';
        if (rawKey && rebuilt.modalKey === rawKey) {
            if (typeof rawEvent.modalMessage === 'string' && rawEvent.modalMessage.trim()) {
                rebuilt.modalMessage = rawEvent.modalMessage;
            }
            if (Array.isArray(rawEvent.modalButtons)) {
                const buttons = rawEvent.modalButtons.filter(
                    (button): button is string => typeof button === 'string' && button.trim().length > 0,
                );
                if (buttons.length > 0) {
                    rebuilt.modalButtons = buttons;
                }
            }
        }
    }
    return rebuilt;
}

function hasActionableEscalatedModal(rebuilt: Record<string, unknown>, state: SessionStateLike): boolean {
    const approval = state?.activeChat?.providerApproval ?? state?.providerApproval;
    // Legacy (IDE/extension/CLI-fallback) records are never Inbox-actionable by design,
    // but their buttons are still the owner's decision — escalate on the buttons alone.
    if (approval && approval.actionable === false && approval.source !== 'legacy_provider') return false;
    return Array.isArray(rebuilt.modalButtons) && rebuilt.modalButtons.length > 0;
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
    const held = new Map<string, { key: string; raw: Record<string, unknown>; timer: unknown; firstHeldAt: number; rechecks: number }>();
    const escalated = new Set<string>();
    const lastEscalatedAt = new Map<string, number>();
    const statusOnlyWatchers = new Map<string, unknown>();

    const stopStatusOnlyWatcher = (sessionId: string) => {
        const w = statusOnlyWatchers.get(sessionId);
        if (w !== undefined) { clearTimer(w); statusOnlyWatchers.delete(sessionId); }
    };
    const clearStatusOnlyEscalation = (sessionId: string) => {
        stopStatusOnlyWatcher(sessionId);
        escalated.delete(`${sessionId}\u0000${STATUS_ONLY_KEY}`);
    };
    // Forget a delivered external wait once the session stops waiting, so the next
    // wait (a new sign-in) escalates again instead of being deduped forever.
    const armStatusOnlyWatcher = (sessionId: string) => {
        stopStatusOnlyWatcher(sessionId);
        const poll = () => {
            statusOnlyWatchers.delete(sessionId);
            if (!escalated.has(`${sessionId}\u0000${STATUS_ONLY_KEY}`)) return;
            let st: SessionStateLike = null;
            try { st = deps.readState(sessionId); } catch { st = null; }
            if (!stillWaiting(st)) { clearStatusOnlyEscalation(sessionId); return; }
            statusOnlyWatchers.set(sessionId, setTimer(poll, STATUS_ONLY_RESOLVE_POLL_MS));
        };
        statusOnlyWatchers.set(sessionId, setTimer(poll, STATUS_ONLY_RESOLVE_POLL_MS));
    };

    const fire = (sessionId: string) => {
        const entry = held.get(sessionId);
        if (!entry) return;
        let state: SessionStateLike = null;
        let currentKey: string | null = null;
        try { state = deps.readState(sessionId); currentKey = episodeKeyFor(state, entry.raw); } catch { currentKey = null; }
        if (!currentKey) {
            // Still parked but the episode is momentarily unreadable (an
            // evidence:'unavailable' repaint): look again shortly instead of
            // dropping the escalation for good.
            const open = heldEpisodeStillOpen(state, entry.key);
            if ((stillWaiting(state) && entry.rechecks < ESCALATION_MAX_RECHECKS)
                || (open && entry.rechecks < ESCALATION_MAX_OPEN_EPISODE_RECHECKS)) {
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
            entry.timer = setTimer(() => fire(sessionId), cooldownRemaining);
            return;
        }
        const rebuilt = buildEscalatedEvent(entry.raw, state);
        const statusOnly = currentKey === STATUS_ONLY_KEY;
        // An external wait has no buttons by construction; it is still owner-actionable.
        if (!statusOnly && !hasActionableEscalatedModal(rebuilt, state)) {
            if ((stillWaiting(state) && entry.rechecks < ESCALATION_MAX_RECHECKS)
                || (heldEpisodeStillOpen(state, currentKey) && entry.rechecks < ESCALATION_MAX_OPEN_EPISODE_RECHECKS)) {
                entry.rechecks += 1;
                entry.key = currentKey;
                entry.timer = setTimer(() => fire(sessionId), ESCALATION_RECHECK_MS);
                return;
            }
            held.delete(sessionId);
            return;
        }
        LOG.info('StatusEvent', `approval escalated to owner session=${sessionId} after ${Math.round(delayMs / 1000)}s unresolved`);
        let delivered = false;
        try {
            delivered = deps.escalate(sessionId, rebuilt) !== false;
        } catch (error) {
            LOG.warn('StatusEvent', `approval escalation delivery failed session=${sessionId}: ${(error as Error)?.message ?? error}`);
            delivered = false;
        }
        if (!delivered) {
            // Never drop a live approval without notifying the owner: keep
            // re-checking while the session remains parked on a live episode.
            if (stillWaiting(state)) {
                entry.rechecks += 1;
                entry.key = currentKey;
                entry.timer = setTimer(() => fire(sessionId), ESCALATION_RECHECK_MS);
            } else {
                held.delete(sessionId);
            }
            return;
        }
        held.delete(sessionId);
        // Mark ONLY the episode actually delivered as escalated so an earlier
        // coalesced episode that was never delivered can still escalate if it
        // becomes current again.
        escalated.add(`${sessionId}\u0000${currentKey}`);
        lastEscalatedAt.set(sessionId, nowMs);
        if (statusOnly) armStatusOnlyWatcher(sessionId);
        while (escalated.size > MAX_ESCALATED_REMEMBERED) {
            const oldest = escalated.values().next().value;
            if (oldest === undefined) break;
            escalated.delete(oldest);
        }
    };

    return {
        hold(rawEvent) {
            const sessionId = typeof rawEvent.targetSessionId === 'string' ? rawEvent.targetSessionId.trim() : '';
            if (rawEvent.event !== 'agent:waiting_approval') {
                // Any other session fact is a chance to notice an external wait ended.
                if (sessionId) {
                    let st: SessionStateLike = null;
                    try { st = deps.readState(sessionId); } catch { st = null; }
                    if (!stillWaiting(st)) clearStatusOnlyEscalation(sessionId);
                }
                return false;
            }
            if (!sessionId) return false;
            let state: SessionStateLike;
            try { state = deps.readState(sessionId); } catch { return false; }
            if (!state || !isCoordinatorFirstSession(state.settings ?? null)) return false;
            const key = episodeKeyFor(state, rawEvent);
            if (key !== STATUS_ONLY_KEY) clearStatusOnlyEscalation(sessionId);
            if (key && escalated.has(`${sessionId}\u0000${key}`)) return true;
            const existing = held.get(sessionId);
            if (existing) {
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
            if (existing) clearTimer(existing.timer);
            const lastAt = lastEscalatedAt.get(sessionId);
            const cooldownRemaining = lastAt !== undefined ? Math.max(0, lastAt + cooldownMs - nowMs) : 0;
            const holdRemaining = Math.max(0, firstHeldAt + delayMs - nowMs);
            const waitMs = Math.max(holdRemaining, cooldownRemaining);
            held.set(sessionId, {
                key: key ?? '',
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
            stopStatusOnlyWatcher(sessionId);
            for (const k of [...escalated]) if (k.startsWith(`${sessionId}\u0000`)) escalated.delete(k);
            lastEscalatedAt.delete(sessionId);
        },
        dispose() {
            for (const entry of held.values()) clearTimer(entry.timer);
            held.clear();
            for (const w of statusOnlyWatchers.values()) clearTimer(w);
            statusOnlyWatchers.clear();
            escalated.clear();
            lastEscalatedAt.clear();
        },
        get heldCount() { return held.size; },
    };
}
