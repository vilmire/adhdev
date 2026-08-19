import type { ChatMessage } from '../types.js';
import { flattenContent } from './contracts.js';

export const DEFAULT_FINAL_SUMMARY_MAX_CHARS = 16_000;

export function extractFinalSummaryFromMessages(
  messages: ChatMessage[] | null | undefined,
  maxChars: number = DEFAULT_FINAL_SUMMARY_MAX_CHARS,
): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  // Find last user-facing assistant message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    const classification = classifyChatMessageVisibility(msg);
    if (classification.isUserFacing && (msg.role === 'assistant' || msg.role === 'model')) {
      const text = flattenContent(msg.content).trim();
      if (text) return text.slice(0, maxChars);
    }
  }

  // Completion summaries must describe the assistant/model result. If no
  // user-facing assistant/model message exists yet (for example, only the
  // dispatched user prompt is visible), return empty instead of echoing the
  // prompt as a misleading finalSummary.
  return '';
}

export function readChatMessageTimestampMs(message: ChatMessage | null | undefined): number | undefined {
  if (!message) return undefined;
  const record = message as ChatMessage & Record<string, unknown>;
  for (const value of [record.timestamp, record.createdAt, record.created_at, record.updatedAt, record.time, record.receivedAt]) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      // Heuristic seconds-vs-ms detection mirrors the mesh transcript reader.
      return value > 10_000_000_000 ? value : value * 1000;
    }
    if (typeof value === 'string' && value.trim()) {
      const ms = new Date(value.trim()).getTime();
      if (Number.isFinite(ms)) return ms;
    }
  }
  return undefined;
}

function readChatMessageTimestampIso(message: ChatMessage | null | undefined): string | undefined {
  const ms = readChatMessageTimestampMs(message);
  return typeof ms === 'number' ? new Date(ms).toISOString() : undefined;
}

/**
 * Turn-scoped variant of extractFinalSummaryFromMessages. Selects the last
 * user-facing assistant/model bubble whose own timestamp is at/after the
 * producing turn's start (`minTimestampMs`). This is the NOTIF Defect-B fix:
 * a completion event's finalSummary must describe the turn THAT completed, not
 * the prior task's last bubble. For native-source providers (claude-cli) the
 * external transcript holds the ENTIRE session history filtered only by session
 * start, so a completion debounce that fires before the producing turn's final
 * assistant bubble has landed would otherwise echo the previous task's tail.
 * A message whose timestamp predates the turn start is skipped; if no in-turn
 * assistant bubble exists yet, returns '' (weak/empty) — never the stale tail.
 *
 * Mirrors the reconcile path's transcriptAfterDispatch guard (mesh-events-stale):
 * a bubble only counts if its timestamp proves it was produced after the turn began.
 * When `minTimestampMs` is undefined the behaviour is identical to the unscoped
 * extractor (no turn boundary known → no filtering).
 */
export function extractFinalSummaryFromMessagesAfter(
  messages: ChatMessage[] | null | undefined,
  minTimestampMs: number | undefined,
  maxChars: number = DEFAULT_FINAL_SUMMARY_MAX_CHARS,
): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const hasBoundary = typeof minTimestampMs === 'number' && Number.isFinite(minTimestampMs);

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (hasBoundary) {
      // A bubble carrying a timestamp BEFORE the producing turn's start belongs to
      // a prior task — skip it. A bubble with no parseable timestamp cannot be
      // proven stale, so it is kept (the unscoped fallback) rather than dropped.
      const ts = readChatMessageTimestampMs(msg);
      if (typeof ts === 'number' && ts < (minTimestampMs as number)) continue;
    }
    const classification = classifyChatMessageVisibility(msg);
    if (classification.isUserFacing && (msg.role === 'assistant' || msg.role === 'model')) {
      const text = flattenContent(msg.content).trim();
      if (text) return text.slice(0, maxChars);
    }
  }
  return '';
}

/**
 * Like extractFinalSummaryFromMessages but also returns the ISO timestamp of the
 * selected final assistant/model message. Completion reconciliation needs the
 * timestamp to prove the transcript was produced AFTER the dispatch — without it
 * reconcileDirectDispatchCompletionFromTranscript rejects non-JSON summaries as
 * "transcript_not_proven_after_dispatch". The summary selection is identical so the
 * timestamp always belongs to the message whose text became the summary.
 */
