import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { workerPeerContextHandlers } from '../../src/commands/low-family/worker-peer-context'
import {
  __resetWorkerSessionBindsForTest,
  __resetWorkerTaskTokensForTest,
  mintWorkerSessionBind,
  mintWorkerTaskToken,
} from '../../src/mesh/worker-mcp-isolation'
import { __resetHandoffNotesForTest, storeHandoffNote } from '../../src/mesh/worker-handoff-notes'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store'
import { appendLedgerEntry } from '../../src/mesh/mesh-ledger'

beforeEach(() => {
  __resetWorkerTaskTokensForTest()
  __resetWorkerSessionBindsForTest()
  __resetHandoffNotesForTest()
})
afterEach(() => {
  __resetWorkerTaskTokensForTest()
  __resetWorkerSessionBindsForTest()
  __resetHandoffNotesForTest()
})

// mesh_queue rows share a process-wide SQLite store keyed by `id` alone (not
// scoped by mesh_id) — every task id used anywhere in this file must be
// globally unique, not just unique-per-mesh. Prefixing with the (already
// per-test) mesh id gives that cheaply.
let seq = 0
function uniqueMeshId(): string {
  seq += 1
  return `peer-ctx-mesh-${seq}`
}

function seedQueueEntry(meshId: string, taskId: string, missionId?: string): void {
  const now = new Date().toISOString()
  MeshRuntimeStore.getInstance().insertQueueEntry({
    id: taskId, meshId, message: 'do the thing', status: 'assigned', createdAt: now, updatedAt: now,
    ...(missionId ? { missionId } : {}),
  })
}

/** Bind + token for a worker "self", so the handler can resolve an identity. */
function bindWorker(meshId: string, taskId: string, sessionId: string): { bind: string } {
  seedQueueEntry(meshId, taskId)
  MeshRuntimeStore.getInstance().updateQueueEntry({
    ...MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId)!,
    assignedSessionId: sessionId,
  })
  const bind = mintWorkerSessionBind({ meshId, sessionId })
  mintWorkerTaskToken({ meshId, taskId, attemptId: `${taskId}-a1`, sessionId })
  return { bind: bind.bind }
}

