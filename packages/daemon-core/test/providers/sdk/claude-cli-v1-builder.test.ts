/**
 * End-to-end test: load the real adhdev-providers/cli/claude-cli/provider.v1.json
 * and exercise its declarative tui block against the same regression scenarios
 * the v0 detect_status.js was hardened against.
 *
 * Goal: prove the v1 manifest + builder chain reproduces production behaviour
 * before fixture-record-replay is wired up.
 *
 * Scope: status detection only. Modal extraction (parseApproval) is exercised
 * separately in builders-parse-approval.test.ts; this file only checks
 * detectStatus's three-way verdict (generating / waiting_approval / idle / null).
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
  type ModalTuiSpec,
} from '../../../src/providers/sdk/v1/builders/cli/parse-approval.js';
import type {
  CliScreenSnapshot,
  CliApprovalInput,
  CliStatusInput,
} from '../../../src/providers/sdk/v1/types/cli/index.js';

const MANIFEST_PATH = resolve(
  __dirname,
  '../../../../../../adhdev-providers/cli/claude-cli/provider.v1.json',
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
    tail: screenText.split('\n').slice(-12).join('\n'),
    screen: emptyScreen(screenText),
    bufferScreen: emptyScreen(screenText),
    tailScreen: emptyScreen(screenText),
  };
}

describe('claude-cli v1 manifest — declarative detect_status', () => {
  if (!existsSync(MANIFEST_PATH)) {
    it.skip('manifest not found — skipping', () => undefined);
    return;
  }

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
  const spec: DetectStatusTuiSpec = {
    spinner: manifest.tui.spinner,
    settledPrompt: manifest.tui.settledPrompt,
    modal: manifest.tui.modal,
  };
  const detect = buildDetectStatusFromTui(spec);
  const parseApproval = buildParseApprovalFromTui(manifest.tui.modal as ModalTuiSpec);

  it('returns generating when braille spinner is in the live frame', () => {
    const screen = ['⣟ Thinking...', 'esc to interrupt'].join('\n');
    expect(detect(statusInput(screen))).toBe('generating');
  });

  it('returns generating when "Claude is thinking" is visible', () => {
    const screen = ['⏺ Implementing X', '', 'Claude is thinking'].join('\n');
    expect(detect(statusInput(screen))).toBe('generating');
  });

  it('returns generating for the playful spinner verbs (Flummoxing/Finagling)', () => {
    const screen = ['Flummoxing the parser…'].join('\n');
    expect(detect(statusInput(screen))).toBe('generating');
  });

  it('returns generating when "esc to cancel/interrupt/stop" footer is shown', () => {
    const screen = ['some prose', 'esc to interrupt'].join('\n');
    expect(detect(statusInput(screen))).toBe('generating');
  });

  it('returns waiting_approval when "This command requires approval" is visible', () => {
    const screen = [
      '⏺ Bash(ls -la /tmp)',
      'This command requires approval',
      '❯ 1. Yes',
      '  2. No',
      '  3. Always allow',
    ].join('\n');
    expect(detect(statusInput(screen))).toBe('waiting_approval');
  });

  it('extracts Claude approval labels from the provider-declared label capture group', () => {
    const screen = [
      '⏺ Bash(rm -rf /tmp/example)',
      'This command requires approval',
      '❯ 1. Yes, allow once',
      '  2. Yes, and always allow',
      '  3. No, cancel',
    ].join('\n');

    expect(parseApproval(approvalInput(screen))).toEqual({
      message: 'This command requires approval',
      buttons: ['Yes, allow once', 'Yes, and always allow', 'No, cancel'],
    });
  });

  it('returns waiting_approval for "Do you want to proceed?"', () => {
    const screen = [
      'agy wants to make this edit',
      'Do you want to proceed?',
      '❯ 1. Yes, allow once',
      '  2. No, cancel',
    ].join('\n');
    expect(detect(statusInput(screen))).toBe('waiting_approval');
  });

  it('returns waiting_approval for trust-folder modal (Quick safety check)', () => {
    const screen = [
      'Quick safety check',
      'Is this a project you trust?',
      '❯ 1. Yes, I trust this folder',
      '  2. No, exit',
    ].join('\n');
    expect(detect(statusInput(screen))).toBe('waiting_approval');
  });

  it('returns waiting_approval for MCP server install prompt', () => {
    const screen = [
      'New MCP server found in this project',
      '❯ 1. Use this mcp server',
      '  2. Skip',
    ].join('\n');
    expect(detect(statusInput(screen))).toBe('waiting_approval');
  });

  it('returns waiting_approval for Settings Warning variant', () => {
    const screen = [
      'Settings Warning',
      'Enter to confirm',
      '❯ 1. Continue',
      '  2. Cancel',
    ].join('\n');
    expect(detect(statusInput(screen))).toBe('waiting_approval');
  });

  it('returns waiting_approval for (y/n) fallback variant', () => {
    const screen = ['Are you sure? (y/n)'].join('\n');
    expect(detect(statusInput(screen))).toBe('waiting_approval');
  });

  it('returns idle when settled prompt + "? for shortcuts" footer is visible', () => {
    const screen = [
      'Previous turn output',
      '',
      '❯',
      '? for shortcuts',
    ].join('\n');
    expect(detect(statusInput(screen))).toBe('idle');
  });

  it('respects dispatch order: spinner wins over settled prompt', () => {
    // sprint-2026-06 regression — claude footer kept "❯ ? for shortcuts" visible
    // while a spinner was still running. Builder must return generating.
    const screen = [
      '⣟ Thinking...',
      '? for shortcuts',
      '❯',
    ].join('\n');
    expect(detect(statusInput(screen))).toBe('generating');
  });

  it('respects dispatch order: modal wins over settled prompt', () => {
    const screen = [
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No',
      '? for shortcuts',
      '❯',
    ].join('\n');
    expect(detect(statusInput(screen))).toBe('waiting_approval');
  });

  it('returns null on a blank/unknown screen (caller falls back to its own policy)', () => {
    expect(detect(statusInput('totally unrelated output\nnothing matches'))).toBe(null);
  });
});
