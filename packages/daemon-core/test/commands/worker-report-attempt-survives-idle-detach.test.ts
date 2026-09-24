/**
 * Live rc.41 run 6 finding (item 3): a worker's forwarded-report log line said
 * `attempt ?` even though the session's own stamp trace showed
 * `stamped mesh assignment … attempt=mesh_direct:…`. `assignmentStampReader`
 * (commands/low-family/worker-report.ts) reads `settings.meshActiveAttemptId`
 * off the LIVE instance at the moment the report is resolved — so if anything
 * between the stamp and the report clears that field, the reader legitimately
 * returns no attempt.
 *
 * The wave-15 WORKER-BIND-IDLE-DETACH fix (cli-provider-events.ts `pushEvent`)
 * is exactly the guard against that: a session with a LIVE worker-MCP bind
 * must not let its OWN `generating_completed`/`agent:stopped` call
 * `detachMeshAssignment()`, because `detachMeshAssignment` unconditionally
 * strips `meshActiveAttemptId` (cli-provider-mesh-assignment.ts, both the
 * coordinator-launched and ad-hoc branches). This test proves the two halves
 * actually compose: stamp → fire the session's own idle edge while the bind
 * is live → the SAME reader `worker_resolve_task` uses still answers with the
 * attempt id. It also proves the negative (break-once): with no live bind,
 * the pre-existing unconditional detach fires and the attempt is gone —
 * reproducing the exact `attempt ?` symptom.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { pushEvent, type ProviderEventsHost } from '../../src/providers/cli-provider-events.js'
import { workerReportHandlers } from '../../src/commands/low-family/worker-report.js'
import {
  __resetWorkerSessionBindsForTest,
  mintWorkerSessionBind,
} from '../../src/runtime-defaults.js'

const WORKER_DAEMON = 'daemon_mach_worker_attempt_survives'

function freshIds(tag: string) {
  return {
    meshId: `mesh_${tag}`,
    taskId: `task_${tag}`,
    sessionId: `session_${tag}`,
    nodeId: `node_${tag}`,
  }
}

/** The stamp `attachMeshAssignment` writes on receipt of a dispatch. */
function stampedSettings(ids: ReturnType<typeof freshIds>, attemptId: string) {
  return {
    meshNodeFor: ids.meshId,
    meshNodeId: ids.nodeId,
    meshActiveTaskId: ids.taskId,
    meshActiveAttemptId: attemptId,
    meshActiveAttemptGeneration: 0,
    meshCoordinatorDaemonId: 'owner-daemon',
    launchedByCoordinator: true,
  }
}

function host(ids: ReturnType<typeof freshIds>, settings: Record<string, any>): ProviderEventsHost & { detachCalls: number } {
  const state: any = {
    instanceId: ids.sessionId,
    type: 'claude-code',
    workingDir: '/work/repo',
    provider: { controls: {} } as any,
    providerSessionId: undefined,
    settings,
    context: null,
    lifecyclePort: { emit: () => {} } as any,
    adapter: {},
    appliedEffectKeys: new Set<string>(),
    controlValues: {},
    summaryMetadata: undefined,
    suppressIdleHistoryReplay: false,
    runtimeMessages: [],
    lastPersistedHistoryMessages: [],
    generatingStartedAt: 0,
    completedDebouncePending: null,
    generatingDebouncePending: null,
    detachCalls: 0,
    isMeshWorkerSession: () => true,
    completingTurnTaskId: () => ids.taskId,
    detachMeshAssignment() {
      // Mirror the real cli-provider-mesh-assignment.ts detachMeshAssignment
      // closely enough to matter: it unconditionally strips the attempt
      // markers alongside the task marker.
      state.detachCalls++
      const { meshActiveTaskId, meshActiveDispatchNonce, meshActiveAttemptId, meshActiveAttemptGeneration, ...rest } = state.settings
      void meshActiveTaskId; void meshActiveDispatchNonce; void meshActiveAttemptId; void meshActiveAttemptGeneration
      state.settings = rest
    },
    promoteProviderSessionId: () => {},
    appendRuntimeMessage: () => {},
    pushEvent(event: any) { pushEvent(state, event) },
  }
  return state
}

function resolveCtx(sessionId: string, getSettings: () => Record<string, any>): any {
  return {
    deps: {
      statusInstanceId: WORKER_DAEMON,
      instanceManager: {
        getInstance: (id: string) => (id === sessionId ? { getState: () => ({ settings: getSettings() }) } : undefined),
      },
    },
  }
}

describe('worker-report attempt id survives the worker\'s own idle edge (wave 15 composition)', () => {
  afterEach(() => __resetWorkerSessionBindsForTest())

  it('BEFORE the report lands: a LIVE bind withholds detach, so the reader still returns the stamped attempt', async () => {
    const ids = freshIds('live_bind')
    const attemptId = `mesh_direct:${ids.taskId}`
    const h = host(ids, stampedSettings(ids, attemptId))
    // meshCoordinatorDaemonId ('owner-daemon') differs from this daemon
    // (WORKER_DAEMON), so local bind-exchange (no matching queue row on this
    // daemon either way) falls through to resolveRemoteWorker →
    // assignmentStampReader — the exact path worker-report-remote-forward's
    // "answers for a remote-owned task too" case exercises.
    const { bind } = mintWorkerSessionBind({ meshId: ids.meshId, sessionId: ids.sessionId })

    // The worker's own false-idle edge (e.g. an FSM misread mid tool-call, or
    // a genuine end of turn before report_completion has been called yet).
    h.pushEvent({ event: 'agent:generating_completed', timestamp: Date.now() } as any)

    expect(h.detachCalls).toBe(0)
    expect(h.settings.meshActiveTaskId).toBe(ids.taskId)
    expect(h.settings.meshActiveAttemptId).toBe(attemptId)

    // The SAME reader worker_resolve_task uses (assignmentStampReader) must
    // now answer with the attempt id instead of `attempt ?`.
    const res: any = await workerReportHandlers.worker_resolve_task(
      resolveCtx(ids.sessionId, () => h.settings),
      { bind },
    )
    expect(res).toMatchObject({ success: true, meshId: ids.meshId, taskId: ids.taskId, attemptId })
  })

  it('break-once: WITHOUT a live bind, the same idle edge strips the attempt and reproduces `attempt ?`', async () => {
    const ids = freshIds('no_bind')
    const attemptId = `mesh_direct:${ids.taskId}`
    const h = host(ids, stampedSettings(ids, attemptId))
    // No mintWorkerSessionBind — this is the pre-wave-15 shape (or a provider
    // that never got a worker MCP bind).

    h.pushEvent({ event: 'agent:generating_completed', timestamp: Date.now() } as any)

    expect(h.detachCalls).toBe(1)
    expect(h.settings.meshActiveAttemptId).toBeUndefined()

    const res: any = await workerReportHandlers.worker_resolve_task(
      resolveCtx(ids.sessionId, () => h.settings),
      {},
    )
    // No stamp survives → unauthenticated, no attemptId at all (the exact
    // "attempt ?" shape on the forwarded-report log line).
    expect(res.success).toBe(false)
    expect(res.attemptId).toBeUndefined()
  })
})
