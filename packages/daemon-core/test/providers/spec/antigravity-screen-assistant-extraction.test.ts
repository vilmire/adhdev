/**
 * AGY-ASSISTANT-EXTRACTION (M-MESH-INFRA-0829 defect 2)
 *
 * Live 2026-08-29 (Jupiter session ed1a0ec5, spec=antigravity-cli 4.0.json):
 * the worker finished, FSM fired busy→idle, the TUI showed the final JSON
 * report under a `● Bash(...)` tool list — and Spec Debug's
 * "Last Assistant Message" was blank. Mesh turn stayed generating because
 * the completion gate is fail-closed without a final assistant bubble.
 *
 * Root cause is the engine, not the spec:
 *   - spec 4.0.json has FSM section rules only; no assistant-message markers.
 *   - SpecCliAdapter.getScriptParsedStatus / getDebugSnapshot fall through
 *     to readClaudeScreenAssistantMessages, which is a no-op unless
 *     cliType==='claude-cli' (looks for `⏺`).
 *   - native_history is `{ reader: 'antigravity-cli' }` with no `source`,
 *     so the snapshot never even consults the built-in sqlite reader.
 *
 * This fixture is the live layout: user numbered-list echo, thought chrome,
 * collapsed tool calls, then an indented JSON assistant report. Extraction
 * must return that JSON as the last standard assistant message — not the
 * user list, not `● Bash(...)`.
 */
import { describe, expect, it, vi } from 'vitest';
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js';
import { completionHasFinalAssistantMessage } from '../../../src/providers/completion/evidence.js';

/**
 * Measured idle frame: tool-call list + indented JSON answer. Banner / footer
 * / thought captions / user numbered-list echo are present the same way the
 * live snapshot described them (modal:/body: previews showed the user list
 * because body is the whole screen and modal falls back to whole-screen when
 * no approval landmark is on the frame — that is expected FSM section
 * fallback, not the assistant-extraction bug).
 */
export const AGY_TOOL_THEN_JSON_SCREEN = [
  '                  Antigravity CLI 1.0.8',
  '                  worker@example.com (Google AI Ultra)',
  '                  Gemini 3.1 Pro (High)',
  '                  ~/Work/adhdev/oss/packages/daemon-core',
  '              ',
  '',
  '────────────────────────────────────────────────────────────',
  '> # antigravity 완료 추출 실패 RCA+수정',
  '  1. spec FSM 상태 이력: busy→idle 전이 정상',
  '  2. Last Assistant Message가 공란',
  '  3. 완료 게이트는 fail-closed 유지',
  '',
  '▸ Thought for 12s, 1840 tokens',
  '  Prioritizing Tool Usage',
  '',
  '● Bash(git status) (ctrl+o to expand)',
  '● Bash(git -C oss status) (ctrl+o to expand)',
  '',
  '  {',
  '    "status": "completed",',
  '    "rca": "engine PTY parser is Claude-only",',
  '    "fixSide": "daemon-core"',
  '  }',
  '',
  '> ',
  '? for shortcuts',
].join('\n');

const EXPECTED_JSON_ANSWER = [
  '{',
  '"status": "completed",',
  '"rca": "engine PTY parser is Claude-only",',
  '"fixSide": "daemon-core"',
  '}',
].join('\n');

function makeAntigravityAdapter(screenText: string): any {
  const adapter = Object.create(SpecCliAdapter.prototype);
  Object.assign(adapter, {
    cliType: 'antigravity-cli',
    cliName: 'Antigravity CLI',
    workingDir: '/tmp/agy-work',
    driver: {
      snapshot: () => screenText,
      getScreen: () => screenText,
      getSections: () => [
        { id: 'footer', text: '? for shortcuts' },
        { id: 'modal', text: screenText },
        { id: 'body', text: screenText },
      ],
      getStateHistory: () => [],
      hasIdleHoldPending: () => false,
      getLastBusyAt: () => 0,
      getSpecPath: () => 'specs/4.0.json',
      getCursorPosition: () => ({ row: 0, col: 0 }),
      getCompletionIdleDebounceState: () => null,
      getFsmDebug: () => null,
      getFsmSnapshotHistory: () => null,
      getEventTimeline: () => null,
      hasSeenReady: () => true,
    },
    spec: {
      id: 'antigravity-cli',
      name: 'Antigravity CLI',
      native_history: { reader: 'antigravity-cli' },
    },
    latestState: { id: 'idle', label: 'Ready', title: null, status: 'idle' },
    latestModal: null,
    activeInteractivePrompt: null,
    interactivePromptTransport: null,
    claudeTuiPromptCaptureInFlight: false,
    kimiAuthBillingFailure: null,
    exited: false,
    spawned: true,
    spawnedAtMs: Date.now(),
    spawnedEnv: {},
    providerSessionId: undefined,
    owningSessionId: 'sess-agy-1',
    statusCallback: vi.fn(),
  });
  return adapter;
}

