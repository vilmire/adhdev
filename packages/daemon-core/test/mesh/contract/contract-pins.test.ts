/**
 * Contract versioning Cut A — dispatch pins and bindings.
 *   AC14 R24 same-attempt generation bump
 *   AC15 R25 holder with a different prior pin (RN-03)
 *   AC16 read/action races across authority and recipient changes
 *   AC27 pin budget and provider composition (block-level; dispatch-level in contract-dispatch-wiring.test.ts)
 */
import { describe, expect, it } from 'vitest'
import { acceptUnits, makeHarness, refusalCode, type Harness } from './contract-test-helpers'
import {
  admitDispatch, bindMissionScope, bodyCarriesPinBlock, getBinding, rebindToHolder, renderPinBlock, stampTaskScopeFromMission,
} from '../../../src/mesh/contract/contract-pins'
import { contractObserve, contractRead } from '../../../src/mesh/contract/contract-reads'
import { assessResultEligibility, recordResultEvidence } from '../../../src/mesh/contract/contract-assessment'
import { issueWorkerPrincipal } from '../../../src/mesh/contract/contract-context'
import { transferAuthority } from '../../../src/mesh/contract/contract-authority'

function scoped(h: Harness, taskId: string, units?: string[]) {
  bindMissionScope(h.ctx, h.owner, { meshId: h.meshId, missionId: 'mission', namespaceId: h.ns, ...(units ? { units } : {}) })
  stampTaskScopeFromMission(h.ctx, h.meshId, taskId, 'mission')
}

function admit(h: Harness, taskId: string, attemptId: string, generation: number, sessionId: string) {
  return admitDispatch(h.ctx, { meshId: h.meshId, taskId, attemptId, generation, recipient: { sessionId, daemonId: 'daemon-A' }, recipientSupportsContractTools: true })!
}

function readAll(h: Harness, w: ReturnType<typeof issueWorkerPrincipal>, bindingId: string, unitIds: string[]) {
  const units = unitIds.map((u) => {
    const r = contractRead(h.ctx, w, { bindingId, unitId: u })
    return { unitId: u, unitDigest: r.unitDigest }
  })
  contractObserve(h.ctx, w, { bindingId, units })
}

describe('AC14 — R24 same-attempt generation bump', () => {
  it('generation 1 gets a fresh pin/binding; generation-0 receipts cannot count for it, in either settlement order', () => {
    const h = makeHarness()
    acceptUnits(h, { a: 'R1 text' })
    scoped(h, 't')
    const g0 = admit(h, 't', 'att', 0, 'S1')
    const w0 = issueWorkerPrincipal({ meshId: h.meshId, taskId: 't', attemptId: 'att', generation: 0, sessionId: 'S1' })
    acceptUnits(h, { a: 'R2 text' }) // R2 accepted before generation 1 claim
    const g1 = admit(h, 't', 'att', 1, 'S1')
    expect(g1.binding.bindingId).not.toBe(g0.binding.bindingId)
    expect(g1.binding.pinSetId).not.toBe(g0.binding.pinSetId)
    // Order A: the stale generation-0 read settles after generation 1 exists.
    expect(refusalCode(() => contractRead(h.ctx, w0, { bindingId: g0.binding.bindingId, unitId: 'a' }))).toBe('binding_not_active')
    expect(refusalCode(() => contractRead(h.ctx, w0, { bindingId: g1.binding.bindingId, unitId: 'a' }))).toBe('binding_not_active')
    const w1 = issueWorkerPrincipal({ meshId: h.meshId, taskId: 't', attemptId: 'att', generation: 1, sessionId: 'S1' })
    readAll(h, w1, g1.binding.bindingId, ['a'])
    const ev = recordResultEvidence(h.ctx, { meshId: h.meshId, taskId: 't', attemptId: 'att', generation: 1, outputVersion: 1, payloadDigest: 'd1' }, { sessionId: 'S1' })!
    expect(assessResultEligibility(h.ctx, ev.resultKey, 'dependency').state).toBe('eligible')
    // Historical generation-0 binding stays inspectable.
    expect(getBinding(h.ctx, g0.binding.bindingId)!.state).toBe('superseded')
  })

  it('order B: generation-0 receipts recorded before the bump never satisfy generation-1 evidence', () => {
    const h = makeHarness()
    acceptUnits(h, { a: 'same text' })
    scoped(h, 't')
    const g0 = admit(h, 't', 'att', 0, 'S1')
    const w0 = issueWorkerPrincipal({ meshId: h.meshId, taskId: 't', attemptId: 'att', generation: 0, sessionId: 'S1' })
    readAll(h, w0, g0.binding.bindingId, ['a'])
    const g1 = admit(h, 't', 'att', 1, 'S1') // unchanged content, new generation ⇒ new binding
    expect(g1.binding.bindingId).not.toBe(g0.binding.bindingId)
    const ev = recordResultEvidence(h.ctx, { meshId: h.meshId, taskId: 't', attemptId: 'att', generation: 1, outputVersion: 1, payloadDigest: 'd1' }, { sessionId: 'S1' })!
    const a = assessResultEligibility(h.ctx, ev.resultKey, 'dependency')
    expect(a.state).toBe('held_missing_evidence')
    expect(a.reasons).toContain('missing_e2:a')
  })
})

