/**
 * Claude TUI interactive-prompt (AskUserQuestion) capture and answering for
 * the spec-path adapter.
 *
 * Split out of cli-adapter.ts (file-size gate). The prompt STATE stays on
 * SpecCliAdapter (tests and the status projection read it there); every
 * function here reads and writes it only through the explicit
 * {@link ClaudeTuiPromptHost} view the adapter builds.
 */
import {
    normalizeClaudeTuiIdentity,
    claudeTuiQuestionMatches,
    claudeTuiQuestionTextAppears,
    claudeTuiPagesLookLikeSameQuestion,
    readClaudeTuiHeaders,
    claudeAskUserQuestionPromptsMatch,
    readClaudeToolResultIds,
} from './claude-tui-helpers.js';
import type { ISpecDriver } from './fsm-driver-types.js';
import type { FsmStatus } from './fsm-types.js';
import type { NativeHistoryConfig } from './types.js';
import { executeNativeHistory } from './native-history-executor.js';
import type { NativeHistoryInput } from './native-history-types.js';
import { readJsonlLines } from './native-history-jsonl-cache.js';
import {
    buildClaudeInteractiveTuiAnswerSteps,
    buildClaudeInteractiveToolResult,
    claudeTuiPreviewPanelVisible,
    detectClaudeAskUserQuestionPromptFromJson,
    detectClaudeAskUserQuestionPromptFromTuiPages,
    detectClaudeTuiMultiSelect,
    isClaudeTuiReviewScreen,
    readFocusedClaudeTuiQuestion,
    stableClaudeTuiPromptId,
    type ClaudeInteractiveTuiPage,
    type InteractivePrompt,
    type InteractivePromptResponse,
} from '../types/interactive-prompt.js';
import { detectClaudePendingQuestion } from '../claude-pending-question.js';
import type { AdapterChangeCause } from '../../cli-adapter-types.js';
import {
    CLAUDE_TUI_REVIEW_PAGE_NOT_FOCUSED_PREFIX,
    CLAUDE_TUI_REVIEW_UNCONFIRMED_PREFIX,
} from '@adhdev/mesh-shared';
import { LOG } from '../../logging/logger.js';
/** The adapter state + hooks the claude TUI prompt machinery reads/writes. */
export interface ClaudeTuiPromptHost {
    readonly cliType: string;
    readonly driver: Pick<ISpecDriver, 'snapshot' | 'dispatch'>;
    readonly latestState: { id: string; status: FsmStatus } | null;
    activeInteractivePrompt: InteractivePrompt | null;
    interactivePromptTransport: 'stream-json' | 'tui' | null;
    /** See SpecCliAdapter.interactivePromptLostAt. */
    interactivePromptLostAt: number | null;
    claudeTuiPromptCaptureInFlight: boolean;
    /** See SpecCliAdapter.claudeTuiCaptureSuppressed (OWNER-INPUT-WINS). */
    claudeTuiCaptureSuppressed: boolean;
    claudeTuiCaptureFailures: { key: string; count: number } | null;
    claudeTuiCaptureFooterAbsentAt: number | null;
    /** True when this session's interactive-prompt scheme is `claude_tui`. */
    isClaudeTuiScheme(): boolean;
    notifyChange(cause: AdapterChangeCause): void;
    /** Pending AskUserQuestion from claude's native JSONL (null on miss). */
    detectNativePendingQuestion(): InteractivePrompt | null;
    /** Native JSONL carries a tool_result bound to `prompt`. */
    hasBoundToolResult(prompt: InteractivePrompt): boolean;
}

/**
 * Grace window a held interactive prompt must be absent from the screen
 * before we treat it as resolved-in-terminal and clear it. claude-cli
 * repaints the picker across multiple PTY chunks, so a single
 * footer-less frame is not proof the prompt is gone. Sized in the same
 * spirit as the approval FSM's `approvalCooldown` modal-lost hysteresis.
 */
const INTERACTIVE_PROMPT_LOST_GRACE_MS = 1500;

/**
 * Multi-question TUI capture: after Tabbing to a page, re-snapshot at this
 * interval until its checkbox glyph column has settled, up to the timeout.
 * The interval matches the legacy single fixed wait (120ms); the timeout
 * bounds total capture time so a single-select page (which never shows
 * glyphs) doesn't stall the capture indefinitely.
 */
const CLAUDE_TUI_PAGE_POLL_INTERVAL_MS = 120;
const CLAUDE_TUI_PAGE_SETTLE_TIMEOUT_MS = 600;

/**
 * Review-page settle budget for a FREEFORM ("Other" / "Type something.")
 * answer specifically (residual gap after rc.34's settle-poll fix, live
 * defect 2026-08-29). CLAUDE_TUI_PAGE_SETTLE_TIMEOUT_MS was tuned against a
 * plain option-select transition — a single digit keypress that flips
 * straight to the review page with no reflow. A freeform confirm keystroke
 * instead commits a typed (possibly multi-byte/CJK, possibly wrapped)
 * string that the TUI must additionally lay out into the review echo
 * before the picker settles, which measurably exceeds the 600ms/5-sample
 * budget on a slower or higher-latency (remote CDP) link — the settle poll
 * exhausts on a still-question-shaped frame and assertFocusedClaudeTuiReview
 * fails closed with "Claude TUI review page is not focused for the active
 * interactive prompt" even though the review page was only moments away.
 * A short-lived retry from the caller then succeeds once real time has
 * passed, which is why the daemon log shows no repeated failures for a
 * question that visibly took over a minute to answer end-to-end.
 */
