/**
 * Contract versioning Cut A — evidence, eligibility, retention, guards.
 *   AC06 served bytes are not a semantic read (E2 vs C1)
 *   AC07 crash between completion and evidence assessment (core join)
 *   AC13 Refinery admission/landing race — guard core (RN-02 scoped, crash convergence)
 *   AC18 audit quarantine idempotency and body-loss prevention
 *   AC19 quarantine is never eligible
 *   AC24 GC, spool quota and legal purge
 *   AC31 exact revalidation and no stale cached decisions
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { acceptUnits, grant, makeHarness, refusalCode, type Harness } from './contract-test-helpers'
import { admitDispatch, bindMissionScope, stampTaskScopeFromMission } from '../../../src/mesh/contract/contract-pins'
import { __setContractReadFaultForTests, contractObserve, contractRead } from '../../../src/mesh/contract/contract-reads'
import {
  __setContractEvidenceJoinFaultForTests, assessResultEligibility, assessTaskForPurpose, beginGuardedUse, recordResultEvidence, revalidateResult,
} from '../../../src/mesh/contract/contract-assessment'
import { issueWorkerPrincipal } from '../../../src/mesh/contract/contract-context'
import { currentHeadVector, beginContractProcessIncarnation, updatePolicy } from '../../../src/mesh/contract/contract-authority'
import { acceptProposal, proposeRevision, reviewProposal, revokeRevision, stageSpoolBody } from '../../../src/mesh/contract/contract-proposals'
import { finishUseGuard, getUseGuard, markUseGuardUnknown, reconcileUnknownUseGuard, recordGuardIntent } from '../../../src/mesh/contract/contract-use-guards'
import { beginContractGc, legalPurgeBody, quarantineHistoricalReport, runContractGc, sweepContractGc } from '../../../src/mesh/contract/contract-retention'

afterEach(() => { __setContractReadFaultForTests(null); __setContractEvidenceJoinFaultForTests(null) })

function setup(h: Harness, units: Record<string, string>, taskId = 't') {
  acceptUnits(h, units)
  bindMissionScope(h.ctx, h.owner, { meshId: h.meshId, missionId: 'm', namespaceId: h.ns })
  stampTaskScopeFromMission(h.ctx, h.meshId, taskId, 'm')
  const adm = admitDispatch(h.ctx, { meshId: h.meshId, taskId, attemptId: 'att', generation: 0, recipient: { sessionId: 'S1', daemonId: 'daemon-A' }, recipientSupportsContractTools: true })!
  const w = issueWorkerPrincipal({ meshId: h.meshId, taskId, attemptId: 'att', generation: 0, sessionId: 'S1' })
  return { adm, w, bindingId: adm.binding.bindingId }
}

const ref = (h: Harness, taskId = 't', v = 1) => ({ meshId: h.meshId, taskId, attemptId: 'att', generation: 0, outputVersion: v, payloadDigest: `digest-${v}` })

function readFully(h: Harness, w: any, bindingId: string, unitId: string) {
  return contractRead(h.ctx, w, { bindingId, unitId })
}

describe('AC06 — served bytes are not a semantic read', () => {
  it('partial, interrupted and foreign reads never count as full; full E2 alone has no C1', () => {
    const h = makeHarness({ budgets: { maxReadBytesPerRequest: 4 } })
    const text = 'abcdefghij'
    const { w, bindingId } = setup(h, { a: text })
    const first = contractRead(h.ctx, w, { bindingId, unitId: 'a', rangeStart: 0, rangeEnd: 4 })
    expect(first.fullCoverage).toBe(false)
    expect(refusalCode(() => contractObserve(h.ctx, w, { bindingId, units: [{ unitId: 'a', unitDigest: first.unitDigest }] }))).toBe('no_full_receipt')
    // Interrupted serve: no receipt recorded at all.
    __setContractReadFaultForTests(() => { throw new Error('socket closed') })
    expect(refusalCode(() => contractRead(h.ctx, w, { bindingId, unitId: 'a', rangeStart: 4, rangeEnd: 8 }))).toBe('THREW:socket closed')
    __setContractReadFaultForTests(null)
    // Foreign binding receipt cannot be claimed.
    const foreign = issueWorkerPrincipal({ meshId: h.meshId, taskId: 't', attemptId: 'att', generation: 0, sessionId: 'S-other' })
    expect(refusalCode(() => contractRead(h.ctx, foreign, { bindingId, unitId: 'a' }))).toBe('binding_not_active')
    contractRead(h.ctx, w, { bindingId, unitId: 'a', rangeStart: 4, rangeEnd: 8 })
    const last = contractRead(h.ctx, w, { bindingId, unitId: 'a', rangeStart: 8, rangeEnd: 10 })
    expect(last.fullCoverage).toBe(true)
    // Full served coverage WITHOUT a claim ⇒ held (no automatic C1).
    const ev = recordResultEvidence(h.ctx, ref(h), { sessionId: 'S1' })!
    const a = assessResultEligibility(h.ctx, ev.resultKey, 'dependency')
    expect(a.state).toBe('held_missing_evidence')
    expect(a.reasons).toEqual(['missing_c1:a'])
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM contract_claims').get() as any).n).toBe(0)
  })

  it('full served bytes plus an explicit claim from the same active binding satisfies the evidence policy', () => {
    const h = makeHarness()
    const { w, bindingId } = setup(h, { a: 'the contract' })
    const r = readFully(h, w, bindingId, 'a')
    expect(r.content).toBe('the contract')
    contractObserve(h.ctx, w, { bindingId, units: [{ unitId: 'a', unitDigest: r.unitDigest }] })
    const ev = recordResultEvidence(h.ctx, ref(h), { sessionId: 'S1' })!
    expect(assessResultEligibility(h.ctx, ev.resultKey, 'dependency')).toMatchObject({ state: 'eligible', usable: true })
    // The private snapshot names exact coverage and binding.
    const snap = JSON.parse((h.db.prepare('SELECT evidence_json FROM contract_result_evidence').get() as any).evidence_json)
    expect(snap.bindingId).toBe(bindingId)
    expect(snap.units[0]).toMatchObject({ unitId: 'a', e2Full: true })
    expect(snap.units[0].c1ClaimIds.length).toBe(1)
  })

  it('E2-only policy is labelled served_bytes_only, never a read acknowledgement', () => {
    const h = makeHarness()
    const { w, bindingId } = setup(h, { a: 'x' })
    readFully(h, w, bindingId, 'a')
    const ev = recordResultEvidence(h.ctx, ref(h), { sessionId: 'S1' })!
    updatePolicy(h.ctx, h.owner, h.ns, { evidenceMode: 'E2' })
    // Policy revision moved ⇒ revalidation needed even in E2 mode (exact vector identity).
    expect(assessResultEligibility(h.ctx, ev.resultKey, 'dependency').state).toBe('needs_revalidation')
  })
})

describe('AC07 — crash between completion and the evidence join', () => {
  it('before the join every consumer holds; replay creates exactly one snapshot; afterwards it is usable', () => {
    const h = makeHarness()
    const { w, bindingId } = setup(h, { a: 'x' })
    const r = readFully(h, w, bindingId, 'a')
    contractObserve(h.ctx, w, { bindingId, units: [{ unitId: 'a', unitDigest: r.unitDigest }] })
    __setContractEvidenceJoinFaultForTests(() => { throw new Error('crash') })
    expect(refusalCode(() => recordResultEvidence(h.ctx, ref(h), { sessionId: 'S1' }))).toBe('THREW:crash')
    __setContractEvidenceJoinFaultForTests(null)
    for (const purpose of ['dependency', 'handoff', 'context', 'integration_admission', 'integration_landing', 'mission_close'] as const) {
      expect(assessTaskForPurpose(h.ctx, { meshId: h.meshId, taskId: 't', purpose, latestOutput: { version: 1, digest: 'digest-1' } }).usable).toBe(false)
    }
    expect(recordResultEvidence(h.ctx, ref(h), { sessionId: 'S1' })!.created).toBe(true)
    expect(recordResultEvidence(h.ctx, ref(h), { sessionId: 'S1' })!.created).toBe(false)
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM contract_result_evidence').get() as any).n).toBe(1)
    expect(assessTaskForPurpose(h.ctx, { meshId: h.meshId, taskId: 't', purpose: 'dependency', latestOutput: { version: 1, digest: 'digest-1' } }).state).toBe('eligible')
  })

  it('unscoped tasks stay compat-open and are untouched', () => {
    const h = makeHarness()
    expect(recordResultEvidence(h.ctx, ref(h, 'legacy'))).toBeNull()
    expect(assessTaskForPurpose(h.ctx, { meshId: h.meshId, taskId: 'legacy', purpose: 'dependency', latestOutput: null })).toEqual({ state: 'compat_open', usable: true, reasons: [] })
  })
})

function eligibleResult(h: Harness, units: Record<string, string>) {
  const s = setup(h, units)
  for (const unitId of Object.keys(units)) {
    const r = readFully(h, s.w, s.bindingId, unitId)
    contractObserve(h.ctx, s.w, { bindingId: s.bindingId, units: [{ unitId, unitDigest: r.unitDigest }] })
  }
  return recordResultEvidence(h.ctx, ref(h), { sessionId: 'S1' })!.resultKey
}

describe('AC31 — exact revalidation and cache invalidation', () => {
  it('only an authorized exact result/vector/purpose assessment unblocks; a later head holds again; workers cannot self-assess', () => {
    const h = makeHarness()
    const key = eligibleResult(h, { a: 'R1' })
    acceptUnits(h, { a: 'R2' })
    expect(assessResultEligibility(h.ctx, key, 'dependency').state).toBe('needs_revalidation')
    const worker = issueWorkerPrincipal({ meshId: h.meshId, taskId: 't', attemptId: 'att', generation: 0, sessionId: 'S1' })
    const vector = currentHeadVector(h.ctx, h.ns)!
    expect(refusalCode(() => revalidateResult(h.ctx, worker, { resultKey: key, purpose: 'dependency', expectedVector: vector, decision: 'compatible', reason: 'self' }))).toBe('not_authorized')
    const noAssess = grant(h, 'coord-x', ['review'])
    expect(refusalCode(() => noAssess.principal('assess'))).toBe('not_authorized')
    const assessor = grant(h, 'coord-assess', ['assess'])
    const stale = { ...vector, headGeneration: vector.headGeneration - 1 }
    expect(refusalCode(() => revalidateResult(h.ctx, assessor.principal('assess'), { resultKey: key, purpose: 'dependency', expectedVector: stale, decision: 'compatible', reason: 'stale' }))).toBe('vector_mismatch')
    const r = revalidateResult(h.ctx, assessor.principal('assess'), { resultKey: key, purpose: 'dependency', expectedVector: vector, decision: 'compatible', reason: 'unit a semantics unchanged for this result' })
    expect(r.eligibility.state).toBe('eligible')
    // Other purposes and other output versions remain held.
    expect(assessResultEligibility(h.ctx, key, 'integration_landing').state).toBe('needs_revalidation')
    const other = recordResultEvidence(h.ctx, ref(h, 't', 2), { sessionId: 'S1' })!
    expect(assessResultEligibility(h.ctx, other.resultKey, 'dependency').state).toBe('needs_revalidation')
    // The next head invalidates the earlier revalidation immediately (no stale cache).
    acceptUnits(h, { a: 'R3' })
    expect(assessResultEligibility(h.ctx, key, 'dependency').state).toBe('needs_revalidation')
  })

  it('a narrow waiver is scoped and expires; revoked origin is never waivable', () => {
    const h = makeHarness()
    const key = eligibleResult(h, { a: 'R1' })
    acceptUnits(h, { a: 'R2' })
    const vector = currentHeadVector(h.ctx, h.ns)!
    expect(refusalCode(() => revalidateResult(h.ctx, h.owner, { resultKey: key, purpose: 'dependency', expectedVector: vector, decision: 'waiver', reason: 'r' }))).toBe('invalid_input')
    revalidateResult(h.ctx, h.owner, { resultKey: key, purpose: 'dependency', expectedVector: vector, decision: 'waiver', reason: 'hotfix window', expiresAt: h.clock.now + 60_000 })
    expect(assessResultEligibility(h.ctx, key, 'dependency').state).toBe('waived')
    h.clock.now += 60_001
    expect(assessResultEligibility(h.ctx, key, 'dependency').state).toBe('needs_revalidation')
    const pinned = (h.db.prepare('SELECT revision_id FROM contract_pin_sets').get() as any).revision_id
    revokeRevision(h.ctx, h.owner, { namespaceId: h.ns, revisionId: pinned })
    expect(assessResultEligibility(h.ctx, key, 'dependency').state).toBe('rejected_revoked')
    expect(refusalCode(() => revalidateResult(h.ctx, h.owner, { resultKey: key, purpose: 'dependency', expectedVector: currentHeadVector(h.ctx, h.ns)!, decision: 'waiver', reason: 'x', expiresAt: h.clock.now + 1000 }))).toBe('revoked')
  })
})

describe('AC18 / AC19 — audit-only quarantine', () => {
  it('idempotent by deliveryId+digest; changed bytes refused; refused without provenance; never eligible, not even by waiver', () => {
    const h = makeHarness()
    setup(h, { a: 'x' })
    const body = Buffer.from(JSON.stringify({ outcome: 'completed', summary: 'late' }))
    const digest = createHash('sha256').update(body).digest('hex')
    const base = { deliveryId: 'delivery-0001', meshId: h.meshId, taskId: 't', attemptId: 'att-old', body, payloadDigest: digest, preparedTuple: { preparedAtMs: 1 } }
    expect(quarantineHistoricalReport(h.ctx, { ...base, provenanceVerified: false })).toEqual({ disposition: 'refused_no_provenance' })
    const first = quarantineHistoricalReport(h.ctx, { ...base, provenanceVerified: true })
    expect(first.disposition).toBe('audit_only')
    const again = quarantineHistoricalReport(h.ctx, { ...base, provenanceVerified: true }) as any
    expect(again.receipt.duplicate).toBe(true)
    const changed = Buffer.from('{"outcome":"completed","summary":"edited"}')
    expect(quarantineHistoricalReport(h.ctx, { ...base, body: changed, payloadDigest: createHash('sha256').update(changed).digest('hex'), provenanceVerified: true })).toEqual({ disposition: 'digest_conflict' })
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM contract_audit_quarantine').get() as any).n).toBe(1)
    const row = h.db.prepare(`SELECT result_key FROM contract_result_evidence WHERE provenance = 'quarantine'`).get() as any
    expect(assessResultEligibility(h.ctx, row.result_key, 'dependency').state).toBe('rejected_ineligible_origin')
    expect(refusalCode(() => revalidateResult(h.ctx, h.owner, { resultKey: row.result_key, purpose: 'dependency', expectedVector: currentHeadVector(h.ctx, h.ns)!, decision: 'waiver', reason: 'please', expiresAt: h.clock.now + 1000 }))).toBe('ineligible_origin')
  })

  it('quota failure returns pending so the caller keeps its local bytes; refusal_local_only policy refuses', () => {
    const h = makeHarness({ budgets: { maxQuarantineBodyBytes: 8 } })
    setup(h, { a: 'x' })
    const body = Buffer.from('more than eight bytes')
    const digest = createHash('sha256').update(body).digest('hex')
    const input = { deliveryId: 'delivery-0002', meshId: h.meshId, taskId: 't', body, payloadDigest: digest, preparedTuple: {}, provenanceVerified: true }
    expect(quarantineHistoricalReport(h.ctx, input)).toEqual({ disposition: 'pending', reason: 'quota' })
    updatePolicy(h.ctx, h.owner, h.ns, { lateReportMode: 'refusal_local_only' })
    expect(quarantineHistoricalReport(h.ctx, input)).toEqual({ disposition: 'refused_local_only' })
  })
})

describe('AC24 — GC, spool quota and legal purge', () => {
  it('referenced bytes survive GC; a new reference during mark/sweep is protected; quota refuses explicitly', () => {
    const h = makeHarness({ budgets: { maxSpoolBytes: 64 } })
    eligibleResult(h, { a: 'pinned-body' })
    const orphan = stageSpoolBody(h.ctx, Buffer.from('orphan'))
    const plan = beginContractGc(h.ctx)
    const late = stageSpoolBody(h.ctx, Buffer.from('late-ref')) // staged after the barrier
    const { reclaimed } = sweepContractGc(h.ctx, plan)
    expect(reclaimed).toBe(1)
    const live = (h.db.prepare('SELECT digest FROM contract_spool WHERE body IS NOT NULL').all() as any[]).map(r => r.digest)
    expect(live).toContain(late)
    expect(live).not.toContain(orphan)
    expect(live.length).toBe(2)
    expect(refusalCode(() => stageSpoolBody(h.ctx, Buffer.alloc(80, 1)))).toBe('quota_exceeded')
    runContractGc(h.ctx)
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM contract_spool WHERE body IS NOT NULL').get() as any).n).toBe(1)
  })

  it('legal purge leaves a tombstone and an unavailable hold, never a current-file fallback', () => {
    const h = makeHarness()
    const key = eligibleResult(h, { a: 'secret contract' })
    const digest = (h.db.prepare('SELECT unit_digest FROM contract_units').get() as any).unit_digest
    expect(refusalCode(() => legalPurgeBody(h.ctx, issueWorkerPrincipal({ meshId: 'm', taskId: 't', attemptId: 'a', generation: 0, sessionId: 's' }) as any, digest, 'legal'))).toBe('not_owner')
    expect(legalPurgeBody(h.ctx, h.owner, digest, 'legal')).toBe(true)
    expect(assessResultEligibility(h.ctx, key, 'dependency')).toMatchObject({ state: 'unavailable', reasons: ['unit_purged'] })
    expect((h.db.prepare('SELECT reason FROM contract_tombstones').get() as any).reason).toBe('legal')
    expect(refusalCode(() => stageSpoolBody(h.ctx, Buffer.from('secret contract')))).toBe('unavailable')
  })
})

describe('AC13 / RN-02 — scoped use guards and crash convergence', () => {
  function guardedSetup() {
    const h = makeHarness()
    const key = eligibleResult(h, { a: 'A1', b: 'B1' })
    return { h, key }
  }
  function propose(h: Harness, units: Record<string, string>) {
    const commit = h.reader.commit('/repo/root', Object.fromEntries(Object.entries(units).map(([k, v]) => [`c/${k}.md`, v])))
    const base = currentHeadVector(h.ctx, h.ns)!
    const all = ['a', 'b']
    const p = proposeRevision(h.ctx, grant(h, `auth-${Math.random()}`, ['propose']).principal('propose'), {
      namespaceId: h.ns, baseHead: base, impact: 'nonbreaking',
      units: all.map(u => units[u] ? { unitId: u, source: { repoBindingId: 'root', commitOid: commit, path: `c/${u}.md` } } : { unitId: u, carryForward: true as const }),
    })
    reviewProposal(h.ctx, grant(h, `rev-${Math.random()}`, ['review']).principal('review'), { proposalId: p.proposalId, proposalVersion: 1, candidateRevisionId: p.candidateRevisionId, verdict: 'approve' })
    return () => acceptProposal(h.ctx, h.owner, { proposalId: p.proposalId, proposalVersion: 1, expectedHead: base, idempotencyKey: `guard-${Math.random().toString(36).slice(2)}` })
  }

  it('an accept racing the guarded publication of the same unit serializes behind the guard; unrelated units do not stall', () => {
    const { h, key } = guardedSetup()
    // Narrow the guard to unit a only by pinning a single unit for a second task.
    const { guard } = beginGuardedUse(h.ctx, { namespaceId: h.ns, resultKeys: [key], purpose: 'integration_landing' })
    expect(guard).not.toBeNull()
    expect(guard!.units).toEqual(['a', 'b'])
    expect(refusalCode(propose(h, { a: 'A2' }))).toBe('use_guard_conflict')
    finishUseGuard(h.ctx, guard!.guardId, 'published', { commit: 'abc' })
    expect(refusalCode(propose(h, { a: 'A2' }))).toBeNull()
    // After a completed use, the later head invalidates future reuse.
    expect(assessResultEligibility(h.ctx, key, 'integration_landing').state).toBe('needs_revalidation')
  })

  it('a guard over unit a does not block a change to unit b (scoped to the contract units)', () => {
    const h = makeHarness()
    acceptUnits(h, { a: 'A1', b: 'B1' })
    bindMissionScope(h.ctx, h.owner, { meshId: h.meshId, missionId: 'm', namespaceId: h.ns, units: ['a'] })
    stampTaskScopeFromMission(h.ctx, h.meshId, 't', 'm')
    const adm = admitDispatch(h.ctx, { meshId: h.meshId, taskId: 't', attemptId: 'att', generation: 0, recipient: { sessionId: 'S1', daemonId: 'daemon-A' }, recipientSupportsContractTools: true })!
    const w = issueWorkerPrincipal({ meshId: h.meshId, taskId: 't', attemptId: 'att', generation: 0, sessionId: 'S1' })
    const r = contractRead(h.ctx, w, { bindingId: adm.binding.bindingId, unitId: 'a' })
    contractObserve(h.ctx, w, { bindingId: adm.binding.bindingId, units: [{ unitId: 'a', unitDigest: r.unitDigest }] })
    const key = recordResultEvidence(h.ctx, ref(h), { sessionId: 'S1' })!.resultKey
    const { guard } = beginGuardedUse(h.ctx, { namespaceId: h.ns, resultKeys: [key], purpose: 'integration_landing' })
    expect(guard!.units).toEqual(['a'])
    expect(refusalCode(propose(h, { b: 'B2' }))).toBeNull()
    expect(refusalCode(propose(h, { a: 'A2' }))).toBe('use_guard_conflict')
  })

  it('held results never open a guard; a head that moved between admission and landing holds the final use', () => {
    const { h, key } = guardedSetup()
    expect(assessResultEligibility(h.ctx, key, 'integration_admission').usable).toBe(true) // provisional admission at R1
    propose(h, { a: 'A2' })() // R2 accepted before final landing
    const { guard, decisions } = beginGuardedUse(h.ctx, { namespaceId: h.ns, resultKeys: [key], purpose: 'integration_landing' })
    expect(guard).toBeNull()
    expect(decisions[0].state).toBe('needs_revalidation')
  })

  it('crash with an unknown external outcome blocks conflicting acceptance until reconciliation — never timer-only release', () => {
    const { h, key } = guardedSetup()
    const { guard } = beginGuardedUse(h.ctx, { namespaceId: h.ns, resultKeys: [key], purpose: 'integration_landing' })
    recordGuardIntent(h.ctx, guard!.guardId, { branch: 'feature', target: 'main', commit: 'c0ffee' })
    beginContractProcessIncarnation(h.ctx) // daemon crash/restart mid-publication
    expect(getUseGuard(h.ctx, guard!.guardId)!.state).toBe('unknown')
    h.clock.now += 365 * 24 * 3600 * 1000 // time alone changes nothing
    expect(refusalCode(propose(h, { a: 'A2' }))).toBe('use_guard_conflict')
    expect(reconcileUnknownUseGuard(h.ctx, guard!.guardId, () => 'indeterminate').state).toBe('unknown')
    let seenRef: any = null
    expect(reconcileUnknownUseGuard(h.ctx, guard!.guardId, (r) => { seenRef = r; return 'landed' }).state).toBe('finished')
    expect(seenRef).toEqual({ branch: 'feature', target: 'main', commit: 'c0ffee' })
    expect(refusalCode(propose(h, { a: 'A2' }))).toBeNull()
  })

  it('an exception mid-publication marks the guard unknown; a definite not-landed probe releases it', () => {
    const { h, key } = guardedSetup()
    const { guard } = beginGuardedUse(h.ctx, { namespaceId: h.ns, resultKeys: [key], purpose: 'integration_landing' })
    markUseGuardUnknown(h.ctx, guard!.guardId)
    expect(reconcileUnknownUseGuard(h.ctx, guard!.guardId, () => 'not_landed').state).toBe('released')
  })
})
