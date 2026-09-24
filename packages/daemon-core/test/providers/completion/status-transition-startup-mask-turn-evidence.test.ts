/**
 * F2 (wiring-unification follow-up, live 2026-09-25): the first real turn
 * after an auto-approve-masked STARTUP prompt (e.g. a "trust this folder?"
 * consent modal shown before any task was ever dispatched) produced NO turn
 * evidence at all — no `turn_started`, no `turn_end`, no
 * `agent:generating_started` / `agent:generating_completed`.
 *
 * Root cause: `maybeAutoApproveStatus`'s mask (`autoApproveActive ||
 * autoApproveHoldIdle` collapsing the visible status to 'generating') exists
 * to protect an IN-PROGRESS turn's UI from a momentary blip, but it applied
 * unconditionally — including to a startup consent modal where NO turn has
 * ever started (generatingStartedAt === 0) and none is in flight
 * (hasAdapterPendingResponse() false). The masked starting→generating (then
 * waiting_approval→generating-again across the resolve sequence) edge did not
 * match the `idle→generating` arm (lastStatus wasn't 'idle') nor the
 * `startingToGeneratingWithActiveTurn` arm (no real turn), so it fell through
 * to the bare `host.lastStatus = newStatus` update, pinning `lastStatus` at
 * 'generating' with generatingStartedAt left at 0. Because the adapter's own
 * FSM does not re-fire onChange once it settles quietly at idle, nothing ever
 * revisited that stale value — so when the user's FIRST real message later
 * drove the adapter genuinely idle→generating, the tick saw
 * generating→generating (no edge) and the idle→generating arm — the only
 * place that arms generatingStartedAt, the debounce, and turn_started
 * evidence — never ran.
 *
 * The fix (status-transition.ts `startupMaskWithNoActiveTurn`): skip the mask
 * whenever generatingStartedAt === 0 (no turn has ever started this boot) AND
 * hasAdapterPendingResponse() is false, letting the tick observe the real
 * rawStatus across the whole startup sequence so lastStatus tracks correctly
 * and never gets stuck.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runStatusTransitionTick, type StatusTransitionHost } from '../../../src/providers/completion/status-transition.js';
import { createTurnEvidencePort } from '../../../src/providers/turn-evidence-port.js';
import type { ProviderModule } from '../../../src/providers/contracts.js';
import type { TurnEvidence } from '@adhdev/mesh-shared';

const PROVIDER: ProviderModule = { type: 'claude-cli', name: 'Claude Code', category: 'cli' } as ProviderModule;

type FakeAdapterState = {
    rawStatus: string;
    activeModal: { message?: string; buttons?: string[]; kind?: string } | null;
    activeInteractivePrompt: any;
};

/**
 * A harness that models the live sequence precisely enough to exercise the
 * mask: `maybeAutoApproveStatus` and `hasAdapterPendingResponse` are both
 * driven by mutable test state (not fixed stubs), exactly like the two real
 * collaborators status-transition.ts reads through the host.
 */
