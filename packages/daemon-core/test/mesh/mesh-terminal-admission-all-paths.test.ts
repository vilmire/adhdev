import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// ---------------------------------------------------------------------------
// TERMINAL-ADMISSION-ALL-PATHS — regression suite for the three paths that
// reached a terminal decision WITHOUT consulting evaluateTerminalAdmission.
//
// THE MEASUREMENT THIS SUITE PINS
// -------------------------------
// The admission gate landed guarding the transcript POLL. Live logs then showed
// it had never once run: 49/49 polls declined UPSTREAM of the gate
// (poll_terminal_evidence_timestamp_unusable), 0 completions produced. Every
// real false completion came from a path the gate did not cover.
//
//   (2) provider_event — the 10:49 incident. agent:generating_completed →
//       terminal `completed` committed 296ms later, while the SAME session had
//       logged native_transcript_advancing (msgCount=542) one second earlier.
//   (1) poll — a hard pre-return on an unusable timestamp made the gate
//       unreachable. The real cause was SHAPE (no final assistant selected in a
//       tool-heavy tail), reported as a timestamp verdict.
//   (3) acked-hold synth — fail-OPEN on the same freshness evidence the poll
//       treats as fail-CLOSED, inside the same file.
//
// The contracts under test, in order of importance:
//   A. a MOVING transcript cannot be promoted to terminal on ANY path
//   B. a GENUINE completion still passes on every path (if this breaks, every
//      task in the fleet wedges — it is tested first-class, not incidentally)
//   C. RECLAIM of a dead session still works — a timeout is not completion
//      evidence, but recovery is still owed
// ---------------------------------------------------------------------------

