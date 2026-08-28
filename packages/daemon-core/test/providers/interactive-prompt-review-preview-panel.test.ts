import { describe, expect, it } from 'vitest';
import {
  isClaudeTuiReviewScreen,
  readFocusedClaudeTuiQuestion,
} from '../../src/providers/types/interactive-prompt.js';

/**
 * REVIEW-PAGE FALSE-NEGATIVE (live defect, 2026-08-28)
 *
 * A dashboard / mesh_answer_question response was rejected with
 * "Claude TUI review page is not focused for the active interactive prompt"
 * on an AskUserQuestion that renders a PREVIEW PANEL beside its option rows.
 *
 * assertFocusedClaudeTuiReview fails closed on
 *   `focused || !isClaudeTuiReviewScreen(screenText)`
 * so it needs readFocusedClaudeTuiQuestion to return null on a review page.
 * The review-page guard inside parseClaudeInteractiveTuiQuestion only fired
 * when the review marker was the FIRST non-blank line after the `✔ Submit`
 * nav line. Preview/notes panel text lands between the two, so the guard was
 * skipped, the leftover option block parsed as an "open question", and the
 * final Enter was refused.
 */
describe('claude TUI review page detection with intervening panel content', () => {
  // Real captured layout (2026-08-28): option rows carry a box-drawn preview
  // panel on the right, plus a notes hint below.
  const QUESTION_PAGE_WITH_PREVIEW = [
    '←  ☐ 세션 바인딩  ✔ Submit  →',
    '',
    '워커 MCP 격리를 어떻게 적용할까요?',
    '',
    '❐ 1. 세션 바인딩 교환 (권장)      ┌──────────────────────────┐',
    '  2. 클레임 시 config 재작성      │ 스폰: config { env: { … } }',
    '                                  └──────────────────────────┘',
    '',
    'Notes: press n to add notes',
    '  3. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel',
  ].join('\n');

  // Same picker, now on its final review/submit page. The preview panel and
  // the notes hint are still drawn, so the review marker is NOT adjacent to
  // the nav line — this is the exact shape that defeated the old guard.
  const REVIEW_PAGE_WITH_PREVIEW = [
    '←  ☒ 세션 바인딩  ✔ Submit  →',
    '',
    '┌──────────────────────────┐',
    '│ 스폰: config { env: { … } }',
    '└──────────────────────────┘',
    'Notes: press n to add notes',
    '',
    'Review your answers',
    '',
    '❯ 1. 세션 바인딩 교환 (권장)',
    '  2. 클레임 시 config 재작성',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');

  // The pre-existing shape: review marker immediately after the nav line.
  const REVIEW_PAGE_ADJACENT = [
    '←  ☒ Favorite color  ☒ Font style  ✔ Submit  →',
    '',
    'Ready to submit your answers?',
    '',
    '❯ 1. Submit',
    '  2. Go back',
    '',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ].join('\n');

  it('RED: a review page whose marker is separated by preview-panel content reads as no focused question', () => {
    // isClaudeTuiReviewScreen already recognises it...
    expect(isClaudeTuiReviewScreen(REVIEW_PAGE_WITH_PREVIEW)).toBe(true);
    // ...so the whole gate hinges on this returning null. Before the fix it
    // returned a bogus question parsed out of the leftover option block,
    // which made assertFocusedClaudeTuiReview throw.
    expect(readFocusedClaudeTuiQuestion(REVIEW_PAGE_WITH_PREVIEW)).toBeNull();
  });

  it('keeps rejecting the adjacent-marker review page (pre-existing behaviour)', () => {
    expect(isClaudeTuiReviewScreen(REVIEW_PAGE_ADJACENT)).toBe(true);
    expect(readFocusedClaudeTuiQuestion(REVIEW_PAGE_ADJACENT)).toBeNull();
  });

  it('still parses a real question page that renders a preview panel', () => {
    const focused = readFocusedClaudeTuiQuestion(QUESTION_PAGE_WITH_PREVIEW);
    expect(focused).not.toBeNull();
    expect(focused?.question).toBe('워커 MCP 격리를 어떻게 적용할까요?');
  });

  it('does not treat a following question as a review page (stacked-picker protection)', () => {
    // Two pickers stacked in one snapshot: an older one above, the focused one
    // below. The focused (bottommost) picker is a real question and must parse.
    const stacked = [
      '←  ☒ First  ✔ Submit  →',
      '',
      'Ready to submit your answers?',
      '',
      '❯ 1. Submit',
      '',
      'Enter to select · Esc to cancel',
      '',
      '←  ☐ Second  ✔ Submit  →',
      '',
      'Which branch should we cut from?',
      '',
      '❯ 1. main',
      '  2. develop',
      '',
      'Enter to select · Esc to cancel',
    ].join('\n');
    const focused = readFocusedClaudeTuiQuestion(stacked);
    expect(focused?.question).toBe('Which branch should we cut from?');
  });
});
