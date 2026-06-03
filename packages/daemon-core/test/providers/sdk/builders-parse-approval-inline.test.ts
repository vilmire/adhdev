/**
 * Tests for the inlineButtonPattern fallback in buildParseApprovalFromTui.
 *
 * Per-line button extraction is the primary path. When that returns fewer
 * than minButtons options, the builder makes a second pass with
 * `inlineButtonPattern` so providers whose terminal puts every option on
 * one line (Antigravity feedback survey) still work.
 */

import { describe, expect, it } from 'vitest';
import {
  buildParseApprovalFromTui,
  type ModalTuiSpec,
} from '../../../src/providers/sdk/v1/builders/cli/parse-approval.js';
import type {
  CliApprovalInput,
  CliScreenSnapshot,
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

function approvalInput(screenText: string): CliApprovalInput {
  return {
    buffer: screenText,
    screenText,
    rawBuffer: screenText,
    tail: screenText,
    screen: emptyScreen(screenText),
    bufferScreen: emptyScreen(screenText),
    tailScreen: emptyScreen(screenText),
  };
}

const spec: ModalTuiSpec = {
  $schema: 'adhdev:tui/modal@1',
  questionPattern: 'How\'s the CLI experience',
  questionFlags: 'i',
  buttonPattern: '^>?\\s*\\d+\\.\\s+(.+)$',
  buttonFlags: 'm',
  inlineButtonPattern: '\\[\\d+\\]\\s+([^\\[]+?)(?=\\s+\\[\\d+\\]|$)',
  inlineButtonFlags: 'gi',
  scope: 'window-around-question',
  scopeWindowLines: 8,
  minButtons: 2,
};

describe('inline button fallback', () => {
  const parse = buildParseApprovalFromTui(spec);

  it('extracts 4 inline-bracket options on one line', () => {
    const screen = [
      "How's the CLI experience so far?",
      '[0] skip [1] yes [2] no [3] still using',
    ].join('\n');
    const r = parse(approvalInput(screen));
    expect(r?.buttons).toEqual(['skip', 'yes', 'no', 'still using']);
  });

  it('still extracts per-line options first when both are available', () => {
    const perLineSpec: ModalTuiSpec = { ...spec, inlineButtonPattern: '\\[\\d+\\]\\s+([^\\[]+?)(?=\\s+\\[\\d+\\]|$)' };
    const screen = [
      "How's the CLI experience so far?",
      '1. yes',
      '2. no',
      '[X] inline-fallback-should-not-fire-here',
    ].join('\n');
    const r = buildParseApprovalFromTui(perLineSpec)(approvalInput(screen));
    expect(r?.buttons).toEqual(['yes', 'no']);
  });

  it('forces the g flag even if the author omitted it', () => {
    const noGFlag: ModalTuiSpec = { ...spec, inlineButtonFlags: 'i' };
    const screen = [
      "How's the CLI experience so far?",
      '[0] alpha [1] beta [2] gamma',
    ].join('\n');
    const r = buildParseApprovalFromTui(noGFlag)(approvalInput(screen));
    expect(r?.buttons).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('returns null when neither per-line nor inline extraction yields minButtons', () => {
    const screen = [
      "How's the CLI experience so far?",
      '[0] only-one-option',
    ].join('\n');
    expect(parse(approvalInput(screen))).toBeNull();
  });
});
