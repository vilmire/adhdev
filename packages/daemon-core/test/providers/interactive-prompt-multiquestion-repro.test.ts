import { describe, it, expect } from 'vitest';
import {
  detectClaudeAskUserQuestionPromptFromTuiPages,
  readFocusedClaudeTuiQuestion,
} from '../../src/providers/types/interactive-prompt';

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
});
