import type { SessionOwnerAttention } from '../types'

/**
 * Read the owner-attention park off a session row (daemon.metadata
 * SessionEntry / DaemonData). Null when absent or malformed, so a projection
 * that always writes the result clears a previously-set park.
 */
export function readSessionOwnerAttention(source: unknown): SessionOwnerAttention | null {
    const value = source && typeof source === 'object' ? (source as { ownerAttention?: unknown }).ownerAttention : undefined
    if (!value || typeof value !== 'object') return null
    const { stateId, message } = value as { stateId?: unknown; message?: unknown }
    if (typeof stateId !== 'string' || !stateId) return null
    return { stateId, message: typeof message === 'string' ? message : '' }
}
