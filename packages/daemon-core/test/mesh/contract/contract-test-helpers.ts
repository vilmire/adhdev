/**
 * Shared fixtures for the contract-versioning (Cut A) acceptance tests.
 * In-memory SQLite, a deterministic clock/RNG, and a fake source reader that
 * models immutable committed blobs (the real git reader has its own suite:
 * contract-git-source.test.ts).
 */
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { createContractCtx, MemoryContractAuthorityFence } from '../../../src/mesh/contract/contract-store'
import type { ContractCtx, OwnerPrincipal, CoordinatorPrincipal } from '../../../src/mesh/contract/contract-context'
import { issueOwnerPrincipal } from '../../../src/mesh/contract/contract-context'
import type { ContractRepoBindingRecord, ContractSourceReader, ContractSourceRequest } from '../../../src/mesh/contract/contract-git-source'
import { ContractRefusal, type ContractBudgets, type ContractSourceEntry } from '../../../src/mesh/contract/contract-types'
import { enrollNamespace, mintCoordinatorGrant, currentHeadVector, verifyCoordinatorCapability } from '../../../src/mesh/contract/contract-authority'
import { acceptProposal, proposeRevision, reviewProposal } from '../../../src/mesh/contract/contract-proposals'

export class FakeSourceReader implements ContractSourceReader {
  /** repoPath → commit → path → bytes */
  readonly repos = new Map<string, Map<string, Map<string, Buffer>>>()
  commit(repoPath: string, files: Record<string, string | Buffer>): string {
    const oid = createHash('sha1').update(`${repoPath}:${JSON.stringify(Object.keys(files))}:${Math.random()}`).digest('hex')
    const commits = this.repos.get(repoPath) ?? new Map()
    commits.set(oid, new Map(Object.entries(files).map(([p, b]) => [p, Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8')])))
    this.repos.set(repoPath, commits)
    return oid
  }
  describeRepository(repoPath: string) {
    if (!repoPath.startsWith('/')) throw new ContractRefusal('invalid_source')
    return { commonDir: `${repoPath}/.git`, hashAlgorithm: 'sha1' as const }
  }
  resolveBlob(bindings: ReadonlyMap<string, ContractRepoBindingRecord>, req: ContractSourceRequest, maxBytes: number) {
    const b = bindings.get(req.repoBindingId)
    if (!b) throw new ContractRefusal('invalid_source')
    const bytes = this.repos.get(b.repoPath)?.get(req.commitOid)?.get(req.path)
    if (!bytes) throw new ContractRefusal('source_unavailable')
    if (bytes.length > maxBytes) throw new ContractRefusal('budget_exceeded')
    const entry: ContractSourceEntry = {
      repoBindingId: b.repoBindingId, hashAlgorithm: 'sha1', commitOid: req.commitOid, gitlinks: [], path: req.path,
      blobOid: createHash('sha1').update(`blob ${bytes.length}\u0000`).update(bytes).digest('hex'), mode: '100644',
      byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    }
    return { entry, bytes }
  }
  observeWorkspace(binding: ContractRepoBindingRecord, paths: readonly string[], nowMs: number) {
    return { observedAtMs: nowMs, repoBindingId: binding.repoBindingId, headOid: null, entries: paths.map(p => ({ path: p, status: 'clean', worktreeSha256: null })) }
  }
}

export interface Harness {
  ctx: ContractCtx
  db: Database.Database
  clock: { now: number }
  reader: FakeSourceReader
  fence: MemoryContractAuthorityFence
  owner: OwnerPrincipal
  ns: string
  repoId: string
  meshId: string
}

let seq = 0
export function makeHarness(opts: { budgets?: Partial<ContractBudgets>; daemonId?: string; db?: Database.Database; fence?: MemoryContractAuthorityFence } = {}): Harness {
  const db = opts.db ?? new Database(':memory:')
  const clock = { now: 1_800_000_000_000 }
  let counter = 0
  const seed = `${seq}:${Math.random()}`
  const reader = new FakeSourceReader()
  const fence = opts.fence ?? new MemoryContractAuthorityFence()
  const ctx = createContractCtx({
    db,
    localDaemonId: opts.daemonId ?? 'daemon-A',
    fence,
    budgets: opts.budgets ?? null,
    sourceReader: reader,
    rt: {
      nowMs: () => clock.now,
      randomBytes: (n: number) => {
        counter += 1
        return Buffer.from(createHash('sha512').update(`rng:${seed}:${counter}`).digest().subarray(0, n))
      },
    },
  })
  seq += 1
  const owner = issueOwnerPrincipal('internal_test')
  const meshId = `mesh_${seq}`
  const enrolled = enrollNamespace(ctx, owner, { meshId, repositories: [{ repoBindingId: 'root', repoPath: '/repo/root' }] })
  return { ctx, db, clock, reader, fence, owner, ns: enrolled.namespaceId, repoId: 'root', meshId }
}

export function grant(h: Harness, sessionId: string, ops: Array<'propose' | 'review' | 'accept' | 'assign' | 'assess' | 'revoke'>, extra: { maxImpact?: 'breaking' | 'nonbreaking' } = {}): { capability: string; principal: (op: any) => CoordinatorPrincipal; grantId: string } {
  const g = mintCoordinatorGrant(h.ctx, h.owner, { namespaceId: h.ns, coordinatorSessionId: sessionId, ops, ...(extra.maxImpact ? { maxImpact: extra.maxImpact } : {}) })
  return {
    capability: g.capability,
    grantId: g.grantId,
    principal: (op) => verifyCoordinatorCapability(h.ctx, g.capability, { namespaceId: h.ns, sessionId, op }),
  }
}

/** Propose + independent review + owner accept of a set of units committed in the fake root repo. */
export function acceptUnits(h: Harness, units: Record<string, string>, opts: { impact?: 'breaking' | 'nonbreaking'; key?: string } = {}) {
  const commit = h.reader.commit('/repo/root', Object.fromEntries(Object.entries(units).map(([id, text]) => [`contracts/${id}.md`, text])))
  const author = grant(h, `coord-author-${seq}-${Math.random()}`, ['propose'])
  const reviewer = grant(h, `coord-review-${seq}-${Math.random()}`, ['review'])
  const base = currentHeadVector(h.ctx, h.ns)!
  const prop = proposeRevision(h.ctx, author.principal('propose'), {
    namespaceId: h.ns,
    baseHead: base,
    impact: opts.impact ?? 'nonbreaking',
    units: Object.keys(units).map(id => ({ unitId: id, source: { repoBindingId: h.repoId, commitOid: commit, path: `contracts/${id}.md` } })),
  })
  reviewProposal(h.ctx, reviewer.principal('review'), { proposalId: prop.proposalId, proposalVersion: prop.proposalVersion, candidateRevisionId: prop.candidateRevisionId, verdict: 'approve' })
  const acc = acceptProposal(h.ctx, h.owner, { proposalId: prop.proposalId, proposalVersion: prop.proposalVersion, expectedHead: base, idempotencyKey: opts.key ?? `key-${Math.random().toString(36).slice(2, 12)}` })
  return { prop, acc, commit }
}

export function refusalCode(fn: () => unknown): string | null {
  try { fn(); return null } catch (e) { return e instanceof ContractRefusal ? e.code : `THREW:${(e as Error).message}` }
}
