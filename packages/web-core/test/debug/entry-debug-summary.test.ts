import { describe, expect, it } from 'vitest'
import { summarizeDaemonEntriesForDebug } from '../../src/debug/entryDebugSummary'

describe('entryDebugSummary', () => {
  it('summarizes entry ids, statuses, and transport counts', () => {
    const summary = summarizeDaemonEntriesForDebug([
      { id: 'daemon_1', type: 'adhdev-daemon', status: 'online' },
      { id: 'daemon_1:ide:a', type: 'cursor', status: 'idle', transport: 'cdp-page' },
      { id: 'daemon_1:cli:b', type: 'claude-cli', status: 'generating', transport: 'pty' },
    ] as any)

    expect(summary).toEqual({
      count: 3,
      ids: ['daemon_1', 'daemon_1:ide:a', 'daemon_1:cli:b'],
      statuses: ['online', 'idle', 'generating'],
      transports: { 'cdp-page': 1, pty: 1 },
    })
  })
})
