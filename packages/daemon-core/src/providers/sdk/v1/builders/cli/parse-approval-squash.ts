/**
 * buildParseApprovalFromSquash
 *
 * Companion to buildParseApprovalFromTui. Handles the squashed-modal case:
 * the terminal has re-flowed the approval frame so the rendered text is a
 * single run of lowercase-alnum bytes (e.g. `doyoutrustthecontentsofthisdirectory…1yescontinue2noquit`).
 *
 * Author declares:
 *   - `cues`        — compact substrings/regexes that identify the modal
 *   - `footers`     — optional compact substrings that must also be present
 *   - `buttonRules` — compact→labels mappings used to recover button labels
 *
 * Returns the same shape as buildParseApprovalFromTui — a CliApprovalModal
 * (message + buttons) or null when no rule matches. Caller composes the two
 * builders: try the regular modal first, then fall back to squash. Codex
 * needs both because at narrow widths the terminal renders the squash form,
 * and at wider widths it renders the regular framed form.
 */

import type {
  CliApprovalInput,
  CliApprovalModal,
  CliParseApprovalFn,
} from '../../types/cli/index.js';

// ─── Spec mirrors the JSON schema ─────────────────────────────────────

interface SquashCueSpec {
  compact: string;
  kind?: 'substring' | 'regex';
  label?: string;
  messageWhenMatched?: string;
}

interface SquashFooterSpec {
  compact: string;
  kind?: 'substring' | 'regex';
}

interface SquashButtonRuleSpec {
  compact: string;
  kind?: 'substring' | 'regex';
  labels: string[];
}

export interface ApprovalSquashSpec {
  $schema: 'adhdev:tui/approval-squash@1';
  cues: SquashCueSpec[];
  footers?: SquashFooterSpec[];
  buttonRules: SquashButtonRuleSpec[];
  scope?: 'tail-window' | 'whole-screen';
  tailWindowLines?: number;
}

// ─── Internals ────────────────────────────────────────────────────────

const COMPACT_RE = /[^a-z0-9]+/g;

/**
 * The canonical normalisation. Identical to codex-cli's `compactText`:
 * lowercase, then strip everything that is not a-z or 0-9.
 *
 * Exported for tests and for the (rare) provider that wants to compose this
 * with extra normalisation steps.
 */
export function compactText(value: string): string {
  return String(value || '').toLowerCase().replace(COMPACT_RE, '');
}

function compileRegex(source: string, flags = 'i'): RegExp {
  try { return new RegExp(source, flags); }
  catch (e) { throw new Error(`Invalid regex /${source}/${flags}: ${(e as Error).message}`); }
}

function matchSubstringOrRegex(
  needle: string,
  kind: 'substring' | 'regex' | undefined,
  haystack: string,
): boolean {
  if (kind === 'regex') return compileRegex(needle).test(haystack);
  return haystack.includes(needle);
}

function scopeText(spec: ApprovalSquashSpec, input: CliApprovalInput): string {
  const scope = spec.scope ?? 'tail-window';
  const candidates = [
    String(input.screenText || ''),
    String(input.rawBuffer || ''),
    String(input.buffer || ''),
    String(input.tail || ''),
  ].filter(Boolean);
  const joined = candidates.join('\n');
  if (scope === 'whole-screen') return joined;
  const tailLines = spec.tailWindowLines ?? 24;
  return joined.split('\n').slice(-tailLines).join('\n');
}

// ─── Public builder ───────────────────────────────────────────────────

export function buildParseApprovalFromSquash(spec: ApprovalSquashSpec): CliParseApprovalFn {
  if (!Array.isArray(spec.cues) || spec.cues.length === 0) {
    throw new Error('approval-squash spec must declare at least one cue.');
  }
  if (!Array.isArray(spec.buttonRules) || spec.buttonRules.length === 0) {
    throw new Error('approval-squash spec must declare at least one button rule.');
  }

  return function parseApproval(input: CliApprovalInput): CliApprovalModal | null {
    const text = scopeText(spec, input);
    if (!text) return null;
    const compact = compactText(text);
    if (!compact) return null;

    // 1) Find the first matching cue. Its messageWhenMatched (if present) is
    //    the human-readable modal message; otherwise we fall back to a label
    //    or empty string.
    let matchedCue: SquashCueSpec | null = null;
    for (const cue of spec.cues) {
      if (matchSubstringOrRegex(cue.compact, cue.kind, compact)) {
        matchedCue = cue;
        break;
      }
    }
    if (!matchedCue) return null;

    // 2) If footers are declared, at least one must also match.
    if (spec.footers && spec.footers.length > 0) {
      const anyFooter = spec.footers.some((f) =>
        matchSubstringOrRegex(f.compact, f.kind, compact),
      );
      if (!anyFooter) return null;
    }

    // 3) Find a button rule whose compact pattern is present in the compacted
    //    text. First match wins.
    let labels: string[] | null = null;
    for (const rule of spec.buttonRules) {
      if (matchSubstringOrRegex(rule.compact, rule.kind, compact)) {
        labels = rule.labels;
        break;
      }
    }
    if (!labels || labels.length === 0) return null;

    const message = matchedCue.messageWhenMatched
      || matchedCue.label
      || '';

    return { message, buttons: [...labels] };
  };
}

// Internal exports for tests.
export const __internal = {
  compactText,
  matchSubstringOrRegex,
  scopeText,
};