describe('AC15 / RN-03 — R25 rebind to a holder with a different prior pin', () => {
  it('different holder pin ⇒ NEW binding id requiring fresh read + claim; S2 receipts are never relabelled', () => {
    const h = makeHarness()
    acceptUnits(h, { a: 'R1' })
    scoped(h, 't')
    const holderBinding = admit(h, 't', 'att', 0, 'S1') // trusted holder S1 admitted at R1
    acceptUnits(h, { a: 'R2' })
    const dup = admit(h, 't', 'att', 0, 'S2') // duplicate dispatch to S2 at R2
    const w2 = issueWorkerPrincipal({ meshId: h.meshId, taskId: 't', attemptId: 'att', generation: 0, sessionId: 'S2' })
    contractRead(h.ctx, w2, { bindingId: dup.binding.bindingId, unitId: 'a' })
    const r = rebindToHolder(h.ctx, { meshId: h.meshId, taskId: 't', attemptId: 'att', generation: 0, losingSessionId: 'S2', holderSessionId: 'S1' })
    expect(r.mode).toBe('fresh_binding')
    expect(r.bindingId).not.toBe(holderBinding.binding.bindingId)
    expect(r.bindingId).not.toBe(dup.binding.bindingId)
    expect(bodyCarriesPinBlock(`x\n${r.block}\ny`, r.block!)).toBe(true)
    // Deferred S2 read after the rebind cannot satisfy anything.
    expect(refusalCode(() => contractRead(h.ctx, w2, { bindingId: dup.binding.bindingId, unitId: 'a' }))).toBe('binding_not_active')
    // S1 result before any fresh read: held — the S2 receipt was not copied.
    const ev = recordResultEvidence(h.ctx, { meshId: h.meshId, taskId: 't', attemptId: 'att', generation: 0, outputVersion: 1, payloadDigest: 'd' }, { sessionId: 'S1' })!
    expect(assessResultEligibility(h.ctx, ev.resultKey, 'dependency').state).toBe('held_missing_evidence')
    const reads = h.db.prepare('SELECT binding_id, session_id FROM contract_reads').all() as any[]
    expect(reads).toEqual([{ binding_id: dup.binding.bindingId, session_id: 'S2' }])
    // The amendment notice is durable for the holder.
    expect((h.db.prepare(`SELECT notice_class FROM contract_notices WHERE binding_id = ?`).get(r.bindingId) as any).notice_class).toBe('binding_amended')
  })

  it('positive control: holder evidence already matching the exact pin set is re-linked without a fabricated read', () => {
    const h = makeHarness()
    acceptUnits(h, { a: 'R1' })
    scoped(h, 't')
    const holder = admit(h, 't', 'att', 0, 'S1')
    const w1 = issueWorkerPrincipal({ meshId: h.meshId, taskId: 't', attemptId: 'att', generation: 0, sessionId: 'S1' })
    readAll(h, w1, holder.binding.bindingId, ['a'])
    const dup = admit(h, 't', 'att', 0, 'S2') // same head ⇒ same pin set
    expect(dup.binding.pinSetId).toBe(holder.binding.pinSetId)
    const r = rebindToHolder(h.ctx, { meshId: h.meshId, taskId: 't', attemptId: 'att', generation: 0, losingSessionId: 'S2', holderSessionId: 'S1' })
    expect(r).toEqual({ mode: 'linked', bindingId: holder.binding.bindingId })
    const ev = recordResultEvidence(h.ctx, { meshId: h.meshId, taskId: 't', attemptId: 'att', generation: 0, outputVersion: 1, payloadDigest: 'd' }, { sessionId: 'S1' })!
    expect(assessResultEligibility(h.ctx, ev.resultKey, 'dependency').state).toBe('eligible')
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM contract_reads').get() as any).n).toBe(1) // no fabricated receipt
  })
})

