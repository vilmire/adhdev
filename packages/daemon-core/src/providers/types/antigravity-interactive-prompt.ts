import type { AntigravityPendingAskQuestion } from '../native-history/antigravity-proto.js';
import type {
  InteractiveAnswer,
  InteractiveOption,
  InteractivePrompt,
  InteractivePromptResponse,
  InteractiveQuestion,
} from './interactive-prompt.js';

export interface ParsedAntigravityChoiceOption {
  /** 1-based option number rendered in the TUI (1..K). */
  index: number;
  /** Option label text without numbering or checkbox prefix. */
  label: string;
  /** Whether the checkbox is currently checked in multi-select mode. */
  checked: boolean;
}

export interface ParsedAntigravityChoiceScreen {
  /** 1-based current question index M in `Question M/N: ...`. */
  currentIndex: number;
  /** Total question count N in `Question M/N: ...`. */
  totalQuestions: number;
  /** Current question text rendered after `Question M/N: `. */
  questionText: string;
  /** Whether the current question renders checkboxes / multi-select hints. */
  multiSelect: boolean;
  /** Real options 1..K with the automatic K+1 `Write-in...` row stripped. */
  options: ParsedAntigravityChoiceOption[];
  /** 1-based row index of the automatic `Write-in...` row (K + 1), or 0 in write-in editor mode. */
  writeInRowIndex: number;
  /** 1-based row index currently focused by `>` / `❯` / `›` (1..K+1). Defaults to 1. */
  currentCursorRow: number;
  /** True when the TUI is inside the `Your answer:` write-in sub-view. */
  writingIn: boolean;
  /** Content fingerprint for deduplication across screen ticks. */
  fingerprint: string;
}

const HEADER_TITLE_RE = /^\s*Question\s*$/;
const HEADER_DIVIDER_RE = /^\s*─{10,}\s*$/;
const QUESTION_HEADER_RE = /^\s*Question\s+(\d+)\/(\d+):\s+(.+?)\s*$/;
const OPTION_LINE_RE = /^\s*([❯›>])?\s*(\d+)\.\s+(?:\[([ xX✓✔])\]\s+)?(.+?)\s*$/;
const WRITE_IN_LABEL_RE = /^(?:Write-in\.\.\.|.+\(Write-in\))$/i;
const OPTIONS_NAV_HINTS_RE = /^\s*↑\/↓ Navigate\s*[•·].*[•·]\s*(?:<esc>|esc)\s+Skip\s*$/;
const WRITE_IN_PROMPT_RE = /^\s*Your answer:\s*$/;
const WRITE_IN_NAV_HINTS_RE = /^\s*[Ee]nter Submit.*[•·]\s*(?:<esc>|esc)\s+Back\s*$/;
const POST_MODAL_VETO_RE =
  /^\s*(?:─{10,}|[╭╰┌└│]|>\s+Type your message)|[\u2800-\u28ff]\s+(?:Generating|Running|Thinking)/;

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

export function normalizeAntigravityPromptText(text: string): string {
  return stripAnsi(text).replace(/\s+/g, ' ').trim();
}

/**
 * Parse an active Antigravity (`agy` 1.4.2) `AskQuestionModel` TUI section.
 *
 * Strictly validates the `Question` + `─{10,}` + `Question M/N:` header and active
 * `NavHints` footer (`↑/↓ Navigate • ... • <esc> Skip` or `Enter Submit • <esc> Back`),
 * strips the automatic `K+1. Write-in...` row into `allowFreeform: true`, and rejects
 * historical/quoted blocks that are followed by a composer frame or live spinner.
 */
