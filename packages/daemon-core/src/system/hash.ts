/**
 * Shared SHA-256 hashing helpers for daemon-core (Node runtime).
 *
 * daemon-core runs under Node, so it uses `node:crypto` directly and must NOT
 * import the server's WebCrypto-based `utils/crypto.ts` (different runtime +
 * cross-package dependency direction). Output is byte-identical to that helper
 * for the same input — lowercase hex SHA-256.
 */
import { createHash } from 'node:crypto';

/** Full lowercase hex SHA-256 digest of `input`. */
export function sha256Hex(input: string): string {
    return createHash('sha256').update(input).digest('hex');
}

/**
 * Truncated SHA-256 hex digest — the first `length` hex chars (default 16).
 * Used for stable short identifiers (workspace hashes, token ids, coordinator
 * home dirs) where collision risk at 16 hex chars (64 bits) is negligible.
 */
export function shortHash(input: string, length = 16): string {
    return sha256Hex(input).slice(0, length);
}
