/**
 * CLI completion decision engine.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Completion detection for CLI providers accreted eight generations of patches
 * inside CliProviderInstance (debounce → 10 finalization block reasons →
 * CANON-A/B/C → the CANON-C min-elapsed floor → SETTLE-VALLEY hold →
 * transcript-growth hold → TX-FSM stages layered on top → three out-of-band
 * stall rescues), with six judgment sites able to emit
 * `agent:generating_completed` and ~20 tunables whose ordering invariants were
 * maintained by hand in comments. Every layer was a correct fix for a real
 * incident; the defect density came from the layers being IMPLICIT — each one
 * an inline branch mutating shared instance state.
 *
 * This module makes the judgment EXPLICIT and PURE:
 *
 *   decideCompletionFlush(arm, reader, policy) -> CompletionFlushDecision
 *
 * - The engine owns WHETHER/WHEN semantics: cancel vs hold vs weak emit vs
 *   genuine emit, and every hold's bound (retry, floor, cap).
 * - The caller (CliProviderInstance) owns the CLOCK (setTimeout scheduling),
 *   the SIGNALS (adapter/parser/transcript reads, exposed through
 *   CompletionSignalReader so expensive probes stay conditional), and the
 *   EMIT (emitGeneratingCompleted) + logging/tracing keyed off the returned
 *   decision.
 * - All state the old code mutated mid-flight (loggedBlockReason,
 *   backgroundTaskHoldSince, resolvedFinal* evidence stash) is returned as an
 *   explicit `armPatch` for the caller to apply — the engine never mutates its
 *   inputs, so every decision is unit-testable with fake readers and fake
 *   clocks.
 *
 * SEMANTIC FIDELITY
 * -----------------
 * Phase 1 reproduces the pre-rewrite pipeline decision-for-decision (the 56
 * cli-provider-*.test.ts suites encode the contract). The pipeline order is
 * load-bearing; do not reorder rules without a failing test that proves the
 * new order correct. Rule provenance is annotated with the incident tags the
 * original inline fixes carried (FALSE-IDLE, CANON-C, SETTLE-VALLEY, TX-FSM,
 * ANTIGRAVITY-30S-CAP-PREMATURE, …) so the history stays greppable.
 */

import { isCliGeneratingLikeStatus } from '../cli-provider-status-helpers';
import { NATIVE_HISTORY_MESH_IDLE_SETTLE_MS } from '../cli-provider-instance-types';

export type EvidenceSource = 'parsed' | 'external-native' | 'unavailable';
export type AuthorityTiming = 'immediate' | 'floor' | 'hold';

/** Immutable per-arm record — the engine-visible projection of CompletedDebouncePending. */
export interface CompletionArmState {
    readonly firstObservedAt: number;
    readonly previousStatus: string;
    readonly turnStartedAt?: number;
    readonly busyEpochAtArm?: number;
    readonly lastOutputAtArm?: number;
    /** Last hold reason surfaced (dedupes hold logging; also gates the new-PTY-output cancel). */
    readonly loggedBlockReason?: string;
    /** First instant the background-task hold engaged (caps the hold window). */
    readonly backgroundTaskHoldSince?: number;
}

/** Patch to persist onto the pending record after a decision. */
export interface CompletionArmPatch {
    loggedBlockReason?: string | null;
    backgroundTaskHoldSince?: number | null;
    /** Evidence stash for TOCTOU-free finalSummary extraction (EMPTY-FINAL-CONTENT). */
    resolvedFinalMessages?: unknown[] | null;
    resolvedFinalEvidenceSource?: EvidenceSource | null;
    resolvedFinalEvidenceObservedAt?: number | null;
}

/**
 * Lazy signal access. Implementations MUST memoize per flush attempt: the
 * engine may consult a signal more than once and the decision must be made
 * against one coherent sample, and expensive probes (native transcript reads)
 * must not run twice. Fake readers in tests get determinism for free.
 */
