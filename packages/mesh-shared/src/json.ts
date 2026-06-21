/**
 * Pure JSON-record reading primitives shared by the cloud (web-core / P2P transit)
 * and standalone (daemon-core / local IPC) mesh normalizers.
 *
 * These operate only on plain JS values — no Node/DOM APIs, no transport, no git
 * exec — so both cores can import them without violating the core↔core dependency
 * ban. They are the single source of truth for the field-coercion rules that the
 * two transports previously hand-synced (and drifted on).
 */

export type JsonRecord = Record<string, unknown>

export function readRecord(value: unknown): JsonRecord {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

export function readString(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value !== 'string') continue
        const trimmed = value.trim()
        if (trimmed) return trimmed
    }
    return undefined
}

export function readNumber(...values: unknown[]): number | undefined {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) return value
    }
    return undefined
}

export function readBoolean(...values: unknown[]): boolean | undefined {
    for (const value of values) {
        if (typeof value === 'boolean') return value
    }
    return undefined
}

export function readStringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : []
}

/**
 * Coerce a value that is either an already-parsed plain object or a JSON string
 * into a plain object record. Arrays, primitives, parse failures and empty
 * strings all collapse to {} — callers treat the result as a best-effort record.
 *
 * This is the single source of truth for the `parseJsonRecord`/`parseJsonObject`
 * coercion that cloud mesh normalizers previously hand-redefined per file.
 */
export function parseJsonRecord(value: unknown): JsonRecord {
    if (!value) return {}
    if (typeof value === 'object') return readRecord(value)
    if (typeof value !== 'string') return {}
    const trimmed = value.trim()
    if (!trimmed) return {}
    try {
        return readRecord(JSON.parse(trimmed))
    } catch {
        return {}
    }
}

/**
 * Join a (possibly absent) repo root with a relative submodule path. Returns the
 * path unchanged when it is already absolute, and undefined when nothing usable
 * can be derived — callers must treat the result as optional.
 */
export function joinRepoPath(root: string | undefined, relativePath: string | undefined): string | undefined {
    const normalizedRoot = typeof root === 'string' ? root.trim().replace(/[\\/]+$/, '') : ''
    const normalizedPath = typeof relativePath === 'string' ? relativePath.trim() : ''
    if (!normalizedPath) return undefined
    if (/^(?:[A-Za-z]:[\\/]|\/)/.test(normalizedPath)) return normalizedPath
    if (!normalizedRoot) return undefined
    return `${normalizedRoot}/${normalizedPath.replace(/^[\\/]+/, '')}`
}
