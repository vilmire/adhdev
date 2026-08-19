import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CHAT_MESSAGE_KINDS,
  buildAssistantChatMessage,
  buildChatMessage,
  buildRuntimeSystemChatMessage,
  buildSystemChatMessage,
  buildTerminalChatMessage,
  buildThoughtChatMessage,
  buildToolChatMessage,
  buildUserChatMessage,
  DEFAULT_FINAL_SUMMARY_MAX_CHARS,
  extractFinalAssistantSummaryEvidence,
  extractFinalSummaryFromMessages,
  FINAL_SUMMARY_CHROME_FALLBACK_MAX_DEPTH,
  filterUserFacingChatMessages,
  isBuiltinChatMessageKind,
  isTranscriptChromeOnlyText,
  isUserFacingChatMessage,
  normalizeChatMessage,
  normalizeChatMessageKind,
  normalizeChatMessages,
  selectFinalAssistantTurnEndMessage,
  hasTrailingToolActivityAfterFinalAssistant,
} from '../../src/providers/chat-message-normalization';

describe('chat message normalization', () => {
  it('exports the built-in kind list and builtin-kind guard', () => {
    expect(BUILTIN_CHAT_MESSAGE_KINDS).toEqual(['standard', 'thought', 'tool', 'terminal', 'system']);
    expect(isBuiltinChatMessageKind('tool')).toBe(true);
    expect(isBuiltinChatMessageKind('custom_kind')).toBe(false);
  });

  it('defaults non-system messages to standard kind', () => {
    expect(normalizeChatMessage({ role: 'assistant', content: 'hello' } as any).kind).toBe('standard');
    expect(normalizeChatMessage({ role: 'user', content: 'hello' } as any).kind).toBe('standard');
  });

  it('defaults system-role messages to system kind', () => {
    expect(normalizeChatMessage({ role: 'system', content: 'notice' } as any).kind).toBe('system');
  });

  it('preserves known explicit kinds and normalizes casing', () => {
    expect(normalizeChatMessageKind('tool', 'assistant')).toBe('tool');
    expect(normalizeChatMessageKind('TERMINAL', 'assistant')).toBe('terminal');
    expect(normalizeChatMessageKind('text', 'assistant')).toBe('standard');
    expect(normalizeChatMessageKind('command', 'assistant')).toBe('terminal');
    expect(normalizeChatMessage({ role: 'assistant', content: 'thinking', kind: 'thought' } as any).kind).toBe('thought');
  });

  it('infers richer kinds from readChat producer hints when explicit kind is missing', () => {
    expect(normalizeChatMessage({ role: 'assistant', content: 'npm test', _sub: 'command' } as any).kind).toBe('terminal');
    expect(normalizeChatMessage({ role: 'assistant', content: 'Search files', _sub: 'tool' } as any).kind).toBe('tool');
    expect(normalizeChatMessage({ role: 'assistant', content: 'planning', meta: { label: 'Thinking' } } as any).kind).toBe('thought');
    expect(normalizeChatMessage({
      role: 'assistant',
      content: 'Ran tool',
      toolCalls: [{ toolCallId: 'tc-1', title: 'Run npm test', kind: 'execute' }],
    } as any).kind).toBe('terminal');
  });

  it('falls back from unknown kinds based on role', () => {
    expect(normalizeChatMessage({ role: 'assistant', content: 'hello', kind: 'weird' } as any).kind).toBe('standard');
    expect(normalizeChatMessage({ role: 'system', content: 'notice', kind: 'weird' } as any).kind).toBe('system');
  });

  it('provides builders for common runtime message roles', () => {
    const built = buildChatMessage({ role: 'assistant', content: 'hello' } as any);
    expect(built.kind).toBe('standard');

    const systemMessage = buildSystemChatMessage({ content: 'notice' } as any);
    expect(systemMessage.role).toBe('system');
    expect(systemMessage.kind).toBe('system');

    const runtimeSystemMessage = buildRuntimeSystemChatMessage({ content: 'notice', receivedAt: 123 } as any);
    expect(runtimeSystemMessage.role).toBe('system');
    expect(runtimeSystemMessage.kind).toBe('system');
    expect(runtimeSystemMessage.senderName).toBe('System');
    expect(runtimeSystemMessage.receivedAt).toBe(123);

    const assistantMessage = buildAssistantChatMessage({ content: 'reply' } as any);
    expect(assistantMessage.role).toBe('assistant');
    expect(assistantMessage.kind).toBe('standard');

    const thoughtMessage = buildThoughtChatMessage({ content: 'analyzing…' } as any);
    expect(thoughtMessage.role).toBe('assistant');
    expect(thoughtMessage.kind).toBe('thought');

    const toolMessage = buildToolChatMessage({ content: 'Searching files' } as any);
    expect(toolMessage.role).toBe('assistant');
    expect(toolMessage.kind).toBe('tool');

    const terminalMessage = buildTerminalChatMessage({ content: 'npm test\nPASS', meta: { label: 'Ran command' } } as any);
    expect(terminalMessage.role).toBe('assistant');
    expect(terminalMessage.kind).toBe('terminal');
    expect(terminalMessage.meta).toMatchObject({ label: 'Ran command' });

    const userMessage = buildUserChatMessage({ content: 'prompt' } as any);
    expect(userMessage.role).toBe('user');
    expect(userMessage.kind).toBe('standard');
  });

  it('normalizes message arrays consistently', () => {
    const normalized = normalizeChatMessages([
      { role: 'assistant', content: 'reply' },
      { role: 'system', content: 'notice' },
      { role: 'assistant', content: 'command', kind: 'tool' },
    ] as any);

    expect(normalized.map((message) => message.kind)).toEqual(['standard', 'system', 'tool']);
  });

  it('filters user-facing transcript messages without discarding debug rows from normalization', () => {
    const messages = normalizeChatMessages([
      { role: 'user', content: 'prompt' },
      { role: 'assistant', content: 'answer' },
      { role: 'assistant', content: '⚡ mcp_adhdev_mesh_mesh_git_status (0.0s)', kind: 'tool' },
      { role: 'assistant', content: '$ git status --short', kind: 'terminal' },
      { role: 'assistant', content: 'intentional tool summary', kind: 'tool', meta: { transcriptVisibility: 'visible' } },
      { role: 'assistant', content: 'internal standard status', meta: { internal: true } },
      { role: 'system', content: 'runtime notice' },
    ] as any);

    expect(messages.map((message) => message.kind)).toEqual([
      'standard',
      'standard',
      'tool',
      'terminal',
      'tool',
      'standard',
      'system',
    ]);
    expect(messages.map((message) => isUserFacingChatMessage(message))).toEqual([
      true,
      true,
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(filterUserFacingChatMessages(messages).map((message) => message.content)).toEqual([
      'prompt',
      'answer',
      'intentional tool summary',
    ]);
  });

  it('extractFinalSummaryFromMessages returns empty string for null/undefined/empty', () => {
    expect(extractFinalSummaryFromMessages(null)).toBe('');
    expect(extractFinalSummaryFromMessages(undefined)).toBe('');
    expect(extractFinalSummaryFromMessages([])).toBe('');
  });

  it('extractFinalSummaryFromMessages extracts last user-facing assistant message', () => {
    const messages = [
      { role: 'user', content: 'prompt' },
      { role: 'assistant', content: 'first answer' },
      { role: 'assistant', content: 'final answer', meta: { userFacing: true } },
    ] as any;
    expect(extractFinalSummaryFromMessages(messages)).toBe('final answer');
  });

  it('extractFinalSummaryFromMessages returns empty instead of echoing a user prompt when no assistant result exists', () => {
    const messages = [
      { role: 'user', content: 'prompt' },
      { role: 'assistant', content: 'answer', meta: { hidden: true } },
      { role: 'user', content: 'follow-up', meta: { userFacing: true } },
    ] as any;
    expect(extractFinalSummaryFromMessages(messages)).toBe('');
  });

  it('extractFinalSummaryFromMessages keeps ordinary completion summaries under the default cap', () => {
    const text = 'a'.repeat(8_000);
    const messages = [
      { role: 'assistant', content: text, meta: { userFacing: true } },
    ] as any;
    expect(DEFAULT_FINAL_SUMMARY_MAX_CHARS).toBe(16_000);
    expect(extractFinalSummaryFromMessages(messages)).toBe(text);
  });

  it('extractFinalSummaryFromMessages truncates oversized summaries at the default cap', () => {
    const text = 'a'.repeat(20_000);
    const messages = [
      { role: 'assistant', content: text, meta: { userFacing: true } },
    ] as any;
    const summary = extractFinalSummaryFromMessages(messages);
    expect(summary).toHaveLength(16_000);
    expect(summary).toBe('a'.repeat(16_000));
  });

  it('extractFinalSummaryFromMessages truncates to maxChars when an explicit limit is provided', () => {
    const messages = [
      { role: 'assistant', content: 'a'.repeat(1000), meta: { userFacing: true } },
    ] as any;
    expect(extractFinalSummaryFromMessages(messages, 100)).toBe('a'.repeat(100));
  });

  it('extractFinalSummaryFromMessages prefers assistant over user', () => {
    const messages = [
      { role: 'user', content: 'user message', meta: { userFacing: true } },
      { role: 'assistant', content: 'assistant message', meta: { userFacing: true } },
    ] as any;
    expect(extractFinalSummaryFromMessages(messages)).toBe('assistant message');
  });
});

// EARLYNOTIFY-GATEBYPASS (a)/(b): the completion final-assistant evidence must require a genuine
// turn end — a NON-EMPTY LATEST user-facing assistant bubble. An empty (streaming / mid-turn)
// latest assistant bubble must NOT walk back to promote an earlier narration to "final".
describe('extractFinalAssistantSummaryEvidence — turn-finality (Defect-B)', () => {
  it('returns the latest non-empty assistant bubble as the turn end', () => {
    const messages = [
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'the final answer' },
    ] as any;
    expect(extractFinalAssistantSummaryEvidence(messages).finalSummary).toBe('the final answer');
  });

  it('returns empty when the LATEST assistant bubble is empty (streaming) — no walk-back to an earlier one', () => {
    const messages = [
      { role: 'user', content: 'task A' },
      { role: 'assistant', content: 'earlier mid-turn narration' },
      { role: 'user', content: 'task B' },
      // The B turn is streaming: its assistant bubble exists but has no text yet.
      { role: 'assistant', content: '' },
    ] as any;
    // Must NOT promote 'earlier mid-turn narration' — the turn has not ended.
    expect(extractFinalAssistantSummaryEvidence(messages).finalSummary).toBe('');
    expect(selectFinalAssistantTurnEndMessage(messages)).toBeNull();
  });

  it('returns empty when the last user-facing word is a user message (dispatched task, no reply yet)', () => {
    const messages = [
      { role: 'assistant', content: 'prior task answer' },
      { role: 'user', content: 'new task with no assistant reply yet' },
    ] as any;
    expect(extractFinalAssistantSummaryEvidence(messages).finalSummary).toBe('');
    expect(selectFinalAssistantTurnEndMessage(messages)).toBeNull();
  });

  it('skips trailing activity (tool/thought) bubbles and still finds the assistant turn end', () => {
    const messages = [
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'the final answer' },
      { role: 'assistant', content: 'ran a tool', kind: 'tool' },
    ] as any;
    expect(extractFinalAssistantSummaryEvidence(messages).finalSummary).toBe('the final answer');
  });
});