export function parseAntigravityChoiceScreen(
  rawSectionText: string,
): ParsedAntigravityChoiceScreen | null {
  if (!rawSectionText || !rawSectionText.trim()) return null;
  const cleaned = stripAnsi(rawSectionText).replace(/\r\n/g, '\n');
  const lines = cleaned.split('\n');

  // Find the last valid `Question` + `─{10,}` + (optional blank line) + `Question M/N: ...` header.
  let headerIdx = -1;
  let currentIndex = 0;
  let totalQuestions = 0;
  let questionHeaderLineIdx = -1;
  let questionFirstLine = '';

  for (let i = 0; i + 2 < lines.length; i++) {
    if (!HEADER_TITLE_RE.test(lines[i]!)) continue;
    if (!HEADER_DIVIDER_RE.test(lines[i + 1]!)) continue;
    let qLineIdx = i + 2;
    if (lines[qLineIdx]!.trim() === '' && i + 3 < lines.length) {
      qLineIdx = i + 3;
    }
    const qMatch = QUESTION_HEADER_RE.exec(lines[qLineIdx]!);
    if (!qMatch) continue;
    const m = Number.parseInt(qMatch[1]!, 10);
    const n = Number.parseInt(qMatch[2]!, 10);
    if (!Number.isFinite(m) || !Number.isFinite(n) || m < 1 || n < 1 || m > n) continue;
    headerIdx = i;
    currentIndex = m;
    totalQuestions = n;
    questionHeaderLineIdx = qLineIdx;
    questionFirstLine = qMatch[3]!.trim();
  }

  if (headerIdx < 0 || questionHeaderLineIdx < 0) return null;

  // Locate the active footer line after the question header.
  let footerIdx = -1;
  let writingIn = false;
  let multiSelectFromHint = false;

  for (let i = questionHeaderLineIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (OPTIONS_NAV_HINTS_RE.test(line)) {
      footerIdx = i;
      writingIn = false;
      multiSelectFromHint = /\bToggle\b/i.test(line);
      break;
    }
    if (WRITE_IN_NAV_HINTS_RE.test(line)) {
      footerIdx = i;
      writingIn = true;
      break;
    }
  }

  if (footerIdx < 0) return null;

  // Reject if anything after the active NavHints footer looks like a composer box or live spinner.
  for (let i = footerIdx + 1; i < lines.length; i++) {
    if (POST_MODAL_VETO_RE.test(lines[i]!)) {
      return null;
    }
  }

  if (writingIn) {
    let yourAnswerIdx = -1;
    for (let i = questionHeaderLineIdx + 1; i < footerIdx; i++) {
      if (WRITE_IN_PROMPT_RE.test(lines[i]!)) {
        yourAnswerIdx = i;
        break;
      }
    }
    if (yourAnswerIdx < 0) return null;

    const questionLines = [questionFirstLine];
    for (let i = questionHeaderLineIdx + 1; i < yourAnswerIdx; i++) {
      const trimmed = lines[i]!.trim();
      if (trimmed) questionLines.push(trimmed);
    }
    const questionText = questionLines.join(' ');
    return {
      currentIndex,
      totalQuestions,
      questionText,
      multiSelect: false,
      options: [],
      writeInRowIndex: 0,
      currentCursorRow: 1,
      writingIn: true,
      fingerprint: `agy-q:${currentIndex}/${totalQuestions}:writein:${questionText}`,
    };
  }

  // Options mode: parse question continuation lines and numbered option rows 1..K+1.
  const questionLines = [questionFirstLine];
  interface RawOptionRow {
    focused: boolean;
    index: number;
    checkbox: string | null;
    labelParts: string[];
  }
  const rawRows: RawOptionRow[] = [];

  for (let i = questionHeaderLineIdx + 1; i < footerIdx; i++) {
    const line = lines[i]!;
    const optMatch = OPTION_LINE_RE.exec(line);
    if (optMatch) {
      rawRows.push({
        focused: Boolean(optMatch[1]),
        index: Number.parseInt(optMatch[2]!, 10),
        checkbox: optMatch[3] ?? null,
        labelParts: [optMatch[4]!.trim()],
      });
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (rawRows.length === 0) {
      questionLines.push(trimmed);
    } else {
      rawRows[rawRows.length - 1]!.labelParts.push(trimmed);
    }
  }

  // Must have at least 1 real option + 1 automatic `Write-in...` row (total >= 2 rows).
  if (rawRows.length < 2) return null;

  // Verify contiguous 1-based numbering 1..rawRows.length.
  for (let idx = 0; idx < rawRows.length; idx++) {
    if (rawRows[idx]!.index !== idx + 1) return null;
  }

  const lastRow = rawRows[rawRows.length - 1]!;
  const lastRowLabel = lastRow.labelParts.join(' ');
  if (!WRITE_IN_LABEL_RE.test(lastRowLabel)) {
    return null;
  }

  let currentCursorRow = 1;
  for (const row of rawRows) {
    if (row.focused) {
      currentCursorRow = row.index;
      break;
    }
  }

  const realRows = rawRows.slice(0, -1);
  const hasCheckboxes = realRows.some((r) => r.checkbox !== null);
  const multiSelect = hasCheckboxes || multiSelectFromHint;

  const options: ParsedAntigravityChoiceOption[] = realRows.map((row) => ({
    index: row.index,
    label: row.labelParts.join(' '),
    checked: row.checkbox !== null && row.checkbox.trim().length > 0,
  }));

  const questionText = questionLines.join(' ');
  const optionSig = options.map((o) => `${o.index}:${o.label}`).join('|');

  return {
    currentIndex,
    totalQuestions,
    questionText,
    multiSelect,
    options,
    writeInRowIndex: lastRow.index,
    currentCursorRow,
    writingIn: false,
    fingerprint: `agy-q:${currentIndex}/${totalQuestions}:${multiSelect ? 'm' : 's'}:${questionText}:${optionSig}`,
  };
}

/**
 * Verify that the live parsed TUI screen matches the `currentIndex`-th question
 * of the pending native `CortexStepAskQuestion` step.
 */
export function doesAntigravityScreenMatchNativeStep(
  screen: ParsedAntigravityChoiceScreen,
  nativePending: AntigravityPendingAskQuestion,
): boolean {
  if (nativePending.questions.length !== screen.totalQuestions) return false;
  const targetQuestion = nativePending.questions[screen.currentIndex - 1];
  if (!targetQuestion) return false;

  const normScreenQ = normalizeAntigravityPromptText(screen.questionText);
  const normNativeQ = normalizeAntigravityPromptText(targetQuestion.questionText);
  if (!normScreenQ || !normNativeQ) return false;
  if (
    normScreenQ !== normNativeQ &&
    !normScreenQ.includes(normNativeQ) &&
    !normNativeQ.includes(normScreenQ)
  ) {
    return false;
  }

  if (screen.writingIn) {
    return true;
  }

  if (Boolean(targetQuestion.isMultiSelect) !== Boolean(screen.multiSelect)) {
    return false;
  }
  if (targetQuestion.options.length !== screen.options.length) {
    return false;
  }

  for (let i = 0; i < targetQuestion.options.length; i++) {
    const normNativeOpt = normalizeAntigravityPromptText(targetQuestion.options[i]!.label);
    const normScreenOpt = normalizeAntigravityPromptText(screen.options[i]!.label);
    if (
      normNativeOpt !== normScreenOpt &&
      !normScreenOpt.includes(normNativeOpt) &&
      !normNativeOpt.includes(normScreenOpt)
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Build a normalized `InteractivePrompt` by combining the live parsed TUI screen
 * with the authoritative pending native `CortexStepAskQuestion` payload.
 *
 * Returns `null` when `nativePending` is absent or does not match the active screen,
 * so the caller falls back to truthful manual `waiting_choice` status without
 * fabricating options or mis-binding a stale DB step.
 */
export function buildAntigravityInteractivePrompt(params: {
  screen: ParsedAntigravityChoiceScreen;
  nativePending: AntigravityPendingAskQuestion | null | undefined;
  promptId?: string;
  createdAt?: number;
  providerType?: string;
}): InteractivePrompt | null {
  const { screen, nativePending, promptId, createdAt, providerType = 'antigravity-cli' } = params;
  if (!nativePending) return null;
  if (!doesAntigravityScreenMatchNativeStep(screen, nativePending)) {
    return null;
  }

  const questions: InteractiveQuestion[] = nativePending.questions.map((q, qIdx) => {
    const options: InteractiveOption[] = q.options.map((opt) => ({
      label: opt.label,
    }));
    return {
      questionId: `q${qIdx + 1}`,
      question: q.questionText,
      header: `Question ${qIdx + 1}/${nativePending.questions.length}`,
      options,
      multiSelect: q.isMultiSelect,
      allowFreeform: true,
    };
  });

  const resolvedPromptId =
    promptId ??
    `agy-ask:${nativePending.conversationId}:${nativePending.stepIdx}:${nativePending.callId || '0'}`;

  return {
    promptId: resolvedPromptId,
    origin: 'cli',
    providerType,
    createdAt: createdAt ?? Date.now(),
    questions,
  };
}

function moveAntigravityCursor(fromRow: number, toRow: number): string {
  if (toRow === fromRow) return '';
  if (toRow > fromRow) return '\x1b[B'.repeat(toRow - fromRow);
  return '\x1b[A'.repeat(fromRow - toRow);
}

function resolveSelectedOptionRows(
  question: InteractiveQuestion,
  selectedLabels: string[],
): number[] {
  const rows: number[] = [];
  const seen = new Set<number>();
  for (const selected of selectedLabels) {
    let idx = question.options.findIndex((candidate) => candidate.label === selected);
    if (idx < 0) {
      const asNum = Number(selected);
      if (Number.isInteger(asNum) && asNum >= 1 && asNum <= question.options.length) {
        idx = asNum - 1;
      }
    }
    if (idx < 0) {
      throw new Error(`Unknown option for ${question.questionId}: ${selected}`);
    }
    const rowNumber = idx + 1;
    if (!seen.has(rowNumber)) {
      seen.add(rowNumber);
      rows.push(rowNumber);
    }
  }
  return rows;
}

/**
 * Build exact PTY keystrokes for a single Antigravity (`agy` 1.4.2) `AskQuestion` item.
 *
 * Verified against `AskQuestionModel.Update` in the `agy` 1.4.2 binary:
 * - Single-select option `1..9`: digit key `'1'..'9'` selects and auto-advances immediately (no `\r`).
 * - Single-select option `>9`: arrow keys from `currentCursorRow` to `targetRow`, then `\r`.
 * - Multi-select options: digit `'1'..'9'` moves cursor & toggles; for `>9`, arrow keys from
 *   tracked cursor row + `' '` (Space) toggles; then `\r` submits the question (NO `\t` Tab).
 * - Freeform / Write-in (`K+1`): selects row `K+1` (via digit `<=9` or arrows + `\r` for `>9`),
 *   types the freeform text, and sends `\r` (which calls `advanceOrSubmit`).
 */
export interface AntigravityQuestionKeystrokeOptions {
  currentCursorRow?: number;
  writingIn?: boolean;
  /**
   * 1-based option row numbers (1..K) currently checked (`[x]`) on the live TUI screen.
   * When omitted in options mode (`writingIn !== true`), defaults to `[]` (no options pre-checked).
   * When omitted in write-in mode (`writingIn === true`) on a multi-select question, refuses
   * because the `Your answer:` sub-view hides the option checkboxes.
   */
  currentlyCheckedRows?: ReadonlyArray<number>;
}

function computeMultiSelectToggleRows(
  realOptionCount: number,
  desiredRows: ReadonlyArray<number>,
  currentlyCheckedRows: ReadonlyArray<number>,
): number[] {
  const desiredSet = new Set(desiredRows);
  const checkedSet = new Set<number>();
  for (const row of currentlyCheckedRows) {
    if (!Number.isInteger(row) || row < 1 || row > realOptionCount) {
      throw new Error(`Invalid checked option row ${row} (expected 1..${realOptionCount})`);
    }
    checkedSet.add(row);
  }
  const toggleRows: number[] = [];
  for (let row = 1; row <= realOptionCount; row++) {
    if (checkedSet.has(row) !== desiredSet.has(row)) {
      toggleRows.push(row);
    }
  }
  return toggleRows;
}

function appendMultiSelectToggleKeys(
  toggleRows: ReadonlyArray<number>,
  initialCursorRow: number,
): { keys: string; cursorRow: number } {
  let keys = '';
  let cursorRow = initialCursorRow;
  for (const targetRow of toggleRows) {
    if (targetRow <= 9) {
      keys += String(targetRow);
      cursorRow = targetRow;
    } else {
      keys += moveAntigravityCursor(cursorRow, targetRow);
      keys += ' ';
      cursorRow = targetRow;
    }
  }
  return { keys, cursorRow };
}

/**
 * Build exact PTY keystrokes for a single Antigravity (`agy` 1.4.2) `AskQuestion` item.
 *
 * Verified against `AskQuestionModel.Update` in the `agy` 1.4.2 binary:
 * - Single-select option `1..9`: digit key `'1'..'9'` selects and auto-advances immediately (no `\r`).
 * - Single-select option `>9`: arrow keys from `currentCursorRow` to `targetRow`, then `\r`.
 * - Multi-select options: reconciles the live checked set against desired labels using the
 *   symmetric difference (`checked !== desired`); digit `'1'..'9'` moves cursor & toggles,
 *   `>9` uses arrow keys from tracked cursor row + `' '` (Space) to toggle, then `\r` submits
 *   (NO `\t` Tab). If all desired options are already checked and no unwanted options are checked,
 *   sends only `\r`.
 * - Freeform / Write-in (`K+1`): selects row `K+1` (via digit `<=9` or arrows + `\r` for `>9`),
 *   types the freeform text, and sends `\r` (which calls `advanceOrSubmit`).
 */
export function buildAntigravityQuestionKeystrokes(
  question: InteractiveQuestion,
  answer: InteractiveAnswer,
  options?: AntigravityQuestionKeystrokeOptions,
): string {
  const realOptionCount = question.options.length;
  if (realOptionCount < 1) {
    throw new Error(`Question ${question.questionId} has no options`);
  }

  const writeInRow = realOptionCount + 1;
  let cursorRow =
    options?.currentCursorRow && options.currentCursorRow >= 1
      ? options.currentCursorRow
      : 1;
  const freeform = answer.freeformText?.trim() ?? '';

  if (question.multiSelect && options?.writingIn && options.currentlyCheckedRows === undefined) {
    throw new Error(
      `Cannot reconcile multi-select checkboxes for ${question.questionId} while the native Write-in editor is already open`,
    );
  }

  if (freeform.length > 0) {
    if (question.allowFreeform === false) {
      throw new Error(`Freeform write-in is not supported for ${question.questionId}`);
    }
    if (!question.multiSelect && answer.selectedLabels.length > 0) {
      throw new Error(
        `Single-select question ${question.questionId} cannot combine option selection with freeform write-in`,
      );
    }

    if (!question.multiSelect) {
      if (options?.writingIn) {
        return `${freeform}\r`;
      }
      let keys = '';
      if (writeInRow <= 9) {
        keys += String(writeInRow);
      } else {
        keys += moveAntigravityCursor(cursorRow, writeInRow);
        keys += '\r';
      }
      keys += `${freeform}\r`;
      return keys;
    }

    // Multi-select with freeform write-in: reconcile regular option checkboxes first.
    const desiredRows = resolveSelectedOptionRows(question, answer.selectedLabels);
    const toggleRows = computeMultiSelectToggleRows(
      realOptionCount,
      desiredRows,
      options?.currentlyCheckedRows ?? [],
    );

    if (options?.writingIn) {
      if (toggleRows.length === 0) {
        return `${freeform}\r`;
      }
      // Exit write-in sub-view (`<esc> Back`) to reconcile checkboxes, then re-open Write-in.
      let keys = '\x1b';
      const toggled = appendMultiSelectToggleKeys(toggleRows, writeInRow);
      keys += toggled.keys;
      cursorRow = toggled.cursorRow;
      if (writeInRow <= 9) {
        keys += String(writeInRow);
      } else {
        keys += moveAntigravityCursor(cursorRow, writeInRow);
        keys += '\r';
      }
      keys += `${freeform}\r`;
      return keys;
    }

    let keys = '';
    const toggled = appendMultiSelectToggleKeys(toggleRows, cursorRow);
    keys += toggled.keys;
    cursorRow = toggled.cursorRow;

    if (writeInRow <= 9) {
      keys += String(writeInRow);
    } else {
      keys += moveAntigravityCursor(cursorRow, writeInRow);
      keys += '\r';
    }
    keys += `${freeform}\r`;
    return keys;
  }

  const treatAsMultiSelect = question.multiSelect || answer.selectedLabels.length > 1;
  if (treatAsMultiSelect && !question.multiSelect) {
    throw new Error(`Expected one selected label for ${question.questionId}`);
  }

  const selectedRows = resolveSelectedOptionRows(question, answer.selectedLabels);
  if (question.multiSelect) {
    if (selectedRows.length === 0) {
      throw new Error(`Expected at least one selected label for ${question.questionId}`);
    }
  } else if (selectedRows.length !== 1) {
    throw new Error(`Expected one selected label for ${question.questionId}`);
  }

  let prefix = '';
  if (options?.writingIn) {
    // Exit write-in sub-view back to options list first (`<esc> Back`).
    prefix = '\x1b';
    cursorRow = writeInRow;
  }

  if (question.multiSelect) {
    const toggleRows = computeMultiSelectToggleRows(
      realOptionCount,
      selectedRows,
      options?.currentlyCheckedRows ?? [],
    );
    const toggled = appendMultiSelectToggleKeys(toggleRows, cursorRow);
    return `${prefix}${toggled.keys}\r`;
  }

  // Single-select
  const targetRow = selectedRows[0]!;
  if (targetRow <= 9) {
    return `${prefix}${String(targetRow)}`;
  }
  return `${prefix}${moveAntigravityCursor(cursorRow, targetRow)}\r`;
}

/**
 * Build `<esc>` skip keystrokes for cancelling an active Antigravity `AskQuestion` modal.
 *
 * In `AskQuestionModel.Update`, `<esc>` in options mode marks the current question skipped
 * and calls `advanceOrSubmit`. For a carousel with `N` questions at 1-based index `M`,
 * skipping the remainder of the prompt requires `N - M + 1` `<esc>` presses (plus one
 * leading `<esc>` if currently inside the `Your answer:` write-in sub-view).
 */
export function buildAntigravityCancelKeystrokes(params: {
  currentIndex: number;
  totalQuestions: number;
  writingIn?: boolean;
  singleStepOnly?: boolean;
}): string {
  const { currentIndex, totalQuestions, writingIn = false, singleStepOnly = false } = params;
  const remaining = singleStepOnly
    ? 1
    : Math.max(1, totalQuestions - Math.max(1, currentIndex) + 1);
  const lead = writingIn ? '\x1b' : '';
  return `${lead}${'\x1b'.repeat(remaining)}`;
}

/**
 * Build per-question PTY keystroke steps for an `InteractivePromptResponse`
 * under the `antigravity_tui` scheme.
 *
 * Unlike Claude/Kimi, Antigravity `advanceOrSubmit` immediately finishes after the Nth
 * question with NO final review screen and NO trailing `\r`.
 */
export function buildAntigravityInteractiveTuiAnswerSteps(
  prompt: InteractivePrompt,
  response: InteractivePromptResponse,
  options?: {
    startQuestionIndex?: number;
    currentCursorRow?: number;
    writingIn?: boolean;
    currentlyCheckedRows?: ReadonlyArray<number>;
  },
): string[] {
  if (response.promptId !== prompt.promptId) {
    throw new Error('Interactive prompt response does not match active prompt');
  }

  const startIdx = Math.max(0, options?.startQuestionIndex ?? 0);
  if (response.action === 'dismiss') {
    const steps: string[] = [];
    if (options?.writingIn) {
      steps.push('\x1b');
    }
    const remaining = Math.max(1, prompt.questions.length - startIdx);
    for (let i = 0; i < remaining; i++) {
      steps.push('\x1b');
    }
    return steps;
  }

  const steps: string[] = [];
  for (let i = startIdx; i < prompt.questions.length; i++) {
    const question = prompt.questions[i]!;
    const answer = response.answers[question.questionId];
    if (!answer) {
      throw new Error(`Missing answer for ${question.questionId}`);
    }
    const keys = buildAntigravityQuestionKeystrokes(
      question,
      answer,
      i === startIdx
        ? {
            currentCursorRow: options?.currentCursorRow,
            writingIn: options?.writingIn,
            currentlyCheckedRows: options?.currentlyCheckedRows,
          }
        : { currentCursorRow: 1, writingIn: false },
    );
    steps.push(keys);
  }

  return steps;
}
