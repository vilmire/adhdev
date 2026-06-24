import { afterEach, describe, expect, it, vi } from 'vitest'
import { awaitWithWarmupDeadline } from '../../src/commands/router.js'

// Regression coverage for the P2P DataChannel cold-open warmup fix. The first
// direct-peer mesh git_status to a peer whose channel is still opening used to be
// charged the cold-open handshake against the response budget — a single
// Promise.race(dispatch, 25s) — so it false-timed-out, and only the warm retry
// (reusing the now-open channel) succeeded. awaitWithWarmupDeadline separates the
// two budgets: the cold-open warmup gets connectTimeoutMs, and only the warm
// round trip gets responseTimeoutMs. These tests exercise that timing logic with
// fake timers, without any real WebRTC.

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('awaitWithWarmupDeadline', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves on a warm channel when work finishes within the response budget', async () => {
    vi.useFakeTimers()
    const work = deferred<string>()
    const p = awaitWithWarmupDeadline(work.promise, {
      isConnected: () => true,
      connectTimeoutMs: 45_000,
      responseTimeoutMs: 25_000,
      pollIntervalMs: 200,
    })
    await vi.advanceTimersByTimeAsync(5_000)
    work.resolve('OK')
    await expect(p).resolves.toBe('OK')
  })

  it('does NOT charge cold-open warmup against the response budget (the core fix)', async () => {
    vi.useFakeTimers()
    const work = deferred<string>()
    let connected = false
    const p = awaitWithWarmupDeadline(work.promise, {
      isConnected: () => connected,
      connectTimeoutMs: 45_000,
      responseTimeoutMs: 25_000,
      pollIntervalMs: 200,
    })
    // 30s of cold-open handshake — well past the 25s response budget. With the old
    // single-race this would already have rejected; here it must still be pending.
    await vi.advanceTimersByTimeAsync(30_000)
    connected = true
    // Next poll observes the warm channel and arms the response deadline.
    await vi.advanceTimersByTimeAsync(200)
    // The warm round trip completes 3s after the channel opened — inside the 25s
    // response budget that only started at open.
    await vi.advanceTimersByTimeAsync(3_000)
    work.resolve('OK')
    await expect(p).resolves.toBe('OK')
  })

  it('rejects with timeout when the channel never opens within the connect budget', async () => {
    vi.useFakeTimers()
    const work = deferred<string>() // never settles
    const p = awaitWithWarmupDeadline(work.promise, {
      isConnected: () => false,
      connectTimeoutMs: 45_000,
      responseTimeoutMs: 25_000,
      pollIntervalMs: 200,
    })
    const assertion = expect(p).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(45_000)
    await assertion
  })

  it('rejects with timeout when a warm channel never responds within the response budget', async () => {
    vi.useFakeTimers()
    const work = deferred<string>() // never settles
    const p = awaitWithWarmupDeadline(work.promise, {
      isConnected: () => true,
      connectTimeoutMs: 45_000,
      responseTimeoutMs: 25_000,
      pollIntervalMs: 200,
    })
    const assertion = expect(p).rejects.toThrow('timeout')
    // Response budget starts at t0 for an already-warm channel; not the combined
    // connect+response window.
    await vi.advanceTimersByTimeAsync(25_000)
    await assertion
  })

  it('surfaces a genuine connect failure immediately rather than masking it for the whole window', async () => {
    vi.useFakeTimers()
    const work = deferred<string>()
    const p = awaitWithWarmupDeadline(work.promise, {
      isConnected: () => false, // still "connecting" from the snapshot's view
      connectTimeoutMs: 45_000,
      responseTimeoutMs: 25_000,
      pollIntervalMs: 200,
    })
    const assertion = expect(p).rejects.toThrow('peer failed')
    // The mesh manager fails the peer 2s in and rejects the dispatch directly — the
    // deadline must not swallow that into a generic timeout or delay it to 45s.
    await vi.advanceTimersByTimeAsync(2_000)
    work.reject(new Error('peer failed'))
    await assertion
  })
})