export interface CompletionSignalReader {
    now(): number;
    /** Auto-approve-adjusted visible status ('generating' while auto-approve is mid-resolve). */
    visibleStatus(): string;
    busyEpoch(): number;
    /** Raw adapter status sample (allowParse:false). */
    lastOutputAt(): number | undefined;
    adapterWaitingForResponse(): boolean;
    adapterTurnScopeActive(): boolean;
    /** hasAdapterPendingResponse(): waitingForResponse || turnScope || isProcessing || partial. */
    adapterAnyPending(): boolean;
    partialResponsePending(): boolean;
    /** getScriptParsedStatus() — ok:false carries the throw message (parse_error block). */
    parsedStatus(): { ok: true; status: string; modalActive: boolean; messages: unknown } | { ok: false; error: string };
    /** shouldSuppressStaleParsedBusyStatus() for the current parsed/adapter pair. */
    staleParsedBusySuppressed(): boolean;
    backgroundTask(): { active: boolean; count?: number };
    /** Turn-scoped final-assistant evidence (completionFinalAssistantEvidence). */
    finalAssistantEvidence(): { present: boolean; source: EvidenceSource; messages: unknown[] };
    /** External-native tail probe (recordPendingTranscriptProbe result), only meaningful for external-native evidence. */
    externalNativeTailProbe(): { lastRole?: string; contentLen?: number } | null;
    /** TX-FSM Stage 1 growth snapshot; null = unavailable (fail-open). */
    transcriptGrowth(): { available: boolean; growing: boolean; msgCount?: number; mtimeAgeMs?: number } | null;
    busyLeaseGateEnabled(): boolean;
    /** TX-FSM Stage 2 lease; null = no lease issued. */
    busyLease(): { active: boolean; lastLiveAt?: number; expiresAt?: number; remainingMs?: number } | null;
    /** Age of the authoritative transcript per the last signal snapshot (Stage 2.2 dwell). */
    transcriptAgeMs(): number | undefined;
    /** SETTLE-VALLEY: inside the approval-resume grace window (recent resolveModal). */
    inApprovalResumeGrace(): boolean;
    /** FALSEIDLE-a: lastResolvedEntrySeq >= approvalEntrySeq (fails open true). */
    hasApprovalResolutionEvidence(): boolean;
    /** Last 16 screen lines match looksLikeActiveApprovalPromptText. */
    screenTailShowsApprovalPrompt(): boolean;
    /** ANTIGRAVITY-30S-CAP-PREMATURE: adapter pending OR raw output within quiet dwell. */
    holdClassPtyStillActive(): boolean;
    /** adapter.chatMessagesOwnedExternally === true */
    ownsExternalHistory(): boolean;
    authorityTiming(): AuthorityTiming;
    /** meshNodeFor || meshActiveTaskId || launchedByCoordinator */
    allowMissingAssistantTimeout(): boolean;
}

/** Tunables. Defaults mirror the historical constants; injected so tests can compress time. */
export interface CompletionPolicy {
    finalizationRetryMs: number;            // COMPLETED_FINALIZATION_RETRY_MS (1_000)
    finalizationMaxWaitMs: number;          // COMPLETED_FINALIZATION_MAX_WAIT_MS (30_000)
    backgroundTaskHoldMaxMs: number;        // BACKGROUND_TASK_HOLD_MAX_MS (300_000)
    canonCMinElapsedFloorMs: number;        // CANON_C_MISSING_ASSISTANT_MIN_ELAPSED_MS (20_000)
    transcriptGrowthQuietMs: number;        // MISSING_ASSISTANT_TRANSCRIPT_GROWTH_QUIET_MS (60_000)
    holdClassHardCapMs: number;             // ANTIGRAVITY_HOLD_HARD_CAP_MS (300_000)
    ptyParsedFinalAssistantQuietDwellMs: number; // PTY_PARSED_FINAL_ASSISTANT_QUIET_DWELL_MS (1_200)
    /**
     * (INFINITE-GENERATING) Absolute bound on a TERMINAL finalization block.
     * TERMINAL_BLOCK_HARD_CAP_MS (600_000). Terminal blocks legitimately outlive the 30s
     * finalization cap — that is what makes them terminal — but a reason that never clears
     * must not pin the session in `generating` forever. Set well above the hold-class hard
     * cap so it is a backstop for the genuinely stuck case, never the ordinary release path.
     */
    terminalBlockHardCapMs: number;
}

export interface FinalizationBlock {
    reason: string;
    terminal?: boolean;
    /** Transcript-evidence gate marker (CANON-C decouple) — mesh sessions only. */
    allowTimeout?: boolean;
    /** SETTLE-VALLEY / hold-class marker: wait for the authoritative transcript. */
    holdForTranscript?: boolean;
    /** FLOOR-class marker: no external transcript will land to upgrade a weak emit. */
    noExternalTranscriptSource?: boolean;
}

