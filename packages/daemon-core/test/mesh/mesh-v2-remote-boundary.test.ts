import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// Isolate all file I/O (pending-events JSONL + MeshRuntimeStore SQLite) to a per-run
// temp dir so the suite never touches the production ~/.adhdev/mesh-ledger.
const testTmpDir = path.join(tmpdir(), `adhdev-mesh-v2-boundary-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')
vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' }),
}))

import {
  serializeV2EnvelopeToWire,
  readV2EnvelopeFromWire,
  stampPendingEventV2,
  queuePendingMeshCoordinatorEvent,
  getPendingMeshCoordinatorEvents,
  type PendingMeshCoordinatorEvent,
} from '../../src/mesh/mesh-events-pending.js'
import { MESH_PROTOCOL_VERSION_V2, type CoordinatorIdentity } from '../../src/mesh/contracts.js'
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js'
import { getLedgerDir } from '../../src/mesh/mesh-ledger.js'

const DISPATCHED_BY: CoordinatorIdentity = {
  daemonId: 'daemon_mach_coordinator',
  coordinatorRunId: 'run-1234',
  sessionId: 'coord-session-abc',
}

// A fully v2-stamped pending event as it exists in a REMOTE worker's queue: the top-level
// envelope fields are what T4 must carry across the P2P relay boundary intact.
function makeStampedRemoteEvent(meshId: string): PendingMeshCoordinatorEvent {
  const base: PendingMeshCoordinatorEvent = {
    event: 'agent:generating_completed',
    meshId,
    nodeLabel: "Node 'node_worker'",
    nodeId: 'node_worker',
    workspace: '/repo/worktree-worker',
    metadataEvent: { taskId: 'task_42', finalSummary: 'done' },
    coordinatorMessage: 'Worker completed task_42',
    queuedAt: 1_700_000_000_000,
    targetCoordinatorDaemonId: DISPATCHED_BY.daemonId,
    targetCoordinatorSessionId: DISPATCHED_BY.sessionId,
  }
  // Stamp exactly as the emit path does (unicast: intendedFor defaults to dispatchedBy).
  return stampPendingEventV2(base, { dispatchedBy: DISPATCHED_BY, scope: 'unicast' })
}

// Mirror what buildForwardPayloadFromPending (reconcile-loop) / buildMeshForwardPayloadFrom
// PendingEvent (mcp) produce for the wire: v2 envelope spread first, then the flat fields.
function flattenToWire(event: PendingMeshCoordinatorEvent): Record<string, unknown> {
  return {
    ...serializeV2EnvelopeToWire(event),
    event: event.event,
    meshId: event.meshId,
    nodeId: event.nodeId,
    workspace: event.workspace,
    // metadata is spread flat on the real wire; irrelevant to the envelope assertions.
    taskId: (event.metadataEvent as any).taskId,
  }
}

function cleanup(meshId: string) {
  __resetMeshRuntimeStoreForTests()
  const pendingPath = path.join(getLedgerDir(), `${meshId}.pending-events.jsonl`)
  if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath)
}

describe('v2 envelope: remote (P2P) boundary preservation (T4/B3b)', () => {
  it('serialize → wire → deserialize preserves all 5 v2 fields verbatim', () => {
    const meshId = 'mesh_remote_1'
    const event = makeStampedRemoteEvent(meshId)
    // Sanity: emit produced a full v2 envelope.
    expect(event.protocolVersion).toBe(MESH_PROTOCOL_VERSION_V2)
    expect(event.eventId).toBeTruthy()
    expect(event.scope).toBe('unicast')

    const wire = flattenToWire(event)
    // JSON round-trip to prove the payload survives real P2P serialization.
    const overWire = JSON.parse(JSON.stringify(wire)) as Record<string, unknown>
    const restored = readV2EnvelopeFromWire(overWire)

    expect(restored.protocolVersion).toBe(MESH_PROTOCOL_VERSION_V2)
    expect(restored.eventId).toBe(event.eventId) // ★ eventId immutable across the boundary
    expect(restored.scope).toBe('unicast')
    expect(restored.dispatchedBy).toEqual(DISPATCHED_BY)
    expect(restored.intendedFor).toEqual(DISPATCHED_BY) // unicast default = dispatchedBy
  })

  it('re-queue on the receiving daemon keeps the ORIGINAL eventId (idempotency)', () => {
    const meshId = 'mesh_remote_reque'
    cleanup(meshId)
    try {
      const remote = makeStampedRemoteEvent(meshId)
      const originalEventId = remote.eventId!

      // The receiving daemon rebuilds a pending event from the wire payload and re-queues it,
      // spreading the restored envelope last (as handleMeshForwardEvent does).
      const restored = readV2EnvelopeFromWire(flattenToWire(remote))
      const rebuilt: PendingMeshCoordinatorEvent = {
        event: remote.event,
        meshId,
        nodeLabel: remote.nodeLabel,
        nodeId: remote.nodeId,
        workspace: remote.workspace,
        metadataEvent: { ...remote.metadataEvent },
        coordinatorMessage: remote.coordinatorMessage,
        queuedAt: 1_700_000_999_000, // a NEW queuedAt on re-queue — must not affect eventId
        targetCoordinatorDaemonId: remote.targetCoordinatorDaemonId,
        targetCoordinatorSessionId: remote.targetCoordinatorSessionId,
        ...restored,
      }

      expect(queuePendingMeshCoordinatorEvent(rebuilt)).toBe(true)

      const queued = getPendingMeshCoordinatorEvents(meshId)
      expect(queued).toHaveLength(1)
      const persisted = queued[0]
      // ★ The eventId minted once on the remote must be preserved — NOT re-generated.
      expect(persisted.eventId).toBe(originalEventId)
      expect(persisted.protocolVersion).toBe(MESH_PROTOCOL_VERSION_V2)
      expect(persisted.scope).toBe('unicast')
      expect(persisted.dispatchedBy).toEqual(DISPATCHED_BY)
      expect(persisted.intendedFor).toEqual(DISPATCHED_BY)
    } finally {
      cleanup(meshId)
    }
  })

  it('stampPendingEventV2 short-circuits (no fresh UUID) for a restored v2 event', () => {
    const remote = makeStampedRemoteEvent('mesh_remote_stamp')
    const restored = readV2EnvelopeFromWire(flattenToWire(remote))
    // A re-queue passes the restored envelope; the emit stamper must return it unchanged.
    const restamped = stampPendingEventV2({
      event: remote.event,
      meshId: remote.meshId,
      nodeLabel: remote.nodeLabel,
      metadataEvent: {},
      queuedAt: 1,
      ...restored,
    })
    expect(restamped.eventId).toBe(remote.eventId)
  })

  it('v1 event (no envelope) stays v1-safe: serialize empty, restore empty', () => {
    const v1: PendingMeshCoordinatorEvent = {
      event: 'agent:generating_completed',
      meshId: 'mesh_v1',
      nodeLabel: "Node 'n'",
      metadataEvent: {},
      queuedAt: 1,
    }
    expect(serializeV2EnvelopeToWire(v1)).toEqual({})
    expect(readV2EnvelopeFromWire({ event: 'x', meshId: 'mesh_v1' })).toEqual({})
  })

  it('drops a malformed envelope on the wire (partial CoordinatorIdentity) rather than corrupting the re-queue', () => {
    // dispatchedBy present but missing coordinatorRunId → not a valid identity → skipped.
    const restored = readV2EnvelopeFromWire({
      protocolVersion: MESH_PROTOCOL_VERSION_V2,
      eventId: 'evt-9',
      scope: 'unicast',
      dispatchedBy: { daemonId: 'daemon_mach_x' }, // malformed: no coordinatorRunId
      intendedFor: 'not-an-object',
    })
    expect(restored.protocolVersion).toBe(MESH_PROTOCOL_VERSION_V2)
    expect(restored.eventId).toBe('evt-9')
    expect(restored.scope).toBe('unicast')
    expect(restored.dispatchedBy).toBeUndefined()
    expect(restored.intendedFor).toBeUndefined()
  })
})

afterEach(() => {
  vi.clearAllMocks()
})
