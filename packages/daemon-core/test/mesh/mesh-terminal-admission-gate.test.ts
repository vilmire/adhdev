import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// ---------------------------------------------------------------------------
// TERMINAL-ADMISSION-GATE — regression suite for the P0-1/P0-2/P0-3/P1-4 fixes.
//
// The incident being pinned: at the 15-min delivered-no-turn redrive deadline the
// terminal poll read a MID-TURN kimi worker's chat tail WITHOUT includeActivity
// (the trailing Edit tool call was filtered out), saw "idle + final assistant
// preamble", and flipped the queue row to completed — 6s before the worker went
// busy again. The fixes under test:
//   P0-1  single terminal-admission choke point (evaluateTerminalAdmission)
//   P0-2  includeActivity + native-marker priority (turnTerminalMarkers)
//   P0-3  RC.20 gates run BEFORE the terminal poll on the long redrive path
//   P1-4  a weak (message-shape) completion is a CANDIDATE — no queue/dependency
//         release until re-confirmed on consecutive ticks
//
// The Kimi wire reproduced below: assistant preamble → tool.call → tool.results,
// NO turn.ended. The Korean preamble text is INCIDENTAL — no test pattern-matches
// its content (the mission forbids phrase filtering); it is just a non-empty
// assistant bubble, exactly as the admission predicate treats it.
// ---------------------------------------------------------------------------

// Isolate all file I/O (ledger JSONL, MeshRuntimeStore, pending events) to a per-run
// temp dir so the suite never touches the production ~/.adhdev/mesh-ledger.
const testTmpDir = path.join(tmpdir(), `adhdev-terminal-admission-test-${randomUUID().slice(0, 8)}`)
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

import { runMeshReconcileTick, __resetReconcileInFlightSynthDebounceForTests, __resetReclaimUnknownStreakForTests } from '../../src/mesh/mesh-reconcile-loop.js'
import { pollAssignedTaskTerminalEvidence } from '../../src/mesh/mesh-completion-synthesis.js'
import { evaluateTerminalAdmission, TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS } from '../../src/mesh/mesh-terminal-admission.js'
import { buildMeshSystemMessage } from '../../src/mesh/mesh-events-utils.js'
import { getPendingMeshCoordinatorEvents } from '../../src/mesh/mesh-events-pending.js'
import { __resetMeshRuntimeStoreForTests, enqueueTask, getQueue, __clearMeshQueueForTests, claimNextTask } from '../../src/mesh/mesh-work-queue.js'
import { getLedgerDir, readLedgerEntries } from '../../src/mesh/mesh-ledger.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { createSessionDelivery } from '../../src/mesh/mesh-delivery-policy.js'
import { getRecentLogs } from '../../src/logging/logger.js'

function cleanup(meshId: string) {
  try { __clearMeshQueueForTests(meshId) } catch { /* best-effort */ }
  __resetMeshRuntimeStoreForTests()
  __resetReconcileInFlightSynthDebounceForTests()
  __resetReclaimUnknownStreakForTests()
  try { MeshRuntimeStore.resetForTests() } catch { /* best-effort */ }
  meshConfigMocks.listMeshes.mockReturnValue([])
  meshConfigMocks.getMesh.mockReset()
  const pendingPath = path.join(getLedgerDir(), `${meshId}.pending-events.jsonl`)
  if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath)
  const queuePath = path.join(getLedgerDir(), `${meshId}.queue.json`)
  if (fs.existsSync(queuePath)) fs.unlinkSync(queuePath)
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Shared fixtures ─────────────────────────────────────────────────────────

const TASK_PROMPT = 'graph store에 update 메서드를 추가하고 테스트를 통과시켜 주세요'
// Incidental non-empty assistant text — the exact wire preamble. NEVER matched on.
const WIRE_PREAMBLE = '이제 구현합니다. 먼저 graph store에 update 메서드를 추가합니다.'

const KIMI_FLOOR_PROFILE = { class: 'native-source', timing: 'floor', emitsPtyTurnEvents: false } as const
const NO_TURN_MS = 16 * 60_000 // past the 15-min DELIVERED_NO_TURN_DEADLINE

function backdateDispatch(meshId: string, taskId: string, ageMs: number) {
  const store = MeshRuntimeStore.getInstance()
  const entry = store.findQueueEntryById(meshId, taskId)!
  entry.dispatchTimestamp = new Date(Date.now() - ageMs).toISOString()
  store.updateQueueEntry(entry)
}

