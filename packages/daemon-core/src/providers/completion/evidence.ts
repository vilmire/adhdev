/**
 * Completion evidence & summary resolution (Phase 3 of the completion-engine
 * rewrite — verbatim move out of CliProviderInstance).
 *
 * Owns the "is this turn genuinely over, and what did the assistant actually
 * say" machinery: the final-assistant presence check, the external-native
 * transcript read (session-own conversation resolution incl. the antigravity
 * pin/floor recovery), the evidence probe the finalization gate consumes, the
 * finalSummary provenance chain (native transcript > parsed screen > cached
 * in-turn summary), and the live-turn pending-evidence read the mesh
 * completion gate re-verifies against. Mutable state (the external transcript
 * probe, the dashboard tail-repair summary cache) lives ON THE HOST (the
 * provider instance) so restarts and the existing suites construct it
 * unchanged; intra-module calls route back THROUGH the host so instance-level
 * overrides (the suites stub readExternalCompletionMessages et al.) stay on
 * the path.
 *
 * Provenance kept inline: FALSE-IDLE Defect 1b/1c + FALSEIDLE FixB, TX-FSM
 * Stage 2.1 (KIMI-PARSED-RACE), ANTIGRAVITY-PREMATURE-COMPLETION,
 * ANTIGRAVITY-FINAL-MESSAGE-TAIL-GAP, KIMI-RC30-COMPLETION-SUMMARY-NATIVE-
 * SNAPSHOT, NOTIF Defect-B, EMPTY-FINAL-CONTENT (kimi native-source TOCTOU),
 * NATIVE-TRAILING-TOOL-GATE / MID-TURN-LIVE-STATE-GATE.
 */

import * as fs from 'fs';
import { flattenContent, type ProviderModule } from '../contracts.js';
import {
    isUserFacingChatMessage,
    extractFinalSummaryFromMessagesAfter,
    readChatMessageTimestampMs,
    hasTrailingToolActivityAfterFinalAssistant,
} from '../chat-message-normalization.js';
import { looksLikeActiveApprovalPromptText } from '../approval-utils.js';
import { isNativeSourceCanonicalHistory, readProviderChatHistory } from '../../config/chat-history.js';
import { loadPersistedProviderSessionPins } from '../../config/state-store.js';
import { buildExternalTranscriptProbe } from '../cli-provider-transcript-merge.js';
import type { NativeTurnTerminalMarker } from '../../chat/native-turn-signal.js';
import type {
    CompletedDebouncePending,
    CompletionFinalAssistantEvidence,
    ExternalTranscriptProbe,
} from '../cli-provider-instance-types.js';
import type { SignalSnapshot } from '../spec/signal-envelope.js';
import type { ChatMessage } from '../../types.js';

/**
 * (SUMMARY-SCRAPE-FALLBACK) Where a resolved finalSummary came from, and whether that
 * source can silently clip the text.
 *
 * `mayBeTruncated` is the field the emit paths and the coordinator care about. It is set
 * ONLY for `parsed_screen_fallback`: a provider whose canonical history is the append-only
 * native transcript, whose turn-scoped transcript read came back empty (not yet flushed to
 * disk), and which therefore fell through to the PTY viewport scrape. The terminal wraps and
 * scrolls, so that scrape is an arbitrary-length prefix of the real turn — the observed
 * "summary cut off mid-sentence". Every other source is complete by construction:
 * the native transcript holds whole bubbles, and a genuinely PTY-parsed provider
 * (`parsed_screen`) has no better source to be truncated relative to.
 */
export type FinalSummaryProvenance = {
    source:
        /** Turn-scoped read of the provider's own append-only native transcript. */
        | 'native_transcript'
        /** PTY screen scrape for a provider whose ONLY history is the screen. */
        | 'parsed_screen'
        /** PTY screen scrape taken because a native-source transcript was not yet written. */
        | 'parsed_screen_fallback'
        /** No source yielded any text. */
        | 'none';
    mayBeTruncated: boolean;
    /** Length of the resolved summary, for the diagnostic/trace (0 when none). */
    contentLength: number;
};

/**
 * (SUMMARY-SCRAPE-FALLBACK, part A) Bounded wait for a native-source provider's transcript
 * write before a completion is allowed to settle for the PTY screen scrape as its summary.
 *
 * Consumed by evaluateFinalizationBlock (completion-engine.ts), NOT by
 * completionFinalSummary. The summary is resolved AFTER the emit decision is already made,
 * so returning nothing from the resolver would emit a summary-LESS completion rather than
 * delay it — strictly worse than a truncated one. The only place a wait can actually buy the
 * transcript time is the gate, which already owns a retry loop.
 *
 * WHY A WAIT AND NOT A DOWNSTREAM UPGRADE: the sibling turn-boundary race (NOTIF Defect-B,
 * documented in completionFinalSummary below) can emit '' and rely on the mesh reconcile loop
 * to replace it, because '' is unmistakably incomplete. A partial PREFIX is not — it reads as
 * a finished sentence, no reconciler can tell it apart from a genuinely short answer, and
 * nothing downstream ever revisits it. So it has to be caught before the value is accepted.
 *
 * WHY BOUNDED, AND WHY THIS BOUND: the wait delays the completion notification, so it must
 * never be the reason a turn looks stuck. claude-cli's transcript is the `immediate`
 * write-lag class — the append trails the PTY idle by a flush, not by seconds — so a wait
 * of a couple of finalization retries (COMPLETED_FINALIZATION_RETRY_MS is 1s) covers the real
 * lag with margin. Past it the completion proceeds ANYWAY and takes the scrape, flagged as
 * possibly-truncated (part B): a late-but-flagged notification beats a withheld one. The
 * gate's own 30s finalization cap and 600s terminal hard cap remain the outer bounds; this
 * hold is strictly inside them and never extends either.
 */
