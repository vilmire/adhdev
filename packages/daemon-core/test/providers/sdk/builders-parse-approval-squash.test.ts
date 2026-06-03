/**
 * approval-squash builder — exercised against the real codex-cli regression
 * shapes: trust-folder modal collapsed into a single-line compact run.
 */

import { describe, expect, it } from 'vitest';
import {
  buildParseApprovalFromSquash,
  compactText,
  type ApprovalSquashSpec,
} from '../../../src/providers/sdk/v1/builders/cli/parse-approval-squash.js';
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
    tail: screenText.split('\n').slice(-24).join('\n'),
    screen: emptyScreen(screenText),
    bufferScreen: emptyScreen(screenText),
    tailScreen: emptyScreen(screenText.split('\n').slice(-24).join('\n')),
  };
}

const codexSquashSpec: ApprovalSquashSpec = {
  $schema: 'adhdev:tui/approval-squash@1',
  cues: [
    { compact: 'doyoutrustthecontentsofthisdirectory', label: 'trust-folder', messageWhenMatched: 'Do you trust the contents of this directory?' },
    { compact: 'workingwithuntrustedcontents',          label: 'untrusted-content', messageWhenMatched: 'Working with untrusted contents' },
    { compact: 'switchtogpt',                            kind: 'regex', label: 'rate-limit', messageWhenMatched: 'Approaching rate limits' },
  ],
  footers: [
    { compact: 'pressentertocontinue' },
    { compact: 'esctocancel' },
  ],
  buttonRules: [
    { compact: '1yescontinue2noquit',         labels: ['Yes, continue', 'No, quit'] },
    { compact: '1approveandrun2deny',         labels: ['Approve and run', 'Deny'] },
    { compact: '1alwaysapprove2approve3deny', labels: ['Always approve', 'Approve', 'Deny'] },
  ],
  scope: 'tail-window',
  tailWindowLines: 24,
};

describe('approval-squash builder — codex trust modal', () => {
  const parse = buildParseApprovalFromSquash(codexSquashSpec);

  it('parses the canonical squashed trust-folder modal', () => {
    const screen = [
      'OpenAI Codex',
      'Do you trust the contents of this directory?',
      '1. Yes, continue',
      '2. No, quit',
      'Press Enter to continue · Esc to cancel',
    ].join('\n');
    const result = parse(approvalInput(screen));
    expect(result).not.toBeNull();
    expect(result?.message).toBe('Do you trust the contents of this directory?');
    expect(result?.buttons).toEqual(['Yes, continue', 'No, quit']);
  });

  it('parses even when the terminal has fully collapsed the modal into one line', () => {
    // No newlines, no whitespace between cue and buttons — compactText still
    // sees the same byte sequence, and the rule fires.
    const compactedLine = 'doyoutrustthecontentsofthisdirectory1yescontinue2noquitpressentertocontinueesctocancel';
    const result = parse(approvalInput(compactedLine));
    expect(result?.buttons).toEqual(['Yes, continue', 'No, quit']);
    expect(result?.message).toBe('Do you trust the contents of this directory?');
  });

  it('returns null when the cue is present but no button rule matches', () => {
    const screen = [
      'Do you trust the contents of this directory?',
      // Buttons are not in our rule table → null
      '1. Run anyway',
      '2. Bail',
      'Press Enter to continue',
    ].join('\n');
    expect(parse(approvalInput(screen))).toBeNull();
  });

  it('returns null when the footer is missing (declared but absent)', () => {
    const screen = [
      'Do you trust the contents of this directory?',
      '1. Yes, continue',
      '2. No, quit',
      // No "Press Enter to continue" / "Esc to cancel"
    ].join('\n');
    expect(parse(approvalInput(screen))).toBeNull();
  });

  it('returns null when no cue matches', () => {
    const screen = 'totally unrelated assistant prose with no modal cues';
    expect(parse(approvalInput(screen))).toBeNull();
  });

  it('honours the rate-limit cue (regex variant)', () => {
    const screen = [
      'Approaching rate limits',
      'Switch to gpt-4o for lower credit usage',
      '1. Approve and run',
      '2. Deny',
      'Press Enter to continue',
    ].join('\n');
    const result = parse(approvalInput(screen));
    expect(result?.message).toBe('Approaching rate limits');
    expect(result?.buttons).toEqual(['Approve and run', 'Deny']);
  });
});

describe('compactText', () => {
  it('preserves byte order across whitespace and punctuation', () => {
    expect(compactText('Do you TRUST the contents of this directory?')).toBe(
      'doyoutrustthecontentsofthisdirectory',
    );
    expect(compactText('1.\n  Yes, continue')).toBe('1yescontinue');
  });

  it('returns empty for empty/null input', () => {
    expect(compactText('')).toBe('');
    expect(compactText(undefined as unknown as string)).toBe('');
  });
});

describe('approval-squash spec validation', () => {
  it('throws when cues array is empty', () => {
    expect(() => buildParseApprovalFromSquash({
      $schema: 'adhdev:tui/approval-squash@1',
      cues: [],
      buttonRules: [{ compact: '1y2n', labels: ['Y', 'N'] }],
    } as ApprovalSquashSpec)).toThrow(/at least one cue/);
  });

  it('throws when buttonRules array is empty', () => {
    expect(() => buildParseApprovalFromSquash({
      $schema: 'adhdev:tui/approval-squash@1',
      cues: [{ compact: 'x' }],
      buttonRules: [],
    } as ApprovalSquashSpec)).toThrow(/at least one button rule/);
  });
});
