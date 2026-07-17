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
//
// FALSE-STALL-WATCHDOG-OVERFIRE fixes (B/C/E): the threshold is now turn-scoped
// (raised while a turn is in flight), the anchor is force re-armed when a turn
// ends (completion/idle valley no longer false-fires), and a per-session refire
// cooldown throttles repeated stall notifications. A genuine mid-turn wedge still
// fires — late, at the raised turn bound. The turn-active signal is the adapter's
// currentTurnScope / isWaitingForResponse (hasAdapterPendingResponse()).
const STALL_MS = 180_000         // idle threshold (MESH_WORKER_STALL_IDLE_THRESHOLD_MS)
const TURN_STALL_MS = 360_000    // turn-active threshold (MESH_WORKER_STALL_TURN_THRESHOLD_MS)

describe('CliProviderInstance.checkMeshWorkerStall', () => {
  function makeInstance(opts: {
    settings: Record<string, any>
    lastOutputAt: number
    status?: string
    alive?: boolean
    startedAt?: number
    turnActive?: boolean
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
    instance.meshStallTurnActiveLast = undefined
    instance.meshStallLastFiredAt = -1
    const adapter = {
      currentTurnTaskId: undefined as string | undefined,
      _lastOutputAt: opts.lastOutputAt,
      _status: opts.status ?? 'idle',
      _alive: opts.alive ?? true,
      // hasAdapterPendingResponse() reads currentTurnScope for the turn-active edge.
      currentTurnScope: opts.turnActive ? { id: 'turn-1' } : undefined,
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

  it('re-arms on new output so a later stall fires again (once past the refire cooldown)', () => {
    const COOLDOWN_MS = 600_000
    const outputAt = 10_000
    const { instance, emitted, adapter } = makeInstance({ settings: meshSettings, lastOutputAt: outputAt })
    instance.checkMeshWorkerStall(outputAt)
    instance.checkMeshWorkerStall(outputAt + STALL_MS)
    expect(emitted).toHaveLength(1)
    const firstFireAt = outputAt + STALL_MS
    // New output advances lastOutputAt — the episode re-arms. Spaced far enough that
    // the next stall crosses AFTER the refire cooldown, so it is a genuine new
    // notification (not the deduped-churn case covered separately).
    const outputAt2 = firstFireAt + COOLDOWN_MS
    adapter._lastOutputAt = outputAt2
    instance.checkMeshWorkerStall(outputAt2)
    expect(emitted).toHaveLength(1) // re-arm, no emit yet
    // Under the new threshold — no emit.
    instance.checkMeshWorkerStall(outputAt2 + STALL_MS - 1)
    expect(emitted).toHaveLength(1)
    // New stall crosses the threshold, well past the cooldown — a second event fires.
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

  it('does not throw and treats liveness as alive when the adapter has no isAlive() (SpecCliAdapter / antigravity-cli)', () => {
    // Regression: the spec-driven adapter (native-source providers like
    // antigravity-cli) implements CliAdapter but historically exposed no
    // isAlive(). The 5s tick called this.adapter.isAlive() unguarded and threw
    // `this.adapter.isAlive is not a function` on EVERY check, disabling stall
    // detection for those sessions. The call site is now typeof-guarded and a
    // missing method is treated as alive — so the watchdog still arms + fires.
    const outputAt = 10_000
    const { instance, emitted, adapter } = makeInstance({ settings: meshSettings, lastOutputAt: outputAt })
    // Remove isAlive to model the spec-adapter (pre-fix) shape.
    delete (adapter as any).isAlive
    expect(() => instance.checkMeshWorkerStall(outputAt)).not.toThrow()
    expect(emitted).toHaveLength(0)
    instance.checkMeshWorkerStall(outputAt + STALL_MS - 1)
    expect(emitted).toHaveLength(0)
    // Alive-by-default: the stall still fires exactly once at the threshold.
    instance.checkMeshWorkerStall(outputAt + STALL_MS)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].meshWorkerStall).toBe(true)
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

  // ── FALSE-STALL-WATCHDOG-OVERFIRE regression cases ──────────────────────────

  // (1) Fix B: a turn that ends (active → idle) re-arms the anchor to `now`, so the
  // post-completion idle valley does NOT fire against the pre-completion output
  // clock. Before the fix the anchor kept counting from the last mid-turn output
  // and a completed worker false-fired seconds after going idle.
  it('re-arms the anchor when a turn ends so the completed→idle valley does not false-fire', () => {
    const outputAt = 10_000
    const { instance, emitted, adapter } = makeInstance({
      settings: meshSettings, lastOutputAt: outputAt, status: 'generating', turnActive: true,
    })
    // Turn in flight, output produced a while ago. Arm, then sit almost at the idle
    // bound — no emit yet (turn-active bar is higher anyway).
    instance.checkMeshWorkerStall(outputAt + 1_000)
    instance.checkMeshWorkerStall(outputAt + STALL_MS - 1)
    expect(emitted).toHaveLength(0)
    // The turn ENDS: adapter goes idle, currentTurnScope cleared. lastOutputAt has
    // NOT advanced (the last bytes were mid-turn). This tick sees active → inactive
    // and force re-arms the anchor to `now`.
    adapter._status = 'idle'
    adapter.currentTurnScope = undefined
    const idleAt = outputAt + STALL_MS - 1
    instance.checkMeshWorkerStall(idleAt)
    expect(emitted).toHaveLength(0)
    // Just under the idle threshold measured FROM THE RE-ARM — still quiet.
    instance.checkMeshWorkerStall(idleAt + STALL_MS - 1)
    expect(emitted).toHaveLength(0)
    // Past the idle threshold from the re-arm — the fresh idle stall fires.
    instance.checkMeshWorkerStall(idleAt + STALL_MS)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].observedStatus).toBe('idle')
  })

  // (2) Fix C: while a turn is in flight the threshold is raised to 360s — a long
  // normal thinking gap at 180s does NOT fire, but a stall past 360s still does.
  it('applies the raised turn-scoped threshold while a turn is in flight', () => {
    const outputAt = 10_000
    const { instance, emitted } = makeInstance({
      settings: meshSettings, lastOutputAt: outputAt, status: 'generating', turnActive: true,
    })
    instance.checkMeshWorkerStall(outputAt)
    // At the OLD 180s bound — a normal long thinking gap — must NOT fire now.
    instance.checkMeshWorkerStall(outputAt + STALL_MS + 5_000)
    expect(emitted).toHaveLength(0)
    // Just under the raised 360s bound — still quiet.
    instance.checkMeshWorkerStall(outputAt + TURN_STALL_MS - 1)
    expect(emitted).toHaveLength(0)
    // Past 360s — a genuine mid-turn wedge fires (late, but detected).
    instance.checkMeshWorkerStall(outputAt + TURN_STALL_MS)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].observedStatus).toBe('generating')
  })

  // (3) Fix E: repeated stalls for the same session are throttled by the refire
  // cooldown even when new output keeps re-arming the anchor. The stall still fires
  // once, but a second re-armed stall inside the cooldown window is suppressed.
  it('dedupes repeated stalls for the same session within the refire cooldown', () => {
    const outputAt = 10_000
    const { instance, emitted, adapter } = makeInstance({ settings: meshSettings, lastOutputAt: outputAt })
    instance.checkMeshWorkerStall(outputAt)
    instance.checkMeshWorkerStall(outputAt + STALL_MS)
    expect(emitted).toHaveLength(1)
    const firstFireAt = outputAt + STALL_MS
    // A single byte dribbles out shortly after — re-arms the anchor.
    const outputAt2 = firstFireAt + 10_000
    adapter._lastOutputAt = outputAt2
    instance.checkMeshWorkerStall(outputAt2) // re-arm, no emit
    // The re-armed anchor crosses the idle bound again, but this is within the
    // refire cooldown (600s) of the first emission → suppressed.
    const secondCrossAt = outputAt2 + STALL_MS
    expect(secondCrossAt - firstFireAt).toBeLessThan(600_000) // within cooldown
    instance.checkMeshWorkerStall(secondCrossAt)
    expect(emitted).toHaveLength(1) // deduped — still just the one
  })

  // (4) A genuine wedge (turn in flight, output unchanged past the raised 360s bar)
  // is STILL detected. The threshold raise and dedupe only delay/thin the signal —
  // they never fully suppress a real stall.
  it('still fires for a genuine mid-turn wedge past the raised threshold', () => {
    const outputAt = 10_000
    const { instance, emitted } = makeInstance({
      settings: meshSettings, lastOutputAt: outputAt, status: 'generating', turnActive: true,
    })
    instance.checkMeshWorkerStall(outputAt)
    // Wedged mid-turn: no output at all, past the 360s turn bound.
    instance.checkMeshWorkerStall(outputAt + TURN_STALL_MS + 1)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].event).toBe('monitor:no_progress')
    expect(emitted[0].meshWorkerStall).toBe(true)
    expect(emitted[0].observedStatus).toBe('generating')
  })
})