const CLAUDE_TUI_REVIEW_SETTLE_TIMEOUT_MS = 1800;
/** Max capture attempts per prompt identity before giving up (one retry). */
const CLAUDE_TUI_CAPTURE_MAX_ATTEMPTS = 2;

/**
 * Internal control-flow signal, never surfaced to a caller.
 *
 * assertFocusedClaudeTuiReview can discover — via the native tool_result —
 * that the answer already completed even though no review page rendered. It
 * must then stop setInteractivePromptResponse from writing the final Enter,
 * because focus no longer belongs to our question. Throwing this instead of
 * returning normally keeps that "do not press Enter" decision in one place;
 * setInteractivePromptResponse catches it and returns success.
 */
class ClaudeTuiAnswerDeliveredSignal extends Error {
    constructor() {
        super('claude-tui answer already delivered');
        this.name = 'ClaudeTuiAnswerDeliveredSignal';
    }
}

/**
 * Clear a held interactive prompt once the user has resolved it directly
 * in the terminal (the choice picker leaves the screen without going
 * through setInteractivePromptResponse). The approval path already does
 * this via the FSM's modal-lost hysteresis; the interactive-prompt path
 * had no equivalent, so a terminal-side answer left activeInteractivePrompt
 * set and getStatus() re-emitted the same choice modal forever.
 *
 * Detection is question-specific. "Enter to select" is shared by every
 * claude picker, so another picker must not keep this held question alive.
 * When the held question text is absent for
 * INTERACTIVE_PROMPT_LOST_GRACE_MS the prompt is genuinely resolved.
 */
export function maybeClearResolvedClaudeTuiPrompt(host: ClaudeTuiPromptHost, options: {
    screenText?: string;
    resolveImmediatelyWhenBusy?: boolean;
    resolvedByBoundToolResult?: boolean;
} = {}): 'held' | 'missing' | 'cleared' | 'unavailable' {
    if (!host.isClaudeTuiScheme() || !host.activeInteractivePrompt) return 'unavailable';
    // stream-json prompts are tracked by their tool-call lifecycle, not by
    // screen footer, but claude renders the same TUI picker for both
    // transports while awaiting an answer — so screen presence is a valid
    // resolved-signal for either. (If the screen read fails, keep holding.)
    let screenText = options.screenText;
    if (screenText === undefined) {
        try {
            screenText = host.driver.snapshot();
        } catch {
            return 'unavailable';
        }
    }
    const identifiableQuestions = host.activeInteractivePrompt.questions.filter(q => !!q.question?.trim());
    // Empty questions are not emitted by a real capture, but retaining the
    // footer fallback keeps defensive/manual prompt fixtures compatible.
    const stillOnScreen = identifiableQuestions.length > 0
        ? identifiableQuestions.some(q => claudeTuiQuestionTextAppears(q, screenText))
        : screenText.includes('Enter to select');
    if (stillOnScreen) {
        // Prompt reappeared / never left — reset the hysteresis timer.
        host.interactivePromptLostAt = null;
        return 'held';
    }
    // During a dashboard answer, a provider transition to busy is causal
    // confirmation that the final choice was submitted. Combined with the
    // bound question text being absent, it is stronger than the ordinary
    // terminal-side stale cleanup and does not need its repaint grace.
    // The review poll only enables this after ruling out a focused foreign
    // question, preserving the wrong-picker fail-closed guard.
    const resolvedByBusyAdvance = options.resolveImmediatelyWhenBusy === true
        && host.latestState?.status === 'generating';
    const resolvedByBoundToolResult = options.resolvedByBoundToolResult === true;
    const lostAt = host.interactivePromptLostAt ?? Date.now();
    if (host.interactivePromptLostAt == null) host.interactivePromptLostAt = lostAt;
    if (!resolvedByBusyAdvance && !resolvedByBoundToolResult
        && Date.now() - lostAt < INTERACTIVE_PROMPT_LOST_GRACE_MS) return 'missing';
    // Resolved in the terminal — drop the held prompt so getStatus() stops
    // re-emitting it.
    host.activeInteractivePrompt = null;
    host.interactivePromptTransport = null;
    host.interactivePromptLostAt = null;
    host.notifyChange('prompt_cleared');
    return 'cleared';
}

/**
 * Read the pending AskUserQuestion off claude's native JSONL transcript, or
 * null when there is none / it cannot be read.
 *
 * `ADHDEV_DISABLE_CLAUDE_JSONL_PROMPT=1` forces the legacy screen-scrape
 * path. It exists so the fallback stays exercisable — both in the injection
 * test that proves the scrape still produces the (broken) split labels, and
 * on a live machine where a transcript-format change would otherwise need a
 * downgrade to diagnose.
 */
export function detectClaudeNativePendingQuestion(
    nativeHistory: NativeHistoryConfig | undefined,
    input: NativeHistoryInput,
): InteractivePrompt | null {
    if (process.env.ADHDEV_DISABLE_CLAUDE_JSONL_PROMPT === '1') return null;
    if (!nativeHistory?.source) return null;
    try {
        return detectClaudePendingQuestion(nativeHistory, input);
    } catch {
        // Fail open: the caller falls back to the screen scrape.
        return null;
    }
}

/**
 * True only when the native Claude JSONL contains a tool_result for the
 * AskUserQuestion bound to `prompt`. TUI-captured prompts use a stable
 * content-derived id rather than Claude's tool_use id, so bind the native
 * call by its exact question/header/option identity first (ignoring only
 * Claude's synthetic freeform/chat rows) and only then accept its matching
 * tool_use_id. A later identical unresolved call resets the result, keeping
 * latest-call-wins semantics.
 */
