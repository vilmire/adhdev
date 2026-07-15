/**
 * Tests for buildParseApprovalFromTui — modal extraction from a
 * declarative tui/modal@1 spec. Scenarios mirror real screen captures
 * from the sprint-2026-06 fixes.
 */

import { describe, expect, it } from 'vitest';
import {
  buildParseApprovalFromTui,
  type ModalTuiSpec,
} from '../../../src/providers/sdk/v1/builders/cli/parse-approval.js';
import type {
  CliScreenSnapshot,
  CliApprovalInput,
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

function input(screenText: string): CliApprovalInput {
  return {
    buffer: screenText,
    screenText,
    rawBuffer: screenText,
    tail: screenText.split('\n').slice(-12).join('\n'),
    screen: emptyScreen(screenText),
    bufferScreen: emptyScreen(screenText),
    tailScreen: emptyScreen(screenText),
  };
}

describe('buildParseApprovalFromTui — codex-cli-style modal', () => {
  const spec: ModalTuiSpec = {
    $schema: 'adhdev:tui/modal@1',
    questionPattern: 'Do you want to (?:proceed|allow|run)',
    buttonPattern: '^[\\s❯>]*\\d+\\.\\s+(.+)$',
    scope: 'between-last-two-separators',
  };
  const parse = buildParseApprovalFromTui(spec);

  it('extracts message + raw button labels from a fully-rendered modal', () => {
    const screen = [
      '⏺ Trying to run a command',
      '────────────────────────────────',
      'Do you want to proceed?',
      '> 1. Yes',
      '  2. No, suggest a different approach',
      '────────────────────────────────',
      '? for shortcuts',
    ].join('\n');
    expect(parse(input(screen))).toEqual({
      message: 'Do you want to proceed?',
      buttons: ['Yes', 'No, suggest a different approach'],
    });
  });

  it('uses an explicit label capture group when selection markers are captured separately', () => {
    const parseWithMarkerGroup = buildParseApprovalFromTui({
      $schema: 'adhdev:tui/modal@1',
      questionPattern: 'This command requires approval',
      buttonPattern: '^\\s*([❯›>]\\s*)?\\d+[.)]\\s+(.+)$',
      buttonLabelGroup: 2,
      scope: 'window-around-question',
    });
    const screen = [
      'Bash(rm -rf /tmp/example)',
      'This command requires approval',
      '❯ 1. Yes, allow once',
      '  2. No, cancel',
    ].join('\n');

    expect(parseWithMarkerGroup(input(screen))).toEqual({
      message: 'This command requires approval',
      buttons: ['Yes, allow once', 'No, cancel'],
    });
  });

  it('returns null when no question is visible', () => {
    const screen = ['Just some prose', 'with no modal at all'].join('\n');
    expect(parse(input(screen))).toBeNull();
  });

  it('returns null when fewer buttons than minButtons (default 2) are present', () => {
    const screen = [
      '────────────────────────────────',
      'Do you want to proceed?',
      '> 1. Only one option here',
      '────────────────────────────────',
    ].join('\n');
    expect(parse(input(screen))).toBeNull();
  });

  it('does NOT misfire on an assistant numbered list above the modal frame', () => {
    // sprint-2026-06 regression: claude/codex parseApproval misfired on
    // numbered lists in assistant prose. between-last-two-separators must
    // scope to only the framed area.
    const screen = [
      '⏺ The status report has three points:',
      '  1. Implementation is on schedule',
      '  2. Tests pass',
      '  3. Documentation pending',
      '──────────────────────────────── ',
      // No modal, just trailing chrome. The earlier numbered list must not
      // be picked up as buttons.
      '? for shortcuts',
    ].join('\n');
    expect(parse(input(screen))).toBeNull();
  });
});

describe('buildParseApprovalFromTui — question keyword inside a button label (cursor-cli)', () => {
  // cursor-cli's questionPattern lists bare keywords (`Trust`, `Approve`,
  // `approve`, `Allow`) that ALSO appear in its button labels. A bottom-up
  // question scan would otherwise land on the BUTTON row and scope the
  // affirmative option out (→ fewer than minButtons → null → the approval
  // never surfaces and the session wedges in `starting`). This is the general
  // form of the kimi defect-C fix. The real cursor spec patterns are used.
  const spec: ModalTuiSpec = {
    $schema: 'adhdev:tui/modal@1',
    questionPattern: 'Run this command|Allow|Do you want to|Do you trust|Trust|approve|Approve|permission',
    questionFlags: 'i',
    // Real cursor spec buttonPattern: matches numbered / bracket-letter options
    // (group 1) AND `→ Label (keyhint)` options like `→ Run (once) (y)` (group 2).
    buttonPattern: '^[\\s│┃|]*(?:[❯›>▶●→]\\s*)?(?:(?:\\d+[.)]|\\[[A-Za-z]\\])\\s+([^│┃|]+?)|(\\S[^│┃|]*?)\\s*\\((?:y|n|tab|shift\\+tab|esc(?:\\s+or\\s+n)?)\\))\\s*[│┃|]?\\s*$',
    buttonLabelGroup: 1,
    buttonFlags: 'm',
    scope: 'window-around-question',
    scopeWindowLines: 20,
  };
  const parse = buildParseApprovalFromTui(spec);

  it('surfaces the Workspace-Trust modal even though the Trust BUTTON label matches the question pattern', () => {
    // Verbatim cursor-agent v2026.07 "Workspace Trust Required" box.
    const screen = [
      '  ╭────────────────╮',
      '  │                                                    │',
      '  │  ⚠ Workspace Trust Required                        │',
      '  │                                                    │',
      '  │  Cursor Agent can execute code and access files.   │',
      '  │                                                    │',
      '  │  Do you trust the contents of this directory?      │',
      '  │                                                    │',
      '  │    /private/tmp/cursor-flip-test                   │',
      '  │                                                    │',
      '  │  ▶ [a] Trust this workspace                        │',
      '  │    [q] Quit                                        │',
      '  │                                                    │',
      '  ╰────────────────╯',
    ].join('\n');

    const modal = parse(input(screen));
    expect(modal).not.toBeNull();
    // The question resolves to the prose line, NOT the "Trust this workspace"
    // button row, so BOTH options survive with the affirmative one first.
    // (message retains the box borders — the point is that it is the prose
    // question line, not a button label.)
    expect(modal!.message).toContain('Do you trust the contents of this directory?');
    expect(modal!.buttons).toEqual(['Trust this workspace', 'Quit']);
  });

  it('surfaces the "Run this command?" git-status approval whose buttons use `→ Label (keyhint)` rows', () => {
    // Verbatim cursor-agent v2026.07 allowlist prompt. The buttons carry NO
    // number / bracket-letter — they are `→ Run (once) (y)` etc. The pre-fix
    // buttonPattern matched none → parseApproval null → session wedged in
    // `generating` forever (Symptom 2). The label may itself contain parens.
    const screen = [
      '  $ git status Waiting for approval...',
      '  ────────────────────────────────────',
      '   $  git status in .',
      '',
      '   Run this command?',
      '   Not in allowlist: git status',
      '    → Run (once) (y)',
      '      Add Shell(git status) to allowlist? (tab)',
      '      Run Everything (shift+tab)',
      '      Skip (esc or n)',
    ].join('\n');
    const modal = parse(input(screen));
    expect(modal).not.toBeNull();
    expect(modal!.buttons).toEqual([
      'Run (once)',
      'Add Shell(git status) to allowlist?',
      'Run Everything',
      'Skip',
    ]);
  });
});

describe('buildParseApprovalFromTui — claude-cli marker group labels', () => {
  const parse = buildParseApprovalFromTui({
    $schema: 'adhdev:tui/modal@1',
    questionPattern: 'Do you want to (?:proceed|allow|run|make this edit|create|overwrite)',
    questionFlags: 'i',
    buttonPattern: '^\\s*([❯›>]\\s*)?\\d+[.)]\\s+(.+)$',
    buttonLabelGroup: 2,
    buttonFlags: 'm',
    scope: 'window-around-question',
    scopeWindowLines: 16,
  });

  it('extracts Bash approval labels without the selected marker', () => {
    const screen = [
      'Bash command',
      'ls /etc',
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. Yes, allow reading from etc/ from this project',
      '  3. No',
    ].join('\n');

    expect(parse(input(screen))).toEqual({
      message: 'Do you want to proceed?',
      buttons: ['Yes', 'Yes, allow reading from etc/ from this project', 'No'],
    });
  });

  it('extracts Write approval labels without the selected marker', () => {
    const screen = [
      'Write(/tmp/adhdev-claude-approval-test.txt)',
      'Create file',
      'Do you want to create adhdev-claude-approval-test.txt?',
      '❯ 1. Yes',
      '  2. Yes, allow all edits in tmp/ during this session (shift+tab)',
      '  3. No',
    ].join('\n');

    expect(parse(input(screen))).toEqual({
      message: 'Do you want to create adhdev-claude-approval-test.txt?',
      buttons: ['Yes', 'Yes, allow all edits in tmp/ during this session (shift+tab)', 'No'],
    });
  });

  it('extracts WebFetch approval labels without the selected marker', () => {
    const screen = [
      'Fetch',
      'Claude wants to fetch content from example.com',
      'Do you want to allow Claude to fetch this content?',
      '❯ 1. Yes',
      "  2. Yes, and don't ask again for example.com",
      '  3. No, and tell Claude what to do differently (esc)',
    ].join('\n');

    expect(parse(input(screen))).toEqual({
      message: 'Do you want to allow Claude to fetch this content?',
      buttons: ['Yes', "Yes, and don't ask again for example.com", 'No, and tell Claude what to do differently (esc)'],
    });
  });
});

describe('buildParseApprovalFromTui — antigravity-style with continuation lines', () => {
  const spec: ModalTuiSpec = {
    $schema: 'adhdev:tui/modal@1',
    questionPattern: 'agy wants to run:',
    buttonPattern: '^[\\s❯>]*\\d+\\.\\s+(.+)$',
    scope: 'window-around-question',
    scopeWindowLines: 20,
    continuationLines: true,
  };
  const parse = buildParseApprovalFromTui(spec);

  it('concatenates wrapped button labels into a single entry', () => {
    const screen = [
      'agy wants to run: bash -c "echo hi"',
      '  1. Yes',
      '  2. Yes, and always allow in this conversation',
      '     for commands matching `echo *`',
      '  3. No, suggest a different approach',
    ].join('\n');
    const result = parse(input(screen));
    expect(result).not.toBeNull();
    expect(result!.buttons).toEqual([
      'Yes',
      'Yes, and always allow in this conversation for commands matching `echo *`',
      'No, suggest a different approach',
    ]);
  });
});
