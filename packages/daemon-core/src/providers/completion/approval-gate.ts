/**
 * PTY auto-approve gate (Phase 3 of the completion-engine rewrite — verbatim
 * move out of CliProviderInstance).
 *
 * Owns the settle/hysteresis/flap-continuity/mask-stall/busy-window machinery
 * that decides WHEN a captured approval modal is stable enough to fire the
 * approve key, and when a stalled episode must instead be surfaced to the mesh
 * coordinator. Episode state lives ON THE HOST (the provider instance) so
 * restarts and the existing per-incident suites construct it unchanged.
 *
 * Provenance kept inline: AUTOAPPROVE-FLAP-RECUR Fix A/B/C, AUTOAPPROVE-SETTLE-
 * FLAP, STATUS-MISMATCH mask-stall, NOTIF-APPROVAL-MASKED Q1b,
 * APPROVAL-PICKER-MISROUTE, APPROVAL-INBOX-BLINDSPOT, #137 tall-diff anchors.
 *
 * Timing invariant (do not regress the ordering):
 *   APPROVAL_AUTO_MASK_STALL_MS > APPROVAL_FLAP_CONTINUITY_MS + max_busy_phase
 *     + APPROVAL_SETTLE_MS
 * so a flapping-but-progressing episode gets a full continuity cycle before the
 * mask-stall nudge pages the coordinator.
 */

import { LOG } from '../../logging/logger.js';
import {
    pickApprovalButton,
    hasNegativeApprovalOption,
    hasReliableApprovalAffirmative,
    looksLikeActiveApprovalPromptText,
    normalizeApprovalLabel,
} from '../approval-utils.js';
import { workingDirBasename } from '../working-dir.js';
import { formatApprovalRequestMessage } from '../cli-provider-effect-format.js';
import { hasNonEmptyCliModalButtons } from '../cli-provider-status-helpers.js';

export const APPROVAL_SETTLE_MS = 600;
export const APPROVAL_GATE_HYSTERESIS_MS = 1500;
export const APPROVAL_FLAP_CONTINUITY_MS = 6000;
export const APPROVAL_AUTO_MASK_STALL_MS = 10500;
/** Busy window after a fire during which re-snapshots of the same entry are ignored. */
export const APPROVAL_FIRE_BUSY_WINDOW_MS = 5000;
/** AUTOAPPROVE-FLAP-INBOX-MISSING sticky-approval overlay window — see the
 *  class static's doc (CliProviderInstance.APPROVAL_STICKY_FLAP_MS) for the
 *  full 2026-07-13 RCA. */
export const APPROVAL_STICKY_FLAP_MS = 4000;

/**
 * The settle-gate identity signature: question line + NORMALIZED affirmative
 * label — no volatile counters, no raw button set (AUTOAPPROVE-SETTLE-FLAP).
 */
export function approvalModalSignature(message: unknown, affirmativeAnchor: string): string {
    return [typeof message === 'string' ? message.trim() : '', affirmativeAnchor].join('::');
}

/** The narrow surface of CliProviderInstance the gate reads/writes. */
export interface ApprovalGateHost {
    type: string;
    workingDir: string;
    provider: { name?: string } & Record<string, unknown>;
    adapter: {
        getStatus(opts: { allowParse: boolean }): unknown;
        resolveModalMatched?: (index: number) => boolean;
        resolveModal?: (index: number) => void;
    };
    manualAttendance: {
        isAttended(now: number): boolean;
        remainingMs(now: number): number;
    };
    // Episode state (instance-owned; tests seed these directly).
    lastAutoApprovalSignature: string;
    pendingAutoApprovalSignature: string;
    pendingAutoApprovalSince: number;
    autoApproveInactiveSince: number;
    autoApproveMaskSince: number;
    stalledApprovalNudgeEpisode: number;
    autoApproveLastModalSeenAt: number;
    autoApproveBusy: boolean;
    autoApproveBusyTimer: NodeJS.Timeout | null;
    autoApproveSettleTimer: NodeJS.Timeout | null;
    lastAutoApproveFiredAt: number;
    // AUTOAPPROVE-FLAP-INBOX-MISSING sticky-approval overlay state (instance-owned;
    // the sticky suite seeds/inspects these directly).
    approvalStickyLastConcreteAt: number;
    approvalStickyModal: { message?: string; buttons?: unknown[]; kind?: string | null } | null;
    approvalStickyEntrySeq: number;
    shouldUsePtyAutoApprove(): boolean;
    isAutonomousMeshSession(): boolean;
    isMeshWorkerSession(): boolean;
    recordAutoApproval(modalMessage?: string, buttonLabel?: string, now?: number): void;
    appendRuntimeSystemMessage(content: string, dedupKey: string, receivedAt?: number): void;
    pushEvent(event: Record<string, unknown>): void;
    /** TERMINAL-STALE-APPROVAL: stays an instance method (reads the completion
     *  emit latch + busyEpoch, which the completion paths own). */
    hasEmittedGenuineCompletionForCurrentEpoch(): boolean;
    /**
     * Timer-driven settle re-check, dispatched THROUGH the host so instance-level
     * stubs/overrides stay on the path (the suites stub maybeAutoApproveStatus and
     * assert the recheck routes into it).
     */
    recheckAutoApproveSettled(): void;
}

