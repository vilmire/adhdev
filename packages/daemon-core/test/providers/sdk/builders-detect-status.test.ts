/**
 * Tests for buildDetectStatusFromTui.
 *
 * Validates the builder against scenarios drawn directly from the 4
 * production CLI providers' real-world screen captures. These are the
 * same regressions the sprint-2026-06 fixes addressed; if the builder
 * can absorb them with declarative spec, it covers ~70% of the
 * detect_status.js code in the audited providers.
 */

import { describe, expect, it } from 'vitest';
import {
  buildDetectStatusFromTui,
  type DetectStatusTuiSpec,
} from '../../../src/providers/sdk/v1/builders/cli/detect-status.js';
import type {
  CliScreenSnapshot,
  CliStatusInput,
} from '../../../src/providers/sdk/v1/types/cli/index.js';

function emptyScreen(text: string): CliScreenSnapshot {
  return {
    text,
    lineCount: text.split('\n').length,
    lines: [],
    nonEmptyLines: [],
    firstNonEmptyLineIndex: -1,
    lastNonEmptyLineIndex: -1,
    firstNonEmptyLine: null,
    lastNonEmptyLine: null,
    promptLineIndex: -1,
    promptLine: null,
    linesAbovePrompt: [],
    linesBelowPrompt: [],
  };
}

function statusInput(screenText: string): CliStatusInput {
  return {
    tail: screenText.split('\n').slice(-8).join('\n'),
    screenText,
    rawBuffer: screenText,
    isWaitingForResponse: false,
    screen: emptyScreen(screenText),
    tailScreen: emptyScreen(screenText),
  };
}

describe('buildDetectStatusFromTui — codex-cli-shaped spec', () => {
  const spec: DetectStatusTuiSpec = {
    spinner: {
      $schema: 'adhdev:tui/spinner@1',
      patterns: [
        { regex: '(?:Thinking|Working) \\((?:\\d+h\\s+\\d+m\\s+\\d+s|\\d+m\\s+\\d+s|\\d+s)', flags: 'i' },
        { regex: 'esc to (?:cancel|interrupt|stop)', flags: 'i' },
      ],
      scope: 'live-frame-tail',
      scopeWindowLines: 12,
    },
    settledPrompt: {
      $schema: 'adhdev:tui/settled-prompt@1',
      regex: '^[›❯>]\\s*$',
      flags: 'm',
      withFooter: [{ pattern: '? for shortcuts' }],
      scope: 'last-n-lines',
      scopeWindowLines: 8,
    },
    modal: {
      $schema: 'adhdev:tui/modal@1',
      questionPattern: 'Do you want to (?:proceed|allow|run|make this edit)',
      buttonPattern: '^[\\s❯>]*\\d+\\.\\s+(.+)$',
    },
  };

  const detect = buildDetectStatusFromTui(spec);

  it('returns generating when Working (8m 56s) is on screen', () => {
    const screen = [
      '⏺ Implementing the new contract loader',
      '',
      'Working (8m 56s • esc to interrupt) · 1 background terminal running',
      '❯ gpt-5-codex high · /skills',
    ].join('\n');
    expect(detect(statusInput(screen))).toBe('generating');
  });

  it('returns generating when only "esc to interrupt" is visible (lower case)', () => {
    const screen = ['plenty of prose', 'esc to interrupt', '❯ gpt-5-codex high'].join('\n');
    expect(detect(statusInput(screen))).toBe('generating');
  });

  it('returns waiting_approval when the proceed question is on screen', () => {
    const screen = [
      'agy wants to run: bash -c "ls"',
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No',
    ].join('\n');
    expect(detect(statusInput(screen))).toBe('waiting_approval');
  });

  it('returns idle when only the settled prompt + footer chrome is visible', () => {
    const screen = [
      'Earlier response from the model.',
      '────────────────────────────────',
      '>',
      '────────────────────────────────',
      '? for shortcuts',
    ].join('\n');
    expect(detect(statusInput(screen))).toBe('idle');
  });

  it('returns generating (not idle) when spinner is visible despite footer also being there', () => {
    // sprint-2026-06 regression: codex kept model footer visible during Working
    // and `hasReadyPrompt` falsely fired idle. Builder must respect spinner-first
    // ordering.
    const screen = [
      'Working (12s • esc to interrupt) · /ps',
      '? for shortcuts',
      '❯',
    ].join('\n');
    expect(detect(statusInput(screen))).toBe('generating');
  });

  it('returns null when nothing on screen matches any cue', () => {
    expect(detect(statusInput('totally blank screen\nno cues here'))).toBe(null);
  });
});