export function hasBoundClaudeAskUserQuestionToolResult(
    cliType: string,
    nativeHistory: NativeHistoryConfig | undefined,
    input: NativeHistoryInput,
    prompt: InteractivePrompt,
): boolean {
    if (cliType !== 'claude-cli' || !nativeHistory || nativeHistory.source?.kind !== 'jsonl') return false;
    try {
        const history = executeNativeHistory(nativeHistory, input);
        if (!history?.sourcePath) return false;

        let boundToolUseId: string | null = null;
        let resolved = false;
        for (const record of readJsonlLines(history.sourcePath)) {
            const observedPrompt = detectClaudeAskUserQuestionPromptFromJson(record, cliType);
            if (observedPrompt
                && (observedPrompt.promptId === prompt.promptId
                    || claudeAskUserQuestionPromptsMatch(prompt, observedPrompt))) {
                boundToolUseId = observedPrompt.promptId;
                resolved = false;
            }
            if (!boundToolUseId) continue;
            if (readClaudeToolResultIds(record).includes(boundToolUseId)) resolved = true;
        }
        return resolved;
    } catch {
        // Native history is corroborating evidence only. If it cannot be
        // read or bound, retain the screen/state fail-closed path.
        return false;
    }
}

export function maybeCaptureClaudeTuiPrompt(host: ClaudeTuiPromptHost): void {
    if (!host.isClaudeTuiScheme()
        || host.activeInteractivePrompt
        || host.claudeTuiPromptCaptureInFlight) return;
    // QUOTED-MARKER DEFENCE (2026-08-28): the capture below is pure screen
    // scraping, so a session that merely PRINTS the picker's marker strings
    // ("Enter to select", "✔ Submit", "❐ 1. …" — e.g. quoting a TUI layout
    // in its own output) used to parse as a live picker and publish a phony
    // waiting_choice prompt while the agent was still generating.
    //
    // The FSM already distinguishes the two: the claude spec has a dedicated
    // `picker` state (status falls through to idle) and its `busy` state
    // transitions explicitly NOT-match the picker footer, so a real picker is
    // never reported as generating. Gating on that is the same cheap
    // cross-check the kimi built-in selector already applies for the exact
    // same failure mode (refreshWirePendingQuestion: "a quoted snapshot in
    // scrolling output must never parse as the picker").
    if (host.latestState?.status === 'generating') return;
    const screenText = host.driver.snapshot();
    if (!screenText.includes('Enter to select')) {
        // Picker gone — re-arm capture for the next prompt, but only once
        // the footer has STAYED absent across the repaint-grace window.
        // A single footer-less frame is claude mid-repaint (chunked
        // redraw), not a closed picker: clearing the latch here on one
        // frame is how capture re-armed and restarted key injection
        // while the owner was mid-answer.
        const now = Date.now();
        if (host.claudeTuiCaptureFooterAbsentAt === null) host.claudeTuiCaptureFooterAbsentAt = now;
        if (now - host.claudeTuiCaptureFooterAbsentAt >= INTERACTIVE_PROMPT_LOST_GRACE_MS) {
            host.claudeTuiCaptureSuppressed = false;
            host.claudeTuiCaptureFailures = null;
        }
        return;
    }
    host.claudeTuiCaptureFooterAbsentAt = null;

    // NATIVE-JSONL FIRST (structured source of truth). The picker IS on
    // screen (footer present, not generating) — so if claude's own
    // transcript shows an unanswered AskUserQuestion, take its verbatim
    // labels/descriptions/previews instead of scraping them back off the
    // terminal, where a wrapped label is indistinguishable from a
    // description. Screen presence stays the liveness gate; the transcript
    // supplies only the CONTENT.
    //
    // Deliberately non-exclusive: on any miss (transcript not yet written,
    // unresolvable path, read error) this falls through to the scrape below
    // unchanged. That fallback is why a JSONL write lagging the repaint
    // degrades to the old behaviour rather than to no prompt at all.
    const nativePrompt = host.detectNativePendingQuestion();
    if (nativePrompt) {
        host.activeInteractivePrompt = nativePrompt;
        host.interactivePromptTransport = 'tui';
        host.interactivePromptLostAt = null;
        host.notifyChange('prompt_captured');
        return;
    }

    const headers = readClaudeTuiHeaders(screenText);
    if (headers.length === 0) {
        // Headerless (single-question) capture parses the CURRENT screen
        // only and injects no keys — always safe, even while the owner is
        // driving the picker from the terminal.
        const prompt = detectClaudeAskUserQuestionPromptFromTuiPages([{ screenText }], {
            // REBIND OPTION FIDELITY (rc.20): provisional id — replaced with the
            // content-addressed stable id below, so the SAME picker re-captured
            // after a daemon restart keeps the SAME promptId and pre-restart
            // answers still bind to the options they were issued against.
            promptId: 'ask-user-tui-pending',
            providerType: host.cliType,
        });
        if (!prompt) return;
        prompt.promptId = stableClaudeTuiPromptId(prompt.questions);
        host.activeInteractivePrompt = prompt;
        host.interactivePromptTransport = 'tui';
        host.interactivePromptLostAt = null;
        host.notifyChange('prompt_captured');
        return;
    }
    // Owner is driving this picker from the terminal — stay hands-off. The
    // multi-question capture injects Tab/Shift-Tab into the same input
    // stream the owner's keystrokes are in.
    if (host.claudeTuiCaptureSuppressed) return;
    // The review/submit page ("Ready to submit your answers?") still shows
    // the nav line + footer, so it looks capturable — but it parses to null
    // BY DESIGN, which used to leave activeInteractivePrompt null and
    // re-arm this whole capture on the very next frame: a Tab/Shift-Tab
    // injection loop running at the exact moment the owner presses Enter
    // on the pre-selected Submit row. Never capture from the review page.
    if (isClaudeTuiReviewScreen(screenText)) return;
    // Bound retries per prompt identity so an unparsable picker cannot
    // become a key-injection storm (see claudeTuiCaptureFailures).
    const navKey = headers.join('\u0001');
    if (host.claudeTuiCaptureFailures?.key === navKey
        && host.claudeTuiCaptureFailures.count >= CLAUDE_TUI_CAPTURE_MAX_ATTEMPTS) return;
    host.claudeTuiPromptCaptureInFlight = true;
    void captureClaudeTuiPrompt(host, screenText, headers).finally(() => {
        host.claudeTuiPromptCaptureInFlight = false;
    });
}

