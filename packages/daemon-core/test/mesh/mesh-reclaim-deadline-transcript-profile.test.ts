import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// Isolate all file I/O (ledger JSONL, MeshRuntimeStore, pending events) to a per-run
// temp dir so the suite never touches the production ~/.adhdev/mesh-ledger.
const testTmpDir = path.join(tmpdir(), `adhdev-reclaim-profile-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')
vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' }),
  getMachineId: () => 'test-machine',
  getMachineNickname: () => null,
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
  runMeshReconcileTick,
  __resetAutoPruneThrottleForTests,
  __resetReconcileInFlightSynthDebounceForTests,
  __resetReclaimUnknownStreakForTests,
} from '../../src/mesh/mesh-reconcile-loop.js'
import {
  __resetMeshRuntimeStoreForTests,
  enqueueTask,
  getQueue,
  __clearMeshQueueForTests,
  claimNextTask,
} from '../../src/mesh/mesh-work-queue.js'
import { getLedgerDir, readLedgerEntries } from '../../src/mesh/mesh-ledger.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { createSessionDelivery } from '../../src/mesh/mesh-delivery-policy.js'
import { getTurnLedgerMetrics, __resetTurnLedgerMetricsForTests } from '../../src/mesh/mesh-turn-ledger.js'

function cleanup(meshId: string) {
  try { __clearMeshQueueForTests(meshId) } catch { /* best-effort */ }
  __resetMeshRuntimeStoreForTests()
  __resetReconcileInFlightSynthDebounceForTests()
  __resetAutoPruneThrottleForTests()
  __resetReclaimUnknownStreakForTests()
  meshConfigMocks.listMeshes.mockReturnValue([])
  meshConfigMocks.getMesh.mockReset()
  for (const suffix of ['pending-events.jsonl', 'queue.json']) {
    const p = path.join(getLedgerDir(), `${meshId}.${suffix}`)
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }
}

function backdateDispatch(meshId: string, taskId: string, ageMs: number) {
  const store = MeshRuntimeStore.getInstance()
  const entry = store.findQueueEntryById(meshId, taskId)!
  entry.dispatchTimestamp = new Date(Date.now() - ageMs).toISOString()
  store.updateQueueEntry(entry)
}

/** Drop the row's assignedSessionId while KEEPING the claim-time transcript profile
 *  stamp. This is the shape a rebind/restart leaves behind: the coordinator still
 *  knows the worker's provider class, but has no session id to hang evidence off. */
function unbindRowSession(meshId: string, taskId: string) {
  const store = MeshRuntimeStore.getInstance()
  const entry = store.findQueueEntryById(meshId, taskId)!
  delete (entry as any).assignedSessionId
  store.updateQueueEntry(entry)
}

// Past the 15-min DELIVERED_NO_TURN_DEADLINE_MS.
const NO_TURN_MS = 16 * 60_000
// Past the consume grace but inside the 5-min ASSIGNED_STRANDED_DEADLINE_MS —
// the SHORT `delivered_not_consumed_redrive` path.
const SHORT_REDRIVE_MS = 4 * 60_000

// codex-cli's real shape: native-source, floor timing, emitsPtyTurnEvents=false.
// This is the class of the live incident (task c6e393ea, 2026-09-20).
const CODEX_FLOOR_PROFILE = { class: 'native-source', timing: 'floor', emitsPtyTurnEvents: false } as const

const codexProvider = {
  type: 'codex-cli',
  category: 'cli',
  transcriptAuthority: 'provider',
  nativeHistory: { source: { kind: 'jsonl' } },
  requiresFinalAssistantBeforeIdle: true,
  tui: { transcriptPty: { scope: 'buffer' } },
}

/**
 * Build a delivered-but-never-acked row on a codex-cli (native-source floor) session,
 * aged past the requested deadline. The transcript is QUIET past the stale window and
 * carries a trailing tool bubble so the terminal-evidence poll declines — the exact
 * "silently reasoning for minutes" shape from the live incident.
 */
function makeSilentWorkerCase(opts: {
  meshId: string
  nodeId: string
  sessionId: string
  ageMs: number
  adapterLiveTurn?: boolean
  /** Drop assignedSessionId after claiming, keeping the profile stamp. */
  unbindSession?: boolean
  /** 'absent' → no local instance (remote worker; verdict UNKNOWN). */
  instance?: 'idle' | 'absent'
}) {
  const { meshId, nodeId, sessionId, ageMs } = opts
  const dispatchAt = Date.now()
  enqueueTask(meshId, 'audit the reclaim deadline paths', { targetNodeId: nodeId, difficulty: 'medium' })
  const claimed = claimNextTask(meshId, nodeId, sessionId, [], {
    providerType: 'codex-cli',
    assignedTranscriptProfile: CODEX_FLOOR_PROFILE as any,
  })!
  backdateDispatch(meshId, claimed.id, ageMs)
  createSessionDelivery({
    meshId, nodeId, sessionId, taskId: claimed.id,
    kind: 'task', message: 'audit the reclaim deadline paths', status: 'delivered',
  })
  if (opts.unbindSession) unbindRowSession(meshId, claimed.id)

  const instance = {
    category: 'cli',
    provider: codexProvider,
    getState: () => ({
      instanceId: sessionId, status: 'idle', type: 'codex-cli',
      settings: { meshNodeFor: meshId, meshNodeId: nodeId },
    }),
    ...(opts.adapterLiveTurn !== undefined
      ? { hasLiveTurnPendingEvidence: () => opts.adapterLiveTurn === true }
      : {}),
  }
  const withInstance = (opts.instance ?? 'idle') === 'idle'
  // Transcript: post-dispatch work started, then went QUIET ~14.5 min ago —
  // far past NATIVE_SOURCE_ACTIVITY_STALE_MS (10 min).
  const dispatchedAt = dispatchAt - ageMs
  const messages = [
    { role: 'user', content: 'audit the reclaim deadline paths', timestamp: dispatchedAt + 300 },
    { role: 'assistant', content: 'Reading the reconcile paths…', timestamp: dispatchedAt + 60_000 },
    { role: 'assistant', content: '', kind: 'tool', timestamp: dispatchedAt + 90_000 },
  ]
  const readChat = vi.fn(async (cmd: string) => {
    if (cmd !== 'read_chat') return { success: true }
    return { success: true, status: 'idle', messages }
  })
  const components = {
    instanceManager: {
      getByCategory: (c: string) => (c === 'cli' && withInstance ? [instance] : []),
      getInstance: (id: string) => (withInstance && id === sessionId ? instance : undefined),
    },
    commandHandler: { handle: readChat },
  } as any
  const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w' }] }
  meshConfigMocks.listMeshes.mockReturnValue([mesh])
  meshConfigMocks.getMesh.mockReturnValue(mesh)
  return { claimed, components, readChat }
}

const reclaims = (meshId: string) => readLedgerEntries(meshId).filter(e => e.kind === 'task_reclaimed')

describe('reclaim deadlines must respect assignedTranscriptProfile.emitsPtyTurnEvents=false', () => {
  beforeEach(() => {
    __resetTurnLedgerMetricsForTests()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── DEFECT A: the long (15-min delivered-no-turn) path's ENTIRE native-source
  // gate block — the activity gate AND the adapter-live veto — was guarded on
  // `evidenceSessionId` being non-empty. A row that lost its session binding
  // (rebind / restart / refused claim) still carries the claim-time profile
  // stamp, which needs no session to read. With no session the verdict is
  // hard-coded IDLE_CONFIRMED, so the row went straight to the reclaim with
  // reason `delivered_no_turn_deadline` WITHOUT the profile ever being consulted.
  // That is the observed live shape: task c6e393ea produced its answer and was
  // reclaimed anyway, its `assignedTranscriptProfile` already saying
  // emitsPtyTurnEvents:false.
  it('DEFECT A: a session-unbound row whose stamped profile says emitsPtyTurnEvents=false is NOT reclaimed at the delivered-no-turn deadline', async () => {
    const meshId = `mesh_defect_a_${Date.now()}`
    try {
      const { claimed, components } = makeSilentWorkerCase({
        meshId, nodeId: 'node_w', sessionId: 'sess-codex-unbound',
        ageMs: NO_TURN_MS, unbindSession: true,
      })

      await runMeshReconcileTick(components)

      // The profile must be consulted from the ROW STAMP even with no session id.
      expect(reclaims(meshId).map(e => (e.payload as any).reason)).not.toContain('delivered_no_turn_deadline')
      expect(getQueue(meshId).find(t => t.id === claimed.id)!.status).toBe('assigned')
    } finally {
      cleanup(meshId)
    }
  })

  // ── DEFECT B: the SHORT (`delivered_not_consumed_redrive`, 5-min) path carried
  // the identical `evidenceSessionId` guard on its profile read, so the same
  // session-unbound row was re-driven there too — re-injecting the prompt into a
  // worker that never stopped.
  it('DEFECT B: a session-unbound row whose stamped profile says emitsPtyTurnEvents=false is NOT re-driven on the short delivered-not-consumed path', async () => {
    const meshId = `mesh_defect_b_${Date.now()}`
    try {
      const { claimed, components } = makeSilentWorkerCase({
        meshId, nodeId: 'node_w', sessionId: 'sess-codex-unbound-short',
        ageMs: SHORT_REDRIVE_MS, unbindSession: true,
      })

      await runMeshReconcileTick(components)

      expect(reclaims(meshId).map(e => (e.payload as any).reason)).not.toContain('delivered_not_consumed_redrive')
      expect(getQueue(meshId).find(t => t.id === claimed.id)!.status).toBe('assigned')
    } finally {
      cleanup(meshId)
    }
  })

  // ── DEFECT C: the SHORT path had NO adapter-live veto at all. Its only
  // profile-aware hold was `pollAssignedTaskInTurnProgress` — a TRANSCRIPT read.
  // The rc.23 incident proved a codex-cli turn writes NOTHING to the transcript
  // for ~6 minutes of silent model reasoning, so a worker mid-thought presents as
  // "no post-dispatch activity" and is re-driven. The long path already appeals
  // to the adapter (RECLAIM-ADAPTER-LIVE-TURN); the short path must too — same
  // signal, same root cause as rc.22/rc.23.
  it('DEFECT C: a transcript-SILENT worker whose ADAPTER turn is still open is NOT re-driven on the short delivered-not-consumed path', async () => {
    const meshId = `mesh_defect_c_${Date.now()}`
    try {
      const { claimed, components } = makeSilentWorkerCase({
        meshId, nodeId: 'node_w', sessionId: 'sess-codex-thinking',
        ageMs: SHORT_REDRIVE_MS, adapterLiveTurn: true,
      })
      // No post-dispatch transcript activity at all — pure silent reasoning.
      ;(components.commandHandler.handle as any).mockImplementation(async (cmd: string) =>
        cmd === 'read_chat' ? { success: true, status: 'idle', messages: [] } : { success: true })

      await runMeshReconcileTick(components)

      expect(reclaims(meshId).map(e => (e.payload as any).reason)).not.toContain('delivered_not_consumed_redrive')
      expect(getQueue(meshId).find(t => t.id === claimed.id)!.status).toBe('assigned')
      expect(getTurnLedgerMetrics().redriveBlockedByReason['native_source_adapter_live']).toBeGreaterThanOrEqual(1)
    } finally {
      cleanup(meshId)
    }
  })

  // ── CONTROL GROUP 1 (must stay GREEN through the fix): a CLOSED adapter turn on
  // a genuinely stale transcript still reclaims. The fix must not become an
  // unbounded hold — this is the bounded-recovery direction.
  it('CONTROL: a CLOSED adapter turn on a stale transcript STILL reclaims at the delivered-no-turn deadline', async () => {
    const meshId = `mesh_control_closed_${Date.now()}`
    try {
      const { components } = makeSilentWorkerCase({
        meshId, nodeId: 'node_w', sessionId: 'sess-codex-done',
        ageMs: NO_TURN_MS, adapterLiveTurn: false,
      })

      await runMeshReconcileTick(components)

      expect(reclaims(meshId).map(e => (e.payload as any).reason)).toContain('delivered_no_turn_deadline')
    } finally {
      cleanup(meshId)
    }
  })

  // ── CONTROL GROUP 2 (must stay GREEN through the fix): a provider WITH reliable
  // PTY turn events (emitsPtyTurnEvents=true — claude-cli / daemon-owned) is
  // untouched by any of this. Its missing generating_started genuinely means the
  // prompt was never consumed, so the short redrive must still fire immediately.
  it('CONTROL: an emitsPtyTurnEvents=TRUE provider is unaffected — the short redrive still fires', async () => {
    const meshId = `mesh_control_pty_${Date.now()}`
    const nodeId = 'node_w'
    const sessionId = 'sess-claude-never-started'
    try {
      enqueueTask(meshId, 'a pty-event provider task', { targetNodeId: nodeId, difficulty: 'medium' })
      const claimed = claimNextTask(meshId, nodeId, sessionId, [], {
        providerType: 'claude-cli',
        assignedTranscriptProfile: { class: 'daemon-owned', timing: 'immediate', emitsPtyTurnEvents: true } as any,
      })!
      backdateDispatch(meshId, claimed.id, SHORT_REDRIVE_MS)
      createSessionDelivery({
        meshId, nodeId, sessionId, taskId: claimed.id,
        kind: 'task', message: 'a pty-event provider task', status: 'delivered',
      })
      const instance = {
        category: 'cli',
        provider: { type: 'claude-cli', category: 'cli', transcriptAuthority: 'daemon' },
        getState: () => ({
          instanceId: sessionId, status: 'idle', type: 'claude-cli',
          settings: { meshNodeFor: meshId, meshNodeId: nodeId },
        }),
        // Adapter reports a live turn — for a PTY-event provider this must NOT
        // be consulted (the class never enters the native-source branch at all).
        hasLiveTurnPendingEvidence: () => true,
      }
      const components = {
        instanceManager: {
          getByCategory: (c: string) => (c === 'cli' ? [instance] : []),
          getInstance: (id: string) => (id === sessionId ? instance : undefined),
        },
        commandHandler: { handle: vi.fn(async () => ({ success: true, status: 'idle', messages: [] })) },
      } as any
      const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w' }] }
      meshConfigMocks.listMeshes.mockReturnValue([mesh])
      meshConfigMocks.getMesh.mockReturnValue(mesh)

      await runMeshReconcileTick(components)

      expect(reclaims(meshId).map(e => (e.payload as any).reason)).toContain('delivered_not_consumed_redrive')
    } finally {
      cleanup(meshId)
    }
  })
})
