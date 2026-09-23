/**
 * SpecCliAdapter status projection — the pure FSM-state → CliAdapterStatus map.
 *
 * Extracted from cli-adapter.ts as a barrier-preserving pure move (no behaviour
 * change): the adapter had reached the 2,400-line file-size gate, and this was
 * the one genuinely self-contained unit in it — a total function of the
 * adapter's latched status fields with no I/O, no timers and no mutation. The
 * adapter keeps the side effects (refreshWirePendingQuestion,
 * maybeConfirmLiveAuthBillingSuspect, maybeRefreshNativeHistory) and calls this
 * for the decision itself.
 *
 * Ordering here is load-bearing and each branch's rationale is stated at the
 * branch. The short version, highest precedence first:
 *
 *   error → stopped → starting(not spawned) → starting(no state)
 *     → approval → waiting_external → starting(not ready) → generating → idle
 */
'use strict';

import type { CliAdapterStatus } from '../../cli-adapter-types.js';
import type { FsmStatus } from './fsm-types.js';

/** The latched adapter facts this projection reads. Deliberately a plain data
 *  bag rather than the adapter itself: it keeps the function total and testable,
 *  and makes it impossible for a future edit to reach for adapter I/O here. */
export interface AdapterStatusInputs {
    providerSessionId: string | undefined;
    providerFailure: { message: string; errorReason?: string } | null | undefined;
    exited: boolean;
    spawned: boolean;
    activeInteractivePrompt: CliAdapterStatus['activeInteractivePrompt'];
    state: { id: string; label: string; title: string | null; status: FsmStatus } | null;
    modal: {
        title: string | null;
        buttons: { index: number; label: string }[];
        kind?: 'approval' | 'picker' | 'confirm' | null;
    } | null;
    /**
     * `driver.hasSeenReady?.()` — undefined for stub/legacy drivers with no such
     * surface, which are treated as "not gated" (see the branch below).
     *
     * ★A THUNK, not a value, and that is load-bearing. In the original inline
     * code this was read only AFTER the error / stopped / not-spawned / no-state
     * early returns, so those returns shielded it from an adapter that has no
     * `driver` at all — which several provider-failure tests construct, and
     * which a real adapter also is before spawn. Passing an eagerly-evaluated
     * boolean reintroduced a `Cannot read properties of undefined` crash on
     * exactly the auth/billing-failure path that must stay reliable. Deferring
     * the read preserves the original evaluation ORDER through the extraction.
     */
    readySeen: () => boolean | undefined;
    /**
     * Wiring-unification A5-3: the driver's raw PTY output clock and rendered
     * screen-change clock (ms wall-clock; `undefined` when the driver has no
     * such surface, 0 when it has one but nothing has been observed yet).
     * Plain values, not thunks: the adapter reads them with optional chaining
     * so a driverless adapter (provider-failure tests, pre-spawn) is safe, and
     * they are carried on EVERY branch — a stopped session's last-output time
     * is exactly what the termination bridge's `silentForMs` wants.
     */
    lastOutputAt: number | undefined;
    lastScreenChangeAt: number | undefined;
}

/** A clock is surfaced only once it has ticked: 0 / undefined / non-finite all
 *  mean "never observed", and consumers already treat absence that way
 *  (mesh-stall-watchdog anchors on startedAt when the field is missing). */
function clockField<K extends 'lastOutputAt' | 'lastScreenChangeAt'>(key: K, value: number | undefined): Partial<Record<K, number>> {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? ({ [key]: value } as Partial<Record<K, number>>)
        : {};
}