// Isolate all file I/O (ledger JSONL, MeshRuntimeStore) to a per-run temp dir so
// the suite never touches the production ~/.adhdev/mesh-ledger.
const testTmpDir = path.join(tmpdir(), `adhdev-admission-paths-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')
vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' }),
}))

const meshConfigMocks = vi.hoisted(() => ({
  listMeshes: vi.fn(() => [] as any[]),
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
}))

vi.mock('../../src/config/mesh-config.js', () => ({
  listMeshes: meshConfigMocks.listMeshes,
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
}))

import {
  evaluateTerminalAdmission,
  TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS,
} from '../../src/mesh/mesh-terminal-admission.js'
import { evaluateProviderEventAdmission } from '../../src/mesh/mesh-provider-event-admission.js'
import { getTerminalAdmissionObservations } from '../../src/providers/completion/evidence.js'
import {
  pollAssignedTaskTerminalEvidence,
  reconcileUnterminatedDirectDispatches,
} from '../../src/mesh/mesh-completion-synthesis.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { __clearMeshQueueForTests, insertDirectDispatch, getActiveDirectDispatches } from '../../src/mesh/mesh-work-queue.js'
import { readLedgerEntries } from '../../src/mesh/mesh-ledger.js'
import { getRecentLogs } from '../../src/logging/logger.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const NOW = 1_760_000_000_000

// ── The 10:49 wire ─────────────────────────────────────────────────────────
// A final-LOOKING assistant bubble, and the transcript still moving underneath
// it. No trailing tool bubble has landed in the tail yet — that is precisely why
// the live-state gate's trailing-tool discriminator does not fire, and why
// FRESHNESS is the only signal that separates this from a real turn end.
function growingTailObservations(nowMs = NOW) {
  return {
    activeModalPresent: false,
    trailingActivityCount: 0,
    newestActivityAtMs: nowMs - 1_000, // 1s old — the 10:49 gap, well inside the 8s window
    finalAssistantPresent: true,
    nativeMarkersFieldPresent: false,
  }
}

function settledTailObservations(nowMs = NOW) {
  return {
    ...growingTailObservations(nowMs),
    newestActivityAtMs: nowMs - 60_000, // long quiet — a genuine turn end
  }
}

function makeInstance(observations: unknown, drain: string = 'idle') {
  return {
    getTerminalAdmissionObservations: () => observations,
    getDrainStatus: () => drain,
  }
}

// ── (2) provider_event — THE path that produced the incident ───────────────

describe('(2) provider_event admission — the 10:49 false completion', () => {
  it('★CORE CONTRACT: a completion arriving while the transcript is still growing is DECLINED', () => {
    const decision = evaluateProviderEventAdmission({
      instance: makeInstance(growingTailObservations()),
      providerType: 'kimi',
      nowMs: NOW,
    })
    expect(decision.kind).toBe('decline')
    expect(decision.kind === 'decline' && decision.reason).toBe('transcript_growing')
  })

  it('★LIVENESS: a genuine completion (settled tail) still ADMITS — breaking this wedges every task', () => {
    const decision = evaluateProviderEventAdmission({
      instance: makeInstance(settledTailObservations()),
      providerType: 'kimi',
      nowMs: NOW,
    })
    expect(decision.kind).toBe('admit')
  })

  it('★LIVENESS: a native turn-terminal marker admits STRONG even on a fresh tail', () => {
    // A provider that PROVES this turn ended outranks the freshness heuristic:
    // rule 3 runs before rule 6. Without this, a fast codex/kimi turn whose
    // marker lands inside the quiet window would be held every time.
    const decision = evaluateProviderEventAdmission({
      instance: makeInstance({
        ...growingTailObservations(),
        nativeMarkersFieldPresent: true,
        nativeMarkers: [{ receivedAt: NOW - 500, outcome: 'completed', summary: '', turnId: 't1' }],
      }),
      providerType: 'kimi',
      turnStartedAtMs: NOW - 60_000,
      nowMs: NOW,
    })
    expect(decision.kind).toBe('admit')
    expect(decision.kind === 'admit' && decision.evidenceLevel).toBe('strong')
  })

  it('★LIVENESS: a remote / unobservable session is UNOBSERVED, never declined', () => {
    // The single most dangerous regression this gate could introduce: declining
    // completions for workers we cannot see. Absence of evidence is never a veto.
    for (const instance of [undefined, null, {}, { getTerminalAdmissionObservations: 'nope' }]) {
      const decision = evaluateProviderEventAdmission({ instance, providerType: 'kimi', nowMs: NOW })
      expect(decision.kind).toBe('unobserved')
    }
  })

  it('★LIVENESS: a throwing / empty observation probe fails OPEN', () => {
    const thrower = { getTerminalAdmissionObservations: () => { throw new Error('probe blew up') } }
    expect(evaluateProviderEventAdmission({ instance: thrower, nowMs: NOW }).kind).toBe('unobserved')

    const empty = { getTerminalAdmissionObservations: () => null }
    expect(evaluateProviderEventAdmission({ instance: empty, nowMs: NOW }).kind).toBe('unobserved')
  })

  it('shapes OTHER than transcript_growing are not enforced here (they have their own handling)', () => {
    // Deliberate narrowing — see the module header. A tool-only/empty-reply turn
    // is a REAL turn end (codex: 19.5% of turns), and vetoing it here would
    // re-break the very completions the native-marker rule exists to release.
    const decision = evaluateProviderEventAdmission({
      instance: makeInstance({ ...settledTailObservations(), finalAssistantPresent: false }),
      providerType: 'kimi',
      nowMs: NOW,
    })
    expect(decision.kind).toBe('unobserved')
    expect(decision.kind === 'unobserved' && decision.reason).toContain('no_final_assistant_summary')
  })

  it('an unreadable drain status is OMITTED, not read as a non-idle veto', () => {
    // getDrainStatus absent/throwing/'other' must not decline: the event itself is
    // the provider asserting a turn end. Only the transcript rules apply.
    for (const drain of ['other', 'THROW', undefined]) {
      const instance: Record<string, unknown> = {
        getTerminalAdmissionObservations: () => settledTailObservations(),
      }
      if (drain === 'THROW') instance.getDrainStatus = () => { throw new Error('x') }
      else if (drain !== undefined) instance.getDrainStatus = () => drain
      const decision = evaluateProviderEventAdmission({ instance, providerType: 'kimi', nowMs: NOW })
      expect(decision.kind).toBe('admit')
    }
  })

  it('a genuinely generating session is declined by rule 2 (not enforced here, but observed)', () => {
    const decision = evaluateProviderEventAdmission({
      instance: makeInstance(settledTailObservations(), 'generating'),
      providerType: 'kimi',
      nowMs: NOW,
    })
    // Rule 2 fires; this gate leaves the veto to the live-state gate that runs
    // before it, so the decision is 'unobserved' carrying the observed reason.
    expect(decision.kind).toBe('unobserved')
    expect(decision.kind === 'unobserved' && decision.reason).toContain('session_not_idle')
  })
})

// ── The provider-side observation bundle (what feeds the gate) ─────────────

describe('provider observations — transcript freshness is what the live-state gate misses', () => {
  function hostWith(messages: unknown[] | null, snapshot: unknown, modalParked = false) {
    return {
      isModalParked: () => modalParked,
      probeNativeTranscriptSignals: () => ({ snapshot, messages }),
      lastNativeTurnTerminalMarkers: null,
    } as any
  }

  it('★the 10:49 shape: a growing transcript with NO trailing tool bubble is still observed as fresh', () => {
    // This is the exact blind spot. hasTrailingToolActivityAfterFinalAssistant
    // returns false here (nothing trails the assistant), so the live-state gate
    // sees "not pending". The mtime age proves the file is still being written.
    const obs = getTerminalAdmissionObservations(
      hostWith(
        [{ role: 'user', content: 'task', timestamp: NOW - 120_000 },
         { role: 'assistant', content: 'Working on it', timestamp: NOW - 90_000 }],
        { available: true, detail: { msgCount: 542, ageMs: 1_000 } },
      ),
      NOW,
    )
    expect(obs.trailingActivityCount).toBe(0)
    expect(obs.finalAssistantPresent).toBe(true)
    // The mtime (1s) is FRESHER than the newest bubble timestamp (90s) — the
    // freshest observation wins, so the veto engages.
    expect(NOW - obs.newestActivityAtMs!).toBeLessThan(TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS)
  })

  it('takes the FRESHER of bubble timestamp and snapshot mtime (a newer observation can only strengthen the veto)', () => {
    const obs = getTerminalAdmissionObservations(
      hostWith(
        [{ role: 'assistant', content: 'done', timestamp: NOW - 500 }],
        { available: true, detail: { msgCount: 3, ageMs: 90_000 } },
      ),
      NOW,
    )
    expect(obs.newestActivityAtMs).toBe(NOW - 500)
  })

  it('fails OPEN on an unavailable snapshot / null messages / a throwing probe', () => {
    const unavailable = getTerminalAdmissionObservations(hostWith(null, { available: false }), NOW)
    expect(unavailable.newestActivityAtMs).toBeUndefined()
    expect(unavailable.finalAssistantPresent).toBe(false)

    const thrower = getTerminalAdmissionObservations({
      isModalParked: () => false,
      probeNativeTranscriptSignals: () => { throw new Error('read failed') },
      lastNativeTurnTerminalMarkers: null,
    } as any, NOW)
    expect(thrower.newestActivityAtMs).toBeUndefined()
  })

  it('marker FIELD presence discriminates version skew (absent list ≠ authoritative empty list)', () => {
    const absent = getTerminalAdmissionObservations(
      hostWith([], { available: true, detail: { msgCount: 0, ageMs: 60_000 } }), NOW)
    expect(absent.nativeMarkersFieldPresent).toBe(false)

    const present = getTerminalAdmissionObservations({
      isModalParked: () => false,
      probeNativeTranscriptSignals: () => ({ snapshot: { available: true, detail: { msgCount: 1, ageMs: 60_000 } }, messages: [] }),
      lastNativeTurnTerminalMarkers: [],
    } as any, NOW)
    expect(present.nativeMarkersFieldPresent).toBe(true)
  })
})

// ── (1) + (3): the rules the other two paths now share ────────────────────

describe('(1)+(3) shared freshness contract — a timeout is never completion evidence', () => {
  const base = {
    producer: 'unit',
    providerType: 'kimi',
    providerHasNativeMarker: false,
    nativeMarkersFieldPresent: false,
    providerObservedStatus: 'idle',
    activeModalPresent: false,
    finalAssistantPresent: true,
    trailingActivityCount: 0,
    turnStartedAtMs: NOW - 60_000,
    nowMs: NOW,
  }

  it('★no deadline, however old, bypasses the transcript_growing veto', () => {
    // (3)'s death-deadline case: 8 minutes past the ack is NOT evidence the turn
    // ended. Freshness — not the age of the row — decides.
    const v = evaluateTerminalAdmission({
      ...base,
      turnStartedAtMs: NOW - 8 * 60_000,
      newestActivityAtMs: NOW - 1_000,
    })
    expect(v.admit).toBe(false)
    expect(!v.admit && v.reason).toBe('transcript_growing')
  })

  it('★RECLAIM PRESERVED: a DEAD session (no fresh activity) is NOT vetoed by freshness', () => {
    // The distinction that keeps recovery alive: a dead worker's transcript does
    // not grow, so the veto never engages for it and the death-deadline synth /
    // reclaim path proceeds exactly as before. Only a MOVING tail is refused.
    const v = evaluateTerminalAdmission({ ...base, newestActivityAtMs: NOW - 15_518_000 })
    expect(v.admit).toBe(true)
  })

  it('★an unobservable tail (no timestamps at all) never manufactures a veto', () => {
    const v = evaluateTerminalAdmission({ ...base, newestActivityAtMs: undefined })
    expect(v.admit).toBe(true)
  })

  it('the boundary is exactly the quiet window, shared by both paths', () => {
    const justInside = evaluateTerminalAdmission({
      ...base, newestActivityAtMs: NOW - (TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS - 1),
    })
    expect(justInside.admit).toBe(false)

    const justOutside = evaluateTerminalAdmission({
      ...base, newestActivityAtMs: NOW - TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS,
    })
    expect(justOutside.admit).toBe(true)
  })
})

// ── (1) poll path — the timestamp-unusable demotion, end to end ───────────

describe('(1) poll path — timestamp_unusable demoted from hard pre-return to admission input', () => {
  const NODE_ID = 'node_w'
  const SESSION_ID = 'sess-poll-demote'

  function cleanup(meshId: string) {
    try { __clearMeshQueueForTests(meshId) } catch { /* best-effort */ }
    try { MeshRuntimeStore.resetForTests() } catch { /* best-effort */ }
    meshConfigMocks.listMeshes.mockReturnValue([])
    meshConfigMocks.getMesh.mockReset()
  }

  function pollCase(meshId: string, providerType: string, payload: Record<string, unknown>, messages: any[], dispatchedAtMs: number) {
    const readChat = vi.fn(async (cmd: string, args?: any) => {
      if (cmd !== 'read_chat') return { success: true }
      const includeActivity = args?.includeActivity === true || args?.includeActivity === 'true'
      const visible = includeActivity ? messages : messages.filter(m => m?.kind !== 'tool' && m?.kind !== 'terminal')
      return { success: true, ...payload, messages: visible }
    })
    const mesh = { id: meshId, nodes: [{ id: NODE_ID, workspace: `/repo/${NODE_ID}` }] }
    meshConfigMocks.listMeshes.mockReturnValue([mesh])
    meshConfigMocks.getMesh.mockReturnValue(mesh)
    const components = {
      statusInstanceId: 'daemon_local_admission_paths',
      instanceManager: { getInstance: () => undefined, getByCategory: () => [] },
      commandHandler: { handle: readChat },
    } as any
    const row = {
      id: `task-${meshId}`,
      assignedSessionId: SESSION_ID,
      assignedNodeId: NODE_ID,
      assignedProviderType: providerType,
      dispatchTimestamp: new Date(dispatchedAtMs).toISOString(),
    }
    return { components, mesh, row }
  }

  function recentDrops(substr: string) {
    return getRecentLogs(200, 'warn').filter(e => e.message.includes(substr))
  }

  it('★THE MEASURED 43/49 CASE: a tool-heavy tail with NO final assistant now declines for the RIGHT reason (shape, not timestamp)', async () => {
    // This is the case the investigation measured. tailLimit=10 on a coordinator
    // session leaves only tool bubbles in the window, so
    // selectFinalAssistantTurnEndMessage returns null and transcriptMessageAt is
    // absent — which the OLD hard pre-return reported as `timestamp_unusable`.
    // The refusal is correct; the REASON was not, and it made the gate unreachable.
    const meshId = `mesh_paths_shape_${Date.now()}`
    try {
      const dispatchedAtMs = Date.now() - 120_000
      const { components, mesh, row } = pollCase(meshId, 'claude',
        { status: 'idle', providerObservedStatus: 'idle' },
        [
          { role: 'user', content: 'do the thing', timestamp: dispatchedAtMs + 1_000 },
          { role: 'assistant', content: '↗ Read: a.ts', kind: 'tool', timestamp: dispatchedAtMs + 30_000 },
          { role: 'assistant', content: '↘ ok', kind: 'tool', timestamp: dispatchedAtMs + 31_000 },
        ],
        dispatchedAtMs)

      expect(await pollAssignedTaskTerminalEvidence(components, mesh, row)).toBeNull()
      // The gate is now REACHED and answers with the honest shape reason.
      expect(recentDrops('poll_terminal_evidence_no_final_assistant_summary').length).toBeGreaterThan(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('★INVARIANT PRESERVED: an undated tail is still NEVER completed on shape evidence alone', () => {
    // The original guard's intent. Rules 5→8 make this structural
    // (finalAssistantPresent and transcriptMessageAt come from the SAME selector),
    // and the explicit dispatchBoundaryUnusable re-assertion pins it against
    // future drift in either extractor.
    const undated = evaluateTerminalAdmission({
      producer: 'unit',
      providerType: 'claude',
      providerHasNativeMarker: false,
      nativeMarkersFieldPresent: false,
      providerObservedStatus: 'idle',
      activeModalPresent: false,
      finalAssistantPresent: false, // no selection ⇒ no timestamp
      trailingActivityCount: 0,
      nowMs: NOW,
    })
    expect(undated.admit).toBe(false)
    expect(!undated.admit && undated.reason).toBe('no_final_assistant_summary')
  })

  it('★a provably STALE tail (summary predates dispatch) is still fail-closed', async () => {
    const meshId = `mesh_paths_stale_${Date.now()}`
    try {
      const dispatchedAtMs = Date.now() - 60_000
      const { components, mesh, row } = pollCase(meshId, 'claude',
        { status: 'idle', providerObservedStatus: 'idle' },
        [
          // A PRIOR task's summary, dated before this task's dispatch.
          { role: 'assistant', content: 'previous answer', timestamp: dispatchedAtMs - 600_000 },
        ],
        dispatchedAtMs)

      expect(await pollAssignedTaskTerminalEvidence(components, mesh, row)).toBeNull()
      expect(recentDrops('poll_terminal_evidence_summary_predates_dispatch').length).toBeGreaterThan(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('★LIVENESS: a genuine post-dispatch settled tail still COMPLETES through the poll', async () => {
    const meshId = `mesh_paths_genuine_${Date.now()}`
    try {
      const dispatchedAtMs = Date.now() - 300_000
      const { components, mesh, row } = pollCase(meshId, 'claude',
        { status: 'idle', providerObservedStatus: 'idle' },
        [
          { role: 'user', content: 'do the thing', timestamp: dispatchedAtMs + 1_000 },
          { role: 'assistant', content: 'Done. Added the update method and the tests pass.', timestamp: dispatchedAtMs + 60_000 },
        ],
        dispatchedAtMs)

      const evidence = await pollAssignedTaskTerminalEvidence(components, mesh, row)
      expect(evidence?.outcome).toBe('completed')
      expect(evidence?.evidenceLevel).toBe('weak')
    } finally {
      cleanup(meshId)
    }
  })

  it('★a MOVING tail is refused by the poll even though the summary is post-dispatch', async () => {
    const meshId = `mesh_paths_moving_${Date.now()}`
    try {
      const dispatchedAtMs = Date.now() - 300_000
      const { components, mesh, row } = pollCase(meshId, 'claude',
        { status: 'idle', providerObservedStatus: 'idle' },
        [
          { role: 'user', content: 'do the thing', timestamp: dispatchedAtMs + 1_000 },
          // Post-dispatch final assistant, but written 1s ago — still moving.
          { role: 'assistant', content: 'Working on it', timestamp: Date.now() - 1_000 },
        ],
        dispatchedAtMs)

      expect(await pollAssignedTaskTerminalEvidence(components, mesh, row)).toBeNull()
      expect(recentDrops('poll_terminal_evidence_transcript_growing').length).toBeGreaterThan(0)
    } finally {
      cleanup(meshId)
    }
  })
})

// ── (3) acked-hold synth — fail-open/fail-closed symmetry ─────────────────

describe('(3) acked-hold synth — the same freshness evidence the poll treats as fail-closed', () => {
  const NODE_ID = 'node_synth'
  const SESSION_ID = 'sess-synth'
  const WORKSPACE = '/repo/node_synth'

  function cleanup(meshId: string) {
    try { __clearMeshQueueForTests(meshId) } catch { /* best-effort */ }
    try { MeshRuntimeStore.resetForTests() } catch { /* best-effort */ }
    meshConfigMocks.listMeshes.mockReturnValue([])
    meshConfigMocks.getMesh.mockReset()
  }

  // Seed a direct dispatch that is WELL past every grace window and past the
  // acked-hold death deadline, so the synth would otherwise fire — this is the
  // "a timeout fired" state where fail-open used to matter most.
  function seedAgedDispatch(meshId: string, taskId: string, ageMs: number) {
    const dispatchedAt = new Date(Date.now() - ageMs).toISOString()
    MeshRuntimeStore.getInstance().appendLedgerEntry({
      id: `dispatch-${taskId}`,
      meshId,
      timestamp: dispatchedAt,
      kind: 'task_dispatched',
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      providerType: 'claude-code',
      payload: { source: 'direct', taskId, providerType: 'claude-code', targetSessionId: SESSION_ID },
    } as any)
    insertDirectDispatch(meshId, {
      taskId,
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      providerType: 'claude-code',
      message: 'do the task',
      via: 'local_direct',
      dispatchedAt,
    } as any)
  }

  function makeComponents(messages: any[]) {
    const readChat = vi.fn(async (cmd: string, args?: any) => {
      if (cmd !== 'read_chat') return { success: true }
      const includeActivity = args?.includeActivity === true || args?.includeActivity === 'true'
      const visible = includeActivity ? messages : messages.filter(m => m?.kind !== 'tool' && m?.kind !== 'terminal')
      return { success: true, status: 'idle', providerObservedStatus: 'idle', messages: visible }
    })
    return {
      statusInstanceId: 'daemon_local_synth',
      instanceManager: { getInstance: () => undefined, getByCategory: () => [] },
      commandHandler: { handle: readChat },
    } as any
  }

  function hostMesh(meshId: string) {
    const mesh = { id: meshId, nodes: [{ id: NODE_ID, workspace: WORKSPACE }], policy: {} }
    meshConfigMocks.listMeshes.mockReturnValue([mesh])
    meshConfigMocks.getMesh.mockReturnValue(mesh)
    return mesh
  }

  function recentDrops(substr: string) {
    return getRecentLogs(200, 'warn').filter(e => e.message.includes(substr))
  }

  it('★SYMMETRY: a MOVING tail is no longer fail-open — the synth is vetoed even long past the deadline', async () => {
    const meshId = `mesh_synth_growing_${Date.now()}`
    try {
      const taskId = `task-${randomUUID().slice(0, 8)}`
      const dispatchedAtMs = Date.now() - 20 * 60_000 // 20 min — past every deadline
      seedAgedDispatch(meshId, taskId, 20 * 60_000)
      const mesh = hostMesh(meshId)
      const components = makeComponents([
        { role: 'user', content: 'do the task', timestamp: dispatchedAtMs + 1_000 },
        // A final-LOOKING assistant bubble written 1s ago: the tail is still moving.
        { role: 'assistant', content: 'Working on it', timestamp: Date.now() - 1_000 },
      ])

      await reconcileUnterminatedDirectDispatches(components, mesh as any, ['daemon_local_synth'], 'daemon_local_synth')

      // No completion was manufactured off a moving transcript, deadline or not.
      expect(readLedgerEntries(meshId).some(e => e.kind === 'task_completed')).toBe(false)
      expect(recentDrops('reconcile_synth_veto_transcript_growing').length).toBeGreaterThan(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('★RECLAIM/BACKSTOP PRESERVED: a DEAD session (quiet tail) still synthesizes its completion', async () => {
    // The distinction that must survive: this veto refuses to complete a MOVING
    // tail. It must not disable recovery of a genuinely finished/dead worker —
    // whose transcript, by definition, is not growing.
    const meshId = `mesh_synth_dead_${Date.now()}`
    try {
      const taskId = `task-${randomUUID().slice(0, 8)}`
      const dispatchedAtMs = Date.now() - 20 * 60_000
      seedAgedDispatch(meshId, taskId, 20 * 60_000)
      const mesh = hostMesh(meshId)
      const components = makeComponents([
        { role: 'user', content: 'do the task', timestamp: dispatchedAtMs + 1_000 },
        // Answered 10 minutes ago and quiet since — a real, settled turn end.
        { role: 'assistant', content: 'Done — the update method is added and tests pass.', timestamp: Date.now() - 600_000 },
      ])

      await reconcileUnterminatedDirectDispatches(components, mesh as any, ['daemon_local_synth'], 'daemon_local_synth')

      expect(readLedgerEntries(meshId).some(e => e.kind === 'task_completed')).toBe(true)
      expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(false)
    } finally {
      cleanup(meshId)
    }
  })
})