describe('buildDetectStatusFromTui — claude-cli-shaped spec (braille spinner)', () => {
  const spec: DetectStatusTuiSpec = {
    spinner: {
      $schema: 'adhdev:tui/spinner@1',
      patterns: [
        { regex: '[\\u2800-\\u28FF]', description: 'Braille spinner glyphs' },
        { regex: 'esc to (?:cancel|interrupt|stop)', flags: 'i' },
      ],
      scope: 'live-frame-tail',
      scopeWindowLines: 4,
    },
  };

  const detect = buildDetectStatusFromTui(spec);

  it('returns generating when a single braille glyph is present in the live frame tail', () => {
    expect(detect(statusInput('⣟ Thinking...'))).toBe('generating');
  });

  it('returns null when braille only appears far above the live frame tail', () => {
    const screen = ['⣟ very old turn', '', '', '', '', '', '', '', '', 'idle prompt'].join('\n');
    expect(detect(statusInput(screen))).toBe(null);
  });
});

describe('buildDetectStatusFromTui — fixB ① button-block cue with a GENERIC buttonPattern', () => {
  // codex-shaped: buttonPattern matches ANY numbered line. The cue's approval-
  // verb anchor (affirmative + decline required) must keep generic menus from
  // being mis-detected as modals while still catching real approvals after the
  // question line scrolls out. Modal-first dispatch so the cue can win.
  const spec: DetectStatusTuiSpec = {
    spinner: {
      $schema: 'adhdev:tui/spinner@1',
      patterns: [{ regex: 'esc to (?:cancel|interrupt|stop)', flags: 'i' }],
      scope: 'live-frame-tail',
      scopeWindowLines: 12,
    },
    modal: {
      $schema: 'adhdev:tui/modal@1',
      questionPattern: 'Do you want to (?:proceed|allow|run)',
      buttonPattern: '^[\\s❯>]*\\d+\\.\\s+(.+)$',
    },
    dispatchOrder: {
      $schema: 'adhdev:tui/dispatch-order@1',
      order: ['modal', 'spinner', 'settled-prompt'],
      onNoMatch: 'idle',
    },
  };
  const detect = buildDetectStatusFromTui(spec);

  it('fires waiting_approval on a genuine approval block (Yes/No) with the question scrolled out', () => {
    const screen = ['  earlier tool output', '❯ 1. Yes', '  2. No', 'esc to interrupt'].join('\n');
    expect(detect(statusInput(screen))).toBe('waiting_approval');
  });

  it('does NOT mis-detect a generic numbered file menu as a modal', () => {
    const screen = ['Pick a file:', '1. index.ts', '2. main.ts', '3. utils.ts', 'esc to interrupt'].join('\n');
    expect(detect(statusInput(screen))).toBe('generating');
  });

  it('does NOT fire when only an affirmative option is present (no decline)', () => {
    const screen = ['1. Continue', '2. Continue anyway', 'esc to interrupt'].join('\n');
    expect(detect(statusInput(screen))).toBe('generating');
  });
});

