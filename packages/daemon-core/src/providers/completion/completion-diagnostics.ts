/**
 * Completion adapter-probe predicates, the signal reader, and the diagnostic /
 * hold-log builders (verbatim move out of CliProviderInstance —
 * M-FILE-SIZE-DEBT decomposition).
 *
 * These are the READ side of the completion gate: everything that interrogates
 * the adapter (pending response, stale parsed-busy, approval-resolution seq,
 * hold-class PTY dwell) and everything that renders a decision for humans (the
 * finalization diagnostic payload, the per-hold-reason log + mesh trace). The
 * WHETHER/WHEN judgment stays in completion-engine.ts; this module only feeds
 * and reports it.
 *
 * State lives ON THE HOST (the provider instance) exactly as before, so the
 * per-incident regression suites that drive these privates directly are
 * unchanged. Provenance kept inline: ANTIGRAVITY-30S-CAP-PREMATURE,
 * FALSEIDLE-a approval-resolution evidence, NOTIF Defect-B cached-summary
 * credit, FALSE-IDLE Defect 1c turn scoping, SUMMARY-SCRAPE-FALLBACK part A.
 */

import { LOG } from '../../logging/logger.js';
import { flattenContent } from '../contracts.js';
import type { ChatMessage } from '../../types.js';
import { isUserFacingChatMessage } from '../chat-message-normalization.js';
import { looksLikeActiveApprovalPromptText } from '../approval-utils.js';
import { isCliGeneratingLikeStatus, hasNonEmptyCliModalButtons } from '../cli-provider-status-helpers.js';
import { resolveTranscriptAuthorityProfile } from '../transcript-evidence.js';
import { traceMeshEventDrop } from '../../shared/mesh-event-trace.js';
import type { SignalSnapshot } from '../spec/signal-envelope.js';
import * as evidence from './evidence.js';
import type {
    CompletedDebouncePending,
    CompletedFinalizationBlock,
    CompletionFinalAssistantEvidence,
    ExternalTranscriptProbe,
} from '../cli-provider-instance-types.js';
import {
    COMPLETED_FINALIZATION_MAX_WAIT_MS,
    CANON_C_MISSING_ASSISTANT_MIN_ELAPSED_MS,
    MISSING_ASSISTANT_TRANSCRIPT_GROWTH_QUIET_MS,
    ANTIGRAVITY_HOLD_QUIET_DWELL_MS,
    ANTIGRAVITY_HOLD_HARD_CAP_MS,
    BACKGROUND_TASK_HOLD_MAX_MS,
} from '../cli-provider-instance-types.js';
import type {
    CompletionFlushDecision,
    CompletionSignalReader,
    EvidenceSource,
} from './completion-engine.js';

/** The narrow surface of CliProviderInstance this cluster reads/writes. */
export interface CompletionDiagnosticsHost {
    type: string;
    workingDir: string;
    instanceId: string;
    provider: Record<string, unknown> & { name?: string };
    providerSessionId?: string;
    settings: Record<string, any>;
    adapter: Record<string, any> & {
        getStatus(opts?: { allowParse: boolean }): any;
        getScriptParsedStatus?: () => any;
        isProcessing?: () => boolean;
        getPartialResponse?: () => string;
    };
    busyEpoch: number;
    autoApproveBusy: boolean;
    generatingStartedAt: number;
    lastTranscriptSignalSnapshot: SignalSnapshot | null;
    transcriptSignalSource: { busyLease(): unknown } | null;
    shouldUsePtyAutoApprove(): boolean;
    hasAdapterPendingResponse(): boolean;
    completionFinalAssistantEvidence(parsedMessages: unknown, turnStartedAt?: number): CompletionFinalAssistantEvidence;
    cachedInTurnCompletionSummaryContent(turnStartedAt?: number): string;
    recordPendingTranscriptProbe(pending: CompletedDebouncePending): ExternalTranscriptProbe | null;
    readExternalCompletionMessages(opts?: { allowManifestNativeSource?: boolean }): unknown[] | null;
    probeNativeTranscriptSignals(): { snapshot: SignalSnapshot | null; messages: unknown[] | null } | null;
    busyLeaseGateEnabled(): boolean;
    inApprovalResumeGrace(now?: number): boolean;
    isMeshWorkerSession(): boolean;
    meshTraceCtx(event?: string): Record<string, unknown>;
}

