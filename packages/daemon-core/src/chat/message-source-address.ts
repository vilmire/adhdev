/**
 * Message source addresses — the daemon-internal `_src` stamp.
 *
 * Design: docs/design/2026-09-28-transcript-message-keyed-storage.md §3.2–§3.3.
 *
 * A reader that knows WHERE in its source a bubble came from stamps that
 * address on the message as `_src`. The per-session message identity ledger
 * (`message-identity-ledger.ts`) turns an address into a stable, opaque
 * `messageId`:
 *
 *   - `cls:'n'`   native, deterministic: `n.<L>.<addr>` is reproducible from the
 *                 source alone, so a restart re-derives the same id with no
 *                 persisted state. `L` is a lineage token (hash of the history
 *                 session id — an identifier, never content).
 *   - `cls:'rt'`  a CLI runtime overlay row, keyed by its local dedup key.
 *   - `cls:'acp'` an ACP-instance-owned row, keyed by an instance-local id
 *                 (partial → final succession reuses the SAME id, §3.4).
 *
 * Messages without `_src` (PTY parse, IDE DOM, best-effort fallbacks) are
 * identified by the ledger's aligner instead.
 *
 * ★ `_src` is DAEMON-INTERNAL. It must never reach the replica wire (L2) —
 * `check:message-projection-parity` lists it as a forbidden wire field — and
 * the read_chat choke point strips it from everything it returns. Some rows
 * (`rt:user_input_ack:<hash>`) embed a local content hash in their key; that is
 * acceptable only because the key never leaves this process.
 *
 * Pure: no I/O, no daemon state. OSS code (AGPL-3.0).
 */

import { createHash } from 'crypto';

export type MessageSourceAddress =
    | { readonly cls: 'n'; readonly L: string; readonly addr: string }
    | { readonly cls: 'rt'; readonly key: string }
    | { readonly cls: 'acp'; readonly id: string };

/** Script/sqlite-supplied native ids are normalized and capped to this length (§3.2). */
export const NATIVE_ID_TOKEN_MAX_BYTES = 40;
/** Address of the synthesized `session_start` record a reader emits once. */
export const SESSION_START_ADDRESS = 's';

const ADDR_RE = /^[a-z0-9._-]{1,48}$/;
const LINEAGE_RE = /^[0-9a-f]{8}$/;
const LOCAL_KEY_MAX_LENGTH = 256;

/** `hex8(sha256(historySessionId))` — identifies the source lineage, not its content. */
export function lineageToken(historySessionId: string): string {
    return createHash('sha256').update(String(historySessionId)).digest('hex').slice(0, 8);
}

/**
 * The jsonl-style address `recordIndex "." (blockIndex + 1)`. `blockIndex -1`
 * (a record that IS its bubble, or string content) maps to part 0, so a record
 * that yields a prose bubble plus N tool blocks addresses them `.0`, `.1`… .
 */
export function recordBlockAddress(recordIndex: number, blockIndex: number): string | undefined {
    if (!Number.isInteger(recordIndex) || recordIndex < 0) return undefined;
    if (!Number.isInteger(blockIndex) || blockIndex < -1) return undefined;
    return `${recordIndex}.${blockIndex + 1}`;
}

/** hermes `messages.id` row address: `h<rowId>.<part>`. */
export function rowIdAddress(rowId: unknown, part = 0): string | undefined {
    const token = normalizeNativeIdToken(rowId);
    if (!token || !Number.isInteger(part) || part < 0) return undefined;
    return `h${token}.${part}`;
}

/** Script/manifest-supplied native id address: `k<nativeId>.<part>`. */
export function keyedNativeAddress(nativeId: unknown, part = 0): string | undefined {
    const token = normalizeNativeIdToken(nativeId);
    if (!token || !Number.isInteger(part) || part < 0) return undefined;
    return `k${token}.${part}`;
}