export const NATIVE_SUMMARY_WRITE_WAIT_MAX_MS = 2_500;

/**
 * The narrow surface of CliProviderInstance the evidence/summary machinery
 * reads/writes. Mutable probe/cache state stays instance-owned (tests seed and
 * inspect it directly), and moved siblings are dispatched back THROUGH the
 * host so instance-level stubs/overrides (the suites replace
 * readExternalCompletionMessages) remain on the path.
 */
export interface EvidenceHost {
    type: string;
    instanceId: string;
    workingDir: string;
    startedAt: number;
    providerSessionId?: string;
    provider: ProviderModule;
    adapter: {
        getStatus(opts: { allowParse: boolean }): unknown;
        getScriptParsedStatus(): any;
    };
    // Mutable evidence state (instance-owned).
    lastExternalCompletionProbe: ExternalTranscriptProbe | null;
    /** (NATIVE-TURN-SIGNAL) Terminal markers from the last native transcript read. */
    lastNativeTurnTerminalMarkers?: NativeTurnTerminalMarker[] | null;
    lastCompletionSummary: { content: string; receivedAt: number; sourceTimestampMs?: number } | null;
    /**
     * (SUMMARY-SCRAPE-FALLBACK) Provenance of the LAST finalSummary this module resolved.
     *
     * completionFinalSummary returns a bare string, so the one fact its caller cannot
     * otherwise recover is WHICH source produced it — and that fact is exactly what makes
     * the value trustworthy or not. A native-source provider that fell through to the PTY
     * screen scrape yields a summary the terminal may have wrapped/scrolled/clipped
     * (an arbitrary partial prefix), while the same provider's on-disk transcript read
     * yields the complete turn. Recording the source here lets the emit paths stamp it onto
     * completionDiagnostic so the coordinator can see "this summary may be truncated"
     * instead of silently trusting a half sentence.
     *
     * Written on every completionFinalSummary call (including the ones that return
     * undefined, so a stale provenance can never outlive its summary). Optional so
     * existing test doubles that construct a bare host keep working unchanged.
     */
    lastFinalSummaryProvenance?: FinalSummaryProvenance | null;
    // Instance-owned helpers the moved methods call.
    hasAdapterPendingResponse(): boolean;
    isModalParked(): boolean;
    probeNativeTranscriptSignals(): { snapshot: SignalSnapshot | null; messages: unknown[] | null } | null;
    busyLeaseGateEnabled(): boolean;
    /**
     * (NATIVE-TURN-SIGNAL) The provider's own terminal record for THIS turn, or null
     * when the provider declares no completion signal (claude-cli, hermes-cli) or the
     * turn has not ended. Optional so signal-less hosts and existing test doubles keep
     * working unchanged — absent means "fall back to shape inference", which is the
     * pre-existing behaviour.
     */
    nativeTurnTerminalMarker?(turnStartedAt?: number): NativeTurnTerminalMarker | null;
    injectedTaskHasStartedGenerating(): boolean;
    publishTranscriptSignalObservation(messages: unknown[] | null, error?: boolean): void;
    spawnedEnvOverrides(): Record<string, string> | undefined;
    lastVisibleAssistantSummaryDetail(messages: unknown): { content: string; timestampMs?: number };
    // Moved siblings, routed via the host so test overrides stay effective.
    completionHasFinalAssistantMessage(messages: unknown, turnStartedAt?: number): boolean;
    readExternalCompletionMessages(opts?: { allowManifestNativeSource?: boolean }): unknown[] | null;
    completionFinalSummary(parsedMessages: unknown, turnStartedAt?: number): string | undefined;
}

/**
 * (SUMMARY-SCRAPE-FALLBACK, part A) Turn-scoped final-summary extraction over an arbitrary
 * message array, exposed so the signal reader can ask "is this turn's complete text on disk"
 * using the EXACT same scoping rule completionFinalSummary applies. Sharing the predicate is
 * the point: a reader that answered "on disk" by a looser rule than the consumer would release
 * the hold on a bubble the summary then refuses, and the truncated scrape would ship anyway.
 */
export function extractFinalSummaryForTurn(messages: unknown, turnStartedAt?: number): string {
    return extractFinalSummaryFromMessagesAfter(
        (Array.isArray(messages) ? messages : []) as any,
        turnStartedAt,
    );
}