export type CompletionFlushDecision =
    | {
        kind: 'cancel';
        reason: 'resumed_status' | 'busy_reentry' | 'new_pty_output';
        trace: Record<string, unknown>;
    }
    | {
        kind: 'hold';
        /** Stable hold identifier — also becomes pending.loggedBlockReason (via armPatch). */
        reason: string;
        retryInMs: number;
        /** The underlying finalization block, when the hold came from one. */
        block?: FinalizationBlock;
        /** True when this hold reason is new for this pending (caller logs once). */
        firstOfReason: boolean;
        armPatch: CompletionArmPatch;
        trace: Record<string, unknown>;
    }
    | {
        kind: 'emit-weak';
        block: FinalizationBlock;
        emittedAfterFinalizationTimeout: boolean;
        /** CANON-C decoupled-immediate (vs 30s forced-timeout release). */
        decoupledImmediateEmit: boolean;
        /**
         * (INFINITE-GENERATING) Released by the terminal-block hard cap — a terminal block
         * whose reason never cleared. Distinct provenance from the ordinary 30s timeout:
         * this one means the turn was genuinely stuck, which is worth surfacing.
         */
        releasedByTerminalBlockHardCap: boolean;
        waitedMs: number;
        armPatch: CompletionArmPatch;
        trace: Record<string, unknown>;
    }
    | {
        kind: 'emit-genuine';
        armPatch: CompletionArmPatch;
        trace: Record<string, unknown>;
    };

/**
 * Pure port of getCompletedFinalizationBlock(). Consumes signals through the
 * reader; evidence stashing is returned via `evidencePatch` instead of mutating
 * the pending record.
 */
