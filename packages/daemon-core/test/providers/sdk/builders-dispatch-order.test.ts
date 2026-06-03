/**
 * dispatch-order primitive — wiring through buildDetectStatusFromTui.
 *
 * The default order is `spinner → modal → settled-prompt`. Providers can
 * override per-manifest. Claude needs `modal → spinner → settled-prompt` so
 * that approval modals shown while a spinner is still in the buffer (assistant
 * text mentioning "Thinking" above the actual modal frame) still resolve to
 * waiting_approval rather than generating.
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
    tail: screenText.split('\n').slice(-12).join('\n'),
    screenText,
    rawBuffer: screenText,
    isWaitingForResponse: false,
    screen: emptyScreen(screenText),
    tailScreen: emptyScreen(screenText.split('\n').slice(-12).join('\n')),
  };
}

const baseSpec: DetectStatusTuiSpec = {
  spinner: {
    $schema: 'adhdev:tui/spinner@1',
    patterns: [{ regex: 'Thinking', flags: 'i' }],
    scope: 'whole-screen',
  },
  settledPrompt: {
    $schema: 'adhdev:tui/settled-prompt@1',
    regex: '^❯\\s*$',
    flags: 'm',
  },
  modal: {
    $schema: 'adhdev:tui/modal@1',
    questionPattern: 'Do you want to proceed\\?',
    buttonPattern: '^\\d+\\.\\s+(.+)$',
  },
};

const screen = [
  'Thinking… some prose from earlier',
  'Do you want to proceed?',
  '1. Yes',
  '2. No',
  '❯',
].join('\n');

describe('dispatch-order builder wiring', () => {
  it('default order returns generating when spinner cue is anywhere on screen', () => {
    const detect = buildDetectStatusFromTui(baseSpec);
    expect(detect(statusInput(screen))).toBe('generating');
  });

  it('modal-first order returns waiting_approval when both cues match', () => {
    const detect = buildDetectStatusFromTui({
      ...baseSpec,
      dispatchOrder: {
        $schema: 'adhdev:tui/dispatch-order@1',
        order: ['modal', 'spinner', 'settled-prompt'],
      },
    });
    expect(detect(statusInput(screen))).toBe('waiting_approval');
  });

  it('settled-prompt-first order still returns idle when prompt is at the bottom', () => {
    const detect = buildDetectStatusFromTui({
      ...baseSpec,
      dispatchOrder: {
        $schema: 'adhdev:tui/dispatch-order@1',
        order: ['settled-prompt', 'spinner', 'modal'],
      },
    });
    expect(detect(statusInput(screen))).toBe('idle');
  });

  it('declaring an unimplemented group (cue-ordering) is a no-op, not an error', () => {
    const detect = buildDetectStatusFromTui({
      ...baseSpec,
      dispatchOrder: {
        $schema: 'adhdev:tui/dispatch-order@1',
        order: ['cue-ordering', 'modal', 'spinner', 'settled-prompt'],
      },
    });
    // cue-ordering returns null, falls through to modal → waiting_approval.
    expect(detect(statusInput(screen))).toBe('waiting_approval');
  });

  it('empty order array falls back to the default order', () => {
    const detect = buildDetectStatusFromTui({
      ...baseSpec,
      dispatchOrder: {
        $schema: 'adhdev:tui/dispatch-order@1',
        order: [],
      },
    });
    expect(detect(statusInput(screen))).toBe('generating');
  });

  it('returns null when none of the groups in the order match', () => {
    const detect = buildDetectStatusFromTui({
      ...baseSpec,
      dispatchOrder: {
        $schema: 'adhdev:tui/dispatch-order@1',
        order: ['modal', 'settled-prompt'],
      },
    });
    expect(detect(statusInput('nothing matches at all\nnope'))).toBe(null);
  });
});
