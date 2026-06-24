import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  awaitWithWarmupDeadline,
  readWarmupConnectionState,
  resolveWarmupDeadlineOpts,
} from '../../src/mesh/mesh-warmup-deadline.js'

// Coverage for the fail-loud degrade of the warmup-aware deadline. The old call
// sites fell back to `() => true` ("always warm") when no live connection getter was
// wired — silently charging a still-opening cold channel against the response budget
// and re-introducing the very cold-open false-timeout the deadline exists to prevent.
// resolveWarmupDeadlineOpts now degrades CONSERVATIVELY (combined budget) and FAIL
// LOUD (onMissingGetter), while a present getter keeps the precise warm/cold split.

describe('readWarmupConnectionState', () => {
  it('reads a non-empty string state, else undefined', () => {
    expect(readWarmupConnectionState({ state: 'connected' })).toBe('connected')
    expect(readWarmupConnectionState({ state: 'connecting' })).toBe('connecting')
    expect(readWarmupConnectionState({ state: '' })).toBeUndefined()
    expect(readWarmupConnectionState({})).toBeUndefined()
    expect(readWarmupConnectionState(null)).toBeUndefined()
    expect(readWarmupConnectionState(undefined)).toBeUndefined()
    expect(readWarmupConnectionState({ state: 123 as unknown as string })).toBeUndefined()
  })
})

describe('resolveWarmupDeadlineOpts', () => {
  it('with a getter, the channel is warm ONLY when the snapshot reports connected', () => {
    const onMissingGetter = vi.fn()
    let snapshot: Record<string, unknown> | null = { state: 'connecting' }
    const resolved = resolveWarmupDeadlineOpts({
      getConnection: () => snapshot,
      daemonId: 'd1',
      connectTimeoutMs: 45_000,
      responseTimeoutMs: 25_000,
      onMissingGetter,
    })
    // Budgets are untouched and the degrade hook is never invoked.
    expect(resolved.connectTimeoutMs).toBe(45_000)
    expect(resolved.responseTimeoutMs).toBe(25_000)
    expect(onMissingGetter).not.toHaveBeenCalled()
    // connecting / unknown / null → NOT warm (generous connect budget governs).
    expect(resolved.isConnected()).toBe(false)
    snapshot = null
    expect(resolved.isConnected()).toBe(false)
    snapshot = { state: 'failed' }
    expect(resolved.isConnected()).toBe(false)
    // Only `connected` is warm.
    snapshot = { state: 'connected' }
    expect(resolved.isConnected()).toBe(true)
  })

  it('without a getter, fails loud and degrades to the COMBINED budget (never always-warm)', () => {
    const onMissingGetter = vi.fn()
    const resolved = resolveWarmupDeadlineOpts({
      getConnection: undefined,
      daemonId: 'd2',
      connectTimeoutMs: 45_000,
      responseTimeoutMs: 25_000,
      onMissingGetter,
    })
    // Fail-loud: the degrade is surfaced, not silent.
    expect(onMissingGetter).toHaveBeenCalledWith('d2')
    // NOT always-warm — the channel is treated as unobservable so the response
    // deadline never arms early on a cold channel.
    expect(resolved.isConnected()).toBe(false)
    // Combined window so a slow cold open is never false-timed at the response budget.
    expect(resolved.connectTimeoutMs).toBe(70_000)
    expect(resolved.responseTimeoutMs).toBe(25_000)
  })
})

describe('resolveWarmupDeadlineOpts ∘ awaitWithWarmupDeadline (no-getter degrade)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does NOT false-timeout a slow cold open within the combined window', async () => {
    vi.useFakeTimers()
    let resolveWork!: (v: string) => void
    const work = new Promise<string>((res) => { resolveWork = res })
    const opts = resolveWarmupDeadlineOpts({
      getConnection: undefined,
      daemonId: 'd3',
      connectTimeoutMs: 45_000,
      responseTimeoutMs: 25_000,
      onMissingGetter: () => {},
    })
    const p = awaitWithWarmupDeadline(work, { ...opts, pollIntervalMs: 200 })
    // 50s — past the 25s response budget that the OLD `() => true` fallback would
    // have applied (false-timeout). With the combined 70s window it is still pending.
    await vi.advanceTimersByTimeAsync(50_000)
    resolveWork('OK')
    await expect(p).resolves.toBe('OK')
  })

  it('still rejects once the combined window is exhausted (hung dispatch)', async () => {
    vi.useFakeTimers()
    const work = new Promise<string>(() => {}) // never settles
    const opts = resolveWarmupDeadlineOpts({
      getConnection: undefined,
      daemonId: 'd4',
      connectTimeoutMs: 45_000,
      responseTimeoutMs: 25_000,
      onMissingGetter: () => {},
    })
    const p = awaitWithWarmupDeadline(work, { ...opts, pollIntervalMs: 200 })
    const assertion = expect(p).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(70_000)
    await assertion
  })
})
