import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// hasRecentIntentionalCleanupStop (mesh-event-forwarding.ts) is the ledger-fallback half of
// shouldSuppressIntentionalCleanupStop: when an agent:stopped event's OWN metadata does not
// carry the intentional/operator_cleanup markers (e.g. a legacy/thin worker payload), it falls
// back to scanning the ledger for a recent session_stopped/task_failed/task_stalled entry that
// DOES carry those markers (written by mesh_cleanup_sessions / mesh_remove_node) for the same
// session or node, within a 30-minute window. Before the fix this scanned a bare
// `readLedgerEntries(meshId, { tail: 200 })`; a bare tail window can be crowded out by
// unrelated mesh traffic within the 30-minute window, silently missing a genuine
// intentional-cleanup-stop and letting a spurious agent:stopped/monitor:no_progress reach the
// coordinator for a session that was deliberately torn down moments earlier.

const testTmpDir = path.join(tmpdir(), `adhdev-cleanup-stop-crowding-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ machineId: 'test-machine' } as any)),
}))
vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: configMocks.loadConfig,
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

import {
  __resetMeshWorkspaceCacheForTests,
  handleMeshForwardEvent,
} from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js'
import { getLedgerDir, appendLedgerEntry } from '../../src/mesh/mesh-ledger.js'

const NODE_ID = 'node_cleanup_1'
const SESSION_ID = 'cleanup-session-1'
const WORKSPACE = '/repo/worker'

function cleanupMeshFiles(meshId: string) {
  const queuePath = path.join(getLedgerDir(), `${meshId}.queue.json`)
  const ledgerPath = path.join(getLedgerDir(), `${meshId}.jsonl`)
  const pendingPath = path.join(getLedgerDir(), `${meshId}.pending-events.jsonl`)
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  __resetMeshWorkspaceCacheForTests()
  meshConfigMocks.getMesh.mockReset()
  meshConfigMocks.listMeshes.mockReset()
  meshConfigMocks.listMeshes.mockReturnValue([])
  if (fs.existsSync(queuePath)) fs.unlinkSync(queuePath)
  if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath)
  if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath)
}

function mockMesh(meshId: string) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    nodes: [{ id: NODE_ID, workspace: WORKSPACE }],
    policy: {},
  })
  meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
}

function makeRemoteComponents() {
  return {
    instanceManager: {
      getInstance: vi.fn(() => undefined),
      getByCategory: vi.fn(() => []),
      onEvent: vi.fn(),
    },
  } as any
}

describe('intentional-cleanup-stop ledger fallback — LEDGER-KIND-TAIL-BLINDSPOT', () => {
  it('★still suppresses agent:stopped when the operator_cleanup ledger entry is buried beyond the 200-entry tail window', () => {
    const meshId = `mesh_cleanup_stop_buried_${Date.now()}`
    try {
      mockMesh(meshId)
      appendLedgerEntry(meshId, {
        kind: 'session_stopped',
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        payload: {
          intentional: true,
          reason: 'operator_cleanup',
          source: 'mesh_cleanup_sessions',
        },
      })
      for (let i = 0; i < 260; i++) {
        appendLedgerEntry(meshId, {
          kind: 'session_launched',
          nodeId: 'node-other',
          payload: { source: 'unrelated_traffic', seq: i },
        })
      }

      const components = makeRemoteComponents()
      const result = handleMeshForwardEvent(components, {
        event: 'agent:stopped',
        meshId,
        nodeId: NODE_ID,
        targetSessionId: SESSION_ID,
        providerType: 'codex-cli',
        timestamp: Date.now(),
      })

      expect((result as any).suppressed).toBe(true)
      expect((result as any).intentionalCleanupStop).toBe(true)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('does NOT suppress agent:stopped for an unrelated session with no cleanup-stop evidence', () => {
    const meshId = `mesh_cleanup_stop_unrelated_${Date.now()}`
    try {
      mockMesh(meshId)
      appendLedgerEntry(meshId, {
        kind: 'session_stopped',
        nodeId: 'node-different',
        sessionId: 'session-different',
        payload: {
          intentional: true,
          reason: 'operator_cleanup',
          source: 'mesh_cleanup_sessions',
        },
      })

      const components = makeRemoteComponents()
      const result = handleMeshForwardEvent(components, {
        event: 'agent:stopped',
        meshId,
        nodeId: NODE_ID,
        targetSessionId: SESSION_ID,
        providerType: 'codex-cli',
        timestamp: Date.now(),
      })

      expect((result as any).intentionalCleanupStop).not.toBe(true)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })
})
