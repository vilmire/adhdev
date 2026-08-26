import { describe, expect, it, vi } from 'vitest'
import { buildRedriveProvenance, describeRedriveProviderFlip } from '../../src/mesh/mesh-redrive-provenance.js'
import {
  waitForRemoteSessionReady,
  REMOTE_LAUNCH_READY_TIMEOUT_MS,
  REMOTE_LAUNCH_READY_POLL_MS,
} from '../../src/mesh/mesh-remote-ready-wait.js'

// REDRIVE-OBSERVABILITY + REMOTE-READY-WAIT.
//
// Two independent changes to the delivered-but-unconsumed redrive path, landed together
// because they address the same live failure (2026-08-25/26, 7-8 occurrences, each recovered
// by hand): a task is recorded as dispatched, the worker never consumes it, the watchdog
// force-reclaims after 25-40s, and the re-claim adopts an idle session WITHOUT recomputing
// routing — so the provider silently changes.
//
//   (a) REDRIVE-PROVIDER-FLIP — the flip is now recorded at the moment it happens. Previously
//       it was derivable ONLY by pulling a task's two `task_dispatched` ledger entries and
//       diffing providerType by hand, which is why the flips went unnoticed for a day.
//       This is observability only: nothing routes or gates on it. It lands FIRST precisely
//       so any later change to redrive routing has a baseline to be measured against.
//
//   (b) REMOTE-READY-WAIT — the remote auto-launch path already receives `agent:ready`
//       (forwarded → remote-idle registry) but returned the instant `launch_cli` resolved,
//       i.e. on "spawn accepted", not "session can take a prompt". It now waits, bounded by
//       the SAME 15s budget as the local barrier, and on timeout proceeds exactly as before.
//
// Deliberately NOT covered here because they are deliberately NOT changed: the redrive
// constants, the not_before backoff, idle-session reuse, the dispatchFailureCount budget, and
// the local readiness path. The guard tests below pin that the no-flip and local cases stay
// byte-identical to prior behavior.

const RECLAIM = {
  providerType: 'codex-cli',
  nodeId: 'node_aaaa1111',
  sessionId: 'sess_old',
  reason: 'delivered_not_consumed_redrive',
  reclaimCount: 1,
  at: '2026-08-26T00:00:00.000Z',
}