export function evaluateFinalizationBlock(
    arm: CompletionArmState,
    reader: CompletionSignalReader,
    policy: CompletionPolicy,
): { block: FinalizationBlock | null; evidencePatch: CompletionArmPatch } {
    const evidencePatch: CompletionArmPatch = {};
    const visibleStatus = reader.visibleStatus();
    if (visibleStatus !== 'idle') {
        return { block: { reason: `status:${visibleStatus}`, terminal: true }, evidencePatch };
    }

    const approvalResolvedIdle = arm.previousStatus === 'waiting_approval';
    // (FALSEIDLE-a FixA) Adapter pending-response checks run UNCONDITIONALLY; the
    // approval-resolved path only demotes them to non-terminal (bounded by the 30s cap)
    // so a provider that never closes its turn scope force-fires weak instead of wedging.
    if (reader.adapterWaitingForResponse()) {
        return { block: { reason: 'adapter_waiting_for_response', terminal: !approvalResolvedIdle }, evidencePatch };
    }
    if (reader.adapterTurnScopeActive()) {
        return { block: { reason: 'adapter_turn_scope_active', terminal: !approvalResolvedIdle }, evidencePatch };
    }
    if (reader.adapterAnyPending()) {
        return { block: { reason: 'adapter_pending_response', terminal: !approvalResolvedIdle }, evidencePatch };
    }

    // (FALSE-IDLE, Fix 1) SETTLE-VALLEY extension for the generating→idle valley after an
    // auto-approve resolveModal (previousStatus==='generating'). Non-terminal: the retry loop
    // re-runs the resume guards, and the grace lapses on its own.
    if (!approvalResolvedIdle && reader.inApprovalResumeGrace()) {
        return { block: { reason: 'approval_resume_grace', terminal: false }, evidencePatch };
    }

    if (reader.partialResponsePending()) {
        return { block: { reason: 'partial_response_pending', terminal: true }, evidencePatch };
    }

    const parsed = reader.parsedStatus();
    if (!parsed.ok) {
        return { block: { reason: `parse_error:${parsed.error}` }, evidencePatch };
    }
    if (parsed.status !== 'idle') {
        if (reader.staleParsedBusySuppressed()) return { block: null, evidencePatch };
        return {
            block: { reason: `parsed_status:${parsed.status}`, terminal: isCliGeneratingLikeStatus(parsed.status) },
            evidencePatch,
        };
    }
    if (parsed.modalActive) {
        return { block: { reason: 'parsed_modal_active', terminal: true }, evidencePatch };
    }

    const ownsExternal = reader.ownsExternalHistory();
    const timing = reader.authorityTiming();
    const allowMissingAssistantTimeout = reader.allowMissingAssistantTimeout();

    // FALSE-IDLE turn-boundary evidence (Defect 1b): only an in-turn final assistant counts.
    const evidence = reader.finalAssistantEvidence();

    // EMPTY-FINAL-CONTENT (TOCTOU): stash the exact message array that proved the turn done,
    // so a clean verdict extracts finalSummary from THIS snapshot, not a racing second read.
    if (evidence.present && evidence.source !== 'unavailable') {
        evidencePatch.resolvedFinalMessages = Array.isArray(evidence.messages) ? evidence.messages : null;
        evidencePatch.resolvedFinalEvidenceSource = evidence.source;
        evidencePatch.resolvedFinalEvidenceObservedAt = reader.now();
    } else {
        evidencePatch.resolvedFinalMessages = null;
        evidencePatch.resolvedFinalEvidenceSource = null;
        evidencePatch.resolvedFinalEvidenceObservedAt = null;
    }

    if (!evidence.present) {
        if (ownsExternal) {
            if (evidence.source === 'external-native') {
                // Native tail probe: an assistant tail with content proves the turn done.
                const probe = reader.externalNativeTailProbe();
                if (probe?.lastRole === 'assistant' && (probe.contentLen ?? 0) > 0) {
                    return { block: null, evidencePatch };
                }
                // (FALSE-IDLE-MIDTURN antigravity → SPEC-DRIVEN) HOLD class: the manifest
                // declares the transcript write can legitimately lag the PTY idle. Hold for it.
                if (timing === 'hold') {
                    if (allowMissingAssistantTimeout) {
                        return {
                            block: { reason: 'missing_final_assistant', terminal: false, holdForTranscript: true },
                            evidencePatch,
                        };
                    }
                    return { block: null, evidencePatch };
                }
                // (SETTLE-VALLEY) The inter-approval idle valley of a native-history mesh worker.
                if (allowMissingAssistantTimeout && approvalResolvedIdle) {
                    return {
                        block: { reason: 'missing_final_assistant', terminal: false, holdForTranscript: true },
                        evidencePatch,
                    };
                }
                // (EARLY-EMIT FLOOR, mission f2f6da1b defect A) FLOOR class gets the CANON-C
                // min-elapsed floor (noExternalTranscriptSource); IMMEDIATE (write-lag, e.g.
                // claude-cli) stays un-floored by owner decision.
                const isWriteLagNativeSource = timing !== 'floor';
                return {
                    block: {
                        reason: 'missing_final_assistant',
                        terminal: true,
                        allowTimeout: allowMissingAssistantTimeout,
                        ...(isWriteLagNativeSource ? {} : { noExternalTranscriptSource: true }),
                    },
                    evidencePatch,
                };
            }
            // (INFINITE-GENERATING / EVIDENCE-FALLTHROUGH) Everything below is the
            // "owns an external transcript, but this probe did NOT resolve it" case:
            // evidence.source is 'unavailable' (no session pinned yet, file not written,
            // typed fail-closed attribution) or 'parsed' (fell back to the PTY scrape).
            //
            // Previously ONLY timing==='floor' returned here. A 'hold'/'immediate' provider
            // fell out of both enclosing ifs, skipped the missing-evidence branch entirely,
            // and reached the tail `return { block: null }` — a CLEAN completion asserting
            // "the turn is provably finished" while the evidence explicitly said the final
            // assistant was NOT found. That is antigravity's unstable verdict and the
            // empty-summary first notification: the completion fired off a probe that had
            // resolved nothing, so the summary extractor (which applies stricter turn-scoping)
            // had nothing to emit.
            //
            // WHY WEAK-EMIT AND NOT A HOLD: a hold is only correct when there is reason to
            // expect the blocker to clear. Here the transcript is UNRESOLVED, which the
            // evidence layer itself treats as fail-open (completionFinalAssistantEvidence
            // falls back to parsed rather than reporting present:false forever). Holding
            // would recreate the exact unbounded wedge the terminal-block hard cap exists to
            // prevent. So: block it (never clean), but route it through the transcript-
            // evidence gate (allowTimeout) so the verdict stage releases it via the WEAK
            // emit — which carries explicit "without finalized assistant turn" provenance in
            // the log line, the completionDiagnostic and the completion-gate trace, instead
            // of the silent clean completion this used to produce.
            //
            // allowTimeout is unconditional here, NOT allowMissingAssistantTimeout: on a
            // non-mesh interactive session there is no mesh rescue net, so gating it would
            // leave the block held to the 30s cap for a turn that is already idle and has no
            // transcript coming.
            //
            // noExternalTranscriptSource is scoped to the FLOOR class only. That flag is what
            // arms the CANON-C 20s min-elapsed floor, and the floor exists to stop a
            // floor-class provider from emitting on a first-poll timing guess. Setting it for
            // hold/immediate would import a 20s delay those classes never had — the exact
            // over-correction that turns a false-completion fix into a new latency defect.
            // So: floor keeps its floor, hold/immediate release as soon as the verdict stage
            // runs, and BOTH now carry weak-emit provenance instead of emitting clean.
            return {
                block: {
                    reason: 'missing_final_assistant',
                    terminal: false,
                    allowTimeout: true,
                    ...(timing === 'floor' ? { noExternalTranscriptSource: true } : {}),
                },
                evidencePatch,
            };
        } else {
            // PTY-parsed provider: no external transcript will land to upgrade a weak emit.
            return {
                block: {
                    reason: 'missing_final_assistant',
                    terminal: timing === 'floor',
                    allowTimeout: allowMissingAssistantTimeout,
                    noExternalTranscriptSource: true,
                },
                evidencePatch,
            };
        }
    }

    // (FALSEIDLE-a) Structural approval-resolution gate — before the brittle screen-text
    // heuristic so it also catches modals whose text the heuristic misses (cd / untrusted hooks).
    if (approvalResolvedIdle
        && allowMissingAssistantTimeout
        && !reader.hasApprovalResolutionEvidence()) {
        return { block: { reason: 'approval_resolution_unconfirmed', terminal: false }, evidencePatch };
    }

    // Screen still shows an approval/choice prompt → the turn is not complete.
    if (reader.screenTailShowsApprovalPrompt()) {
        return { block: { reason: 'screen_shows_approval_prompt', terminal: approvalResolvedIdle }, evidencePatch };
    }

    // (FALSE-IDLE-MIDTURN codex/PTY) Quiet-dwell for a PARSED evidence source: an on-screen
    // fragment captured mid-stream can flip present:true — require minimum quiet since last
    // raw PTY output. Non-terminal; bounded by the 30s cap.
    if (allowMissingAssistantTimeout && !ownsExternal && evidence.source === 'parsed') {
        const lastOutputAt = reader.lastOutputAt();
        if (typeof lastOutputAt === 'number') {
            const quietMs = reader.now() - lastOutputAt;
            if (quietMs < policy.ptyParsedFinalAssistantQuietDwellMs) {
                return { block: { reason: 'parsed_final_assistant_quiet_dwell', terminal: false }, evidencePatch };
            }
        }
    }

    // TX-FSM Stage 2.2 (KIMI-POST-FINAL-WEDGE) — transcript-clock quiet dwell for lease-gated
    // native-source evidence. Cosmetic PTY repaints advance lastOutputAt forever; the
    // authoritative transcript's age is the correct clock. Fail-open on missing snapshot.
    if (ownsExternal && evidence.source === 'external-native' && reader.busyLeaseGateEnabled()) {
        const ageMs = reader.transcriptAgeMs();
        if (typeof ageMs === 'number' && ageMs < policy.ptyParsedFinalAssistantQuietDwellMs) {
            return { block: { reason: 'native_source_final_assistant_quiet_dwell', terminal: false }, evidencePatch };
        }
    }

    return { block: null, evidencePatch };
}

