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
import type {
    CompletedDebouncePending,
    CompletionFinalAssistantEvidence,
    ExternalTranscriptProbe,
} from '../cli-provider-instance-types.js';
import type { SignalSnapshot } from '../spec/signal-envelope.js';
import type { ChatMessage } from '../../types.js';

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
    lastCompletionSummary: { content: string; receivedAt: number; sourceTimestampMs?: number } | null;
    // Instance-owned helpers the moved methods call.
    hasAdapterPendingResponse(): boolean;
    isModalParked(): boolean;
    probeNativeTranscriptSignals(): { snapshot: SignalSnapshot | null; messages: unknown[] | null } | null;
    busyLeaseGateEnabled(): boolean;
    injectedTaskHasStartedGenerating(): boolean;
    publishTranscriptSignalObservation(messages: unknown[] | null, error?: boolean): void;
    spawnedEnvOverrides(): Record<string, string> | undefined;
    lastVisibleAssistantSummaryDetail(messages: unknown): { content: string; timestampMs?: number };
    // Moved siblings, routed via the host so test overrides stay effective.
    completionHasFinalAssistantMessage(messages: unknown, turnStartedAt?: number): boolean;
    readExternalCompletionMessages(opts?: { allowManifestNativeSource?: boolean }): unknown[] | null;
    completionFinalSummary(parsedMessages: unknown, turnStartedAt?: number): string | undefined;
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
    });
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
            return externalSummary;
        }
        return parsedSummary || undefined;
    }
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
        if (fromSnapshot) return fromSnapshot;
    }
    return host.completionFinalSummary(host.adapter?.getScriptParsedStatus()?.messages, pending.turnStartedAt);
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
