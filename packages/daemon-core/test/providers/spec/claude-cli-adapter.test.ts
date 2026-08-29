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

const OTHER_CHECKBOX_PICKER_SCREEN = [
  '────────────────────────────────────────────────────────────────',
  ' ☐ Model ',
  '',
  'Which model should Claude use?',
  '',
  '❯ [ ] 1. Opus',
  '  [ ] 2. Sonnet',
  '  [ ] 3. Haiku',
  '────────────────────────────────────────────────────────────────',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

// During a picker transition claude can leave the AskUserQuestion frame in the
// scrollback while a second picker owns focus at the bottom of the terminal.
// The shared footer is intentionally present twice: footer presence alone
// cannot identify which picker will receive an injected key.
const STACKED_PICKERS_SCREEN = [
  SINGLE_QUESTION_SCREEN,
  '',
  OTHER_CHECKBOX_PICKER_SCREEN,
].join('\n');

function renderPromptQuestionScreen(prompt: any, questionIndex = 0): string {
  const question = prompt.questions[questionIndex];
  const nav = `←  ${prompt.questions.map((q: any) => `☐ ${q.header || q.questionId}`).join('  ')}  ✔ Submit  →`;
  return [
    nav,
    '',
    question.question,
    '',
    ...question.options.map((option: any, index: number) => (
      `${index === 0 ? '❯' : ' '} ${index + 1}. ${question.multiSelect ? '[ ] ' : ''}${option.label}`
    )),
    '────────────────────────────────────────────────────────────────',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');
}

function renderPromptReviewScreen(prompt: any): string {
  return [
    `←  ${prompt.questions.map((q: any) => `☒ ${q.header || q.questionId}`).join('  ')}  ✔ Submit  →`,
    '',
    'Ready to submit your answers?',
    '',
    '❯ Submit answers',
    '  Cancel',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');
}

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
    adapter.latestModal = { title: 'Proceed?', buttons: [{ index: 0, label: 'Yes' }, { index: 1, label: 'No' }], kind: 'approval' };

    const status = adapter.getStatus();
    expect(status.status).toBe('waiting_approval');
    // activeModal carries the semantic modal `kind` through to the auto-approve gate, plus
    // buttonMeta preserving each label's real FSM display index (BUTTON-INDEX-MISMAP Fix C.1).
    expect(status.activeModal).toEqual({
      message: 'Proceed?',
      buttons: ['Yes', 'No'],
      buttonMeta: [{ index: 0, label: 'Yes' }, { index: 1, label: 'No' }],
      kind: 'approval',
    });
  });

  it('surfaces a picker modal as waiting_approval but tags it kind=picker (so it is NOT auto-answered)', () => {
    // A /model picker shares the approval status (so the dashboard still shows
    // the modal), but carries kind='picker' so the auto-approve gate leaves it
    // for the user instead of blindly selecting the first option.
    const adapter = makeAdapter(SINGLE_QUESTION_SCREEN);
    adapter.latestState = { id: 'picker', label: 'Picker open', title: 'Select a model', status: 'approval' };
    adapter.latestModal = {
      title: 'Select a model',
      buttons: [{ index: 0, label: '1. Default (recommended)' }, { index: 1, label: '2. Opus' }, { index: 2, label: '3. Sonnet' }],
      kind: 'picker',
    };

    const status = adapter.getStatus();
    expect(status.status).toBe('waiting_approval');
    expect(status.activeModal?.kind).toBe('picker');
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

  it('clears the held question when only a different picker keeps the shared footer alive', () => {
    vi.useFakeTimers();
    try {
      let screen = SINGLE_QUESTION_SCREEN;
      const adapter = makeAdapter(SINGLE_QUESTION_SCREEN);
      adapter.driver = { snapshot: () => screen };

      adapter.maybeCaptureClaudeTuiPrompt();
      expect(adapter.activeInteractivePrompt?.questions[0]?.question).toBe('무엇을 내시겠어요?');

      // The AskUserQuestion picker is gone, but another claude picker replaces
      // it and renders the same footer. Footer-only presence tracking wedges
      // the held question forever instead of starting the lost grace window.
      screen = OTHER_CHECKBOX_PICKER_SCREEN;
      adapter.maybeClearResolvedClaudeTuiPrompt();
      vi.advanceTimersByTime(1600);
      adapter.maybeClearResolvedClaudeTuiPrompt();

      expect(adapter.activeInteractivePrompt).toBeNull();
      expect(adapter.interactivePromptTransport).toBeNull();
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

describe('SpecCliAdapter — TUI multiSelect re-evaluated on later frames', () => {
  // Regression (first-frame glyph miss): the TUI prompt is captured on the FIRST
  // frame that renders the "Enter to select" footer. If the option rows'
  // checkbox column has not drawn yet on that frame, detectClaudeTuiMultiSelect
  // returns false and the prompt freezes as single-select — the dashboard then
  // renders radio buttons even though the picker is multi-select. Once the glyph
  // column appears on a later frame the adapter must promote the held prompt to
  // multiSelect:true and re-emit status. Promotion is one-way (false→true).

  // Frame 1: a headerless numbered-choice picker with NO checkbox glyphs yet —
  // captured as multiSelect:false. (Same shape as SINGLE_QUESTION_SCREEN.)
  const FRAME_NO_GLYPH = [
    '▗ ▗   ▖ ▖  Claude Code v2.1.153',
    '  ▘▘ ▝▝    ~/Work/adhdev',
    '',
    '────────────────────────────────────────────────────────────────',
    ' ☐ Languages ',
    '',
    '무엇을 내시겠어요?',
    '',
    '❯ 1. ✊ 바위',
    '  2. ✌️  가위',
    '  3. ✋  보',
    '  4. Type something.',
    '────────────────────────────────────────────────────────────────',
    '  5. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');

  // Frame 2: the same prompt, now with the per-option checkbox column rendered.
  const FRAME_WITH_GLYPH = [
    '▗ ▗   ▖ ▖  Claude Code v2.1.153',
    '  ▘▘ ▝▝    ~/Work/adhdev',
    '',
    '────────────────────────────────────────────────────────────────',
    ' ☐ Languages ',
    '',
    '무엇을 내시겠어요?',
    '',
    '❯ [ ] 1. ✊ 바위',
    '  [x] 2. ✌️  가위',
    '  [ ] 3. ✋  보',
    '  4. Type something.',
    '────────────────────────────────────────────────────────────────',
    '  5. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');

  it('promotes multiSelect false→true when the checkbox glyphs appear on a later frame', () => {
    let screen = FRAME_NO_GLYPH;
    const adapter = makeAdapter(FRAME_NO_GLYPH);
    adapter.driver = { snapshot: () => screen };

    // First frame: captured as single-select (no glyph column yet).
    adapter.maybeCaptureClaudeTuiPrompt();
    expect(adapter.activeInteractivePrompt).not.toBeNull();
    expect(adapter.activeInteractivePrompt.questions).toHaveLength(1);
    expect(adapter.activeInteractivePrompt.questions[0].multiSelect).toBe(false);
    adapter.statusCallback.mockClear();

    // Later frame: glyph column now rendered → promote to multi-select.
    screen = FRAME_WITH_GLYPH;
    adapter.maybeUpgradeClaudeTuiMultiSelect();
    expect(adapter.activeInteractivePrompt.questions[0].multiSelect).toBe(true);
    expect(adapter.statusCallback).toHaveBeenCalled();
  });

  it('does not promote a genuine single-select prompt on later frames (no false-positive)', () => {
    const screen = FRAME_NO_GLYPH;
    const adapter = makeAdapter(FRAME_NO_GLYPH);
    adapter.driver = { snapshot: () => screen };

    adapter.maybeCaptureClaudeTuiPrompt();
    expect(adapter.activeInteractivePrompt.questions[0].multiSelect).toBe(false);
    adapter.statusCallback.mockClear();

    // Subsequent frames keep showing the numbered rows without any checkbox
    // glyph → stays single-select, no spurious status re-emit.
    adapter.maybeUpgradeClaudeTuiMultiSelect();
    adapter.maybeUpgradeClaudeTuiMultiSelect();
    expect(adapter.activeInteractivePrompt.questions[0].multiSelect).toBe(false);
    expect(adapter.statusCallback).not.toHaveBeenCalled();
  });

  it('does not promote a held single-select from a different focused checkbox picker', () => {
    let screen = SINGLE_QUESTION_SCREEN;
    const adapter = makeAdapter(SINGLE_QUESTION_SCREEN);
    adapter.driver = { snapshot: () => screen };

    adapter.maybeCaptureClaudeTuiPrompt();
    expect(adapter.activeInteractivePrompt.questions[0].multiSelect).toBe(false);
    adapter.statusCallback.mockClear();

    screen = STACKED_PICKERS_SCREEN;
    adapter.maybeUpgradeClaudeTuiMultiSelect();

    expect(adapter.activeInteractivePrompt.questions[0].multiSelect).toBe(false);
    expect(adapter.statusCallback).not.toHaveBeenCalled();
  });

  it('is a no-op once multiSelect is already true (one-way promotion, no demote)', () => {
    let screen = FRAME_WITH_GLYPH;
    const adapter = makeAdapter(FRAME_WITH_GLYPH);
    adapter.driver = { snapshot: () => screen };

    // Captured straight as multi-select (glyphs present on the first frame).
    adapter.maybeCaptureClaudeTuiPrompt();
    expect(adapter.activeInteractivePrompt.questions[0].multiSelect).toBe(true);
    adapter.statusCallback.mockClear();

    // A later frame where the glyph column has scrolled out of view must NOT
    // demote the already-known multi-select prompt, and must not re-emit.
    screen = FRAME_NO_GLYPH;
    adapter.maybeUpgradeClaudeTuiMultiSelect();
    expect(adapter.activeInteractivePrompt.questions[0].multiSelect).toBe(true);
    expect(adapter.statusCallback).not.toHaveBeenCalled();
  });
});

describe('SpecCliAdapter — setInteractivePromptResponse submit path', () => {
  // End-to-end of the actual daemon submit entry point: when the dashboard
  // submits an interactive prompt answer, cli-provider-instance forwards it to
  // adapter.setInteractivePromptResponse(), which (for the TUI transport) builds
  // key steps and writes them to the PTY. This test drives that real method with
  // a mock dispatch driver and asserts the exact bytes written.
  //
  // The multi-select case is the regression under fix: setInteractivePromptResponse
  // previously threw "Claude TUI multi-select prompts are not supported yet", so a
  // checked-box submit never reached the PTY — the selection was silently dropped.
  function makeSubmitAdapter(prompt: any): { adapter: any; writes: string[] } {
    const writes: string[] = [];
    let questionIndex = 0;
    let screen = renderPromptQuestionScreen(prompt, questionIndex);
    const adapter = makeAdapter(screen);
    adapter.driver = {
      snapshot: () => screen,
      dispatch: (event: any) => {
        if (event?.kind !== 'pty_write') return;
        writes.push(event.data);
        const question = prompt.questions[questionIndex];
        if (!question) return; // final Enter on the review page
        const advancesQuestion = event.data === '\t'
          || (!question.multiSelect && /^\d$/.test(event.data));
        if (!advancesQuestion) return;
        questionIndex += 1;
        screen = questionIndex < prompt.questions.length
          ? renderPromptQuestionScreen(prompt, questionIndex)
          : renderPromptReviewScreen(prompt);
      },
    };
    adapter.activeInteractivePrompt = prompt;
    adapter.interactivePromptTransport = 'tui';
    return { adapter, writes };
  }

  const MULTI_PROMPT = {
    promptId: 'ask-multi-1',
    origin: 'cli' as const,
    providerType: 'claude-cli',
    createdAt: 0,
    questions: [
      {
        questionId: 'q1',
        question: 'Pick all languages',
        header: 'Languages',
        multiSelect: true,
        options: [{ label: 'TypeScript' }, { label: 'Python' }, { label: 'Rust' }],
        allowFreeform: false,
      },
    ],
  };

  it('writes a digit per checked box (no Space) and Tab to advance on a multi-select submit', async () => {
    const { adapter, writes } = makeSubmitAdapter(MULTI_PROMPT);

    await adapter.setInteractivePromptResponse({
      promptId: 'ask-multi-1',
      answers: { q1: { selectedLabels: ['TypeScript', 'Rust'] } },
    });

    // In the claude-cli checkbox picker a digit toggles its option directly
    // (cursor does not move), so TypeScript(idx0) → '1', Rust(idx2) → '3' — NO
    // trailing Space (which would toggle the cursor's row instead). Tab commits
    // the question and advances to the Review screen; final Enter submits.
    expect(writes).toEqual(['1', '3', '\t', '\r']);
    expect(writes).not.toContain(' ');
    // The held prompt is cleared after a successful submit.
    expect(adapter.activeInteractivePrompt).toBeNull();
    expect(adapter.interactivePromptTransport).toBeNull();
    expect(adapter.statusCallback).toHaveBeenCalled();
  });

  it('still writes a single numeric key for a single-select submit (no regression)', async () => {
    const single = {
      ...MULTI_PROMPT,
      promptId: 'ask-single-1',
      questions: [{ ...MULTI_PROMPT.questions[0], questionId: 'q1', multiSelect: false }],
    };
    const { adapter, writes } = makeSubmitAdapter(single);

    await adapter.setInteractivePromptResponse({
      promptId: 'ask-single-1',
      answers: { q1: { selectedLabels: ['Python'] } },
    });

    // Python(idx1) → '2', then final Enter to submit. No Space toggles.
    expect(writes).toEqual(['2', '\r']);
    expect(writes).not.toContain(' ');
  });

  it('fails closed before writing when another stacked picker owns focus', async () => {
    let screen = SINGLE_QUESTION_SCREEN;
    const writes: string[] = [];
    const adapter = makeAdapter(SINGLE_QUESTION_SCREEN);
    adapter.driver = {
      snapshot: () => screen,
      dispatch: (event: any) => {
        if (event?.kind === 'pty_write') writes.push(event.data);
      },
    };

    adapter.maybeCaptureClaudeTuiPrompt();
    const prompt = adapter.activeInteractivePrompt;
    expect(prompt?.questions[0]?.question).toBe('무엇을 내시겠어요?');

    // The original question remains visible above, but the lower picker is the
    // focused widget that will consume input. promptId still matches the held
    // slot, so only a live focused-question check can prevent the stale write.
    screen = STACKED_PICKERS_SCREEN;
    await expect(adapter.setInteractivePromptResponse({
      promptId: prompt.promptId,
      answers: { q1: { selectedLabels: ['✌️  가위'] } },
    })).rejects.toThrow(/focused.*question|question.*focused/i);

    expect(writes).toEqual([]);
    expect(adapter.activeInteractivePrompt).toBe(prompt);
  });

  it('rechecks focus before every key and stops when a second picker appears mid-submit', async () => {
    let screen = renderPromptQuestionScreen(MULTI_PROMPT);
    const writes: string[] = [];
    const adapter = makeAdapter(screen);
    adapter.driver = {
      snapshot: () => screen,
      dispatch: (event: any) => {
        if (event?.kind !== 'pty_write') return;
        writes.push(event.data);
        if (writes.length === 1) {
          screen = [renderPromptQuestionScreen(MULTI_PROMPT), OTHER_CHECKBOX_PICKER_SCREEN].join('\n');
        }
      },
    };
    adapter.activeInteractivePrompt = MULTI_PROMPT;
    adapter.interactivePromptTransport = 'tui';

    await expect(adapter.setInteractivePromptResponse({
      promptId: MULTI_PROMPT.promptId,
      answers: { q1: { selectedLabels: ['TypeScript', 'Rust'] } },
    })).rejects.toThrow(/focused.*question|question.*focused/i);

    // First toggle landed while the held question owned focus; the next toggle
    // was withheld as soon as the new lower picker became focused.
    expect(writes).toEqual(['1']);
    expect(adapter.activeInteractivePrompt).toBe(MULTI_PROMPT);
  });

  // RESIDUAL FOCUS-GUARD GAP (live defect, 2026-08-29): a 3-choice + "Other"
  // (Type something.) AskUserQuestion answered via the freeform field was
  // rejected with "Claude TUI review page is not focused for the active
  // interactive prompt" — the plain settle budget (tuned against a one-digit
  // option select) gave up before the review page finished repainting the
  // typed answer. This end-to-end run proves setInteractivePromptResponse
  // actually derives usedFreeform from the response and forwards it, by
  // simulating a review repaint slower than the plain budget but within the
  // widened freeform one.
  const FREEFORM_PROMPT = {
    promptId: 'ask-freeform-1',
    origin: 'cli' as const,
    providerType: 'claude-cli',
    createdAt: 0,
    questions: [{
      questionId: 'q1',
      question: '무엇을 내시겠어요?',
      header: '가위바위보',
      multiSelect: false,
      options: [{ label: '바위' }, { label: '가위' }, { label: '보' }, { label: 'Type something.' }],
      allowFreeform: true,
    }],
  };

  it('submits a freeform (Other) answer through a slow review repaint that the plain budget would miss', async () => {
    const screen = renderPromptQuestionScreen(FREEFORM_PROMPT);
    let confirmedFreeform = false;
    let staleSnapshotsAfterConfirm = 0;
    let isReview = false;
    let currentScreen = screen;
    const adapter = makeAdapter(screen);
    adapter.driver = {
      snapshot: () => {
        if (confirmedFreeform && !isReview) {
          staleSnapshotsAfterConfirm += 1;
          // Settles on the 7th post-confirm sample (~720ms of polling) — past
          // the plain 600ms/5-sample budget, inside the widened freeform one.
          if (staleSnapshotsAfterConfirm > 6) {
            isReview = true;
            currentScreen = renderPromptReviewScreen(FREEFORM_PROMPT);
          }
        }
        return currentScreen;
      },
      dispatch: (event: any) => {
        if (event?.kind !== 'pty_write') return;
        // The freeform branch's own confirm Enter is the first '\r' written;
        // the final submit Enter (after assertFocusedClaudeTuiReview resolves)
        // is a second, later one this test never reaches if the fix regresses.
        if (event.data === '\r' && !confirmedFreeform) confirmedFreeform = true;
      },
    };
    adapter.activeInteractivePrompt = FREEFORM_PROMPT;
    adapter.interactivePromptTransport = 'tui';

    await adapter.setInteractivePromptResponse({
      promptId: 'ask-freeform-1',
      answers: { q1: { selectedLabels: [], freeformText: 'x' } },
    });

    expect(adapter.activeInteractivePrompt).toBeNull();
    expect(adapter.interactivePromptTransport).toBeNull();
  }, 10000);
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
