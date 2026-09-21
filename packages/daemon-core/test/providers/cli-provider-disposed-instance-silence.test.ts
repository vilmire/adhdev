import { describe, expect, it, vi } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// DISPOSED-INSTANCE SILENCE. dispose() does not stop the driver: for the seconds
// the PTY takes to tear down, the status callback keeps firing and pushEvent's
// direct path (context.emitProviderEvent) delivers whatever it produces.
// Standalone live check 2026-09-22: a session stopped MID-TURN logged
// `status: generating → idle` + "waiting to emit completed until transcript
// finalizes" 12s after stop_cli — one transcript condition away from reporting a
// killed turn as agent:generating_completed.
describe('CliProviderInstance — a disposed instance may only report its own stop', () => {
  const make = () => {
    const emitted: any[] = []
    const instance = Object.create(CliProviderInstance.prototype) as any
    instance.instanceId = 'sess-disposed'
    instance.type = 'claude-cli'
    instance.workingDir = '/work/repo'
    instance.providerSessionId = 'prov-1'
    instance.settings = {}
    instance.events = []
    instance.provider = {}
    instance.disposed = false
    instance.completedDebounceTimer = null
    instance.autoApproveSettleTimer = null
    instance.autoApproveBusyTimer = null
    instance.appliedEffectKeys = new Set()
    instance.sqliteProbeCache = { db: null, dbPath: null }
    instance.adapter = { shutdown: vi.fn() }
    instance.monitor = { reset: vi.fn() }
    instance.clearCancelledCompletionRecheck = vi.fn()
    instance.isMeshWorkerSession = () => false
    instance.context = { emitProviderEvent: (event: any) => emitted.push(event) }
    return { instance, emitted }
  }

  it('delivers events normally before dispose', () => {
    const { instance, emitted } = make()
    instance.pushEvent({ event: 'agent:generating_completed', timestamp: 1 })
    expect(emitted.map(e => e.event)).toEqual(['agent:generating_completed'])
  })

  it('after dispose, drops completion/lifecycle events but still reports the stop', () => {
    const { instance, emitted } = make()
    instance.dispose()
    for (const event of ['agent:generating_completed', 'agent:generating_started', 'agent:ready', 'agent:waiting_approval']) {
      instance.pushEvent({ event, timestamp: 2 })
    }
    expect(emitted).toEqual([])

    instance.pushEvent({ event: 'agent:stopped', timestamp: 3 })
    expect(emitted.map(e => e.event)).toEqual(['agent:stopped'])
  })

  it('cancels a pending completion debounce on dispose', () => {
    vi.useFakeTimers()
    try {
      const { instance } = make()
      const fired = vi.fn()
      instance.completedDebounceTimer = setTimeout(fired, 1_000)
      instance.dispose()
      vi.advanceTimersByTime(5_000)
      expect(fired).not.toHaveBeenCalled()
      expect(instance.completedDebounceTimer).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
