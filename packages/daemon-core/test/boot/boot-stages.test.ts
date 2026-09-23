/**
 * Staged boot composition (wiring-unification B4, plan §4 / §6.3).
 *
 * `bootDaemonRuntime` takes its eight stages by injection, so the ORDER
 * contract — S1..S8 forward, teardown in reverse with the seqscribe node closed
 * after the session core and `bus.close()` + VACUUM last — is tested
 * behaviourally instead of by reading daemon-lifecycle.ts as text.
 */
import { describe, expect, it, vi } from 'vitest'

const quota = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('../../src/quota/refresh.js', () => ({
  quotaProviderEnabledFromLoader: () => () => true,
  hydrateQuotaCacheFromDisk: () => { quota.calls.push('hydrate') },
  refreshQuotaCacheOnBoot: () => { quota.calls.push('refresh') },
  setupQuotaRefreshLoop: () => ({ stop() {} }),
  setupQuotaEventRefresh: () => ({ stop() {} }),
}))

import { bootDaemonRuntime, type DaemonBootStages } from '../../src/boot/daemon-runtime.js'
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js'
import { SessionRegistry } from '../../src/sessions/registry.js'
import { scheduleQuotaBootRefresh } from '../../src/boot/stages/loops.js'

function recordingStages(log: string[]) {
  const bus = createSessionLifecycleBus()
  const registry = new SessionRegistry(bus)
  const originalBeginShutdown = registry.beginShutdown.bind(registry)
  registry.beginShutdown = () => { log.push('registry.beginShutdown'); originalBeginShutdown() }
  const originalClose = bus.close
  bus.close = () => { log.push('bus.close'); originalClose() }
  const seqscribe = {
    quiesce: () => log.push('dispose:S4.quiesce'),
    close: async () => { log.push('dispose:S4.close') },
  }
  const stages: DaemonBootStages = {
    bootPlatform: async (cfg) => { log.push('S1'); return { cfg } as any },
    bootProviders: async (s1) => {
      log.push('S2')
      return { ...s1, stalenessProbe: { stop: () => log.push('dispose:S2.staleness'), onStale() {} } } as any
    },
    bootSessionCore: async (s2) => {
      log.push('S3')
      return {
        ...s2, bus, sessionRegistry: registry,
        disposeSessionCore: async () => { log.push('dispose:S3.sessionCore') },
        disposeLiveness: () => log.push('dispose:S3.liveness'),
      } as any
    },
    bootSeqscribeNode: (s3) => { log.push('S4'); return { ...s3, seqscribe } as any },
    bootCommandPlane: (s4) => { log.push('S5'); return s4 as any },
    armSeqscribeProjections: (s5) => { log.push('S6'); return { ...s5, disarmProjections: () => log.push('dispose:S6') } as any },
    bootMeshRuntime: (s6) => {
      log.push('S7')
      return { ...s6, components: { marker: 'components' }, disposeMeshRuntime: () => log.push('dispose:S7') } as any
    },
    startLoops: async () => { log.push('S8'); return () => log.push('dispose:S8') },
    vacuum: () => log.push('vacuum'),
  }
  return { stages, bus, registry, seqscribe }
}

describe('bootDaemonRuntime', () => {
  it('runs S1..S8 in order, each fed by the previous stage, and returns the runtime', async () => {
    const log: string[] = []
    const { stages, bus, seqscribe } = recordingStages(log)
    const runtime = await bootDaemonRuntime({ sessionHost: {} }, stages)
    expect(log).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'])
    expect(runtime.bus).toBe(bus)
    expect(runtime.seqscribe).toBe(seqscribe)
    expect(runtime.components).toEqual({ marker: 'components' })
  })

  it('shuts down in reverse stage order: producers first, node close after the session core, bus.close then VACUUM last', async () => {
    const log: string[] = []
    const { stages } = recordingStages(log)
    const runtime = await bootDaemonRuntime({ sessionHost: {} }, stages)
    log.length = 0
    await runtime.shutdown()
    expect(log).toEqual([
      'registry.beginShutdown',
      'dispose:S8',
      'dispose:S7',
      'dispose:S6',
      'dispose:S4.quiesce',
      'dispose:S2.staleness',
      'dispose:S3.liveness',
      'dispose:S3.sessionCore',
      'dispose:S4.close',
      'bus.close',
      'vacuum',
    ])
  })

  it('shutdown is idempotent and a throwing disposer does not stop the rest', async () => {
    const log: string[] = []
    const { stages } = recordingStages(log)
    stages.bootMeshRuntime = (s6: any) => ({ ...s6, components: {}, disposeMeshRuntime: () => { throw new Error('boom') } })
    const runtime = await bootDaemonRuntime({ sessionHost: {} }, stages)
    log.length = 0
    await Promise.all([runtime.shutdown(), runtime.shutdown()])
    expect(log.filter(l => l === 'vacuum')).toHaveLength(1)
    expect(log).toContain('dispose:S6')
    expect(log.at(-1)).toBe('vacuum')
  })

  it('a session terminated during shutdown carries daemon_shutdown (beginShutdown runs before any teardown)', async () => {
    const log: string[] = []
    const { stages, registry, bus } = recordingStages(log)
    const causes: string[] = []
    bus.on('terminated', e => { causes.push(e.cause) })
    stages.startLoops = async () => () => { registry.terminate('s1', 'pty_exit') }
    registry.register({ sessionId: 's1', parentSessionId: null, providerType: 'x', transport: 'pty' }, 'launch')
    const runtime = await bootDaemonRuntime({ sessionHost: {} }, stages)
    await runtime.shutdown()
    expect(causes).toEqual(['daemon_shutdown'])
  })
})

describe('scheduleQuotaBootRefresh (S8)', () => {
  it('hydrates BEFORE the boot refresh, deferred past the call and never awaited', async () => {
    quota.calls.length = 0
    scheduleQuotaBootRefresh({ providerLoader: {} } as any)
    // Nothing runs synchronously — a ~900ms codex spawn must not add to boot.
    expect(quota.calls).toEqual([])
    await new Promise(resolve => setImmediate(resolve))
    expect(quota.calls).toEqual(['hydrate', 'refresh'])
  })
})
