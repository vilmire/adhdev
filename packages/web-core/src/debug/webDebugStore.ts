export interface WebDebugEvent {
  interactionId?: string
  kind: string
  topic?: string
  payload?: Record<string, unknown>
}

export interface WebDebugEntry extends WebDebugEvent {
  id: string
  ts: number
}

export interface WebDebugQuery {
  interactionId?: string
  topic?: string
  kind?: string
  limit?: number
}

export interface WebDebugStore {
  record(event: WebDebugEvent): WebDebugEntry
  list(query?: WebDebugQuery): WebDebugEntry[]
  clear(): void
}

export function createWebDebugStore(options: { capacity?: number } = {}): WebDebugStore {
  const capacity = Math.max(1, Math.floor(options.capacity || 200))
  const entries: WebDebugEntry[] = []

  return {
    record(event: WebDebugEvent): WebDebugEntry {
      const entry: WebDebugEntry = {
        id: `webdbg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        ts: Date.now(),
        ...event,
        payload: event.payload ? { ...event.payload } : {},
      }
      entries.push(entry)
      if (entries.length > capacity) {
        entries.splice(0, entries.length - capacity)
      }
      return entry
    },
    list(query: WebDebugQuery = {}): WebDebugEntry[] {
      const limit = Math.max(1, Math.floor(query.limit || 100))
      return entries
        .filter((entry) => !query.interactionId || entry.interactionId === query.interactionId)
        .filter((entry) => !query.topic || entry.topic === query.topic)
        .filter((entry) => !query.kind || entry.kind === query.kind)
        .slice(-limit)
        .map((entry) => ({ ...entry, payload: entry.payload ? { ...entry.payload } : {} }))
    },
    clear(): void {
      entries.splice(0, entries.length)
    },
  }
}

export const webDebugStore = createWebDebugStore()
