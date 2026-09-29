/**
 * Modal-park / approval-recency judgments of a CLI provider instance: whether
 * the session is parked on a human-await modal (and so excluded from mesh
 * drain / force-inject), whether an approval was resolved locally, and the
 * post-approval resume grace — plus the hot chat-state projection (which masks
 * an auto-approving modal) and the approval audit-record messages.
 *
 * Split out of cli-provider-instance.ts (file-size gate). Functions take the
 * instance through the compiler-checked {@link ModalParkHost} view.
 */
import { isCliGeneratingLikeStatus } from './cli-provider-status-helpers.js';
import { APPROVAL_LOCAL_RESOLUTION_COOLDOWN_MS, APPROVAL_RESUME_GRACE_MS } from './cli-provider-instance-constants.js';
import type { CliProviderInstance } from './cli-provider-instance.js';
import type { HotChatSessionState } from './provider-instance.js';
import { formatAutoApprovalMessage } from './approval-utils.js';

/** The CliProviderInstance members these functions read or call (compiler-checked; no cast). */
export type ModalParkHost = Pick<CliProviderInstance, 'activeInteractivePrompt' | 'adapter' | 'autoApproveEffectivelyActive' | 'autoApproveMaskStalled' | 'hasAdapterPendingResponse' | 'isAutonomousMeshSession' | 'isModalParked' | 'isTransientToolConsent' | 'lastAutoApproveFiredAt' | 'manualAttendance' | 'shouldUsePtyAutoApprove'>;

/**
 * The resolved modal-park status of this session, or null when it is not
 * parked on a modal awaiting a human answer. Mirrors the overlay logic in
 * getState(): an active AskUserQuestion interactive prompt resolves to
 * waiting_choice; otherwise the adapter's waiting_approval (tool consent)
 * counts — UNLESS auto-approve will dismiss it, in which case the session is
 * effectively generating and is NOT modal-parked. This is the single signal
 * the mesh force-inject guard consults, and the same status string the
 * reconcile loop reads off get_status_metadata. Lowercase literals only —
 * the SessionStatus enum is forked across modules and waiting_choice is
 * absent from some of them.
 */
export function resolveModalParkStatus(host: ModalParkHost): 'waiting_choice' | 'waiting_approval' | null {
    if (host.activeInteractivePrompt) return 'waiting_choice';
    let adapterStatus: { status?: string };
    try {
        adapterStatus = host.adapter.getStatus({ allowParse: false });
    } catch {
        return null;
    }
    // A session whose auto-approve is held by manual attendance IS parked on a
    // modal awaiting the human — autoApproveEffectivelyActive folds that in, so
    // the mesh force-inject guard correctly treats it as modal-parked. STATUS-MISMATCH:
    // a STALLED auto-approve (never resolving) is likewise effectively parked — treat it
    // as modal-parked so its events are held/surfaced rather than masked behind generating.
    if (adapterStatus.status === 'waiting_approval'
        && (!host.autoApproveEffectivelyActive(adapterStatus.status) || host.autoApproveMaskStalled())) {
        // NOTIF-HELD-DRAIN (Fix 1): an autonomous mesh session (coordinator or worker)
        // that is actively progressing a turn — a tool call is in flight
        // (hasAdapterPendingResponse) and NO human is attending it by hand — surfaces a
        // routine tool-consent `waiting_approval` on EVERY tool call when auto-approve is
        // off. That transient consent is part of the turn the harness/operator drives to
        // completion, NOT a session genuinely wedged awaiting a human's modal answer.
        // Classifying it modal-parked makes findLiveCoordinators hold the mesh's pending
        // completion events under `modal_parked` across a busy coordinator's whole work
        // batch, which is the multi-minute notification stall. Treat such a transient
        // consent as NOT modal-parked so it is held as ordinary "generating" (released on
        // the next idle) instead. A manually-attended session, a stalled auto-approve, or a
        // non-progressing session (no turn in flight) still parks — those are the genuine
        // human-await cases the guard must keep holding.
        if (host.isTransientToolConsent()) {
            return null;
        }
        return 'waiting_approval';
    }
    return null;
}