/** AUTOAPPROVE-FLAP-RECUR (Fix B): widened continuity for an active worker mask episode. */
export function autoApproveContinuityWindowMs(host: ApprovalGateHost): number {
    return host.autoApproveMaskSince > 0 && host.isAutonomousMeshSession()
        ? APPROVAL_FLAP_CONTINUITY_MS
        : APPROVAL_GATE_HYSTERESIS_MS;
}

/**
 * The settle-gate identity for a raw activeModal, or null when it is NOT a
 * concrete auto-approvable consent prompt. Mirrors the fire path's gates so the
 * mask-stall nudge asks the SAME question the settle clock is accruing against.
 */
export function approvableModalSignature(host: ApprovalGateHost, modal: any): string | null {
    const buttons = Array.isArray(modal?.buttons)
        ? modal.buttons.map((b: any) => String(b || '').trim()).filter(Boolean)
        : [];
    if (!modal || buttons.length === 0) return null;
    const modalKind = typeof modal?.kind === 'string' ? modal.kind : 'approval';
    if (modalKind !== 'approval') return null;
    const { index: buttonIndex, label: buttonLabel } = pickApprovalButton(buttons, host.provider as any);
    const hasReliableConsentAnchor = hasNegativeApprovalOption(buttons)
        || hasReliableApprovalAffirmative(buttons);
    if (buttonIndex < 0 || !hasReliableConsentAnchor) return null;
    return approvalModalSignature(modal?.message, normalizeApprovalLabel(buttonLabel));
}

/** Full PTY auto-approve episode reset (mode switch / lifecycle teardown). */
export function resetPtyAutoApproveState(host: ApprovalGateHost): void {
    host.lastAutoApprovalSignature = '';
    host.pendingAutoApprovalSignature = '';
    host.pendingAutoApprovalSince = 0;
    host.autoApproveInactiveSince = 0;
    host.autoApproveMaskSince = 0;
    host.stalledApprovalNudgeEpisode = 0;
    host.autoApproveLastModalSeenAt = 0;
    host.autoApproveBusy = false;
    if (host.autoApproveSettleTimer) {
        clearTimeout(host.autoApproveSettleTimer);
        host.autoApproveSettleTimer = null;
    }
    if (host.autoApproveBusyTimer) {
        clearTimeout(host.autoApproveBusyTimer);
        host.autoApproveBusyTimer = null;
    }
}

/**
 * STATUS-MISMATCH: the current episode has masked waiting_approval behind
 * `generating` past the stall bound without resolving. Side-effect-free read.
 */
export function autoApproveMaskStalled(host: ApprovalGateHost, now: number): boolean {
    return host.shouldUsePtyAutoApprove()
        && host.autoApproveMaskSince > 0
        && now - host.autoApproveMaskSince > APPROVAL_AUTO_MASK_STALL_MS;
}

function armSettleRecheck(host: ApprovalGateHost, delayMs: number): void {
    if (host.autoApproveSettleTimer) clearTimeout(host.autoApproveSettleTimer);
    host.autoApproveSettleTimer = setTimeout(() => {
        host.autoApproveSettleTimer = null;
        host.recheckAutoApproveSettled();
    }, delayMs);
}

/**
 * NOTIF-APPROVAL-MASKED (Q1b): page the mesh coordinator exactly once per
 * STALLED auto-approve episode — the dashboard mask stays, but a worker whose
 * settle gate never satisfied must not sit invisible behind `generating`.
 */