export type CompletionPreflightDecision =
    | Extract<CompletionFlushDecision, { kind: 'cancel' } | { kind: 'hold' }>
    | { kind: 'proceed'; armPatch: CompletionArmPatch };

export type CompletionVerdictDecision =
    Extract<CompletionFlushDecision, { kind: 'hold' } | { kind: 'emit-weak' } | { kind: 'emit-genuine' }>;

/**
 * Stage 1 — continuity cancels + the background-task hold. Runs BEFORE the
 * finalization-block evaluation so the caller can obtain the block through its
 * own (historically stubbable) seam between the two stages.
 */
export function decideCompletionPreflight(
    arm: CompletionArmState,
    reader: CompletionSignalReader,
    policy: CompletionPolicy,
): CompletionPreflightDecision {
    const now = reader.now();
    const visibleStatus = reader.visibleStatus();

    // 1) Point-sample resume cancel.
    if (visibleStatus !== 'idle') {
        return {
            kind: 'cancel',
            reason: 'resumed_status',
            trace: { latestVisibleStatus: visibleStatus, previousStatus: arm.previousStatus, busyEpochAtArm: arm.busyEpochAtArm, busyEpoch: reader.busyEpoch() },
        };
    }

    // 2) FALSE-IDLE continuity (Defect 1a): busy re-entry cancels unconditionally —
    // busyEpoch is the structural continuity signal and wins even after a hold.
    const busyEpoch = reader.busyEpoch();
    if (typeof arm.busyEpochAtArm === 'number' && busyEpoch !== arm.busyEpochAtArm) {
        return {
            kind: 'cancel',
            reason: 'busy_reentry',
            trace: {
                latestVisibleStatus: visibleStatus,
                previousStatus: arm.previousStatus,
                busyEpochAtArm: arm.busyEpochAtArm,
                busyEpoch,
                busyEpochDelta: busyEpoch - arm.busyEpochAtArm,
            },
        };
    }

    // 3) New raw PTY output — but ONLY until a finalization block claims the pending
    // (a claimed hold owns its own release; cosmetic idle repaints must not delete it).
    const lastOutputAt = reader.lastOutputAt();
    if (!arm.loggedBlockReason
        && typeof arm.lastOutputAtArm === 'number'
        && typeof lastOutputAt === 'number'
        && lastOutputAt > arm.lastOutputAtArm) {
        return {
            kind: 'cancel',
            reason: 'new_pty_output',
            trace: {
                latestVisibleStatus: visibleStatus,
                previousStatus: arm.previousStatus,
                lastOutputAtArm: arm.lastOutputAtArm,
                lastOutputAt,
                lastOutputAtDelta: lastOutputAt - arm.lastOutputAtArm,
            },
        };
    }

    // 4) (FALSE-IDLE-BACKGROUND-CMD) Background tool work hold, capped so a killed
    // background job can delay but never pin the completion.
    const bg = reader.backgroundTask();
    let bgPatch: CompletionArmPatch = {};
    if (bg.active) {
        const holdSince = typeof arm.backgroundTaskHoldSince === 'number' ? arm.backgroundTaskHoldSince : now;
        const heldMs = now - holdSince;
        if (heldMs < policy.backgroundTaskHoldMaxMs) {
            return {
                kind: 'hold',
                reason: 'background_task_active',
                retryInMs: policy.finalizationRetryMs,
                firstOfReason: arm.loggedBlockReason !== 'background_task_active',
                armPatch: { backgroundTaskHoldSince: holdSince, loggedBlockReason: 'background_task_active' },
                trace: { backgroundTaskCount: bg.count ?? null, heldMs, latestVisibleStatus: visibleStatus, previousStatus: arm.previousStatus },
            };
        }
        // Cap exceeded — release to normal finalization (never pinned indefinitely).
    } else if (typeof arm.backgroundTaskHoldSince === 'number') {
        bgPatch = {
            backgroundTaskHoldSince: null,
            ...(arm.loggedBlockReason === 'background_task_active' ? { loggedBlockReason: null } : {}),
        };
    }
    return { kind: 'proceed', armPatch: bgPatch };
}

