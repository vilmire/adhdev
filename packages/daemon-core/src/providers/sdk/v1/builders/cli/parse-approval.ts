/**
 * buildParseApprovalFromTui
 *
 * Turns a `tui/modal@1` block into a runtime
 * `(input: CliApprovalInput) => CliApprovalModal | null` function.
 *
 * Contract rules enforced (sprint-2026-06):
 *   - Returns null when the question pattern is not visible.
 *   - Returns null when the button list is empty or shorter than minButtons.
 *   - Button labels are raw text; never rewritten (e.g. "Yes, and don't ask
 *     again for X" stays verbatim).
 *   - Modal scope respects between-last-two-separators / window-around-question
 *     / whole-screen to avoid false-positives from numbered lists in
 *     assistant prose.
 */

import type {
  CliApprovalInput,
  CliApprovalModal,
  CliParseApprovalFn,
} from '../../types/cli/index.js';
import {
  applyVisibleRegion,
  type VisibleRegionSpec,
} from './visible-region.js';

// ─── Spec shapes ───────────────────────────────────────────────────────

interface ModalQuestionVariant {
  regex: string;
  flags?: string;
  label?: string;
}

interface ModalContextHeader {
  regex: string;
  flags?: string;
}

export interface ModalTuiSpec {
  $schema: 'adhdev:tui/modal@1';
  questionPattern: string;
  questionFlags?: string;
  questionVariants?: ModalQuestionVariant[];
  buttonPattern: string;
  buttonFlags?: string;
  buttonLabelGroup?: number;
  /**
   * Optional fallback for terminals that render all options on a single line
   * (e.g. Antigravity feedback survey: `[0] skip [1] yes [2] no [3] still using`).
   * When per-line button extraction collects fewer than `minButtons`, the
   * builder makes a second pass with this regex (global match, capture group 1
   * is the label).
   */
  inlineButtonPattern?: string;
  inlineButtonFlags?: string;
  scope?: 'between-last-two-separators' | 'window-around-question' | 'whole-screen';
  scopeWindowLines?: number;
  contextHeader?: ModalContextHeader;
  continuationLines?: boolean;
  minButtons?: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────

// A horizontal rule line. Covers solid box-drawing rules (─ ━ ═) AND the dashed
// variants (╌ ╍ ┄ ┅ ┈ ┉) that Claude Code draws as the INNER separators around a
// Write/Edit diff body. This matches the coverage of the claude-cli v4 FSM spec
// anchor `^[─╌]+$` (issue #137) so the SDK-v1 parser recognizes the same modal
// frames the FSM does — a dashed rule is a separator, not modal content.
const SEPARATOR_RE = /^[─━═╌╍┄┅┈┉]{10,}\s*$/;

function compile(re: string, flags?: string): RegExp {
  try {
    return new RegExp(re, flags);
  } catch (e) {
    throw new Error(`Invalid regex /${re}/${flags ?? ''}: ${(e as Error).message}`);
  }
}

// See detect-status.PICKER_OPTION_ROW — kept in lockstep so both layers gate on
// the identical picker signature.
const PICKER_OPTION_ROW = /^\s*(?:[❯›>]\s*)?(?:\[[ xX]\]|[☐☒◻◼]\s*)?\d+[.)]\s+\S/m;

/**
 * APPROVAL-PICKER-MISROUTE (mission f1d25e11 / fb2a7053) defense-in-depth: mirror
 * detect-status.isAskUserQuestionPickerSignature at the button-parse layer. A
 * multi-choice AskUserQuestion picker is not an approval modal; its numbered
 * option rows can otherwise be extracted as approval buttons and produce a
 * spurious approval modal.
 *
 * The picker signature is the claude TUI select footer ("Enter to select" +
 * "Esc to cancel") plus at least one numbered option row. A genuine approval
 * modal never renders that footer pair, so it is safe even though approval modals
 * also draw numbered rows. The freeform escape hatch ("Type something" / "Chat
 * about this") used to be REQUIRED here too, which broke the guard whenever the
 * hatch rows were absent or scrolled out of frame; it is now downgraded to an
 * optional supporting signal (mirrors detect-status).
 */
function isAskUserQuestionPickerSignature(text: string): boolean {
  if (!text) return false;
  const hasSelectFooter = /Enter to select/i.test(text) && /Esc to cancel/i.test(text);
  if (!hasSelectFooter) return false;
  return PICKER_OPTION_ROW.test(text);
}