/**
 * The TUI prompt is captured on the FIRST frame that renders the
 * "Enter to select" footer. At that instant the option rows' checkbox
 * column may not have drawn yet, so `detectClaudeTuiMultiSelect` returns
 * false and the prompt is frozen as single-select — the dashboard then
 * renders radio buttons even though the picker is multi-select.
 *
 * While the same TUI prompt is still on screen, re-check the live snapshot:
 * if checkbox glyphs have since appeared, promote any single-select
 * question to multi-select and re-emit status. Promotion is one-way
 * (false→true only) — once a question is known multi-select we never demote
 * it, since the glyph column can scroll out of view on later frames.
 *
 * For MULTI-question prompts the per-page Tab capture is the actual source
 * of the bug: pages 2..N are snapshotted ~120ms after the Tab keypress,
 * before their option-row glyph column has redrawn, so those questions
 * freeze as single-select while page 1 (already settled) is correct. We
 * cannot upgrade blindly — the live snapshot shows only ONE focused page —
 * but we CAN read that page's question text/header and upgrade the matching
 * question. As the user navigates the picker (or it settles), each page is
 * eventually re-read and repaired.
 */
export function maybeUpgradeClaudeTuiMultiSelect(host: ClaudeTuiPromptHost): void {
    if (!host.isClaudeTuiScheme()
        || host.interactivePromptTransport !== 'tui'
        || !host.activeInteractivePrompt) return;
    const questions = host.activeInteractivePrompt.questions;
    if (questions.every(q => q.multiSelect)) return;
    let screenText = '';
    try {
        screenText = host.driver.snapshot();
    } catch {
        return;
    }
    if (!screenText.includes('Enter to select')) return;

    if (questions.length === 1) {
        if (questions[0].multiSelect) return;
        const focused = readFocusedClaudeTuiQuestion(screenText);
        if (!focused || !claudeTuiQuestionMatches(questions[0], focused) || !focused.multiSelect) return;
        questions[0].multiSelect = true;
        host.notifyChange('prompt_updated');
        return;
    }

    // Multi-question: attribute the focused page's glyphs to its question by
    // matching header (preferred) or question text, then upgrade just that
    // one. Never demote — a settled non-multi page is left as captured.
    const focused = readFocusedClaudeTuiQuestion(screenText);
    if (!focused || !focused.multiSelect) return;
    const match = questions.find(q => claudeTuiQuestionMatches(q, focused));
    if (!match || match.multiSelect) return;
    match.multiSelect = true;
    host.notifyChange('prompt_updated');
}

export function readClaudeTuiSnapshotForAnswer(host: ClaudeTuiPromptHost): string {
    try {
        return host.driver.snapshot();
    } catch (error: any) {
        throw new Error(`Cannot verify the focused Claude TUI question before answering: ${error?.message || error}`);
    }
}

export async function assertFocusedClaudeTuiQuestion(host: ClaudeTuiPromptHost, 
    expected: InteractivePrompt['questions'][number],
    prompt: InteractivePrompt,
): Promise<'focused' | 'completed'> {
    // MULTI-QUESTION PAGE REPAINT RACE (live defect, 2026-09-02).
    //
    // This used to gate on a SINGLE snapshot. In a multi-question prompt the
    // keystroke that answers question N is also what navigates the picker
    // onto question N+1, and that repaint is not instantaneous: the fixed
    // 180ms inter-key delay in setInteractivePromptResponse races it. On a
    // slow frame the next iteration's snapshot still showed the PREVIOUS
    // page, so the assertion fired with expected = the question we were
    // about to answer and focused = the one still on screen — the observed
    // "expected <question 2>; focused question is <question 1>" failure.
    // Because the picker never moves, every retry reproduced it identically:
    // a permanent deadlock on any 2+ question prompt.
    //
    // Single-question prompts never hit this (one iteration, no page
    // transition), which is why the defect looked multi-question-specific.
    //
    // The fix is the same bounded settle-poll assertFocusedClaudeTuiReview
    // already applies to the review page for this exact class of race: keep
    // re-snapshotting until the expected page lands, then fall through to
    // the last frame so a genuinely WRONG screen still fails closed with its
    // real content. A foreign picker that never becomes the expected page
    // costs only the bounded budget before it is rejected.
    const settleTimeoutMs = expected.allowFreeform
        ? CLAUDE_TUI_REVIEW_SETTLE_TIMEOUT_MS
        : CLAUDE_TUI_PAGE_SETTLE_TIMEOUT_MS;
    const deadline = Date.now() + settleTimeoutMs;
    let screenText = readClaudeTuiSnapshotForAnswer(host);
    let focused = readFocusedClaudeTuiQuestion(screenText);
    while (Date.now() < deadline && !(focused && claudeTuiQuestionMatches(expected, focused))) {
        // Either a stale/foreign page or no picker at all. Both can be
        // mid-repaint, and the no-picker case is separately resolved as
        // 'completed' below — so keep sampling rather than deciding on a
        // single transient frame.
        await new Promise(resolve => setTimeout(resolve, CLAUDE_TUI_PAGE_POLL_INTERVAL_MS));
        screenText = readClaudeTuiSnapshotForAnswer(host);
        focused = readFocusedClaudeTuiQuestion(screenText);
    }
    if (focused) {
        if (claudeTuiQuestionMatches(expected, focused)) return 'focused';
        throw new Error(`Claude TUI focused question does not match the active interactive prompt (expected "${expected.question}"; focused question is "${focused.question}")`);
    }

    // A direct-submit Claude TUI can resolve the question after an early
    // keystep (for example, the first digit of a previously multi-step
    // answer). Once the picker is gone, corroborate completion before
    // stopping the key loop so no remaining answer keys leak into the next
    // widget. A visible foreign picker is handled above and always fails
    // closed, even if the provider concurrently reports busy.
    const resolvedByBoundToolResult = host.hasBoundToolResult(prompt);
    const resolvedByBusyAdvance = host.latestState?.status === 'generating';
    if (resolvedByBoundToolResult || resolvedByBusyAdvance) return 'completed';

    throw new Error(`Claude TUI focused question does not match the active interactive prompt (expected "${expected.question}")`);
}

