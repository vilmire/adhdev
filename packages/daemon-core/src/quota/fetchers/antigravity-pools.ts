import { toIsoResetMs, toNumber } from './coerce.js';

/**
 * The quota pool a group/bucket belongs to. Antigravity shares one weekly and
 * one 5h limit per MODEL GROUP: "Gemini Models" (gemini-weekly, gemini-5h) vs
 * "Claude and GPT models" (3p-weekly, 3p-5h). Unknown pools return null and
 * stay ungrouped (routing then keeps the conservative headline).
 */
export function quotaPoolOf(groupLabel: string | null, bucket: Record<string, unknown>): string | null {
    const label = (groupLabel ?? '').trim().toLowerCase();
    const id = typeof bucket.bucketId === 'string' ? bucket.bucketId.trim().toLowerCase() : '';
    if (/^gemini/.test(label) || /^gemini/.test(id)) return 'gemini';
    if (/^(?:claude|gpt)/.test(label) || /^3p-/.test(id)) return 'claude-gpt';
    return null;
}

/**
 * ★An EXHAUSTED bucket can arrive with NO remaining member at all: proto3 JSON
 * drops zero-valued scalars, so "0 left" is serialized as an absent
 * `remainingFraction`. Dropping such a bucket erased exactly the pool that was
 * out of quota and let the other pool's healthy headline speak for the whole
 * account (owner screen 2026-10-23: Gemini weekly 0% left, ADHDev "clear").
 * A live bucket always carries its fraction (every captured sample does, even
 * at 1.0), so a bucket with a reset stamp and neither remaining member — or a
 * `remainingAmount` of 0 — is read as 0 left. Callers already skip `disabled`.
 */
export function exhaustedByOmission(bucket: Record<string, unknown>): boolean {
    if (bucket.remainingFraction === undefined && bucket.remainingAmount === undefined
        && toIsoResetMs(bucket.resetTime) !== null) {
        return true;
    }
    const amount = toNumber(bucket.remainingAmount);
    return amount !== null && amount <= 0;
}
