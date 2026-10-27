/**
 * Contract versioning Cut A — privacy.
 *   AC29 redaction and content-free observability
 *   AC30 cross-namespace existence and digest privacy
 */
import { describe, expect, it } from 'vitest'
import { acceptUnits, grant, makeHarness, refusalCode } from './contract-test-helpers'
import { redactLogLine } from '../../../src/logging/log-redactor'
import { ContractRefusal } from '../../../src/mesh/contract/contract-types'
import { verifyCoordinatorCapability, mintCoordinatorGrant, currentHeadVector } from '../../../src/mesh/contract/contract-authority'
import { admitDispatch, bindMissionScope, stampTaskScopeFromMission } from '../../../src/mesh/contract/contract-pins'
import { contractRead } from '../../../src/mesh/contract/contract-reads'
import { issueWorkerPrincipal } from '../../../src/mesh/contract/contract-context'

describe('AC29 — redaction and content-free refusals', () => {
  it('csb_/wtk_/wsb_ bearer values never survive log redaction', () => {
    const secrets = ['csb_AbCdEfGhIjKlMnOpQrStUvWxYz012345-_', 'wtk_ZZZZZZZZZZZZZZZZZZZZZZZZ', 'wsb_qqqqqqqqqqqqqqqqqqqqqqqqqqqq']
    for (const s of secrets) {
      const out = redactLogLine(`grant minted capability=${s} for session`)
      expect(out).not.toContain(s.slice(4))
      expect(out).toContain(s.slice(0, 4))
    }
  })

  it('refusal messages carry only allowlisted codes — no secret, prose, path or digest echo', () => {
    const h = makeHarness()
    acceptUnits(h, { a: 'PROSE-CANARY-7731 /home/secret/path' })
    const canaries = ['PROSE-CANARY-7731', '/home/secret/path', 'csb_']
    const g = mintCoordinatorGrant(h.ctx, h.owner, { namespaceId: h.ns, coordinatorSessionId: 'S', ops: ['assess'] })
    const errors: string[] = []
    for (const fn of [
      () => verifyCoordinatorCapability(h.ctx, `${g.capability}x`, { namespaceId: h.ns, sessionId: 'S', op: 'assess' }),
      () => verifyCoordinatorCapability(h.ctx, g.capability, { namespaceId: h.ns, sessionId: 'S', op: 'accept' }),
      () => verifyCoordinatorCapability(h.ctx, 'PROSE-CANARY-7731', { namespaceId: h.ns, sessionId: 'S', op: 'assess' }),
    ]) {
      try { fn() } catch (e) { errors.push(String((e as Error).message)); expect(e).toBeInstanceOf(ContractRefusal) }
    }
    expect(errors.length).toBe(3)
    for (const msg of errors) {
      expect(msg).toMatch(/^contract_refused:[a-z_]+$/)
      for (const c of canaries) expect(msg).not.toContain(c)
    }
    expect(errors.join('')).not.toContain(g.capability)
  })
})

describe('AC30 — cross-namespace existence and digest privacy', () => {
  it('an N1 principal learns nothing about N2: same refusal whether N2 exists or not; ids are namespace-scoped', () => {
    const h1 = makeHarness()
    const h2 = makeHarness({ db: h1.db, fence: h1.fence })
    const r1 = acceptUnits(h1, { a: 'yes' })
    const r2 = acceptUnits(h2, { a: 'yes' }) // equal low-entropy content in N2
    const n1 = grant(h1, 'S1', ['assess'])
    const existing = refusalCode(() => verifyCoordinatorCapability(h1.ctx, n1.capability, { namespaceId: h2.ns, sessionId: 'S1', op: 'assess' }))
    const missing = refusalCode(() => verifyCoordinatorCapability(h1.ctx, n1.capability, { namespaceId: 'ns_does_not_exist', sessionId: 'S1', op: 'assess' }))
    expect(existing).toBe('scope_mismatch')
    expect(missing).toBe(existing)
    // Revision identities are namespace-domain digests: equal prose does not correlate across namespaces.
    expect(r1.acc.vector.revisionId).not.toBe(r2.acc.vector.revisionId)
    // A worker of N1 cannot read through an N2 binding (indistinguishable from a missing one).
    bindMissionScope(h2.ctx, h2.owner, { meshId: h2.meshId, missionId: 'm', namespaceId: h2.ns })
    stampTaskScopeFromMission(h2.ctx, h2.meshId, 't2', 'm')
    const adm2 = admitDispatch(h2.ctx, { meshId: h2.meshId, taskId: 't2', attemptId: 'a', generation: 0, recipient: { sessionId: 'S2', daemonId: 'daemon-A' }, recipientSupportsContractTools: true })!
    const w1 = issueWorkerPrincipal({ meshId: h1.meshId, taskId: 't1', attemptId: 'a', generation: 0, sessionId: 'S2' })
    expect(refusalCode(() => contractRead(h1.ctx, w1, { bindingId: adm2.binding.bindingId, unitId: 'a' }))).toBe('binding_missing')
    expect(refusalCode(() => contractRead(h1.ctx, w1, { bindingId: 'bnd_nonexistent', unitId: 'a' }))).toBe('binding_missing')
    expect(currentHeadVector(h1.ctx, h1.ns)!.namespaceId).toBe(h1.ns)
  })
})