// ★FIDELITY: the fake read_chat SIMULATES the real activity-surface filtering
// (read-chat-presentation.ts): activity bubbles (kind 'tool'/'terminal') are
// STRIPPED from the returned tail unless the caller opts in with
// `includeActivity: true`. This makes the P0-2 fix load-bearing — a production
// revert that drops the flag reproduces the incident inside these tests.
function makeReadChat(payload: Record<string, unknown>, messages: any[]) {
  return vi.fn(async (cmd: string, args?: any) => {
    if (cmd !== 'read_chat') return { success: true }
    const includeActivity = args?.includeActivity === true || args?.includeActivity === 'true'
    const visible = includeActivity
      ? messages
      : messages.filter(m => m?.kind !== 'tool' && m?.kind !== 'terminal')
    return { success: true, ...payload, messages: visible }
  })
}

// The Kimi incident wire as read_chat messages: user prompt → assistant preamble
// → tool.call → tool.result bubbles, NO turn.ended. `fresh` places the tool
// activity seconds before now (mid-turn); stale places it minutes back.
function kimiMidTurnWire(dispatchedAtMs: number, tail: 'fresh' | 'stale'): any[] {
  // `stale` must land CLEARLY past NATIVE_SOURCE_ACTIVITY_STALE_MS (10min): with the
  // 16-min backdated dispatch, +6min leaves the bubble ~9.5min old — still "fresh" at
  // the gate and the poll never runs (boundary flake). +2/+3min ≈ 13min stale.
  const preambleAt = tail === 'fresh' ? Date.now() - 3_000 : dispatchedAtMs + 2 * 60_000
  const toolAt = tail === 'fresh' ? Date.now() - 1_500 : dispatchedAtMs + 3 * 60_000
  return [
    { role: 'user', content: TASK_PROMPT, timestamp: dispatchedAtMs + 1_000 },
    { role: 'assistant', content: WIRE_PREAMBLE, timestamp: preambleAt },
    { role: 'assistant', content: '↗ Edit: src/graph/store.ts', kind: 'tool', timestamp: toolAt },
    { role: 'assistant', content: '↘ The file has been updated.', kind: 'tool', timestamp: toolAt + 500 },
  ]
}

function hostMesh(meshId: string, nodes: Array<{ id: string }>) {
  const mesh = { id: meshId, nodes: nodes.map(n => ({ id: n.id, workspace: `/repo/${n.id}` })) }
  meshConfigMocks.listMeshes.mockReturnValue([mesh])
  meshConfigMocks.getMesh.mockReturnValue(mesh)
  return mesh
}

// Recent [drop:*] EvtTrace warnings naming `substr`, optionally scoped to a task.
function recentDrops(substr: string, taskId?: string) {
  return getRecentLogs(200, 'warn')
    .filter(e => e.message.includes(substr) && (!taskId || e.message.includes(`task=${taskId}`)))
}

// ── 1. Poll-level: the choke point itself ────────────────────────────────────

