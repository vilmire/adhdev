import { describe, expect, it, vi, beforeEach } from 'vitest'

// PROJECTION-SELF-REFERENCE — the turn-completion deadlock.
//
// For a mesh-owned session, Stage 6 replaces read_chat's `status` with the turn-ledger
// stage (read-chat-presentation.ts). pollAssignedTaskTerminalEvidence — the writer that
// ADVANCES that stage — used to gate on `status === 'idle'`. That closed a cycle: the
// ledger stayed `generating` because the poll declined, and the poll declined because the
// ledger said `generating`. Observed live for 1h+ on codex-cli AND claude-cli (attempt
// 22ac9624, 328 `session_not_idle` drops on a session whose turn had visibly ended).
//
// The fix reads the provider's OWN verdict (`providerObservedStatus`), which is the one
// input independent of the ledger. These tests pin BOTH directions:
//   - the deadlock is broken (a finished worker completes even while projected=generating)
//   - completion detection is NOT loosened (mid-turn is still refused, and every
//     structural turn-end guard still carries load)

import { pollAssignedTaskTerminalEvidence } from '../../src/mesh/mesh-completion-synthesis.js'

const MESH_ID = 'mesh_projection_self_ref'
const NODE_ID = 'node_local_selfref'
const SESSION_ID = 'session-selfref-1'
const TASK_ID = 'task-selfref-1'
const DISPATCH_AT = '2026-08-15T07:51:03.698Z'
// Comfortably after dispatch, and old enough that no settle window is in play.
const FINAL_ASSISTANT_AT = '2026-08-15T07:53:00.000Z'

const mesh = { id: MESH_ID, nodes: [{ id: NODE_ID, workspace: '/repo/selfref' }] }
const row = {
  id: TASK_ID,
  assignedSessionId: SESSION_ID,
  assignedNodeId: NODE_ID,
  assignedProviderType: 'codex-cli',
  dispatchTimestamp: DISPATCH_AT,
}

function finishedTranscript() {
  return [
    { role: 'user', content: 'do the thing', timestamp: DISPATCH_AT },
    { role: 'assistant', content: 'Here is the completed report.', timestamp: FINAL_ASSISTANT_AT },
  ]
}

/**
 * A daemon whose read_chat returns the given payload. The session is treated as
 * local (no daemonId on the node), so the poll takes the commandHandler path.
 */