describe('hasTrailingToolActivityAfterFinalAssistant — EARLY-IDLE-COMPLETION-FALSE-POSITIVE guard', () => {
  it('true when a tool_use bubble trails the final assistant (preamble-then-tool, turn still executing)', () => {
    const messages = [
      { role: 'user', content: 'investigate' },
      { role: 'assistant', content: 'Let me explore…' },
      { role: 'assistant', content: 'Read src/foo.ts', kind: 'tool' },
    ] as any;
    expect(hasTrailingToolActivityAfterFinalAssistant(messages)).toBe(true);
  });

  it('true when a trailing terminal command follows the final assistant', () => {
    const messages = [
      { role: 'user', content: 'run tests' },
      { role: 'assistant', content: 'Running the suite…' },
      { role: 'assistant', content: 'npm test', kind: 'terminal' },
    ] as any;
    expect(hasTrailingToolActivityAfterFinalAssistant(messages)).toBe(true);
  });

  it('false for a genuinely finished turn (final assistant last, no trailing tool) — kimi pure-PTY rescue preserved', () => {
    const messages = [
      { role: 'user', content: 'do work' },
      { role: 'assistant', content: 'Done — implemented and committed.' },
    ] as any;
    expect(hasTrailingToolActivityAfterFinalAssistant(messages)).toBe(false);
  });

  it('false when the trailing bubble is a thought (a turn may end on an internal thought)', () => {
    const messages = [
      { role: 'user', content: 'do work' },
      { role: 'assistant', content: 'All set.' },
      { role: 'assistant', content: 'reflecting', kind: 'thought' },
    ] as any;
    expect(hasTrailingToolActivityAfterFinalAssistant(messages)).toBe(false);
  });

  it('false when tools precede the final assistant answer (normal completed turn)', () => {
    const messages = [
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: 'Editing…', kind: 'tool' },
      { role: 'assistant', content: 'Fixed and verified.' },
    ] as any;
    expect(hasTrailingToolActivityAfterFinalAssistant(messages)).toBe(false);
  });

  it('false when there is no final assistant bubble (streaming / user had last word)', () => {
    expect(hasTrailingToolActivityAfterFinalAssistant([
      { role: 'assistant', content: 'prior answer' },
      { role: 'user', content: 'new task, no reply yet' },
    ] as any)).toBe(false);
    expect(hasTrailingToolActivityAfterFinalAssistant([] as any)).toBe(false);
  });
});