export function hasAdapterPendingResponse(host: CompletionDiagnosticsHost): boolean {
    const adapterAny = host.adapter as any;
    if (adapterAny?.isWaitingForResponse === true) return true;
    if (adapterAny?.currentTurnScope) return true;
    try {
        if (typeof host.adapter.isProcessing === 'function' && host.adapter.isProcessing()) return true;
    } catch { /* defensive: status rendering must not fail because of adapter diagnostics */ }
    try {
        const partial = typeof host.adapter.getPartialResponse === 'function'
            ? host.adapter.getPartialResponse()
            : '';
        if (typeof partial === 'string' && partial.trim()) return true;
    } catch { /* defensive: missing partial means no pending response evidence */ }
    return false;
}

// (ANTIGRAVITY-30S-CAP-PREMATURE) Discriminator gating the 30s-cap release of an antigravity
// `holdForTranscript` block. Antigravity's idle verdict is PTY-screen-derived but its assistant
// answer lands in native-history, which can legitimately lag past COMPLETED_FINALIZATION_MAX_WAIT_MS
// (30s) on a long turn. The cap releases on elapsed time, not proof-of-idle, so it force-emitted a
// premature weak completion WHILE THE PTY WAS STILL GENERATING. Returns true when the PTY is still
// active — i.e. the adapter reports a pending response OR raw PTY output arrived within the last
// ANTIGRAVITY_HOLD_QUIET_DWELL_MS — meaning the 30s cap must KEEP HOLDING (the turn is not proven
// over). Returns false when the PTY is genuinely quiescent (no pending response AND no recent
// output), so a real tool-only turn with no assistant bubble still force-emits a weak completion
// rather than wedging. The absolute ANTIGRAVITY_HOLD_HARD_CAP_MS bound is enforced at the call site
// so a runaway PTY that never falls quiet still eventually releases. Fails OPEN (returns false =
// allow release) when lastOutputAt is unreadable, so the gate can never wedge a session.
export function antigravityHoldPtyStillActive(host: CompletionDiagnosticsHost): boolean {
    if (host.hasAdapterPendingResponse()) return true;
    try {
        const outStatus = host.adapter.getStatus({ allowParse: false }) as any;
        const lastOutputAt = typeof outStatus?.lastOutputAt === 'number' && Number.isFinite(outStatus.lastOutputAt)
            ? outStatus.lastOutputAt as number
            : undefined;
        if (typeof lastOutputAt === 'number') {
            const quietMs = Date.now() - lastOutputAt;
            if (quietMs < ANTIGRAVITY_HOLD_QUIET_DWELL_MS) return true;
        }
    } catch { /* defensive: dwell read is best-effort — fall through to allow release */ }
    return false;
}

export function shouldSuppressStaleParsedBusyStatus(
    host: CompletionDiagnosticsHost,
    parsedStatus: any,
    adapterStatus: any,
): boolean {
    const parsedRawStatus = typeof parsedStatus?.status === 'string' ? parsedStatus.status.trim() : '';
    const adapterRawStatus = typeof adapterStatus?.status === 'string' ? adapterStatus.status.trim() : '';
    if (!isCliGeneratingLikeStatus(parsedRawStatus)) return false;
    if (adapterRawStatus !== 'idle') return false;
    if (hasNonEmptyCliModalButtons(parsedStatus?.activeModal ?? parsedStatus?.modal)) return false;
    if (host.hasAdapterPendingResponse()) return false;
    // Do not suppress when the adapter's raw response buffer is still non-empty.
    // This catches the case where isWaitingForResponse has already flipped to false
    // (so getPartialResponse() returns '') but the provider's native parser still
    // reports generating because it's parsing buffered content. Suppressing the
    // finalization block here would emit a false completion event while the provider
    // session is still actively processing its response stream.
    const adapterAny = host.adapter as any;
    if (typeof adapterAny?.responseBuffer === 'string' && adapterAny.responseBuffer.trim()) return false;
    return true;
}