function componentsReturning(payload: Record<string, unknown>) {
  return {
    statusInstanceId: 'daemon_local_selfref',
    instanceManager: { getInstance: () => undefined },
    commandHandler: { handle: vi.fn(async () => ({ success: true, ...payload })) },
  } as any
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('PROJECTION-SELF-REFERENCE: the ledger-vs-poll deadlock', () => {
  it('completes a finished turn even while the projected status still reads generating', async () => {
    // The exact live shape: Stage 6 has overwritten `status` with the stale ledger
    // stage, while the provider itself has settled to idle and the transcript holds a
    // post-dispatch final assistant message.
    const components = componentsReturning({
      status: 'generating',            // projected — the stale ledger stage
      providerObservedStatus: 'idle',  // the provider's own verdict
      messages: finishedTranscript(),
    })

    const evidence = await pollAssignedTaskTerminalEvidence(components, mesh, row)

    expect(evidence).not.toBeNull()
    expect(evidence?.outcome).toBe('completed')
    expect(evidence?.finalSummary).toContain('completed report')
  })

  it('INJECTION (revert the fix): gating on the projected status re-wedges the turn', async () => {
    // Reverting means reading `status` again. Simulate exactly that by having the
    // provider field agree with the stale projection — which is what the pre-fix
    // reader effectively did — and confirm the poll declines. This is the red state
    // the fix removes.
    const components = componentsReturning({
      status: 'generating',
      providerObservedStatus: 'generating',
      messages: finishedTranscript(),
    })

    expect(await pollAssignedTaskTerminalEvidence(components, mesh, row)).toBeNull()
  })
})

describe('mid-turn promotion stays impossible', () => {
  it('refuses a worker whose OWN verdict is generating, transcript notwithstanding', async () => {
    // The load-bearing safety property: a genuinely mid-turn provider reports
    // `generating` in providerObservedStatus too, so the new reader refuses it just as
    // the old one did.
    const components = componentsReturning({
      status: 'generating',
      providerObservedStatus: 'generating',
      messages: finishedTranscript(),
    })

    expect(await pollAssignedTaskTerminalEvidence(components, mesh, row)).toBeNull()
  })

  it('refuses a worker parked on an approval modal', async () => {
    const components = componentsReturning({
      status: 'waiting_approval',
      providerObservedStatus: 'waiting_approval',
      messages: finishedTranscript(),
    })

    expect(await pollAssignedTaskTerminalEvidence(components, mesh, row)).toBeNull()
  })
})

describe('the structural turn-end guards still carry load', () => {
  // Each case below is idle-by-provider AND projected-idle, so ONLY the named guard
  // can be what refuses it. If a guard were dropped, the corresponding case would
  // return a completion — which is the over-loosening these tests exist to catch.

  it('guard: a final assistant message is required (user-only transcript is not a turn-end)', async () => {
    // NOTE on isolation: an EMPTY transcript is the obvious case, but it is a bad probe
    // for THIS guard — with no messages there is also no timestamp, so the later
    // stale-tail check declines it anyway and the assertion passes even if the
    // final-assistant guard is deleted (verified by injection). Use a transcript that
    // clears every OTHER guard — post-dispatch, well-formed timestamps, no trailing tool
    // activity — and differs only in having no assistant message at all.
    const components = componentsReturning({
      status: 'idle',
      providerObservedStatus: 'idle',
      messages: [
        { role: 'user', content: 'do the thing', timestamp: FINAL_ASSISTANT_AT },
      ],
    })

    expect(await pollAssignedTaskTerminalEvidence(components, mesh, row)).toBeNull()
  })

  it('guard: trailing tool activity after the final assistant means mid-turn', async () => {
    const components = componentsReturning({
      status: 'idle',
      providerObservedStatus: 'idle',
      messages: [
        ...finishedTranscript(),
        { role: 'assistant', kind: 'tool_use', content: 'Read(src/index.ts)', timestamp: '2026-08-15T07:53:05.000Z' },
      ],
    })

    expect(await pollAssignedTaskTerminalEvidence(components, mesh, row)).toBeNull()
  })

  it('guard: a summary predating dispatch is a stale tail, not this turn', async () => {
    const components = componentsReturning({
      status: 'idle',
      providerObservedStatus: 'idle',
      messages: [
        { role: 'assistant', content: 'A previous task summary.', timestamp: '2026-08-15T07:00:00.000Z' },
      ],
    })

    expect(await pollAssignedTaskTerminalEvidence(components, mesh, row)).toBeNull()
  })

  it('guard: the settle window rejects a final assistant that is still too fresh', async () => {
    const now = Date.now()
    const components = componentsReturning({
      status: 'idle',
      providerObservedStatus: 'idle',
      messages: [
        { role: 'user', content: 'go', timestamp: new Date(now - 60_000).toISOString() },
        { role: 'assistant', content: 'Let me look into that.', timestamp: new Date(now - 500).toISOString() },
      ],
    })

    const evidence = await pollAssignedTaskTerminalEvidence(
      components,
      { ...mesh },
      { ...row, dispatchTimestamp: new Date(now - 60_000).toISOString() },
      { minFinalAssistantAgeMs: 10_000 },
    )

    expect(evidence).toBeNull()
  })
})

describe('mixed-version fallback', () => {
  it('an older daemon omitting the field falls back to the projected status (never a fabricated idle)', async () => {
    // No providerObservedStatus at all. The reader must fall back to `status` —
    // pre-fix behaviour — rather than defaulting to idle and inventing a turn-end.
    const components = componentsReturning({
      status: 'generating',
      messages: finishedTranscript(),
    })

    expect(await pollAssignedTaskTerminalEvidence(components, mesh, row)).toBeNull()
  })

  it('an older daemon reporting idle still completes through the normal guards', async () => {
    const components = componentsReturning({
      status: 'idle',
      messages: finishedTranscript(),
    })

    const evidence = await pollAssignedTaskTerminalEvidence(components, mesh, row)
    expect(evidence?.outcome).toBe('completed')
  })
})
