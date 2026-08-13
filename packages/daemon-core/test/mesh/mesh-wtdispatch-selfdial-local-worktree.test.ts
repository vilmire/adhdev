import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// WTDISPATCH-SELFDIAL. A mesh node that is a LOCAL WORKTREE inherits the coordinator's
// own daemonId from the node it was cloned from (mesh-crud addNode copies
// `daemonId: sourceNode.daemonId`). So readMeshNodeDaemonId() on such a node returns
// THIS daemon's id and the remote-dispatch block is entered.
//
// The only thing that used to keep the task local from there was a raw
// `cliManager.adapters.has(sessionId)` probe. That Map lookup is false for any session
// whose id is not byte-identical to a live adapter key on this daemon — a co-located
// worktree sibling observed solely through the remote-idle store, an ACP worker whose
// instanceId is minted independently of its adapter key, or a prefixed id form. When it
// read false, the dispatch was routed `transport: 'remote'` and dialed P2P to the
// coordinator's OWN daemon id, which daemon-mesh-manager's isSelfDial correctly refuses
// ("Refusing to send mesh command … to this daemon's own id"). The dispatch then failed
// deterministically, and because the ledger booked it retryable, the reconcile loop
// re-claimed and re-failed it (the observed dispatchNonce climb to 5).
//
// Locality is a DAEMON-IDENTITY question. These tests pin that tryAssignQueueTask routes
// a local-worktree node LOCALLY even when its session is absent from cliManager.adapters,
// and that a genuinely REMOTE node still forwards over P2P.

