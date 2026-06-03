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

function modalMatches(spec: ModalSpec, input: CliStatusInput): boolean {
  // Status-level modal detection is cue-only — does the question appear at all?
  // Button extraction lives in buildParseApprovalFromTui.
  const text = input.screenText ?? '';
  const question = compile(spec.questionPattern, spec.questionFlags ?? 'i');
  if (question.test(text)) return true;
  for (const variant of spec.questionVariants ?? []) {
    const re = compile(variant.regex, variant.flags ?? 'i');
    if (re.test(text)) return true;
  }
  return false;
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
      return modalMatches(spec.modal, input) ? 'waiting_approval' : null;
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
