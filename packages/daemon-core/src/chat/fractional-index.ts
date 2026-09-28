/**
 * Fractional indexing — order keys that sort lexicographically (plain `<` on
 * JS strings) and always admit a new key between any two neighbours.
 *
 * Design: docs/design/2026-09-28-transcript-message-keyed-storage.md §4.4 —
 * bubble order is carried by a per-bubble `ord` string instead of an ordered
 * id list, so an insert writes one key and a move rewrites only the moved
 * bubble.
 *
 * The scheme is the well-known base62 "integer part + fraction" layout (as in
 * the `fractional-indexing` package): the head character encodes the integer
 * part's length (`a`..`z` positive, `A`..`Z` negative), so repeated appends grow
 * the key logarithmically ("a0" → "az" → "b00" …) rather than one character per
 * few appends, and prepends mirror that. Keys are pure ASCII; the base62 digit
 * order (`0-9A-Za-z`) matches code-unit order, which is what makes `<` correct.
 *
 * Pure, no dependencies. OSS code (AGPL-3.0).
 */

export const BASE_62_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const ZERO = BASE_62_DIGITS[0];
const SMALLEST_INTEGER = `A${ZERO.repeat(26)}`;

function midpoint(a: string, b: string | null): string {
    if (b !== null && a >= b) throw new Error(`fractional-index: ${a} >= ${b}`);
    if (a.slice(-1) === ZERO || (b !== null && b.slice(-1) === ZERO)) {
        throw new Error('fractional-index: trailing zero');
    }
    if (b !== null) {
        // Shared prefix (treating a missing digit of `a` as zero) is copied
        // verbatim; the midpoint is taken on what follows it.
        let n = 0;
        while ((a[n] || ZERO) === b[n]) n += 1;
        if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
    }
    const digitA = a ? BASE_62_DIGITS.indexOf(a[0]) : 0;
    const digitB = b !== null ? BASE_62_DIGITS.indexOf(b[0]) : BASE_62_DIGITS.length;
    if (digitB - digitA > 1) {
        return BASE_62_DIGITS[Math.round(0.5 * (digitA + digitB))];
    }
    // Consecutive digits: descend one position.
    if (b !== null && b.length > 1) return b.slice(0, 1);
    return BASE_62_DIGITS[digitA] + midpoint(a.slice(1), null);
}

function integerLength(head: string): number {
    if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
    if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
    throw new Error(`fractional-index: invalid order key head ${head}`);
}

function integerPart(key: string): string {
    const length = integerLength(key[0]);
    if (length > key.length) throw new Error(`fractional-index: invalid order key ${key}`);
    return key.slice(0, length);
}

export function isValidOrderKey(key: unknown): key is string {
    if (typeof key !== 'string' || key.length === 0) return false;
    if (key === SMALLEST_INTEGER) return false;
    for (const ch of key) if (!BASE_62_DIGITS.includes(ch)) return false;
    try {
        const int = integerPart(key);
        const fraction = key.slice(int.length);
        return !fraction.endsWith(ZERO);
    } catch {
        return false;
    }
}

function assertOrderKey(key: string): void {
    if (!isValidOrderKey(key)) throw new Error(`fractional-index: invalid order key ${key}`);
}

function incrementInteger(x: string): string | null {
    const [head, ...digits] = x.split('');
    let carry = true;
    for (let i = digits.length - 1; carry && i >= 0; i -= 1) {
        const d = BASE_62_DIGITS.indexOf(digits[i]) + 1;
        if (d === BASE_62_DIGITS.length) {
            digits[i] = ZERO;
        } else {
            digits[i] = BASE_62_DIGITS[d];
            carry = false;
        }
    }
    if (carry) {
        if (head === 'Z') return `a${ZERO}`;
        if (head === 'z') return null;
        const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
        if (nextHead > 'a') digits.push(ZERO);
        else digits.pop();
        return nextHead + digits.join('');
    }
    return head + digits.join('');
}

function decrementInteger(x: string): string | null {
    const [head, ...digits] = x.split('');
    let borrow = true;
    for (let i = digits.length - 1; borrow && i >= 0; i -= 1) {
        const d = BASE_62_DIGITS.indexOf(digits[i]) - 1;
        if (d === -1) {
            digits[i] = BASE_62_DIGITS.slice(-1);
        } else {
            digits[i] = BASE_62_DIGITS[d];
            borrow = false;
        }
    }
    if (borrow) {
        if (head === 'a') return `Z${BASE_62_DIGITS.slice(-1)}`;
        if (head === 'A') return null;
        const prevHead = String.fromCharCode(head.charCodeAt(0) - 1);
        if (prevHead < 'Z') digits.push(BASE_62_DIGITS.slice(-1));
        else digits.pop();
        return prevHead + digits.join('');
    }
    return head + digits.join('');
}

/** A key strictly between `a` and `b` (`null` = unbounded on that side). */
export function generateKeyBetween(a: string | null, b: string | null): string {
    if (a !== null) assertOrderKey(a);
    if (b !== null) assertOrderKey(b);
    if (a !== null && b !== null && a >= b) throw new Error(`fractional-index: ${a} >= ${b}`);
    if (a === null) {
        if (b === null) return `a${ZERO}`;
        const ib = integerPart(b);
        const fb = b.slice(ib.length);
        if (ib === SMALLEST_INTEGER) return ib + midpoint('', fb);
        if (ib < b) return ib;
        const decremented = decrementInteger(ib);
        if (decremented === null) throw new Error('fractional-index: cannot decrement any more');
        return decremented;
    }
    if (b === null) {
        const ia = integerPart(a);
        const fa = a.slice(ia.length);
        const incremented = incrementInteger(ia);
        return incremented === null ? ia + midpoint(fa, null) : incremented;
    }
    const ia = integerPart(a);
    const fa = a.slice(ia.length);
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ia === ib) return ia + midpoint(fa, fb);
    const incremented = incrementInteger(ia);
    if (incremented === null) throw new Error('fractional-index: cannot increment any more');
    if (incremented < b) return incremented;
    return ia + midpoint(fa, null);
}

/** `n` ascending keys strictly between `a` and `b`, spread to keep them short. */
export function generateNKeysBetween(a: string | null, b: string | null, n: number): string[] {
    if (n <= 0) return [];
    if (n === 1) return [generateKeyBetween(a, b)];
    if (b === null) {
        let current = generateKeyBetween(a, b);
        const result = [current];
        for (let i = 0; i < n - 1; i += 1) {
            current = generateKeyBetween(current, b);
            result.push(current);
        }
        return result;
    }
    if (a === null) {
        let current = generateKeyBetween(a, b);
        const result = [current];
        for (let i = 0; i < n - 1; i += 1) {
            current = generateKeyBetween(a, current);
            result.push(current);
        }
        result.reverse();
        return result;
    }
    const mid = Math.floor(n / 2);
    const center = generateKeyBetween(a, b);
    return [
        ...generateNKeysBetween(a, center, mid),
        center,
        ...generateNKeysBetween(center, b, n - mid - 1),
    ];
}