/** Pure message-content check — no host state. Semantics are a verbatim move. */
export function completionHasFinalAssistantMessage(messages: unknown, turnStartedAt?: number): boolean {
    const visibleMessages = (Array.isArray(messages) ? messages : [])
        .filter((message: any) => isUserFacingChatMessage(message as ChatMessage));
    const lastVisible = visibleMessages[visibleMessages.length - 1] as ChatMessage | undefined;
    const role = typeof lastVisible?.role === 'string' ? lastVisible.role.trim().toLowerCase() : '';
    const content = lastVisible ? flattenContent(lastVisible.content).trim() : '';
    if (role !== 'assistant' || !content) return false;
    // Guard: if the last assistant message looks like an active approval/input prompt,
    // it is not a real completion — the session is still awaiting user input.
    if (looksLikeActiveApprovalPromptText(content)) return false;
    // FALSE-IDLE turn-boundary evidence (Defect 1b): when a producing-turn start is
    // known, the final assistant bubble must POST-DATE it. A STALE mid-turn assistant
    // (predating this turn's start — e.g. the last bubble of a prior sub-turn observed
    // during an inter-approval valley) must NOT satisfy the finalization gate, or a
    // false-idle blip emits a completion carrying that stale summary. A bubble with no
    // parseable timestamp cannot be proven stale, so it is kept (fails open — behaviour
    // identical to before for providers/paths that carry no timestamps).
    if (typeof turnStartedAt === 'number' && Number.isFinite(turnStartedAt) && turnStartedAt > 0) {
        // readChatMessageTimestampMs mirrors the summary turn-scoping reader
        // (extractFinalSummaryFromMessagesAfter) — same seconds-vs-ms heuristic and
        // field precedence — so the present-check and the summary-scope agree on which
        // bubbles predate the turn.
        const ts = readChatMessageTimestampMs(lastVisible);
        if (typeof ts === 'number' && ts < turnStartedAt) return false;
    }
    return true;
}

/**
 * Provider-agnostic live-state observation for the mesh completion gate.
 * `observedAt` is the PTY snapshot clock, not the time this accessor ran:
 * after restart/rebind an old waiting_* frame must remain recognizably
 * older than a newly-written authoritative transcript final.
 */
export function getLiveTurnPendingEvidence(host: EvidenceHost): {
    pending: boolean;
    kind?: 'adapter' | 'modal' | 'transcript_tool';
    observedAt?: number;
} {
    const adapterPending = host.hasAdapterPendingResponse();
    const modalParked = host.isModalParked();
    if (adapterPending || modalParked) {
        let observedAt: number | undefined;
        try {
            const raw = host.adapter.getStatus({ allowParse: false }) as any;
            if (typeof raw?.lastOutputAt === 'number' && Number.isFinite(raw.lastOutputAt)) {
                observedAt = raw.lastOutputAt;
            }
        } catch { /* no snapshot clock => the gate keeps the live veto */ }
        return {
            pending: true,
            kind: modalParked ? 'modal' : 'adapter',
            ...(observedAt !== undefined ? { observedAt } : {}),
        };
    }
    try {
        const probe = host.probeNativeTranscriptSignals();
        if (probe?.snapshot?.available === true
            && Array.isArray(probe.messages)
            && hasTrailingToolActivityAfterFinalAssistant(probe.messages as ChatMessage[])) {
            return {
                pending: true,
                kind: 'transcript_tool',
                observedAt: probe.snapshot.sampledAt,
            };
        }
    } catch { /* fail open — a probe error must never fabricate pending evidence */ }
    return { pending: false };
}

export function recordPendingTranscriptProbe(host: EvidenceHost, pending: CompletedDebouncePending): ExternalTranscriptProbe | null {
    const probe = host.lastExternalCompletionProbe;
    if (!probe) return null;
    const history = pending.transcriptProbeHistory || [];
    const last = history[history.length - 1];
    if (!last || last.readAt !== probe.readAt || last.msgCount !== probe.msgCount || last.lastRole !== probe.lastRole || last.contentLen !== probe.contentLen) {
        history.push(probe);
        pending.transcriptProbeHistory = history.slice(-5);
    }
    return probe;
}

