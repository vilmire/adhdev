import { describe, expect, it } from 'vitest'
import { localGeneratingLabelIsContradicted } from '../../src/mesh/mesh-reconcile-stranded-dispatch.js'

// CANCEL-BLIP-ORPHAN, coordinator net.
//
// The early transcript-evidence rescue (evaluateEarlyIdleTranscriptArm) exists to complete a
// row whose worker finished but whose generating_completed never arrived. Its FIRST gate is
// (a) positive idle evidence — and a LOCAL 'GENERATING' verdict short-circuited it outright.
//
// That is exactly the state the orphaned-completion defect leaves behind: the completion arm
// was deleted by a continuity cancel, so the provider FSM label stays 'generating' with
// nothing left to clear it. The rescue refused to even ACCRUE its streak, and the row sat
// 'assigned' until the 15/90-min hard deadline — matching the observed live stall (worker
// finished ~10min in, coordinator queue read 'generating' for ~24min).
//
// resolveSessionBusyVerdict reads the FSM STATUS LABEL. hasLiveTurnPendingEvidence() is
// computed from the ADAPTER's own turn state and is entirely independent of that label. A
// session whose label says 'generating' while its adapter reports no live turn is, by
// construction, stale — that positive contradiction (never a mere absence of evidence) is
// what re-opens the gate.
//
// Clearing the gate only lets the STREAK BEGIN. The caller still requires 8s of continuity,
// turn-start evidence, and the decisive pollAssignedTaskTerminalEvidence before anything is
// completed — so this changes WHICH rows may be examined, never the bar for completing one.

function componentsWith(probe: (() => boolean) | 'absent' | 'throws') {
  return {
    instanceManager: {
      getInstance: (_sessionId: string) => {
        if (probe === 'absent') return {}                       // older/remote instance surface
        if (probe === 'throws') return { hasLiveTurnPendingEvidence: () => { throw new Error('boom') } }
        return { hasLiveTurnPendingEvidence: probe }
      },
    },
  } as any
}

describe('CANCEL-BLIP-ORPHAN — stale local generating label is recoverable', () => {
  it('reports a contradiction when the FSM says generating but the adapter has NO live turn', () => {
    // The defect state: label wedged at 'generating', adapter knows the turn is over.
    expect(localGeneratingLabelIsContradicted(componentsWith(() => false), 'sess-wedged')).toBe(true)
  })

  // ★The false-positive guard. A genuinely mid-turn worker must never be re-opened for
  // early completion — that would race a live turn, the very thing the gate protects.
  it('reports NO contradiction while the adapter still has live turn evidence', () => {
    expect(localGeneratingLabelIsContradicted(componentsWith(() => true), 'sess-working')).toBe(false)
  })

  it('reports NO contradiction when the probe is unavailable (remote / older surface)', () => {
    // An unresolvable probe is not evidence of anything — the gate stays as it was.
    expect(localGeneratingLabelIsContradicted(componentsWith('absent'), 'sess-remote')).toBe(false)
  })

  it('reports NO contradiction when the probe throws (failed observation is never idle)', () => {
    expect(localGeneratingLabelIsContradicted(componentsWith('throws'), 'sess-broken')).toBe(false)
  })

  it('reports NO contradiction when there is no instance manager at all', () => {
    expect(localGeneratingLabelIsContradicted({} as any, 'sess-none')).toBe(false)
  })
})

describe('CANCEL-BLIP-ORPHAN — the arm gate consults the contradiction', () => {
  it('gates the early-idle arm on the contradiction rather than returning false outright', async () => {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const src = readFileSync(
      join(import.meta.dirname, '../../src/mesh/mesh-reconcile-stranded-dispatch.ts'),
      'utf-8',
    )
    const start = src.indexOf('async function evaluateEarlyIdleTranscriptArm')
    expect(start, 'arm gate not found').toBeGreaterThan(-1)
    const gate = src.slice(start, src.indexOf('\n}', start))
    // Without this the local GENERATING verdict short-circuits the rescue unconditionally and
    // a wedged label can never be recovered before the hard deadline.
    expect(gate).toContain('localGeneratingLabelIsContradicted(')
    expect(gate).toMatch(/verdict === 'GENERATING'\s*&&\s*!localGeneratingLabelIsContradicted\(/)
  })
})
