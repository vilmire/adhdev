/**
 * End-to-end test: load the real adhdev-providers/cli/codex-cli/provider.v1.json
 * and exercise its declarative tui block against the same regression scenarios
 * the v0 detect_status.js + parse_approval.js were hardened against.
 *
 * Three builders are composed:
 *   - buildDetectStatusFromTui (spinner / modal / settled-prompt / dispatchOrder)
 *   - buildParseApprovalFromTui (numbered button modal)
 *   - buildParseApprovalFromSquash (compacted modal fallback)
 *
 * Goal: prove the v1 manifest + builders reproduce codex's production
 * status detection + approval extraction before fixture-record-replay lands.
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
import {
  buildParseApprovalFromSquash,
} from '../../../src/providers/sdk/v1/builders/cli/parse-approval-squash.js';
import type {
  CliScreenSnapshot,
  CliStatusInput,
  CliApprovalInput,
} from '../../../src/providers/sdk/v1/types/cli/index.js';

const MANIFEST_PATH = resolve(
  __dirname,
  '../../../../../../adhdev-providers/cli/codex-cli/provider.v1.json',
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

function getTui(manifest: Record<string, any>): Record<string, any> {
  return manifest.tui ?? manifest.primitives?.tui;
}

describe('codex-cli v1 manifest — declarative builders', () => {
  if (!existsSync(MANIFEST_PATH)) {
    it.skip('manifest not found — skipping', () => undefined);
    return;
  }

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
  const tui = getTui(manifest);
  const detectSpec: DetectStatusTuiSpec = {
    spinner: tui.spinner,
    settledPrompt: tui.settledPrompt,
    modal: tui.modal,
    dispatchOrder: tui.dispatchOrder,
  };
  const detect = buildDetectStatusFromTui(detectSpec);
  const parseModal = buildParseApprovalFromTui(tui.modal);
  const parseSquash = buildParseApprovalFromSquash(tui.approvalSquash);

  // ─── detect_status verdicts ─────────────────────────────────────────────

  it('returns generating when "Working (8m 56s)" is visible', () => {
    const screen = ['⏺ Implementing the new feature', 'Working (8m 56s • esc to interrupt)', '❯ gpt-5-codex high'].join('\n');
    expect(detect(statusInput(screen))).toBe('generating');
  });

  it('returns generating for "Starting MCP servers (8s)"', () => {
    const screen = ['Starting MCP servers (8s)', 'something else'].join('\n');
    expect(detect(statusInput(screen))).toBe('generating');
  });

  it('returns waiting_approval for "Allow Codex to run"', () => {
    const screen = ['codex wants to run: ls', 'Allow Codex to run this command?', '❯ 1. Approve and run', '  2. Deny'].join('\n');
    expect(detect(statusInput(screen))).toBe('waiting_approval');
  });

  it('returns waiting_approval for the current shell escalation prompt', () => {
    const screen = [
      'Would you like to run the following command?',
      '$ curl -I https://example.com',
      '› 1. Yes, proceed (y)',
      "  2. Yes, and don't ask again for commands that start with `curl -I` (p)",
      '  3. No, and tell Codex what to do differently (esc)',
      'Press enter to confirm or esc to cancel',
    ].join('\n');
    expect(detect(statusInput(screen))).toBe('waiting_approval');
  });

  it('returns waiting_approval for "Approaching rate limits" + switch suggestion', () => {
    const screen = ['Approaching rate limits', 'Switch to gpt-4o for lower credit usage', '❯ 1. Approve and run', '  2. Deny'].join('\n');
    expect(detect(statusInput(screen))).toBe('waiting_approval');
  });

  it('respects modal-first dispatch order: modal beats spinner', () => {
    const screen = ['Working (5s • esc to interrupt) earlier', 'Allow command?', '❯ 1. Approve and run', '  2. Deny'].join('\n');
    expect(detect(statusInput(screen))).toBe('waiting_approval');
  });

  it('returns idle when settled prompt + "tab to queue message" is visible', () => {
    const screen = ['Earlier reply', '❯ gpt-5-codex high', '? for shortcuts', 'tab to queue message', '❯'].join('\n');
    expect(detect(statusInput(screen))).toBe('idle');
  });

  // ─── parse_approval (regular modal) ─────────────────────────────────────

  it('extracts a numbered approval modal (normal rendering)', () => {
    const screen = [
      '────────────────────────────────',
      'Allow command?',
      '❯ 1. Approve and run',
      '  2. Deny',
      '────────────────────────────────',
    ].join('\n');
    const result = parseModal(approvalInput(screen));
    expect(result?.message).toMatch(/Allow command/i);
    expect(result?.buttons).toEqual(['Approve and run', 'Deny']);
  });

  it('extracts current shell approval labels without the selection pointer', () => {
    const screen = [
      'Would you like to run the following command?',
      '$ curl -I https://example.com',
      '› 1. Yes, proceed (y)',
      "  2. Yes, and don't ask again for commands that start with `curl -I` (p)",
      '  3. No, and tell Codex what to do differently (esc)',
      'Press enter to confirm or esc to cancel',
    ].join('\n');
    const result = parseModal(approvalInput(screen));
    expect(result?.message).toBe('Would you like to run the following command?');
    expect(result?.buttons).toEqual([
      'Yes, proceed (y)',
      "Yes, and don't ask again for commands that start with `curl -I` (p)",
      'No, and tell Codex what to do differently (esc)',
    ]);
  });

  // ─── parse_approval-squash (compacted rendering) ────────────────────────

  it('recovers the trust-folder modal from a fully compacted single-line blob', () => {
    const compactedBlob = 'doyoutrustthecontentsofthisdirectory1yescontinue2noquitpressentertocontinueesctocancel';
    const result = parseSquash(approvalInput(compactedBlob));
    expect(result?.message).toBe('Do you trust the contents of this directory?');
    expect(result?.buttons).toEqual(['Yes, continue', 'No, quit']);
  });

  it('recovers the rate-limit modal from a compacted blob', () => {
    const blob = [
      'Approaching rate limits',
      'Switch to gpt-4o for lower credit usage',
      '1. Approve and run',
      '2. Deny',
      'Press Enter to continue',
    ].join('\n');
    const result = parseSquash(approvalInput(blob));
    expect(result?.buttons).toEqual(['Approve and run', 'Deny']);
  });

  it('returns null from squash when only a regular modal is present (no compact match)', () => {
    const screen = ['Do you want to proceed?', '❯ 1. Yes, run it', '  2. Cancel'].join('\n');
    expect(parseSquash(approvalInput(screen))).toBeNull();
  });
});