// (FALSEIDLE-a) Positive, structural proof that the latest approval entry was resolved
// through ADHDev. resolveModal() — driven by auto-approve, dashboard/mesh_approve, and
// dev-cli-debug alike — advances the engine's lastResolvedEntrySeq to the current
// approvalEntrySeq. So `lastResolvedEntrySeq >= approvalEntrySeq` (with a real entry,
// approvalEntrySeq > 0) means the modal we last saw was actually answered. Absence of this
// evidence after a waiting_approval→idle transition means the idle is suspect: the spec's
// text-based approval→idle rule false-tripped while the modal is still unresolved.
// Fails OPEN (returns true) when the seq fields are unavailable, so the gate can never wedge
// a session on a provider/adapter that does not surface the counters.
export function hasApprovalResolutionEvidence(host: CompletionDiagnosticsHost): boolean {
    try {
        const status = host.adapter.getStatus({ allowParse: false }) as any;
        const entrySeq = typeof status?.approvalEntrySeq === 'number' ? status.approvalEntrySeq : 0;
        if (entrySeq <= 0) return true;
        const resolvedSeq = typeof status?.lastResolvedEntrySeq === 'number' ? status.lastResolvedEntrySeq : undefined;
        if (resolvedSeq === undefined) return true;
        return resolvedSeq >= entrySeq;
    } catch {
        return true;
    }
}

// (FALSEIDLE-a) Hold a completion that is the anomalous DIRECT waiting_approval→idle
// transition with no positive resolution evidence. A genuinely resolved approval routes
// through resolveModal → setStatus('generating'), so its completion's previousStatus is
// 'generating' (not 'waiting_approval') and this gate never fires for it. Scoped to
// delegated mesh/coordinator sessions — whose only modal-resolution path is auto-approve /
// mesh_approve (both advance lastResolvedEntrySeq) — so an interactive local session, where
// a human may answer the PTY prompt directly and leave no resolveModal record, is untouched.
// Non-terminal: the hold is bounded by COMPLETED_FINALIZATION_MAX_WAIT_MS (30s), giving a
// settling auto-approve time to fire and advance the seq, and guaranteeing no permanent wedge
// if resolution ever happens via a path that does not record evidence.
export function approvalResolutionFinalizationBlock(
    host: CompletionDiagnosticsHost,
    pending: CompletedDebouncePending,
): CompletedFinalizationBlock | null {
    if (pending.previousStatus !== 'waiting_approval') return null;
    const meshContext = !!(host.settings.meshNodeFor || host.settings.meshActiveTaskId || host.settings.launchedByCoordinator);
    if (!meshContext) return null;
    if (hasApprovalResolutionEvidence(host)) return null;
    return { reason: 'approval_resolution_unconfirmed', terminal: false };
}

