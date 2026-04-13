import type { DaemonData } from '../types'

export function summarizeDaemonEntriesForDebug(entries: DaemonData[]): {
  count: number
  ids: string[]
  statuses: string[]
  transports: Record<string, number>
} {
  const transports: Record<string, number> = {}
  for (const entry of entries) {
    if (entry.transport) {
      transports[entry.transport] = (transports[entry.transport] || 0) + 1
    }
  }

  return {
    count: entries.length,
    ids: entries.map((entry) => entry.id),
    statuses: entries.map((entry) => String(entry.status || 'unknown')),
    transports,
  }
}