describe('buildDetectStatusFromTui — stale modal box supersession (cursor-cli)', () => {
  // cursor-agent's "Workspace Trust Required" box lingers in the terminal grid
  // after the user answers: the redraw that paints the idle composer is shorter
  // than the box, so the top modal rows are never cleared. The unscoped
  // whole-screen modal cue kept firing waiting_approval forever, so the startup
  // gate never released and the session wedged in `starting`/generating.
  const spec: DetectStatusTuiSpec = {
    spinner: {
      $schema: 'adhdev:tui/spinner@1',
      patterns: [{ regex: '\\bWorking\\b' }],
      scope: 'live-frame-tail',
      scopeWindowLines: 12,
    },
    settledPrompt: {
      $schema: 'adhdev:tui/settled-prompt@1',
      regex: '^\\s*(?:Auto|Plan|Ask)\\b[^\\n]*\\n\\s*(?:~|/)[^\\n]+$',
      flags: 'm',
      scope: 'last-n-lines',
      scopeWindowLines: 8,
    },
    modal: {
      $schema: 'adhdev:tui/modal@1',
      questionPattern: 'Do you want to|Do you trust|Trust|approve|Allow',
      questionFlags: 'i',
      buttonPattern:
        '^[\\s│┃|]*(?:[❯›>▶●]\\s*)?(?:\\d+[.)]|\\[[A-Za-z]\\])\\s+([^│┃|]+?)\\s*[│┃|]?\\s*$',
      buttonLabelGroup: 1,
      buttonFlags: 'm',
    },
    dispatchOrder: {
      $schema: 'adhdev:tui/dispatch-order@1',
      order: ['modal', 'spinner', 'settled-prompt'],
      onNoMatch: 'preserve-last',
    },
  };
  const detect = buildDetectStatusFromTui(spec);

  it('yields idle when a stale trust-modal box sits above the repainted composer', () => {
    const screen = [
      '  ╭─────╮',
      '  │  ⚠ Workspace Trust Required',
      '  │  Do you trust the contents of this directory?',
      '  │    /private/tmp/adhdev-selfhost-cursor',
      '  │    [a] Trust this workspace',
      '  │    [q] Quit',
      '  │  ⏳ Trusting workspace...',
      '  ╰─────╯',
      '',
      '  Cursor Agent',
      '  v2026.07.09-a3815c0',
      '  Tip: Use /run-everything to skip all approvals.',
      '',
      '  → Plan, search, build anything',
      '',
      '  Auto',
      '  /private/tmp/adhdev-selfhost-cursor · main',
    ].join('\n');
    expect(detect(statusInput(screen))).toBe('idle');
  });

  it('still fires waiting_approval for a live trust modal (no composer below)', () => {
    const screen = [
      '  ╭─────╮',
      '  │  ⚠ Workspace Trust Required',
      '  │  Do you trust the contents of this directory?',
      '  │    /private/tmp/x',
      '  │  ▶ [a] Trust this workspace',
      '  │    [q] Quit',
      '  ╰─────╯',
    ].join('\n');
    expect(detect(statusInput(screen))).toBe('waiting_approval');
  });

  it('still fires waiting_approval for a live approval modal flush against its buttons', () => {
    const screen = [
      '  Run this command?',
      '    ls -la',
      '  ❯ 1. Yes',
      '    2. No, and tell Cursor what to do differently',
    ].join('\n');
    expect(detect(statusInput(screen))).toBe('waiting_approval');
  });
});

