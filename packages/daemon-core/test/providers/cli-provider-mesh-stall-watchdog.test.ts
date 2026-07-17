import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// MESH-STALL-WATCH (feature 1: STALL detection). The status-agnostic stall
// watchdog fires exactly ONE informational monitor:no_progress event when a
// coordinator-spawned mesh worker's raw PTY output (lastOutputAt) has been
// unchanged past MESH_WORKER_STALL_THRESHOLD_MS (180s). It reuses the adapter's
// existing lastOutputAt clock (no new signal) and is driven by the manager's 5s
// onTick (no new timer). It re-arms on new output (fires again for a later
// stall), anchors a silent spawn on the spawn time, and never fires for a
// non-mesh session.
const STALL_MS = 180_000

describe('CliProviderInstance.checkMeshWorkerStall', () => {
  function makeInstance(opts: {
    settings: Record<string, any>
    lastOutputAt: number
    status?: string
    alive?: boolean
    startedAt?: number
  }) {
    const emitted: any[] = []
    const instance = Object.create(CliProviderInstance.prototype) as any
    instance.instanceId = 'sess-instance-1'
    instance.type = 'claude-code'
    instance.workingDir = '/work/repo'
    instance.providerSessionId = 'provider-sess-1'
    instance.settings = opts.settings
    instance.events = []
    instance.startedAt = opts.startedAt ?? 1_000
    // Mesh-stall episode fields must start uninitialised (mirrors the class
    // instance-field defaults, which Object.create does NOT run).
    instance.meshStallAnchorAt = -1
    instance.meshStallEmittedForAnchor = false
    const adapter = {
      currentTurnTaskId: undefined as string | undefined,
      _lastOutputAt: opts.lastOutputAt,
      _status: opts.status ?? 'idle',
      _alive: opts.alive ?? true,
      isAlive() { return this._alive },
      getStatus() { return { lastOutputAt: this._lastOutputAt, status: this._status } },
    }
    instance.adapter = adapter
    instance.context = { emitProviderEvent: (e: any) => emitted.push(e) }
    return { instance, emitted, adapter }
  }

  const meshSettings = { meshNodeFor: 'mesh-abc', meshNodeId: 'node-1', meshActiveTaskId: 'task-1' }

  it('fires exactly one stall event after 180s of unchanged output', () => {
    const outputAt = 10_000
    const { instance, emitted } = makeInstance({ settings: meshSettings, lastOutputAt: outputAt })
    // First tick arms the episode against the current lastOutputAt — no emit.
    instance.checkMeshWorkerStall(outputAt + 5_000)
    expect(emitted).toHaveLength(0)
    // Just under the threshold — still no emit.
    instance.checkMeshWorkerStall(outputAt + STALL_MS - 1)
    expect(emitted).toHaveLength(0)
    // At/over the threshold — one stall event.
    instance.checkMeshWorkerStall(outputAt + STALL_MS)
    expect(emitted).toHaveLength(1)
    const ev = emitted[0]
    expect(ev.event).toBe('monitor:no_progress')
    expect(ev.meshWorkerStall).toBe(true)
    expect(ev.lastOutputAt).toBe(outputAt)
    expect(ev.stalledMs).toBe(STALL_MS)
    expect(ev.observedStatus).toBe('idle')
    expect(ev.taskId).toBe('task-1')
    // A subsequent tick with STILL no new output does NOT re-emit for the same stall.
    instance.checkMeshWorkerStall(outputAt + STALL_MS + 60_000)
    expect(emitted).toHaveLength(1)
  })

  it('re-arms on new output so a later stall fires again', () => {
    const outputAt = 10_000
    const { instance, emitted, adapter } = makeInstance({ settings: meshSettings, lastOutputAt: outputAt })
    instance.checkMeshWorkerStall(outputAt)
    instance.checkMeshWorkerStall(outputAt + STALL_MS)
    expect(emitted).toHaveLength(1)
    // New output advances lastOutputAt — the episode re-arms.
    const outputAt2 = outputAt + STALL_MS + 30_000
    adapter._lastOutputAt = outputAt2
    instance.checkMeshWorkerStall(outputAt2)
    expect(emitted).toHaveLength(1) // re-arm, no emit yet
    // Under the new threshold — no emit.
    instance.checkMeshWorkerStall(outputAt2 + STALL_MS - 1)
    expect(emitted).toHaveLength(1)
    // New stall crosses the threshold — a second event fires.
    instance.checkMeshWorkerStall(outputAt2 + STALL_MS)
    expect(emitted).toHaveLength(2)
    expect(emitted[1].lastOutputAt).toBe(outputAt2)
  })

  it('anchors a silent spawn (no output yet) on the spawn time', () => {
    const startedAt = 5_000
    // lastOutputAt === 0 → adapter has emitted nothing; anchor must be startedAt.
    const { instance, emitted } = makeInstance({ settings: meshSettings, lastOutputAt: 0, startedAt })
    instance.checkMeshWorkerStall(startedAt + 1_000) // arm
    expect(emitted).toHaveLength(0)
    instance.checkMeshWorkerStall(startedAt + STALL_MS - 1)
    expect(emitted).toHaveLength(0)
    instance.checkMeshWorkerStall(startedAt + STALL_MS)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].meshWorkerStall).toBe(true)
    expect(emitted[0].lastOutputAt).toBe(startedAt)
  })

  it('fires regardless of reported status (status-agnostic)', () => {
    const outputAt = 10_000
    const { instance, emitted } = makeInstance({ settings: meshSettings, lastOutputAt: outputAt, status: 'generating' })
    instance.checkMeshWorkerStall(outputAt)
    instance.checkMeshWorkerStall(outputAt + STALL_MS)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].observedStatus).toBe('generating')
  })

  it('never fires for a non-mesh session', () => {
    const outputAt = 10_000
    const { instance, emitted } = makeInstance({ settings: {}, lastOutputAt: outputAt })
    instance.checkMeshWorkerStall(outputAt)
    instance.checkMeshWorkerStall(outputAt + STALL_MS)
    instance.checkMeshWorkerStall(outputAt + STALL_MS * 2)
    expect(emitted).toHaveLength(0)
  })

  it('does not fire for a dead PTY and re-arms cleanly when it comes back alive', () => {
    const outputAt = 10_000
    const { instance, emitted, adapter } = makeInstance({ settings: meshSettings, lastOutputAt: outputAt, alive: false })
    instance.checkMeshWorkerStall(outputAt)
    instance.checkMeshWorkerStall(outputAt + STALL_MS)
    expect(emitted).toHaveLength(0)
    // Session comes back alive — the first live tick re-arms against current output.
    adapter._alive = true
    instance.checkMeshWorkerStall(outputAt + STALL_MS + 1)
    expect(emitted).toHaveLength(0)
    instance.checkMeshWorkerStall(outputAt + STALL_MS + 1 + STALL_MS)
    expect(emitted).toHaveLength(1)
  })
})