// KIMI-CHROME-TAIL: a trailing assistant bubble whose ENTIRE text is PTY chrome (status bar,
// Todo panel, spinner frames, keybinding hints) is TUI debris captured in the same flush as the
// real answer — not the turn's content. The selector skips it (bounded depth) and takes the
// immediately preceding substantive bubble. This is the narrow, pattern-anchored exception to
// the Defect-B no-walk-back rule; the empty-bubble and user-last-word guards are untouched.
describe('selectFinalAssistantTurnEndMessage — chrome-only tail fallback (KIMI-CHROME-TAIL)', () => {
  // Real capture from kimi session fee1dc98 (last stored bubble, 128 chars, pure chrome).
  const KIMI_CHROME_TAIL = [
    '루트 version-bump 1.0.36 (재실행, 검증 진행 중)',
    '○ 루트 push + Cloudflare prod 배포 확인',
    '○ 최종 보고',
    'auto  K3 thinking: high  ~/Work/adhdev  main [±]',
  ].join('\n');

  it('isTranscriptChromeOnlyText matches observed chrome shapes, and only those', () => {
    expect(isTranscriptChromeOnlyText(KIMI_CHROME_TAIL)).toBe(true);
    // Collapsed todo hint + status bar
    expect(isTranscriptChromeOnlyText('… +5 more (3 done) · ctrl+t to expand\nauto  K3 thinking: high  ~/repo  main')).toBe(true);
    // Status bar alone
    expect(isTranscriptChromeOnlyText('auto  K3 thinking: high  [1 task running]  ~/Work/adhdev  main [+1 -1]')).toBe(true);
    // Box rule + Todo panel + status bar
    expect(isTranscriptChromeOnlyText('────────────────────────────────────────\nTodo\n✓ task one\n✓ task two\nauto  K3 thinking: high  ~/repo  main')).toBe(true);
    // Spinner + tip
    expect(isTranscriptChromeOnlyText('🌕 · Tip: /web: use the Web UI for a better experience')).toBe(true);
    // NOT chrome: genuine prose, even when short
    expect(isTranscriptChromeOnlyText('Done — implemented and committed.')).toBe(false);
    // NOT chrome: checkmark list without any hard chrome anchor
    expect(isTranscriptChromeOnlyText('✓ first done\n✓ second done')).toBe(false);
    // NOT chrome: a one-line genuine answer glued above a status bar (orphan must sit above a
    // PANEL line; above a HARD line it is treated as real content)
    expect(isTranscriptChromeOnlyText('배포 완료했습니다.\nauto  K3 thinking: high  ~/repo  main')).toBe(false);
    // NOT chrome: substantive report with a chrome tail (whole-bubble rule)
    expect(isTranscriptChromeOnlyText('Final report: all checks passed.\n──────\nTodo\n✓ done\nauto  K3 thinking: high  ~/repo  main')).toBe(false);
    expect(isTranscriptChromeOnlyText('')).toBe(false);
    expect(isTranscriptChromeOnlyText(null)).toBe(false);
  });

  it('falls back to the previous substantive bubble when the latest assistant bubble is chrome-only', () => {
    const messages = [
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'the real final report' },
      { role: 'assistant', content: KIMI_CHROME_TAIL },
    ] as any;
    expect(selectFinalAssistantTurnEndMessage(messages)?.content).toBe('the real final report');
    expect(extractFinalAssistantSummaryEvidence(messages).finalSummary).toBe('the real final report');
  });

  it('does NOT fall back when the latest assistant bubble is substantive', () => {
    const messages = [
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'auto  K3 thinking: high  ~/repo  main' },
      { role: 'assistant', content: 'the real final report' },
    ] as any;
    expect(selectFinalAssistantTurnEndMessage(messages)?.content).toBe('the real final report');
  });

  it('skips two consecutive chrome bubbles (within the depth cap)', () => {
    const messages = [
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'the real final report' },
      { role: 'assistant', content: KIMI_CHROME_TAIL },
      { role: 'assistant', content: 'auto  K3 thinking: high  ~/repo  main' },
    ] as any;
    expect(FINAL_SUMMARY_CHROME_FALLBACK_MAX_DEPTH).toBe(2);
    expect(selectFinalAssistantTurnEndMessage(messages)?.content).toBe('the real final report');
  });

  it('accepts the chrome bubble as-is beyond the depth cap (no unbounded walk-back)', () => {
    const messages = [
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'the real final report' },
      { role: 'assistant', content: 'auto  K3 thinking: high  ~/repo  main' },
      { role: 'assistant', content: 'auto  K3 thinking: high  ~/repo  main' },
      { role: 'assistant', content: KIMI_CHROME_TAIL },
    ] as any;
    expect(selectFinalAssistantTurnEndMessage(messages)?.content).toBe('auto  K3 thinking: high  ~/repo  main');
  });

  it('Defect-B guards intact: chrome fallback never crosses a user message or an empty bubble', () => {
    // User dispatch after the chrome tail → the assistant did not have the last word.
    expect(selectFinalAssistantTurnEndMessage([
      { role: 'assistant', content: 'prior task answer' },
      { role: 'assistant', content: KIMI_CHROME_TAIL },
      { role: 'user', content: 'new task, no reply yet' },
    ] as any)).toBeNull();
    // Chrome tail, then the turn's (still empty) streaming bubble → in flight, no promotion.
    expect(selectFinalAssistantTurnEndMessage([
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'mid-turn narration' },
      { role: 'assistant', content: KIMI_CHROME_TAIL },
      { role: 'assistant', content: '' },
    ] as any)).toBeNull();
    // Chrome tail with NO substantive bubble before it in this turn → null, never the prior turn.
    expect(selectFinalAssistantTurnEndMessage([
      { role: 'assistant', content: 'prior task answer' },
      { role: 'user', content: 'new task' },
      { role: 'assistant', content: KIMI_CHROME_TAIL },
    ] as any)).toBeNull();
  });
});

