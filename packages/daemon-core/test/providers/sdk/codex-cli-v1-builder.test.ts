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

  // ─── mid-tool-call idle valley (mission f2f6da1b root fix) ───────────────
  // codex's live spinner ("Working (Ns • esc to interrupt)") scrolls UP out of
  // the bottom visible rows while a tool call's output renders, so the OLD
  // live-frame-tail spinner scope (bottom 12 lines) momentarily missed it and the
  // settled-prompt regex (^[❯›>]$) fired a FALSE idle — the codex early-completion
  // valley. The spinner scope is now whole-screen, so the pushed-up spinner header
  // is still detected and the turn correctly stays `generating`. The patterns were
  // simultaneously tightened (glyph/digit after "Working (", bulleted "…esc to
  // interrupt)" footer) so a whole-screen scan does NOT match assistant prose that
  // merely says "Working" or "esc to interrupt".
  //
  // A 40-row grid: spinner header on line 2, then tool output, and a bare prompt
  // char in the LAST 12 lines (what tricked the old tail scope into reading idle).
  function valleyScreen(spinnerHeader: string): string {
    const toolOutput = Array.from({ length: 20 }, (_, i) => `  read package.json → line ${i + 1}`);
    return [
      '⏺ Reading the repo-root package.json',
      spinnerHeader,
      ...toolOutput,
      '❯ gpt-5-codex high',
      '  gpt-5-codex low · ~/repo · 019f9177-abcd',
    ].join('\n');
  }

  it('mid-tool-call VALLEY: stays generating when the spinner scrolled above the bottom rows (Working timer)', () => {
    expect(detect(statusInput(valleyScreen('Working (18s • esc to interrupt)')))).toBe('generating');
  });

  it('regression guard: the SAME valley frame WOULD misdetect under a bottom-rows-only scope (proves the scope fix is load-bearing)', () => {
    // Rebuild the detector with the OLD live-frame-tail scope; the pushed-up spinner
    // is outside the bottom rows so it is NOT seen and the frame reads NOT generating
    // (the exact codex early-completion valley). This asserts the fixture is a genuine
    // valley and that scope: whole-screen is what closes it — so a future edit that
    // narrows the scope back re-breaks this test.
    const oldScopeDetect = buildDetectStatusFromTui({
      spinner: { ...(tui.spinner as any), scope: 'live-frame-tail', scopeWindowLines: 12 },
      settledPrompt: tui.settledPrompt,
      modal: tui.modal,
      dispatchOrder: tui.dispatchOrder,
    });
    expect(oldScopeDetect(statusInput(valleyScreen('Working (18s • esc to interrupt)')))).not.toBe('generating');
  });

  it('mid-tool-call VALLEY: stays generating for the braille-glyph spinner header (Thinking)', () => {
    expect(detect(statusInput(valleyScreen('  Thinking (⣿ 4s • esc to interrupt)')))).toBe('generating');
  });

  it('mid-tool-call VALLEY: stays generating for "Starting MCP servers (" pushed up', () => {
    expect(detect(statusInput(valleyScreen('Starting MCP servers (3s • esc to interrupt)')))).toBe('generating');
  });

  it('genuine turn-end: settles to idle once the spinner is gone from the whole grid', () => {
    const screen = [
      '⏺ The "name" field is "adhdev-cloud-monorepo".',
      ...Array.from({ length: 16 }, (_, i) => `  (prior tool output ${i + 1})`),
      '❯ gpt-5-codex high',
      '? for shortcuts',
      'tab to queue message',
      '❯',
    ].join('\n');
    expect(detect(statusInput(screen))).toBe('idle');
  });

  it('no false-generating: an assistant answer that mentions the spinner words stays idle', () => {
    // The tightened patterns must not fire on prose. Both cues appear as plain text
    // in the final answer, but neither is the live spinner (no glyph/digit after
    // "Working (", no bulleted "…esc to interrupt)" footer).
    const screen = [
      '⏺ Working on it is done. To stop codex mid-turn, press esc to interrupt the run.',
      ...Array.from({ length: 12 }, (_, i) => `  detail ${i + 1}`),
      '❯ gpt-5-codex high',
      '? for shortcuts',
      'tab to queue message',
      '❯',
    ].join('\n');
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

  it('extracts wrapped shell escalation labels from the label capture group', () => {
    const screen = [
      'Would you like to run the following command?',
      'Reason: The patched standalone is listening on 127.0.0.1:3848 but sandbox curl cannot connect;',
      'allow reading the local smoke-test status outside the sandbox?',
      '$ curl -sS http://127.0.0.1:3848/api/v1/status | node -e "let',
      '  s=\'\';process.stdin.on(\'data\',d=>s+=d);process.stdin.on(\'end\',()=>{const',
      '  j=JSON.parse(s);console.log(JSON.stringify(j.sessions?.[0]?.activeModal));})"',
      '› 1. Yes, proceed (y)',
      '  2. Yes, and don\'t ask again for commands that start with `node -e "let',
      '     s=\'\';process.stdin.on(\'data\',d=>s+=d);process.stdin.on(\'end\',()=>{const',
      '     j=JSON.parse(s);console.log(JSON.stringify(j.sessions?.[0]?.activeModal));})"` (p)',
      '  3. No, and tell Codex what to do differently (esc)',
      'Press enter to confirm or esc to cancel',
    ].join('\n');
    const result = parseModal(approvalInput(screen));
    expect(result?.message).toBe('Would you like to run the following command?');
    expect(result?.buttons).toEqual([
      'Yes, proceed (y)',
      'Yes, and don\'t ask again for commands that start with `node -e "let s=\'\';process.stdin.on(\'data\',d=>s+=d);process.stdin.on(\'end\',()=>{const j=JSON.parse(s);console.log(JSON.stringify(j.sessions?.[0]?.activeModal));})"` (p)',
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
