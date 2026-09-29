/**
 * §8 unit 2 — the local seqscribe stats surface must actually PASS the
 * transcript counters (wiring-unification B4 moved the old
 * `daemon-lifecycle.ts` `getSeqscribeStats` closure into
 * `seqscribe/local-stats.ts`, so this is now a behavioural test instead of a
 * source-text guard).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const summarize = vi.fn((_stats: unknown, opts: unknown) => ({ opts }))
vi.mock('../../src/seqscribe/stats.js', () => ({ summarizeSeqscribeStats: (stats: unknown, opts: unknown) => summarize(stats, opts) }))

import { buildLocalSeqscribeStats } from '../../src/seqscribe/local-stats.js'
import type { SeqscribeRuntime } from '../../src/seqscribe/runtime.js'

const transcriptCounters = {
  published: 7, publishFailed: 1, deduped: 2, oversized: 0, dropped: 0,
  ptyDirtyCoalesced: 5, emptyGuarded: 0, collectorUnavailable: 0, sourcePending: 3, collectFailed: 0,
  unidentified: 0, chatRowsWritten: 21, chatBytesWritten: 4096,
  chatBaseFrames: { epoch_start: 1, writer_change: 0, lineage_switch: 0, resync_request: 0, unexpected: 0 },
  chatBaseRateExceeded: 0, chatTripwireRefused: 0,
}

function runtime(withTranscript: boolean): SeqscribeRuntime {
  const snapshot = { stats: { topics: {} }, at: 1 }
  return {
    node: { authorityEnabled: true },
    collector: { snapshot: () => snapshot },
    transcriptReplica: { getCounters: () => ({ digestMismatches: 2, resubscribes: 3, baseRequests: 1 }) },
    projections: () => ({
      transcript: withTranscript
        ? { getCounters: () => transcriptCounters, getLatencyDetail: () => ({ lat: 1 }) }
        : null,
      parityLoop: null,
    }),
  } as unknown as SeqscribeRuntime
}

const meshDelivery = () => ({ delivered: 3, deferred: 1, escalated: 0 })

describe('buildLocalSeqscribeStats — transcript counter wiring (§8 unit 2)', () => {
  beforeEach(() => summarize.mockClear())

  it('returns null without a runtime (no node) — "no seqscribe" stays distinguishable', () => {
    expect(buildLocalSeqscribeStats(null, { meshDelivery })).toBeNull()
    expect(summarize).not.toHaveBeenCalled()
  })

  it('forwards the transcript counters into summarizeSeqscribeStats, keyed off the SERVICE', () => {
    buildLocalSeqscribeStats(runtime(true), { meshDelivery })
    const opts = summarize.mock.calls[0][1] as any
    // `active` follows the service, not the mode (mode `shadow` still publishes).
    expect(opts.transcript).toMatchObject({ active: true, published: 7, publishFailed: 1, ptyDirtyCoalesced: 5, sourcePending: 3 })
    expect(opts.transcriptLatency).toEqual({ lat: 1 })
    expect(opts.meshDelivery).toEqual({ delivered: 3, deferred: 1, escalated: 0 })
    // The retired Stage 5a redrive / Stage 4A read-routing blocks are gone.
    expect(opts.terminalRedrive).toBeUndefined()
    expect(opts.readRouting).toBeUndefined()
    expect(opts.authorityEnabled).toBe(true)
    // Keyed chat write/read health (design 2026-09-28 §8.3) — local-only detail.
    expect(opts.transcriptChat).toMatchObject({
      chatFramesPublished: 7, chatRowsWritten: 21, chatBytesWritten: 4096,
      chatDigestMismatch: 2, chatReplicaResubscribes: 3, chatBaseRequests: 1,
    })
    expect(opts.transcriptChat.chatBaseFrames.epoch_start).toBe(1)
  })

  it('asks for local diagnostics and never forwards the retired parity counters', () => {
    buildLocalSeqscribeStats(runtime(true), { meshDelivery })
    const opts = summarize.mock.calls[0][1] as any
    expect(opts.includeLocalDiagnostics).toBe(true)
    expect(opts.transcriptParity).toBeUndefined()
  })

  it('omits the transcript block (not active:false) when no publisher is armed', () => {
    buildLocalSeqscribeStats(runtime(false), { meshDelivery })
    const opts = summarize.mock.calls[0][1] as any
    expect(opts.transcript).toBeUndefined()
  })
})
