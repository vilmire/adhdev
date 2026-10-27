/**
 * Contract versioning Cut A — acceptance + notices.
 *   AC20 atomic CAS with idempotency and notice-outbox failures
 *   AC21 multiple bumps and ABA notice dedupe
 *   AC28 offline mailbox/PTY recovery and impact lag (core half)
 */
import { afterEach, describe, expect, it } from 'vitest'
import { acceptUnits, grant, makeHarness, refusalCode, type Harness } from './contract-test-helpers'
import { currentHeadVector, getAuthority } from '../../../src/mesh/contract/contract-authority'
import {
  __setContractAcceptFaultForTests, acceptProposal, closeProposal, proposeRevision, reviewProposal,
} from '../../../src/mesh/contract/contract-proposals'
import { admitDispatch, bindMissionScope, stampTaskScopeFromMission } from '../../../src/mesh/contract/contract-pins'
import { processImpactOutbox } from '../../../src/mesh/contract/contract-notices'
import { contractCurrent } from '../../../src/mesh/contract/contract-reads'
import { issueWorkerPrincipal } from '../../../src/mesh/contract/contract-context'

afterEach(() => __setContractAcceptFaultForTests(null))

function twoProposals(h: Harness) {
  const commit = h.reader.commit('/repo/root', { 'c/a.md': 'A1', 'c/b.md': 'B1' })
  const author = grant(h, 'author', ['propose'])
  const reviewer = grant(h, 'reviewer', ['review'])
  const base = currentHeadVector(h.ctx, h.ns)!
  const mk = (path: string, unitId: string) => {
    const p = proposeRevision(h.ctx, author.principal('propose'), { namespaceId: h.ns, baseHead: base, impact: 'nonbreaking', units: [{ unitId, source: { repoBindingId: 'root', commitOid: commit, path } }] })
    reviewProposal(h.ctx, reviewer.principal('review'), { proposalId: p.proposalId, proposalVersion: p.proposalVersion, candidateRevisionId: p.candidateRevisionId, verdict: 'approve' })
    return p
  }
  return { base, p1: mk('c/a.md', 'a'), p2: mk('c/b.md', 'b'), author, reviewer, commit }
}