/**
 * Stage 2 — the verdict for an already-evaluated finalization block (null =
 * clean). The caller applies stage-1's armPatch (and the block evaluation's
 * evidencePatch) to the pending record BEFORE calling this, so `arm` reflects
 * the post-preflight view — that is what the loggedBlockReason dedupe keys on.
 */
export function decideCompletionVerdict(
    arm: CompletionArmState,
    reader: CompletionSignalReader,
    policy: CompletionPolicy,
    block: FinalizationBlock | null,
): CompletionVerdictDecision {
    const now = reader.now();
    const visibleStatus = reader.visibleStatus();
    const busyEpoch = reader.busyEpoch();
    const basePatch: CompletionArmPatch = {};

    if (!block) {
        return { kind: 'emit-genuine', armPatch: basePatch, trace: { latestVisibleStatus: visibleStatus, approvalResolvedIdle: arm.previousStatus === 'waiting_approval', busyEpoch } };
    }

    const waitedMs = now - arm.firstObservedAt;
    const isTranscriptEvidenceGate = block.allowTimeout === true;

    const hold = (reason: string, extraTrace: Record<string, unknown>): CompletionVerdictDecision => ({
        kind: 'hold',
        reason,
        retryInMs: policy.finalizationRetryMs,
        block,
        firstOfReason: arm.loggedBlockReason !== reason,
        armPatch: { ...basePatch, loggedBlockReason: reason },
        trace: { blockReason: block.reason, latestVisibleStatus: visibleStatus, waitedMs, ...extraTrace },
    });

    // 5) (TRANSCRIPT-GROWTH-HOLD / TX-FSM Stage 1) Floor-class missing-assistant: a growing
    // native transcript proves the turn alive — hold, releasing at most growth-quiet after
    // the last append. Fail-open when no snapshot.
    if (block.reason === 'missing_final_assistant' && block.noExternalTranscriptSource === true) {
        const growth = reader.transcriptGrowth();
        if (growth?.available === true && growth.growing === true) {
            return hold('native_transcript_advancing', {
                msgCount: growth.msgCount ?? null,
                sourceMtimeAgeMs: growth.mtimeAgeMs ?? 0,
                growthQuietMs: policy.transcriptGrowthQuietMs,
            });
        }
        // (TX-FSM Stage 2) Bounded busy lease: transcript not growing now, but proven live
        // within the lease bound — keep holding until the lease expires. Canary-gated.
        if (growth?.available === true && reader.busyLeaseGateEnabled()) {
            const lease = reader.busyLease();
            if (lease?.active === true) {
                return hold('busy_lease_active', {
                    leaseLastLiveAt: lease.lastLiveAt ?? null,
                    leaseExpiresAt: lease.expiresAt ?? null,
                    leaseRemainingMs: lease.remainingMs ?? null,
                });
            }
        }
    }

    // 6) Non-gate blocks hold: terminal blocks until their reason clears, non-terminal
    // blocks up to the 30s cap.
    //
    // (INFINITE-GENERATING) A terminal hold is bounded by terminalBlockHardCapMs. The
    // original rule held terminal blocks *indefinitely* on the premise that "their reason
    // must clear" — but nothing guarantees that. A codex-cli worker whose native transcript
    // never grows a final assistant, or any provider whose adapter never closes its turn
    // scope, re-evaluates to the same terminal block on every retry and holds forever: the
    // session is pinned in `generating`, permanently occupying its one-active-per-node mesh
    // write slot, and the coordinator never receives a completion. Every other hold in this
    // engine is already bounded (background-task cap, 30s finalization cap, CANON-C floor,
    // hold-class hard cap); this was the one unbounded path. Past the cap we fall through to
    // the weak emit, which is the same release the 30s timeout produces — a completion with
    // explicit "no finalized assistant turn" provenance, not a fabricated clean one.
    if (!isTranscriptEvidenceGate
        && (block.terminal ? waitedMs < policy.terminalBlockHardCapMs : waitedMs < policy.finalizationMaxWaitMs)) {
        return hold(block.reason, {
            terminal: block.terminal === true,
            holdForTranscript: block.holdForTranscript === true,
            approvalResolvedIdle: arm.previousStatus === 'waiting_approval',
        });
    }

    // 7) (CANON-C EARLY-EMIT FLOOR) Floor-class decoupled emit observes a minimum dwell —
    // a PTY-parsed/floor provider firing at first-poll waitedMs is a pure timing guess.
    if (isTranscriptEvidenceGate
        && block.reason === 'missing_final_assistant'
        && block.noExternalTranscriptSource === true
        && waitedMs < policy.canonCMinElapsedFloorMs) {
        return hold('canon_c_min_elapsed_floor', { terminal: block.terminal === true, canonCMinElapsedFloor: true });
    }

    // 8) (ANTIGRAVITY-30S-CAP-PREMATURE) Hold-class past the 30s cap: release requires a
    // genuinely quiet PTY, bounded by the absolute hard cap so a runaway PTY still releases.
    if (reader.authorityTiming() === 'hold'
        && block.holdForTranscript === true
        && waitedMs < policy.holdClassHardCapMs
        && reader.holdClassPtyStillActive()) {
        return hold('antigravity_hold_pty_active', {
            terminal: block.terminal === true,
            holdForTranscript: true,
            antigravityPtyStillActive: true,
        });
    }

    // 9) Weak emit: CANON-C decoupled-immediate, the 30s forced-timeout release, or the
    // (INFINITE-GENERATING) terminal-block hard-cap rescue.
    const emittedAfterFinalizationTimeout = waitedMs >= policy.finalizationMaxWaitMs;
    const releasedByTerminalBlockHardCap = block.terminal === true
        && !isTranscriptEvidenceGate
        && waitedMs >= policy.terminalBlockHardCapMs;
    return {
        kind: 'emit-weak',
        block,
        emittedAfterFinalizationTimeout,
        decoupledImmediateEmit: isTranscriptEvidenceGate && !emittedAfterFinalizationTimeout,
        releasedByTerminalBlockHardCap,
        waitedMs,
        armPatch: basePatch,
        trace: {
            blockReason: block.reason,
            latestVisibleStatus: visibleStatus,
            approvalResolvedIdle: arm.previousStatus === 'waiting_approval',
            emittedAfterFinalizationTimeout,
            releasedByTerminalBlockHardCap,
            waitedMs,
            busyEpoch,
        },
    };
}

