import { describe, expect, it } from 'vitest'
import { StatusMonitor } from '../../src/providers/status-monitor.js'

// Approval-pending suppression for the no-progress watchdog.
//
// While an approval modal is pending the assistant emits no tokens and the screen
// is frozen on the modal, so the progress fingerprint goes static. But this is a
// user action wait, not a stall — the watchdog must NOT fire. The CLI/IDE
// auto-approve paths also synthesize the reported status to 'generating' during
// the wait, so callers pass an explicit `approvalPending` flag and the monitor
// holds its timer for as long as it is set.
describe('StatusMonitor no-progress watchdog approval suppression', () => {
  const THRESHOLD = 5 // seconds
  const KEY = 'cli:claude'

  function longGen(events: ReturnType<StatusMonitor['check']>): boolean {
    return events.some(e => e.type === 'monitor:long_generating')
  }

  it('does NOT fire while approval is pending, even though the fingerprint is frozen', () => {
    const monitor = new StatusMonitor({ longGeneratingThresholdSec: THRESHOLD, alertCooldownSec: 0 })
    const start = 1_000_000
    const frozen = 'awaiting approval'
    // Status synthesized to 'generating' (auto-approve path) but approvalPending=true.
    for (let i = 0; i <= THRESHOLD + 5; i++) {
      const now = start + i * 1000
      const events = monitor.check(KEY, 'generating', now, frozen, true)
      expect(longGen(events), `tick ${i} must not alert while approval pending`).toBe(false)
    }
  })

  it('DOES fire after approval clears when generating then genuinely stalls', () => {
    const monitor = new StatusMonitor({ longGeneratingThresholdSec: THRESHOLD, alertCooldownSec: 0 })
    const start = 2_000_000
    // Hold in approval for a long time.
    for (let i = 0; i <= THRESHOLD + 3; i++) {
      monitor.check(KEY, 'generating', start + i * 1000, 'awaiting approval', true)
    }
    // Approval clears; generating resumes with a frozen fingerprint (true stall).
    const resume = start + (THRESHOLD + 4) * 1000
    const frozen = 'stuck after approval'
    expect(longGen(monitor.check(KEY, 'generating', resume, frozen, false))).toBe(false)

    let fired = false
    for (let i = 1; i <= THRESHOLD + 2; i++) {
      const now = resume + i * 1000
      if (longGen(monitor.check(KEY, 'generating', now, frozen, false))) { fired = true; break }
    }
    expect(fired).toBe(true)
  })

  it('restarts the timer from the moment approval clears (approval wait does not accrue)', () => {
    const monitor = new StatusMonitor({ longGeneratingThresholdSec: THRESHOLD, alertCooldownSec: 0 })
    const start = 3_000_000
    // Generate normally for a couple seconds, then enter a long approval wait.
    monitor.check(KEY, 'generating', start, 'fp-a', false)
    monitor.check(KEY, 'generating', start + 1000, 'fp-b', false)

    const approvalStart = start + 2000
    // Stay in approval well beyond the threshold with a frozen fingerprint.
    let last = approvalStart
    for (let i = 0; i <= THRESHOLD + 5; i++) {
      last = approvalStart + i * 1000
      monitor.check(KEY, 'generating', last, 'frozen-modal', true)
    }

    // Resume generating with a frozen fingerprint. Because the timer restarts at the
    // moment approval clears, the alert must NOT fire immediately even though the
    // total wall-clock since generating began is far over the threshold.
    const resume = last + 1000
    const frozen = 'frozen-after-resume'
    expect(longGen(monitor.check(KEY, 'generating', resume, frozen, false))).toBe(false)
    // Just under threshold from resume → still silent.
    expect(longGen(monitor.check(KEY, 'generating', resume + (THRESHOLD - 1) * 1000, frozen, false))).toBe(false)
    // Past threshold from resume → fires.
    expect(longGen(monitor.check(KEY, 'generating', resume + (THRESHOLD + 1) * 1000, frozen, false))).toBe(true)
  })
})
