/**
 * buildDetectStatusFromTui
 *
 * Turns a manifest's declarative TUI block into a runtime
 * `(input: CliStatusInput) => CliStatus | null` function.
 *
 * Inputs handled (all optional except spinner):
 *   - tui/spinner@1          → contributes `generating`
 *   - tui/settled-prompt@1   → contributes `idle`
 *   - tui/modal@1            → contributes `waiting_approval`
 *
 * Dispatch order (sprint-2026-06 contract):
 *   1. Active generation cues win over idle prompt — checked first.
 *      Reason: codex/claude keep model footer visible during `Working` and
 *      `hasReadyPrompt` falsely fired idle. Audit §4.2 introduces
 *      `tui/cue-ordering` as the named primitive for this rule.
 *   2. Modal cue (if present) is checked next — `waiting_approval`.
 *   3. Settled-prompt cue — `idle`.
 *   4. Default: `null` (no change).
 */

import type {
  CliStatusInput,
  CliStatus,
  CliDetectStatusFn,
} from '../../types/cli/index.js';
import {
  applyVisibleRegion,
  type VisibleRegionSpec,
} from './visible-region.js';
import {
  pickApprovalButton,
  hasNegativeApprovalOption,
} from '../../../../approval-utils.js';

// ─── Primitive spec shapes (mirror the JSON schemas) ───────────────────

interface RegexLikeSpec {
  regex: string;
  flags?: string;
}

interface SpinnerPatternSpec extends RegexLikeSpec {
  description?: string;
}

interface SpinnerSpec {
  $schema: 'adhdev:tui/spinner@1';
  patterns: SpinnerPatternSpec[];
  scope?: 'live-frame-tail' | 'whole-screen' | 'recent-buffer';
  scopeWindowLines?: number;
}

interface SettledPromptFooterSpec {
  pattern: string;
  kind?: 'substring' | 'regex';
  flags?: string;
}

interface SettledPromptSpec {
  $schema: 'adhdev:tui/settled-prompt@1';
  regex: string;
  flags?: string;
  withFooter?: SettledPromptFooterSpec[];
  scope?: 'last-n-lines' | 'whole-screen';
  scopeWindowLines?: number;
}

interface ModalSpec {
  $schema: 'adhdev:tui/modal@1';
  questionPattern: string;
  questionFlags?: string;
  questionVariants?: Array<{ regex: string; flags?: string; label?: string }>;
  buttonPattern: string;
  buttonFlags?: string;
  buttonLabelGroup?: number;
}

export type DispatchGroup =
  | 'spinner'
  | 'modal'
  | 'settled-prompt'
  | 'cue-ordering'
  | 'error-detection'
  | 'approval-stitching';

export interface DispatchOrderSpec {
  $schema: 'adhdev:tui/dispatch-order@1';
  order: DispatchGroup[];
  onNoMatch?: 'idle' | 'unknown' | 'preserve-last';
}

