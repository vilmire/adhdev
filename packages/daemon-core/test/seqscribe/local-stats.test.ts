/**
 * §8 unit 2 — the local seqscribe stats surface must actually PASS the
 * transcript counters (wiring-unification B4 moved the old
 * `daemon-lifecycle.ts` `getSeqscribeStats` closure into
 * `seqscribe/local-stats.ts`, so this is now a behavioural test instead of a
 * source-text guard).
 *
 * The defect class this pins: the publisher and its parity self-check were live
 * in production while `transcriptParityRan` read a permanent `false`, because
 * the call site computed nothing / passed a narrowed slice. A false NEGATIVE on
 * the Phase 4 promotion gate's evidence field.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const summarize = vi.fn((_stats: unknown, opts: unknown) => ({ opts }))
vi.mock('../../src/seqscribe/stats.js', () => ({ summarizeSeqscribeStats: (stats: unknown, opts: unknown) => summarize(stats, opts) }))

const parityCounters = { runs: 2, compared: 2, mismatches: 0, persistentMismatches: 0, sessionsRepeated: 0, pendingMissingRevisits: 1, since: '2026-09-23T00:00:00.000Z' }
vi.mock('../../src/seqscribe/transcript-parity.js', () => ({ transcriptParityCounters: () => parityCounters }))

import { buildLocalSeqscribeStats } from '../../src/seqscribe/local-stats.js'
import type { SeqscribeRuntime } from '../../src/seqscribe/runtime.js'

const transcriptCounters = {
  published: 7, publishFailed: 1, deduped: 2, oversized: 0, dropped: 0,
  ptyDirtyCoalesced: 5, emptyGuarded: 0, collectorUnavailable: 0, sourcePending: 3, collectFailed: 0,
}

function runtime(withTranscript: boolean): SeqscribeRuntime {
  const snapshot = { stats: { topics: {} }, at: 1 }
  return {
    node: { authorityEnabled: true },
    collector: { snapshot: () => snapshot },
    projections: () => ({
      transcript: withTranscript
        ? { getCounters: () => transcriptCounters, getLatencyDetail: () => ({ lat: 1 }) }
        : null,
      parityLoop: null,
    }),
  } as unknown as SeqscribeRuntime
}

const terminalRedrive = () => ({ redelivered: 3, skipped: 1, quarantined: 0 })

describe('buildLocalSeqscribeStats — transcript counter wiring (§8 unit 2)', () => {
  beforeEach(() => summarize.mockClear())

  it('returns null without a runtime (no node) — "no seqscribe" stays distinguishable', () => {
    expect(buildLocalSeqscribeStats(null, { terminalRedrive })).toBeNull()
    expect(summarize).not.toHaveBeenCalled()
  })

  it('forwards the transcript counters into summarizeSeqscribeStats, keyed off the SERVICE', () => {
    buildLocalSeqscribeStats(runtime(true), { terminalRedrive })
    const opts = summarize.mock.calls[0][1] as any
    // `active` follows the service, not the mode (mode `shadow` still publishes).
    expect(opts.transcript).toMatchObject({ active: true, published: 7, publishFailed: 1, ptyDirtyCoalesced: 5, sourcePending: 3 })
    expect(opts.transcriptLatency).toEqual({ lat: 1 })
    expect(opts.terminalRedrive).toEqual({ redelivered: 3, skipped: 1, quarantined: 0 })
    expect(opts.authorityEnabled).toBe(true)
  })

  it('★passes the WHOLE parity counter object, never a narrowed subset, with local diagnostics on', () => {
    buildLocalSeqscribeStats(runtime(true), { terminalRedrive })
    const opts = summarize.mock.calls[0][1] as any
    expect(opts.transcriptParity).toBe(parityCounters)
    expect(opts.includeLocalDiagnostics).toBe(true)
  })

  it('omits the transcript block (not active:false) when no publisher is armed', () => {
    buildLocalSeqscribeStats(runtime(false), { terminalRedrive })
    const opts = summarize.mock.calls[0][1] as any
    expect(opts.transcript).toBeUndefined()
    expect(opts.transcriptParity).toBe(parityCounters)
  })
})