export function readExternalCompletionMessages(host: EvidenceHost, opts?: { allowManifestNativeSource?: boolean }): unknown[] | null {
    const adapterOwnsMessagesElsewhere = (host.adapter as any)?.chatMessagesOwnedExternally === true;
    // KIMI-RC30-COMPLETION-SUMMARY-NATIVE-SNAPSHOT: production kimi routes
    // through ProviderCliAdapter (provider dir ships provider.v1.json, no
    // spec.json), which does NOT set chatMessagesOwnedExternally — only
    // SpecCliAdapter does. The manifest's declarative nativeHistory survives
    // ProviderLoader resolve (rc.29), so for callers that explicitly opt in
    // (completion SUMMARY selection only) the manifest's canonical
    // native-source declaration is an equivalent authority signal for whether
    // an on-disk transcript exists to read. The completion evidence/gate
    // probe (completionFinalAssistantEvidence) does NOT opt in — its
    // block/hold semantics are byte-identical to before.
    const manifestNativeSource = opts?.allowManifestNativeSource === true
        && isNativeSourceCanonicalHistory(host.provider?.nativeHistory);
    if (!adapterOwnsMessagesElsewhere && !manifestNativeSource) return null;
    // authority-ok: native READ resolution, not a completion/stall/redrive verdict.
    // This gate only decides whether an on-disk native transcript EXISTS to read for
    // this session; the completion decision is made by callers over the returned
    // messages (completionFinalAssistantEvidence / completionFinalSummary), which
    // route class through resolveTranscriptAuthorityProfile.
    if (!isNativeSourceCanonicalHistory(host.provider.nativeHistory)) return null;

    // Resolve a CONCRETE native-history handle for this session's OWN
    // conversation. A provider that exposes its session id on the CLI
    // (codex/claude/hermes) sets this.providerSessionId. antigravity takes no
    // --session-id, so this.providerSessionId stays empty — recover the real
    // on-disk conversation id from the read pin persisted across restart
    // (state.json sessionProviderSessionPins, keyed by this session's
    // instanceId — the same map a binding read_chat / mesh_read_chat records
    // the resolved uuid into). The OLD `if (!this.providerSessionId) return
    // null` guard blocked antigravity's completion transcript entirely, so its
    // final-assistant evidence was permanently 'unavailable' and the turn
    // completion never emitted → the mesh reconcile loop reclaimed the
    // "delivered but no completion" task and re-dispatched the same MAGI prompt
    // (ANTIGRAVITY-FINAL-MESSAGE-TAIL-GAP, completion side).
    //
    // Prefer a concrete handle (providerSessionId, else the persisted pin). When
    // neither exists yet — a fresh antigravity turn whose conversation has not
    // been bound by any read_chat — fall through with an EMPTY handle and let the
    // dispatcher resolve this session's own conversations/<uuid>.db by the
    // spawn-floor + workspace + instanceId claim. This is safe now that the
    // claim owner token is single-form iid:<instanceId> (never collapses to '')
    // and pickUnboundConversationDb picks the oldest store born at/after THIS
    // session's floor: the probe resolves the session's OWN db under its own
    // owner token, so it can never steal a sibling's conversation (the earlier
    // theft required a floor=0 / owner='' collapse that no longer happens). It
    // means the completion summary is available on the FIRST completion — before
    // any read_chat has recorded a pin — which the dashboard tail-repair needs.
    let resolvedHandle = host.providerSessionId || '';
    if (!resolvedHandle) {
        try {
            const pinned = loadPersistedProviderSessionPins()[host.instanceId];
            if (typeof pinned === 'string' && pinned.trim()) resolvedHandle = pinned.trim();
        } catch { /* best-effort pin hydration */ }
    }

    if (host.lastExternalCompletionProbe?.sourcePath) {
        try { fs.statSync(host.lastExternalCompletionProbe.sourcePath); } catch { /* best-effort metadata refresh */ }
    }
    const restoredHistory = readProviderChatHistory(host.type, {
        canonicalHistory: host.provider.nativeHistory,
        historySessionId: resolvedHandle || undefined,
        workspace: host.workingDir,
        offset: 0,
        limit: Number.MAX_SAFE_INTEGER,
        historyBehavior: host.provider.historyBehavior,
        scripts: host.provider.scripts as any,
        sessionStartedAtMs: host.startedAt,
        // The claim owner token must match read_chat's so the exact-bind on our
        // own conversation stays idempotent rather than looking foreign, and so
        // the floor-based resolution above claims THIS session's db under its
        // own owner (never a sibling's).
        instanceId: host.instanceId,
        envOverrides: host.spawnedEnvOverrides(),
        forceRefresh: true,
        // (NATIVE-TURN-SIGNAL audit) excludeInProgressTurn is deliberately NOT passed
        // here, and that is correct — not the declared-but-ignored field it looks like.
        // It is a per-CALL display concern, not a manifest policy: read_chat sets it only
        // for `returnedStatus === 'waiting_approval'` (chat-commands-read.ts) so a paused
        // turn's half-written tail is hidden from the user. The completion gate needs the
        // exact opposite — it exists to judge the turn that JUST finished, so excluding the
        // in-progress turn would hide the very evidence it is looking for and would make
        // missing_final_assistant strictly more common. Codex's manifest sets
        // excludeInProgressTurn:true for its own read path; that must not leak here.
    });
    // (NATIVE-TURN-SIGNAL) Capture the provider's own turn-terminal records from THIS read,
    // before the source check below can early-return. Refreshed on every probe so a stale
    // marker from a previous read can never satisfy a later turn's gate.
    host.lastNativeTurnTerminalMarkers = Array.isArray((restoredHistory as any).turnTerminalMarkers)
        ? (restoredHistory as any).turnTerminalMarkers as NativeTurnTerminalMarker[]
        : null;

    if (restoredHistory.source !== 'provider-native') {
        host.lastExternalCompletionProbe = null;
        host.publishTranscriptSignalObservation(null);
        return null;
    }
    host.lastExternalCompletionProbe = buildExternalTranscriptProbe(
        restoredHistory.messages,
        restoredHistory.sourcePath,
        restoredHistory.sourceMtimeMs,
    );
    host.publishTranscriptSignalObservation(restoredHistory.messages);
    return restoredHistory.messages;
}

