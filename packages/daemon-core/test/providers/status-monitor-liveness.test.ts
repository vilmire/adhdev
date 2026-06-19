import { describe, expect, it } from 'vitest'
import { StatusMonitor } from '../../src/providers/status-monitor.js'

// [G] long-generating watchdog false-stall regression.
//
// The watchdog must fire only when the worker is genuinely stalled — no progress
// of ANY kind for longerGeneratingThresholdSec. The CLI fingerprint is built from
// the parsed assistant buffer PLUS the adapter's raw-activity timestamps
// (lastScreenChangeAt / lastOutputAt). While a tool/build runs the assistant emits
// no tokens, so the assistant buffer is static — but the screen/raw timestamps keep
// advancing, which must keep the fingerprint moving and suppress the alert.
describe('StatusMonitor long-generating liveness watchdog', () => {
  const THRESHOLD = 5 // seconds

  function fingerprint(partial: string, scr: number, out: number): string {
    // Mirrors cli-provider-instance.ts progressFingerprint composition.
    return `${`${partial}`.slice(-2000)}::scr=${scr}::out=${out}`
  }

  it('does NOT fire while raw PTY activity advances even though the assistant buffer is static (tool/build running)', () => {
    const monitor = new StatusMonitor({ longGeneratingThresholdSec: THRESHOLD, alertCooldownSec: 0 })
    const start = 1_000_000
    // Assistant buffer never grows (no assistant tokens during tool execution),
    // but the terminal screen keeps changing as the build prints output.
    const staticAssistant = 'Running tests…'
    let events = monitor.check('cli:claude', 'generating', start, fingerprint(staticAssistant, start, start))
    expect(events).toHaveLength(0)

    // Advance well past the threshold, ticking every second with a fresh screen-change
    // timestamp — simulating active build output with no assistant tokens.
    for (let i = 1; i <= THRESHOLD + 3; i++) {
      const now = start + i * 1000
      events = monitor.check('cli:claude', 'generating', now, fingerprint(staticAssistant, now, now))
      expect(events, `tick ${i} must not alert while screen is changing`).toHaveLength(0)
    }
  })

  it('DOES fire when nothing changes at all — a genuine stall (no assistant tokens, no raw output)', () => {
    const monitor = new StatusMonitor({ longGeneratingThresholdSec: THRESHOLD, alertCooldownSec: 0 })
    const start = 2_000_000
    // Frozen everything: assistant buffer, screen, and raw output timestamps are all
    // pinned to the start. This is the only case the watchdog should survive.
    const frozen = fingerprint('half a response', start, start)
    monitor.check('cli:claude', 'generating', start, frozen)

    let fired: ReturnType<StatusMonitor['check']> = []
    for (let i = 1; i <= THRESHOLD + 2; i++) {
      const now = start + i * 1000
      const events = monitor.check('cli:claude', 'generating', now, frozen)
      if (events.some(e => e.type === 'monitor:long_generating')) { fired = events; break }
    }
    expect(fired.some(e => e.type === 'monitor:long_generating')).toBe(true)
  })

  it('resets the stall timer whenever the fingerprint changes, so progress defers the alert', () => {
    const monitor = new StatusMonitor({ longGeneratingThresholdSec: THRESHOLD, alertCooldownSec: 0 })
    const start = 3_000_000
    monitor.check('cli:claude', 'generating', start, fingerprint('a', start, start))

    // Just before the threshold, screen changes once → timer resets.
    const beforeThreshold = start + (THRESHOLD - 1) * 1000
    expect(monitor.check('cli:claude', 'generating', beforeThreshold, fingerprint('a', beforeThreshold, beforeThreshold))).toHaveLength(0)

    // Now freeze. The alert should NOT fire until THRESHOLD seconds after the reset,
    // proving the change deferred it rather than the absolute generating start time.
    const frozen = fingerprint('a', beforeThreshold, beforeThreshold)
    expect(monitor.check('cli:claude', 'generating', beforeThreshold + 1000, frozen)).toHaveLength(0)
    expect(monitor.check('cli:claude', 'generating', beforeThreshold + (THRESHOLD - 1) * 1000, frozen)).toHaveLength(0)
    const late = monitor.check('cli:claude', 'generating', beforeThreshold + (THRESHOLD + 1) * 1000, frozen)
    expect(late.some(e => e.type === 'monitor:long_generating')).toBe(true)
  })
})