export interface DetectStatusTuiSpec {
  spinner?: SpinnerSpec;
  settledPrompt?: SettledPromptSpec;
  modal?: ModalSpec;
  dispatchOrder?: DispatchOrderSpec;
  visibleRegion?: VisibleRegionSpec;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function compile(re: string, flags?: string): RegExp {
  try {
    return new RegExp(re, flags ?? '');
  } catch (e) {
    throw new Error(`Invalid regex /${re}/${flags ?? ''}: ${(e as Error).message}`);
  }
}

function takeTail(text: string, lines: number): string {
  if (!text) return '';
  const split = text.split('\n');
  if (split.length <= lines) return text;
  return split.slice(-lines).join('\n');
}

function scopeText(
  input: CliStatusInput,
  scope: SpinnerSpec['scope'] | SettledPromptSpec['scope'],
  windowLines: number | undefined,
): string {
  const lines = windowLines && windowLines > 0 ? windowLines : 8;
  switch (scope) {
    case 'whole-screen':
      return input.screenText ?? '';
    case 'recent-buffer':
      return input.tail ?? '';
    case 'last-n-lines':
    case 'live-frame-tail':
    case undefined:
    default:
      return takeTail(input.screenText ?? '', lines);
  }
}

function compileSpinnerMatchers(spec: SpinnerSpec): RegExp[] {
  return spec.patterns.map((p) => compile(p.regex, p.flags ?? 'i'));
}

function spinnerMatches(spec: SpinnerSpec, input: CliStatusInput): boolean {
  const matchers = compileSpinnerMatchers(spec);
  const text = scopeText(input, spec.scope, spec.scopeWindowLines);
  return matchers.some((re) => re.test(text));
}

function compileSettledPromptMatchers(spec: SettledPromptSpec): {
  prompt: RegExp;
  footers: Array<{ test: (s: string) => boolean }>;
} {
  const prompt = compile(spec.regex, spec.flags ?? 'm');
  const footers = (spec.withFooter ?? []).map((f) => {
    if (f.kind === 'regex') {
      const re = compile(f.pattern, f.flags ?? 'i');
      return { test: (s: string) => re.test(s) };
    }
    const needle = f.pattern.toLowerCase();
    return { test: (s: string) => s.toLowerCase().includes(needle) };
  });
  return { prompt, footers };
}

function settledPromptMatches(spec: SettledPromptSpec, input: CliStatusInput): boolean {
  const { prompt, footers } = compileSettledPromptMatchers(spec);
  const text = scopeText(input, spec.scope, spec.scopeWindowLines);
  if (!prompt.test(text)) return false;
  if (footers.length === 0) return true;
  return footers.every((f) => f.test(text));
}

/**
 * Extract approval-button labels from every line matching the modal spec's
 * `buttonPattern`. Mirrors buildParseApprovalFromTui's per-line extraction but
 * scans the whole screen with no question-line anchor, so the cue survives the
 * question line scrolling out of the captured frame during long runs of
 * consecutive approvals.
 */
function extractButtonLabels(spec: ModalSpec, text: string): string[] {
  if (!text) return [];
  const flags = spec.buttonFlags && spec.buttonFlags.includes('m')
    ? spec.buttonFlags
    : `${spec.buttonFlags ?? ''}m`;
  const buttonRe = compile(spec.buttonPattern, flags);
  const labelGroup = Number.isInteger(spec.buttonLabelGroup) && (spec.buttonLabelGroup ?? 0) > 0
    ? spec.buttonLabelGroup!
    : 1;
  const out: string[] = [];
  for (const line of text.split('\n')) {
    buttonRe.lastIndex = 0;
    const m = buttonRe.exec(line);
    if (!m) continue;
    const captured = m[labelGroup] ?? (labelGroup === 1 && m.length > 2 ? m[m.length - 1] : undefined);
    if (captured && captured.trim()) out.push(captured.trim());
  }
  return out;
}

/**
 * (fixB ①) The approval's selectable button block is itself a modal cue.
 * Anchored on approval *verbs* so it generalizes across CLIs without trusting
 * any single spec's `buttonPattern` specificity: a real approval modal offers
 * BOTH an affirmative option (Yes/Allow/Continue/…) and a decline (No/Deny/
 * Cancel/Skip/…). A generic numbered menu, a single prose "1. Yes …" line, or
 * an assistant enumeration lacks that pair and does not fire the cue.
 */
function buttonBlockApprovalCue(spec: ModalSpec, text: string): boolean {
  // Defense-in-depth (mission fb2a7053): even if some caller reaches here on a
  // question picker, its "Enter to select"/"Esc to cancel" footer marks it as a
  // choice, not an approval — never derive an approval cue from picker rows.
  if (/Enter to select/i.test(text) && /Esc to cancel/i.test(text)) return false;
  const labels = extractButtonLabels(spec, text);
  if (labels.length < 2) return false;
  if (pickApprovalButton(labels).index < 0) return false;
  return hasNegativeApprovalOption(labels);
}

// A claude-cli AskUserQuestion picker option row: an optional cursor / checkbox
// followed by a "N." number marker. The picker draws AT LEAST one such row.
const PICKER_OPTION_ROW = /^\s*(?:[❯›>]\s*)?(?:\[[ xX]\]|[☐☒◻◼]\s*)?\d+[.)]\s+\S/m;