// FALSE-IDLE Defect 1c: turn-scoped view of the cached completion summary.
// The cache is populated from an UNSCOPED tail read (lastVisibleAssistant‑
// SummaryDetail) so the dashboard can show the answer the instant native-history
// has it — which means it can hold a bubble that PREDATES the producing turn.
// The weak-completion (missing_final_assistant) emit path falls back to the cache
// for finalSummary; without turn-scoping it would re-surface the exact stale
// mid-turn bubble the turn-boundary gate already rejected as evidence, freezing
// that stale text as the completion's finalSummary. Consult the cache only when
// its source bubble is proven in-turn (timestamp at/after turnStartedAt). When no
// boundary is known (turnStartedAt falsy) or the cache carries no source timestamp
// (legacy writes), behaviour is identical to the unscoped read.
export function cachedInTurnCompletionSummaryContent(host: EvidenceHost, turnStartedAt?: number): string {
    const cached = host.lastCompletionSummary;
    const content = typeof cached?.content === 'string' ? cached.content.trim() : '';
    if (!content) return '';
    const hasBoundary = typeof turnStartedAt === 'number' && Number.isFinite(turnStartedAt) && turnStartedAt > 0;
    const ts = cached?.sourceTimestampMs;
    if (hasBoundary && typeof ts === 'number' && Number.isFinite(ts) && ts < (turnStartedAt as number)) {
        return '';
    }
    return content;
}

