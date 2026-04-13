import { getDebugRuntimeConfig, shouldCollectTraceCategory } from './debug-config.js'

export type DebugTraceLevel = 'debug' | 'info' | 'warn' | 'error'

export interface DebugTraceEvent {
  interactionId?: string
  category: string
  stage: string
  level: DebugTraceLevel
  sessionId?: string
  providerType?: string
  payload?: Record<string, unknown>
}

export interface DebugTraceEntry extends DebugTraceEvent {
  id: string
  ts: number
}

export interface DebugTraceStoreOptions {
  enabled: boolean
  capacity: number
}

export interface DebugTraceQuery {
  interactionId?: string
  category?: string
  limit?: number
}

export interface DebugTraceStore {
  record(event: DebugTraceEvent): DebugTraceEntry | null
  list(query?: DebugTraceQuery): DebugTraceEntry[]
  clear(): void
}

function summarizeString(value: string): string {
  return `[${value.length} chars]`
}

function sanitizeTraceValue(value: unknown, traceContent: boolean): unknown {
  if (traceContent) {
    if (Array.isArray(value)) return value.map((entry) => sanitizeTraceValue(entry, traceContent))
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, sanitizeTraceValue(nested, traceContent)]),
      )
    }
    return value
  }

  if (typeof value === 'string') return summarizeString(value)
  if (Array.isArray(value)) return value.map((entry) => sanitizeTraceValue(entry, traceContent))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, sanitizeTraceValue(nested, traceContent)]),
    )
  }
  return value
}

export function sanitizeTracePayload(payload?: Record<string, unknown>): Record<string, unknown> {
  if (!payload) return {}
  const { traceContent } = getDebugRuntimeConfig()
  return sanitizeTraceValue(payload, traceContent) as Record<string, unknown>
}

function createEntry(event: DebugTraceEvent): DebugTraceEntry {
  return {
    id: `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    ...event,
    payload: sanitizeTracePayload(event.payload),
  }
}

export function createDebugTraceStore(options: DebugTraceStoreOptions): DebugTraceStore {
  const entries: DebugTraceEntry[] = []
  const capacity = Math.max(1, Math.floor(options.capacity || 100))

  return {
    record(event: DebugTraceEvent): DebugTraceEntry | null {
      if (!options.enabled) return null
      const entry = createEntry(event)
      entries.push(entry)
      if (entries.length > capacity) {
        entries.splice(0, entries.length - capacity)
      }
      return entry
    },
    list(query: DebugTraceQuery = {}): DebugTraceEntry[] {
      const limit = Math.max(1, Math.floor(query.limit || 100))
      return entries
        .filter((entry) => !query.interactionId || entry.interactionId === query.interactionId)
        .filter((entry) => !query.category || entry.category === query.category)
        .slice(-limit)
        .map((entry) => ({ ...entry, payload: entry.payload ? { ...entry.payload } : {} }))
    },
    clear(): void {
      entries.splice(0, entries.length)
    },
  }
}

let globalStore = createDebugTraceStore({ enabled: false, capacity: getDebugRuntimeConfig().traceBufferSize })

export function configureDebugTraceStore(): void {
  const config = getDebugRuntimeConfig()
  globalStore = createDebugTraceStore({
    enabled: config.collectDebugTrace,
    capacity: config.traceBufferSize,
  })
}

export function recordDebugTrace(event: DebugTraceEvent): DebugTraceEntry | null {
  if (!shouldCollectTraceCategory(event.category)) return null
  return globalStore.record(event)
}

export function getRecentDebugTrace(query: DebugTraceQuery = {}): DebugTraceEntry[] {
  return globalStore.list(query)
}

export function clearDebugTrace(): void {
  globalStore.clear()
}

export function createInteractionId(prefix = 'ix'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