/**
 * Wait for the review page to actually be on screen before the final Enter.
 *
 * The last answer keystroke is what navigates the picker onto its review
 * page, and the TUI repaint is not instantaneous. Gating on a single
 * snapshot taken a fixed delay after that keypress races the repaint: on a
 * slow frame the assertion still sees the previous question page and fails
 * closed, refusing an answer that was in fact correct (live defect
 * 2026-08-28). Poll on the same bounded budget the capture path already
 * uses (snapshotSettledClaudeTuiPage) and accept the first frame that reads
 * as the review page; on timeout fall through to the last frame so a
 * genuinely wrong screen still fails closed with its real content.
 *
 * `widenSettleBudget` widens the budget to
 * CLAUDE_TUI_REVIEW_SETTLE_TIMEOUT_MS in two measured cases:
 *   - freeform-capable pickers ("Type something." / Other) carry a heavier
 *     layout burden even when a standard option is selected (residual gap,
 *     live defect 2026-08-29);
 *   - preview-layout answers (2026-09-11): a single-question preview
 *     prompt submits directly with NO review page, so its resolution
 *     signal is native tool_result / busy-advance / the 1500ms lost-grace
 *     clear — the 600ms page budget can never observe that last one.
 */
export async function snapshotSettledClaudeTuiReview(host: ClaudeTuiPromptHost, prompt: InteractivePrompt, widenSettleBudget: boolean): Promise<string | null> {
    let screenText = readClaudeTuiSnapshotForAnswer(host);
    const budgetMs = widenSettleBudget
        ? CLAUDE_TUI_REVIEW_SETTLE_TIMEOUT_MS
        : CLAUDE_TUI_PAGE_SETTLE_TIMEOUT_MS;
    const deadline = Date.now() + budgetMs;
    let poll = 0;
    while (true) {
        poll += 1;
        const focused = readFocusedClaudeTuiQuestion(screenText);
        const review = !focused && isClaudeTuiReviewScreen(screenText);
        let classification: string;
        let directSubmitted = false;

        if (focused) {
            const boundQuestion = prompt.questions.some(question => claudeTuiQuestionMatches(question, focused));
            classification = boundQuestion ? 'bound_question' : 'foreign_question';
        } else if (review) {
            classification = 'review';
        } else if (!host.activeInteractivePrompt) {
            // The ordinary stale cleanup or a future native tool-result
            // observer may have cleared the prompt between poll samples.
            classification = 'direct_submit_already_cleared';
            directSubmitted = true;
        } else if (host.activeInteractivePrompt.promptId !== prompt.promptId) {
            classification = 'active_prompt_changed';
        } else {
            const resolvedByBoundToolResult = host.hasBoundToolResult(prompt);
            const resolution = maybeClearResolvedClaudeTuiPrompt(host, {
                screenText,
                resolveImmediatelyWhenBusy: true,
                resolvedByBoundToolResult,
            });
            classification = resolution === 'cleared'
                ? resolvedByBoundToolResult
                    ? 'direct_submit_tool_result'
                    : 'direct_submit_busy'
                : resolution === 'held'
                    ? 'bound_question_unparsed'
                    : resolution === 'missing'
                        ? 'bound_question_missing'
                        : 'snapshot_unavailable';
            directSubmitted = resolution === 'cleared';
        }

        // Screen text can contain source, secrets, or user input. Keep the
        // answer-settle diagnostic deliberately structural: classification,
        // UTF-8 byte count, poll index, and spec-defined provider state.
        LOG.debug(
            'SpecAdapter',
            `[${host.cliType}] Claude TUI answer poll=${poll} classification=${classification} screenBytes=${Buffer.byteLength(screenText, 'utf8')} providerState=${host.latestState?.id ?? 'unknown'} providerStatus=${host.latestState?.status ?? 'unknown'} widenSettleBudget=${widenSettleBudget}`,
        );

        if (review) return screenText;
        if (directSubmitted) return null;
        if (Date.now() >= deadline) return screenText;
        await new Promise(resolve => setTimeout(resolve, CLAUDE_TUI_PAGE_POLL_INTERVAL_MS));
        screenText = readClaudeTuiSnapshotForAnswer(host);
    }
}