/**
 * Convenience composition of the full pipeline: preflight → block evaluation →
 * verdict, merging every stage's armPatch. CliProviderInstance deliberately
 * does NOT use this — it interposes its own getCompletedFinalizationBlock
 * delegate between the stages so the historical per-incident test seam
 * (stubbing the block) keeps working.
 */
export function decideCompletionFlush(
    arm: CompletionArmState,
    reader: CompletionSignalReader,
    policy: CompletionPolicy,
): CompletionFlushDecision {
    const pre = decideCompletionPreflight(arm, reader, policy);
    if (pre.kind !== 'proceed') return pre;
    const armAfterPre: CompletionArmState = {
        ...arm,
        ...(pre.armPatch.loggedBlockReason === null ? { loggedBlockReason: undefined } : {}),
        ...(pre.armPatch.backgroundTaskHoldSince === null ? { backgroundTaskHoldSince: undefined } : {}),
    };
    const { block, evidencePatch } = evaluateFinalizationBlock(armAfterPre, reader, policy);
    const verdict = decideCompletionVerdict(armAfterPre, reader, policy, block);
    return { ...verdict, armPatch: { ...pre.armPatch, ...evidencePatch, ...verdict.armPatch } };
}

// ---------------------------------------------------------------------------
// ARM POLICY — the generating→idle transition's completion-arm decisions.
// These were inline branches in detectStatusTransition; they are the WHETHER/
// WHEN judgment for arming (not flushing) a completion, so they belong to the
// engine. The caller still owns the clock, the pending-record construction and
// all logging/tracing keyed off the returned decision.
// ---------------------------------------------------------------------------