/**
 * APPROVAL-PICKER-MISROUTE (mission f1d25e11 / fb2a7053) defense-in-depth: an
 * AskUserQuestion multi-choice picker is NOT an approval modal. Its option rows
 * ("❯ 1. label") can otherwise satisfy the approval button cue and get
 * mis-classified as `waiting_approval`, so the worker's question is surfaced to
 * the coordinator as a task_approval_needed (→ mesh_approve, which cannot answer
 * it), with no promptId for mesh_answer_question.
 *
 * The picker's distinguishing signature is its footer: the claude TUI select
 * hints "Enter to select" AND "Esc to cancel". A genuine tool-consent approval
 * modal (Yes/No/Allow/Deny) NEVER renders that footer pair — it uses the ordinary
 * "? for shortcuts" prompt line instead — so the footer alone reliably separates
 * the two even though BOTH draw numbered option rows.
 *
 * The original guard additionally required the freeform escape hatch ("Type
 * something" / "Chat about this"). That made the guard collapse whenever the
 * escape-hatch rows were absent or scrolled out of the captured frame: the
 * picker then fell through to the approval matchers → waiting_approval. The
 * escape hatch is therefore DOWNGRADED from a required signal to an optional
 * supporting one: the guard now fires on the select footer plus at least one
 * numbered option row (which every picker draws), and the escape hatch merely
 * reinforces an already-matching footer. The numbered-row requirement keeps a
 * bare "Enter to select" string (e.g. inside prose) from being mistaken for a
 * picker.
 */
export function isAskUserQuestionPickerSignature(text: string): boolean {
  if (!text) return false;
  const hasSelectFooter = /Enter to select/i.test(text) && /Esc to cancel/i.test(text);
  if (!hasSelectFooter) return false;
  return PICKER_OPTION_ROW.test(text);
}

function modalMatches(spec: ModalSpec, input: CliStatusInput): boolean {
  // Status-level modal detection is cue-only — does the question appear at all?
  // Button extraction lives in buildParseApprovalFromTui.
  const text = input.screenText ?? '';
  // A question picker (AskUserQuestion) is never an approval — bail before any
  // approval cue can match its numbered option rows (mission f1d25e11).
  if (isAskUserQuestionPickerSignature(text)) return false;
  const question = compile(spec.questionPattern, spec.questionFlags ?? 'i');
  if (question.test(text)) return true;
  for (const variant of spec.questionVariants ?? []) {
    const re = compile(variant.regex, variant.flags ?? 'i');
    if (re.test(text)) return true;
  }
  // The question line can scroll out of the captured frame while the button
  // block (and a residual spinner) remain. Hold the modal cue on the button
  // block alone so waiting_approval does not flap to generating mid-approval.
  if (buttonBlockApprovalCue(spec, text)) return true;
  return false;
}

/**
 * Index (line number) of the last line in `screenText` that carries a modal
 * cue — question line, question variant, or a button-block label line — or -1
 * if none. Used to detect a *stale* modal box: some CLIs (e.g. cursor-agent's
 * "Workspace Trust Required" prompt) never clear their box rows after the user
 * answers. The redraw that replaces the modal with the idle composer is shorter
 * than the box, so the top modal rows linger in the terminal grid. Without a
 * spatial check, the unscoped whole-screen `modalMatches` keeps firing
 * `waiting_approval` forever and the session wedges in `starting` — the
 * startup gate never releases because `detectStatus` never returns `idle`.
 */
function lastModalCueLine(spec: ModalSpec, screenText: string): number {
  if (!screenText) return -1;
  const lines = screenText.split('\n');
  const question = compile(spec.questionPattern, spec.questionFlags ?? 'i');
  const variants = (spec.questionVariants ?? []).map((v) => compile(v.regex, v.flags ?? 'i'));
  const buttonFlags = spec.buttonFlags && spec.buttonFlags.includes('m')
    ? spec.buttonFlags
    : `${spec.buttonFlags ?? ''}m`;
  const buttonRe = compile(spec.buttonPattern, buttonFlags);
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    question.lastIndex = 0;
    if (question.test(line)) { last = i; continue; }
    if (variants.some((re) => { re.lastIndex = 0; return re.test(line); })) { last = i; continue; }
    buttonRe.lastIndex = 0;
    if (buttonRe.test(line)) { last = i; continue; }
  }
  return last;
}