describe('(a) redrive provider-flip provenance', () => {
  // ── INJECTION TEST 1 ──────────────────────────────────────────────────────
  // The load-bearing assertion. Revert the change (drop `lastReclaim` from the queue row, or
  // make buildRedriveProvenance return null / providerChanged:false) and this goes RED.
  it('marks providerChanged when a redrive lands on a DIFFERENT provider', () => {
    const p = buildRedriveProvenance(RECLAIM, 'kimi')
    expect(p).not.toBeNull()
    expect(p!.providerChanged).toBe(true)
    expect(p!.previousProviderType).toBe('codex-cli')
    expect(p!.providerType).toBe('kimi')
    // The whole point is that the flip is legible WITHOUT a second ledger entry to join
    // against: previous and current provider are both present on this single record.
    expect(p!.reason).toBe('delivered_not_consumed_redrive')
    expect(p!.reclaimCount).toBe(1)
    expect(p!.previousNodeId).toBe('node_aaaa1111')
    expect(p!.previousSessionId).toBe('sess_old')
    expect(p!.reclaimedAt).toBe('2026-08-26T00:00:00.000Z')
  })

  it('renders a flip description naming both providers and the reclaim reason', () => {
    const p = buildRedriveProvenance(RECLAIM, 'kimi')!
    const msg = describeRedriveProviderFlip(p, 'task_1234', 'mesh_abcd')
    expect(msg).toContain('task_1234')
    expect(msg).toContain('mesh_abcd')
    expect(msg).toContain('codex-cli → kimi')
    expect(msg).toContain('delivered_not_consumed_redrive')
  })

  // ── OVERCORRECTION GUARDS ────────────────────────────────────────────────
  describe('overcorrection guards', () => {
    it('does NOT report a flip when the redrive kept the same provider', () => {
      // The benign majority case. If this ever reported a flip the record would become noise
      // and stop being a signal — which is the failure mode that makes an observability
      // change worse than nothing.
      const p = buildRedriveProvenance(RECLAIM, 'codex-cli')
      expect(p).not.toBeNull()
      expect(p!.providerChanged).toBe(false)
      // Provenance is still emitted (the dispatch WAS a redrive, and reclaimCount is useful)
      // — only the separate flip record and warn are withheld.
      expect(p!.reason).toBe('delivered_not_consumed_redrive')
      expect(p!.reclaimCount).toBe(1)
    })

    it('treats whitespace-only provider differences as the same provider', () => {
      expect(buildRedriveProvenance({ ...RECLAIM, providerType: ' codex-cli ' }, 'codex-cli')!.providerChanged).toBe(false)
    })

    it('returns null for an ordinary first dispatch (no reclaim ever happened)', () => {
      // Guarantees the task_dispatched payload shape is UNCHANGED for the common,
      // non-redriven case — no new field appears on the overwhelming majority of entries.
      expect(buildRedriveProvenance(undefined, 'codex-cli')).toBeNull()
    })

    it('never fabricates a flip when the previous provider is unknown (legacy row)', () => {
      // An absent previous provider is a legacy/never-assigned row, NOT evidence of a change.
      // Reporting it as a flip would manufacture exactly the false signal this record exists
      // to avoid — and would make every legacy row look like an incident.
      const p = buildRedriveProvenance({ ...RECLAIM, providerType: undefined }, 'kimi')
      expect(p).not.toBeNull()
      expect(p!.providerChanged).toBe(false)
      expect(p!.previousProviderType).toBeUndefined()
    })

    it('does not fabricate a flip when the dispatched provider is empty', () => {
      const p = buildRedriveProvenance(RECLAIM, '')
      expect(p!.providerChanged).toBe(false)
    })

    it('preserves the reclaim count across repeated redrives', () => {
      const p = buildRedriveProvenance({ ...RECLAIM, reclaimCount: 3 }, 'kimi')!
      expect(p.reclaimCount).toBe(3)
      expect(p.providerChanged).toBe(true)
    })
  })
})