export function extractFinalAssistantSummaryEvidence(
  messages: ChatMessage[] | null | undefined,
  maxChars: number = DEFAULT_FINAL_SUMMARY_MAX_CHARS,
  opts?: SelectFinalAssistantTurnEndOptions,
): { finalSummary: string; transcriptMessageAt?: string } {
  const turnEnd = selectFinalAssistantTurnEndMessage(messages, opts);
  if (!turnEnd) return { finalSummary: '' };
  return {
    finalSummary: flattenContent(turnEnd.content).trim().slice(0, maxChars),
    transcriptMessageAt: readChatMessageTimestampIso(turnEnd),
  };
}

/**
 * EARLYNOTIFY-GATEBYPASS (a)/(b) — the shared turn-finality selector for the completion
 * final-assistant judgement, so the ~duplicated "which bubble is the turn's final answer"
 * logic is decided ONE way (UNIFY A-6).
 *
 * Returns the message that qualifies as the turn's FINAL assistant bubble, or null when the
 * transcript does not (yet) prove a turn end. The rule is a NON-EMPTY LATEST user-facing
 * assistant/model bubble:
 *   - Scanning from the end, the FIRST user-facing assistant/model bubble encountered IS the
 *     turn-end candidate. If it is EMPTY (a streaming placeholder / mid-turn narration whose
 *     text has not landed), the turn is still in flight → return null. Crucially we do NOT walk
 *     back past that empty bubble to promote an EARLIER assistant narration to "final" (the
 *     Defect-B walk-back).
 *   - Trailing activity/internal bubbles (tool/thought/status) are skipped — they are not the
 *     assistant's user-facing answer.
 *   - A trailing user-facing USER message (a freshly dispatched task with no reply yet) means the
 *     assistant did not have the last word — no earlier bubble is promoted here; callers that must
 *     still reach a prior turn's tail use the timestamp-scoped extractor instead.
 *
 * A bare snapshot-idle with an arbitrary non-empty tail therefore does NOT qualify as a turn end;
 * only a genuine latest-assistant bubble does. Turn-finality signals that live OUTSIDE the
 * transcript (a committed generating→idle FSM transition, a self-attributing final_summary_json,
 * or a continuous-idle streak) are enforced by the callers (the CLI completion gate, the reconcile
 * grace gate) on top of this structural check.
 *
 * KIMI-CHROME-TAIL — the ONE narrow exception to the no-walk-back rule above: when the latest
 * user-facing assistant bubble's ENTIRE text is PTY chrome (see isTranscriptChromeOnlyText), the
 * selector skips it and accepts the immediately preceding substantive assistant bubble, bounded
 * by FINAL_SUMMARY_CHROME_FALLBACK_MAX_DEPTH. Why this does NOT reintroduce Defect-B:
 *   - Defect-B is about walking back past evidence that the producing turn has not answered yet
 *     (an EMPTY streaming bubble, or a user message holding the last word) and echoing a PRIOR
 *     task's tail. Both guards are untouched: an empty bubble still returns null immediately and
 *     any user-facing user message still ends the scan with null, so the fallback can NEVER cross
 *     a dispatched user prompt into a previous turn's history.
 *   - A chrome-only bubble is not turn content at all — it is TUI rendering debris (status bar,
 *     collapsed Todo panel) serialized into the transcript in the SAME flush as the real answer
 *     (observed: kimi session fee1dc98, where the chrome tail and the genuine 6,120-char report
 *     carry an identical timestamp). Skipping it moves WITHIN one flush, not across a turn.
 *   - The trigger is a whole-bubble pattern match, never a length/shortness heuristic, and the
 *     depth is capped, so an arbitrary non-empty tail still qualifies exactly as before.
 *
 * INSTANT-ACK STRUCTURAL GUARD (2026-08-18 false-completion fix, opts.turnStartedAtMs):
 * when the caller supplies the dispatch/turn-start boundary, a selected bubble that BOTH
 * (a) landed within FINAL_ANSWER_MIN_TURN_AGE_MS of the boundary AND (b) is still younger
 * than that window NOW is REFUSED as a turn-end candidate. The incident shape is the
 * "on it / let me look" acknowledgment — structurally a SINGLE fresh assistant bubble
 * seconds after dispatch (observed: dispatch+13s, then 39 more minutes of real work).
 * This is a purely STRUCTURAL check (timestamp deltas + position) — never a content/phrase
 * match, so no language- or provider-specific wording is filtered. Condition (b) makes the
 * guard self-healing: once the bubble has AGED past the window it re-qualifies (a genuinely
 * finished fast turn — the 84594b15 shape, answer at dispatch+4s — completes one window
 * late, never wedged); the guard can only DELAY a candidacy, never lose it.
 */
export const FINAL_ANSWER_MIN_TURN_AGE_MS = 30_000;