function makeHarness() {
    const pushed: any[] = [];
    const evidence: TurnEvidence[] = [];
    const evidenceOpts: any[] = [];
    const completions: any[] = [];
    const port = createTurnEvidencePort({ observe: (e, o) => { evidence.push(e); evidenceOpts.push(o); } });

    const state: FakeAdapterState = {
        rawStatus: 'starting',
        activeModal: null,
        activeInteractivePrompt: null,
    };
    let pendingResponse = false;
    // Mirrors approval-gate.ts's autoApproveBusy semantics closely enough for
    // this test: `autoApproveActive` fires true exactly once per consent
    // modal (fire-and-mask), `autoApproveBusy` (read by autoApproveHoldIdle)
    // stays true until the test explicitly clears it (modeling the real
    // APPROVAL_FIRE_BUSY_WINDOW_MS timer elapsing).
    let autoApproveFiresNext = false;

    const host: StatusTransitionHost & Record<string, unknown> = {
        type: 'claude-cli',
        instanceId: 'inst-f2',
        workingDir: '/work/adhdev',
        provider: PROVIDER,
        adapter: {
            getStatus: () => ({
                status: state.rawStatus,
                activeInteractivePrompt: state.activeInteractivePrompt,
                activeModal: state.activeModal,
            }),
            getScriptParsedStatus: () => null,
            // Set ONLY by the real onTurnStarted on a genuine inject, and
            // persists past completion — see status-transition.ts's
            // noTurnStartedThisBoot discriminator and (pre-existing)
            // maybeSynthesizeStartupGraceCollapse's identical use of the field.
            currentTurnTaskId: undefined as string | undefined,
        },
        monitor: { check: () => [] } as any,
        providerSessionId: undefined,
        turnEvidencePort: port,
        currentAttemptRef: () => ({ attemptId: 'attempt_f2', generation: 0 }),

        lastStatus: 'starting',
        generatingStartedAt: 0,
        generatingDebounceTimer: null,
        generatingDebouncePending: null,
        completedDebounceTimer: null,
        completedDebouncePending: null,
        busyEpoch: 0,
        autoApproveBusy: false,
        suppressIdleHistoryReplay: false,
        lastApprovalEventFingerprint: '',
        lastInteractivePromptEventKey: '',
        startupGraceCollapseAt: null,
        agentReadyEmitted: true, // boot one-shot already consumed — isolate this test to the mask bug
        errorMessage: undefined,
        errorReason: undefined,
        lastCompletionSummary: null,

        stabilizeFlappingApprovalStatus: (adapterStatus: any) => adapterStatus,
        promoteProviderSessionId: () => {},
        // Fires (returns true) exactly once per arranged consent modal — the
        // test drives `autoApproveFiresNext` the same way a real settle gate
        // would resolve after APPROVAL_SETTLE_MS.
        maybeAutoApproveStatus: () => {
            if (autoApproveFiresNext) {
                autoApproveFiresNext = false;
                (host as any).autoApproveBusy = true;
                return true;
            }
            return false;
        },
        hasAdapterPendingResponse: () => pendingResponse,
        fsmTraceOn: () => false,
        recordFsmTransitionTrace: () => {},
        completionTraceOn: () => false,
        recordCompletionGateTrace: () => {},
        pushEvent: (event: unknown) => { pushed.push(event); },
        appendRuntimeSystemMessage: () => {},
        completingTurnTaskId: () => undefined,
        isAutonomousMeshSession: () => false,
        isMeshWorkerSession: () => false,
        meshTraceCtx: () => ({}),
        completionFinalAssistantEvidence: () => ({ source: 'unavailable', messages: [] }) as any,
        completionHasFinalAssistantMessage: () => false,
        hasEmittedGenuineCompletionForCurrentEpoch: () => false,
        emitGeneratingCompleted: (opts: any) => { completions.push(opts); },
        markCurrentTurnStartupGraceCollapseSatisfied: () => {},
        maybeSynthesizeStartupGraceCollapse: () => false,
        // Flush synchronously (mirrors cli-provider-startup-grace-generating-miss.test.ts):
        // fire emitGeneratingCompleted immediately from the armed completedDebouncePending
        // so the test can assert without spinning the real settle timer.
        scheduleCompletedDebounceFlush: () => {
            const pending = (host as any).completedDebouncePending;
            if (!pending) return;
            (host as any).completedDebouncePending = null;
            completions.push({ ...pending, fromDebounce: true });
        },
        emitAgentReadyOnce: () => {},
        applyProviderResponse: () => {},
    };

    return {
        host,
        pushed,
        evidence,
        evidenceOpts,
        completions,
        setRawStatus: (s: string) => { state.rawStatus = s; },
        setModal: (m: FakeAdapterState['activeModal']) => { state.activeModal = m; },
        setPendingResponse: (v: boolean) => { pendingResponse = v; },
        // Models the real onTurnStarted stamping adapter.currentTurnTaskId on a
        // genuine inject (the daemon calls this the moment it dispatches a task,
        // ahead of/alongside setPendingResponse(true)).
        markTurnStartedThisBoot: (taskId = 'task-real-1') => { (host.adapter as any).currentTurnTaskId = taskId; },
        armAutoApproveFire: () => { autoApproveFiresNext = true; },
        clearAutoApproveBusy: () => { (host as any).autoApproveBusy = false; },
        tick: () => runStatusTransitionTick(host),
    };
}