/**
 * Charset-normalize a source-supplied identifier (DOM id, sqlite id) into
 * `[a-z0-9_-]`, capped at {@link NATIVE_ID_TOKEN_MAX_BYTES}. Lower-casing can
 * make two distinct ids collide; the ledger detects an in-frame collision and
 * demotes the duplicate to the aligner class (§3.2).
 */
export function normalizeNativeIdToken(raw: unknown): string {
    if (typeof raw !== 'string' && typeof raw !== 'number') return '';
    const text = String(raw).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
    return text.slice(0, NATIVE_ID_TOKEN_MAX_BYTES);
}

/** Build a native `_src`, or undefined when the lineage or address is unknown. */
export function nativeSourceAddress(historySessionId: unknown, addr: string | undefined): MessageSourceAddress | undefined {
    const session = typeof historySessionId === 'string' ? historySessionId.trim() : '';
    if (!session || !addr || !ADDR_RE.test(addr)) return undefined;
    return { cls: 'n', L: lineageToken(session), addr };
}

export function runtimeSourceAddress(dedupKey: unknown): MessageSourceAddress | undefined {
    const key = typeof dedupKey === 'string' ? dedupKey.trim() : '';
    if (!key || key.length > LOCAL_KEY_MAX_LENGTH) return undefined;
    return { cls: 'rt', key };
}

export function acpSourceAddress(localId: unknown): MessageSourceAddress | undefined {
    const id = typeof localId === 'string' ? localId.trim() : '';
    if (!id || id.length > LOCAL_KEY_MAX_LENGTH) return undefined;
    return { cls: 'acp', id };
}

/** Ledger lookup key (`bySrc`, §3.3). Process-local; never on any wire. */
export function messageSourceKey(src: MessageSourceAddress): string {
    switch (src.cls) {
        case 'n': return `n:${src.L}.${src.addr}`;
        case 'rt': return `rt:${src.key}`;
        case 'acp': return `acp:${src.id}`;
    }
}

/** The deterministic `n.<L>.<addr>` id for a native address; null for other classes. */
export function naturalMessageId(src: MessageSourceAddress): string | null {
    if (src.cls !== 'n') return null;
    return `n.${src.L}.${src.addr}`;
}

/**
 * Validate an untrusted `_src` value (the read_chat contract is an allow-list
 * and re-reads this field shape-checked, never spread). Returns a fresh object
 * so a caller can never smuggle extra properties through it.
 */
export function readMessageSourceAddress(value: unknown): MessageSourceAddress | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    switch (record.cls) {
        case 'n': {
            const L = typeof record.L === 'string' ? record.L : '';
            const addr = typeof record.addr === 'string' ? record.addr : '';
            if (!LINEAGE_RE.test(L) || !ADDR_RE.test(addr)) return undefined;
            return { cls: 'n', L, addr };
        }
        case 'rt':
            return runtimeSourceAddress(record.key);
        case 'acp':
            return acpSourceAddress(record.id);
        default:
            return undefined;
    }
}

/**
 * Return `messages` with every `_src` removed (same array when none carried
 * one). For surfaces that hand native-history rows to a consumer WITHOUT
 * passing the read_chat choke point (e.g. `chat_history`).
 */
export function stripMessageSourceAddresses<T>(messages: T[]): T[] {
    if (!Array.isArray(messages) || !messages.some((m) => m && typeof m === 'object' && '_src' in (m as object))) {
        return messages;
    }
    return messages.map((message) => {
        if (!message || typeof message !== 'object' || !('_src' in (message as object))) return message;
        const { _src, ...rest } = message as T & { _src?: unknown };
        void _src;
        return rest as T;
    });
}

/** Native `_src` for a jsonl-style `(recordIndex, blockIndex)` position. */
export function recordBlockSource(historySessionId: unknown, recordIndex: number, blockIndex: number): MessageSourceAddress | undefined {
    return nativeSourceAddress(historySessionId, recordBlockAddress(recordIndex, blockIndex));
}