export function buildCompletedFinalizationDiagnostic(
    host: CompletionDiagnosticsHost,
    args: {
        blockReason: string;
        latestStatus?: any;
        latestVisibleStatus: string;
        waitedMs: number;
        pending: CompletedDebouncePending;
        emittedAfterFinalizationTimeout: boolean;
    },
): Record<string, unknown> {
    let parsed: any = null;
    let parseError: string | undefined;
    try {
        parsed = host.adapter.getScriptParsedStatus?.();
    } catch (error: any) {
        parseError = error?.message || String(error);
    }

    // FALSE-IDLE Defect 1c: turn-scope the diagnostic's evidence probe too. Passing
    // pending.turnStartedAt makes completionHasFinalAssistantMessage reject a stale
    // mid-turn bubble (predating the turn) just as the finalization gate did, so the
    // diagnostic cannot credit finalAssistantPresent (or clear missing_final_assistant)
    // off a bubble the gate already rejected. With no boundary this is unchanged.
    const turnEvidence = host.completionFinalAssistantEvidence(parsed?.messages, args.pending.turnStartedAt);
    if (turnEvidence.source === 'external-native') {
        host.recordPendingTranscriptProbe(args.pending);
    }
    const visibleMessages = (Array.isArray(turnEvidence.messages) ? turnEvidence.messages : [])
        .filter((message: any) => isUserFacingChatMessage(message as ChatMessage));
    const lastVisible = visibleMessages[visibleMessages.length - 1] as ChatMessage | undefined;
    const lastVisibleRole = typeof lastVisible?.role === 'string' ? lastVisible.role.trim().toLowerCase() : null;
    const lastVisibleKind = typeof (lastVisible as any)?.kind === 'string' ? (lastVisible as any).kind : null;
    const lastVisibleContentLength = lastVisible ? flattenContent(lastVisible.content).trim().length : 0;

    // NOTIF Defect-B: when the live evidence probe momentarily yields no in-turn
    // final assistant (source='unavailable'/external-native with present=false) but
    // a prior poll already parsed and CACHED the real answer for this turn
    // (lastCompletionSummary — the same value mesh_read_chat.summary surfaces),
    // credit the cache as evidence. This flips finalAssistantPresent to true and
    // records the cached source so the completion notification carries
    // completion_diagnostic=present with the summary, instead of
    // missing_final_assistant with an empty payload. Only ever UPGRADES a
    // point-sample miss — a genuine present=true is unchanged, and an empty cache
    // leaves the missing-evidence diagnostic exactly as before.
    const cachedSummary = turnEvidence.present ? '' : host.cachedInTurnCompletionSummaryContent(args.pending.turnStartedAt);
    const creditedFromCache = !turnEvidence.present && cachedSummary.length > 0;
    const finalAssistantPresent = turnEvidence.present || creditedFromCache;
    const finalAssistantEvidenceSource = turnEvidence.present
        ? turnEvidence.source
        : (creditedFromCache ? 'cached-summary' : turnEvidence.source);
    // When the cached summary rescues the evidence, the turn is no longer
    // "missing final assistant" — clear that blockReason so isMissingFinalAssistant‑
    // Diagnostic()/isWeakCompletionEvidence() no longer flag it (both key off
    // blockReason='missing_final_assistant' independently of finalAssistantPresent)
    // and the coordinator log's formatCompletionMetadata reads
    // completion_diagnostic=present (empty blockReason → 'present'). The ORIGINAL
    // reason is preserved under originalBlockReason for diagnostics.
    const clearMissingBlock = creditedFromCache && args.blockReason === 'missing_final_assistant';
    const effectiveBlockReason = clearMissingBlock ? undefined : args.blockReason;

    return {
        providerType: host.type,
        sessionId: host.instanceId,
        providerSessionId: host.providerSessionId || null,
        workspace: host.workingDir,
        ...(effectiveBlockReason ? { blockReason: effectiveBlockReason } : {}),
        ...(clearMissingBlock ? { originalBlockReason: args.blockReason } : {}),
        emittedAfterFinalizationTimeout: args.emittedAfterFinalizationTimeout,
        waitedMs: args.waitedMs,
        maxWaitMs: COMPLETED_FINALIZATION_MAX_WAIT_MS,
        adapterStatus: typeof args.latestStatus?.status === 'string' ? args.latestStatus.status : null,
        latestVisibleStatus: args.latestVisibleStatus,
        parsedStatus: typeof parsed?.status === 'string' ? parsed.status : (parseError ? 'parse_error' : 'unknown'),
        parseError: parseError || undefined,
        finalAssistantPresent,
        finalAssistantFromCachedSummary: !turnEvidence.present && cachedSummary.length > 0,
        finalAssistantEvidenceSource,
        visibleMessageCount: visibleMessages.length,
        lastVisibleRole,
        lastVisibleKind,
        lastVisibleContentLength,
        pendingStartedAt: host.generatingStartedAt || null,
        pendingFirstObservedAt: args.pending.firstObservedAt,
        pendingTimestamp: args.pending.timestamp,
        pendingDurationSec: args.pending.duration,
        previousBlockReason: args.pending.loggedBlockReason || null,
        transcriptProbeHistory: args.pending.transcriptProbeHistory || [],
    };
}