/**
 * Settle-window selection for the normal (debounce-elapsed) completion arm.
 *
 * - Native-history providers (transcript authoritative) flush immediately —
 *   UNLESS the session progresses autonomously (mesh worker OR self-
 *   coordinator), where a short settle window lets the continuity guard catch
 *   a background-child false idle / inter-approval valley (FALSEIDLE-BGCHILD-a,
 *   FALSE-IDLE self-coordinator settle) instead of firing an early completion
 *   the coordinator can never correct.
 * - Screen-parsed providers keep the historical 3s debounce.
 */
export function resolveCompletionSettleDelayMs(input: {
    ownsExternalHistory: boolean;
    autonomousMeshSession: boolean;
}): number {
    if (!input.ownsExternalHistory) return 3000;
    return input.autonomousMeshSession ? NATIVE_HISTORY_MESH_IDLE_SETTLE_MS : 0;
}

export type ShortGenerationAction = 'settle_arm' | 'suppress' | 'inline_fire';

export interface ShortGenerationDecision {
    action: ShortGenerationAction;
    /** FALSE-IDLE short-gen: zero-evidence dip — as unproven as a floor-class miss. */
    missingEvidence: boolean;
    /** Present only for settle_arm. */
    flushDelayMs?: number;
}

/**
 * Routing for a completion whose generating phase was shorter than the UI
 * debounce (the "short generating" branch).
 *
 * - Autonomous mesh sessions NEVER fire inline: the short branch used to be a
 *   point-sample that synchronously emitted a false completion the
 *   coordinator could not correct (FALSE-IDLE short-gen settle, the core
 *   fix). They arm the same settle + continuity machinery as the normal
 *   branch.
 * - Non-mesh with missing evidence suppresses entirely (no coordinator to
 *   notify; an unproven completion would surface an empty turn).
 * - Non-mesh with confirmed evidence keeps the interactive fast-path: a fast
 *   turn surfaces its completion promptly, and there is no coordinator to be
 *   falsely notified.
 *
 * missingEvidence folds 'unavailable' into the floor/external-native
 * predicate: a zero-evidence dip (the mid-turn point-sample that triggered
 * the false-idle bug) is weak/held, never fired as genuine. A confirmed
 * finalSummary always clears the gate.
 */
export function decideShortGenerationCompletion(input: {
    timing: AuthorityTiming;
    evidenceSource: EvidenceSource;
    hasFinalSummary: boolean;
    autonomousMeshSession: boolean;
}): ShortGenerationDecision {
    const missingEvidence = (input.timing === 'floor'
        || input.evidenceSource === 'external-native'
        || input.evidenceSource === 'unavailable') && !input.hasFinalSummary;
    if (input.autonomousMeshSession) {
        return { action: 'settle_arm', missingEvidence, flushDelayMs: NATIVE_HISTORY_MESH_IDLE_SETTLE_MS };
    }
    if (missingEvidence) return { action: 'suppress', missingEvidence };
    return { action: 'inline_fire', missingEvidence: false };
}