function findQuestionLineIndex(
  spec: ModalTuiSpec,
  lines: string[],
): { index: number; matchedSource: 'primary' | string } | null {
  const primary = compile(spec.questionPattern, spec.questionFlags ?? 'i');
  // A question keyword frequently ALSO appears inside a button label:
  // cursor-agent's Workspace-Trust modal renders `▶ [a] Trust this workspace`
  // and its questionPattern matches the bare word `Trust`; the git-command
  // prompt offers an `Approve`/`Allow`/`Run` button while the pattern lists
  // `approve|Approve|Allow`. A bottom-up scan therefore lands on the BUTTON
  // line (lower on screen) instead of the real prose question above it, and
  // extractButtons (which starts at question.index + 1) then scopes the
  // affirmative button OUT — leaving fewer than minButtons → parseApproval
  // returns null → the approval never surfaces and the session wedges in
  // `starting`/`generating`. Skip lines that are themselves button lines so
  // the search resolves to the prose question, not a button label that merely
  // shares a keyword. This is the general form of the kimi defect-C fix.
  const buttonFlags = spec.buttonFlags && spec.buttonFlags.includes('m')
    ? spec.buttonFlags
    : `${spec.buttonFlags ?? ''}m`;
  const buttonRe = compile(spec.buttonPattern, buttonFlags);
  const isButtonLine = (line: string): boolean => {
    buttonRe.lastIndex = 0;
    return buttonRe.test(line);
  };
  // First pass: prefer a question line that is NOT itself a button line.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (primary.test(lines[i]) && !isButtonLine(lines[i])) return { index: i, matchedSource: 'primary' };
  }
  for (const variant of spec.questionVariants ?? []) {
    const re = compile(variant.regex, variant.flags ?? 'i');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (re.test(lines[i]) && !isButtonLine(lines[i])) return { index: i, matchedSource: variant.label ?? 'variant' };
    }
  }
  // Fallback: no non-button question line found. Accept a button-line match so
  // providers whose question genuinely renders on the button row (rare) still
  // work — behaviour identical to the pre-fix scan.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (primary.test(lines[i])) return { index: i, matchedSource: 'primary' };
  }
  for (const variant of spec.questionVariants ?? []) {
    const re = compile(variant.regex, variant.flags ?? 'i');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (re.test(lines[i])) return { index: i, matchedSource: variant.label ?? 'variant' };
    }
  }
  return null;
}

function scopeLines(
  spec: ModalTuiSpec,
  lines: string[],
  questionIndex: number,
): { start: number; end: number } {
  const scope = spec.scope ?? 'between-last-two-separators';
  if (scope === 'whole-screen') {
    return { start: 0, end: lines.length };
  }
  if (scope === 'window-around-question') {
    const window = spec.scopeWindowLines ?? 16;
    return {
      start: Math.max(0, questionIndex - 2),
      end: Math.min(lines.length, questionIndex + window),
    };
  }
  // between-last-two-separators
  let lastSep = -1;
  let prevSep = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (SEPARATOR_RE.test(lines[i].trim())) {
      if (lastSep < 0) lastSep = i;
      else if (prevSep < 0) {
        prevSep = i;
        break;
      }
    }
  }
  // Only scope to the separator frame when it actually BRACKETS the question
  // line. Claude Write/Edit modals draw dashed (╌) inner rules around the diff
  // body, so the last two separators can enclose the file diff while the
  // question + button block sit BELOW the lower dashed rule. Scoping to that
  // inner frame would drop every button (→ null → missed auto-approve, #137).
  // When the question is outside the frame, fall through to a window around it.
  if (lastSep >= 0 && prevSep >= 0 && questionIndex >= prevSep && questionIndex < lastSep + 1) {
    return { start: prevSep, end: lastSep + 1 };
  }
  // Fallback: window around question line.
  return {
    start: Math.max(0, questionIndex - 4),
    end: Math.min(lines.length, questionIndex + 16),
  };
}

