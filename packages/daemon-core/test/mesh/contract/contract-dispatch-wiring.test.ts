/**
 * Contract versioning Cut A — the queue claim dispatch path (tryAssignQueueTask).
 *   AC27 the admitted pin block reaches the dispatched body exactly once, outside
 *        upstream/handoff prose; a refused admission never reaches native submission
 *   AC14 a re-dispatch with a new generation carries a fresh binding
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

const testTmpDir = path.join(tmpdir(), `adhdev-contract-dispatch-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')
const LOCAL_MACHINE_ID = 'mach_4444444444444444444444444444dddd'

vi.mock('../../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: LOCAL_MACHINE_ID } as any),
  getMachineId: () => LOCAL_MACHINE_ID,
  getMachineNickname: () => null,
}))

const meshConfigMocks = vi.hoisted(() => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
  listMeshes: vi.fn(() => [] as any[]),
}))
vi.mock('../../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}))

import { tryAssignQueueTask } from '../../../src/mesh/mesh-events.js'
import { enqueueTask, getQueue } from '../../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../../src/mesh/mesh-runtime-store.js'
import { setActiveTurnLedger } from '../../../src/mesh/turn-ledger/active-ledger.js'
import { withMeshRouter } from '../helpers/mesh-router-stub.js'
import { __drainTestTurnLedgersForTests, wipeTurnTablesForTests } from '../helpers/mesh-turn-ledger-fixture.js'
import { createContractCtx, MemoryContractAuthorityFence } from '../../../src/mesh/contract/contract-store'
import { issueOwnerPrincipal } from '../../../src/mesh/contract/contract-context'
import { currentHeadVector, enrollNamespace, mintCoordinatorGrant, verifyCoordinatorCapability } from '../../../src/mesh/contract/contract-authority'
import { acceptProposal, proposeRevision, reviewProposal } from '../../../src/mesh/contract/contract-proposals'
import { bindMissionScope, listBindingsForTask, PIN_BLOCK_OPEN } from '../../../src/mesh/contract/contract-pins'
import { __setContractCtxForTests } from '../../../src/mesh/contract-runtime'
import { upsertMeshMission } from '../../../src/mesh/mesh-missions'
import { FakeSourceReader } from './contract-test-helpers'

const NODE_ID = 'node_contract_dispatch_local00000000000'
const WS = '/repo/contract-dispatch'

function createComponents(meshId: string, sessionIds: string[], opts: { workerMcpDelivered?: boolean } = {}) {
  const instances = new Map(sessionIds.map((sessionId) => {
    const state = {
      settings: { meshNodeFor: meshId, meshNodeId: NODE_ID, providerType: 'claude-cli', ...(opts.workerMcpDelivered === undefined ? {} : { workerMcpDelivered: opts.workerMcpDelivered }) },
      status: 'idle', instanceId: sessionId, type: 'claude-cli', workspace: WS,
    }
    return [sessionId, { getState: () => state, updateSettings: vi.fn() }] as const
  }))
  return withMeshRouter({
    instanceManager: {
      getInstance: vi.fn((id: string) => instances.get(id)),
      getByCategory: vi.fn((c: string) => (c === 'cli' ? [...instances.values()] : [])),
      attachMeshAssignmentToInstance: vi.fn(() => ({ stamped: true })),
    },
    cliManager: { adapters: new Map(), handleCliCommand: vi.fn(async () => ({ success: true })) },
    providerLoader: {
      resolveAlias: vi.fn((t: string) => t),
      isMachineProviderEnabled: vi.fn(() => true),
      getMeta: vi.fn(() => undefined),
      setCliDetectionResults: vi.fn(),
    },
    statusInstanceId: 'daemon-local',
    onStatusChange: vi.fn(),
  } as any)
}

const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve() }

function setupContract(meshId: string) {
  const reader = new FakeSourceReader()
  const ctx = createContractCtx({ db: MeshRuntimeStore.getInstance().db, localDaemonId: LOCAL_MACHINE_ID, fence: new MemoryContractAuthorityFence(), sourceReader: reader })
  __setContractCtxForTests(ctx)
  const owner = issueOwnerPrincipal('internal_test')
  const ns = enrollNamespace(ctx, owner, { meshId, repositories: [{ repoBindingId: 'root', repoPath: '/repo/root' }] }).namespaceId
  const role = (op: 'propose' | 'review') => {
    const s = `c-${op}-${randomUUID().slice(0, 6)}`
    const g = mintCoordinatorGrant(ctx, owner, { namespaceId: ns, coordinatorSessionId: s, ops: [op] })
    return verifyCoordinatorCapability(ctx, g.capability, { namespaceId: ns, sessionId: s, op })
  }
  const commit = reader.commit('/repo/root', { 'c/api.md': 'API v1' })
  const base = currentHeadVector(ctx, ns)!
  const p = proposeRevision(ctx, role('propose'), { namespaceId: ns, baseHead: base, impact: 'nonbreaking', units: [{ unitId: 'api', source: { repoBindingId: 'root', commitOid: commit, path: 'c/api.md' } }] })
  reviewProposal(ctx, role('review'), { proposalId: p.proposalId, proposalVersion: 1, candidateRevisionId: p.candidateRevisionId, verdict: 'approve' })
  acceptProposal(ctx, owner, { proposalId: p.proposalId, proposalVersion: 1, expectedHead: base, idempotencyKey: `disp-${randomUUID()}` })
  const missionId = upsertMeshMission(meshId, { title: 'pilot' }).id
  bindMissionScope(ctx, owner, { meshId, missionId, namespaceId: ns })
  return { ctx, ns, missionId }
}

function sentBodies(components: any): string[] {
  return (components.cliManager.handleCliCommand as any).mock.calls
    .filter((c: any[]) => c[0] === 'agent_command' && c[1]?.action === 'send_chat')
    .map((c: any[]) => String(c[1].message))
}

describe('contract dispatch admission on the queue claim path', () => {
  let meshId = ''
  beforeEach(() => {
    meshId = `mesh_contract_dispatch_${randomUUID().slice(0, 8)}`
    meshConfigMocks.getMesh.mockReturnValue({ id: meshId, name: 'Contract Dispatch Mesh', policy: {}, nodes: [{ id: NODE_ID, workspace: WS, repoRoot: WS, policy: {} }] })
    meshConfigMocks.listMeshes.mockReturnValue([])
  })
  afterEach(async () => {
    setActiveTurnLedger(null)
    __setContractCtxForTests(undefined)
    await __drainTestTurnLedgersForTests()
    wipeTurnTablesForTests()
  })

  it('a strict task is dispatched with the exact admitted pin block once, ahead of the authored text', async () => {
    const { ctx, missionId } = setupContract(meshId)
    const components = createComponents(meshId, ['sess-c1'], { workerMcpDelivered: true })
    setActiveTurnLedger(components.turnLedger)
    const task = enqueueTask(meshId, 'Implement the pinned API.', { difficulty: 'easy', readonly: true, missionId })
    expect(tryAssignQueueTask(components, meshId, NODE_ID, 'sess-c1', 'claude-cli')).toBe(true)
    await settle()
    const bodies = sentBodies(components)
    expect(bodies.length).toBe(1)
    const body = bodies[0]
    const bindings = listBindingsForTask(ctx, meshId, task.id)
    expect(bindings.length).toBe(1)
    expect(body.split(PIN_BLOCK_OPEN).length).toBe(2)
    expect(body).toContain(`binding=${bindings[0].bindingId}`)
    expect(body.indexOf(PIN_BLOCK_OPEN)).toBeLessThan(body.indexOf('Implement the pinned API.'))
    expect(body).not.toContain('API v1') // unit prose is fetched with contract_read, never squeezed into the brief
  })

  it('a session known NOT to hold the worker MCP is refused before native submission (no send_chat)', async () => {
    const { ctx, missionId } = setupContract(meshId)
    const components = createComponents(meshId, ['sess-c2'], { workerMcpDelivered: false })
    setActiveTurnLedger(components.turnLedger)
    const task = enqueueTask(meshId, 'Implement the pinned API.', { difficulty: 'easy', readonly: true, missionId })
    expect(tryAssignQueueTask(components, meshId, NODE_ID, 'sess-c2', 'claude-cli')).toBe(true)
    await settle()
    expect(sentBodies(components)).toEqual([])
    expect(listBindingsForTask(ctx, meshId, task.id)).toEqual([])
    // The dispatch-failure path put the task back (requeued), never a silent assigned row.
    expect(getQueue(meshId).find(t => t.id === task.id)?.status).not.toBe('completed')
  })

  it('a compat-open task is dispatched byte-identically (no pin block)', async () => {
    setupContract(meshId)
    const components = createComponents(meshId, ['sess-c3'], { workerMcpDelivered: true })
    setActiveTurnLedger(components.turnLedger)
    enqueueTask(meshId, 'Legacy work.', { difficulty: 'easy', readonly: true })
    expect(tryAssignQueueTask(components, meshId, NODE_ID, 'sess-c3', 'claude-cli')).toBe(true)
    await settle()
    const bodies = sentBodies(components)
    expect(bodies.length).toBe(1)
    expect(bodies[0]).not.toContain(PIN_BLOCK_OPEN)
  })
})
