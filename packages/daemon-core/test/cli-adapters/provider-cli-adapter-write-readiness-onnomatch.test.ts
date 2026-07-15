import { describe, expect, it, vi } from 'vitest'
import { ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js'

// Regression: opencode (and any CLI whose only idle cue is a settled-prompt
// placeholder with dispatchOrder.onNoMatch = 'preserve-last') could reach the
// engine-reported 'idle' (script_detect, via parseSession's `detectStatus() ??
// 'idle'`) yet keep the PTY write gate shut, because the write-readiness gates
// (resolveStartupState / sendMessage recovery) called runDetectStatus directly
// and required the *literal* 'idle'. When the placeholder was momentarily out
// of the last-8-lines scope the raw detector returned null → this.ready never
// flipped → the first prompt sat in `not_ready_pending_prompt` forever.
//
// detectIdleHonoringOnNoMatch closes that split-brain: it honors the manifest
// onNoMatch policy and, for idle-preserving policies, treats a durably
// engine-settled-idle session as write-ready.

type BuildOpts = {
  type?: string
  onNoMatch?: 'preserve-last' | 'idle' | 'unknown'
  detectStatus?: () => string | null
  engineStatus?: string
  isWaitingForResponse?: boolean
  currentTurnScope?: unknown
  activeModal?: unknown
}

function buildAdapter(opts: BuildOpts = {}) {
  const detectStatus = opts.detectStatus ?? (() => null)
  const provider: any = {
    type: opts.type ?? 'opencode',
    name: 'Opencode',
    category: 'cli',
    binary: 'opencode',
    spawn: { command: 'opencode', args: [], shell: false, env: {} },
    scripts: {
      detectStatus,
      parseOutput: () => ({ status: detectStatus() ?? 'idle', messages: [] }),
      parseApproval: () => null,
    },
  }
  if (opts.onNoMatch) {
    provider.tui = { dispatchOrder: { order: ['modal', 'spinner', 'settled-prompt'], onNoMatch: opts.onNoMatch } }
  }

  const adapter = new ProviderCliAdapter(provider, '/tmp/project') as any
  adapter.terminalScreen = { write: vi.fn(), getText: () => '' }
  adapter.scheduleSettle = vi.fn()

  // Drive engine into the requested settled shape.
  adapter.engine.currentStatus = opts.engineStatus ?? 'idle'
  adapter.engine.isWaitingForResponse = opts.isWaitingForResponse ?? false
  adapter.engine.currentTurnScope = opts.currentTurnScope ?? null
  adapter.engine.activeModal = opts.activeModal ?? null
  return adapter
}

describe('write-readiness onNoMatch unification', () => {
  it('detectIdleHonoringOnNoMatch: falls back to engine-settled idle when raw detector returns null (preserve-last)', () => {
    const adapter = buildAdapter({ onNoMatch: 'preserve-last', detectStatus: () => null })
    expect(adapter.runDetectStatus('anything')).toBeNull()
    expect(adapter.detectIdleHonoringOnNoMatch('anything')).toBe(true)
  })

  it('detectIdleHonoringOnNoMatch: still true via the literal raw detector (no policy needed)', () => {
    const adapter = buildAdapter({ onNoMatch: 'preserve-last', detectStatus: () => 'idle' })
    expect(adapter.detectIdleHonoringOnNoMatch('anything')).toBe(true)
  })

  it('detectIdleHonoringOnNoMatch: does NOT fall back for default (no) onNoMatch policy', () => {
    const adapter = buildAdapter({ onNoMatch: undefined, detectStatus: () => null })
    expect(adapter.detectIdleHonoringOnNoMatch('anything')).toBe(false)
  })

  it('detectIdleHonoringOnNoMatch: does NOT fall back for onNoMatch=unknown', () => {
    const adapter = buildAdapter({ onNoMatch: 'unknown', detectStatus: () => null })
    expect(adapter.detectIdleHonoringOnNoMatch('anything')).toBe(false)
  })

  it('detectIdleHonoringOnNoMatch: fallback is gated — never opens mid-turn', () => {
    const adapter = buildAdapter({
      onNoMatch: 'preserve-last',
      detectStatus: () => null,
      isWaitingForResponse: true,
      currentTurnScope: { prompt: 'x', startedAt: Date.now(), bufferStart: 0, rawBufferStart: 0 },
    })
    expect(adapter.detectIdleHonoringOnNoMatch('anything')).toBe(false)
  })

  it('detectIdleHonoringOnNoMatch: fallback is gated — never opens while a modal is up', () => {
    const adapter = buildAdapter({
      onNoMatch: 'preserve-last',
      detectStatus: () => null,
      activeModal: { message: 'Run this command?', buttons: ['Yes', 'No'] },
    })
    expect(adapter.detectIdleHonoringOnNoMatch('anything')).toBe(false)
  })

  it('resolveStartupState: opens the write gate for a settled-idle opencode-like session even when the raw detector returns null', () => {
    const adapter = buildAdapter({ onNoMatch: 'preserve-last', detectStatus: () => null })
    // Simulate a fresh spawn that has produced output and gone screen-stable.
    adapter.startupParseGate = true
    adapter.startupFirstOutputAt = Date.now() - 5000
    adapter.lastScreenChangeAt = Date.now() - 3000 // stableMs > 2000
    adapter.schedulePendingOutboundFlush = vi.fn()

    expect(adapter.ready).toBe(false)
    adapter.resolveStartupState('test')

    expect(adapter.ready).toBe(true)
    expect(adapter.startupParseGate).toBe(false)
    expect(adapter.engine.currentStatus).toBe('idle')
    // Barrier flush must fire so any not_ready_pending_prompt queue drains.
    expect(adapter.schedulePendingOutboundFlush).toHaveBeenCalled()
  })

  it('resolveStartupState: keeps the gate shut (default policy) — no regression for non-preserve-last providers whose raw detector returns null', () => {
    const adapter = buildAdapter({ type: 'claude-cli', onNoMatch: undefined, detectStatus: () => null })
    adapter.startupParseGate = true
    adapter.startupFirstOutputAt = Date.now() - 5000
    adapter.lastScreenChangeAt = Date.now() - 3000
    adapter.schedulePendingOutboundFlush = vi.fn()

    adapter.resolveStartupState('test')

    expect(adapter.ready).toBe(false)
    expect(adapter.startupParseGate).toBe(true)
  })
})
