/**
 * APPROVAL-PICKER-MISROUTE (mission f1d25e11) regression: a claude-cli
 * AskUserQuestion multi-choice picker must NOT be classified as an approval
 * modal. Its numbered option rows ("❯ 1. label") can otherwise satisfy the
 * approval button cue and get surfaced to the coordinator as
 * task_approval_needed (→ mesh_approve, which cannot answer a question). Both
 * the status detector (modalMatches → waiting_approval) and the button parser
 * (buildParseApprovalFromTui) must yield on the picker signature so the screen
 * is surfaced only as waiting_choice.
 */

import { describe, expect, it } from 'vitest';
import {
  buildDetectStatusFromTui,
  isAskUserQuestionPickerSignature,
  type DetectStatusTuiSpec,
} from '../../../src/providers/sdk/v1/builders/cli/detect-status.js';
import {
  buildParseApprovalFromTui,
  type ModalTuiSpec,
} from '../../../src/providers/sdk/v1/builders/cli/parse-approval.js';
import type {
  CliScreenSnapshot,
  CliStatusInput,
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

// A claude-cli AskUserQuestion picker: numbered option rows (whose "❯ N. label"
// shape and Yes/No-ish labels can trip an approval button matcher), the
// claude TUI select footer, AND the freeform escape hatch. This is the exact
// signature the guard keys on.
const QUESTION_SCREEN = [
  '  Scope',
  '  Which scope should I use?',
  '',
  '  ❯ 1. Yes, unicast',
  '    2. No, broadcast',
  '    3. Type something',
  '    4. Chat about this',
  '',
  '  Enter to select · Esc to cancel',
].join('\n');

// The RCA case (mission fb2a7053): the SAME picker, but WITHOUT the freeform
// escape-hatch rows ("Type something" / "Chat about this") — they can be absent
// or scrolled out of the captured frame. Only the select footer + numbered
// options remain. The guard must STILL recognise this as a picker even though
// the escape hatch is gone.
const QUESTION_SCREEN_NO_HATCH = [
  '  Scope',
  '  Which scope should I use?',
  '',
  '  ❯ 1. Yes, unicast',
  '    2. No, broadcast',
  '',
  '  Enter to select · Esc to cancel',
].join('\n');

// The rc.19 LIVE screen: current claude-cli renders the picker footer as
// "Enter to select · ↑/↓ to navigate" — the "Esc to cancel" half of the old
// footer pair is GONE. The picker rows here use Continue/Abort labels, whose
// affirmative/negative-ish verbs make the approval misroute concrete (the live
// mesh_approve call selected "Continue").
const QUESTION_SCREEN_RC19_FOOTER = [
  '  ☐ Canary gate',
  '',
  '  ❯ 1. Continue',
  '    2. Abort',
  '    3. Type something.',
  '    4. Chat about this',
  '',
  '  Enter to select · ↑/↓ to navigate',
].join('\n');

// A genuine tool-consent approval modal — no picker footer, no freeform hatch.
const APPROVAL_SCREEN = [
  '  Do you want to proceed?',
  '  ❯ 1. Yes',
  '    2. No',
].join('\n');

// The same genuine approval with the exact claude v2.1.84 footer
// ("Esc to cancel · Tab to amend · ctrl+e to explain") — proves dropping the
// Esc-half from the picker signature does not misread a real consent as a picker.
const APPROVAL_SCREEN_REALISTIC_FOOTER = [
  '  Bash command',
  '',
  '  npm test',
  '  Run shell command',
  '',
  '  Do you want to proceed?',
  '  ❯ 1. Yes',
  '    2. Yes, and don\'t ask again for: npm test',
  '    3. No',
  '',
  '  Esc to cancel · Tab to amend · ctrl+e to explain',
].join('\n');

// A modal spec loose enough that WITHOUT the guard the picker's rows would match
// as an approval (the button cue anchors on affirmative+decline verbs).
const spec: ModalTuiSpec & DetectStatusTuiSpec['modal'] = {
  $schema: 'adhdev:tui/modal@1',
  questionPattern: 'Do you want to (?:proceed|allow|run)|Which scope',
  questionVariants: [{ regex: 'scope should I use', flags: 'i' }],
  buttonPattern: '^[\\s❯>]*\\d+\\.\\s+(.+)$',
  scope: 'whole-screen',
};

describe('AskUserQuestion picker is not an approval (mission f1d25e11)', () => {
  it('isAskUserQuestionPickerSignature recognises the picker signature and rejects a plain approval', () => {
    expect(isAskUserQuestionPickerSignature(QUESTION_SCREEN)).toBe(true);
    // Case (1): the RCA regression — a picker with NO freeform escape hatch is
    // still recognised (footer + numbered options are sufficient).
    expect(isAskUserQuestionPickerSignature(QUESTION_SCREEN_NO_HATCH)).toBe(true);
    // Case (2): a genuine approval modal (Yes/No, no picker footer) is NOT a picker.
    expect(isAskUserQuestionPickerSignature(APPROVAL_SCREEN)).toBe(false);
    // Case (3): the rc.19 footer ("Enter to select · ↑/↓ to navigate", NO
    // "Esc to cancel") is still recognised as a picker.
    expect(isAskUserQuestionPickerSignature(QUESTION_SCREEN_RC19_FOOTER)).toBe(true);
    // Select footer alone (no numbered option rows) is not enough to call it a
    // picker — guards a stray "Enter to select" string in prose.
    expect(isAskUserQuestionPickerSignature('Enter to select · Esc to cancel')).toBe(false);
    // The realistic approval footer ("Esc to cancel · Tab to amend …") without
    // the select hint is NOT a picker.
    expect(isAskUserQuestionPickerSignature(APPROVAL_SCREEN_REALISTIC_FOOTER)).toBe(false);
  });

  it('detect-status does NOT report waiting_approval for a question picker (with or without escape hatch)', () => {
    const detect = buildDetectStatusFromTui({
      modal: spec as DetectStatusTuiSpec['modal'],
      dispatchOrder: { $schema: 'adhdev:tui/dispatch-order@1', order: ['modal'] },
    });
    // The question screen must NOT be classified as an approval.
    expect(detect(statusInput(QUESTION_SCREEN))).toBeNull();
    // Case (1): the escape-hatch-less picker must ALSO not be an approval.
    expect(detect(statusInput(QUESTION_SCREEN_NO_HATCH))).toBeNull();
    // Case (2): a genuine approval modal on the same spec still fires
    // waiting_approval — no false-negative introduced by the relaxed guard.
    expect(detect(statusInput(APPROVAL_SCREEN))).toBe('waiting_approval');
    // Case (3): the rc.19-footer picker (no "Esc to cancel") must ALSO not be an
    // approval. Without the guard its "❯ 1. Continue" row matches the spec's
    // approval-button-block variant and the screen mis-classifies (the live defect).
    expect(detect(statusInput(QUESTION_SCREEN_RC19_FOOTER))).toBeNull();
    // Case (4): a genuine approval with the realistic v2.1.84 footer still fires.
    expect(detect(statusInput(APPROVAL_SCREEN_REALISTIC_FOOTER))).toBe('waiting_approval');
  });

  it('parse-approval returns null for a question picker but still parses a real approval', () => {
    const parse = buildParseApprovalFromTui(spec);
    // No approval modal is extracted from the question picker — its option rows
    // are never mistaken for approval buttons.
    expect(parse(approvalInput(QUESTION_SCREEN))).toBeNull();
    // Case (1): same for the escape-hatch-less picker.
    expect(parse(approvalInput(QUESTION_SCREEN_NO_HATCH))).toBeNull();
    // Case (2): the genuine approval modal still parses (regression guard).
    const approval = parse(approvalInput(APPROVAL_SCREEN));
    expect(approval).not.toBeNull();
    expect(approval?.buttons).toEqual(['Yes', 'No']);
    // Case (3): the rc.19-footer picker yields no spurious approval modal either.
    expect(parse(approvalInput(QUESTION_SCREEN_RC19_FOOTER))).toBeNull();
    // Case (4): the genuine approval with the realistic v2.1.84 footer parses.
    const realistic = parse(approvalInput(APPROVAL_SCREEN_REALISTIC_FOOTER));
    expect(realistic).not.toBeNull();
    expect(realistic?.buttons.length).toBeGreaterThanOrEqual(2);
  });
});
