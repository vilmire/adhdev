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
