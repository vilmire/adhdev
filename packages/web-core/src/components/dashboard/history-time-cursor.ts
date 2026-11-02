/**
 * "Load earlier" paging cursor - web-core half of daemon-core's
 * `config/chat-history-tail.ts` (`buildHistoryTimeCursor`).
 *
 * Wire form `ts:<receivedAt>:<role>:<hash8>`, sent in `chat_history`'s
 * `excludeFromIdentity`. It anchors a page to the oldest row the pane already
 * shows, by TIME, so rows arriving between pages cannot shift the boundary the
 * way a count taken against a moving history length does.
 *
 * ★ `hashHistoryCursorContent` MUST stay byte-identical to the daemon's (FNV-1a
 * 32-bit over whitespace-normalized content); `history-time-cursor-parity.test`
 * pins the two together. (web-core may not value-import the daemon-core barrel.)
 */
export function hashHistoryCursorContent(content: unknown): string {
    const text = (typeof content === 'string' ? content : '').replace(/\s+/g, ' ').trim()
    let hash = 0x811c9dc5
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, '0')
}

interface CursorRow { receivedAt?: number | null; role?: string; content?: unknown }

/** '' when the row has no usable timestamp (the caller then pages by count). */
export function buildHistoryTimeCursor(row: CursorRow | undefined): string {
    if (!row) return ''
    const at = Number(row.receivedAt)
    if (!Number.isFinite(at) || at <= 0) return ''
    return `ts:${Math.floor(at)}:${row.role || ''}:${hashHistoryCursorContent(row.content)}`
}

/** Dedup key across live / spilled / paged rows; '' when the row cannot be keyed by time. */
export function historyRowDedupeKey(row: CursorRow | undefined): string {
    if (!row) return ''
    const at = Number(row.receivedAt)
    if (!Number.isFinite(at) || at <= 0) return ''
    return `${Math.floor(at)}|${row.role || ''}|${hashHistoryCursorContent(row.content)}`
}