export function maybeEmitStalledApprovalNudge(host: ApprovalGateHost, adapterStatus: any, now: number): void {
    if (!host.shouldUsePtyAutoApprove()) return;
    if (!host.isMeshWorkerSession()) return;
    if (adapterStatus?.status !== 'waiting_approval') return;
    // ASKUSERQUESTION-NOT-APPROVAL (rc.19): a captured interactive prompt with no
    // concrete modal (or a picker) is a QUESTION — already surfaced as
    // agent:waiting_choice; nudging it as approval would re-misroute it.
    const nudgeModal = adapterStatus.activeModal;
    const nudgeModalKind = nudgeModal && typeof nudgeModal.kind === 'string' ? nudgeModal.kind : null;
    if (adapterStatus.activeInteractivePrompt && (!nudgeModal || nudgeModalKind === 'picker')) return;
    if (!autoApproveMaskStalled(host, now)) return;
    // AUTOAPPROVE-FLAP-RECUR (Fix C, redesigned): defer ONLY when this frame's
    // modal carries the SAME identity the settle clock is accruing against — a
    // stable modal is about to fire on its own; a flapping modal (different or
    // non-concrete signature) never satisfies the settle gate and MUST page the
    // coordinator (the rc.466 regression silenced exactly this case).
    const currentSignature = approvableModalSignature(host, adapterStatus.activeModal);
    const settleProgressing = !!currentSignature
        && host.pendingAutoApprovalSince > 0
        && currentSignature === host.pendingAutoApprovalSignature;
    if (settleProgressing) return;
    // Exactly once per stalled episode (autoApproveMaskSince uniquely identifies it).
    if (host.stalledApprovalNudgeEpisode === host.autoApproveMaskSince) return;
    host.stalledApprovalNudgeEpisode = host.autoApproveMaskSince;
    const modal = adapterStatus.activeModal;
    const dirName = workingDirBasename(host.workingDir);
    const chatTitle = `${host.provider.name} · ${dirName}`;
    host.appendRuntimeSystemMessage(
        formatApprovalRequestMessage(modal?.message, modal?.buttons),
        `approval_request:${now}`,
        now,
    );
    host.pushEvent({
        event: 'agent:waiting_approval', chatTitle, timestamp: now,
        modalMessage: modal?.message,
        modalButtons: modal?.buttons,
    });
    LOG.info('CLI', `[${host.type}] stalled auto-approve nudge → coordinator (masked ${Math.round((now - host.autoApproveMaskSince) / 1000)}s)`);
}

/**
 * The auto-approve decision for one status frame. Returns whether auto-approve
 * is ACTIVE for this frame (waiting_approval + PTY mode), which the caller uses
 * for the visible-status mask. Semantics are a verbatim move — see the module
 * header for the incident provenance of each branch.
 */
