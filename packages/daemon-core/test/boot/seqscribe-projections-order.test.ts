/**
 * S6 armSeqscribeProjections — fixed arm order, exact-reverse disarm, one slot
 * (wiring-unification B4, plan §4.1 / §4.4). Replaces the source-text guard in
 * fleet-status-parity.test.ts ("arms after the shadow and detaches before it in
 * daemon lifecycle") with an order spy over the real stage function.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { calls, rec } = vi.hoisted(() => {
  const calls: string[] = []
  const rec = (name: string) => (...args: any[]) => { calls.push(`${name}(${args[0] === null ? 'null' : args[0] ? 'node' : ''})`) }
  return { calls, rec }
})

vi.mock('../../src/seqscribe/mesh-dual-write.js', () => ({
  configureMeshDualWrite: rec('dualWrite'),
  activateKnownMeshTopics: () => { calls.push('activateTopics'); return 0 },
}))
vi.mock('../../src/seqscribe/mesh-read-model.js', () => ({
  configureMeshReadModel: rec('readModel'),
  pruneStaleConsumersAtBoot: () => { calls.push('prune') },
}))
vi.mock('../../src/seqscribe/fleet-status-shadow.js', () => ({ configureFleetStatusShadow: rec('fleetShadow') }))
vi.mock('../../src/seqscribe/fleet-status-parity.js', () => ({ configureFleetStatusParity: rec('fleetParity') }))
vi.mock('../../src/seqscribe/transcript-publisher.js', () => ({
  configureTranscriptProjection: (deps: any) => { calls.push(`transcript(${deps ? 'deps' : 'null'})`); return deps ? { fake: 'service' } : null },
}))
vi.mock('../../src/seqscribe/transcript-publish-runtime.js', () => ({ createLiveTranscriptPublisher: () => async () => {} }))
vi.mock('../../src/seqscribe/transcript-activation.js', () => ({ releaseSessionTranscriptTopic: () => {} }))
vi.mock('../../src/seqscribe/transcript-bus-subscriber.js', () => ({
  subscribeTranscriptProjection: () => { calls.push('transcriptBus'); return () => calls.push('transcriptBus.off') },
}))
vi.mock('../../src/seqscribe/mesh-terminal-redrive-consumer.js', () => ({
  configureTerminalRedrive: rec('redrive'),
  ensureTerminalRedriveConsumersAtBoot: () => 0,
}))
vi.mock('../../src/mesh/mesh-terminal-redrive.js', () => ({
  REDRIVE_CONSUMER: 'redrive', REDRIVE_ENV: 'X', consumeRedriveEntry: () => {}, isTerminalRedriveEnabled: () => true,
}))
vi.mock('../../src/mesh/mesh-parity-loop.js', () => ({
  startMeshParityLoop: () => { calls.push('parityLoop'); return { stop: () => calls.push('parityLoop.stop'), runOnce: async () => {} } },
}))
vi.mock('../../src/config/mesh-config.js', () => ({ listMeshesReadOnly: () => [] }))

import { armSeqscribeProjections } from '../../src/boot/stages/seqscribe-projections.js'
import { seqscribeSlot } from '../../src/seqscribe/runtime-slot.js'

function stage() {
  let projections: any = null
  const rt: any = {
    node: { daemonId: 'd', writerId: 'w' },
    transcriptClaims: {},
    projections: () => projections,
    attachProjections: (v: any) => { projections = v },
  }
  const s5: any = {
    seqscribe: rt,
    sessionRegistry: { setTranscriptTopicRelease: vi.fn(), get: () => undefined },
    providerLoader: { getMeta: () => undefined },
    commandHandler: { handle: vi.fn() },
    bus: {},
  }
  return { rt, s5 }
}

describe('armSeqscribeProjections', () => {
  beforeEach(() => { calls.length = 0 })

  it('arms in the fixed order and binds the one runtime slot first', () => {
    const { rt, s5 } = stage()
    const steps: string[] = []
    const s6 = armSeqscribeProjections(s5, { onStep: s => steps.push(s) })
    expect(steps).toEqual([
      'arm:slot', 'arm:dual-write', 'arm:read-model', 'arm:fleet-shadow', 'arm:fleet-parity',
      'arm:transcript', 'arm:activate-topics', 'arm:prune-consumers', 'arm:terminal-redrive', 'arm:parity-loop',
    ])
    // Dual-write before topic activation / prune / redrive / parity loop; shadow before parity.
    expect(calls).toEqual([
      'dualWrite(node)', 'readModel(node)', 'fleetShadow(node)', 'fleetParity(node)',
      'transcript(deps)', 'transcriptBus', 'activateTopics', 'prune', 'redrive(node)', 'parityLoop',
    ])
    expect(seqscribeSlot.current()).toBe(rt)
    expect(rt.projections()).toMatchObject({ transcript: { fake: 'service' } })
    s6.disarmProjections()
  })

  it('disarms in the exact reverse and clears the slot LAST', () => {
    const { rt, s5 } = stage()
    const steps: string[] = []
    const s6 = armSeqscribeProjections(s5, { onStep: s => steps.push(s) })
    calls.length = 0
    steps.length = 0
    s6.disarmProjections()
    expect(steps).toEqual([
      'disarm:attach', 'disarm:parity-loop', 'disarm:terminal-redrive', 'disarm:transcript',
      'disarm:fleet-parity', 'disarm:fleet-shadow', 'disarm:read-model', 'disarm:dual-write', 'disarm:slot',
    ])
    // fleet parity detaches before its shadow; the parity loop stops before dual-write detaches.
    expect(calls).toEqual([
      'parityLoop.stop', 'redrive(null)', 'transcriptBus.off', 'transcript(null)',
      'fleetParity(null)', 'fleetShadow(null)', 'readModel(null)', 'dualWrite(null)',
    ])
    expect(seqscribeSlot.current()).toBeNull()
    expect(rt.projections()).toBeNull()
    // Idempotent.
    s6.disarmProjections()
    expect(steps).toHaveLength(9)
  })

  it('without a node it arms nothing and binds no slot', () => {
    const { s5 } = stage()
    const s6 = armSeqscribeProjections({ ...s5, seqscribe: null })
    expect(calls).toEqual([])
    expect(seqscribeSlot.current()).toBeNull()
    s6.disarmProjections()
  })
})
