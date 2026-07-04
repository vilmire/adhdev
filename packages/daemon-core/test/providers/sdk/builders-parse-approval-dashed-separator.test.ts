/**
 * Regression: Claude Write/Edit approval modals draw DASHED (╌ U+254C) inner
 * separators around the diff body. The SDK-v1 SEPARATOR_RE was solid-only
 * (─ ━ ═), so `between-last-two-separators` scoping never recognized the dashed
 * rules — and once it does (equivalent coverage to the FSM anchor `^[─╌]+$`),
 * the last two separators enclose the DIFF, not the button block, which would
 * drop every button. This asserts the parser still surfaces ≥2 buttons for the
 * real captured fixture (issue #137, missed-approval-write-2026-06-04).
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildParseApprovalFromTui,
  type ModalTuiSpec,
} from '../../../src/providers/sdk/v1/builders/cli/parse-approval.js';
import { hasNegativeApprovalOption } from '../../../src/providers/approval-utils.js';
import type { CliApprovalInput } from '../../../src/providers/sdk/v1/types/cli/index.js';

function approvalInput(screenText: string): CliApprovalInput {
  return { screenText } as CliApprovalInput;
}

// The claude-cli v1 modal spec uses the DEFAULT scope (between-last-two-separators)
// with no `scope` field — mirrors adhdev-providers/cli/claude-cli/provider.v1.json.
const claudeModalSpec: ModalTuiSpec = {
  $schema: 'adhdev:tui/modal@1',
  questionPattern:
    'Do you want to (?:proceed|allow|run|make this edit|create|overwrite)',
  questionFlags: 'i',
  buttonPattern: '^\\s*([❯›>]\\s*)?\\d+[.)]\\s+(.+)$',
  buttonLabelGroup: 2,
  buttonFlags: 'm',
};

describe('parseApproval — dashed (╌) inner separators (claude Write/Edit)', () => {
  const parse = buildParseApprovalFromTui(claudeModalSpec);

  it('surfaces all buttons when dashed rules bracket the diff, not the modal', () => {
    // The two ╌ rules enclose the diff body ("1 hello"); the question + buttons
    // sit BELOW the lower dashed rule. Recognizing the dashed rules must NOT
    // scope the modal to the diff and drop the buttons.
    const screen = [
      '⏺ Write(/tmp/adhdev-approval-test.txt)',
      '',
      '────────────────────────────────────────────────────────────────────────────────',
      ' Create file',
      ' ../../../../tmp/adhdev-approval-test.txt',
      '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
      '  1 hello',
      '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
      ' Do you want to create adhdev-approval-test.txt?',
      ' ❯ 1. Yes',
      '   2. Yes, allow all edits in tmp/ during this session (shift+tab)',
      '   3. No',
    ].join('\n');

    const r = parse(approvalInput(screen));
    expect(r).not.toBeNull();
    expect(r!.buttons).toEqual([
      'Yes',
      'Yes, allow all edits in tmp/ during this session (shift+tab)',
      'No',
    ]);
    expect(hasNegativeApprovalOption(r!.buttons)).toBe(true);
  });

  it('still surfaces buttons when a TALL diff fills many dashed-bracketed lines', () => {
    const diff = Array.from({ length: 40 }, (_, i) => `  ${i + 1} line ${i + 1}`);
    const screen = [
      '⏺ Write(/tmp/big.txt)',
      '────────────────────────────────────────────────────────────────────────────────',
      ' Create file',
      '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
      ...diff,
      '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
      ' Do you want to create big.txt?',
      ' ❯ 1. Yes',
      '   2. Yes, allow all edits in tmp/ during this session (shift+tab)',
      '   3. No',
    ].join('\n');

    const r = parse(approvalInput(screen));
    expect(r).not.toBeNull();
    expect(r!.buttons.length).toBeGreaterThanOrEqual(2);
    expect(r!.buttons[0]).toBe('Yes');
  });
});

// ─── Real captured fixture (present only in the providers checkout) ──────────

function resolveProvidersDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '../../../../../..');
  const candidates = [
    path.join(repoRoot, 'adhdev-providers/cli/claude-cli'),
    path.join(process.env.HOME ?? '', '.adhdev/providers/.upstream/cli/claude-cli'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

describe('parseApproval — real missed-approval-write-2026-06-04 fixture', () => {
  it('parses ≥2 buttons incl. the decline from the real spec + fixture', () => {
    const dir = resolveProvidersDir();
    if (!dir) return; // fixture + spec only present in the providers checkout
    const fxPath = path.join(dir, 'fixtures', 'missed-approval-write-2026-06-04.json');
    const specPath = path.join(dir, 'provider.v1.json');
    if (!fs.existsSync(fxPath) || !fs.existsSync(specPath)) return;

    const modalSpec = JSON.parse(fs.readFileSync(specPath, 'utf8')).tui?.modal as ModalTuiSpec;
    const screen = JSON.parse(fs.readFileSync(fxPath, 'utf8')).input.screenText as string;
    expect(modalSpec?.$schema).toBe('adhdev:tui/modal@1');

    const r = buildParseApprovalFromTui(modalSpec)(approvalInput(screen));
    expect(r).not.toBeNull();
    expect(r!.buttons.length).toBeGreaterThanOrEqual(2);
    expect(r!.buttons[0]).toBe('Yes');
    expect(hasNegativeApprovalOption(r!.buttons)).toBe(true);
  });
});