describe('worker_peer_context_pull low-family handler', () => {
  it('refuses (unauthenticated) for an unresolvable bind/token', async () => {
    const result: any = await workerPeerContextHandlers.worker_peer_context_pull({} as any, { bind: 'wsb_forged' })
    expect(result).toMatchObject({ success: false, error: 'unauthenticated' })
  })

  it('returns no peers when the mesh has no sibling lifecycle entries', async () => {
    const meshId = uniqueMeshId()
    const selfTaskId = `${meshId}-self`
    const { bind } = bindWorker(meshId, selfTaskId, 'sess-self')
    const result: any = await workerPeerContextHandlers.worker_peer_context_pull({} as any, { bind })
    expect(result).toMatchObject({ success: true, meshId, scope: 'mesh', peers: [] })
  })

  it("surfaces a sibling's lifecycle status and NEVER its own task", async () => {
    const meshId = uniqueMeshId()
    const selfTaskId = `${meshId}-self`
    const siblingId = `${meshId}-sibling-1`
    const { bind } = bindWorker(meshId, selfTaskId, 'sess-self')

    appendLedgerEntry(meshId, { kind: 'task_dispatched', taskId: siblingId, nodeId: 'node-b', payload: { taskId: siblingId } })
    appendLedgerEntry(meshId, { kind: 'task_completed', taskId: siblingId, nodeId: 'node-b', payload: { taskId: siblingId, outcome: 'completed' } })
    // An event for the CALLER's own task must never come back as a "peer".
    appendLedgerEntry(meshId, { kind: 'task_dispatched', taskId: selfTaskId, nodeId: 'node-a', payload: { taskId: selfTaskId } })

    const result: any = await workerPeerContextHandlers.worker_peer_context_pull({} as any, { bind })
    expect(result.success).toBe(true)
    expect(result.peers).toHaveLength(1)
    expect(result.peers[0]).toMatchObject({ taskId: siblingId, nodeId: 'node-b', status: 'completed' })
  })

  it("includes a sibling's handoff note text (content) alongside the lifecycle facts (metadata)", async () => {
    const meshId = uniqueMeshId()
    const selfTaskId = `${meshId}-self`
    const siblingId = `${meshId}-sibling-1`
    const { bind } = bindWorker(meshId, selfTaskId, 'sess-self')

    appendLedgerEntry(meshId, { kind: 'task_completed', taskId: siblingId, nodeId: 'node-b', payload: { taskId: siblingId, outcome: 'completed' } })
    storeHandoffNote({
      meshId,
      taskId: siblingId,
      notes: { intent: 'made re-establish idempotent', touchedFiles: ['src/session-host.ts'], conflictGuidance: 'keep the narrowed key' },
      recordedAtIso: new Date().toISOString(),
    })

    const result: any = await workerPeerContextHandlers.worker_peer_context_pull({} as any, { bind })
    expect(result.peers[0].handoffNote).toMatchObject({
      intent: 'made re-establish idempotent',
      conflictGuidance: 'keep the narrowed key',
      touchedFiles: ['src/session-host.ts'],
    })
  })

  it("degrades gracefully when a sibling's note text was never received by THIS daemon", async () => {
    // ★ASYMMETRIC-MACHINE FIXTURE: the sibling's report_completion may have
    // landed on a DIFFERENT daemon. This daemon still has the lifecycle event
    // (via ledger reconciliation) but never received the note text, so the
    // peer entry must still appear — just without a handoffNote field —
    // rather than the whole pull failing or hiding the sibling entirely.
    const meshId = uniqueMeshId()
    const selfTaskId = `${meshId}-self`
    const remoteSiblingId = `${meshId}-sibling-remote`
    const { bind } = bindWorker(meshId, selfTaskId, 'sess-self')
    appendLedgerEntry(meshId, { kind: 'task_completed', taskId: remoteSiblingId, nodeId: 'node-remote', payload: { taskId: remoteSiblingId, outcome: 'completed' } })

    const result: any = await workerPeerContextHandlers.worker_peer_context_pull({} as any, { bind })
    expect(result.peers).toHaveLength(1)
    expect(result.peers[0].taskId).toBe(remoteSiblingId)
    expect(result.peers[0].handoffNote).toBeUndefined()
  })

  it('same_mission scope excludes siblings outside the caller\'s mission', async () => {
    const meshId = uniqueMeshId()
    const selfTaskId = `${meshId}-self`
    const inMissionId = `${meshId}-in-mission`
    const outOfMissionId = `${meshId}-out-of-mission`
    seedQueueEntry(meshId, selfTaskId, 'mission-a')
    MeshRuntimeStore.getInstance().updateQueueEntry({
      ...MeshRuntimeStore.getInstance().findQueueEntryById(meshId, selfTaskId)!,
      assignedSessionId: 'sess-self',
    })
    const bind = mintWorkerSessionBind({ meshId, sessionId: 'sess-self' })
    mintWorkerTaskToken({ meshId, taskId: selfTaskId, attemptId: 'a1', sessionId: 'sess-self' })

    seedQueueEntry(meshId, inMissionId, 'mission-a')
    seedQueueEntry(meshId, outOfMissionId, 'mission-b')
    appendLedgerEntry(meshId, { kind: 'task_completed', taskId: inMissionId, payload: { taskId: inMissionId, outcome: 'completed' } })
    appendLedgerEntry(meshId, { kind: 'task_completed', taskId: outOfMissionId, payload: { taskId: outOfMissionId, outcome: 'completed' } })

    const result: any = await workerPeerContextHandlers.worker_peer_context_pull({} as any, { bind: bind.bind, scope: 'same_mission' })
    expect(result.scope).toBe('same_mission')
    expect(result.peers.map((p: any) => p.taskId)).toEqual([inMissionId])
  })

  it('topic filter narrows to peers whose handoff note mentions the substring', async () => {
    const meshId = uniqueMeshId()
    const selfTaskId = `${meshId}-self`
    const authTaskId = `${meshId}-about-auth`
    const uiTaskId = `${meshId}-about-ui`
    const { bind } = bindWorker(meshId, selfTaskId, 'sess-self')

    appendLedgerEntry(meshId, { kind: 'task_completed', taskId: authTaskId, payload: { taskId: authTaskId, outcome: 'completed' } })
    storeHandoffNote({
      meshId, taskId: authTaskId,
      notes: { intent: 'refactored session-host auth', touchedFiles: ['src/auth.ts'] },
      recordedAtIso: new Date().toISOString(),
    })
    appendLedgerEntry(meshId, { kind: 'task_completed', taskId: uiTaskId, payload: { taskId: uiTaskId, outcome: 'completed' } })
    storeHandoffNote({
      meshId, taskId: uiTaskId,
      notes: { intent: 'reworked the settings panel layout', touchedFiles: ['src/ui/settings.tsx'] },
      recordedAtIso: new Date().toISOString(),
    })

    const result: any = await workerPeerContextHandlers.worker_peer_context_pull({} as any, { bind, topic: 'auth' })
    expect(result.peers.map((p: any) => p.taskId)).toEqual([authTaskId])
  })
})