export function maybeAutoApproveStatus(host: ApprovalGateHost, adapterStatus: any, now = Date.now()): boolean {
    // launch-args modes grant approval in the CLI process itself and must never
    // enter the PTY modal parser/fire/settle/mask/nudge subsystem.
    if (!host.shouldUsePtyAutoApprove()) {
        resetPtyAutoApproveState(host);
        return false;
    }
    // Manual-attendance suppression: a human actively driving this session keeps
    // the modal visible; clear any in-progress settle gate and arm a re-check for
    // the attendance lapse (the PTY may be silent and never re-drive us).
    if (adapterStatus?.status === 'waiting_approval'
        && host.shouldUsePtyAutoApprove()
        && host.manualAttendance.isAttended(now)) {
        host.lastAutoApprovalSignature = '';
        host.pendingAutoApprovalSignature = '';
        host.pendingAutoApprovalSince = 0;
        host.autoApproveInactiveSince = 0;
        host.autoApproveMaskSince = 0;
        host.stalledApprovalNudgeEpisode = 0;
        host.autoApproveLastModalSeenAt = 0;
        armSettleRecheck(host, host.manualAttendance.remainingMs(now) + 20);
        return false;
    }
    const autoApproveActive = adapterStatus?.status === 'waiting_approval' && host.shouldUsePtyAutoApprove();
    if (!autoApproveActive) {
        host.lastAutoApprovalSignature = '';
        // Hysteresis: a momentary status blip while the same modal's buttons are
        // on screen must not wipe the settle clock (Fix B widens the window for
        // an active worker mask episode so a multi-second flap cycle survives).
        if (host.pendingAutoApprovalSince) {
            if (!host.autoApproveInactiveSince) host.autoApproveInactiveSince = now;
            const goneForMs = now - host.autoApproveInactiveSince;
            const continuityMs = autoApproveContinuityWindowMs(host);
            if (goneForMs < continuityMs) {
                armSettleRecheck(host, continuityMs - goneForMs + 20);
                return autoApproveActive;
            }
        }
        // Genuinely gone past the hysteresis window → episode over; clear the
        // settle gate AND the mask episode so a later approval starts fresh.
        host.pendingAutoApprovalSignature = '';
        host.pendingAutoApprovalSince = 0;
        host.autoApproveInactiveSince = 0;
        host.autoApproveMaskSince = 0;
        host.stalledApprovalNudgeEpisode = 0;
        host.autoApproveLastModalSeenAt = 0;
        if (host.autoApproveSettleTimer) { clearTimeout(host.autoApproveSettleTimer); host.autoApproveSettleTimer = null; }
        return autoApproveActive;
    }
    // Active approval observed — reset the inactivity tracker.
    host.autoApproveInactiveSince = 0;
    // STATUS-MISMATCH: the mask-stall clock measures the true age of the
    // unresolved episode; set only when zero so it survives signature changes.
    if (!host.autoApproveMaskSince) host.autoApproveMaskSince = now;
    // NOTIF-APPROVAL-MASKED (Q1b): single choke point that owns the mask clock.
    maybeEmitStalledApprovalNudge(host, adapterStatus, now);
    const modal = adapterStatus.activeModal;
    // Do not auto-approve when no concrete modal/buttons are present — a flapping
    // paint could otherwise type stray keys (the old resolveModal(-1) bug).
    const buttons = Array.isArray(modal?.buttons)
        ? modal.buttons.map((b: any) => String(b || '').trim()).filter(Boolean)
        : [];
    if (!modal || buttons.length === 0) {
        // AUTOAPPROVE-FLAP-RECUR (Fix A): buttons momentarily scrolled out of the
        // captured frame. Keep the gate warm within the continuity window; only a
        // modal empty PAST the window is a genuine close.
        const blipForMs = host.autoApproveLastModalSeenAt ? now - host.autoApproveLastModalSeenAt : Infinity;
        if (host.pendingAutoApprovalSince && blipForMs < autoApproveContinuityWindowMs(host)) {
            armSettleRecheck(host, autoApproveContinuityWindowMs(host) - blipForMs + 20);
            return autoApproveActive;
        }
        if (blipForMs >= autoApproveContinuityWindowMs(host)) {
            // Genuine close (or never captured): reset the per-signature settle
            // gate; the mask clock keeps running so a never-captured worker modal
            // still surfaces via the stall nudge.
            host.pendingAutoApprovalSignature = '';
            host.pendingAutoApprovalSince = 0;
        }
        return autoApproveActive;
    }
    // Concrete modal captured — stamp last-good-modal so a scroll-out blip can be
    // told apart from a genuine close (Fix A).
    host.autoApproveLastModalSeenAt = now;
    // Picker/confirm exclusion: two independent gates (modal_kind + structural
    // affirmative/decline anchors) must BOTH pass; APPROVAL-PICKER-MISROUTE keeps
    // a mis-routed consent modal alive by requiring a genuine SELECTION picker
    // with no consent structure before bailing on the kind label alone.
    const modalKind = typeof modal?.kind === 'string' ? modal.kind : 'approval';
    if (modalKind !== 'approval') {
        const modalText = `${String(modal?.title || '')}\n${String(modal?.message || '')}\n${buttons.join('\n')}`;
        const looksLikeSelectionPicker = /Select (?:a |an )?(?:model|mode|option)\b|Switch between/i.test(modalText);
        const looksLikeConsent = looksLikeActiveApprovalPromptText(modalText)
            || /Do you want to (?:proceed|create|make|edit|apply|run|delete|modify|allow)\b|allow all edits\b|don'?t ask again\b/i.test(modalText)
            || hasNegativeApprovalOption(buttons)
            || hasReliableApprovalAffirmative(buttons);
        if (looksLikeSelectionPicker && !looksLikeConsent) {
            // Genuine /model or /mode picker — no safe default; leave for the user.
            return autoApproveActive;
        }
    }
    const { index: buttonIndex, label: buttonLabel } = pickApprovalButton(buttons, host.provider as any);
    // Structural decline anchor (#137): a tall diff can scroll "3. No" off-frame;
    // a scoped grant-affirmative only appears in genuine consent modals and
    // stands in as the second anchor.
    const hasReliableConsentAnchor = hasNegativeApprovalOption(buttons)
        || hasReliableApprovalAffirmative(buttons);
    if (buttonIndex < 0 || !hasReliableConsentAnchor) {
        return autoApproveActive;
    }
    // Identity signature: question + stable affirmative anchor only (no seq, no
    // raw button set) — seq flap / button repaints of the SAME modal keep ONE
    // settle clock (AUTOAPPROVE-SETTLE-FLAP).
    const affirmativeAnchor = normalizeApprovalLabel(buttonLabel);
    const modalSignature = approvalModalSignature(modal?.message, affirmativeAnchor);
    // Busy-window re-entry guard DOES need the seq: two distinct back-to-back
    // approvals can carry identical text; the FSM bumps the seq per fresh entry.
    const approvalEntrySeq = typeof adapterStatus?.approvalEntrySeq === 'number'
        ? adapterStatus.approvalEntrySeq
        : 0;
    const busySignature = `${approvalEntrySeq}::${modalSignature}`;
    if (host.autoApproveBusy && busySignature === host.lastAutoApprovalSignature) {
        return autoApproveActive;
    }

    // Settle gate: fire only once this identity has been stable for the window.
    if (modalSignature !== host.pendingAutoApprovalSignature) {
        host.pendingAutoApprovalSignature = modalSignature;
        host.pendingAutoApprovalSince = now;
    }
    const settledForMs = now - host.pendingAutoApprovalSince;
    if (settledForMs < APPROVAL_SETTLE_MS) {
        armSettleRecheck(host, APPROVAL_SETTLE_MS - settledForMs + 20);
        return autoApproveActive;
    }

    // Settled — fire the approve key.
    if (host.autoApproveSettleTimer) { clearTimeout(host.autoApproveSettleTimer); host.autoApproveSettleTimer = null; }
    host.autoApproveBusy = true;
    host.lastAutoApprovalSignature = busySignature;
    host.pendingAutoApprovalSignature = '';
    host.pendingAutoApprovalSince = 0;
    host.autoApproveInactiveSince = 0;
    // Fired (resolveModal in flight) — the episode resolved; end the mask clock.
    host.autoApproveMaskSince = 0;
    host.stalledApprovalNudgeEpisode = 0;
    host.autoApproveLastModalSeenAt = 0;
    if (host.autoApproveBusyTimer) clearTimeout(host.autoApproveBusyTimer);
    host.autoApproveBusyTimer = setTimeout(() => {
        host.autoApproveBusy = false;
        host.autoApproveBusyTimer = null;
        host.lastAutoApprovalSignature = '';
    }, APPROVAL_FIRE_BUSY_WINDOW_MS);
    host.recordAutoApproval(modal?.message, buttonLabel, now);
    // APPROVAL-INBOX-BLINDSPOT (Fix A) + BUTTON-INDEX-MISMAP (Fix C): stamp the
    // local-resolution clock ONLY when the click actually matched a button, so a
    // never-pressed modal is forwarded to the coordinator, not suppressed.
    host.lastAutoApproveFiredAt = now;
    setTimeout(() => {
        const adapter = host.adapter;
        if (typeof adapter.resolveModalMatched === 'function') {
            const matched = adapter.resolveModalMatched(buttonIndex);
            if (!matched) {
                if (host.lastAutoApproveFiredAt === now) host.lastAutoApproveFiredAt = 0;
                LOG.warn('CLI', `[${host.type}] auto-approve resolveModal matched no button (index ${buttonIndex}) — surfacing approval to coordinator`);
            }
        } else {
            adapter.resolveModal?.(buttonIndex);
        }
    }, 0);
    return autoApproveActive;
}

