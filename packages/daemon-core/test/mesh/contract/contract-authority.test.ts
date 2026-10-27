/**
 * Contract versioning Cut A — authority acceptance scenarios.
 *   AC01 reject self-asserted coordinator authority
 *   AC02 scope, rotation and revocation of coordinator grants
 *   AC03 authenticated owner, restart rotation, stale backup, fenced transfer
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { acceptUnits, grant, makeHarness, refusalCode } from './contract-test-helpers'
import {
  beginContractProcessIncarnation, currentHeadVector, enrollNamespace, mintCoordinatorGrant, recoverAuthority,
  revokeGrant, revokeGrantsForSession, transferAuthority, verifyCoordinatorCapability, getAuthority,
} from '../../../src/mesh/contract/contract-authority'
import { acceptProposal, proposeRevision, reviewProposal } from '../../../src/mesh/contract/contract-proposals'
import { MemoryContractAuthorityFence } from '../../../src/mesh/contract/contract-store'

function headSnapshot(h: ReturnType<typeof makeHarness>) {
  return JSON.stringify(currentHeadVector(h.ctx, h.ns))
}

describe('AC01 — self-asserted coordinator authority is refused', () => {
  it('forged principals (env session id, source=ipc label, synthesized host, plain owner object) write nothing', () => {
    const h = makeHarness()
    const before = headSnapshot(h)
    const forged: unknown[] = [
      { kind: 'owner', principalId: 'owner:ipc' },
      { kind: 'coordinator', principalId: 'coordinator:x', grantId: 'g', namespaceId: h.ns, sessionId: process.env.ADHDEV_COORDINATOR_SESSION_ID ?? 'coord-1', ops: ['accept'], maxImpact: 'breaking' },
      { kind: 'owner', principalId: 'owner:standalone', source: 'ipc', hostSynthesized: true },
    ]
    for (const p of forged) {
      expect(refusalCode(() => enrollNamespace(h.ctx, p as any, { meshId: 'm', repositories: [{ repoPath: '/repo/x' }] }))).toBe('unauthenticated')
      expect(refusalCode(() => mintCoordinatorGrant(h.ctx, p as any, { namespaceId: h.ns, coordinatorSessionId: 's', ops: ['accept'] }))).toBe('unauthenticated')
      expect(refusalCode(() => acceptProposal(h.ctx, p as any, { proposalId: 'x', proposalVersion: 1, expectedHead: currentHeadVector(h.ctx, h.ns)!, idempotencyKey: 'key-forged-1' }))).toMatch(/unauthenticated|proposal_not_found/)
      expect(refusalCode(() => recoverAuthority(h.ctx, p as any, h.ns))).toBe('unauthenticated')
    }
    // A raw capability-shaped string that the daemon never minted.
    expect(refusalCode(() => verifyCoordinatorCapability(h.ctx, 'csb_notMintedByThisDaemon0000000000', { namespaceId: h.ns, sessionId: 'coord-1', op: 'accept' }))).toBe('capability_invalid')
    expect(refusalCode(() => verifyCoordinatorCapability(h.ctx, process.env.ADHDEV_COORDINATOR_SESSION_ID ?? 'coord-1', { namespaceId: h.ns, sessionId: 'coord-1', op: 'accept' }))).toBe('capability_invalid')
    expect(headSnapshot(h)).toBe(before)
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM contract_authorities').get() as any).n).toBe(1)
  })

  it('positive control: owner enrolls; a daemon-minted scoped grant performs exactly its delegated op', () => {
    const h = makeHarness()
    const r = acceptUnits(h, { api: 'v1 contract' })
    expect(r.acc.vector.headGeneration).toBe(1)
    const g = grant(h, 'coord-ipc', ['review'])
    expect(g.capability.startsWith('csb_')).toBe(true)
    expect(refusalCode(() => g.principal('review'))).toBeNull()
    expect(refusalCode(() => g.principal('accept'))).toBe('not_authorized')
    // Only the verifier is stored, never the secret.
    const rows = h.db.prepare('SELECT * FROM contract_grants').all() as any[]
    expect(JSON.stringify(rows)).not.toContain(g.capability)
  })
})

describe('AC02 — scope, rotation and revocation', () => {
  it('refuses another namespace, session instance, daemon and op; rotation G→G+1 refuses replay of G', () => {
    const h = makeHarness()
    const other = makeHarness({ db: h.db, fence: h.fence })
    const g1 = mintCoordinatorGrant(h.ctx, h.owner, { namespaceId: h.ns, coordinatorSessionId: 'S', ops: ['accept'] })
    expect(refusalCode(() => verifyCoordinatorCapability(h.ctx, g1.capability, { namespaceId: other.ns, sessionId: 'S', op: 'accept' }))).toBe('scope_mismatch')
    expect(refusalCode(() => verifyCoordinatorCapability(h.ctx, g1.capability, { namespaceId: h.ns, sessionId: 'S2', op: 'accept' }))).toBe('scope_mismatch')
    expect(refusalCode(() => verifyCoordinatorCapability(h.ctx, g1.capability, { namespaceId: h.ns, sessionId: 'S', op: 'revoke' }))).toBe('not_authorized')
    const foreignDaemon = { ...h.ctx, localDaemonId: 'daemon-B' }
    expect(refusalCode(() => verifyCoordinatorCapability(foreignDaemon, g1.capability, { namespaceId: h.ns, sessionId: 'S', op: 'accept' }))).toBe('not_authorized')
    expect(refusalCode(() => verifyCoordinatorCapability(h.ctx, g1.capability, { namespaceId: h.ns, sessionId: 'S', op: 'accept' }))).toBeNull()

    const g2 = mintCoordinatorGrant(h.ctx, h.owner, { namespaceId: h.ns, coordinatorSessionId: 'S', ops: ['accept'] })
    expect(g2.grantGeneration).toBe(g1.grantGeneration + 1)
    expect(refusalCode(() => verifyCoordinatorCapability(h.ctx, g1.capability, { namespaceId: h.ns, sessionId: 'S', op: 'accept' }))).toBe('capability_revoked')
    expect(refusalCode(() => verifyCoordinatorCapability(h.ctx, g2.capability, { namespaceId: h.ns, sessionId: 'S', op: 'accept' }))).toBeNull()
  })

  it('a deferred acceptance rechecks revocation before its commit; the current grant succeeds exactly once', () => {
    const h = makeHarness()
    const commit = h.reader.commit('/repo/root', { 'c/a.md': 'A' })
    const author = grant(h, 'author', ['propose'])
    const reviewer = grant(h, 'reviewer', ['review'])
    const acceptor = grant(h, 'acceptor', ['accept'])
    const base = currentHeadVector(h.ctx, h.ns)!
    const prop = proposeRevision(h.ctx, author.principal('propose'), { namespaceId: h.ns, baseHead: base, impact: 'nonbreaking', units: [{ unitId: 'a', source: { repoBindingId: 'root', commitOid: commit, path: 'c/a.md' } }] })
    reviewProposal(h.ctx, reviewer.principal('review'), { proposalId: prop.proposalId, proposalVersion: 1, candidateRevisionId: prop.candidateRevisionId, verdict: 'approve' })
    const principal = acceptor.principal('accept') // verified now…
    revokeGrant(h.ctx, h.owner, acceptor.grantId) // …revoked before the deferred mutation commits
    expect(refusalCode(() => acceptProposal(h.ctx, principal, { proposalId: prop.proposalId, proposalVersion: 1, expectedHead: base, idempotencyKey: 'deferred-key-1' }))).toBe('capability_revoked')
    expect(currentHeadVector(h.ctx, h.ns)!.headGeneration).toBe(0)
    const fresh = grant(h, 'acceptor', ['accept'])
    const ok = acceptProposal(h.ctx, fresh.principal('accept'), { proposalId: prop.proposalId, proposalVersion: 1, expectedHead: base, idempotencyKey: 'deferred-key-2' })
    expect(ok.vector.headGeneration).toBe(1)
    expect(refusalCode(() => acceptProposal(h.ctx, fresh.principal('accept'), { proposalId: prop.proposalId, proposalVersion: 1, expectedHead: base, idempotencyKey: 'deferred-key-3' }))).toBe('proposal_not_open')
  })

  it('explicit bounded overlap is distinguishable from revocation; default security rotation has zero overlap', () => {
    const h = makeHarness()
    h.db.prepare(`UPDATE contract_authorities SET policy_json = json_set(policy_json, '$.rotationOverlapMs', 60000)`).run()
    const g1 = mintCoordinatorGrant(h.ctx, h.owner, { namespaceId: h.ns, coordinatorSessionId: 'S', ops: ['assess'] })
    mintCoordinatorGrant(h.ctx, h.owner, { namespaceId: h.ns, coordinatorSessionId: 'S', ops: ['assess'], overlapPrevious: true })
    expect(refusalCode(() => verifyCoordinatorCapability(h.ctx, g1.capability, { namespaceId: h.ns, sessionId: 'S', op: 'assess' }))).toBeNull()
    h.clock.now += 61_000
    expect(refusalCode(() => verifyCoordinatorCapability(h.ctx, g1.capability, { namespaceId: h.ns, sessionId: 'S', op: 'assess' }))).toBe('capability_revoked')
    // Explicit revoke (security) ends the overlap immediately.
    const g3 = mintCoordinatorGrant(h.ctx, h.owner, { namespaceId: h.ns, coordinatorSessionId: 'T', ops: ['assess'] })
    mintCoordinatorGrant(h.ctx, h.owner, { namespaceId: h.ns, coordinatorSessionId: 'T', ops: ['assess'], overlapPrevious: true })
    revokeGrant(h.ctx, h.owner, g3.grantId, 'compromised')
    expect(refusalCode(() => verifyCoordinatorCapability(h.ctx, g3.capability, { namespaceId: h.ns, sessionId: 'T', op: 'assess' }))).toBe('capability_revoked')
    // Session end revokes every grant bound to that coordinator instance.
    const g4 = mintCoordinatorGrant(h.ctx, h.owner, { namespaceId: h.ns, coordinatorSessionId: 'U', ops: ['assess'] })
    expect(revokeGrantsForSession(h.ctx, 'U')).toBe(1)
    expect(refusalCode(() => verifyCoordinatorCapability(h.ctx, g4.capability, { namespaceId: h.ns, sessionId: 'U', op: 'assess' }))).toBe('capability_revoked')
  })

  it('an expired grant is refused', () => {
    const h = makeHarness()
    const g = mintCoordinatorGrant(h.ctx, h.owner, { namespaceId: h.ns, coordinatorSessionId: 'S', ops: ['assess'], ttlMs: 1000 })
    h.clock.now += 1001
    expect(refusalCode(() => verifyCoordinatorCapability(h.ctx, g.capability, { namespaceId: h.ns, sessionId: 'S', op: 'assess' }))).toBe('capability_expired')
  })
})

describe('AC03 — authenticated owner and authority recovery', () => {
  it('restart preserves history and rotates delegations; process restart alone does not forge a new tenure', () => {
    const h = makeHarness()
    acceptUnits(h, { a: 'one' })
    const g = mintCoordinatorGrant(h.ctx, h.owner, { namespaceId: h.ns, coordinatorSessionId: 'S', ops: ['assess'] })
    const epochBefore = getAuthority(h.ctx, h.ns)!.authorityEpoch
    beginContractProcessIncarnation(h.ctx)
    expect(getAuthority(h.ctx, h.ns)!.authorityEpoch).toBe(epochBefore)
    expect(currentHeadVector(h.ctx, h.ns)!.headGeneration).toBe(1)
    expect(refusalCode(() => verifyCoordinatorCapability(h.ctx, g.capability, { namespaceId: h.ns, sessionId: 'S', op: 'assess' }))).toBe('capability_revoked')
    const g2 = mintCoordinatorGrant(h.ctx, h.owner, { namespaceId: h.ns, coordinatorSessionId: 'S', ops: ['assess'] })
    expect(refusalCode(() => verifyCoordinatorCapability(h.ctx, g2.capability, { namespaceId: h.ns, sessionId: 'S', op: 'assess' }))).toBeNull()
  })

  it('a grant from an older process incarnation is refused even if its row was never marked revoked', () => {
    const h = makeHarness()
    const g = mintCoordinatorGrant(h.ctx, h.owner, { namespaceId: h.ns, coordinatorSessionId: 'S', ops: ['assess'] })
    h.db.prepare('UPDATE contract_authorities SET process_incarnation = process_incarnation + 1').run()
    expect(refusalCode(() => verifyCoordinatorCapability(h.ctx, g.capability, { namespaceId: h.ns, sessionId: 'S', op: 'assess' }))).toBe('capability_revoked')
  })

  it('a restored stale backup cannot accept; owner recovery to a new epoch rejects prior grants', () => {
    const h = makeHarness()
    acceptUnits(h, { a: 'one' })
    const backup = h.db.serialize()
    // Later tenure: transfer to self with fencing advances the epoch (fence file records it).
    transferAuthority(h.ctx, h.owner, { namespaceId: h.ns, newDaemonId: 'daemon-A', oldWriterFenced: true })
    const fencedEpoch = getAuthority(h.ctx, h.ns)!.authorityEpoch
    const g = mintCoordinatorGrant(h.ctx, h.owner, { namespaceId: h.ns, coordinatorSessionId: 'S', ops: ['assess'] })
    // Restore the stale DB (epoch behind the fence) on the same machine.
    const restored = new Database(backup)
    const stale = { ...h.ctx, db: restored }
    expect(beginContractProcessIncarnation(stale).requiresRecovery).toBe(1)
    expect(refusalCode(() => acceptUnits({ ...h, ctx: stale, db: restored }, { a: 'two' }))).toBe('authority_requires_recovery')
    const v = recoverAuthority(stale, h.owner, h.ns)
    expect(v.authorityEpoch).toBe(fencedEpoch + 1)
    expect(refusalCode(() => verifyCoordinatorCapability(h.ctx, g.capability, { namespaceId: h.ns, sessionId: 'S', op: 'assess' }))).toBeNull() // live DB untouched
    expect(refusalCode(() => verifyCoordinatorCapability(stale, g.capability, { namespaceId: h.ns, sessionId: 'S', op: 'assess' }))).toBe('capability_invalid')
  })

  it('transfer during partition pauses strict acceptance; a fenced transfer advances the epoch exactly once', () => {
    const h = makeHarness()
    acceptUnits(h, { a: 'one' })
    const e0 = getAuthority(h.ctx, h.ns)!.authorityEpoch
    transferAuthority(h.ctx, h.owner, { namespaceId: h.ns, newDaemonId: 'daemon-B', oldWriterFenced: false })
    expect(getAuthority(h.ctx, h.ns)!.status).toBe('paused_transfer')
    expect(getAuthority(h.ctx, h.ns)!.authorityEpoch).toBe(e0)
    expect(refusalCode(() => acceptUnits(h, { a: 'two' }))).toBe('authority_paused')
    transferAuthority(h.ctx, h.owner, { namespaceId: h.ns, newDaemonId: 'daemon-B', oldWriterFenced: true })
    const after = getAuthority(h.ctx, h.ns)!
    expect(after.authorityEpoch).toBe(e0 + 1)
    expect(after.status).toBe('transferred_away')
    // The old daemon is no longer a writer.
    expect(refusalCode(() => mintCoordinatorGrant(h.ctx, h.owner, { namespaceId: h.ns, coordinatorSessionId: 'S', ops: ['assess'] }))).toBe('not_authorized')
    // The new daemon (sharing the store in this test) accepts under the new epoch.
    const b = { ...h, ctx: { ...h.ctx, localDaemonId: 'daemon-B' } }
    h.db.prepare(`UPDATE contract_authorities SET status = 'active'`).run()
    expect(acceptUnits(b, { a: 'three' }).acc.vector.authorityEpoch).toBe(e0 + 1)
  })

  it('fence evidence written on enrollment lives outside the DB', () => {
    const fence = new MemoryContractAuthorityFence()
    const h = makeHarness({ fence })
    expect(fence.read(h.ns)).toBe(1)
  })
})