export async function assertFocusedClaudeTuiReview(host: ClaudeTuiPromptHost, prompt: InteractivePrompt, widenSettleBudget: boolean): Promise<void> {
    const screenText = await snapshotSettledClaudeTuiReview(host, prompt, widenSettleBudget);
    if (screenText === null) return;
    const focused = readFocusedClaudeTuiQuestion(screenText);
    if (focused || !isClaudeTuiReviewScreen(screenText)) {
        const observed = focused?.question ? `; focused question is "${focused.question}"` : '';

        // DELIVERED-BUT-UNCONFIRMED vs WRONG-SCREEN (live defect 2026-09-06,
        // sixth recurrence of this class: f1720f8e, 6db3527e, 50bfe16d,
        // d476f356, 60bd7614, and the 2026-09-02 per-keystroke poll).
        //
        // By the time this gate runs, every answer keystroke has ALREADY been
        // written to the PTY by setInteractivePromptResponse's key loop — only
        // the final review Enter is outstanding. A timeout here therefore
        // means "the keys arrived but the picker did not visibly advance".
        // That is NOT proof the answer was submitted: in the preview
        // (side-by-side) layout a digit only highlights, so pre-2026-09-11
        // this very state was reached with NOTHING submitted (the 09-10
        // incident). The preview protocol fix above (commit Enter) removes
        // the known cause, but this branch must still describe both
        // possibilities honestly instead of claiming delivery.
        //
        // Two outcomes have to be told apart, and the previous code collapsed
        // them into one hard failure:
        //
        //   WRONG SCREEN — a FOREIGN question is focused, or the screen is some
        //     other widget entirely. We must not press Enter into something we
        //     do not own. Keep failing closed; this is the guard that stops a
        //     stale response from operating another picker.
        //
        //   UNCONFIRMED — our OWN bound question is still the focused page. The
        //     picker simply has not advanced within the settle budget. The
        //     input is delivered and the screen is ours, so reporting "failed"
        //     is a false negative, and inviting a retry is actively harmful:
        //     replaying the keystroke sequence double-submits into a picker
        //     that may have advanced in the meantime.
        //
        // Every prior fix in this class widened a timeout, and the race
        // resurfaced on the next slower link. Widening cannot terminate:
        // no finite budget bounds an arbitrarily slow remote repaint. This
        // instead makes the OUTCOME correct at whatever budget we have.
        const boundQuestionStillFocused = !!focused
            && prompt.questions.some(question => claudeTuiQuestionMatches(question, focused));

        if (boundQuestionStillFocused) {
            // Authoritative delivery oracle: if Claude's native JSONL already
            // carries a tool_result for this AskUserQuestion, the answer landed
            // and the terminal completed it — the missing review page is purely
            // a rendering lag. Treat that as success and release the prompt the
            // same way the direct-submit path does.
            if (host.hasBoundToolResult(prompt)) {
                LOG.info('SpecAdapter', `[${host.cliType}] review page unsettled but native tool_result confirms delivery — accepting (widenSettleBudget=${widenSettleBudget})`);
                host.activeInteractivePrompt = null;
                host.interactivePromptTransport = null;
                host.interactivePromptLostAt = null;
                host.notifyChange('prompt_cleared');
                throw new ClaudeTuiAnswerDeliveredSignal();
            }
            // Keys written, submission unconfirmed. Distinct error class so
            // the UI can say "could not confirm" instead of "failed", and
            // suppress retry. Do NOT claim delivery: with the question
            // still on screen the answer may equally well not have been
            // submitted at all (the pre-fix preview layout produced exactly
            // this state with nothing submitted — 09-10 incident).
            LOG.warn('SpecAdapter', `[${host.cliType}] picker still shows our bound question after the settle budget — answer keys were written but submission is unconfirmed and may not have happened (widenSettleBudget=${widenSettleBudget})${observed}`);
            throw new Error(`${CLAUDE_TUI_REVIEW_UNCONFIRMED_PREFIX} — the answer keys were written to the terminal, but the question is still on screen, so the answer may not have been submitted; check the terminal before answering again${observed}`);
        }

        // Log here, not just throw: the caller (mesh-events.ts
        // interactive_prompt_response handler) returns this over the P2P
        // command response as a plain { success: false } object with no
        // LOG.* call of its own, so without a line here this failure class
        // leaves NO trace in the daemon log — confirmed live 2026-08-29,
        // where a dashboard-visible "review page is not focused" error had
        // zero matching log output.
        LOG.warn('SpecAdapter', `[${host.cliType}] assertFocusedClaudeTuiReview failed closed (widenSettleBudget=${widenSettleBudget})${observed}`);
        throw new Error(`${CLAUDE_TUI_REVIEW_PAGE_NOT_FOCUSED_PREFIX} for the active interactive prompt${observed}`);
    }

    // Review pages retain the per-question nav headers. When the captured
    // prompt has headers, require the focused review nav to carry them so
    // a second AskUserQuestion review page cannot borrow the final Enter.
    const expectedHeaders = prompt.questions
        .map(q => q.header && normalizeClaudeTuiIdentity(q.header))
        .filter((header): header is string => !!header);
    if (expectedHeaders.length === 0) return;
    const reviewHeaders = readClaudeTuiHeaders(screenText)
        .map(header => normalizeClaudeTuiIdentity(header));
    if (expectedHeaders.every(header => reviewHeaders.includes(header))) return;
    throw new Error('Claude TUI review page does not match the active interactive prompt headers');
}