describe('SpecCliAdapter — antigravity tool-list + indented JSON assistant extraction', () => {
  it('getScriptParsedStatus extracts the indented JSON after ● Bash(...) as the last assistant message (live idle layout)', () => {
    const adapter = makeAntigravityAdapter(AGY_TOOL_THEN_JSON_SCREEN);
    const parsed = adapter.getScriptParsedStatus();

    expect(parsed.status).toBe('idle');
    const assistants = (parsed.messages ?? []).filter((m: any) => m.role === 'assistant' && m.kind !== 'tool');
    expect(assistants.length).toBeGreaterThan(0);
    const last = assistants[assistants.length - 1];
    expect(last.kind).toBe('standard');
    expect(last.content.replace(/\s+/g, '')).toBe(EXPECTED_JSON_ANSWER.replace(/\s+/g, ''));
    expect(last.content).toContain('"status": "completed"');
    expect(last.content).not.toContain('Busy(git status)');
    expect(last.content).not.toContain('Last Assistant Message가 공란');
    expect(last.content).not.toContain('완료 게이트는 fail-closed');
  });

  it('does not treat the echoed user numbered list as the assistant message', () => {
    const adapter = makeAntigravityAdapter(AGY_TOOL_THEN_JSON_SCREEN);
    const parsed = adapter.getScriptParsedStatus();
    const lastAssistant = [...(parsed.messages ?? [])].reverse().find((m: any) => m.role === 'assistant');
    expect(lastAssistant).toBeDefined();
    expect(lastAssistant.content).not.toMatch(/1\.\s*spec FSM/);
    expect(lastAssistant.content).not.toContain('# antigravity 완료 추출 실패');
  });

  it('does not treat ● Bash(...) tool rows as the last assistant message', () => {
    const adapter = makeAntigravityAdapter(AGY_TOOL_THEN_JSON_SCREEN);
    const parsed = adapter.getScriptParsedStatus();
    const lastAssistant = [...(parsed.messages ?? [])].reverse().find((m: any) => m.role === 'assistant');
    expect(lastAssistant.content).not.toMatch(/^●\s*Bash/);
    expect(lastAssistant.content).not.toMatch(/Bash\(git status\)/);
  });

  it('getDebugSnapshot Last Assistant is the JSON report even when native_history has reader but no source', () => {
    const adapter = makeAntigravityAdapter(AGY_TOOL_THEN_JSON_SCREEN);
    const snap = adapter.getDebugSnapshot() as { messages?: Array<{ role?: string; content?: string }> };
    const lastAssistant = [...(snap.messages ?? [])].reverse().find((m) => m.role === 'assistant' && String(m.content || '').trim());
    expect(lastAssistant, 'snapshot Last Assistant Message was blank').toBeDefined();
    expect(lastAssistant!.content).toContain('"status": "completed"');
  });

  it('extracted JSON is sufficient final-assistant evidence for the fail-closed completion gate', () => {
    const adapter = makeAntigravityAdapter(AGY_TOOL_THEN_JSON_SCREEN);
    const parsed = adapter.getScriptParsedStatus();
    expect(completionHasFinalAssistantMessage(parsed.messages)).toBe(true);
  });

  it('idle screen with tools but no answer body still yields no assistant (fail-closed)', () => {
    const screen = [
      '> run echo capture',
      '',
      '● Bash(echo capture) (ctrl+o to expand)',
      '',
      '> ',
      '? for shortcuts',
    ].join('\n');
    const adapter = makeAntigravityAdapter(screen);
    const parsed = adapter.getScriptParsedStatus();
    const assistants = (parsed.messages ?? []).filter((m: any) => m.role === 'assistant' && String(m.content || '').trim());
    expect(assistants).toEqual([]);
    expect(completionHasFinalAssistantMessage(parsed.messages)).toBe(false);
  });
});