export function buildCompletionSignalReader(
    host: CompletionDiagnosticsHost,
    pending: CompletedDebouncePending,
    visibleStatusOverride?: string,
): CompletionSignalReader {
    const memo = new Map<string, unknown>();
    const once = <T,>(key: string, compute: () => T): T => {
        if (!memo.has(key)) memo.set(key, compute());
        return memo.get(key) as T;
    };
    const adapterStatus = () => once('adapterStatus', () => host.adapter.getStatus({ allowParse: false }) as any);
    const rawParsed = () => once('rawParsed', () => {
        try { return { ok: true as const, value: host.adapter.getScriptParsedStatus?.() as any }; }
        catch (error: any) { return { ok: false as const, error: error?.message || String(error) }; }
    });
    return {
        now: () => Date.now(),
        visibleStatus: () => once('visibleStatus', () => {
            if (typeof visibleStatusOverride === 'string') return visibleStatusOverride;
            const latest = adapterStatus();
            const latestAutoApproveActive = latest?.status === 'waiting_approval' && host.shouldUsePtyAutoApprove();
            return latestAutoApproveActive || host.autoApproveBusy ? 'generating' : String(latest?.status ?? 'unknown');
        }),
        busyEpoch: () => host.busyEpoch,
        lastOutputAt: () => {
            const v = adapterStatus()?.lastOutputAt;
            return typeof v === 'number' && Number.isFinite(v) ? v as number : undefined;
        },
        adapterWaitingForResponse: () => (host.adapter as any)?.isWaitingForResponse === true,
        adapterTurnScopeActive: () => !!(host.adapter as any)?.currentTurnScope,
        adapterAnyPending: () => host.hasAdapterPendingResponse(),
        partialResponsePending: () => {
            const partial = typeof host.adapter.getPartialResponse === 'function'
                ? host.adapter.getPartialResponse()
                : '';
            return typeof partial === 'string' && !!partial.trim();
        },
        parsedStatus: () => once('parsedStatus', () => {
            const rp = rawParsed();
            if (!rp.ok) return { ok: false as const, error: rp.error };
            const parsed = rp.value;
            return {
                ok: true as const,
                status: typeof parsed?.status === 'string' ? parsed.status : 'unknown',
                modalActive: !!(parsed?.activeModal || parsed?.modal),
                messages: parsed?.messages,
            };
        }),
        staleParsedBusySuppressed: () => once('staleParsedBusySuppressed', () => {
            const rp = rawParsed();
            return rp.ok ? shouldSuppressStaleParsedBusyStatus(host, rp.value, adapterStatus()) : false;
        }),
        backgroundTask: () => once('backgroundTask', () => {
            const rp = rawParsed();
            const parsed = rp.ok ? rp.value as { backgroundTaskActive?: boolean; backgroundTaskCount?: number } : undefined;
            return { active: parsed?.backgroundTaskActive === true, count: parsed?.backgroundTaskCount };
        }),
        finalAssistantEvidence: () => once('finalAssistantEvidence', () => {
            const rp = rawParsed();
            const turnEvidence = host.completionFinalAssistantEvidence(rp.ok ? rp.value?.messages : undefined, pending.turnStartedAt);
            LOG.debug('CLI', `[${host.type}] finalAssistantEvidence: present=${turnEvidence.present} source=${turnEvidence.source}`);
            return {
                present: turnEvidence.present,
                source: turnEvidence.source as EvidenceSource,
                messages: Array.isArray(turnEvidence.messages) ? turnEvidence.messages : [],
            };
        }),
        externalNativeTailProbe: () => once('externalNativeTailProbe', () => {
            const probe = host.recordPendingTranscriptProbe(pending);
            if (probe && !pending.loggedTranscriptProbe) {
                LOG.info('CLI', `[${host.type}] external transcript probe: msgCount=${probe.msgCount} lastRole=${probe.lastRole || 'none'} lastKind=${probe.lastKind || 'none'} contentLen=${probe.contentLen} sourceMtime=${probe.sourceMtimeMs ?? 'unknown'} mtimeAge=${probe.mtimeAgeMs ?? 'unknown'}ms`);
                pending.loggedTranscriptProbe = true;
            }
            LOG.debug('CLI', `[${host.type}] external-native probe result: lastRole=${probe?.lastRole} contentLen=${probe?.contentLen}`);
            return probe ? { lastRole: probe.lastRole ?? undefined, contentLen: probe.contentLen } : null;
        }),
        transcriptGrowth: () => once('transcriptGrowth', () => {
            let snapshot: SignalSnapshot | null = null;
            try { snapshot = host.probeNativeTranscriptSignals()?.snapshot ?? null; } catch { snapshot = null; }
            if (!snapshot) return null;
            const available = snapshot.available === true;
            return {
                available,
                growing: available && (snapshot as any).signals?.transcript_growing === true,
                msgCount: (snapshot as any).detail?.msgCount as number | undefined,
                mtimeAgeMs: ((snapshot as any).detail?.ageMs ?? 0) as number,
            };
        }),
        busyLeaseGateEnabled: () => host.busyLeaseGateEnabled(),
        busyLease: () => {
            const lease = host.transcriptSignalSource?.busyLease() ?? null;
            if (!lease) return null;
            return {
                active: (lease as any).active === true,
                lastLiveAt: (lease as any).lastLiveAt as number | undefined,
                expiresAt: (lease as any).expiresAt as number | undefined,
                remainingMs: (lease as any).remainingMs as number | undefined,
            };
        },
        transcriptAgeMs: () => {
            try {
                const snapshot = host.lastTranscriptSignalSnapshot;
                return snapshot?.available === true
                    && typeof (snapshot as any).detail?.ageMs === 'number'
                    && Number.isFinite((snapshot as any).detail.ageMs)
                    ? (snapshot as any).detail.ageMs as number
                    : undefined;
            } catch { return undefined; }
        },
        inApprovalResumeGrace: () => host.inApprovalResumeGrace(),
        hasApprovalResolutionEvidence: () => hasApprovalResolutionEvidence(host),
        screenTailShowsApprovalPrompt: () => once('screenTailShowsApprovalPrompt', () => {
            try {
                const screenText = typeof (host.adapter as any).getScreenText === 'function'
                    ? String((host.adapter as any).getScreenText() || '')
                    : '';
                if (!screenText) return false;
                const tailLines = screenText.split(/\r?\n/).slice(-16).join('\n');
                return looksLikeActiveApprovalPromptText(tailLines);
            } catch { return false; }
        }),
        holdClassPtyStillActive: () => antigravityHoldPtyStillActive(host),
        ownsExternalHistory: () => (host.adapter as any)?.chatMessagesOwnedExternally === true,
        authorityTiming: () => resolveTranscriptAuthorityProfile(host.provider as any).timing,
        allowMissingAssistantTimeout: () => !!(host.settings.meshNodeFor || host.settings.meshActiveTaskId || host.settings.launchedByCoordinator),
        // (SUMMARY-SCRAPE-FALLBACK, part A) Is this turn's COMPLETE text on disk yet?
        //
        // This is a REAL extra native read, not a reuse of the evidence probe's: on the
        // path this signal exists for, completionFinalAssistantEvidence returned via its
        // `parsed` short-circuit and never touched the transcript at all. It is bounded by
        // the guards on the call site — the engine consults it only on an otherwise-clean
        // verdict for an ownsExternal provider with `parsed` evidence, at most once per
        // flush attempt (memoized), and at most for nativeSummaryWriteWaitMaxMs of retries.
        //
        // Fails closed to undefined ("cannot tell" ⇒ never holds) on any throw and for a
        // provider that owns no external history.
        nativeSummaryOnDisk: () => once('nativeSummaryOnDisk', () => {
            try {
                if ((host.adapter as any)?.chatMessagesOwnedExternally !== true) return undefined;
                const messages = host.readExternalCompletionMessages();
                // A NULL read means the transcript is not RESOLVABLE (no session pinned,
                // typed fail-closed attribution) — not "written imminently". Waiting for a
                // transcript that is not coming would convert the established
                // signal-absence fail-open (kimi-parsed-race case 4: unresolved native +
                // parsed answer must EMIT) into a hold. So: undefined, never a hold. Only a
                // transcript we CAN read, which simply has no in-turn bubble yet, is the
                // write-lag race this hold exists for.
                if (!messages) return undefined;
                return !!evidence.extractFinalSummaryForTurn(messages, pending.turnStartedAt);
            } catch { return undefined; }
        }),
    };
}