/**
 * APPROVAL-INBOX-BLINDSPOT (Fix A): true when this session's approval modal was — or is
 * being — resolved LOCALLY within the recent cooldown. Two independent positive signals:
 *   (1) auto-approve fired its resolveModal within APPROVAL_LOCAL_RESOLUTION_COOLDOWN_MS
 *       (lastAutoApproveFiredAt), or
 *   (2) the underlying adapter reports isApprovalRecentlyResolved() — its own resolve
 *       cooldown, which also covers a dashboard / mesh_approve resolution.
 * The mesh event forwarder uses this to decide whether an agent:waiting_approval from an
 * auto-approving worker can be safely SUPPRESSED (a local resolution is in flight) or must
 * be FORWARDED (auto-approve is configured but has NOT actually resolved this modal, so the
 * coordinator/inbox must be told). Keying suppression on real resolution — not just the
 * autoApprove *intent* — is the blind-spot fix: a never-resolving worker approval is no
 * longer silently dropped.
 */
export function approvalRecentlyResolvedLocally(host: ModalParkHost, now = Date.now()): boolean {
    if (host.lastAutoApproveFiredAt
        && now - host.lastAutoApproveFiredAt < APPROVAL_LOCAL_RESOLUTION_COOLDOWN_MS) {
        return true;
    }
    try {
        return host.adapter.isApprovalRecentlyResolved() === true;
    } catch { /* adapter gone / transient */ }
    return false;
}

/**
 * NOTIF-HELD-DRAIN: true when this `waiting_approval` is a routine, transient tool-consent
 * of an autonomously-progressing mesh session rather than a genuine human-await modal —
 * i.e. it is a mesh coordinator/worker session, a turn is actively in flight
 * (hasAdapterPendingResponse), and no human is attending it by hand. Such a consent is
 * driven to resolution by the harness/operator as part of the in-flight turn, so holding
 * the mesh's completion events behind it (modal_parked) is the false-positive that stalls
 * delivery. Narrow by design: manual attendance or a non-progressing session falls through
 * to the genuine-modal classification.
 */
export function isTransientToolConsent(host: ModalParkHost, now = Date.now()): boolean {
    return host.isAutonomousMeshSession()
        && host.hasAdapterPendingResponse()
        && !host.manualAttendance.isAttended(now);
}

/**
 * PTY-OVERTRUST-DRAIN (Defect B). The deliverability/drain status the mesh
 * reconcile loop must consult — the RAW adapter turn-state, with the
 * auto-approve "hold-idle" visual mask STRIPPED.
 *
 * getState().status overlays `autoApproveHoldIdle`/`autoApproveActive` to paint a
 * genuinely-idle adapter as `generating` (a UI-flicker suppression while an
 * auto-approve key-press settles — see getState() ~:800). That mask is correct
 * for the dashboard, but the reconcile loop trusts it as "the coordinator is
 * busy" and therefore HOLDS a worker's completion under
 * `generating_no_idle_coordinator` even though the coordinator's PTY is at a real
 * turn end and would accept the inject as a turn — the completion is stranded.
 *
 * This accessor reports the drain truth instead:
 *   - 'modal_parked' — a GENUINE human-await modal (AskUserQuestion / a non-
 *     transient tool-consent). Still excluded from drain (a force-inject here
 *     writes raw keystrokes the modal eats → data corruption). Mirrors
 *     isModalParked(), evaluated first so a parked session never reads idle.
 *   - 'idle' — the RAW adapter is at a turn end (adapter.getStatus(allowParse:false)
 *     === 'idle') and the session is not modal-parked. Drain-eligible REGARDLESS
 *     of the auto-approve mask. This is the case the mask used to hide.
 *   - 'generating' — the raw adapter is genuinely mid-turn. Held (a raw PTY write
 *     into a generating claude-cli is not consumed as a turn → data loss). The
 *     intentional removal of force-inject-into-generating is preserved.
 *   - 'other' — any other raw status (error / starting / waiting_choice handled by
 *     modal-park above). Not a drain target.
 *
 * Uses allowParse:false (engine.activeModal only, side-effect-free) so it never
 * mutates the very auto-approve mask state the diagnostics read.
 */