export interface SelectFinalAssistantTurnEndOptions {
  /** Dispatch/turn-start boundary (epoch ms) — enables the INSTANT-ACK guard above. */
  turnStartedAtMs?: number;
}

export function selectFinalAssistantTurnEndMessage(
  messages: ChatMessage[] | null | undefined,
  opts?: SelectFinalAssistantTurnEndOptions,
): ChatMessage | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  let chromeFallbacks = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    const classification = classifyChatMessageVisibility(msg);
    if (!classification.isUserFacing) continue; // skip tool/thought/status activity + internal
    if (msg.role === 'assistant' || msg.role === 'model') {
      const text = flattenContent(msg.content).trim();
      // The Defect-B guard, unchanged: an EMPTY latest bubble means the turn is still in
      // flight — never walk back past it.
      if (!text) return null;
      // KIMI-CHROME-TAIL: a wholly-chrome bubble is PTY debris, not the turn's answer. Skip it
      // (bounded); anything else is the turn end exactly as before.
      if (chromeFallbacks < FINAL_SUMMARY_CHROME_FALLBACK_MAX_DEPTH && isTranscriptChromeOnlyText(text)) {
        chromeFallbacks++;
        continue;
      }
      // INSTANT-ACK guard: a bubble that BOTH landed within seconds of the dispatch
      // boundary AND is still that young NOW is the acknowledgment, not the result.
      // Only fires when the boundary AND the bubble timestamp are both provable — an
      // undated bubble keeps the legacy behaviour (the downstream stale-summary /
      // undated-tail guards own that case).
      const boundaryMs = opts?.turnStartedAtMs;
      if (typeof boundaryMs === 'number' && Number.isFinite(boundaryMs)) {
        const msgAt = readChatMessageTimestampMs(msg);
        if (typeof msgAt === 'number' && Number.isFinite(msgAt)
          && msgAt >= boundaryMs
          && msgAt - boundaryMs < FINAL_ANSWER_MIN_TURN_AGE_MS
          && Date.now() - msgAt < FINAL_ANSWER_MIN_TURN_AGE_MS) {
          return null;
        }
      }
      return msg;
    }
    // A user (or other role) had the last user-facing word → the assistant turn is not complete.
    return null;
  }
  return null;
}

/**
 * KIMI-CHROME-TAIL — maximum number of chrome-only assistant bubbles
 * selectFinalAssistantTurnEndMessage will skip. The observed leak writes ONE chrome tail per
 * flush; two allows a duplicated capture. Uncapped skipping would be the Defect-B walk-back.
 */
export const FINAL_SUMMARY_CHROME_FALLBACK_MAX_DEPTH = 2;

/**
 * HARD PTY-chrome line signatures (terminal-UI fragments, never assistant prose). A line
 * matching one of these anchors a chrome block; matching lines are skippable anywhere in the
 * upward scan. Kept provider-agnostic: status bars, collapsed-panel hints, keybinding hints,
 * spinner frames, and box rules as observed across PTY-captured CLI transcripts.
 */
const TRANSCRIPT_CHROME_HARD_LINE_PATTERNS: readonly RegExp[] = [
  // Bottom status bar: "auto  K3 thinking: high  ~/Work/adhdev  main [±]"
  /\bauto\s+K\d+\s+thinking:\s*\S+/i,
  // Bottom status bar (older kimi-for-coding form) / context meter
  /\bkimi-for-coding(?:-highspeed)?\s+(?:thinking|idle)\b/i,
  /\bcontext:\s*\d+(?:\.\d+)?%/,
  // Collapsed-panel hints: "… +3 more (2 done) · ctrl+t to expand",
  // "(12 more lines, ctrl+o to expand)", "... (248 earlier lines)"
  /\bctrl\+t to expand\b/i,
  /\bctrl\+o to expand\b/i,
  /\(\d+\s+earlier lines\)/i,
  // Keybinding hints: "Press Ctrl+B to run in background", "↑ to edit · ctrl-s to steer immediately"
  /\bPress Ctrl\+B to run in background\b/i,
  /↑\s*to edit\b/,
  /\bctrl-s to steer\b/i,
  // Spinner frames: braille "⠦ thinking..." / moon-phase "🌕 · Tip: …"
  // (`u` flag: the moon glyphs are astral code points — a bare class only matches one
  // surrogate half and never fires)
  /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*\S/u,
  /^\s*[🌑🌒🌓🌔🌕🌖🌗🌘]\s*·\s*Tip:/u,
  // Pure box-drawing horizontal rule framing a panel
  /^\s*[─━═]{8,}\s*$/,
];