describe('selectFinalAssistantTurnEndMessage — INSTANT-ACK structural guard (turnStartedAtMs)', () => {
  it('refuses a bubble that landed seconds after dispatch and is still that fresh (the "on it" acknowledgment shape)', () => {
    // The a3dc0a3e incident wire: a single assistant bubble at dispatch+13s, observed
    // immediately — then the worker kept going for 39 minutes. No content inspection —
    // pure timestamp deltas.
    const dispatchAt = Date.now() - 13_500;
    const messages = [
      { role: 'user', content: 'implement the fix', timestamp: dispatchAt + 500 },
      { role: 'assistant', content: '핸들러 위치부터 찾겠습니다.', timestamp: dispatchAt + 13_000 },
    ] as any;
    expect(selectFinalAssistantTurnEndMessage(messages, { turnStartedAtMs: dispatchAt })).toBeNull();
    // The evidence extractor rides the same guard → no finalSummary either.
    expect(extractFinalAssistantSummaryEvidence(messages, undefined, { turnStartedAtMs: dispatchAt }).finalSummary).toBe('');
  });

  it('self-heals: a fast-but-genuine answer qualifies once it has AGED past the window', () => {
    // The 84594b15 shape: the entire answer landed at dispatch+4s, but the worker is
    // genuinely done and the bubble is now minutes old — candidacy is only delayed,
    // never lost.
    const dispatchAt = Date.now() - 120_000;
    const messages = [
      { role: 'user', content: 'quick question', timestamp: dispatchAt + 500 },
      { role: 'assistant', content: 'Done — the answer.', timestamp: dispatchAt + 4_000 },
    ] as any;
    expect(selectFinalAssistantTurnEndMessage(messages, { turnStartedAtMs: dispatchAt })?.content).toBe('Done — the answer.');
  });

  it('admits a bubble that landed past the window even while fresh (ordinary settle windows own freshness)', () => {
    const dispatchAt = Date.now() - 40_000;
    const messages = [
      { role: 'user', content: 'task', timestamp: dispatchAt + 500 },
      { role: 'assistant', content: 'Done after real work.', timestamp: dispatchAt + 35_000 }, // 35s after dispatch, 5s old
    ] as any;
    expect(selectFinalAssistantTurnEndMessage(messages, { turnStartedAtMs: dispatchAt })?.content).toBe('Done after real work.');
  });

  it('does not fire without a boundary, on an undated bubble, or on a pre-dispatch bubble', () => {
    const undated = [
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'undated answer' },
    ] as any;
    // No boundary → legacy behaviour.
    expect(selectFinalAssistantTurnEndMessage(undated)?.content).toBe('undated answer');
    // Boundary but undated bubble → the guard cannot prove freshness → legacy behaviour.
    expect(selectFinalAssistantTurnEndMessage(undated, { turnStartedAtMs: Date.now() })?.content).toBe('undated answer');
    // A bubble PROVABLY older than dispatch is the prior turn's tail — the stale-summary
    // guards own that refusal downstream; this guard only covers the fresh-ack window.
    const boundary = Date.now();
    const preDispatch = [
      { role: 'assistant', content: 'prior answer', timestamp: boundary - 60_000 },
    ] as any;
    expect(selectFinalAssistantTurnEndMessage(preDispatch, { turnStartedAtMs: boundary })?.content).toBe('prior answer');
  });
});