export function completionFinalAssistantEvidence(host: EvidenceHost, parsedMessages: unknown, turnStartedAt?: number): CompletionFinalAssistantEvidence {
    // (FALSEIDLE FixB) UPPER-BOUND turn-end evidence. completionHasFinalAssistantMessage is a
    // pure message-content check ("does the last visible bubble read as a finalized assistant
    // reply, post-dating the turn start?"). That LOWER bound alone treated the FIRST assistant
    // bubble of a turn that is STILL running — a tool call in flight between two assistant
    // bubbles — as proof the turn ended (RCA cases a & b). Require in ADDITION that the turn is
    // genuinely OVER: hasAdapterPendingResponse() folds the three upper-bound discriminators
    // into one — currentTurnScope closed, no in-flight tool (isProcessing false), and no partial
    // response buffer. So a mid-turn point-sample (short-gen / fast-collapse inline paths that
    // do NOT route through getCompletedFinalizationBlock) yields present=false and is held/settled
    // rather than fired. A genuinely-finished turn (adapter idle, no pending) is unaffected — the
    // gate stays open and the completion fires exactly as before. This mirrors the established
    // `completionHasFinalAssistantMessage(...) && !hasAdapterPendingResponse()` pairing already
    // used by the no-progress monitor reconcile path.
    const turnClosed = !host.hasAdapterPendingResponse();

    // (NATIVE-TURN-SIGNAL) The provider's OWN terminal record is authoritative — consult it
    // before any message-shape inference. This is the whole point of the mechanism: a turn
    // that ended on a tool call or with an empty reply produces no assistant bubble, so
    // shape inference reports "no final assistant" forever and only a timeout ever releases
    // it (measured: 193 of 991 codex turns, 19.5%). The marker answers the question directly.
    //
    // Still gated on turnClosed: the marker proves the PROVIDER finished its turn, while
    // turnClosed proves OUR adapter agrees no tool/partial is in flight. Requiring both keeps
    // the FALSEIDLE FixB upper bound intact rather than trading one false-positive class for
    // another. Scoping is turn-id-first (see selectTurnTerminalMarker), which is strictly
    // stronger than the timestamp comparison the shape path falls back to, and it preserves
    // the ANTIGRAVITY-PREMATURE-COMPLETION rule: a PRIOR turn's marker can never satisfy
    // this turn's gate.
    const terminalMarker = host.nativeTurnTerminalMarker?.(turnStartedAt);
    if (terminalMarker) {
        // An ABORTED turn is genuinely over — it must not hang waiting for a final
        // assistant that will never be written.
        return {
            present: turnClosed,
            messages: Array.isArray(parsedMessages) ? parsedMessages : [],
            source: 'native-signal',
            nativeSummary: terminalMarker.summary,
            nativeOutcome: terminalMarker.outcome,
        };
    }

    // TX-FSM Stage 2.1 (KIMI-PARSED-RACE): a native-source provider that ALSO ships a
    // tui.transcriptPty scrape (kimi, like opencode/cursor-cli) keeps that scrape purely
    // for LIVE status convenience — the manifest itself says "Chat is authoritative from
    // nativeHistory; this PTY extraction only keeps live status available". But the parsed
    // scrape carries no tool-activity concept at all (transcriptPty only extracts
    // assistant/user text bullets), so an interim narration bullet Kimi renders just before
    // firing a tool call ("코드와 로그를 병행으로 확인하겠습니다.") satisfies
    // completionHasFinalAssistantMessage identically to a genuine final answer — and this
    // early-return fires BEFORE the richer external-native evidence below is ever consulted,
    // defeating the trailing-tool-activity veto and quiet-dwell guard added below it for
    // this exact defect (live Kimi declaring completion on an interim transcript while the
    // PTY kept generating). Skip the parsed short-circuit for the lease-gated canary
    // (busyLeaseGateEnabled: kimi/codex-cli today) so the authoritative native transcript is
    // judged first; codex-cli ships no transcriptPty so this is a no-op for it. Falls back to
    // the parsed evidence below when the native transcript is unresolved (fail-open, same as
    // before Stage 2.1).
    const preferNativeOverParsed = (host.adapter as any)?.chatMessagesOwnedExternally === true && host.busyLeaseGateEnabled();
    if (!preferNativeOverParsed && host.completionHasFinalAssistantMessage(parsedMessages, turnStartedAt)) {
        return {
            present: turnClosed,
            messages: Array.isArray(parsedMessages) ? parsedMessages : [],
            source: 'parsed',
        };
    }

    const externalMessages = host.readExternalCompletionMessages();
    if (externalMessages) {
        // ANTIGRAVITY-PREMATURE-COMPLETION (recur): the external-native transcript is
        // the WHOLE session's native-history, not turn-scoped by the provider. On a
        // reused-idle antigravity session, a completion-gate poll can run AFTER a new
        // task is injected but BEFORE that task's onTurnStarted fires. The transcript
        // then still tails the PRIOR turn's final-assistant bubble; completionHasFinal‑
        // AssistantMessage accepts it (turnStartedAt is 0/undefined pre-onTurnStarted →
        // fails open, or the prior bubble post-dates the prior turn → passes) and a
        // generating_completed fires for the NEW task BEFORE generating_started — the
        // exact live 06:34→06:35 inversion. Gate external-native evidence on the current
        // injected task having genuinely entered generating: if a task is attached but its
        // turn has not started (turnStartedInjectedTask() === false), the tail is stale by
        // construction, so this evidence must NOT satisfy the completion gate. Fail CLOSED
        // (present=false) rather than open. This does NOT regress the rc.480/481 win: once
        // the injected task's onTurnStarted fires, currentTurnStartedAt/currentTurnTaskId
        // bind to it and a real final bubble still fires completion normally.
        const injectedTaskGenerating = host.injectedTaskHasStartedGenerating();
        // TX-FSM Stage 2.1 (KIMI-PARSED-RACE, trailing-tool-activity veto): mirrors the
        // mesh coordinator's pollAssignedTaskTerminalEvidence guard (ledger 84594b15) on
        // the WORKER's own local evidence. A native-source transcript that captures
        // tool.call/tool.result as kind:'tool' bubbles (kimi's nativeHistory.records, after
        // the provider-manifest fix) proves the last VISIBLE assistant bubble was narration
        // ("Let me check the logs...") that fired a tool call, not the turn's genuine final
        // answer. A provider whose native transcript never records tool activity (nothing to
        // veto on) is unaffected — this can only ever turn a false present:true into false,
        // never the reverse.
        const trailingToolActivity = hasTrailingToolActivityAfterFinalAssistant(externalMessages as any);
        const present = injectedTaskGenerating
            && turnClosed
            && !trailingToolActivity
            && host.completionHasFinalAssistantMessage(externalMessages, turnStartedAt);
        // Dashboard tail-repair cache: this runs on EVERY completion check
        // (mesh AND non-mesh — the non-mesh path suppresses the
        // generating_completed emit, so completionFinalSummary never runs there
        // and cannot cache). Cache whenever the external transcript's LAST
        // visible bubble is an assistant reply — this is a display value only, so
        // it is intentionally looser than the strict `present` completion gate
        // (which also requires turnClosed and turn-scoping): the dashboard should
        // show the answer as soon as native-history has it, even if the FSM has
        // not yet ratified the turn end. getState() replaces it on the next turn.
        const lastVisibleAssistant = host.lastVisibleAssistantSummaryDetail(externalMessages);
        if (lastVisibleAssistant.content) {
            host.lastCompletionSummary = { content: lastVisibleAssistant.content, receivedAt: Date.now(), sourceTimestampMs: lastVisibleAssistant.timestampMs };
        }
        return {
            present,
            messages: externalMessages,
            source: 'external-native',
        };
    }

    // TX-FSM Stage 2.1: the native transcript is unresolved (no session pinned yet, file
    // not yet written) for a provider whose parsed short-circuit was skipped above — fall
    // back to the parsed evidence now rather than reporting present:false forever. Fail-open,
    // identical to the pre-Stage-2.1 behaviour for this narrow (transcript-unavailable) case.
    if (preferNativeOverParsed && host.completionHasFinalAssistantMessage(parsedMessages, turnStartedAt)) {
        return {
            present: turnClosed,
            messages: Array.isArray(parsedMessages) ? parsedMessages : [],
            source: 'parsed',
        };
    }

    return {
        present: false,
        messages: Array.isArray(parsedMessages) ? parsedMessages : [],
        source: 'unavailable',
    };
}

