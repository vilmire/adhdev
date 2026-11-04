import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import {
  __resetWorkerSessionBindsForTest, __resetWorkerTaskTokensForTest, mintWorkerSessionBind, mintWorkerTaskToken,
} from '../../src/mesh/worker-mcp-isolation.js'
import { fenceWorkerReportOnLedger, resolveWorkerIdentity } from '../../src/mesh/worker-report.js'
import { seedMeshAttempt } from '../helpers/turn-attempt-seed.js'

// A managed (stage) task re-queues the same session for a self-check / review revision. The
// ledger opens attempt N+1 on that session, but the worker's MCP process still presents the
// credential minted for attempt N and was refused `stale_attempt` until rebound by hand.
// The follow is scoped: stage task + same session + open current attempt. Everything else
// keeps the strict stale verdict (see artifact-commands-and-transport F3).

const MESH = 'mesh_stage_follow'
function insertTask(id: string, stage: boolean, session = 'worker') {
  const now = new Date().toISOString()
  MeshRuntimeStore.getInstance().insertQueueEntry({
    id, meshId: MESH, message: 'm', status: 'assigned', assignedSessionId: session, createdAt: now, updatedAt: now,
    ...(stage ? { stageState: { phase: 'self_checking', round: 0, reviewTaskIds: [], artifacts: { diff: [], selfCheck: [], verdict: [] } } } : {}),
  } as any)
}

describe('worker credential follows a stage revision attempt on the same session', () => {
  beforeEach(() => { __resetWorkerTaskTokensForTest(); __resetWorkerSessionBindsForTest() })
  afterEach(() => { __resetMeshRuntimeStoreForTests() })

  it('stage task: held token and bind both resolve to the current attempt', () => {
    insertTask('t-stage', true, 'w-stage')
    seedMeshAttempt({ meshId: MESH, taskId: 't-stage', sessionId: 'w-stage', attemptId: 'a0', attemptNo: 0, stage: 'completed' })
    const oldToken = mintWorkerTaskToken({ meshId: MESH, taskId: 't-stage', sessionId: 'w-stage', attemptId: 'a0' })
    const bind = mintWorkerSessionBind({ meshId: MESH, sessionId: 'w-stage' })
    seedMeshAttempt({ meshId: MESH, taskId: 't-stage', sessionId: 'w-stage', attemptId: 'a1', attemptNo: 1, stage: 'generating' })

    const store = MeshRuntimeStore.getInstance()
    const viaToken = resolveWorkerIdentity(store, undefined, oldToken.token)
    expect(viaToken?.attemptId).toBe('a1')
    const viaBind = resolveWorkerIdentity(store, bind.bind, undefined)
    expect(viaBind?.attemptId).toBe('a1')
    expect(fenceWorkerReportOnLedger(store, { meshId: MESH, taskId: 't-stage', attemptId: viaToken!.attemptId, sessionId: 'w-stage' }, 'completed')).toBe('ok')
    // Repeatable: a second call reuses the minted token for the current attempt.
    expect(resolveWorkerIdentity(store, undefined, oldToken.token)?.token).toBe(viaToken!.token)
  })

  it('non-stage task keeps the strict stale verdict', () => {
    insertTask('t-plain', false, 'w-plain')
    seedMeshAttempt({ meshId: MESH, taskId: 't-plain', sessionId: 'w-plain', attemptId: 'p0', attemptNo: 0, stage: 'failed' })
    const oldToken = mintWorkerTaskToken({ meshId: MESH, taskId: 't-plain', sessionId: 'w-plain', attemptId: 'p0' })
    seedMeshAttempt({ meshId: MESH, taskId: 't-plain', sessionId: 'w-plain', attemptId: 'p1', attemptNo: 1, stage: 'generating' })
    expect(resolveWorkerIdentity(MeshRuntimeStore.getInstance(), undefined, oldToken.token)?.attemptId).toBe('p0')
  })

  it('stage task: a current attempt on a different session is not followed', () => {
    insertTask('t-other', true, 'w-other')
    seedMeshAttempt({ meshId: MESH, taskId: 't-other', sessionId: 'w-other', attemptId: 'o0', attemptNo: 0, stage: 'completed' })
    const oldToken = mintWorkerTaskToken({ meshId: MESH, taskId: 't-other', sessionId: 'w-other', attemptId: 'o0' })
    seedMeshAttempt({ meshId: MESH, taskId: 't-other', sessionId: 'someone-else', attemptId: 'o1', attemptNo: 1, stage: 'generating' })
    expect(resolveWorkerIdentity(MeshRuntimeStore.getInstance(), undefined, oldToken.token)?.attemptId).toBe('o0')
  })

  it('stage task: a terminal current attempt is not followed', () => {
    insertTask('t-term', true, 'w-term')
    seedMeshAttempt({ meshId: MESH, taskId: 't-term', sessionId: 'w-term', attemptId: 'x0', attemptNo: 0, stage: 'completed' })
    const oldToken = mintWorkerTaskToken({ meshId: MESH, taskId: 't-term', sessionId: 'w-term', attemptId: 'x0' })
    seedMeshAttempt({ meshId: MESH, taskId: 't-term', sessionId: 'w-term', attemptId: 'x1', attemptNo: 1, stage: 'failed' })
    expect(resolveWorkerIdentity(MeshRuntimeStore.getInstance(), undefined, oldToken.token)?.attemptId).toBe('x0')
  })
})