function turnStartedEvidence(evidence: TurnEvidence[]): TurnEvidence[] {
    return evidence.filter((e) => e.kind === 'turn_started');
}

describe('runStatusTransitionTick — F2 startup auto-approve mask must not swallow the first real turn', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('REGRESSION: trust-modal auto-approved at startup (no active turn) does not pin lastStatus, and the FIRST real turn still gets turn_started/generating_completed evidence', () => {
        const h = makeHarness();

        // ── Startup: a "trust this folder?" consent modal is shown BEFORE any
        // task was ever dispatched (hasAdapterPendingResponse() false throughout). ──
        h.setPendingResponse(false);
        h.setRawStatus('waiting_approval');
        h.setModal({ message: 'Do you trust the files in this folder?', buttons: ['Yes, proceed', 'No, quit'] });
        h.armAutoApproveFire(); // maybeAutoApproveStatus fires the approve key this tick
        h.tick(); // starting → ??? (masked, live log: "auto_approve_mask")

        // FIXED: with no turn EVER started this boot (adapter.currentTurnTaskId
        // unset) and none in flight, the mask must NOT apply — the tick observes
        // the real rawStatus (waiting_approval) instead of getting pinned at a
        // masked 'generating'. The waiting_approval arm treats this as a genuine
        // (if short-lived) busy phase and arms generatingStartedAt — that alone
        // must NOT re-enable masking for the REST of the startup sequence (a
        // narrower guard keyed on generatingStartedAt would stop exempting here
        // and re-open the exact same hole one edge later — this is the case the
        // currentTurnTaskId discriminator exists to cover).
        expect(h.host.lastStatus).toBe('waiting_approval');
        expect(h.host.generatingStartedAt).toBeGreaterThan(0);

        // ── auto-approve resolves the modal; adapter genuinely settles idle,
        // but stays inside the busy window for a moment (autoApproveHoldIdle
        // would normally mask this back to 'generating' — it must NOT here,
        // since no real turn has started yet: currentTurnTaskId is still unset). ──
        h.setModal(null);
        h.setRawStatus('idle');
        h.tick(); // waiting_approval → idle — unmasked (still no real turn)

        expect(h.host.lastStatus).toBe('idle');

        // Busy window elapses (real code: autoApproveBusyTimer fires after
        // APPROVAL_FIRE_BUSY_WINDOW_MS) — no further adapter change, so no tick
        // fires here, matching the live "no further onChange" observation.
        h.clearAutoApproveBusy();

        // ── The user's FIRST real message arrives: genuine idle → generating.
        // The daemon dispatches the task (onTurnStarted stamps
        // adapter.currentTurnTaskId) and the adapter reports generating. ──
        h.setPendingResponse(true);
        h.markTurnStartedThisBoot();
        h.setRawStatus('generating');
        h.tick(); // idle → generating — MUST be a real edge now.

        expect(h.host.lastStatus).toBe('generating');
        expect(h.host.generatingStartedAt).toBeGreaterThan(0);
        expect(h.host.generatingDebouncePending).not.toBeNull();

        // Flush the generating_started debounce (3s in the real module).
        vi.advanceTimersByTime(3001);
        expect(h.pushed.some((e) => e.event === 'agent:generating_started')).toBe(true);
        expect(turnStartedEvidence(h.evidence).length).toBe(1);

        // ── The turn completes. ──
        h.setPendingResponse(false);
        h.setRawStatus('idle');
        h.tick(); // generating → idle — real completion, must NOT be suppressed as a startup blip.

        expect(h.host.lastStatus).toBe('idle');
        expect(h.completions.length).toBeGreaterThanOrEqual(1);
    });

    it('GUARD: a genuine boot blip with NO user input (no consent modal, no turn) is still suppressed as before', () => {
        // The AGY-BOOT-PHANTOM / EARLYNOTIFY-GATEBYPASS protection this fix must
        // not weaken: pure startup PTY noise with no consent modal and no
        // dispatched turn must still produce zero completion events.
        const h = makeHarness();
        h.setPendingResponse(false);

        h.setRawStatus('generating'); // benign startup repaint noise, no auto-approve involved
        h.tick(); // starting → generating (unarmed — no active turn, no mask either)

        expect(h.host.generatingStartedAt).toBe(0);
        expect(h.host.generatingDebouncePending).toBeNull();

        h.setRawStatus('idle');
        h.tick(); // generating → idle — suppressed startup-phase blip

        expect(h.host.lastStatus).toBe('idle');
        expect(h.completions.length).toBe(0);
        expect(turnStartedEvidence(h.evidence).length).toBe(0);
    });

    it('GUARD: a mid-turn approval blip (turn already started) still gets masked to generating, unaffected by the fix', () => {
        const h = makeHarness();

        // A real turn is underway: generatingStartedAt already armed via a
        // genuine idle → generating edge.
        h.setPendingResponse(true);
        h.setRawStatus('idle');
        h.tick(); // starting → idle (agent:ready)
        h.setRawStatus('generating');
        h.tick(); // idle → generating (arms generatingStartedAt)
        expect(h.host.generatingStartedAt).toBeGreaterThan(0);
        const armedAt = h.host.generatingStartedAt;

        // Mid-turn "Allow Bash command?" consent modal, auto-approved — the
        // mask exists exactly for this case and must still apply: the mid-turn
        // blip must not surface as a status flicker or reset turn bookkeeping.
        h.setRawStatus('waiting_approval');
        h.setModal({ message: 'Allow Bash command?', buttons: ['Yes', 'No'] });
        h.armAutoApproveFire();
        h.tick();

        // Masked: lastStatus must NOT visibly flip to waiting_approval — it
        // stays 'generating' (mask keeps the mid-turn UI stable), and the
        // turn's start time is undisturbed.
        expect(h.host.lastStatus).toBe('generating');
        expect(h.host.generatingStartedAt).toBe(armedAt);
    });

    it('BREAK-ONCE control: with the startup mask exemption removed, the first real turn is silently swallowed', () => {
        // This test intentionally re-derives the pre-fix behavior by simulating
        // the OLD unconditional mask (autoApproveActive always collapses to
        // 'generating' regardless of an active turn) to prove the new test
        // above is not a tautology. It does not touch source — it constructs
        // the pinned-lastStatus precondition directly and shows the following
        // real turn produces NO evidence, matching the live defect.
        const h = makeHarness();

        // Simulate the OLD behavior's end state directly: the masked startup
        // approval pinned lastStatus at 'generating' with generatingStartedAt
        // left at 0 (no arm ever claimed the edge).
        h.host.lastStatus = 'generating';
        h.host.generatingStartedAt = 0;

        // The user's first real message arrives — adapter genuinely reports
        // generating (no visible transition, since lastStatus is already
        // 'generating' under the old bug).
        h.setPendingResponse(true);
        h.setRawStatus('generating');
        h.tick();

        // Under the OLD bug this is a no-op tick (newStatus === lastStatus),
        // so none of the turn-start bookkeeping ever runs.
        expect(h.host.generatingDebouncePending).toBeNull();
        expect(turnStartedEvidence(h.evidence).length).toBe(0);

        h.setPendingResponse(false);
        h.setRawStatus('idle');
        h.tick();
        // No completion either — the real live defect being fixed.
        expect(h.completions.length).toBe(0);
    });
});