const testTmpDir = path.join(tmpdir(), `adhdev-mesh-selfdial-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

const LOCAL_MACHINE_ID = 'mach_4462a75330c548be9c2e74dd9f7f6ffb'
// The SAME machine under the cloud `daemon_` id form — what a cloned worktree node
// actually carries, and the exact form seen in the live ledger.
const LOCAL_DAEMON_ID = `daemon_${LOCAL_MACHINE_ID}`
const REMOTE_DAEMON_ID = 'daemon_mach_99999999999999999999999999999999'

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: LOCAL_MACHINE_ID } as any),
}))

const meshConfigMocks = vi.hoisted(() => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
  listMeshes: vi.fn(() => [] as any[]),
}))
vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}))

import { tryAssignQueueTask } from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js'

const WT_NODE = 'node_9c27101b6db449e78342007e3b114627'
const WS_WT = '/repo/wt-mobile'

/**
 * The claiming session lives ONLY in instanceManager — cliManager.adapters is
 * intentionally EMPTY, which is precisely the condition that made the old
 * adapter-presence probe misjudge a local node as remote.
 */
function createComponents(meshId: string, sessions: Array<{ sessionId: string; workspace: string; meshNodeId?: string }>) {
  const instances = sessions.map((s) => {
    const settings: Record<string, unknown> = { meshNodeFor: meshId, providerType: 'claude-cli' }
    if (s.meshNodeId !== undefined) settings.meshNodeId = s.meshNodeId
    return {
      getState: () => ({ settings, status: 'idle', instanceId: s.sessionId, type: 'claude-cli', workspace: s.workspace }),
      updateSettings: vi.fn(),
    }
  })
  return {
    instanceManager: {
      getInstance: vi.fn((sid: string) => instances.find((i) => i.getState().instanceId === sid)),
      getByCategory: vi.fn((category: string) => (category === 'cli' ? instances : [])),
    },
    cliManager: {
      adapters: new Map<string, { workingDir: string }>(), // intentionally EMPTY
      handleCliCommand: vi.fn(async () => ({ success: true })),
    },
    // Present and functional — so choosing 'remote' is a real possibility, not
    // something the absence of a transport masks.
    dispatchMeshCommand: vi.fn(async () => ({ success: true })),
    getMeshPeerConnectionStatus: vi.fn(() => ({ state: 'connected' })),
    providerLoader: {
      resolveAlias: vi.fn((t: string) => t),
      isMachineProviderEnabled: vi.fn(() => true),
      getMeta: vi.fn(() => undefined),
    },
    statusInstanceId: 'daemon-local',
    onStatusChange: vi.fn(),
  } as any
}

function setMesh(meshId: string, nodes: any[]) {
  meshConfigMocks.getMesh.mockReturnValue({ id: meshId, name: 'SELFDIAL Mesh', policy: {}, nodes })
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('WTDISPATCH-SELFDIAL — local worktree node must not be dispatched as remote', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('routes a local-worktree node LOCALLY even though its session is absent from cliManager.adapters', () => {
    const meshId = `mesh_selfdial_${randomUUID().slice(0, 8)}`
    try {
      // The worktree node carries the coordinator's OWN daemonId (inherited from its clone
      // source) — the live shape from ledger 8a1236ba.
      setMesh(meshId, [{
        id: WT_NODE,
        workspace: WS_WT,
        repoRoot: WS_WT,
        policy: {},
        isLocalWorktree: true,
        daemonId: LOCAL_DAEMON_ID,
      }])
      const components = createComponents(meshId, [{ sessionId: 'sess-wt', workspace: WS_WT, meshNodeId: WT_NODE }])
      const task = enqueueTask(meshId, 'MARKER-SELFDIAL', { targetNodeId: WT_NODE, taskMode: 'code_change',
    difficulty: 'medium',
})

      expect(tryAssignQueueTask(components, meshId, WT_NODE, 'sess-wt', 'claude-cli')).toBe(true)

      // THE ASSERTION: never dial P2P to ourselves. Before the fix this was called with
      // LOCAL_DAEMON_ID and the transport rejected it as a self-dial.
      expect(components.dispatchMeshCommand).not.toHaveBeenCalled()
      expect(components.cliManager.handleCliCommand).toHaveBeenCalledTimes(1)

      const [command, payload] = components.cliManager.handleCliCommand.mock.calls[0]
      expect(command).toBe('agent_command')
      expect(payload).toMatchObject({ targetSessionId: 'sess-wt', action: 'send_chat' })

      expect(getQueue(meshId).find((t) => t.id === task.id)?.status).toBe('assigned')
    } finally {
      cleanup(meshId)
    }
  })

  it('still forwards a genuinely REMOTE node over P2P (the fix must not localize everything)', () => {
    const meshId = `mesh_selfdial_remote_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [{
        id: WT_NODE,
        workspace: WS_WT,
        repoRoot: WS_WT,
        policy: {},
        daemonId: REMOTE_DAEMON_ID, // a DIFFERENT machine
      }])
      const components = createComponents(meshId, [{ sessionId: 'sess-remote', workspace: WS_WT, meshNodeId: WT_NODE }])
      enqueueTask(meshId, 'MARKER-REMOTE', { targetNodeId: WT_NODE, taskMode: 'code_change',
    difficulty: 'medium',
})

      expect(tryAssignQueueTask(components, meshId, WT_NODE, 'sess-remote', 'claude-cli')).toBe(true)

      expect(components.dispatchMeshCommand).toHaveBeenCalledTimes(1)
      expect(components.dispatchMeshCommand.mock.calls[0][0]).toBe(REMOTE_DAEMON_ID)
      expect(components.cliManager.handleCliCommand).not.toHaveBeenCalled()
    } finally {
      cleanup(meshId)
    }
  })

  it('treats a bare-form machine id on the node as the same local machine (canon-identity)', () => {
    const meshId = `mesh_selfdial_bare_${randomUUID().slice(0, 8)}`
    try {
      // Same machine, BARE `mach_` form rather than `daemon_mach_`. A raw string compare
      // would call this remote; the canon-aware predicate must not.
      setMesh(meshId, [{
        id: WT_NODE,
        workspace: WS_WT,
        repoRoot: WS_WT,
        policy: {},
        isLocalWorktree: true,
        daemonId: LOCAL_MACHINE_ID,
      }])
      const components = createComponents(meshId, [{ sessionId: 'sess-bare', workspace: WS_WT, meshNodeId: WT_NODE }])
      enqueueTask(meshId, 'MARKER-BARE', { targetNodeId: WT_NODE, taskMode: 'code_change',
    difficulty: 'medium',
})

      expect(tryAssignQueueTask(components, meshId, WT_NODE, 'sess-bare', 'claude-cli')).toBe(true)
      expect(components.dispatchMeshCommand).not.toHaveBeenCalled()
      expect(components.cliManager.handleCliCommand).toHaveBeenCalledTimes(1)
    } finally {
      cleanup(meshId)
    }
  })
})