/**
 * AUTOAPPROVE-FLAP-INBOX-MISSING sticky-approval overlay. Returns the adapterStatus a
 * flap-prone claude-cli approval SHOULD present this frame — either the raw status
 * unchanged, or, when the raw status has momentarily flapped OFF a recently-dominant
 * concrete approval, a synthetic `waiting_approval` re-presenting the cached modal.
 *
 * Records the concrete approval whenever the raw status is waiting_approval WITH
 * buttons. On a subsequent non-approval frame (the spec `approval→busy` flap), if that
 * concrete approval was seen within APPROVAL_STICKY_FLAP_MS AND the engine has NOT
 * resolved a modal since (lastApprovalResolvedAt not advanced past the sticky start),
 * overlay the cached modal + waiting_approval so the inbox / auto-approve / mesh_approve
 * all see the stable approval. A genuine resolution (auto-approve or mesh_approve fires
 * resolveModal → lastApprovalResolvedAt advances) clears the sticky immediately, so a
 * legitimate post-approval resume is NEVER masked as a lingering approval. Bounded by the
 * window, and scoped to autonomous mesh sessions (a foreground/attended or non-mesh
 * session, where a human answers the prompt, is returned untouched).
 */
export function stabilizeFlappingApprovalStatus(host: ApprovalGateHost, adapterStatus: any, now = Date.now()): any {
    // Only autonomous auto-approving mesh sessions are subject to the delegated flap;
    // never overlay for attended/foreground/non-mesh sessions.
    if (!host.isAutonomousMeshSession() || !host.shouldUsePtyAutoApprove()) return adapterStatus;

    const rawStatus = adapterStatus?.status;
    const resolvedAt = typeof (host.adapter as any)?.lastApprovalResolvedAt === 'number'
        ? (host.adapter as any).lastApprovalResolvedAt as number
        : 0;

    if (rawStatus === 'waiting_approval') {
        // A concrete modal this frame refreshes the sticky anchor; an approval frame
        // with buttons momentarily scrolled out is left to the existing settle-gate
        // hysteresis (we do not touch it — status is already waiting_approval).
        if (hasNonEmptyCliModalButtons(adapterStatus?.activeModal)) {
            host.approvalStickyLastConcreteAt = now;
            host.approvalStickyModal = adapterStatus.activeModal;
            host.approvalStickyEntrySeq = typeof adapterStatus?.approvalEntrySeq === 'number'
                ? adapterStatus.approvalEntrySeq
                : host.approvalStickyEntrySeq;
        }
        return adapterStatus;
    }

    // Non-approval frame. TERMINAL-STALE-APPROVAL: once a GENUINE completion for the
    // current turn has been emitted (no new busy phase since), the turn is OVER — the
    // cached sticky modal is stale by construction and must not re-pin waiting_approval
    // onto getState / detectStatusTransition (the late agent:waiting_approval it would
    // emit re-pins every coordinator projection with an approval no mesh_approve can
    // resolve — "Not in approval state"). Drop the sticky anchor and report the raw
    // status. A NEW current concrete modal still surfaces via the raw branch above.
    if (host.approvalStickyLastConcreteAt > 0 && host.hasEmittedGenuineCompletionForCurrentEpoch()) {
        host.approvalStickyLastConcreteAt = 0;
        host.approvalStickyModal = null;
        host.approvalStickyEntrySeq = 0;
    }

    // Non-approval frame. Overlay only if a concrete approval was dominant within the
    // window AND no resolution has happened since the sticky anchor (a resolveModal
    // advances lastApprovalResolvedAt to at/after the anchor → the flap is really a
    // genuine resume, so drop the sticky and report the raw status).
    if (host.approvalStickyLastConcreteAt > 0 && host.approvalStickyModal) {
        const withinWindow = (now - host.approvalStickyLastConcreteAt) < APPROVAL_STICKY_FLAP_MS;
        const resolvedSinceAnchor = resolvedAt >= host.approvalStickyLastConcreteAt;
        if (withinWindow && !resolvedSinceAnchor) {
            return {
                ...adapterStatus,
                status: 'waiting_approval',
                activeModal: host.approvalStickyModal,
                ...(host.approvalStickyEntrySeq ? { approvalEntrySeq: host.approvalStickyEntrySeq } : {}),
                approvalStickyOverlay: true,
            };
        }
        // Window lapsed or a resolution landed — clear the sticky so a later approval
        // re-anchors from scratch and a genuine resume surfaces immediately.
        host.approvalStickyLastConcreteAt = 0;
        host.approvalStickyModal = null;
        host.approvalStickyEntrySeq = 0;
    }
    return adapterStatus;
}