describe('AC20 — atomic CAS acceptance', () => {
  it('100 concurrent accept attempts over two proposals sharing a base: exactly one winner, one head effect per key', () => {
    const h = makeHarness()
    const { base, p1, p2 } = twoProposals(h)
    const outcomes: Record<string, number> = {}
    let winners = 0
    for (let i = 0; i < 100; i += 1) {
      const p = i % 2 === 0 ? p1 : p2
      const key = `retry-key-${i % 10}-${i % 2}` // duplicated keys across retries
      try {
        const r = acceptProposal(h.ctx, h.owner, { proposalId: p.proposalId, proposalVersion: p.proposalVersion, expectedHead: base, idempotencyKey: key })
        if (!r.duplicate) winners += 1
        outcomes.ok = (outcomes.ok ?? 0) + 1
      } catch (e: any) {
        outcomes[e.code] = (outcomes[e.code] ?? 0) + 1
      }
    }
    expect(outcomes.invalid_input).toBeUndefined()
    expect(winners).toBe(1)
    expect(currentHeadVector(h.ctx, h.ns)!.headGeneration).toBe(1)
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM contract_head_log').get() as any).n).toBe(1)
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM contract_impact_outbox').get() as any).n).toBe(1)
    // Losing proposal sees a conflict carrying authorized current-head metadata, never last-writer-wins.
    expect(Object.keys(outcomes).filter(k => k !== 'ok').every(k => ['head_conflict', 'proposal_not_open', 'idempotency_conflict'].includes(k))).toBe(true)
  })

  it('a caller expected-head that does not match the current head is refused even when the proposal base matches', () => {
    const h = makeHarness()
    const { base, p1 } = twoProposals(h)
    const wrong = { ...base, policyRevision: base.policyRevision + 7 }
    const r = (() => { try { acceptProposal(h.ctx, h.owner, { proposalId: p1.proposalId, proposalVersion: 1, expectedHead: wrong, idempotencyKey: 'expected-key-1' }); return null } catch (e: any) { return e } })()
    expect(r?.code).toBe('head_conflict')
    expect(r?.current?.headGeneration).toBe(0) // conflict carries the authorized current head
    expect(currentHeadVector(h.ctx, h.ns)!.headGeneration).toBe(0)
  })

  it('same idempotency key with different request bytes is refused; same bytes replays the recorded result', () => {
    const h = makeHarness()
    const { base, p1, p2 } = twoProposals(h)
    const first = acceptProposal(h.ctx, h.owner, { proposalId: p1.proposalId, proposalVersion: 1, expectedHead: base, idempotencyKey: 'shared-key-1' })
    const again = acceptProposal(h.ctx, h.owner, { proposalId: p1.proposalId, proposalVersion: 1, expectedHead: base, idempotencyKey: 'shared-key-1' })
    expect(again.duplicate).toBe(true)
    expect(again.acceptanceId).toBe(first.acceptanceId)
    expect(refusalCode(() => acceptProposal(h.ctx, h.owner, { proposalId: p2.proposalId, proposalVersion: 1, expectedHead: base, idempotencyKey: 'shared-key-1' }))).toBe('idempotency_conflict')
  })

  it('a crash before commit moves nothing; a committed acceptance always carries its durable impact intent', () => {
    const h = makeHarness()
    const { base, p1 } = twoProposals(h)
    __setContractAcceptFaultForTests((point) => { if (point === 'after_head_update') throw new Error('crash') })
    expect(refusalCode(() => acceptProposal(h.ctx, h.owner, { proposalId: p1.proposalId, proposalVersion: 1, expectedHead: base, idempotencyKey: 'crash-key-1' }))).toBe('THREW:crash')
    expect(currentHeadVector(h.ctx, h.ns)!.headGeneration).toBe(0)
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM contract_impact_outbox').get() as any).n).toBe(0)
    __setContractAcceptFaultForTests((point) => { if (point === 'after_outbox') throw new Error('crash2') })
    expect(refusalCode(() => acceptProposal(h.ctx, h.owner, { proposalId: p1.proposalId, proposalVersion: 1, expectedHead: base, idempotencyKey: 'crash-key-1' }))).toBe('THREW:crash2')
    expect(currentHeadVector(h.ctx, h.ns)!.headGeneration).toBe(0)
    __setContractAcceptFaultForTests(null)
    // Notice transport unavailable: commit still holds its durable descriptor.
    const r = acceptProposal(h.ctx, h.owner, { proposalId: p1.proposalId, proposalVersion: 1, expectedHead: base, idempotencyKey: 'crash-key-1' })
    expect(r.vector.headGeneration).toBe(1)
    const outbox = h.db.prepare('SELECT status FROM contract_impact_outbox').all() as any[]
    expect(outbox).toEqual([{ status: 'pending' }])
  })

  it('stale reviews never approve a later candidate; losing proposal must be re-proposed and re-reviewed (no auto-merge)', () => {
    const h = makeHarness()
    const { base, p1, p2, author, reviewer, commit } = twoProposals(h)
    acceptProposal(h.ctx, h.owner, { proposalId: p1.proposalId, proposalVersion: 1, expectedHead: base, idempotencyKey: 'win-key-01' })
    const cur = currentHeadVector(h.ctx, h.ns)!
    expect(refusalCode(() => acceptProposal(h.ctx, h.owner, { proposalId: p2.proposalId, proposalVersion: 1, expectedHead: cur, idempotencyKey: 'lose-key-01' }))).toBe('proposal_not_open')
    const v2 = proposeRevision(h.ctx, author.principal('propose'), { proposalId: p2.proposalId, namespaceId: h.ns, baseHead: cur, impact: 'nonbreaking', units: [{ unitId: 'a', carryForward: true }, { unitId: 'b', source: { repoBindingId: 'root', commitOid: commit, path: 'c/b.md' } }] })
    expect(v2.proposalVersion).toBe(2)
    expect(refusalCode(() => acceptProposal(h.ctx, h.owner, { proposalId: p2.proposalId, proposalVersion: 2, expectedHead: cur, idempotencyKey: 'lose-key-02' }))).toBe('review_missing')
    reviewProposal(h.ctx, reviewer.principal('review'), { proposalId: p2.proposalId, proposalVersion: 2, candidateRevisionId: v2.candidateRevisionId, verdict: 'approve' })
    expect(acceptProposal(h.ctx, h.owner, { proposalId: p2.proposalId, proposalVersion: 2, expectedHead: cur, idempotencyKey: 'lose-key-03' }).vector.headGeneration).toBe(2)
  })

  it('O3 independence: the author cannot review its own proposal; O2: breaking changes need the owner', () => {
    const h = makeHarness()
    const commit = h.reader.commit('/repo/root', { 'c/a.md': 'A' })
    const both = grant(h, 'both', ['propose', 'review', 'accept'])
    const base = currentHeadVector(h.ctx, h.ns)!
    const p = proposeRevision(h.ctx, both.principal('propose'), { namespaceId: h.ns, baseHead: base, impact: 'breaking', units: [{ unitId: 'a', source: { repoBindingId: 'root', commitOid: commit, path: 'c/a.md' } }] })
    expect(refusalCode(() => reviewProposal(h.ctx, both.principal('review'), { proposalId: p.proposalId, proposalVersion: 1, candidateRevisionId: p.candidateRevisionId, verdict: 'approve' }))).toBe('review_not_independent')
    reviewProposal(h.ctx, grant(h, 'rev', ['review']).principal('review'), { proposalId: p.proposalId, proposalVersion: 1, candidateRevisionId: p.candidateRevisionId, verdict: 'approve' })
    expect(refusalCode(() => acceptProposal(h.ctx, both.principal('accept'), { proposalId: p.proposalId, proposalVersion: 1, expectedHead: base, idempotencyKey: 'brk-key-01' }))).toBe('impact_requires_owner')
    expect(acceptProposal(h.ctx, h.owner, { proposalId: p.proposalId, proposalVersion: 1, expectedHead: base, idempotencyKey: 'brk-key-02' }).vector.headGeneration).toBe(1)
  })

  it('rejection and withdrawal preserve history without moving the head', () => {
    const h = makeHarness()
    const { p1, p2, author, reviewer } = twoProposals(h)
    closeProposal(h.ctx, reviewer.principal('review'), { proposalId: p1.proposalId, proposalVersion: 1, status: 'rejected' })
    closeProposal(h.ctx, author.principal('propose'), { proposalId: p2.proposalId, proposalVersion: 1, status: 'withdrawn' })
    expect(currentHeadVector(h.ctx, h.ns)!.headGeneration).toBe(0)
    expect((h.db.prepare('SELECT status FROM contract_proposals ORDER BY status').all() as any[]).map(r => r.status)).toEqual(['rejected', 'withdrawn'])
  })
})