/**
 * Snapshot the currently-focused claude TUI page, polling until its
 * option-row checkbox glyph column has settled (or a bounded timeout).
 *
 * Why poll: right after a Tab keypress the newly-focused page's glyph
 * column has not redrawn yet, so an immediate snapshot shows the question +
 * option labels but NO per-option checkbox markers — freezing that page as
 * single-select. A fixed delay either races (too short) or is wasteful (too
 * long). Instead we re-snapshot at a fixed interval and stop as soon as the
 * frame shows multi-select glyphs, falling back to the last frame at the
 * timeout. Single-select pages never show glyphs, so they always poll to the
 * timeout — bounded small to keep capture snappy.
 */
export async function snapshotSettledClaudeTuiPage(host: ClaudeTuiPromptHost): Promise<string> {
    let screenText = host.driver.snapshot();
    const deadline = Date.now() + CLAUDE_TUI_PAGE_SETTLE_TIMEOUT_MS;
    while (!detectClaudeTuiMultiSelect(screenText) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, CLAUDE_TUI_PAGE_POLL_INTERVAL_MS));
        screenText = host.driver.snapshot();
    }
    return screenText;
}

export async function captureClaudeTuiPrompt(host: ClaudeTuiPromptHost, firstScreen: string, headers: string[]): Promise<void> {
    // Owner typed between detection and capture start — bail before any
    // key is injected (owner input wins over dashboard capture fidelity).
    if (host.claudeTuiCaptureSuppressed) return;
    const pages: ClaudeInteractiveTuiPage[] = [{ screenText: firstScreen, header: headers[0] }];
    // Forward pass: Tab to each page 2..N and snapshot once its glyph column
    // has settled, so pages 2+ capture their checkbox markers (not a racy
    // pre-redraw frame).
    for (let index = 1; index < headers.length; index += 1) {
        // Abort before injecting the NEXT key if the owner started typing
        // mid-capture — the keys below land in the owner's input stream.
        if (host.claudeTuiCaptureSuppressed) return;
        host.driver.dispatch({ kind: 'pty_write', data: '\t' });
        await new Promise(resolve => setTimeout(resolve, CLAUDE_TUI_PAGE_POLL_INTERVAL_MS));
        pages.push({ screenText: await snapshotSettledClaudeTuiPage(host), header: headers[index] });
    }
    // Return pass: Shift-Tab back through pages N..2. As we land on each page
    // again re-read it and OR-in any now-visible multi-select glyphs — a
    // second chance to repair a page whose forward-pass frame was still racy.
    for (let index = headers.length - 1; index > 0; index -= 1) {
        if (host.claudeTuiCaptureSuppressed) return;
        host.driver.dispatch({ kind: 'pty_write', data: '\x1b[Z' });
        await new Promise(resolve => setTimeout(resolve, CLAUDE_TUI_PAGE_POLL_INTERVAL_MS));
        const reread = await snapshotSettledClaudeTuiPage(host);
        // The page we just Shift-Tab'd ONTO is index-1 (we move backwards).
        const landed = pages[index - 1];
        if (landed
            && !detectClaudeTuiMultiSelect(landed.screenText)
            && detectClaudeTuiMultiSelect(reread)
            // PAGE IDENTITY GUARD: the swap below replaces this page's WHOLE
            // raw screen, so it is only sound if `reread` is the same page we
            // captured going forward. The glyph signal alone cannot tell us
            // that: if the Shift-Tab keypress was swallowed (or the picker had
            // not moved yet when the frame settled) the re-read is still the
            // NEXT page, and we would overwrite this question with that one's
            // text + options + checkboxes. Because `header` is carried
            // separately (by nav-line index) it stays correct, producing the
            // observed symptom — question N-1 rendered with its own header but
            // question N's title, body and checkboxes.
            && claudeTuiPagesLookLikeSameQuestion(landed, reread)) {
            landed.screenText = reread;
        }
    }

    const prompt = detectClaudeAskUserQuestionPromptFromTuiPages(pages, {
        // REBIND OPTION FIDELITY (rc.20): provisional id — replaced with the
        // content-addressed stable id below (same rationale as the
        // headerless capture in maybeCaptureClaudeTuiPrompt).
        promptId: 'ask-user-tui-pending',
        providerType: host.cliType,
    });
    if (!prompt) {
        // Parse failure: the picker stays un-held, so maybeCapture would
        // re-run this whole injection pass on the next frame. Count the
        // failure against this prompt's nav identity so retries are
        // bounded (CLAUDE_TUI_CAPTURE_MAX_ATTEMPTS).
        noteClaudeTuiCaptureFailure(host, headers);
        return;
    }
    host.claudeTuiCaptureFailures = null;
    prompt.promptId = stableClaudeTuiPromptId(prompt.questions);
    host.activeInteractivePrompt = prompt;
    host.interactivePromptTransport = 'tui';
    host.interactivePromptLostAt = null;
    host.notifyChange('prompt_captured');
}

/** Record a failed multi-question capture against the prompt's nav-line
 *  identity so maybeCaptureClaudeTuiPrompt can bound retries. */
export function noteClaudeTuiCaptureFailure(host: ClaudeTuiPromptHost, headers: string[]): void {
    const navKey = headers.join('\u0001');
    if (host.claudeTuiCaptureFailures?.key === navKey) {
        host.claudeTuiCaptureFailures.count += 1;
    } else {
        host.claudeTuiCaptureFailures = { key: navKey, count: 1 };
    }
    const { count } = host.claudeTuiCaptureFailures;
    LOG.warn(
        'SpecAdapter',
        `[${host.cliType}] TUI prompt capture failed to parse (attempt ${count}/${CLAUDE_TUI_CAPTURE_MAX_ATTEMPTS}) — ${count >= CLAUDE_TUI_CAPTURE_MAX_ATTEMPTS ? 'giving up until the picker leaves the screen' : 'one retry remains'}`,
    );
}

