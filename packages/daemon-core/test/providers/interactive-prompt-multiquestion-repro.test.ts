import { describe, it, expect, vi } from 'vitest';
import {
  detectClaudeAskUserQuestionPromptFromTuiPages,
  detectClaudeTuiMultiSelect,
  readFocusedClaudeTuiQuestion,
} from '../../src/providers/types/interactive-prompt';
import { SpecCliAdapter } from '../../src/providers/spec/cli-adapter.js';

// Repro for the reported bug: a 3-question multi-select AskUserQuestion
// (아침/점심/저녁, each with 3 side-dish options) renders as CHECKBOXES in the
// claude-cli terminal but the web dashboard shows RADIO buttons.
//
// In the live TUI the focused question page draws its option-row checkbox
// glyphs ("❯ ☐ 1. Label"); the nav header line shows a ☐ per question. When the
// daemon Tab-captures pages 2 and 3, the snapshot is taken right after the Tab
// keypress, so the newly-focused page's option-row glyph column has not redrawn
// yet — the page shows the question + option labels but NO per-option checkbox
// markers, and the multi-select footer hint is gone in current claude-cli. Only
// page 1 (already settled on screen at capture time) carries the glyphs.
describe('multi-question multi-select capture (repro)', () => {
  const footer = 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel';
  const nav = '←  ☐ 아침  ☐ 점심  ☐ 저녁  ✔ Submit  →';

  // Page 1: focused, glyphs drawn. claude-cli >=2.1 draws the checkbox AFTER
  // the number ("❯ 1. [ ] Label"), which the live daemon confirmed.
  const page1 = [
    nav,
    '',
    '아침 반찬으로 무엇을 드시겠어요?',
    '',
    '❯ 1. [ ] 계란말이',
    '     부드럽고 든든한 단백질 반찬',
    '  2. [ ] 김구이',
    '     바삭한 조미김, 밥도둑',
    '  3. [ ] 콩자반',
    '     달짝지근한 검은콩 조림',
    '────────────────────────────────────────────────',
    footer,
  ].join('\n');

  // Page 2: just Tab-switched. Glyph column not yet redrawn — cursor only.
  const page2 = [
    nav,
    '',
    '점심 반찬으로 무엇을 드시겠어요?',
    '',
    '❯ 1. 제육볶음',
    '     매콤한 돼지고기 볶음',
    '  2. 시금치나물',
    '     담백한 데친 시금치 무침',
    '  3. 감자조림',
    '     간장에 졸인 달큰한 감자',
    '────────────────────────────────────────────────',
    footer,
  ].join('\n');

  // Page 3: same — glyph column not yet redrawn.
  const page3 = [
    nav,
    '',
    '저녁 반찬으로 무엇을 드시겠어요?',
    '',
    '❯ 1. 고등어구이',
    '     노릇하게 구운 고소한 생선',
    '  2. 두부조림',
    '     매콤 양념의 부드러운 두부',
    '  3. 오이무침',
    '     새콤아삭한 오이 무침',
    '────────────────────────────────────────────────',
    footer,
  ].join('\n');

  // The settled snapshot for each page once the glyph column has redrawn (what
  // a later status tick sees while the user is navigating the picker). Real
  // layout: checkbox AFTER the number.
  const page2Settled = page2
    .replace('❯ 1. 제육볶음', '❯ 1. [ ] 제육볶음')
    .replace('  2. 시금치나물', '  2. [ ] 시금치나물')
    .replace('  3. 감자조림', '  3. [ ] 감자조림');
  const page3Settled = page3
    .replace('❯ 1. 고등어구이', '❯ 1. [ ] 고등어구이')
    .replace('  2. 두부조림', '  2. [ ] 두부조림')
    .replace('  3. 오이무침', '  3. [ ] 오이무침');

  it('capture-time loss: pages 2 and 3 freeze as single-select (the bug)', () => {
    const prompt = detectClaudeAskUserQuestionPromptFromTuiPages(
      [{ screenText: page1 }, { screenText: page2 }, { screenText: page3 }],
      { promptId: 'meals', createdAt: 1 },
    );
    expect(prompt).not.toBeNull();
    // Page 1 is correct (settled); 2 and 3 lost because glyphs weren't drawn.
    expect(prompt!.questions.map(q => q.multiSelect)).toEqual([true, false, false]);
  });

  it('upgrade path: focused-page re-read attributes glyphs to the right question', () => {
    // Simulate the capture result, then the status-tick upgrade re-reading each
    // settled page. This mirrors maybeUpgradeClaudeTuiMultiSelect's logic.
    const prompt = detectClaudeAskUserQuestionPromptFromTuiPages(
      [{ screenText: page1 }, { screenText: page2 }, { screenText: page3 }],
      { promptId: 'meals', createdAt: 1 },
    );
    const questions = prompt!.questions;

    for (const settled of [page2Settled, page3Settled]) {
      const focused = readFocusedClaudeTuiQuestion(settled);
      expect(focused).not.toBeNull();
      expect(focused!.multiSelect).toBe(true);
      const match = questions.find(q =>
        (focused!.header && q.header && q.header === focused!.header)
        || q.question === focused!.question);
      expect(match).toBeDefined();
      if (match && !match.multiSelect) match.multiSelect = true;
    }

    expect(questions.map(q => q.multiSelect)).toEqual([true, true, true]);
  });

  it('settle-poll picks the redrawn frame, so capture sees [true,true,true] (the fix)', () => {
    // Model snapshotSettledClaudeTuiPage: after Tabbing to a page the driver
    // first returns the racy (pre-redraw) frame, then the settled frame on a
    // later poll. The poll stops as soon as detectClaudeTuiMultiSelect is true.
    const settleFromFrames = (frames: string[]): string => {
      let chosen = frames[0];
      for (const frame of frames) {
        chosen = frame;
        if (detectClaudeTuiMultiSelect(frame)) break; // settled — stop polling
      }
      return chosen;
    };

    // Page 1 is already settled at capture time; pages 2/3 redraw on a later poll.
    const capturedPages = [
      { screenText: settleFromFrames([page1]) },
      { screenText: settleFromFrames([page2, page2Settled]) },
      { screenText: settleFromFrames([page3, page3Settled]) },
    ];

    const prompt = detectClaudeAskUserQuestionPromptFromTuiPages(capturedPages, {
      promptId: 'meals',
      createdAt: 1,
    });
    expect(prompt).not.toBeNull();
    // With the settle-poll choosing the redrawn frame, every page is captured
    // as multi-select — no page 2+ freeze, so no later upgrade is needed.
    expect(prompt!.questions.map(q => q.multiSelect)).toEqual([true, true, true]);
  });

  it('settle-poll bounded: a genuine single-select page polls to timeout and stays single-select', () => {
    // A single-select page never shows checkbox glyphs, so the poll exhausts
    // every frame and falls back to the last one — still single-select. This
    // guards against the fix over-promoting single-select questions.
    const singlePage = [
      '←  ☐ 모드  ✔ Submit  →',
      '',
      '실행 모드를 고르세요',
      '',
      '❯ 1. 빠르게',
      '  2. 안전하게',
      '────────────────────────────────────────────────',
      footer,
    ].join('\n');
    // Even re-polling the same frame N times never flips detection.
    let chosen = singlePage;
    for (let i = 0; i < 5; i += 1) {
      chosen = singlePage;
      if (detectClaudeTuiMultiSelect(chosen)) break;
    }
    expect(detectClaudeTuiMultiSelect(chosen)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MIXED single/multi prompt — the page-identity defect (owner-observed).
//
// The suite above only covers HOMOGENEOUS question sets (all three meal pages
// are multi-select), where the return-pass screenText swap is harmless: every
// page's re-read looks like every other page's, so landing on the wrong one
// costs nothing observable.
//
// The reported incident was a 2-question prompt with MIXED modes:
//   Q1 = single-select (3 options)   Q2 = multi-select (4 options)
// The dashboard rendered BOTH as checkboxes with IDENTICAL title and body —
// Q1 had been overwritten by Q2.
//
// Root cause is captureClaudeTuiPrompt's return pass. After the forward Tab
// pass captures pages 1..N correctly, it Shift-Tabs back through N..2 and, on
// each landing, replaces `landed.screenText` with the re-read frame whenever
// the re-read shows multi-select glyphs and the landed page does not. That
// swap is gated ONLY on the glyph signal — it never checks that the re-read
// frame is actually the SAME PAGE. When the Shift-Tab does not land (PTY
// timing: keypress swallowed, or the frame polled before the picker moved),
// the re-read is still page 2, and page 1's slot gets page 2's whole screen.
//
// Its `header` field is passed separately (from the nav line, by index) so it
// stays "Q1" — which is exactly the observed symptom: Q1's header over Q2's
// question text, Q2's options, and Q2's checkboxes.
describe('mixed single/multi prompt — return-pass page identity', () => {
  const footer = 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel';
  const nav = '←  ☐ 배포 방식  ☐ 검증 항목  ✔ Submit  →';

  // Q1 — SINGLE-select: option rows carry a cursor/number only, no checkboxes.
  const q1Text = '배포를 어떤 방식으로 진행할까요?';
  const q1Page = [
    nav,
    '',
    q1Text,
    '',
    '❯ 1. 프리뷰 먼저',
    '     rc 프리뷰에 배포 후 검증',
    '  2. 바로 프로덕션',
    '     프로덕션에 즉시 배포',
    '  3. 배포 보류',
    '     이번 주기는 배포하지 않음',
    '────────────────────────────────────────────────',
    footer,
  ].join('\n');

  // Q2 — MULTI-select: option rows carry checkbox glyphs after the number.
  const q2Text = '어떤 항목을 검증할까요?';
  const q2Page = [
    nav,
    '',
    q2Text,
    '',
    '❯ 1. [ ] 유닛 테스트',
    '     daemon-core vitest',
    '  2. [ ] 타입체크',
    '     tsc --noEmit',
    '  3. [ ] 스모크',
    '     wrangler dry-run',
    '  4. [ ] 라이브 E2E',
    '     실제 데몬 대상 검증',
    '────────────────────────────────────────────────',
    footer,
  ].join('\n');

  /**
   * Drive the REAL SpecCliAdapter.captureClaudeTuiPrompt against a scripted
   * driver, so the assertion covers the shipped code path rather than a
   * re-implementation of it.
   *
   * `landsOnShiftTab` models the PTY reality the guard has to survive: when
   * false the Shift-Tab keypress does not move the picker, so every return-pass
   * re-read still renders page 2.
   */
  async function runCapture(landsOnShiftTab: boolean): Promise<any> {
    let focusedPage = 0; // forward pass starts on page 1 (index 0)
    const adapter: any = Object.create(SpecCliAdapter.prototype);
    Object.assign(adapter, {
      cliType: 'claude-cli',
      cliName: 'Claude Code',
      workingDir: '/tmp/work',
      activeInteractivePrompt: null,
      interactivePromptTransport: null,
      interactivePromptLostAt: null,
      claudeTuiPromptCaptureInFlight: false,
      statusCallback: vi.fn(),
      driver: {
        snapshot: () => (focusedPage === 0 ? q1Page : q2Page),
        dispatch: (event: any) => {
          if (event?.kind !== 'pty_write') return;
          if (event.data === '\t') focusedPage = Math.min(focusedPage + 1, 1);
          // Shift-Tab: only moves the picker when the keypress actually lands.
          if (event.data === '\x1b[Z' && landsOnShiftTab) focusedPage = Math.max(focusedPage - 1, 0);
        },
      },
    });

    await adapter.captureClaudeTuiPrompt(q1Page, ['배포 방식', '검증 항목']);
    return adapter.activeInteractivePrompt;
  }

  it('a mis-landed Shift-Tab must NOT overwrite Q1 with Q2 (the defect)', async () => {
    const prompt = await runCapture(/* landsOnShiftTab */ false);

    expect(prompt).not.toBeNull();
    const [first, second] = prompt.questions;

    // The defect: Q1's screenText is replaced by Q2's, so Q1 comes back with
    // Q2's question text, Q2's four options, and Q2's checkboxes — two
    // identical-looking checkbox questions in the dashboard.
    expect(first.question).toBe(q1Text);
    expect(first.multiSelect).toBe(false);
    expect(first.options.map((o: any) => o.label)).toEqual(['프리뷰 먼저', '바로 프로덕션', '배포 보류']);

    // Q2 is unaffected either way — it is the page that was actually on screen.
    expect(second.question).toBe(q2Text);
    expect(second.multiSelect).toBe(true);
    expect(second.options).toHaveLength(4);

    // The two questions must not collapse into the same rendered content.
    expect(first.question).not.toBe(second.question);
  });

  it('a Shift-Tab that DOES land still repairs a racy forward-pass frame', async () => {
    // Identity guard must not block the legitimate repair the return pass
    // exists for. Here the picker really moves back to page 1, so the re-read
    // is genuinely page 1 and the swap is allowed — but page 1 is single-select
    // so nothing changes, and correctness is preserved.
    const prompt = await runCapture(/* landsOnShiftTab */ true);

    expect(prompt).not.toBeNull();
    expect(prompt.questions[0].question).toBe(q1Text);
    expect(prompt.questions[0].multiSelect).toBe(false);
    expect(prompt.questions[1].question).toBe(q2Text);
    expect(prompt.questions[1].multiSelect).toBe(true);
  });
});