/**
 * SOFT Todo-panel lines. On their own "✓ shipped it" can be genuine list prose, so these are
 * only skippable when they sit inside a block already anchored by a HARD chrome line.
 */
const TRANSCRIPT_CHROME_PANEL_LINE_PATTERNS: readonly RegExp[] = [
  /^\s*Todo\s*$/i,
  /^\s*[○✓✗◌◯☐☑✔]\s+\S/,
];

/**
 * A captured Todo panel can drop the marker glyph of its first visible item (fee1dc98 tail:
 * the topmost captured todo line has no ○ marker). At most ONE such unmarked orphan line is
 * tolerated, and only when it sits directly above a marked panel line — never above a hard
 * chrome line, where it could be a one-line genuine answer glued to a status-bar capture.
 */
const TRANSCRIPT_CHROME_MAX_ORPHAN_LINES = 1;

/**
 * True when the ENTIRE bubble text is PTY transcript chrome (status bar / Todo panel /
 * spinner / keybinding hints), i.e. the bubble carries zero assistant prose. Scanning upward:
 * every line must be a hard chrome line, a panel line below already-seen hard chrome, or the
 * single tolerated panel orphan. A bubble with no hard chrome line at all is never chrome —
 * this is a pattern-anchored judgement, deliberately NOT a "short tail" heuristic.
 */
export function isTranscriptChromeOnlyText(text: string | null | undefined): boolean {
  const lines = (typeof text === 'string' ? text : '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  let sawHardChrome = false;
  let previousWasPanelLine = false;
  let orphanLines = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (TRANSCRIPT_CHROME_HARD_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
      sawHardChrome = true;
      previousWasPanelLine = false;
      continue;
    }
    if (sawHardChrome && TRANSCRIPT_CHROME_PANEL_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
      previousWasPanelLine = true;
      continue;
    }
    if (sawHardChrome && previousWasPanelLine && orphanLines < TRANSCRIPT_CHROME_MAX_ORPHAN_LINES) {
      orphanLines++;
      previousWasPanelLine = false;
      continue;
    }
    return false;
  }
  return sawHardChrome;
}

/**
 * EARLY-IDLE-COMPLETION-FALSE-POSITIVE — trailing tool/terminal activity detector.
 *
 * True when the transcript's LAST non-empty user-facing assistant bubble is followed
 * by one or more TOOL / TERMINAL activity bubbles (a tool_use/command the assistant
 * fired AFTER its text) — i.e. the assistant emitted a preamble ("Let me explore…"),
 * then started running Read/Grep, so the turn is still executing and its answer has
 * not landed. Callers that would otherwise promote that preamble to a turn-end summary
 * off a momentary (startup-grace / inter-tool) idle read use this as a veto.
 *
 * Deliberately NARROW so the pure-PTY completion rescue is preserved:
 *   - Only TOOL/TERMINAL activity trailing the assistant vetoes. A trailing THOUGHT or
 *     status bubble does NOT (a finished turn can end on an internal thought), matching
 *     selectFinalAssistantTurnEndMessage's skip set minus the "still-working" signals.
 *   - A genuinely FINISHED worker (final assistant last, no trailing tool activity —
 *     the kimi pure-PTY continuous-idle shape) returns false, so its early completion
 *     is untouched.
 *
 * Returns false when there is no final assistant bubble at all (the caller's
 * selectFinalAssistantTurnEndMessage already handles that as "not a turn end").
 */
export function hasTrailingToolActivityAfterFinalAssistant(
  messages: ChatMessage[] | null | undefined,
): boolean {
  return countTrailingToolActivityAfterFinalAssistant(messages) > 0;
}

/**
 * Counting sibling of hasTrailingToolActivityAfterFinalAssistant (P0-2 of the
 * terminal-admission choke point): the SAME scan, returning HOW MANY
 * tool/terminal activity bubbles trail the final assistant bubble instead of a
 * bare boolean. The terminal-admission predicate records the count in its
 * admission snapshot (P1-5 ledger diagnostics) so a later reader can see
 * exactly how much in-flight activity vetoed (or didn't) the completion.
 * Returns 0 in exactly the cases the boolean returned false — no trailing
 * activity, no final assistant bubble, an empty streaming tail, or a trailing
 * user bubble holding the last word.
 */
