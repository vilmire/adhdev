/**
 * End-to-end test: load adhdev-providers/cli/antigravity-cli/provider.v1.json
 * and exercise its declarative tui block against the same regression
 * scenarios the v0 detect_status.js + parse_approval.js were hardened
 * against.
 *
 * Antigravity is the first production provider migrated to declarative-only
 * (no overrides). If anything in this file fails after a refactor, the
 * migration has regressed — investigate before relaxing assertions.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildDetectStatusFromTui,
  type DetectStatusTuiSpec,
} from '../../../src/providers/sdk/v1/builders/cli/detect-status.js';
import {
  buildParseApprovalFromTui,
} from '../../../src/providers/sdk/v1/builders/cli/parse-approval.js';
import type {
  CliScreenSnapshot,
  CliStatusInput,
  CliApprovalInput,
} from '../../../src/providers/sdk/v1/types/cli/index.js';

const MANIFEST_PATH = resolve(
  __dirname,
  '../../../../../../adhdev-providers/cli/antigravity-cli/provider.v1.json',
);

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
    tail: screenText.split('\n').slice(-12).join('\n'),
    screenText,
    rawBuffer: screenText,
    isWaitingForResponse: false,
    screen: emptyScreen(screenText),
    tailScreen: emptyScreen(screenText.split('\n').slice(-12).join('\n')),
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

describe('antigravity-cli v1 manifest — declarative-only', () => {
  if (!existsSync(MANIFEST_PATH)) {
    it.skip('manifest not found — skipping', () => undefined);
    return;
  }

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));

  it('does NOT declare any overrides — this is a declarative-only provider', () => {
    expect(manifest.overrides).toBeUndefined();
  });

  const detectSpec: DetectStatusTuiSpec = {
    spinner: manifest.tui.spinner,
    settledPrompt: manifest.tui.settledPrompt,
    modal: manifest.tui.modal,
    dispatchOrder: manifest.tui.dispatchOrder,
  };
  const detect = buildDetectStatusFromTui(detectSpec);
  const parseModal = buildParseApprovalFromTui(manifest.tui.modal);

  // ─── detect_status ─────────────────────────────────────────────────────

  it('returns generating when "Using Tool" is in the live frame', () => {
    const screen = ['Using Tool: Bash', 'some output'].join('\n');
    expect(detect(statusInput(screen))).toBe('generating');
  });

  it('returns generating when "Thinking" cue is on screen', () => {
    const screen = ['Thinking…', 'more text'].join('\n');
    expect(detect(statusInput(screen))).toBe('generating');
  });

  it('returns generating when braille spinner is in the last 8 lines', () => {
    const screen = Array(4).fill('previous prose').concat(['⣟ Reading file…', 'a', 'b']).join('\n');
    expect(detect(statusInput(screen))).toBe('generating');
  });

  it('returns idle when settled prompt + "? for shortcuts" footer is visible', () => {
    const screen = ['Previous answer here', '>', '? for shortcuts'].join('\n');
    expect(detect(statusInput(screen))).toBe('idle');
  });

  it('returns waiting_approval when "Do you want to proceed?" + buttons are on screen (modal-first dispatch)', () => {
    const screen = [
      'agy wants to run: ls -la /tmp',
      'Do you want to proceed?',
      '> 1. Yes, allow once',
      '  2. No, cancel',
    ].join('\n');
    expect(detect(statusInput(screen))).toBe('waiting_approval');
  });

  // ─── parse_approval — numbered options + context header ────────────────

  it('extracts a numbered modal with the agy-wants-to-run context header', () => {
    const screen = [
      'agy wants to run: rm -rf /tmp/cache',
      'Do you want to proceed?',
      '> 1. Yes, allow once',
      '  2. No, cancel',
      '  3. Yes, and always allow',
    ].join('\n');
    const result = parseModal(approvalInput(screen));
    expect(result?.buttons).toEqual(['Yes, allow once', 'No, cancel', 'Yes, and always allow']);
    expect(result?.message).toMatch(/Do you want to proceed/i);
    expect(result?.message).toMatch(/rm -rf \/tmp\/cache/);
  });

  // ─── parse_approval — inline-bracket options (Antigravity-specific) ─────

  it('extracts INLINE bracket options when no per-line buttons exist (feedback survey)', () => {
    const screen = [
      'Do you trust the files in this folder?',
      '[0] skip [1] yes [2] no [3] still using',
    ].join('\n');
    const result = parseModal(approvalInput(screen));
    expect(result?.buttons).toEqual(['skip', 'yes', 'no', 'still using']);
  });

  it('does NOT misclassify an assistant numbered list ending in "?" as a modal', () => {
    // The v0 buildGenericApproval was explicitly removed for this exact case.
    // The v1 manifest declares only specific headerMatchers, so an arbitrary
    // "?" line never matches.
    const screen = [
      'Here is the plan:',
      '1. Read the file',
      '2. Edit it',
      '3. Save?',
      '>',
    ].join('\n');
    expect(parseModal(approvalInput(screen))).toBeNull();
  });

  it('trust-folder modal returns the correct buttons', () => {
    const screen = [
      'Do you trust the files in this folder?',
      '> 1. Yes',
      '  2. No',
    ].join('\n');
    const result = parseModal(approvalInput(screen));
    expect(result?.message).toMatch(/Do you trust the files/i);
    expect(result?.buttons).toEqual(['Yes', 'No']);
  });
});
