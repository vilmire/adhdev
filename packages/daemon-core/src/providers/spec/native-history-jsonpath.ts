/**
 * The two spec-field readers every native-history path shares: `jsonPathGet`
 * (resolve a `message_map` location against a record) and `stringifyContent`
 * (collapse structured content to renderable text). The parser, the tool-block
 * projector and the on-demand expand path (`tool-block-expand.ts`) all import
 * them from here, so they can never disagree about which field a spec entry
 * names or how its text is rendered.
 */

/**
 * Resolve `$.a.b[0].c` against a record. Strings without leading `$` are
 * literals. Supports `||` fallback between paths so a single message_map
 * entry can pick the first non-empty value across alternative locations
 * (e.g. agy's content vs. thinking).
 */
export function jsonPathGet(record: any, expr: string): unknown {
    if (typeof expr !== 'string') return undefined;
    if (expr.includes('||')) {
        for (const alt of expr.split('||')) {
            const v = jsonPathGet(record, alt.trim());
            if (v != null && v !== '') return v;
        }
        return undefined;
    }
    if (!expr.startsWith('$')) return expr;
    let cur: any = record;
    let i = 1;
    while (i < expr.length && cur != null) {
        const ch = expr[i];
        if (ch === '.') { i += 1; continue; }
        if (ch === '[') {
            const close = expr.indexOf(']', i);
            if (close < 0) return undefined;
            const idx = Number(expr.slice(i + 1, close));
            if (!Number.isInteger(idx)) return undefined;
            cur = cur[idx];
            i = close + 1;
            continue;
        }
        let end = i;
        while (end < expr.length && expr[end] !== '.' && expr[end] !== '[') end += 1;
        const key = expr.slice(i, end);
        cur = cur[key];
        i = end;
    }
    return cur;
}

/**
 * Coerce a content value to a plain string the dashboard can render.
 *
 * Many providers ship structured content (claude messages are arrays of
 * typed blocks: text / tool_use / tool_result). We collapse those to
 * their text-bearing parts so the dashboard doesn't show raw JSON
 * fragments in the transcript. Tool calls/results are intentionally
 * dropped — the daemon's chat schema is for user-visible turns.
 *
 * Order of attempts:
 *   1. string                          → as-is
 *   2. array of blocks                 → join the `text` field of each
 *                                        block that has one; if none have
 *                                        a text field, fall through
 *   3. object with a top-level `text`  → that string
 *   4. last resort                     → JSON.stringify
 */
export function stringifyContent(v: unknown): string {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) {
        const parts: string[] = [];
        for (const block of v) {
            if (block == null) continue;
            if (typeof block === 'string') { parts.push(block); continue; }
            if (typeof block === 'object') {
                const t = (block as any).text;
                if (typeof t === 'string' && t) { parts.push(t); continue; }
                // tool_use / tool_result / image / etc — skip from the
                // user-facing transcript. They re-surface via the
                // adapter's tool-event channel if/when that's wired.
            }
        }
        if (parts.length > 0) return parts.join('\n');
        return '';
    }
    if (typeof v === 'object') {
        const t = (v as any).text;
        if (typeof t === 'string') return t;
    }
    try { return JSON.stringify(v); } catch { return String(v); }
}