function admittedWorker(h: Harness, taskId: string) {
  bindMissionScope(h.ctx, h.owner, { meshId: h.meshId, missionId: 'm1', namespaceId: h.ns })
  stampTaskScopeFromMission(h.ctx, h.meshId, taskId, 'm1')
  const adm = admitDispatch(h.ctx, { meshId: h.meshId, taskId, attemptId: 'att-1', generation: 0, recipient: { sessionId: 'S1', daemonId: 'daemon-A' }, recipientSupportsContractTools: true })!
  const worker = issueWorkerPrincipal({ meshId: h.meshId, taskId, attemptId: 'att-1', generation: 0, sessionId: 'S1' })
  return { adm, worker }
}

describe('AC21 — multiple bumps and ABA notice dedupe', () => {
  it('R1→R2→R1 stays three distinct notices; retries do not duplicate; an epoch advance is distinguishable', () => {
    const h = makeHarness()
    acceptUnits(h, { a: 'R1' })
    const { worker } = admittedWorker(h, 't1')
    acceptUnits(h, { a: 'R2' })
    acceptUnits(h, { a: 'R1' }) // identical bytes ⇒ same revisionId content-wise, new headGeneration
    expect(currentHeadVector(h.ctx, h.ns)!.headGeneration).toBe(3)
    processImpactOutbox(h.ctx)
    processImpactOutbox(h.ctx) // retry
    let notices = h.db.prepare('SELECT head_generation, to_revision_id FROM contract_notices ORDER BY head_generation').all() as any[]
    expect(notices.map(n => n.head_generation)).toEqual([2, 3])
    // Mark the first native operation "submitted": a later head is not hidden by it.
    h.db.prepare(`UPDATE contract_notices SET hint_operation_id = 'op-1' WHERE head_generation = 2`).run()
    const view = contractCurrent(h.ctx, worker)
    expect(view.notices.map(n => n.headGeneration)).toEqual([2, 3])
    expect(view.currentVector!.headGeneration).toBe(3)
    // Transport acknowledgement never creates a read claim.
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM contract_claims').get() as any).n).toBe(0)
    // Epoch advance: a new semantic event even with the same revision.
    h.db.prepare('UPDATE contract_authorities SET authority_epoch = 2').run()
    h.db.prepare('UPDATE contract_heads SET authority_epoch = 2').run()
    h.db.prepare(`INSERT INTO contract_impact_outbox VALUES ('acc-epoch', ?, 2, 3, ?, 'head_advanced', '', 'pending', 0)`).run(h.ns, currentHeadVector(h.ctx, h.ns)!.revisionId)
    processImpactOutbox(h.ctx)
    notices = h.db.prepare('SELECT authority_epoch, head_generation FROM contract_notices ORDER BY authority_epoch, head_generation').all() as any[]
    expect(notices).toEqual([{ authority_epoch: 1, head_generation: 2 }, { authority_epoch: 1, head_generation: 3 }, { authority_epoch: 2, head_generation: 3 }])
  })
})

