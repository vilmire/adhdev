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

export interface DetectStatusTuiSpec {
  spinner?: SpinnerSpec;
  settledPrompt?: SettledPromptSpec;
  modal?: ModalSpec;
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

export function buildDetectStatusFromTui(spec: DetectStatusTuiSpec): CliDetectStatusFn {
  const compiledSpinner = spec.spinner ? compileSpinnerMatchers(spec.spinner) : null;
  const compiledSettled = spec.settledPrompt
    ? compileSettledPromptMatchers(spec.settledPrompt)
    : null;
  // Modal compilation is recomputed each call because the question + variants
  // share a small RegExp set we don't need to memoise heavily. Cheap on hot path.

  return function detectStatus(input: CliStatusInput): CliStatus | null {
    // Order matters — see file header docstring.

    // 1. Generation cues
    if (spec.spinner && compiledSpinner) {
      const text = scopeText(input, spec.spinner.scope, spec.spinner.scopeWindowLines);
      if (compiledSpinner.some((re) => re.test(text))) return 'generating';
    }

    // 2. Modal cue
    if (spec.modal && modalMatches(spec.modal, input)) {
      return 'waiting_approval';
    }

    // 3. Settled prompt
    if (spec.settledPrompt && compiledSettled) {
      const text = scopeText(input, spec.settledPrompt.scope, spec.settledPrompt.scopeWindowLines);
      if (compiledSettled.prompt.test(text)) {
        if (compiledSettled.footers.length === 0 || compiledSettled.footers.every((f) => f.test(text))) {
          return 'idle';
        }
      }
    }

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