export function countTrailingToolActivityAfterFinalAssistant(
  messages: ChatMessage[] | null | undefined,
): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  let trailingToolActivity = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    const classification = classifyChatMessageVisibility(msg);
    // A trailing user-facing assistant/model bubble with real text ends the scan:
    // how many tools sit AFTER it is the verdict.
    if (classification.isUserFacing && (msg.role === 'assistant' || msg.role === 'model')) {
      if (flattenContent(msg.content).trim()) return trailingToolActivity;
      // Empty streaming assistant bubble — keep scanning back past it, same as
      // selectFinalAssistantTurnEndMessage (which returns null here); an empty tail
      // isn't a turn end, so there is nothing to veto.
      return 0;
    }
    if (classification.isUserFacing) {
      // A trailing user bubble (freshly dispatched task, no reply) → no assistant
      // turn end below it to veto.
      return 0;
    }
    // Non-user-facing activity/internal bubble sitting AFTER the (not-yet-seen)
    // assistant bubble. Only tool/terminal activity signals an in-flight turn.
    if (classification.kind === 'tool' || classification.kind === 'terminal') {
      trailingToolActivity += 1;
    }
  }
  return 0;
}

export const BUILTIN_CHAT_MESSAGE_KINDS = ['standard', 'thought', 'tool', 'terminal', 'system'] as const;

export type BuiltinChatMessageKind = typeof BUILTIN_CHAT_MESSAGE_KINDS[number];
export type ChatMessageKind = BuiltinChatMessageKind | (string & {});

export const CHAT_MESSAGE_VISIBILITIES = ['user', 'debug', 'internal', 'hidden'] as const;
export const CHAT_MESSAGE_TRANSCRIPT_VISIBILITIES = ['visible', 'chat', 'user', 'debug', 'internal', 'hidden'] as const;
export const CHAT_MESSAGE_AUDIENCES = ['chat', 'debug', 'trace', 'internal'] as const;
export const CHAT_MESSAGE_SOURCES = [
  'assistant_text',
  'tool_call',
  'terminal_command',
  'runtime_activity',
  'runtime_status',
  'provider_chrome',
  'control',
] as const;
export const CHAT_MESSAGE_ACTIVITY_SOURCES = ['tool_call', 'terminal_command', 'runtime_activity'] as const;
export const CHAT_MESSAGE_INTERNAL_SOURCES = ['runtime_status', 'provider_chrome', 'control'] as const;

export type ChatMessageVisibility = typeof CHAT_MESSAGE_VISIBILITIES[number] | (string & {});
export type ChatMessageTranscriptVisibility = typeof CHAT_MESSAGE_TRANSCRIPT_VISIBILITIES[number] | (string & {});
export type ChatMessageAudience = typeof CHAT_MESSAGE_AUDIENCES[number] | (string & {});
export type ChatMessageSource = typeof CHAT_MESSAGE_SOURCES[number] | (string & {});
export type ChatMessageTranscriptSurface = 'chat' | 'activity' | 'internal';

export interface ChatMessageVisibilityClassification {
  surface: ChatMessageTranscriptSurface;
  isUserFacing: boolean;
  isActivityFacing: boolean;
  isInternal: boolean;
  explicitUserFacing: boolean;
  explicitHidden: boolean;
  role: string;
  kind: ChatMessageKind;
  visibility: string;
  transcriptVisibility: string;
  audience: string;
  source: string;
}


const KNOWN_CHAT_MESSAGE_KINDS = new Set<string>(BUILTIN_CHAT_MESSAGE_KINDS);
const CHAT_MESSAGE_KIND_ALIASES: Record<string, BuiltinChatMessageKind> = {
  text: 'standard',
  message: 'standard',
  assistant: 'standard',
  thinking: 'thought',
  think: 'thought',
  reasoning: 'thought',
  reason: 'thought',
  toolcall: 'tool',
  tool_call: 'tool',
  tooluse: 'tool',
  tool_use: 'tool',
  action: 'tool',
  command: 'terminal',
  cmd: 'terminal',
  shell: 'terminal',
  console: 'terminal',
};

