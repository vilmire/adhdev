/**
 * turn-ipc shared runtime-guard primitives (the protocol version stamp and the
 * small structural checks every command decoder composes). Part of the turn-ipc
 * wire contract (./turn-ipc.ts).
 */

import { isEvidenceIdentifier } from './turn-evidence';
import { isRecord } from './protocol/envelope';

// ─── shared primitives ─────────────────────────────────────────────────────

/** Every request in this file is versioned so a responder can reject a shape it predates. */
export const TURN_IPC_PROTOCOL_VERSION = 1 as const

export function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value)
}

export function isNonNegativeInt(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0
}

export function isOptionalId(value: unknown): boolean {
    return value === undefined || isEvidenceIdentifier(value)
}

export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) return false
    }
    return true
}

export function makeGuard<T extends readonly string[]>(values: T): (value: unknown) => value is T[number] {
    const set: ReadonlySet<string> = new Set(values)
    return (value: unknown): value is T[number] => typeof value === 'string' && set.has(value)
}

export function isStringArray(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

export function isOptionalShortString(value: unknown, max = 512): boolean {
    return value === undefined || (typeof value === 'string' && value.trim().length > 0 && value.length <= max)
}

export function isRecordArray(value: unknown): value is readonly Record<string, unknown>[] {
    return Array.isArray(value) && value.every(isRecord)
}

export function isOptionalRecord(value: unknown): boolean {
    return value === undefined || isRecord(value)
}

export function isOptionalBoolean(value: unknown): boolean {
    return value === undefined || typeof value === 'boolean'
}

export function isOptionalString(value: unknown): boolean {
    return value === undefined || typeof value === 'string'
}