/**
 * Answer the held claude_tui prompt: TUI keystrokes (bound to the live
 * focused question, then the review page) or a stream-json tool_result
 * line. Clears the held prompt on success; throws (leaving it held) when the
 * live screen does not belong to it.
 */
export async function answerClaudeInteractivePrompt(
    host: ClaudeTuiPromptHost,
    prompt: InteractivePrompt,
    response: InteractivePromptResponse,
): Promise<void> {
    if (host.interactivePromptTransport === 'tui') {
        // A claude terminal can render another picker above the held
        // AskUserQuestion. promptId only binds the dashboard response to
        // our held slot; it says nothing about which terminal widget owns
        // focus. Bind every key to the live focused question before it is
        // written, then require the matching review page for final Enter.
        // A mismatch fails closed and deliberately leaves the held prompt
        // intact so a stale response cannot operate another picker.
        const allowsFreeform = prompt.questions.some(q => q.allowFreeform);
        let completedWithoutReview = false;
        // PREVIEW (side-by-side) LAYOUT (measured live against claude-cli
        // v2.1.220, 2026-09-11): with `preview` options a digit key only
        // highlights — the commit key is one explicit Enter. When the
        // captured options still carry preview metadata (native JSONL
        // capture) the keystroke builder already appends that Enter; this
        // flag additionally covers the TUI-scrape capture below and widens
        // the review settle budget: a single-question preview prompt shows
        // NO review page, so its confirmation can only arrive via native
        // tool_result / busy-advance / the 1500ms lost-grace clear, which
        // structurally exceeds the 600ms page budget.
        let previewLayoutAnswer = prompt.questions.some(q => q.options.some(o => o.preview));
        // Validate the WHOLE response before the first key. Steps are built per
        // question below, so a response missing q2 used to type q1's answer and
        // only then fail (2026-10-01): the caller saw "not delivered" while the
        // terminal had moved on to q2, and every later answer was refused as a
        // focus mismatch.
        buildClaudeInteractiveTuiAnswerSteps(prompt, response);
        questionLoop: for (const question of prompt.questions) {
            const questionSteps = buildClaudeInteractiveTuiAnswerSteps({
                ...prompt,
                questions: [question],
            }, response).slice(0, -1); // final Enter belongs to the review page below
            for (const step of questionSteps) {
                if (await assertFocusedClaudeTuiQuestion(host, question, prompt) === 'completed') {
                    completedWithoutReview = true;
                    break questionLoop;
                }
                host.driver.dispatch({ kind: 'pty_write', data: step });
                await new Promise(resolve => setTimeout(resolve, 180));
            }
            // Screen fallback for the preview layout: a TUI-scrape-captured
            // prompt has no preview metadata (the scrape strips the panel),
            // so its single-select steps end with a bare digit that only
            // highlighted the option. If our own bound question is STILL the
            // focused picker after that digit AND the frame shows the
            // side-by-side preview panel, commit it with the one Enter the
            // layout requires. Both conditions are read off the live frame,
            // so the digit-auto-advances non-preview flow (question already
            // gone or panel-less) never receives this Enter.
            const answer = response.answers[question.questionId];
            const singleSelectDigitOnly = !question.multiSelect
                && (answer?.selectedLabels.length ?? 0) === 1
                && !answer?.freeformText?.trim();
            if (singleSelectDigitOnly && !question.options.some(o => o.preview)) {
                const screenText = readClaudeTuiSnapshotForAnswer(host);
                const focused = readFocusedClaudeTuiQuestion(screenText);
                if (focused
                    && claudeTuiQuestionMatches(question, focused)
                    && claudeTuiPreviewPanelVisible(screenText)) {
                    previewLayoutAnswer = true;
                    LOG.info('SpecAdapter', `[${host.cliType}] preview panel layout detected on screen after digit — sending commit Enter (question "${question.questionId}")`);
                    host.driver.dispatch({ kind: 'pty_write', data: '\r' });
                    await new Promise(resolve => setTimeout(resolve, 180));
                }
            }
        }
        if (!completedWithoutReview) {
            try {
                await assertFocusedClaudeTuiReview(host, prompt, allowsFreeform || previewLayoutAnswer);
            } catch (error) {
                // The review gate proved (via native tool_result) that the
                // answer already landed with no review page to confirm. It has
                // already released the held prompt; return success WITHOUT the
                // final Enter, which would now go to whatever the provider
                // rendered next. Every other error propagates unchanged.
                if (error instanceof ClaudeTuiAnswerDeliveredSignal) return;
                throw error;
            }
            // Claude Code >=2.1.220 completes AskUserQuestion immediately after
            // the final choice. In that direct-submit path the settle poll
            // clears the bound prompt and there is no review page to confirm.
            // Never send a second Enter after that completion signal: focus now
            // belongs to the provider's busy screen (or whatever it renders
            // next), not to the question we answered.
            if (!host.activeInteractivePrompt) return;
            if (host.activeInteractivePrompt.promptId !== prompt.promptId) {
                throw new Error('Claude TUI active interactive prompt changed before review submission');
            }
            host.driver.dispatch({ kind: 'pty_write', data: '\r' });
            await new Promise(resolve => setTimeout(resolve, 180));
        }
    } else {
        host.driver.dispatch({ kind: 'pty_write', data: `${buildClaudeInteractiveToolResult(response)}\n` });
    }
    host.activeInteractivePrompt = null;
    host.interactivePromptTransport = null;
    host.notifyChange('prompt_cleared');
}
