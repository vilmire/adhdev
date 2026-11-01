/**
 * Entry-text helpers shared by the memory store and its archive-tier modules.
 * Split out of memory-store.ts so the archive/undo/consolidation code can use
 * them without a circular value import.
 */

import { createHash } from 'crypto';

export const MAX_MEMORY_ENTRY_CHARS = 500;

/** Count in Unicode code points (what the budgets are measured in). */
export function charCount(s: string): number {
    return Array.from(s).length;
}

export function firstChars(s: string, n: number): string {
    return Array.from(s).slice(0, n).join('');
}

// eslint-disable-next-line no-control-regex
export const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export type MemoryInvalidFormatReason = 'empty' | 'too_long' | 'separator_line' | 'control_chars' | 'empty_match' | 'bad_kind' | 'bad_scope';

export function validateContent(content: unknown): MemoryInvalidFormatReason | null {
    if (typeof content !== 'string' || !content.trim()) return 'empty';
    const c = content.trim();
    if (charCount(c) > MAX_MEMORY_ENTRY_CHARS) return 'too_long';
    if (c.replace(/\r\n?/g, '\n').split('\n').some((l) => l.trim() === '§')) return 'separator_line';
    if (CONTROL_CHARS.test(c)) return 'control_chars';
    return null;
}

/** Whitespace/case/punctuation-insensitive form used for duplicate detection. */
export function normalizeMemoryText(text: string): string {
    return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** Stable short id of a core-tier entry, derived from its normalized text (never stored). */
export function coreEntryId(text: string): string {
    return createHash('sha1').update(normalizeMemoryText(text)).digest('hex').slice(0, 10);
}

/** Token-set Jaccard similarity in [0,1] over `\p{L}\p{N}` words (similar-pair suggestions). */
export function tokenJaccard(a: string, b: string): number {
    const toks = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    const A = toks(a);
    const B = toks(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter += 1;
    return inter / (A.size + B.size - inter);
}