export function completionFinalSummary(host: EvidenceHost, parsedMessages: unknown, turnStartedAt?: number): string | undefined {
    // For native-source providers (claude-cli: chatMessagesOwnedExternally), the PTY
    // screen parse is NOT the source of truth for the final summary — the terminal
    // wraps/scrolls/clips text, so a screen-parsed assistant message is often a partial
    // prefix (e.g. 76 chars of a 112-char turn). The append-only native transcript holds
    // the complete turn. Prefer it whenever it yields a longer/complete summary; fall back
    // to the parsed screen only when the transcript is unavailable. This is the real cause
    // of the truncated finalSummary — independent of cloud vs standalone (it surfaces on
    // any short, fast-completing task where screen parse wins the race).
    //
    // NOTIF Defect-B: `turnStartedAt` (the producing turn's start, snapshotted on the
    // completedDebouncePending record) turn-scopes the NATIVE transcript read. The native
    // transcript holds the WHOLE session filtered only by session start, so a debounce that
    // flushes before the producing turn's final assistant bubble has landed would otherwise
    // return the PRIOR task's last bubble (event taskId=B but summary=A). Filtering to bubbles
    // at/after turnStartedAt yields '' in that race instead of the stale tail; the weak/empty
    // summary is later upgraded by the mesh reconcile loop once the real bubble is written.
    const adapterOwnsMessagesElsewhere = (host.adapter as any)?.chatMessagesOwnedExternally === true;
    // KIMI-RC30-COMPLETION-SUMMARY-NATIVE-SNAPSHOT: the completion summary is a
    // PROVENANCE decision, not a gate verdict — when the provider's manifest
    // declares canonical native-source history (production kimi via
    // ProviderCliAdapter, which never sets chatMessagesOwnedExternally), the
    // on-disk transcript is just as authoritative for the finalSummary as it
    // already is for mesh_read_chat. Prefer its fresh in-turn final assistant
    // over the parsed PTY snapshot (kimi's transcriptPty scrape renders
    // Todo/progress bullets as assistant text — the rc.30 stale summary).
    // Turn-scoping below fails closed: a native tail that predates the turn
    // yields '' and the parsed fallback applies unchanged, and a non-native
    // provider skips the transcript read entirely (no new I/O).
    const manifestNativeSource = !adapterOwnsMessagesElsewhere
        && isNativeSourceCanonicalHistory(host.provider?.nativeHistory);
    // FALSE-IDLE Defect 1b: turn-scope the PARSED screen fallback too. Without this a stale
    // mid-turn assistant (predating turnStartedAt) that the turn-boundary gate already
    // rejected as evidence could still leak into the finalSummary via this parsed fallback
    // when the external transcript's turn-scoped read is empty — freezing the very stale text
    // the gate rejected. extractFinalSummaryFromMessagesAfter drops bubbles before the turn
    // start; with no boundary known (turnStartedAt falsy) it is identical to the unscoped read.
    const parsedSummary = extractFinalSummaryFromMessagesAfter(
        (host.completionHasFinalAssistantMessage(parsedMessages, turnStartedAt)
            ? (Array.isArray(parsedMessages) ? parsedMessages : [])
            : []) as any,
        turnStartedAt,
    );
    if (adapterOwnsMessagesElsewhere || manifestNativeSource) {
        const externalMessages = host.readExternalCompletionMessages(
            manifestNativeSource ? { allowManifestNativeSource: true } : undefined,
        );
        // Turn-scope the external transcript: never return a bubble produced before this
        // turn started. With no boundary known (turnStartedAt falsy) behaviour is unchanged.
        const externalSummary = externalMessages
            ? extractFinalSummaryFromMessagesAfter(externalMessages as any, turnStartedAt)
            : '';
        // The transcript is authoritative for native-source providers. Use it unless it is
        // empty (not yet written, or no in-turn bubble) — only then fall back to the screen
        // parse, which reflects the LIVE screen (this turn's output), not the stale tail.
        if (externalSummary) {
            // Cache the resolved final assistant for the dashboard tail-repair in
            // getState(). This runs on EVERY completion attempt (including non-mesh
            // sessions whose generating_completed is suppressed, and short-gen
            // settle paths), so the dashboard sees the answer even when no
            // agent:generating_completed is ever emitted. Native read already ran.
            // externalSummary is already turn-scoped (extractFinalSummaryFromMessagesAfter
            // dropped any bubble predating turnStartedAt), so it is in-turn by construction.
            // Record the turn boundary as its source timestamp so the weak-completion
            // fallback (cachedInTurnCompletionSummaryContent) accepts it.
            host.lastCompletionSummary = { content: externalSummary, receivedAt: Date.now(), sourceTimestampMs: typeof turnStartedAt === 'number' ? turnStartedAt : undefined };
            host.lastFinalSummaryProvenance = {
                source: 'native_transcript',
                mayBeTruncated: false,
                contentLength: externalSummary.length,
            };
            return externalSummary;
        }
        // (SUMMARY-SCRAPE-FALLBACK) The native transcript yielded nothing for this turn while
        // the PTY screen already shows an assistant reply. That is the write-lag race: the
        // reply exists, it just has not been flushed to disk yet, and the scrape of it is an
        // arbitrary prefix (the terminal wrapped/scrolled it). Part A: hold the fallback for a
        // bounded window so the ordinary flush retry can pick up the complete transcript text.
        // Part B: past the bound, take the scrape but stamp it as possibly-truncated.
        if (parsedSummary) {
            host.lastFinalSummaryProvenance = {
                source: 'parsed_screen_fallback',
                mayBeTruncated: true,
                contentLength: parsedSummary.length,
            };
            return parsedSummary;
        }
        host.lastFinalSummaryProvenance = { source: 'none', mayBeTruncated: false, contentLength: 0 };
        return undefined;
    }
    // A genuinely PTY-parsed provider: the screen IS the canonical history, so there is no
    // better source this value could be a truncated prefix OF. Not flagged.
    host.lastFinalSummaryProvenance = parsedSummary
        ? { source: 'parsed_screen', mayBeTruncated: false, contentLength: parsedSummary.length }
        : { source: 'none', mayBeTruncated: false, contentLength: 0 };
    return parsedSummary || undefined;
}