function canonicalizeKindHint(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function resolveBuiltinOrAliasKind(kind: unknown): BuiltinChatMessageKind | null {
  if (typeof kind !== 'string') return null;
  const normalizedKind = canonicalizeKindHint(kind);
  if (!normalizedKind) return null;
  if (KNOWN_CHAT_MESSAGE_KINDS.has(normalizedKind)) return normalizedKind as BuiltinChatMessageKind;
  return CHAT_MESSAGE_KIND_ALIASES[normalizedKind] || null;
}

function inferHintKind(value: unknown): BuiltinChatMessageKind | null {
  const direct = resolveBuiltinOrAliasKind(value);
  if (direct) return direct;
  if (typeof value !== 'string') return null;
  const normalized = canonicalizeKindHint(value);
  if (!normalized) return null;
  if (/thought|thinking|reasoning/.test(normalized)) return 'thought';
  if (/tool/.test(normalized)) return 'tool';
  if (/terminal|command|shell|console/.test(normalized)) return 'terminal';
  return null;
}

function inferKindFromToolCalls(message: ChatMessage): BuiltinChatMessageKind | null {
  const toolCalls = Array.isArray(message?.toolCalls) ? message.toolCalls : [];
  if (toolCalls.length === 0) return null;
  if (toolCalls.some((toolCall) => toolCall?.kind === 'think')) return 'thought';
  if (toolCalls.some((toolCall) => toolCall?.kind === 'execute')) return 'terminal';
  if (toolCalls.some((toolCall) => Array.isArray(toolCall?.content) && toolCall.content.some((entry) => entry?.type === 'terminal'))) {
    return 'terminal';
  }
  return 'tool';
}

function inferMissingChatMessageKind(message: ChatMessage): BuiltinChatMessageKind | null {
  const role = typeof message?.role === 'string' ? message.role.trim().toLowerCase() : '';
  if (role === 'system') return 'system';

  const meta = message?.meta && typeof message.meta === 'object' ? message.meta as Record<string, unknown> : undefined;
  const hintCandidates: unknown[] = [
    message?._sub,
    message?._type,
    meta?.label,
    typeof message?.senderName === 'string' ? message.senderName : undefined,
  ];

  for (const candidate of hintCandidates) {
    const inferred = inferHintKind(candidate);
    if (inferred) return inferred;
  }

  const inferredFromToolCalls = inferKindFromToolCalls(message);
  if (inferredFromToolCalls) return inferredFromToolCalls;
  return null;
}

export function isBuiltinChatMessageKind(kind: unknown): kind is BuiltinChatMessageKind {
  return resolveBuiltinOrAliasKind(kind) !== null;
}

export function normalizeChatMessageKind(kind: unknown, role: unknown): ChatMessageKind {
  const resolvedKind = resolveBuiltinOrAliasKind(kind);
  if (resolvedKind) return resolvedKind;

  const normalizedRole = typeof role === 'string' ? role.trim().toLowerCase() : '';
  return normalizedRole === 'system' ? 'system' : 'standard';
}

export function resolveChatMessageKind<T extends ChatMessage>(message: T): ChatMessageKind {
  const explicitKind = resolveBuiltinOrAliasKind(message?.kind);
  if (explicitKind) return explicitKind;

  const inferredKind = inferMissingChatMessageKind(message);
  if (inferredKind) return inferredKind;
  return normalizeChatMessageKind(message?.kind, message?.role);
}

export function buildChatMessage<T extends Omit<ChatMessage, 'kind'> & { kind?: ChatMessageKind }>(message: T): T & { kind: ChatMessageKind } {
  return {
    ...message,
    kind: resolveChatMessageKind(message as unknown as ChatMessage),
  };
}

export function buildSystemChatMessage<T extends Omit<ChatMessage, 'role' | 'kind'> & { role?: 'system'; kind?: ChatMessageKind }>(message: T): (T & { role: 'system'; kind: ChatMessageKind }) {
  return buildChatMessage({
    ...message,
    role: 'system',
    kind: message?.kind || 'system',
  } as T & { role: 'system'; kind?: ChatMessageKind }) as T & { role: 'system'; kind: ChatMessageKind };
}

export function buildRuntimeSystemChatMessage<T extends Omit<ChatMessage, 'role' | 'kind' | 'senderName'> & { role?: 'system'; kind?: ChatMessageKind; senderName?: string }>(message: T): (T & { role: 'system'; kind: ChatMessageKind; senderName: string }) {
  return buildSystemChatMessage({
    ...message,
    senderName: typeof message?.senderName === 'string' && message.senderName.trim()
      ? message.senderName
      : 'System',
  } as T & { role?: 'system'; kind?: ChatMessageKind; senderName?: string }) as T & { role: 'system'; kind: ChatMessageKind; senderName: string };
}

export function buildAssistantChatMessage<T extends Omit<ChatMessage, 'role' | 'kind'> & { role?: 'assistant'; kind?: ChatMessageKind }>(message: T): (T & { role: 'assistant'; kind: ChatMessageKind }) {
  return buildChatMessage({
    ...message,
    role: 'assistant',
    kind: message?.kind || 'standard',
  } as T & { role: 'assistant'; kind?: ChatMessageKind }) as T & { role: 'assistant'; kind: ChatMessageKind };
}

export function buildThoughtChatMessage<T extends Omit<ChatMessage, 'role' | 'kind'> & { role?: 'assistant'; kind?: ChatMessageKind }>(message: T): (T & { role: 'assistant'; kind: ChatMessageKind }) {
  return buildAssistantChatMessage({
    ...message,
    kind: message?.kind || 'thought',
  } as T & { role?: 'assistant'; kind?: ChatMessageKind }) as T & { role: 'assistant'; kind: ChatMessageKind };
}

export function buildToolChatMessage<T extends Omit<ChatMessage, 'role' | 'kind'> & { role?: 'assistant'; kind?: ChatMessageKind }>(message: T): (T & { role: 'assistant'; kind: ChatMessageKind }) {
  return buildAssistantChatMessage({
    ...message,
    kind: message?.kind || 'tool',
  } as T & { role?: 'assistant'; kind?: ChatMessageKind }) as T & { role: 'assistant'; kind: ChatMessageKind };
}

export function buildTerminalChatMessage<T extends Omit<ChatMessage, 'role' | 'kind'> & { role?: 'assistant'; kind?: ChatMessageKind }>(message: T): (T & { role: 'assistant'; kind: ChatMessageKind }) {
  return buildAssistantChatMessage({
    ...message,
    kind: message?.kind || 'terminal',
  } as T & { role?: 'assistant'; kind?: ChatMessageKind }) as T & { role: 'assistant'; kind: ChatMessageKind };
}

export function buildUserChatMessage<T extends Omit<ChatMessage, 'role' | 'kind'> & { role?: 'user'; kind?: ChatMessageKind }>(message: T): (T & { role: 'user'; kind: ChatMessageKind }) {
  return buildChatMessage({
    ...message,
    role: 'user',
    kind: message?.kind || 'standard',
  } as T & { role: 'user'; kind?: ChatMessageKind }) as T & { role: 'user'; kind: ChatMessageKind };
}

export function normalizeChatMessage<T extends ChatMessage>(message: T): T {
  return buildChatMessage(message) as T;
}

export function normalizeChatMessages<T extends ChatMessage>(messages: T[] | null | undefined): T[] {
  return (Array.isArray(messages) ? messages : []).map((message) => normalizeChatMessage(message));
}

function readMessageMeta(message: ChatMessage): Record<string, unknown> | null {
  const meta = message?.meta;
  return meta && typeof meta === 'object' && !Array.isArray(meta)
    ? meta as Record<string, unknown>
    : null;
}

function readStringField(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function readRecordField(message: ChatMessage, meta: Record<string, unknown> | null, key: string): unknown {
  const record = message as ChatMessage & Record<string, unknown>;
  return record[key] ?? meta?.[key];
}

function readVisibilityField(message: ChatMessage, meta: Record<string, unknown> | null): string {
  return readStringField(readRecordField(message, meta, 'visibility'));
}

function readTranscriptVisibilityField(message: ChatMessage, meta: Record<string, unknown> | null): string {
  const record = message as ChatMessage & Record<string, unknown>;
  return readStringField(record.transcriptVisibility ?? meta?.transcriptVisibility ?? record.visibility ?? meta?.visibility);
}

const EXPLICIT_HIDDEN_VISIBILITIES = new Set(['hidden', 'debug', 'internal']);
const EXPLICIT_VISIBLE_VISIBILITIES = new Set(['visible', 'user', 'chat']);
const HIDDEN_AUDIENCES = new Set(['debug', 'trace', 'internal']);
const ACTIVITY_SOURCE_SET = new Set<string>(CHAT_MESSAGE_ACTIVITY_SOURCES);
const INTERNAL_SOURCE_SET = new Set<string>(CHAT_MESSAGE_INTERNAL_SOURCES);

function hasBooleanMarker(message: ChatMessage, meta: Record<string, unknown> | null, keys: string[]): boolean {
  const record = message as ChatMessage & Record<string, unknown>;
  return keys.some((key) => record[key] === true || meta?.[key] === true);
}

function isActivityKind(kind: ChatMessageKind): boolean {
  return kind === 'thought' || kind === 'tool' || kind === 'terminal';
}

function isOrdinaryVisibleTurn(message: ChatMessage, role: string, kind: ChatMessageKind): boolean {
  if (role === 'user' || role === 'human') return kind === 'standard' || kind === '';
  if (role === 'assistant') return kind === 'standard' || kind === '';
  return false;
}

/**
 * Shared transcript visibility protocol for all ADHDev provider chat messages.
 *
 * Producers can stamp visibility/audience/source/userFacing/internal/debug either
 * at the top level or under `meta`. Consumers should use this classifier instead
 * of matching command text, icons, provider names, or terminal UI fragments.
 */
export function classifyChatMessageVisibility(message: ChatMessage | null | undefined): ChatMessageVisibilityClassification {
  if (!message) {
    return {
      surface: 'internal',
      isUserFacing: false,
      isActivityFacing: false,
      isInternal: true,
      explicitUserFacing: false,
      explicitHidden: true,
      role: '',
      kind: 'standard',
      visibility: '',
      transcriptVisibility: '',
      audience: '',
      source: '',
    };
  }

  const meta = readMessageMeta(message);
  const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
  const kind = resolveChatMessageKind(message);
  const visibility = readVisibilityField(message, meta);
  const transcriptVisibility = readTranscriptVisibilityField(message, meta);
  const audience = readStringField(readRecordField(message, meta, 'audience'));
  const source = readStringField(readRecordField(message, meta, 'source'));
  const explicitHidden = EXPLICIT_HIDDEN_VISIBILITIES.has(visibility)
    || EXPLICIT_HIDDEN_VISIBILITIES.has(transcriptVisibility)
    || HIDDEN_AUDIENCES.has(audience)
    || hasBooleanMarker(message, meta, ['hidden', 'internal', 'isInternal', 'debug', 'statusOnly', 'controlOnly']);
  const explicitUserFacing = EXPLICIT_VISIBLE_VISIBILITIES.has(visibility)
    || EXPLICIT_VISIBLE_VISIBILITIES.has(transcriptVisibility)
    || audience === 'chat'
    || hasBooleanMarker(message, meta, ['userFacing']);

  if (explicitHidden) {
    const activityLike = isActivityKind(kind) || ACTIVITY_SOURCE_SET.has(source);
    return {
      surface: activityLike ? 'activity' : 'internal',
      isUserFacing: false,
      isActivityFacing: activityLike,
      isInternal: !activityLike,
      explicitUserFacing,
      explicitHidden,
      role,
      kind,
      visibility,
      transcriptVisibility,
      audience,
      source,
    };
  }

  if (explicitUserFacing) {
    return {
      surface: 'chat',
      isUserFacing: true,
      isActivityFacing: false,
      isInternal: false,
      explicitUserFacing,
      explicitHidden,
      role,
      kind,
      visibility,
      transcriptVisibility,
      audience,
      source,
    };
  }

  if (INTERNAL_SOURCE_SET.has(source) || role === 'system' || kind === 'system') {
    return {
      surface: 'internal',
      isUserFacing: false,
      isActivityFacing: false,
      isInternal: true,
      explicitUserFacing,
      explicitHidden,
      role,
      kind,
      visibility,
      transcriptVisibility,
      audience,
      source,
    };
  }

  if (ACTIVITY_SOURCE_SET.has(source) || isActivityKind(kind)) {
    return {
      surface: 'activity',
      isUserFacing: false,
      isActivityFacing: true,
      isInternal: false,
      explicitUserFacing,
      explicitHidden,
      role,
      kind,
      visibility,
      transcriptVisibility,
      audience,
      source,
    };
  }

  const isUserFacing = isOrdinaryVisibleTurn(message, role, kind);
  return {
    surface: isUserFacing ? 'chat' : 'internal',
    isUserFacing,
    isActivityFacing: false,
    isInternal: !isUserFacing,
    explicitUserFacing,
    explicitHidden,
    role,
    kind,
    visibility,
    transcriptVisibility,
    audience,
    source,
  };
}

export function isUserFacingChatMessage(message: ChatMessage | null | undefined): boolean {
  return classifyChatMessageVisibility(message).isUserFacing;
}

export function isActivityChatMessage(message: ChatMessage | null | undefined): boolean {
  return classifyChatMessageVisibility(message).isActivityFacing;
}

export function isInternalChatMessage(message: ChatMessage | null | undefined): boolean {
  return classifyChatMessageVisibility(message).isInternal;
}

export function filterUserFacingChatMessages<T extends ChatMessage>(messages: T[] | null | undefined): T[] {
  return (Array.isArray(messages) ? messages : []).filter((message) => isUserFacingChatMessage(message));
}

export function filterActivityChatMessages<T extends ChatMessage>(messages: T[] | null | undefined): T[] {
  return (Array.isArray(messages) ? messages : []).filter((message) => isActivityChatMessage(message));
}

export function filterInternalChatMessages<T extends ChatMessage>(messages: T[] | null | undefined): T[] {
  return (Array.isArray(messages) ? messages : []).filter((message) => isInternalChatMessage(message));
}

export function filterChatMessagesByVisibility<T extends ChatMessage>(
  messages: T[] | null | undefined,
  surface: ChatMessageTranscriptSurface,
): T[] {
  return (Array.isArray(messages) ? messages : []).filter((message) => classifyChatMessageVisibility(message).surface === surface);
}
