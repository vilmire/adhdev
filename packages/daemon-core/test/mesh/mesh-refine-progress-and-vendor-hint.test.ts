import { describe, expect, it } from 'vitest'

import {
  MIN_EVENT_INTERVAL_MS,
  SLOW_GATE_THRESHOLD_MS,
  buildRefineProgressEventPayload,
  isSlowRefineGate,
  shouldEmitRefineProgress,
  type RefineProgressContext,
} from '../../src/mesh/mesh-refine-progress'
import { buildRefineVendorDriftHint } from '../../src/mesh/mesh-refine-gates'
import { didRefineRebaseBranch } from '../../src/commands/router-refine'

// ★B1 progress admission + ★C vendor-drift-after-rebase explanation.

describe('B1 — only the big trunk and the slow parts are announced', () => {
  it('announces a gate only once it has cost real time', () => {
    expect(isSlowRefineGate(SLOW_GATE_THRESHOLD_MS)).toBe(true)
    expect(isSlowRefineGate(SLOW_GATE_THRESHOLD_MS + 1)).toBe(true)
    // ★The whole point: the ~35-gate set must NOT produce ~35 events. A fast gate
    // (lint, the size/shape guards, the config checks) is silent.
    expect(isSlowRefineGate(SLOW_GATE_THRESHOLD_MS - 1)).toBe(false)
    expect(isSlowRefineGate(250)).toBe(false)
  })

  it('throttles ordinary progress to a readable rate', () => {
    const context: RefineProgressContext = { meshId: 'm', jobId: 'j', lastEmittedAt: 1_000_000 }
    // Too soon after the last event.
    expect(shouldEmitRefineProgress(context, 'slow_gate', 1_000_000 + MIN_EVENT_INTERVAL_MS - 1)).toBe(false)
    // Far enough out.
    expect(shouldEmitRefineProgress(context, 'slow_gate', 1_000_000 + MIN_EVENT_INTERVAL_MS)).toBe(true)
    // First event of a job is never throttled.
    expect(shouldEmitRefineProgress({ meshId: 'm', jobId: 'j' }, 'node_started', 0)).toBe(true)
  })

  // ★B2: the event a coordinator must ACT on is never suppressed to save tokens.
  it.each([['node_failed'], ['chain_abort'], ['job_failed']] as const)(
    'never throttles %s',
    (phase) => {
      const context: RefineProgressContext = { meshId: 'm', jobId: 'j', lastEmittedAt: 1_000_000 }
      expect(shouldEmitRefineProgress(context, phase, 1_000_000 + 1)).toBe(true)
    },
  )

  it('routes a progress event to the same coordinator as the job’s terminal events', () => {
    const context: RefineProgressContext = {
      meshId: 'mesh-1',
      jobId: 'refine_abc',
      coordinatorDaemonId: 'daemon-1',
      coordinatorSessionId: 'session-1',
    }
    const payload = buildRefineProgressEventPayload(context, { phase: 'node_started', nodeId: 'node-1' }, 0)
    expect(payload.event).toBe('refine:progress')
    expect(payload.targetCoordinatorDaemonId).toBe('daemon-1')
    expect(payload.targetCoordinatorSessionId).toBe('session-1')
    // ★Both spellings of the session: the nested one is what survives the P2P relay.
    const metadata = payload.metadataEvent as Record<string, unknown>
    expect(metadata.meshCoordinatorSessionId).toBe('session-1')
    expect(metadata.progress).toBe(true)
    expect(metadata.jobId).toBe('refine_abc')
  })

  it('reports how many events were suppressed since the last emission', () => {
    const context: RefineProgressContext = { meshId: 'm', jobId: 'j' }
    const payload = buildRefineProgressEventPayload(context, { phase: 'slow_gate' }, 4)
    expect((payload.metadataEvent as Record<string, unknown>).suppressedSinceLast).toBe(4)
    // Nothing suppressed → the field is absent rather than a noisy zero.
    const quiet = buildRefineProgressEventPayload(context, { phase: 'slow_gate' }, 0)
    expect((quiet.metadataEvent as Record<string, unknown>).suppressedSinceLast).toBeUndefined()
  })
})

describe('C — a vendor-drift failure caused by the Refinery’s own rebase says so', () => {
  it('explains the drift and names the fix when the branch was rebased', () => {
    const hint = buildRefineVendorDriftHint({
      displayCommand: 'node scripts/check-vendor-drift.mjs',
      rebased: true,
    })
    expect(hint).toBeDefined()
    // ★The causal fact the old failure never stated.
    expect(hint).toContain('REBASED')
    // ★The exact command to run, not a vague "re-sync".
    expect(hint).toContain('bundle:vendor:all')
    // The oss pointer bump is the step most easily forgotten.
    expect(hint).toContain('oss')
  })

  it('stays silent when no rebase happened — the drift is then genuinely the branch’s', () => {
    expect(buildRefineVendorDriftHint({
      displayCommand: 'node scripts/check-vendor-drift.mjs',
      rebased: false,
    })).toBeUndefined()
  })

  it('stays silent for unrelated commands even after a rebase', () => {
    expect(buildRefineVendorDriftHint({ displayCommand: 'npm run typecheck', rebased: true })).toBeUndefined()
    expect(buildRefineVendorDriftHint({ displayCommand: 'npm run lint', rebased: true })).toBeUndefined()
  })

  it('matches the gate however the command is spelled', () => {
    // Registered in .adhdev/refine.json as command+args, so the args must be searched too.
    expect(buildRefineVendorDriftHint({
      displayCommand: 'node',
      args: ['scripts/check-vendor-drift.mjs'],
      rebased: true,
    })).toBeDefined()
  })
})

describe('C — rebase detection reads the recorded stage', () => {
  it('reports a rebase only when sync_base actually rebased', () => {
    expect(didRefineRebaseBranch([{ stage: 'sync_base', status: 'passed', rebased: true }])).toBe(true)
    expect(didRefineRebaseBranch([{ stage: 'sync_base', status: 'passed', rebased: false }])).toBe(false)
    // ★A gitlink-converge stage alone is NOT a rebase: it records resolutions that the
    // sync_base rebase then applies, and may be followed by a skipped rebase.
    expect(didRefineRebaseBranch([{ stage: 'submodule_gitlink_converge', status: 'passed' }])).toBe(false)
    expect(didRefineRebaseBranch([])).toBe(false)
    expect(didRefineRebaseBranch(undefined as any)).toBe(false)
  })
})