/** Human log + mesh trace for a hold decision — messages preserved verbatim per hold id. */
export function logCompletionHold(
    host: CompletionDiagnosticsHost,
    decision: Extract<CompletionFlushDecision, { kind: 'hold' }>,
): void {
    if (!decision.firstOfReason) return;
    const t = decision.trace as Record<string, any>;
    switch (decision.reason) {
        case 'background_task_active':
            LOG.info('CLI', `[${host.type}] holding pending completed (background_task_active count=${t.backgroundTaskCount ?? '?'} heldMs=${t.heldMs} max=${BACKGROUND_TASK_HOLD_MAX_MS})`);
            if (host.isMeshWorkerSession()) traceMeshEventDrop('completion_gate_hold', host.meshTraceCtx(), `background_task_active heldMs=${t.heldMs}`);
            break;
        case 'native_transcript_advancing':
            LOG.info('CLI', `[${host.type}] holding pending completed (native_transcript_advancing: msgCount=${t.msgCount} mtimeAge=${t.sourceMtimeAgeMs}ms < ${MISSING_ASSISTANT_TRANSCRIPT_GROWTH_QUIET_MS}ms) — transcript still growing, screen-idle verdict not trusted`);
            if (host.isMeshWorkerSession()) traceMeshEventDrop('completion_gate_hold', host.meshTraceCtx(), `native_transcript_advancing msgCount=${t.msgCount} mtimeAge=${t.sourceMtimeAgeMs}ms`);
            break;
        case 'busy_lease_active':
            LOG.info('CLI', `[${host.type}] holding pending completed (busy_lease_active: lastLiveAt=${t.leaseLastLiveAt} expiresIn=${t.leaseRemainingMs}ms) — transcript live within the lease bound, screen-idle verdict not trusted`);
            if (host.isMeshWorkerSession()) traceMeshEventDrop('completion_gate_hold', host.meshTraceCtx(), `busy_lease_active lastLiveAt=${t.leaseLastLiveAt} expiresIn=${t.leaseRemainingMs}ms`);
            break;
        case 'canon_c_min_elapsed_floor':
            LOG.info('CLI', `[${host.type}] holding CANON-C decoupled emit until min-elapsed floor (waitedMs=${t.waitedMs} floor=${CANON_C_MISSING_ASSISTANT_MIN_ELAPSED_MS}); no final assistant yet (${t.blockReason})`);
            if (host.isMeshWorkerSession()) traceMeshEventDrop('completion_gate_hold', host.meshTraceCtx(), `canon_c_min_elapsed_floor waited=${t.waitedMs}ms`);
            break;
        case 'antigravity_hold_pty_active':
            LOG.info('CLI', `[${host.type}] 30s cap reached but PTY still generating; holding antigravity completion past cap (waitedMs=${t.waitedMs} hardCap=${ANTIGRAVITY_HOLD_HARD_CAP_MS}) (${t.blockReason})`);
            if (host.isMeshWorkerSession()) traceMeshEventDrop('completion_gate_hold', host.meshTraceCtx(), `antigravity_hold_pty_active waited=${t.waitedMs}ms`);
            break;
        default:
            LOG.info('CLI', `[${host.type}] waiting to emit completed until transcript finalizes (${decision.reason})`);
            if (host.isMeshWorkerSession()) traceMeshEventDrop('completion_gate_hold', host.meshTraceCtx(), `${decision.reason} waited=${t.waitedMs}ms`);
            break;
    }
}