describe('AC16 — read/action races across authority and recipient changes', () => {
  it('an old binding cannot attach evidence after the recipient changes; the unchanged exact binding keeps working', () => {
    const h = makeHarness()
    acceptUnits(h, { a: 'R1', b: 'B' })
    scoped(h, 't')
    const b1 = admit(h, 't', 'att', 0, 'S1')
    const w1 = issueWorkerPrincipal({ meshId: h.meshId, taskId: 't', attemptId: 'att', generation: 0, sessionId: 'S1' })
    expect(refusalCode(() => contractRead(h.ctx, w1, { bindingId: b1.binding.bindingId, unitId: 'a' }))).toBeNull()
    const b2 = admit(h, 't', 'att', 0, 'S3') // recipient changed
    expect(refusalCode(() => contractRead(h.ctx, w1, { bindingId: b1.binding.bindingId, unitId: 'b' }))).toBe('binding_not_active')
    expect(refusalCode(() => contractObserve(h.ctx, w1, { bindingId: b1.binding.bindingId, units: [{ unitId: 'a', unitDigest: 'x' }] }))).toBe('binding_not_active')
    const w3 = issueWorkerPrincipal({ meshId: h.meshId, taskId: 't', attemptId: 'att', generation: 0, sessionId: 'S3' })
    expect(refusalCode(() => contractRead(h.ctx, w3, { bindingId: b2.binding.bindingId, unitId: 'a' }))).toBeNull()
    // Authority change: reads fail closed while the authority is not active here.
    transferAuthority(h.ctx, h.owner, { namespaceId: h.ns, newDaemonId: 'daemon-B', oldWriterFenced: false })
    expect(refusalCode(() => contractRead(h.ctx, w3, { bindingId: b2.binding.bindingId, unitId: 'b' }))).toBe('unavailable')
  })
})

describe('AC27 — pin budget', () => {
  it('block is measured in UTF-8 bytes independently; one byte over the budget refuses before any binding is stored', () => {
    const block = renderPinBlock({ namespaceId: 'ns_x', pinSetId: 'pin_y', vector: { authorityEpoch: 1, headGeneration: 1 }, bindingId: 'bnd_z', unitIds: ['a'] })
    const bytes = Buffer.byteLength(block, 'utf8')
    const atLimit = makeHarness({ budgets: { maxPinBlockBytes: 4096 } })
    acceptUnits(atLimit, { a: 'x' })
    scoped(atLimit, 't')
    const adm = admit(atLimit, 't', 'att', 0, 'S1')
    expect(adm.blockBytes).toBe(Buffer.byteLength(adm.block, 'utf8'))
    expect(adm.blockBytes).toBeLessThanOrEqual(1024) // fits the O9 proposal with the provisional default unit count
    const over = makeHarness({ budgets: { maxPinBlockBytes: adm.blockBytes - 1 } })
    acceptUnits(over, { a: 'x' })
    scoped(over, 't')
    expect(refusalCode(() => admit(over, 't', 'att', 0, 'S1'))).toBe('pin_block_over_budget')
    expect((over.db.prepare('SELECT COUNT(*) AS n FROM contract_bindings').get() as any).n).toBe(0)
    const exact = makeHarness({ budgets: { maxPinBlockBytes: adm.blockBytes } })
    acceptUnits(exact, { a: 'x' })
    scoped(exact, 't')
    expect(refusalCode(() => admit(exact, 't', 'att', 0, 'S1'))).toBeNull()
    expect(bytes).toBeGreaterThan(0)
  })

  it('more pins than the direct-pin budget, an unsupported strict participant, or a remote daemon refuse admission', () => {
    const h = makeHarness({ budgets: { maxDirectTaskPins: 2 } })
    acceptUnits(h, { a: '1', b: '2', c: '3' })
    scoped(h, 't')
    expect(refusalCode(() => admit(h, 't', 'att', 0, 'S1'))).toBe('budget_exceeded')
    const h2 = makeHarness()
    acceptUnits(h2, { a: '1' })
    scoped(h2, 't')
    expect(refusalCode(() => admitDispatch(h2.ctx, { meshId: h2.meshId, taskId: 't', attemptId: 'a', generation: 0, recipient: { sessionId: 'S' }, recipientSupportsContractTools: false }))).toBe('strict_participant_unsupported')
    expect(refusalCode(() => admitDispatch(h2.ctx, { meshId: h2.meshId, taskId: 't', attemptId: 'a', generation: 0, recipient: { sessionId: 'S', daemonId: 'daemon-REMOTE' }, recipientSupportsContractTools: true }))).toBe('strict_participant_unsupported')
  })

  it('the validator requires the exact block exactly once (an authored footer or a truncated/duplicated block fails)', () => {
    const block = renderPinBlock({ namespaceId: 'ns', pinSetId: 'p', vector: { authorityEpoch: 1, headGeneration: 2 }, bindingId: 'b', unitIds: ['a', 'é'] })
    expect(bodyCarriesPinBlock(`task\n${block}\nfooter`, block)).toBe(true)
    expect(bodyCarriesPinBlock(`task\n${block.slice(0, -5)}`, block)).toBe(false)
    expect(bodyCarriesPinBlock(`task\n${block}\n${block}`, block)).toBe(false)
    expect(bodyCarriesPinBlock('task only, worker-authored "<<<ADHDEV-CONTRACT-PINS>>>"', block)).toBe(false)
  })

  it('an unscoped (compat-open) task is admitted with no block at all', () => {
    const h = makeHarness()
    acceptUnits(h, { a: 'x' })
    expect(admitDispatch(h.ctx, { meshId: h.meshId, taskId: 'legacy', attemptId: 'a', generation: 0, recipient: { sessionId: 'S' }, recipientSupportsContractTools: false })).toBeNull()
  })
})
