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
  scope?: 'between-last-two-separators' | 'window-around-question' | 'whole-screen';
  scopeWindowLines?: number;
  contextHeader?: ModalContextHeader;
  continuationLines?: boolean;
  minButtons?: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────

const SEPARATOR_RE = /^(?:─|━|═|━){10,}\s*$/;

function compile(re: string, flags?: string): RegExp {
  try {
    return new RegExp(re, flags);
  } catch (e) {
    throw new Error(`Invalid regex /${re}/${flags ?? ''}: ${(e as Error).message}`);
  }
}

function findQuestionLineIndex(
  spec: ModalTuiSpec,
  lines: string[],
): { index: number; matchedSource: 'primary' | string } | null {
  const primary = compile(spec.questionPattern, spec.questionFlags ?? 'i');
  // Search bottom-up to prefer the most recent modal.
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
  if (lastSep >= 0 && prevSep >= 0) {
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
  let i = windowStart;
  while (i < windowEnd) {
    const line = lines[i];
    const m = buttonRe.exec(line);
    if (m && m[1]) {
      let label = m[1].trim();
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

export function buildParseApprovalFromTui(spec: ModalTuiSpec): CliParseApprovalFn {
  const minButtons = spec.minButtons ?? 2;

  return function parseApproval(input: CliApprovalInput): CliApprovalModal | null {
    const text = input.screenText ?? input.buffer ?? '';
    if (!text) return null;
    const lines = text.split('\n');
    const question = findQuestionLineIndex(spec, lines);
    if (!question) return null;
    const { start, end } = scopeLines(spec, lines, question.index);
    if (question.index < start || question.index >= end) return null;
    const buttons = extractButtons(spec, lines, question.index + 1, end);
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