describe('AC28 — impact lag and offline recovery (core)', () => {
  it('crash after acceptance before fan-out: the descriptor survives and the pull path restores authoritative state', () => {
    const h = makeHarness()
    acceptUnits(h, { a: 'R1' })
    const { worker } = admittedWorker(h, 't1')
    acceptUnits(h, { a: 'R2' })
    // No fan-out ran (crash). The worker's pull still reports the authoritative head.
    const view = contractCurrent(h.ctx, worker)
    expect(view.currentVector!.headGeneration).toBe(2)
    expect(view.pinnedVector!.headGeneration).toBe(1)
    expect((h.db.prepare(`SELECT COUNT(*) AS n FROM contract_impact_outbox WHERE status = 'pending'`).get() as any).n).toBe(2)
    // Resumable bounded fan-out with a hint port that is uncertain (returns null): no blind duplicate injection.
    const calls: string[] = []
    processImpactOutbox(h.ctx, { limit: 1 }) // bounded scan: progress persisted in the cursor
    processImpactOutbox(h.ctx, { hints: { deliver: (n) => { calls.push(n.bindingId); return null } } })
    processImpactOutbox(h.ctx, { hints: { deliver: (n) => { calls.push(n.bindingId); return 'op-x' } } })
    processImpactOutbox(h.ctx, { hints: { deliver: (n) => { calls.push(n.bindingId); return 'op-y' } } })
    expect(calls.length).toBe(2) // one uncertain attempt, one accepted, none after acceptance
    expect((h.db.prepare(`SELECT hint_operation_id FROM contract_notices`).all() as any[])).toEqual([{ hint_operation_id: 'op-x' }])
  })

  it('a full per-binding backlog compacts to the newest notices instead of growing unbounded', () => {
    const h = makeHarness({ budgets: { maxPendingNoticesPerBinding: 2 } })
    acceptUnits(h, { a: 'R0' })
    admittedWorker(h, 't1')
    for (let i = 1; i <= 5; i += 1) { acceptUnits(h, { a: `R${i}` }); processImpactOutbox(h.ctx) }
    const pending = h.db.prepare(`SELECT head_generation FROM contract_notices WHERE state = 'pending' ORDER BY head_generation`).all() as any[]
    expect(pending.map(p => p.head_generation)).toEqual([5, 6])
    expect(getAuthority(h.ctx, h.ns)).not.toBeNull()
  })
})