/**
 * EMPTY-FINAL-CONTENT (kimi native-source TOCTOU): finalSummary for the CLEAN
 * finalization path (getCompletedFinalizationBlock returned null — the turn is already
 * proven done). Prefer extracting the summary from pending.resolvedFinalMessages, the
 * EXACT message snapshot completionFinalAssistantEvidence just proved `present:true`
 * from, instead of taking a brand-new independent read
 * (adapter.getScriptParsedStatus() / a fresh readExternalCompletionMessages() inside
 * completionFinalSummary). A native-source provider's on-disk transcript can be
 * rewritten/truncated between the two reads, and a PTY-buffer scrape can lose the
 * matched bubble to a repaint/scroll — either race can turn a proven-present turn into
 * an emitted completion with an empty assistant bubble. Falls back to the live
 * (pre-fix) read when no snapshot was cached (e.g. a code path that reaches the clean
 * emit without going through getCompletedFinalizationBlock first), so no other provider
 * class's behavior changes.
 */
export function cleanCompletionFinalSummary(host: EvidenceHost, pending: CompletedDebouncePending): string | undefined {
    if (Array.isArray(pending.resolvedFinalMessages)) {
        const fromSnapshot = extractFinalSummaryFromMessagesAfter(pending.resolvedFinalMessages as any, pending.turnStartedAt);
        if (fromSnapshot) {
            // (SUMMARY-SCRAPE-FALLBACK) The snapshot is only as good as the evidence source it
            // was captured from, and for a native-source provider that source can be the PTY
            // screen: completionFinalAssistantEvidence takes a `parsed` short-circuit / fail-open
            // for such a provider whenever its transcript is unresolved, and the resulting CLEAN
            // verdict extracts the summary from THAT snapshot — so the truncated screen text
            // reaches the emit without ever passing through completionFinalSummary's fallback
            // branch. This is the claude-cli case (chatMessagesOwnedExternally, busy-lease gate
            // off, so the parsed short-circuit fires). Flag it on the same axis.
            host.lastFinalSummaryProvenance = resolveSnapshotSummaryProvenance(host, pending, fromSnapshot);
            return fromSnapshot;
        }
    }
    return host.completionFinalSummary(host.adapter?.getScriptParsedStatus()?.messages, pending.turnStartedAt);
}

/**
 * (SUMMARY-SCRAPE-FALLBACK) Provenance for a summary taken from the completion's stashed
 * evidence snapshot. `parsed` evidence for a provider whose canonical history is the native
 * transcript means the screen won a race the transcript should have won — the clip risk. Every
 * other combination is complete by construction: `external-native`/`native-signal` evidence IS
 * the transcript, and `parsed` evidence for a screen-only provider has no better source.
 */
function resolveSnapshotSummaryProvenance(
    host: EvidenceHost,
    pending: CompletedDebouncePending,
    summary: string,
): FinalSummaryProvenance {
    const nativeSourceProvider = (host.adapter as any)?.chatMessagesOwnedExternally === true
        || isNativeSourceCanonicalHistory(host.provider?.nativeHistory);
    if (pending.resolvedFinalEvidenceSource === 'parsed') {
        return nativeSourceProvider
            ? { source: 'parsed_screen_fallback', mayBeTruncated: true, contentLength: summary.length }
            : { source: 'parsed_screen', mayBeTruncated: false, contentLength: summary.length };
    }
    return { source: 'native_transcript', mayBeTruncated: false, contentLength: summary.length };
}

/**
 * KIMI-RC30-COMPLETION-SUMMARY-NATIVE-SNAPSHOT: finalSummary seed for the
 * FORCED finalization-timeout emit. When the gate's last evidence probe proved
 * the turn's final assistant from an external-NATIVE read
 * (pending.resolvedFinalEvidenceSource === 'external-native'), the exact
 * snapshot it cached on pending.resolvedFinalMessages is the authoritative
 * final-message snapshot — extract from it rather than paying a second,
 * independent live read that can race a wire.jsonl rewrite between the probe
 * and the emit (same TOCTOU class cleanCompletionFinalSummary closed for the
 * clean path). A 'parsed' snapshot is deliberately NOT reused here: for a
 * native-source provider the parsed PTY scrape can be a stale Todo/progress
 * bullet (rc.30), so the native-preferring completionFinalSummary below must
 * get its say first. Turn-scoped by extractFinalSummaryFromMessagesAfter, so
 * a pre-turn bubble can never leak out of the snapshot either (fail closed).
 */
export function snapshotExternalNativeCompletionSummary(pending: CompletedDebouncePending): string | undefined {
    if (pending.resolvedFinalEvidenceSource !== 'external-native') return undefined;
    if (!Array.isArray(pending.resolvedFinalMessages)) return undefined;
    const fromSnapshot = extractFinalSummaryFromMessagesAfter(pending.resolvedFinalMessages as any, pending.turnStartedAt);
    return fromSnapshot || undefined;
}