export function projectAdapterStatus(input: AdapterStatusInputs): CliAdapterStatus {
    const sessionFields = input.providerSessionId ? { providerSessionId: input.providerSessionId } : {};
    const base = {
        messages: [] as never[],
        activeModal: null,
        activeInteractivePrompt: input.activeInteractivePrompt,
        ...sessionFields,
        ...clockField('lastOutputAt', input.lastOutputAt),
        ...clockField('lastScreenChangeAt', input.lastScreenChangeAt),
    };

    // A latched provider failure (auth/billing/quota) outranks generic process liveness.
    // Returning `error` makes CliProviderInstance emit agent:stopped with the
    // typed reason, rather than allowing an idle/exit edge to masquerade as a
    // zero-byte completion or a generic crash eligible for blind recovery.
    if (input.providerFailure) {
        return {
            ...base,
            status: 'error',
            errorMessage: input.providerFailure.message,
            errorReason: input.providerFailure.errorReason,
        };
    }
    if (input.exited) return { ...base, status: 'stopped' };
    if (!input.spawned) return { ...base, status: 'starting' };

    const state = input.state;
    if (!state) return { ...base, status: 'starting' };

    // The FSM state is authoritative for status. We do NOT infer status from whether
    // a modal was parsed this frame: a modal/approval state whose buttons briefly fail
    // to parse (PTY repaint) must still report waiting_approval, not collapse to idle —
    // that collapse fired false completions while a session sat at an approval prompt.
    const modal = input.modal;
    if (state.status === 'approval') {
        return {
            ...base,
            status: 'waiting_approval',
            // Surface buttons when we have them; an approval state with no parsed
            // modal this frame still stays waiting_approval (no activeModal yet).
            // `kind` carries the semantic modal class through to the auto-approve
            // gate so a /model picker (kind='picker') is never auto-answered.
            // BUTTON-INDEX-MISMAP (Fix C.1): keep `buttons` as the label list every
            // existing consumer (pickApprovalButton, mesh_approve, auto-approve) reads,
            // but ALSO surface `buttonMeta` carrying each button's real FSM display index
            // alongside its label. A partial/non-contiguous modal (display indices [1,3,4]
            // at array positions [0,1,2]) then no longer loses the index → label mapping
            // once it leaves the adapter: a consumer that has an array position can recover
            // the true FSM index without re-parsing. SpecCliAdapter.resolveModal relies on
            // the same ordered list to translate an array position to the correct FSM index.
            activeModal: modal
                ? {
                    message: modal.title ?? state.label,
                    buttons: modal.buttons.map(b => b.label),
                    buttonMeta: modal.buttons.map(b => ({ index: b.index, label: b.label })),
                    kind: modal.kind ?? null,
                }
                : null,
        };
    }

    // APPROVAL-WAIT-BLINDSPOT (live defect, 2026-09-22): `waiting_external` (see
    // FsmState.status for the full rationale) means the session is blocked on a
    // HUMAN acting outside the terminal — a browser OAuth login, a 2FA tap. It
    // projects to `waiting_approval`, the coarse "a person must act before this
    // continues" class the rest of the stack already understands. That buys
    // three things the previous encodings could not: the session appears in
    // mesh_list_pending_approvals so the coordinator can SEE it; the mesh stall
    // watchdog re-arms instead of firing monitor:no_progress and reaping a task
    // that was only waiting for a login; and the dashboard stops reporting it as
    // busy work.
    //
    // ★Must stay ABOVE the readySeen gate. A login screen appears during boot —
    // before the FSM has ever drawn a ready prompt — so that gate would mask it
    // as 'starting' and restore exactly the invisibility this fixes. Same reason
    // the approval branch above sits there: approval-class states must remain
    // visible during boot, and an external-auth wait is approval-class.
    //
    // activeModal is null by construction: a waiting_external state is not modal
    // and declares no extract.buttons, so nothing is parsed — which is also what
    // keeps the auto-approve gate inert here (it requires buttons to press).
    if (state.status === 'waiting_external') {
        return { ...base, status: 'waiting_approval' };
    }

    // Until the FSM has drawn a genuine non-initial idle prompt, do NOT
    // project the initial state's declared status (often `idle`) or a
    // boot-phase generating state (antigravity `signing_in`) onto the
    // daemon status machine. Projecting idle consumes the starting→idle
    // agent:ready one-shot before the prompt exists; projecting generating
    // arms a false generating_started (signing_in lasting >3s) that never
    // completes — no assistant text — so the dashboard/claim freeze as
    // generating (M-MESH-INFRA-0829). Hold at 'starting' until
    // maybeMarkReady. Missing hasSeenReady (stub/legacy drivers) is
    // treated as "not gated" so existing tests and non-FSM adapters keep
    // their previous projection.
    const readySeen = input.readySeen();
    if (readySeen === false) {
        return { ...base, status: 'starting', fsmReadySeen: false };
    }
    if (state.status === 'generating') {
        return { ...base, status: 'generating' };
    }
    // fsmReadySeen lets CliProviderInstance re-arm the queue-claim agent:ready
    // on the first genuine ready (prompt drawn), independent of the boot-time
    // starting→idle one-shot that the provider-instance otherwise relies on.
    // Surfaced only on idle so the provider-instance fires agent:ready exactly
    // when the worker is actually ready to claim.
    return { ...base, status: 'idle', fsmReadySeen: readySeen === true };
}