export function getDrainStatus(host: ModalParkHost): 'idle' | 'generating' | 'modal_parked' | 'other' {
    if (host.isModalParked()) return 'modal_parked';
    let rawStatus: string;
    try {
        const raw = host.adapter.getStatus({ allowParse: false })?.status;
        rawStatus = typeof raw === 'string' ? raw.trim() : '';
    } catch {
        return 'other';
    }
    if (rawStatus === 'idle') return 'idle';
    if (isCliGeneratingLikeStatus(rawStatus)) return 'generating';
    return 'other';
}

/**
 * FALSE-IDLE: are we inside the post-approval resume grace window? True when this
 * is an autonomous auto-approving mesh session AND the engine resolved a modal
 * (auto-approve / mesh_approve) within APPROVAL_RESUME_GRACE_MS. This is the single
 * "auto-approve recency" judgment shared by Fix 1 (the SETTLE-VALLEY completion
 * hold below) and Fix 2 (the FSM-level applyIdle hysteresis in cli-state-engine).
 *
 * Scoped to autonomous auto-approving sessions so a foreground/attended session,
 * or a session with auto-approve off (whose approvals a human answers), is never
 * held. The recency clock (adapter.getLastApprovalResolvedAt()) is 0 until the first
 * resolveModal, so a plain turn that never saw an approval always returns false.
 */
export function inApprovalResumeGrace(host: ModalParkHost, now = Date.now()): boolean {
    if (!host.isAutonomousMeshSession() || !host.shouldUsePtyAutoApprove()) return false;
    const resolvedAt = host.adapter.getLastApprovalResolvedAt();
    if (resolvedAt <= 0) return false;
    return (now - resolvedAt) < APPROVAL_RESUME_GRACE_MS;
}

/**
 * Whether auto-approve should be treated as active *right now* for display
 * and firing decisions: the configured intent AND the user is not currently
 * attending this session by hand. When a human is attending, auto-approve is
 * held so the modal stays visible and they can drive it via the controlbar.
 * Provider-agnostic — the attendance signal is the command set, never any
 * CLI-specific modal text.
 */
export function autoApproveEffectivelyActive(host: ModalParkHost, status: string | undefined, now = Date.now()): boolean {
    return status === 'waiting_approval'
        && host.shouldUsePtyAutoApprove()
        && !host.manualAttendance.isAttended(now);
}

/** What the hot-state / approval-record helpers read or call (compiler-checked; no cast). */
export type ApprovalRecordHost = Pick<CliProviderInstance, 'adapter' | 'appendRuntimeSystemMessage' | 'autoApproveBusy' | 'autoApproveEffectivelyActive' | 'autoApproveMaskStalled' | 'instanceId'>;

export function getHotChatSessionState(host: ApprovalRecordHost): HotChatSessionState {
    const adapterStatus = host.adapter.getStatus({ allowParse: false });
    const nowMs = Date.now();
    // STATUS-MISMATCH: drop the mask once the auto-approve episode has stalled (see getState).
    const autoApproveActive = host.autoApproveEffectivelyActive(adapterStatus.status, nowMs)
        && !host.autoApproveMaskStalled(nowMs);
    const autoApproveHoldIdle = host.autoApproveBusy && adapterStatus.status === 'idle';
    const visibleStatus = autoApproveActive || autoApproveHoldIdle ? 'generating' : adapterStatus.status;
    const runtime = host.adapter.getRuntimeMetadata();
    return {
        id: host.instanceId,
        status: visibleStatus,
        runtimeLifecycle: runtime?.lifecycle ?? null,
        runtimeSurfaceKind: runtime?.surfaceKind,
        runtimeRestoredFromStorage: runtime?.restoredFromStorage === true,
        runtimeRecoveryState: runtime?.recoveryState ?? null,
    };
}

export function recordAutoApproval(host: ApprovalRecordHost, modalMessage?: string, buttonLabel?: string, now = Date.now()): void {
    host.appendRuntimeSystemMessage(
        formatAutoApprovalMessage(modalMessage, buttonLabel),
        `auto_approval:${now}:${buttonLabel || 'approve'}`,
        now,
    );
}

export function recordApprovalSelection(host: ApprovalRecordHost, buttonText: string): void {
    const cleanButton = String(buttonText || '').trim();
    if (!cleanButton) return;
    const now = Date.now();
    host.appendRuntimeSystemMessage(
        `Approval selected: ${cleanButton}`,
        `approval_selection:${now}:${cleanButton}`,
        now,
    );
}