function extractButtons(
  spec: ModalTuiSpec,
  lines: string[],
  windowStart: number,
  windowEnd: number,
): string[] {
  const buttonRe = compile(spec.buttonPattern, spec.buttonFlags ?? 'm');
  const out: string[] = [];
  const labelGroup = Number.isInteger(spec.buttonLabelGroup) && (spec.buttonLabelGroup ?? 0) > 0
    ? spec.buttonLabelGroup!
    : 1;
  let i = windowStart;
  while (i < windowEnd) {
    const line = lines[i];
    const m = buttonRe.exec(line);
    const captured = m?.[labelGroup] ?? (labelGroup === 1 && m && m.length > 2 ? m[m.length - 1] : undefined);
    if (m && captured) {
      let label = captured.trim();
      // Continuation lines: when enabled, append indented lines below until
      // the next button or blank.
      if (spec.continuationLines) {
        let j = i + 1;
        while (j < windowEnd) {
          const next = lines[j];
          if (!next.trim()) break;
          if (buttonRe.test(next)) break;
          // continuation must be indented (not at column 0 like a new section).
          if (!/^\s+/.test(next)) break;
          label += ' ' + next.trim();
          j += 1;
        }
        i = j;
      } else {
        i += 1;
      }
      out.push(label);
    } else {
      i += 1;
    }
  }
  return out;
}

function buildMessage(
  spec: ModalTuiSpec,
  lines: string[],
  questionIndex: number,
  windowStart: number,
  windowEnd: number,
): string {
  const messageParts: string[] = [];
  if (spec.contextHeader) {
    const ctxRe = compile(spec.contextHeader.regex, (spec.contextHeader.flags ?? 'i') + 'm');
    const haystack = lines.slice(windowStart, windowEnd).join('\n');
    const m = ctxRe.exec(haystack);
    if (m) messageParts.push(m[1] ? m[1].trim() : m[0].trim());
  }
  messageParts.push(lines[questionIndex].trim());
  return messageParts.filter(Boolean).join(' — ');
}

// ─── Public builder ────────────────────────────────────────────────────

function extractInlineButtons(
  spec: ModalTuiSpec,
  lines: string[],
  windowStart: number,
  windowEnd: number,
): string[] {
  if (!spec.inlineButtonPattern) return [];
  // Always force the `g` flag so we can iterate all matches in the line.
  const declaredFlags = spec.inlineButtonFlags ?? 'gi';
  const flags = declaredFlags.includes('g') ? declaredFlags : declaredFlags + 'g';
  const re = compile(spec.inlineButtonPattern, flags);
  const out: string[] = [];
  for (let i = windowStart; i < windowEnd; i += 1) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(lines[i])) !== null) {
      const label = (m[1] ?? m[0]).trim();
      if (label && !out.includes(label)) out.push(label);
      if (m.index === re.lastIndex) re.lastIndex += 1; // safety against zero-width matches
    }
  }
  return out;
}

export function buildParseApprovalFromTui(
  spec: ModalTuiSpec,
  visibleRegion?: VisibleRegionSpec,
): CliParseApprovalFn {
  const minButtons = spec.minButtons ?? 2;

  return function parseApproval(input: CliApprovalInput): CliApprovalModal | null {
    const rawText = input.screenText ?? input.buffer ?? '';
    if (!rawText) return null;
    // An AskUserQuestion picker is not an approval — never extract its option
    // rows as approval buttons (mission f1d25e11). Check the raw text before any
    // visible-region scoping trims the footer that identifies the picker.
    if (isAskUserQuestionPickerSignature(rawText)) return null;
    const text = visibleRegion ? applyVisibleRegion(visibleRegion, rawText) : rawText;
    const lines = text.split('\n');
    const question = findQuestionLineIndex(spec, lines);
    if (!question) return null;
    const { start, end } = scopeLines(spec, lines, question.index);
    if (question.index < start || question.index >= end) return null;
    let buttons = extractButtons(spec, lines, question.index + 1, end);
    // Inline fallback: when per-line extraction came up short, the terminal
    // may have rendered every option on the same line ("[0] skip [1] yes …").
    if (buttons.length < minButtons && spec.inlineButtonPattern) {
      buttons = extractInlineButtons(spec, lines, question.index, end);
    }
    if (buttons.length < minButtons) return null;
    const message = buildMessage(spec, lines, question.index, start, end);
    return { message, buttons };
  };
}

export const __internal = {
  findQuestionLineIndex,
  scopeLines,
  extractButtons,
};