describe('buildDetectStatusFromTui — modal spec `scope` is honored', () => {
  // MODAL-SCOPE-IGNORED: `modalMatches` read `input.screenText` verbatim, so a
  // manifest's declared modal `scope` was silently discarded — cursor-cli
  // shipped `window-around-question: 20` and still wedged. These lock the
  // engine to what the spec asks for, and (critically) lock the ONE region that
  // must stay whole-screen: the scrolled-out-question button-block fallback.
  const baseModal = {
    $schema: 'adhdev:tui/modal@1' as const,
    questionPattern: 'Run this command|Do you want to|Do you trust|Trust|approve|Allow',
    questionFlags: 'i',
    buttonPattern:
      '^[\\s│┃|]*(?:[❯›>▶●]\\s*)?(?:\\d+[.)]|\\[[A-Za-z]\\])\\s+([^│┃|]+?)\\s*[│┃|]?\\s*$',
    buttonLabelGroup: 1,
    buttonFlags: 'm',
  };
  // Mirrors adhdev-providers/cli/cursor-cli/provider.v1.json.
  const scopedSpec: DetectStatusTuiSpec = {
    settledPrompt: {
      $schema: 'adhdev:tui/settled-prompt@1',
      regex: '^\\s*(?:Auto|Plan|Ask)\\b[^\\n]*\\n\\s*(?:~|/)[^\\n]+$',
      flags: 'm',
      scope: 'last-n-lines',
      scopeWindowLines: 8,
    },
    modal: { ...baseModal, scope: 'window-around-question', scopeWindowLines: 20 },
    dispatchOrder: {
      $schema: 'adhdev:tui/dispatch-order@1',
      order: ['modal', 'spinner', 'settled-prompt'],
      onNoMatch: 'preserve-last',
    },
  };
  // Identical except the modal declares nothing — the pre-fix whole-screen read.
  const unscopedSpec: DetectStatusTuiSpec = {
    ...scopedSpec,
    modal: { ...baseModal },
  };

  // A stale trust QUESTION the CLI never cleared, with its button rows already
  // gone (the answered box's options were repainted away) and the live idle
  // composer below.
  //
  // `scope` declares that the question + buttons must appear TOGETHER, so this
  // orphaned question no longer counts as a modal cue. Two properties keep the
  // test honest about which code path decides it:
  //   - No approve/decline button pair survives anywhere, so the whole-screen
  //     `buttonBlockApprovalCue` fallback stays silent and cannot mask the result.
  //   - The intervening lines are ordinary tool prose, so no button row drifts
  //     into the declared 20-line window.
  const staleQuestionThenIdleComposer = [
    '  ⚠ Workspace Trust Required',
    '  Do you trust the contents of this directory?',
    '    /private/tmp/adhdev-selfhost-cursor',
    ...Array.from({ length: 22 }, (_, i) => `  ⏺ Reading src/module-${i + 1}.ts`),
    '  Auto',
    '  /private/tmp/adhdev-selfhost-cursor · main',
  ].join('\n');

  it('yields idle when the declared window excludes the stale box (scope honored)', () => {
    expect(buildDetectStatusFromTui(scopedSpec)(statusInput(staleQuestionThenIdleComposer))).toBe('idle');
  });

  it('an undeclared scope still accepts an orphaned question (whole-screen back-compat)', () => {
    // The contrast that isolates `scope`: same orphaned question, no composer
    // below (so the pre-existing `modalSupersededBySettledPrompt` stale-box
    // mitigation cannot fire and mask the comparison). Whole-screen semantics
    // accept the bare question; the scoped spec below rejects it. This pins that
    // honoring `scope` — not the older spatial mitigation — is what changed.
    const orphanedQuestionOnly = [
      '  ⚠ Workspace Trust Required',
      '  Do you trust the contents of this directory?',
      '    /private/tmp/adhdev-selfhost-cursor',
      ...Array.from({ length: 22 }, (_, i) => `  ⏺ Reading src/module-${i + 1}.ts`),
    ].join('\n');
    expect(buildDetectStatusFromTui(unscopedSpec)(statusInput(orphanedQuestionOnly))).toBe(
      'waiting_approval',
    );
    expect(buildDetectStatusFromTui(scopedSpec)(statusInput(orphanedQuestionOnly))).not.toBe(
      'waiting_approval',
    );
  });

  it('still fires waiting_approval for a LIVE modal under the same scoped spec', () => {
    // Guards against over-narrowing: scoping must not cost real approvals.
    const live = [
      '  Run this command?',
      '    ls -la',
      '  ❯ 1. Yes',
      '    2. No, and tell Cursor what to do differently',
    ].join('\n');
    expect(buildDetectStatusFromTui(scopedSpec)(statusInput(live))).toBe('waiting_approval');
  });

  it('REGRESSION GUARD: a modal whose question scrolled out of frame is still detected via the button block', () => {
    // The load-bearing constraint (detect-status.ts:267-270). With the question
    // line gone there is no anchor to window around, so the button-block cue
    // must keep reading the whole screen. If scoping ever narrows this branch,
    // an in-progress approval becomes undetectable — strictly worse than the
    // stale box this scoping fixes. `Yes`/`No` = affirmative + decline pair.
    const scrolledOut = [
      '    ⏺ Reading src/index.ts',
      '    ⏺ Reading src/app.ts',
      '  ❯ 1. Yes',
      '    2. No, and tell Cursor what to do differently',
    ].join('\n');
    expect(buildDetectStatusFromTui(scopedSpec)(statusInput(scrolledOut))).toBe('waiting_approval');
  });

  it('REGRESSION GUARD: an inline (y/n) approval with NO button rows still fires', () => {
    // The second over-narrowing trap: claude-cli's `(y/n)` fallback variant
    // renders its options inside the question line and draws no button block at
    // all. A co-location rule that demanded separate button rows would suppress
    // a real approval and wedge the session.
    const inlineSpec: DetectStatusTuiSpec = {
      ...scopedSpec,
      modal: {
        ...baseModal,
        questionPattern: 'Are you sure',
        questionVariants: [{ regex: '\\(y/n\\)|\\[Y/n\\]', flags: 'i', label: 'y-n-fallback' }],
        scope: 'window-around-question',
        scopeWindowLines: 48,
      },
    };
    expect(buildDetectStatusFromTui(inlineSpec)(statusInput('Are you sure? (y/n)'))).toBe(
      'waiting_approval',
    );
  });

  it('anchors the window on the prose question, not a button label sharing its keyword', () => {
    // cursor's questionPattern matches the bare word `Trust`, which also appears
    // in the `[a] Trust this workspace` BUTTON. Anchoring there would slide the
    // window down and drop the real question above it.
    const screen = [
      '  Do you trust the contents of this directory?',
      '    /private/tmp/x',
      '  ▶ [a] Trust this workspace',
      '    [q] Quit',
    ].join('\n');
    expect(buildDetectStatusFromTui(scopedSpec)(statusInput(screen))).toBe('waiting_approval');
  });
});

describe('buildDetectStatusFromTui — spec validation', () => {
  it('rejects an invalid spinner regex with a helpful error', () => {
    const spec: DetectStatusTuiSpec = {
      spinner: {
        $schema: 'adhdev:tui/spinner@1',
        patterns: [{ regex: '(unclosed' }],
      },
    };
    expect(() => buildDetectStatusFromTui(spec)(statusInput('anything'))).toThrowError(/Invalid regex/);
  });
});