describe('(b) remote agent:ready bounded wait', () => {
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))

  it('uses the same 15s budget as the local readiness barrier', () => {
    // Symmetry with LOCAL_LAUNCH_READY_TIMEOUT_MS is the design claim; a silent divergence
    // here would turn a "same budget" barrier into a timeout increase, which is out of scope.
    expect(REMOTE_LAUNCH_READY_TIMEOUT_MS).toBe(15_000)
    expect(REMOTE_LAUNCH_READY_POLL_MS).toBe(100)
  })

  // ── INJECTION TEST 2 ──────────────────────────────────────────────────────
  // The load-bearing assertion for the wait. Revert it (return immediately without polling)
  // and this goes RED: the probe would be consulted zero or one times and never observe the
  // readiness that arrives on a later poll.
  it('actually waits, polling until agent:ready lands', async () => {
    let calls = 0
    const sleep = vi.fn(async () => { /* immediate, virtual time */ })
    const ready = await waitForRemoteSessionReady('mesh_1', 'node_1', 'sess_1', {
      // Not ready for the first four polls, ready on the fifth.
      isReady: () => ++calls >= 5,
      sleep,
      now: () => 0, // never reaches the deadline; readiness is what ends the loop
    })
    expect(ready).toBe(true)
    expect(calls).toBe(5)
    // It genuinely slept between polls rather than spinning or short-circuiting.
    expect(sleep).toHaveBeenCalledTimes(4)
    expect(sleep).toHaveBeenCalledWith(REMOTE_LAUNCH_READY_POLL_MS)
  })

  it('returns immediately when the session is already ready (no sleep)', async () => {
    const sleep = vi.fn(async () => {})
    expect(await waitForRemoteSessionReady('mesh_1', 'node_1', 'sess_1', { isReady: () => true, sleep })).toBe(true)
    expect(sleep).not.toHaveBeenCalled()
  })

  // ── TIMEOUT PATH ─────────────────────────────────────────────────────────
  it('gives up after the budget and proceeds optimistically when ready never arrives', async () => {
    // The worst case must be IDENTICAL to pre-change behavior: the caller continues. The
    // barrier reports false; it does not throw, and it does not block past the budget.
    let clock = 0
    const sleep = vi.fn(async (ms: number) => { clock += ms })
    const ready = await waitForRemoteSessionReady('mesh_1', 'node_1', 'sess_1', {
      isReady: () => false,
      sleep,
      now: () => clock,
    })
    expect(ready).toBe(false)
    // Bounded by the budget: 15s / 100ms poll.
    expect(clock).toBeGreaterThanOrEqual(REMOTE_LAUNCH_READY_TIMEOUT_MS)
    expect(sleep.mock.calls.length).toBeLessThanOrEqual(REMOTE_LAUNCH_READY_TIMEOUT_MS / REMOTE_LAUNCH_READY_POLL_MS + 1)
  })

  describe('overcorrection guards', () => {
    it('does not wait at all when the remote launch returned no session id', async () => {
      // Nothing to correlate a ready against — waiting would burn the full budget on a match
      // that can never happen.
      const sleep = vi.fn(async () => {})
      expect(await waitForRemoteSessionReady('mesh_1', 'node_1', undefined, { isReady: () => false, sleep })).toBe(false)
      expect(sleep).not.toHaveBeenCalled()
    })

    it('abandons the wait (never throws) when the readiness probe throws', async () => {
      // A diagnostic barrier must not be able to fail a launch that genuinely succeeded, nor
      // hold the 4s auto-launch loop hostage to an unavailable store.
      const sleep = vi.fn(async () => {})
      const ready = await waitForRemoteSessionReady('mesh_1', 'node_1', 'sess_1', {
        isReady: () => { throw new Error('store unavailable') },
        sleep,
      })
      expect(ready).toBe(false)
      expect(sleep).not.toHaveBeenCalled()
    })

    it('resolves rather than rejecting on the timeout path', async () => {
      let clock = 0
      await expect(waitForRemoteSessionReady('mesh_1', 'node_1', 'sess_1', {
        isReady: () => false,
        sleep: async (ms: number) => { clock += ms },
        now: () => clock,
        timeoutMs: 300,
      })).resolves.toBe(false)
    })

    it('honours an explicitly supplied shorter budget without touching the default', async () => {
      let clock = 0
      await waitForRemoteSessionReady('mesh_1', 'node_1', 'sess_1', {
        isReady: () => false,
        sleep: async (ms: number) => { clock += ms },
        now: () => clock,
        timeoutMs: 500,
        pollMs: 100,
      })
      expect(clock).toBeGreaterThanOrEqual(500)
      expect(clock).toBeLessThan(REMOTE_LAUNCH_READY_TIMEOUT_MS)
      // The module default is untouched by a per-call override.
      expect(REMOTE_LAUNCH_READY_TIMEOUT_MS).toBe(15_000)
    })

    it('does not use real time on the timeout path (test determinism)', async () => {
      // Guards the suite itself: if the injected clock were ignored, this would take 15s.
      const started = Date.now()
      let clock = 0
      await waitForRemoteSessionReady('mesh_1', 'node_1', 'sess_1', {
        isReady: () => false,
        sleep: async (ms: number) => { clock += ms },
        now: () => clock,
      })
      await flush()
      expect(Date.now() - started).toBeLessThan(5_000)
    })
  })
})
