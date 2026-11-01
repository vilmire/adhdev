/**
 * Deterministic text helpers shared by the skill matcher (`skill-match.ts`)
 * and the procedure-signal detector (`../procedure-signals.ts`): a tokenizer
 * (words, Hangul/CJK bi-grams), keyword extraction, a 64-bit simhash and the
 * Jaccard / Hamming similarities. No I/O, no LLM, no embeddings — the same
 * input always gives the same output (design 2026-11-01-procedure-skills.md
 * §5.2, §6.1).
 */

const STOP_WORDS: ReadonlySet<string> = new Set([
    'the', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are', 'be', 'it', 'its', 'this', 'that',
    'please', 'then', 'also', 'from', 'at', 'by', 'as', 'do', 'does', 'my', 'me', 'we', 'you', 'can', 'will', 'should',
    'all', 'any', 'so', 'if', 'not', 'no', 'yes', 'ok', 'okay', 'now', 'just', 'again', 'how', 'what', 'when', 'which',
]);

/** Things that are never part of a procedure's shape: URLs, paths, hex ids / uuids, bare numbers. */
function stripVolatile(text: string): string {
    return text
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/(?:[A-Za-z]:)?[\w.~-]*(?:\/[\w.@~-]+){1,}\/?/g, ' ')
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ' ')
        .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi, ' ')
        .replace(/\b\d[\d.,:_-]*\b/g, ' ');
}

const TOKEN_RE = /[a-z][a-z0-9]*|[가-힣]+|[぀-ヿ㐀-鿿]+/g;

/**
 * Tokens in order of appearance (duplicates kept). English words ≥ 2 chars
 * minus stop words; Hangul / kana / CJK runs become character bi-grams (a
 * 1-char run stays as is), so particles and spacing differences still overlap.
 */
export function tokenize(text: string): string[] {
    const out: string[] = [];
    for (const m of stripVolatile(String(text ?? '').toLowerCase()).matchAll(TOKEN_RE)) {
        const t = m[0];
        if (/^[a-z]/.test(t)) {
            // Over-long runs are blobs (base64, minified text), not words.
            if (t.length >= 2 && t.length <= 32 && !STOP_WORDS.has(t)) out.push(t);
        } else if (t.length === 1) {
            out.push(t);
        } else {
            for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
        }
    }
    return out;
}

/** Up to `max` distinct tokens, most frequent first (ties: first seen). */
export function keywordsOf(text: string, max = 12): string[] {
    const counts = new Map<string, number>();
    for (const t of tokenize(text)) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()]
        .map(([t, n], i) => ({ t, n, i }))
        .sort((a, b) => b.n - a.n || a.i - b.i)
        .slice(0, max)
        .map((e) => e.t);
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
    const A = new Set(a);
    const B = new Set(b);
    if (A.size === 0 && B.size === 0) return 0;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    return inter / (A.size + B.size - inter);
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

function fnv64(s: string): bigint {
    let h = FNV_OFFSET;
    for (let i = 0; i < s.length; i++) {
        h ^= BigInt(s.charCodeAt(i));
        h = (h * FNV_PRIME) & MASK64;
    }
    return h;
}

/** 64-bit simhash of a token list as 16 hex chars. Empty input → all zeros. */
export function simhash64(tokens: readonly string[]): string {
    const v = new Array<number>(64).fill(0);
    for (const t of tokens) {
        const h = fnv64(t);
        for (let i = 0; i < 64; i++) v[i]! += (h >> BigInt(i)) & 1n ? 1 : -1;
    }
    let out = 0n;
    for (let i = 0; i < 64; i++) if (v[i]! > 0) out |= 1n << BigInt(i);
    return out.toString(16).padStart(16, '0');
}

export function hammingDistance(a: string, b: string): number {
    let x = BigInt(`0x${a || '0'}`) ^ BigInt(`0x${b || '0'}`);
    let n = 0;
    while (x) {
        n += Number(x & 1n);
        x >>= 1n;
    }
    return n;
}