/**
 * True when the modal cue is *stale* — a leftover box the CLI failed to clear —
 * because the live idle composer has repainted BELOW it.
 *
 * The discriminator is spatial, so a live modal (whose own selection cursor /
 * button block can incidentally match a settled-prompt regex) is NOT mistaken
 * for stale:
 *
 *   - A settled-prompt cue must match strictly BELOW the last modal cue line.
 *   - AND at least one non-blank line between them is neither a modal cue nor
 *     part of the settled-prompt match itself (the separator prose).
 *
 * A live modal renders its question + button block FLUSH against its own
 * composer/selection cursor (no intervening prose). A stale box, by contrast,
 * has the CLI's welcome banner / follow-up hint / mode footer repainted between
 * the leftover box rows and the live composer. So the discriminator is: a
 * settled-prompt cue matches strictly BELOW the last modal cue line AND at least
 * one non-blank, non-modal line separates them. That separator is exactly the
 * content a live modal never has between its buttons and its cursor, and it is
 * robust to the terminal-snapshot append that can shuffle the tail window.
 */
function modalSupersededBySettledPrompt(
  modalSpec: ModalSpec,
  settledSpec: SettledPromptSpec | undefined,
  settled: ReturnType<typeof compileSettledPromptMatchers> | null,
  input: CliStatusInput,
): boolean {
  if (!settled || !settledSpec) return false;
  if (settledSpec.scope === 'whole-screen') return false;
  const screenText = input.screenText ?? '';
  if (!screenText) return false;
  const modalLine = lastModalCueLine(modalSpec, screenText);
  if (modalLine < 0) return false;
  const lines = screenText.split('\n');
  const below = lines.slice(modalLine + 1);
  if (below.length === 0) return false;
  // A settled prompt (composer) must render somewhere below the modal box.
  const belowText = below.join('\n');
  if (!settled.prompt.test(belowText)) return false;
  if (settled.footers.length > 0 && !settled.footers.every((f) => f.test(belowText))) return false;
  // Require a real separator between the leftover box and the composer: a
  // non-blank line that is neither a modal cue NOR part of the settled-prompt
  // match itself (its bare-prompt line OR one of its declared footer lines).
  // That separator is the CLI's welcome banner / follow-up hint a stale box
  // shows above the repainted composer. A live modal's selection cursor sits
  // flush against its buttons with no such prose between them (and neither the
  // cursor line nor the composer's own footer — e.g. claude's "? for shortcuts"
  // — is a separator), so an active modal is never misread as stale.
  //
  // Footer exclusion is load-bearing: without it, a live approval modal whose
  // frame also carries the settled composer's footer (question + buttons +
  // "? for shortcuts" + "❯") gets misread as a stale box — the footer line
  // counts as fake "separator prose" — and waiting_approval flips to idle, so
  // the modal is missed and the worker wedges. The footer belongs to the
  // composer, not to any leftover box.
  const question = compile(modalSpec.questionPattern, modalSpec.questionFlags ?? 'i');
  const variants = (modalSpec.questionVariants ?? []).map((v) => compile(v.regex, v.flags ?? 'i'));
  const buttonFlags = modalSpec.buttonFlags && modalSpec.buttonFlags.includes('m')
    ? modalSpec.buttonFlags
    : `${modalSpec.buttonFlags ?? ''}m`;
  const buttonRe = compile(modalSpec.buttonPattern, buttonFlags);
  const isModalCueLine = (line: string): boolean => {
    question.lastIndex = 0;
    if (question.test(line)) return true;
    if (variants.some((re) => { re.lastIndex = 0; return re.test(line); })) return true;
    buttonRe.lastIndex = 0;
    return buttonRe.test(line);
  };
  // A single-line settled regex would let a lone match count as its own line;
  // test each below-line against the prompt regex on that line alone.
  const settledPromptLineRe = compile(settledSpec.regex, (settledSpec.flags ?? 'm').includes('m') ? (settledSpec.flags ?? 'm') : `${settledSpec.flags ?? ''}m`);
  const isSettledLine = (line: string): boolean => {
    settledPromptLineRe.lastIndex = 0;
    if (settledPromptLineRe.test(line)) return true;
    // The composer's own declared footer (e.g. claude's "? for shortcuts") is
    // part of the settled prompt block, not separator prose. Excluding it keeps
    // a live approval modal that also renders the composer footer from being
    // misread as a stale box.
    return settled.footers.some((f) => f.test(line));
  };
  return below.some((line) => line.trim() !== '' && !isModalCueLine(line) && !isSettledLine(line));
}

