import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// COORD-NOTIFY-STUCK (mission af4a1ff8): a PINNED queue task whose dispatch fails, or
// whose stranded/no-turn dispatch is reclaimed by the watchdog, returns to 'pending'
// with its targetSessionId pin INTACT (both requeueTask's dispatchFailure branch and
// reclaimStrandedAssignedTask leave the pin untouched by design — see
// mesh-dispatch-failed-notify.ts). Until now neither path told the coordinator this
// happened, so a coordinator could re-target the exact dead session it just failed to
// reach, or wait unaware anything needed a decision while the slower liveness backstops
// (60s dead-target grace / 15min pin TTL) ran out the clock.

const testTmpDir = path.join(tmpdir(), `adhdev-dispatch-failed-notify-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' } as any),
}))

import {
  liveSessionsForNode,
  buildDispatchFailedPinnedNotice,
  notifyCoordinatorOfPinnedDispatchFailure,
  buildReclaimedPinnedNotice,
  notifyCoordinatorOfPinnedReclaim,
} from '../../src/mesh/mesh-dispatch-failed-notify.js'
import { drainPendingMeshCoordinatorEvents, __clearMeshPendingEventsForTests } from '../../src/mesh/mesh-events-pending.js'

const COORDINATOR_DAEMON_ID = 'test-machine'
const NODE_ID = 'node_main'

function liveSession(meshId: string, sessionId: string, status: string, nodeId: string = NODE_ID, providerType = 'codex-cli') {
  const state = {
    instanceId: sessionId,
    status,
    settings: { meshNodeFor: meshId, meshNodeId: nodeId, providerType },
  }
  return { category: 'cli', getState: () => state }
}

function createComponents(cliInstances: any[] = []) {
  return {
    instanceManager: {
      getByCategory: vi.fn((category: string) => (category === 'cli' ? cliInstances : [])),
      getInstance: vi.fn(() => undefined),
    },
  } as any
}

function cleanup(meshId: string) {
  __clearMeshPendingEventsForTests(meshId)
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('liveSessionsForNode', () => {
  it('lists only live, non-terminal sessions on the matching mesh+node', () => {
    const meshId = `mesh_${randomUUID().slice(0, 8)}`
    const components = createComponents([
      liveSession(meshId, 'sess-idle', 'idle', NODE_ID, 'codex-cli'),
      liveSession(meshId, 'sess-generating', 'generating', NODE_ID, 'claude-code'),
      liveSession(meshId, 'sess-dead', 'stopped', NODE_ID),
      liveSession(meshId, 'sess-other-node', 'idle', 'node_other'),
      liveSession('other-mesh', 'sess-other-mesh', 'idle', NODE_ID),
    ])

    const result = liveSessionsForNode(components, meshId, NODE_ID)

    expect(result.map(s => s.sessionId).sort()).toEqual(['sess-generating', 'sess-idle'].sort())
    expect(result.find(s => s.sessionId === 'sess-idle')?.providerType).toBe('codex-cli')
  })

  it('fails soft (empty list) when the instance lookup throws', () => {
    const components = { instanceManager: { getByCategory: () => { throw new Error('boom') } } } as any
    expect(liveSessionsForNode(components, 'mesh1', NODE_ID)).toEqual([])
  })
})

describe('buildDispatchFailedPinnedNotice / buildReclaimedPinnedNotice', () => {
  it('names the pinned session, the failure, and the exact requeue fix commands', () => {
    const msg = buildDispatchFailedPinnedNotice({
      taskId: 'task_abc',
      targetSessionId: 'dead-sess',
      nodeId: NODE_ID,
      error: 'ECONNREFUSED',
      liveSessions: [{ sessionId: 'other-sess', providerType: 'codex-cli' }],
    })
    expect(msg).toMatch(/dead-sess/)
    expect(msg).toMatch(/task_abc/)
    expect(msg).toMatch(/ECONNREFUSED/)
    expect(msg).toMatch(/other-sess/)
    expect(msg).toMatch(/mesh_queue_requeue/)
    expect(msg).toMatch(/clear_target_session=true/)
  })

  it('says so explicitly when no other live session exists on the node', () => {
    const msg = buildDispatchFailedPinnedNotice({
      taskId: 'task_abc', targetSessionId: 'dead-sess', nodeId: NODE_ID, liveSessions: [],
    })
    expect(msg).toMatch(/No other live session/)
  })

  it('reclaim notice states the silence duration and reclaim reason', () => {
    const msg = buildReclaimedPinnedNotice({
      taskId: 'task_xyz',
      targetSessionId: 'stranded-sess',
      nodeId: NODE_ID,
      reclaimReason: 'reclaim_after_unknown_grace',
      silentForMs: 17 * 60_000,
      liveSessions: [],
    })
    expect(msg).toMatch(/17min/)
    expect(msg).toMatch(/reclaim_after_unknown_grace/)
    expect(msg).toMatch(/stranded-sess/)
    expect(msg).toMatch(/mesh_queue_requeue/)
  })
})

describe('notifyCoordinatorOfPinnedDispatchFailure', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('no-ops for an UNPINNED task — the ordinary, self-resolving case must not page', () => {
    const meshId = `mesh_${randomUUID().slice(0, 8)}`
    try {
      const components = createComponents([])
      notifyCoordinatorOfPinnedDispatchFailure(components, {
        meshId, taskId: 't1', targetSessionId: '', nodeId: NODE_ID, error: 'boom',
      })
      const events = drainPendingMeshCoordinatorEvents(meshId, COORDINATOR_DAEMON_ID) as any[]
      expect(events || []).toHaveLength(0)
    } finally { cleanup(meshId) }
  })

  it('★ pages the coordinator with the live-session list on a pinned dispatch failure — silence here is the whole defect', () => {
    const meshId = `mesh_${randomUUID().slice(0, 8)}`
    try {
      const components = createComponents([liveSession(meshId, 'sibling-sess', 'idle', NODE_ID, 'claude-code')])
      notifyCoordinatorOfPinnedDispatchFailure(components, {
        meshId, taskId: 'task_1', targetSessionId: 'dead-sess', nodeId: NODE_ID, error: 'ECONNREFUSED',
      })

      const events = drainPendingMeshCoordinatorEvents(meshId, COORDINATOR_DAEMON_ID) as any[]
      const hit = (events || []).find(e => e?.metadataEvent?.taskId === 'task_1')
      expect(hit, 'the pinned dispatch failure must page the coordinator').toBeTruthy()
      expect(hit.event).toBe('mesh:dispatch_blocked')
      expect(hit.metadataEvent.reason).toBe('pinned_session_dispatch_failed')
      expect(hit.metadataEvent.targetSessionId).toBe('dead-sess')
      expect(hit.metadataEvent.liveSessionIds).toContain('sibling-sess')
      expect(String(hit.coordinatorMessage)).toMatch(/dead-sess/)
    } finally { cleanup(meshId) }
  })

  it('collapses REPEATED failures for the same task+reason (the reconcile loop must not spam)', () => {
    const meshId = `mesh_${randomUUID().slice(0, 8)}`
    try {
      const components = createComponents([])
      notifyCoordinatorOfPinnedDispatchFailure(components, { meshId, taskId: 'task_1', targetSessionId: 'dead-sess', nodeId: NODE_ID, error: 'e1' })
      notifyCoordinatorOfPinnedDispatchFailure(components, { meshId, taskId: 'task_1', targetSessionId: 'dead-sess', nodeId: NODE_ID, error: 'e1' })
      notifyCoordinatorOfPinnedDispatchFailure(components, { meshId, taskId: 'task_1', targetSessionId: 'dead-sess', nodeId: NODE_ID, error: 'e1' })

      const events = drainPendingMeshCoordinatorEvents(meshId, COORDINATOR_DAEMON_ID) as any[]
      expect((events || []).filter(e => e?.metadataEvent?.taskId === 'task_1' && e?.metadataEvent?.reason === 'pinned_session_dispatch_failed')).toHaveLength(1)
    } finally { cleanup(meshId) }
  })

  it('does NOT collapse a dispatch-failure alert with a subsequent RECLAIM alert for the same task — different reasons are different things to tell the coordinator', () => {
    const meshId = `mesh_${randomUUID().slice(0, 8)}`
    try {
      const components = createComponents([])
      notifyCoordinatorOfPinnedDispatchFailure(components, { meshId, taskId: 'task_1', targetSessionId: 'dead-sess', nodeId: NODE_ID, error: 'e1' })
      notifyCoordinatorOfPinnedReclaim(components, { meshId, taskId: 'task_1', targetSessionId: 'dead-sess', nodeId: NODE_ID, reclaimReason: 'reclaim_after_unknown_grace', silentForMs: 17 * 60_000 })

      const events = drainPendingMeshCoordinatorEvents(meshId, COORDINATOR_DAEMON_ID) as any[]
      const reasons = (events || []).filter(e => e?.metadataEvent?.taskId === 'task_1').map(e => e?.metadataEvent?.reason)
      expect(reasons).toContain('pinned_session_dispatch_failed')
      expect(reasons).toContain('pinned_session_reclaimed_stranded')
    } finally { cleanup(meshId) }
  })

  it('routes unicast to the originating coordinator session when known', () => {
    const meshId = `mesh_${randomUUID().slice(0, 8)}`
    try {
      const components = createComponents([])
      notifyCoordinatorOfPinnedDispatchFailure(components, {
        meshId, taskId: 'task_1', targetSessionId: 'dead-sess', nodeId: NODE_ID, error: 'e1',
        sourceCoordinatorSessionId: 'coord-sess-1',
      })
      const events = drainPendingMeshCoordinatorEvents(meshId, COORDINATOR_DAEMON_ID) as any[]
      const hit = (events || []).find(e => e?.metadataEvent?.taskId === 'task_1')
      expect(hit?.targetCoordinatorSessionId).toBe('coord-sess-1')
    } finally { cleanup(meshId) }
  })
})

describe('notifyCoordinatorOfPinnedReclaim', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('no-ops for an UNPINNED reclaimed task', () => {
    const meshId = `mesh_${randomUUID().slice(0, 8)}`
    try {
      const components = createComponents([])
      notifyCoordinatorOfPinnedReclaim(components, {
        meshId, taskId: 't1', targetSessionId: '', nodeId: NODE_ID, reclaimReason: 'reclaim_after_unknown_grace', silentForMs: 900_000,
      })
      const events = drainPendingMeshCoordinatorEvents(meshId, COORDINATOR_DAEMON_ID) as any[]
      expect(events || []).toHaveLength(0)
    } finally { cleanup(meshId) }
  })

  it('★ pages the coordinator when a pinned task is reclaimed after the stranded-dispatch watchdog fires', () => {
    const meshId = `mesh_${randomUUID().slice(0, 8)}`
    try {
      const components = createComponents([])
      notifyCoordinatorOfPinnedReclaim(components, {
        meshId, taskId: 'task_2', targetSessionId: 'stranded-sess', nodeId: NODE_ID,
        reclaimReason: 'reclaim_after_unknown_grace', silentForMs: 17 * 60_000,
      })
      const events = drainPendingMeshCoordinatorEvents(meshId, COORDINATOR_DAEMON_ID) as any[]
      const hit = (events || []).find(e => e?.metadataEvent?.taskId === 'task_2')
      expect(hit, 'the reclaim must page the coordinator — this is the ~17min silent gap').toBeTruthy()
      expect(hit.metadataEvent.reason).toBe('pinned_session_reclaimed_stranded')
      expect(hit.metadataEvent.targetSessionId).toBe('stranded-sess')
    } finally { cleanup(meshId) }
  })
})