describe('poll-level: pollAssignedTaskTerminalEvidence via the admission choke point', () => {
  const NODE_ID = 'node_w'
  const SESSION_ID = 'sess-poll'

  function pollCase(meshId: string, providerType: string, payload: Record<string, unknown>, messages: any[], dispatchedAtMs: number) {
    const readChat = makeReadChat(payload, messages)
    const components = {
      statusInstanceId: 'daemon_local_admission',
      instanceManager: { getInstance: () => undefined, getByCategory: () => [] },
      commandHandler: { handle: readChat },
    } as any
    const mesh = hostMesh(meshId, [{ id: NODE_ID }])
    const row = {
      id: `task-${meshId}`,
      assignedSessionId: SESSION_ID,
      assignedNodeId: NODE_ID,
      assignedProviderType: providerType,
      dispatchTimestamp: new Date(dispatchedAtMs).toISOString(),
    }
    return { components, mesh, row, readChat }
  }

  it('1a: kimi, markers field PRESENT but empty (native read happened, no turn.ended) → decline native_marker_absent', async () => {
    const meshId = `mesh_adm_1a_${Date.now()}`
    try {
      const dispatchedAtMs = Date.now() - 60_000
      const { components, mesh, row } = pollCase(meshId, 'kimi',
        { status: 'idle', providerObservedStatus: 'idle', turnTerminalMarkers: [] },
        [
          { role: 'user', content: TASK_PROMPT, timestamp: dispatchedAtMs + 1_000 },
          // Idle + post-dispatch final assistant, quiet — message shape alone WOULD
          // admit. The empty marker list vetoes: the turn has NOT ended.
          { role: 'assistant', content: WIRE_PREAMBLE, timestamp: dispatchedAtMs + 30_000 },
        ],
        dispatchedAtMs)

      const evidence = await pollAssignedTaskTerminalEvidence(components, mesh, row)
      expect(evidence).toBeNull()
      expect(recentDrops('poll_terminal_evidence_native_marker_absent', row.id).length).toBeGreaterThan(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('1b: kimi, NO markers field (old daemon) + trailing tool bubbles → decline trailing_tool_activity; the poll reads with includeActivity:true', async () => {
    const meshId = `mesh_adm_1b_${Date.now()}`
    try {
      const dispatchedAtMs = Date.now() - 60_000
      const { components, mesh, row, readChat } = pollCase(meshId, 'kimi',
        { status: 'idle', providerObservedStatus: 'idle' },
        kimiMidTurnWire(dispatchedAtMs, 'stale'),
        dispatchedAtMs)

      const evidence = await pollAssignedTaskTerminalEvidence(components, mesh, row)
      expect(evidence).toBeNull()
      expect(recentDrops('poll_terminal_evidence_trailing_tool_activity', row.id).length).toBeGreaterThan(0)
      // P0-2 load-bearing: production MUST opt into the activity surface, or the
      // trailing Edit bubbles above are filtered out before the guard ever sees them.
      expect(readChat).toHaveBeenCalledWith('read_chat', expect.objectContaining({ includeActivity: true }))
    } finally {
      cleanup(meshId)
    }
  })

  it('1c: old daemon, final assistant FRESH (< quiet window), no trailing tool → decline transcript_growing', async () => {
    const meshId = `mesh_adm_1c_${Date.now()}`
    try {
      const dispatchedAtMs = Date.now() - 60_000
      const { components, mesh, row } = pollCase(meshId, 'kimi',
        { status: 'idle', providerObservedStatus: 'idle' },
        [
          { role: 'user', content: TASK_PROMPT, timestamp: dispatchedAtMs + 1_000 },
          { role: 'assistant', content: WIRE_PREAMBLE, timestamp: Date.now() - 500 },
        ],
        dispatchedAtMs)

      const evidence = await pollAssignedTaskTerminalEvidence(components, mesh, row)
      expect(evidence).toBeNull()
      expect(recentDrops('poll_terminal_evidence_transcript_growing', row.id).length).toBeGreaterThan(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('1d: old daemon, final assistant OLD and quiet, no trailing tool → weak admit (old-daemon fallback preserved)', async () => {
    const meshId = `mesh_adm_1d_${Date.now()}`
    try {
      const dispatchedAtMs = Date.now() - 60_000
      const { components, mesh, row } = pollCase(meshId, 'kimi',
        { status: 'idle', providerObservedStatus: 'idle', providerSessionId: 'kimi-hist-1' },
        [
          { role: 'user', content: TASK_PROMPT, timestamp: dispatchedAtMs + 1_000 },
          { role: 'assistant', content: WIRE_PREAMBLE, timestamp: dispatchedAtMs + 30_000 },
        ],
        dispatchedAtMs)

      const evidence = await pollAssignedTaskTerminalEvidence(components, mesh, row)
      expect(evidence).not.toBeNull()
      expect(evidence?.outcome).toBe('completed')
      expect(evidence?.evidenceLevel).toBe('weak')
      expect(evidence?.nativeMarker).toBeUndefined()
      expect(evidence?.admissionSnapshot?.nativeMarkersFieldPresent).toBe(false)
      expect(evidence?.admissionSnapshot?.finalAssistantPresent).toBe(true)
    } finally {
      cleanup(meshId)
    }
  })

  it('1e: kimi with a post-dispatch completed marker → strong admit with the marker attached; a PRE-dispatch marker → decline', async () => {
    const meshId = `mesh_adm_1e_${Date.now()}`
    try {
      const dispatchedAtMs = Date.now() - 60_000
      const messages = [
        { role: 'user', content: TASK_PROMPT, timestamp: dispatchedAtMs + 1_000 },
        { role: 'assistant', content: WIRE_PREAMBLE, timestamp: dispatchedAtMs + 30_000 },
      ]
      const strong = pollCase(meshId, 'kimi',
        {
          status: 'idle',
          providerObservedStatus: 'idle',
          turnTerminalMarkers: [{ receivedAt: dispatchedAtMs + 45_000, outcome: 'completed', summary: 'done', turnId: 'turn-1' }],
        },
        messages, dispatchedAtMs)
      const evidence = await pollAssignedTaskTerminalEvidence(strong.components, strong.mesh, strong.row)
      expect(evidence).not.toBeNull()
      expect(evidence?.evidenceLevel).toBe('strong')
      expect(evidence?.nativeMarker?.turnId).toBe('turn-1')
      expect(evidence?.admissionSnapshot?.nativeMarkerPresent).toBe(true)

      // Turn scoping: a marker from BEFORE this dispatch is a PRIOR turn's record —
      // it can never terminate this turn (the ANTIGRAVITY-PREMATURE-COMPLETION rule).
      const stale = pollCase(`${meshId}_stale`, 'kimi',
        {
          status: 'idle',
          providerObservedStatus: 'idle',
          turnTerminalMarkers: [{ receivedAt: dispatchedAtMs - 5_000, outcome: 'completed', summary: 'done', turnId: 'turn-0' }],
        },
        messages, dispatchedAtMs)
      expect(await pollAssignedTaskTerminalEvidence(stale.components, stale.mesh, stale.row)).toBeNull()
      expect(recentDrops('poll_terminal_evidence_native_marker_absent', stale.row.id).length).toBeGreaterThan(0)
    } finally {
      cleanup(meshId)
      cleanup(`${meshId}_stale`)
    }
  })

  it('1f: a parked approval modal with buttons → decline active_modal', async () => {
    const meshId = `mesh_adm_1f_${Date.now()}`
    try {
      const dispatchedAtMs = Date.now() - 60_000
      const { components, mesh, row } = pollCase(meshId, 'claude-cli',
        {
          status: 'idle',
          providerObservedStatus: 'idle',
          activeModal: { message: 'Allow Edit?', buttons: ['Approve', 'Reject'] },
        },
        [
          { role: 'user', content: TASK_PROMPT, timestamp: dispatchedAtMs + 1_000 },
          { role: 'assistant', content: WIRE_PREAMBLE, timestamp: dispatchedAtMs + 30_000 },
        ],
        dispatchedAtMs)

      expect(await pollAssignedTaskTerminalEvidence(components, mesh, row)).toBeNull()
      expect(recentDrops('poll_terminal_evidence_active_modal', row.id).length).toBeGreaterThan(0)
    } finally {
      cleanup(meshId)
    }
  })
})

describe('1g: evaluateTerminalAdmission rule table (pure predicate)', () => {
  const now = Date.now()
  const base = {
    producer: 'unit',
    providerType: 'kimi',
    providerHasNativeMarker: false,
    nativeMarkersFieldPresent: false,
    providerObservedStatus: 'idle',
    activeModalPresent: false,
    finalAssistantPresent: true,
    trailingActivityCount: 0,
    turnStartedAtMs: now - 60_000,
    newestActivityAtMs: now - 60_000,
    nowMs: now,
  }

  it('rule 1: a parked modal declines before anything else', () => {
    const v = evaluateTerminalAdmission({ ...base, activeModalPresent: true })
    expect(v.admit).toBe(false)
    expect(!v.admit && v.reason).toBe('active_modal')
  })

  it('rule 2: a non-idle (or unknown) provider verdict declines', () => {
    for (const providerObservedStatus of ['generating', 'waiting_approval', '']) {
      const v = evaluateTerminalAdmission({ ...base, providerObservedStatus })
      expect(v.admit).toBe(false)
      expect(!v.admit && v.reason).toBe('session_not_idle')
    }
  })

  it('rule 3: a scoped native marker admits STRONG; field-present-without-marker vetoes; field-absent falls through', () => {
    const strong = evaluateTerminalAdmission({
      ...base,
      providerHasNativeMarker: true,
      nativeMarkersFieldPresent: true,
      nativeMarkers: [{ receivedAt: now - 30_000, outcome: 'completed', summary: '', turnId: 't1' }],
      finalAssistantPresent: false, // markers prove turn end even with NO assistant text
      trailingActivityCount: 0,
    })
    expect(strong.admit).toBe(true)
    expect(strong.admit && strong.evidenceLevel).toBe('strong')
    expect(strong.admit && strong.reason).toBe('native_turn_terminal_marker')

    const veto = evaluateTerminalAdmission({
      ...base,
      providerHasNativeMarker: true,
      nativeMarkersFieldPresent: true,
      nativeMarkers: [],
    })
    expect(veto.admit).toBe(false)
    expect(!veto.admit && veto.reason).toBe('native_marker_absent')

    // No native read (old daemon) → the legacy shape rules decide.
    const fallback = evaluateTerminalAdmission({ ...base, providerHasNativeMarker: true, nativeMarkersFieldPresent: false })
    expect(fallback.admit).toBe(true)
    expect(fallback.admit && fallback.evidenceLevel).toBe('weak')
  })

  it('rule 4: trailing tool activity declines', () => {
    const v = evaluateTerminalAdmission({ ...base, trailingActivityCount: 2 })
    expect(v.admit).toBe(false)
    expect(!v.admit && v.reason).toBe('trailing_tool_activity')
  })

  it('rule 5: message shape without a final assistant declines', () => {
    const v = evaluateTerminalAdmission({ ...base, finalAssistantPresent: false })
    expect(v.admit).toBe(false)
    expect(!v.admit && v.reason).toBe('no_final_assistant_summary')
  })

  it('rule 6: transcript_growing has NO timeout/backstop bypass — an arbitrarily old turn is still vetoed while the tail is fresh', () => {
    // Three HOURS past dispatch: if any deadline could override the veto, this is
    // where it would. A quiet-valley preamble is FRESH, and freshness decides.
    const v = evaluateTerminalAdmission({
      ...base,
      turnStartedAtMs: now - 3 * 60 * 60_000,
      newestActivityAtMs: now - (TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS - 1),
    })
    expect(v.admit).toBe(false)
    expect(!v.admit && v.reason).toBe('transcript_growing')
  })

  it('rule 8: idle + quiet post-dispatch final assistant + no trailing activity → weak admit', () => {
    const v = evaluateTerminalAdmission(base)
    expect(v.admit).toBe(true)
    expect(v.admit && v.evidenceLevel).toBe('weak')
    expect(v.admit && v.reason).toBe('message_shape_fallback')
  })
})

// ── 2. Integration: the Kimi incident wire at the redrive deadline ──────────

describe('integration: redrive deadline, Kimi wire, queue/attempt stay non-terminal', () => {
  function makeIncidentCase(
    meshId: string,
    nodeId: string,
    sessionId: string,
    opts: { stampProfile: boolean; instance: 'idle' | 'absent'; markersField: boolean },
  ) {
    const dispatchedAtMs = Date.now() - NO_TURN_MS
    enqueueTask(meshId, TASK_PROMPT, { targetNodeId: nodeId, difficulty: 'medium' })
    const claimed = claimNextTask(meshId, nodeId, sessionId, [], {
      providerType: 'kimi',
      ...(opts.stampProfile ? { assignedTranscriptProfile: KIMI_FLOOR_PROFILE as any } : {}),
    })!
    backdateDispatch(meshId, claimed.id, NO_TURN_MS)
    createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: TASK_PROMPT, status: 'delivered' })

    const kimiProvider = {
      type: 'kimi',
      category: 'cli',
      transcriptAuthority: 'provider',
      nativeHistory: { source: { kind: 'jsonl' } },
      requiresFinalAssistantBeforeIdle: true,
      tui: { transcriptPty: { scope: 'buffer' } },
    }
    const idleInstance = {
      category: 'cli',
      provider: kimiProvider,
      getState: () => ({ instanceId: sessionId, status: 'idle', type: 'kimi', settings: { meshNodeFor: meshId, meshNodeId: nodeId } }),
    }
    const withInstance = opts.instance === 'idle'
    const readChat = makeReadChat(
      {
        status: 'idle',
        providerObservedStatus: 'idle',
        // Native read happened; NO turn.ended — the incident veto.
        ...(opts.markersField ? { turnTerminalMarkers: [] } : {}),
      },
      kimiMidTurnWire(dispatchedAtMs, 'fresh'),
    )
    const components = {
      instanceManager: {
        getByCategory: (category: string) => (category === 'cli' && withInstance ? [idleInstance] : []),
        getInstance: (id: string) => (withInstance && id === sessionId ? idleInstance : undefined),
      },
      commandHandler: { handle: readChat },
    } as any
    hostMesh(meshId, [{ id: nodeId }])
    return { claimed, components, readChat }
  }

  it('2: mid-turn kimi wire (fresh tool activity, no turn.ended) — four ticks, row stays assigned, attempt never terminal, no completion, no reclaim', async () => {
    const meshId = `mesh_adm_incident_${Date.now()}`
    const nodeId = 'node_w'
    const sessionId = 'sess-kimi-mid-turn'
    try {
      const { claimed, components } = makeIncidentCase(meshId, nodeId, sessionId, {
        stampProfile: true, instance: 'idle', markersField: true,
      })
      const nonceBefore = getQueue(meshId).find(t => t.id === claimed.id)!.dispatchNonce

      await runMeshReconcileTick(components)
      await runMeshReconcileTick(components)
      await runMeshReconcileTick(components)
      await runMeshReconcileTick(components)

      const row = getQueue(meshId).find(t => t.id === claimed.id)!
      expect(row.status).toBe('assigned')
      expect(row.dispatchNonce).toBe(nonceBefore)
      // The RC.20 activity gate holds first (fresh native-source activity): the
      // consumed link is promoted durably, and the attempt is NEVER terminal.
      const attempt = MeshRuntimeStore.getInstance().getCurrentTurnAttempt(meshId, claimed.id)
      expect(attempt?.terminalOutcome ?? null).toBeNull()
      expect(attempt?.stage).toBe('consumed')
      // The incident's outcome is impossible: no completion, no reclaim, no flip.
      expect(readLedgerEntries(meshId).some(e => e.kind === 'task_completed')).toBe(false)
      expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
    } finally {
      cleanup(meshId)
    }
  })

  it('2b: no profile stamp + unobservable (remote) session — the ACTIVITY GATE is skipped, the ADMISSION CHOKE POINT alone vetoes the flip (bounded reclaim follows, never completed)', async () => {
    const meshId = `mesh_adm_incident_nogate_${Date.now()}`
    const nodeId = 'node_w'
    const sessionId = 'sess-kimi-remote-mid-turn'
    try {
      const { claimed, components } = makeIncidentCase(meshId, nodeId, sessionId, {
        stampProfile: false, instance: 'absent', markersField: true,
      })

      // Ticks 1-2 accrue the UNKNOWN grace; from tick 3 the poll runs and DECLINES
      // (native_marker_absent — the markers field is present and empty), so the
      // bounded reclaim path proceeds. Pre-fix, this exact wire flipped COMPLETED.
      await runMeshReconcileTick(components)
      await runMeshReconcileTick(components)
      expect(getQueue(meshId).find(t => t.id === claimed.id)!.status).toBe('assigned')
      await runMeshReconcileTick(components)
      await runMeshReconcileTick(components)

      // The assertion that matters: it must NEVER become completed.
      expect(readLedgerEntries(meshId).some(e => e.kind === 'task_completed')).toBe(false)
      const row = getQueue(meshId).find(t => t.id === claimed.id)!
      expect(row.status).not.toBe('completed')
      // The choke point — not an activity gate (skipped: no stamp, no local instance)
      // — is what vetoed, and the bounded path then reclaimed.
      expect(recentDrops('poll_terminal_evidence_native_marker_absent', claimed.id).length).toBeGreaterThan(0)
      const reclaimed = readLedgerEntries(meshId).filter(e => e.kind === 'task_reclaimed')
      expect(reclaimed).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })
})

// ── 3. A false candidate never releases a dependency ────────────────────────

describe('P1-4: a weak completion candidate holds the queue row AND dependent tasks', () => {
  it('3: old-daemon quiet tail — candidate notified once (possible-completion wording), promoted on tick 3, dependency released exactly then, replay-fenced', async () => {
    const meshId = `mesh_adm_candidate_${Date.now()}`
    const nodeA = 'node_a'
    const nodeB = 'node_b'
    const sessionA = 'sess-claude-finished'
    try {
      const dispatchedAtMs = Date.now() - NO_TURN_MS
      enqueueTask(meshId, TASK_PROMPT, { targetNodeId: nodeA, difficulty: 'medium' })
      const claimedA = claimNextTask(meshId, nodeA, sessionA, [], { providerType: 'claude-cli' })!
      backdateDispatch(meshId, claimedA.id, NO_TURN_MS)
      createSessionDelivery({ meshId, nodeId: nodeA, sessionId: sessionA, taskId: claimedA.id, kind: 'task', message: TASK_PROMPT, status: 'delivered' })
      // B depends on A and targets a node with no session, so only an explicit
      // claim (or A's completion releasing the dependency) can move it.
      const taskB = enqueueTask(meshId, 'follow-up work', { targetNodeId: nodeB, difficulty: 'medium', dependsOn: [claimedA.id] })

      // claude-cli: NO native turn signal, NO markers field → message-shape (weak)
      // evidence only. Frozen timestamps: the candidate streak re-confirms the SAME
      // final-assistant evidence each tick (a moving transcript would reset it).
      const fixtureNow = Date.now()
      const idleInstance = {
        category: 'cli',
        getState: () => ({ instanceId: sessionA, status: 'idle', type: 'claude-cli', settings: { meshNodeFor: meshId, meshNodeId: nodeA } }),
      }
      const readChat = makeReadChat(
        { status: 'idle', providerObservedStatus: 'idle', providerSessionId: 'claude-hist-1' },
        [
          { role: 'user', content: TASK_PROMPT, timestamp: dispatchedAtMs + 1_000 },
          { role: 'assistant', content: 'All done — implemented and tests pass.', timestamp: fixtureNow - 60_000 },
        ],
      )
      const components = {
        instanceManager: {
          getByCategory: (category: string) => (category === 'cli' ? [idleInstance] : []),
          getInstance: (id: string) => (id === sessionA ? idleInstance : undefined),
        },
        commandHandler: { handle: readChat },
      } as any
      hostMesh(meshId, [{ id: nodeA }, { id: nodeB }])

      const completionsForA = () => readLedgerEntries(meshId)
        .filter(e => e.kind === 'task_completed' && (e.payload as any)?.taskId === claimedA.id)
      const pendingCompletionsForA = () => getPendingMeshCoordinatorEvents(meshId)
        .filter(e => e.event === 'agent:generating_completed' && (e.metadataEvent as any)?.taskId === claimedA.id)

      // Tick 1: candidate observed + notified; NO flip, NO terminal ledger, B blocked.
      await runMeshReconcileTick(components)
      expect(getQueue(meshId).find(t => t.id === claimedA.id)!.status).toBe('assigned')
      expect(completionsForA()).toHaveLength(0)
      expect(getQueue(meshId).find(t => t.id === taskB.id)!.status).toBe('pending')
      expect(claimNextTask(meshId, nodeB, 'sess_b', [])).toBeNull()

      // Tick 2: still a candidate — the SAME evidence must re-confirm.
      await runMeshReconcileTick(components)
      expect(getQueue(meshId).find(t => t.id === claimedA.id)!.status).toBe('assigned')
      expect(completionsForA()).toHaveLength(0)

      // Exactly ONE candidate notification, worded as a possibility, never an assertion.
      const notified = pendingCompletionsForA()
      expect(notified).toHaveLength(1)
      expect(notified[0].coordinatorMessage).toContain('possible completion')
      expect(notified[0].coordinatorMessage).not.toContain('has completed its task')
      expect(getRecentLogs(200, 'warn').some(e => e.message.includes('weak_completion_candidate_held'))).toBe(true)

      // Tick 3: identical quiet evidence → PROMOTION.
      await runMeshReconcileTick(components)
      expect(getQueue(meshId).find(t => t.id === claimedA.id)!.status).toBe('completed')
      expect(completionsForA()).toHaveLength(1)
      // The promotion carried the P1-5 admission snapshot into the ledger.
      const diagnostic = (completionsForA()[0].payload as any)?.completionDiagnostic
      expect(diagnostic?.terminalAdmission?.producer).toBe('redrive_deadline_transcript_evidence')
      expect(diagnostic?.terminalAdmission?.nativeMarkersFieldPresent).toBe(false)
      // …and ONLY now does the dependency release.
      const claimedB = claimNextTask(meshId, nodeB, 'sess_b', [])
      expect(claimedB?.id).toBe(taskB.id)

      // Replay fence: further ticks neither duplicate the terminal nor reclaim.
      await runMeshReconcileTick(components)
      await runMeshReconcileTick(components)
      expect(completionsForA()).toHaveLength(1)
      expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
    } finally {
      cleanup(meshId)
    }
  })
})

// ── 4. A genuine turn.ended completes exactly once ──────────────────────────

describe('P0-2: a native turn-terminal marker completes exactly once (strong admit)', () => {
  it('4: kimi, STALE activity (activity gate falls through) + post-dispatch turn.ended → first-tick strong completion, no duplicates, no candidate machinery', async () => {
    const meshId = `mesh_adm_strong_${Date.now()}`
    const nodeId = 'node_w'
    const sessionId = 'sess-kimi-turn-ended'
    try {
      const dispatchedAtMs = Date.now() - NO_TURN_MS
      enqueueTask(meshId, TASK_PROMPT, { targetNodeId: nodeId, difficulty: 'medium' })
      const claimed = claimNextTask(meshId, nodeId, sessionId, [], {
        providerType: 'kimi',
        assignedTranscriptProfile: KIMI_FLOOR_PROFILE as any,
      })!
      backdateDispatch(meshId, claimed.id, NO_TURN_MS)
      createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: TASK_PROMPT, status: 'delivered' })

      const kimiProvider = {
        type: 'kimi',
        category: 'cli',
        transcriptAuthority: 'provider',
        nativeHistory: { source: { kind: 'jsonl' } },
        requiresFinalAssistantBeforeIdle: true,
        tui: { transcriptPty: { scope: 'buffer' } },
      }
      const idleInstance = {
        category: 'cli',
        provider: kimiProvider,
        getState: () => ({ instanceId: sessionId, status: 'idle', type: 'kimi', settings: { meshNodeFor: meshId, meshNodeId: nodeId } }),
      }
      const readChat = makeReadChat(
        {
          status: 'idle',
          providerObservedStatus: 'idle',
          // The provider's OWN record: this turn ended, after this dispatch.
          turnTerminalMarkers: [{ receivedAt: dispatchedAtMs + 6 * 60_000, outcome: 'completed', summary: 'done', turnId: 'turn-1' }],
        },
        // STALE wire (> NATIVE_SOURCE_ACTIVITY_STALE_MS = 10min): the activity gate
        // falls through and the terminal poll decides — via the marker, STRONG.
        kimiMidTurnWire(dispatchedAtMs, 'stale'),
      )
      const components = {
        instanceManager: {
          getByCategory: (category: string) => (category === 'cli' ? [idleInstance] : []),
          getInstance: (id: string) => (id === sessionId ? idleInstance : undefined),
        },
        commandHandler: { handle: readChat },
      } as any
      hostMesh(meshId, [{ id: nodeId }])

      // First tick: strong admit → the immediate terminal flow (no 3-tick wait).
      await runMeshReconcileTick(components)
      const row = getQueue(meshId).find(t => t.id === claimed.id)!
      expect(row.status).toBe('completed')
      const completed = readLedgerEntries(meshId)
        .filter(e => e.kind === 'task_completed' && (e.payload as any)?.taskId === claimed.id)
      expect(completed).toHaveLength(1)
      // The strong admission rode into the ledger diagnostic (P1-5).
      const diagnostic = (completed[0].payload as any)?.completionDiagnostic
      expect(diagnostic?.terminalAdmission?.nativeMarkerPresent).toBe(true)
      // NO candidate machinery ran for a strong admit (scoped to THIS task — the
      // global warn ring still holds scenario 3's candidate traces).
      expect(recentDrops('weak_completion_candidate_held', claimed.id)).toHaveLength(0)
      expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)

      // Further ticks: no duplicate terminal, no candidate notification, no reclaim.
      await runMeshReconcileTick(components)
      await runMeshReconcileTick(components)
      expect(readLedgerEntries(meshId)
        .filter(e => e.kind === 'task_completed' && (e.payload as any)?.taskId === claimed.id)).toHaveLength(1)
      expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
    } finally {
      cleanup(meshId)
    }
  })
})

// ── 5. Wording unit ──────────────────────────────────────────────────────────

describe('P1-4 wording: weak completions read as candidates, genuine ones are unchanged', () => {
  it('5: weak metadata → "possible completion"; genuine metadata → the legacy "has completed its task" text', () => {
    const weak = buildMeshSystemMessage({
      event: 'agent:generating_completed',
      nodeLabel: "Node 'node_a'",
      metadataEvent: { evidenceLevel: 'weak', finalSummary: 'looks done', taskId: 't1', source: 'redrive_deadline_transcript_evidence' },
    })
    expect(weak).toContain('possible completion')
    expect(weak).not.toContain('has completed its task')

    const genuine = buildMeshSystemMessage({
      event: 'agent:generating_completed',
      nodeLabel: "Node 'node_a'",
      metadataEvent: { finalSummary: 'done', taskId: 't1' },
    })
    expect(genuine).toContain('has completed its task')
    expect(genuine).not.toContain('possible completion')
  })
})
