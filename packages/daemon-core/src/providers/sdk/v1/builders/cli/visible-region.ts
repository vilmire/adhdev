/**
 * applyVisibleRegion
 *
 * Scopes the raw terminal text to the "visible region" declared by a
 * `tui/visible-region@1` spec before handing it to detect-status and
 * parse-approval matchers.
 *
 * Scope semantics:
 *   screen   → full text unchanged  (daemon already passes rendered screen)
 *   buffer   → full text unchanged
 *   tail     → last `tailChars` characters (default 4000)
 *   between-anchors → text between most recent (or first) top/bottom anchor
 *                     regex matches; falls back to full text if anchors not found
 *
 * selectAnchor:
 *   "last"  → use the LAST occurrence of the top anchor — useful for providers
 *             like Antigravity that redraw a separator + prompt on every turn;
 *             this excludes all scrollback above the current session frame.
 *   "first" → use the FIRST occurrence (default per schema).
 */

// ─── Spec shape (mirrors tui-visible-region-v1.json) ───────────────────

interface AnchorPatternSpec {
  pattern: string;
  flags?: string;
}

interface AnchorsSpec {
  top?: AnchorPatternSpec;
  bottom?: AnchorPatternSpec;
}

export interface VisibleRegionSpec {
  $schema?: 'adhdev:tui/visible-region@1';
  scope: 'screen' | 'tail' | 'buffer' | 'between-anchors';
  tailChars?: number;
  anchors?: AnchorsSpec;
  selectAnchor?: 'first' | 'last';
  stripCues?: string[];
}

// ─── Helpers ───────────────────────────────────────────────────────────

function compile(re: string, flags?: string): RegExp {
  try {
    return new RegExp(re, flags ?? '');
  } catch (e) {
    throw new Error(`Invalid visible-region anchor regex /${re}/${flags ?? ''}: ${(e as Error).message}`);
  }
}

/**
 * Find all non-overlapping matches of `re` in `text`.
 * Returns them in order of occurrence (earliest first).
 */
function findAllMatches(re: RegExp, text: string): RegExpExecArray[] {
  const results: RegExpExecArray[] = [];
  // Operate on a non-global copy with sticky-safe iteration to avoid
  // mutating the caller's RegExp state.
  const iter = new RegExp(re.source, re.flags.replace('g', '') + 'g');
  let m: RegExpExecArray | null;
  while ((m = iter.exec(text)) !== null) {
    results.push(m);
    // Advance past zero-width matches to prevent infinite loop.
    if (m[0].length === 0) iter.lastIndex += 1;
  }
  return results;
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Apply the visible-region spec to `text` and return the scoped substring.
 * Never throws on missing anchors — falls back to the full text instead.
 */
export function applyVisibleRegion(spec: VisibleRegionSpec, text: string): string {
  if (!text) return text;

  switch (spec.scope) {
    case 'screen':
    case 'buffer':
      return text;

    case 'tail': {
      const limit = spec.tailChars ?? 4000;
      if (text.length <= limit) return text;
      return text.slice(-limit);
    }

    case 'between-anchors': {
      const anchors = spec.anchors;
      if (!anchors?.top && !anchors?.bottom) return text;

      const selectLast = (spec.selectAnchor ?? 'first') === 'last';

      // ── Top anchor ──
      let topEnd = 0; // default: start of text
      if (anchors.top) {
        const topRe = compile(anchors.top.pattern, anchors.top.flags);
        const topMatches = findAllMatches(topRe, text);
        if (topMatches.length === 0) {
          // Top anchor not found — fall back to full text.
          return text;
        }
        const chosen = selectLast
          ? topMatches[topMatches.length - 1]
          : topMatches[0];
        // Region starts just after the end of the top anchor match.
        topEnd = chosen.index + chosen[0].length;
      }

      // ── Bottom anchor ──
      let bottomStart = text.length; // default: end of text
      if (anchors.bottom) {
        const bottomRe = compile(anchors.bottom.pattern, anchors.bottom.flags);
        // Only search the portion that comes AFTER the top anchor end so we
        // always pick the immediately-following bottom anchor.
        const searchFrom = topEnd;
        const suffix = text.slice(searchFrom);
        const bottomMatches = findAllMatches(bottomRe, suffix);
        if (bottomMatches.length === 0) {
          // Bottom anchor not found — fall back to full text.
          return text;
        }
        const chosen = selectLast
          ? bottomMatches[bottomMatches.length - 1]
          : bottomMatches[0];
        bottomStart = searchFrom + chosen.index;
      }

      if (topEnd >= bottomStart) {
        // Degenerate / overlapping anchors — fall back to full text.
        return text;
      }

      return text.slice(topEnd, bottomStart);
    }

    default:
      return text;
  }
}
