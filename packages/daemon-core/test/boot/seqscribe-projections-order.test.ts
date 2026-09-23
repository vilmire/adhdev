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

const topicActivation = vi.hoisted(() => ({ fail: false }))
vi.mock('../../src/seqscribe/mesh-publisher.js', () => ({
  configureMeshPublisher: rec('publisher'),
  activateMeshTopicsAtBoot: () => {
    calls.push('activateTopics')
    if (topicActivation.fail) throw new Error('mesh topic activation failed for mesh.m1.events')
    return 0
  },
}))
vi.mock('../../src/seqscribe/mesh-turn-consumer.js', () => ({
  pruneRetiredMeshConsumers: () => { calls.push('prune'); return 0 },
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
vi.mock('../../src/seqscribe/writer-gc.js', () => ({
  configureTranscriptWriterGc: rec('writerGc'),
}))
vi.mock('../../src/config/mesh-config.js', () => ({ listMeshesReadOnly: () => [{ id: 'm1' }] }))

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
  beforeEach(() => { calls.length = 0; topicActivation.fail = false })

  it('arms in the fixed order and binds the one runtime slot first', () => {
    const { rt, s5 } = stage()
    const steps: string[] = []
    const s6 = armSeqscribeProjections(s5, { onStep: s => steps.push(s) })
    expect(steps).toEqual([
      'arm:slot', 'arm:publisher', 'arm:fleet-shadow', 'arm:fleet-parity',
      'arm:transcript', 'arm:transcript-writer-gc', 'arm:activate-topics', 'arm:prune-consumers',
    ])
    // Publisher before topic activation / prune; shadow before parity. No read
    // model (C7-2), no redrive (the S7 turn.deliver cursor is redelivery), no
    // mesh parity loop (C7-6). The retired cursors are pruned BEFORE S7 arms
    // the turn cursors. Writer-gc (G2b) arms right after the transcript
    // projection it depends on.
    expect(calls).toEqual([
      'publisher(node)', 'fleetShadow(node)', 'fleetParity(node)',
      'transcript(deps)', 'transcriptBus', 'writerGc(node)', 'activateTopics', 'prune',
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
      'disarm:attach', 'disarm:transcript-writer-gc', 'disarm:transcript',
      'disarm:fleet-parity', 'disarm:fleet-shadow', 'disarm:publisher', 'disarm:slot',
    ])
    // fleet parity detaches before its shadow; the publisher detaches last but the slot.
    // Writer-gc disarms before the transcript projection it depends on.
    expect(calls).toEqual([
      'writerGc(null)', 'transcriptBus.off', 'transcript(null)',
      'fleetParity(null)', 'fleetShadow(null)', 'publisher(null)',
    ])
    expect(seqscribeSlot.current()).toBeNull()
    expect(rt.projections()).toBeNull()
    // Idempotent.
    s6.disarmProjections()
    expect(steps).toHaveLength(7)
  })

  it('a known mesh whose events topic cannot be defined fails the stage (C7-1) and unwinds what it armed', () => {
    const { s5 } = stage()
    topicActivation.fail = true
    const steps: string[] = []
    expect(() => armSeqscribeProjections(s5, { onStep: s => steps.push(s) })).toThrow(/mesh topic activation failed/)
    // Nothing past the failed step armed, and the slot/publisher/writer-gc were unwound.
    expect(steps).not.toContain('arm:activate-topics')
    expect(calls).toContain('publisher(null)')
    expect(calls).toContain('writerGc(null)')
    expect(seqscribeSlot.current()).toBeNull()
  })

  it('without a node it arms nothing and binds no slot', () => {
    const { s5 } = stage()
    const s6 = armSeqscribeProjections({ ...s5, seqscribe: null })
    expect(calls).toEqual([])
    expect(seqscribeSlot.current()).toBeNull()
    s6.disarmProjections()
  })
})