// ─── Public builder ────────────────────────────────────────────────────

const DEFAULT_ORDER: DispatchGroup[] = ['spinner', 'modal', 'settled-prompt'];

function evaluateGroup(
  group: DispatchGroup,
  spec: DetectStatusTuiSpec,
  input: CliStatusInput,
  compiled: {
    spinner: RegExp[] | null;
    settled: ReturnType<typeof compileSettledPromptMatchers> | null;
  },
): CliStatus | null {
  switch (group) {
    case 'spinner': {
      if (!spec.spinner || !compiled.spinner) return null;
      const text = scopeText(input, spec.spinner.scope, spec.spinner.scopeWindowLines);
      return compiled.spinner.some((re) => re.test(text)) ? 'generating' : null;
    }
    case 'modal': {
      if (!spec.modal) return null;
      if (!modalMatches(spec.modal, input)) return null;
      // A modal cue with the live composer repainted below it (in the settled
      // prompt's own tail scope) is a stale box the CLI failed to clear — yield
      // so settled-prompt/idle can win.
      if (modalSupersededBySettledPrompt(spec.modal, spec.settledPrompt, compiled.settled, input)) return null;
      return 'waiting_approval';
    }
    case 'settled-prompt': {
      if (!spec.settledPrompt || !compiled.settled) return null;
      const text = scopeText(input, spec.settledPrompt.scope, spec.settledPrompt.scopeWindowLines);
      if (!compiled.settled.prompt.test(text)) return null;
      if (compiled.settled.footers.length === 0) return 'idle';
      return compiled.settled.footers.every((f) => f.test(text)) ? 'idle' : null;
    }
    // Groups declared in the catalog but not yet implemented as builder steps
    // return null so they are no-ops in dispatch — declaring them in `order`
    // is forward-compatible. Phase 2 Week 8+ will wire them.
    case 'cue-ordering':
    case 'error-detection':
    case 'approval-stitching':
      return null;
    default:
      return null;
  }
}

export function buildDetectStatusFromTui(spec: DetectStatusTuiSpec): CliDetectStatusFn {
  const compiledSpinner = spec.spinner ? compileSpinnerMatchers(spec.spinner) : null;
  const compiledSettled = spec.settledPrompt
    ? compileSettledPromptMatchers(spec.settledPrompt)
    : null;
  const compiled = { spinner: compiledSpinner, settled: compiledSettled };
  const order = spec.dispatchOrder?.order && spec.dispatchOrder.order.length > 0
    ? spec.dispatchOrder.order
    : DEFAULT_ORDER;

  return function detectStatus(input: CliStatusInput): CliStatus | null {
    // Apply visible-region scoping before running any matchers.
    const effectiveInput: CliStatusInput = spec.visibleRegion
      ? {
          ...input,
          screenText: applyVisibleRegion(spec.visibleRegion, input.screenText ?? ''),
          tail: applyVisibleRegion(spec.visibleRegion, input.tail),
        }
      : input;

    for (const group of order) {
      const verdict = evaluateGroup(group, spec, effectiveInput, compiled);
      if (verdict !== null) return verdict;
    }
    // onNoMatch policy: the builder always returns null when nothing matched.
    // The daemon's outer state machine maps null per the policy below:
    //   'idle'          → caller treats null as idle (default)
    //   'unknown'       → caller keeps status unknown / shows last
    //   'preserve-last' → caller preserves the last reported verdict
    // Encoding this here would require call-site state; instead the daemon
    // reads `dispatchOrder.onNoMatch` from the manifest directly.
    return null;
  };
}

// Internal exports for builder reuse + tests.
export const __internal = {
  scopeText,
  spinnerMatches,
  settledPromptMatches,
  modalMatches,
};
