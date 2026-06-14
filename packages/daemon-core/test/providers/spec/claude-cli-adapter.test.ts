import { describe, expect, it, vi } from 'vitest';
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js';

const SINGLE_QUESTION_SCREEN = [
  '▗ ▗   ▖ ▖  Claude Code v2.1.153',
  '           Opus 4.7 (1M context) with high effort · Claude Max',
  '  ▘▘ ▝▝    ~/Work/adhdev',
  '',
  '❯ ## Task: 가위바위보',
  '',
  '⏺ 안녕하세요! 가위바위보 한 판 해요.',
  '────────────────────────────────────────────────────────────────',
  ' ☐ 가위바위보 ',
  '',
  '무엇을 내시겠어요?',
  '',
  '❯ 1. ✊ 바위',
  '     주먹',
  '  2. ✌️  가위',
  '     검지와 중지',
  '  3. ✋  보',
  '     손바닥',
  '  4. Type something.',
  '────────────────────────────────────────────────────────────────',
  '  5. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

function makeAdapter(screenText: string): any {
  const adapter = Object.create(SpecCliAdapter.prototype);
  Object.assign(adapter, {
    cliType: 'claude-cli',
    cliName: 'Claude Code',
    workingDir: '/tmp/work',
    driver: { snapshot: () => screenText },
    spec: {
      $schema: 'adhdev:cli/spec@1',
      id: 'claude-cli',
      name: 'Claude Code',
      binary: 'claude',
      send_message: { submit_key: '\r' },
      layout: {
        sections: [
          { id: 'footer', from_bottom: 3 },
          { id: 'modal_zone', from_bottom: 11, until: { section: 'footer' } },
          { id: 'body', from_top: 0, until: { section: 'modal_zone' } },
        ],
      },
      states: [{ id: 'idle', label: 'Ready', when: { regex: '.*' } }],
      default_state: 'idle',
    },
    latestState: { id: 'idle', label: 'Ready', title: null, status: 'idle' },
    latestModal: null,
    activeInteractivePrompt: null,
    interactivePromptTransport: null,
    claudeTuiPromptCaptureInFlight: false,
    exited: false,
    spawned: true,
    providerSessionId: 'session-1',
    statusCallback: vi.fn(),
  });
  return adapter;
}

function makeCodexAdapter(screenText: string): any {
  const adapter = makeAdapter(screenText);
  adapter.cliType = 'codex-cli';
  adapter.cliName = 'Codex CLI';
  adapter.spec = {
    ...adapter.spec,
    id: 'codex-cli',
    name: 'Codex CLI',
    binary: 'codex',
  };
  adapter.providerSessionId = undefined;
  return adapter;
}

describe('SpecCliAdapter — claude-cli screen fallbacks', () => {
  it('promotes headerless numbered-choice AskUserQuestion screens to activeInteractivePrompt', () => {
    const adapter = makeAdapter(SINGLE_QUESTION_SCREEN);

    adapter.maybeCaptureClaudeTuiPrompt();

    expect(adapter.activeInteractivePrompt).not.toBeNull();
    expect(adapter.activeInteractivePrompt.questions[0].options.map((option: any) => option.label)).toEqual([
      '✊ 바위',
      '✌️  가위',
      '✋  보',
      'Type something.',
    ]);
    expect(adapter.statusCallback).toHaveBeenCalled();
  });

  it('emits assistant text from the screen body in getScriptParsedStatus', () => {
    const adapter = makeAdapter(SINGLE_QUESTION_SCREEN);

    const parsed = adapter.getScriptParsedStatus();

    expect(parsed.status).toBe('idle');
    expect(parsed.messages).toEqual([expect.objectContaining({
      role: 'assistant',
      kind: 'standard',
      content: '안녕하세요! 가위바위보 한 판 해요.',
    })]);
  });
});

describe('SpecCliAdapter — FSM state is authoritative for status', () => {
  // Regression: an approval state whose modal buttons briefly fail to parse (PTY
  // repaint → latestModal=null) used to collapse to 'idle', firing a false
  // task_completed while the session sat at an approval prompt. Status must follow
  // the FSM state.status, not the presence of a parsed modal.
  it('keeps waiting_approval when the FSM state is approval but the modal failed to parse this frame', () => {
    const adapter = makeAdapter(SINGLE_QUESTION_SCREEN);
    adapter.latestState = { id: 'approval', label: 'Approval requested', title: null, status: 'approval' };
    adapter.latestModal = null; // modal-parse miss

    expect(adapter.getStatus().status).toBe('waiting_approval');
    expect(adapter.getStatus().activeModal).toBeNull();
  });

  it('surfaces modal buttons when the approval state has a parsed modal', () => {
    const adapter = makeAdapter(SINGLE_QUESTION_SCREEN);
    adapter.latestState = { id: 'approval', label: 'Approval requested', title: 'Proceed?', status: 'approval' };
    adapter.latestModal = { title: 'Proceed?', buttons: [{ index: 0, label: 'Yes' }, { index: 1, label: 'No' }] };

    const status = adapter.getStatus();
    expect(status.status).toBe('waiting_approval');
    expect(status.activeModal).toEqual({ message: 'Proceed?', buttons: ['Yes', 'No'] });
  });

  it('reports generating for a busy state regardless of modal', () => {
    const adapter = makeAdapter(SINGLE_QUESTION_SCREEN);
    adapter.latestState = { id: 'busy', label: 'Generating', title: null, status: 'generating' };
    adapter.latestModal = null;

    expect(adapter.getStatus().status).toBe('generating');
  });

  it('reports idle only when the FSM state itself is idle', () => {
    const adapter = makeAdapter(SINGLE_QUESTION_SCREEN);
    adapter.latestState = { id: 'idle', label: 'Ready', title: null, status: 'idle' };
    adapter.latestModal = null;

    expect(adapter.getStatus().status).toBe('idle');
  });
});

describe('SpecCliAdapter — interactive prompt resolved in terminal', () => {
  // Regression (choice-resolve-stuck): when the user answers an AskUserQuestion
  // choice picker directly in the terminal (not via setInteractivePromptResponse),
  // the picker leaves the screen but activeInteractivePrompt was never cleared,
  // so getStatus() re-emitted the same choice modal forever. The adapter must
  // clear the held prompt once its "Enter to select" footer has been absent for
  // the hysteresis window.
  const RESOLVED_SCREEN = [
    '▗ ▗   ▖ ▖  Claude Code v2.1.153',
    '  ▘▘ ▝▝    ~/Work/adhdev',
    '',
    '⏺ 좋아요, 바위를 냈어요!',
    '',
  ].join('\n');

  function holdPrompt(adapter: any): void {
    adapter.activeInteractivePrompt = { promptId: 'ask-user-session-1-1', origin: 'cli', providerType: 'claude-cli', createdAt: 0, questions: [] };
    adapter.interactivePromptTransport = 'tui';
    adapter.interactivePromptLostAt = null;
  }

  it('clears a held prompt once the picker footer is gone past the grace window', () => {
    vi.useFakeTimers();
    try {
      let screen = SINGLE_QUESTION_SCREEN;
      const adapter = makeAdapter(SINGLE_QUESTION_SCREEN);
      adapter.driver = { snapshot: () => screen };
      holdPrompt(adapter);

      // Footer still on screen → first observation arms the timer but holds.
      adapter.maybeClearResolvedClaudeTuiPrompt();
      expect(adapter.activeInteractivePrompt).not.toBeNull();

      // User answers in the terminal → picker leaves the screen.
      screen = RESOLVED_SCREEN;
      adapter.maybeClearResolvedClaudeTuiPrompt();
      // Within the grace window the prompt is still held (repaint protection).
      expect(adapter.activeInteractivePrompt).not.toBeNull();

      vi.advanceTimersByTime(1600);
      adapter.maybeClearResolvedClaudeTuiPrompt();
      expect(adapter.activeInteractivePrompt).toBeNull();
      expect(adapter.interactivePromptTransport).toBeNull();
      expect(adapter.statusCallback).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not clear a held prompt while the footer is still on screen', () => {
    vi.useFakeTimers();
    try {
      const adapter = makeAdapter(SINGLE_QUESTION_SCREEN);
      holdPrompt(adapter);

      adapter.maybeClearResolvedClaudeTuiPrompt();
      vi.advanceTimersByTime(5000);
      adapter.maybeClearResolvedClaudeTuiPrompt();

      expect(adapter.activeInteractivePrompt).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arms the grace timer if the picker reappears after a transient repaint gap', () => {
    vi.useFakeTimers();
    try {
      let screen = SINGLE_QUESTION_SCREEN;
      const adapter = makeAdapter(SINGLE_QUESTION_SCREEN);
      adapter.driver = { snapshot: () => screen };
      holdPrompt(adapter);

      // Transient frame with no footer (mid-repaint), short of the grace window.
      screen = RESOLVED_SCREEN;
      adapter.maybeClearResolvedClaudeTuiPrompt();
      vi.advanceTimersByTime(500);

      // Footer repaints → timer resets, prompt held.
      screen = SINGLE_QUESTION_SCREEN;
      adapter.maybeClearResolvedClaudeTuiPrompt();
      expect(adapter.interactivePromptLostAt).toBeNull();

      // Now a full grace window with the footer gone clears it.
      screen = RESOLVED_SCREEN;
      adapter.maybeClearResolvedClaudeTuiPrompt();
      vi.advanceTimersByTime(1600);
      adapter.maybeClearResolvedClaudeTuiPrompt();
      expect(adapter.activeInteractivePrompt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SpecCliAdapter — codex-cli footer identity', () => {
  it('extracts providerSessionId from ANSI-colored Codex footer', () => {
    const adapter = makeCodexAdapter([
      '\u001b[1;2m› \u001b[0mReply with exactly: ADHDEV_RETEST_A',
      '',
      '\u001b[2m• \u001b[0mADHDEV_RETEST_A',
      '',
      '\u001b[2C\u001b[38;2;246;226;183;22mgpt-5.5 high\u001b[39;2m · \u001b[38;2;171;223;167;22m~/Work/adhdev\u001b[39;2m · \u001b[38;2;148;153;174;22m019ea2ac-b82d-7551-8276-75d047b2fdab\u001b[0m',
    ].join('\n'));

    const parsed = adapter.getScriptParsedStatus();

    expect(parsed.providerSessionId).toBe('019ea2ac-b82d-7551-8276-75d047b2fdab');
  });
});
