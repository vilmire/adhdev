import { afterEach, describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// fixB ②③ — settle-gate stabilization for claude-cli auto-approve.
//
// Root cause this guards: during consecutive Bash approvals the modal status
// flaps waiting_approval → generating → waiting_approval (the question line
// scrolls out of the captured frame while the button block + a residual spinner
// remain). Two effects starved the 600ms auto-approve settle gate so it never
// fired and a human had to press Yes:
//   ③ the settle signature folded in the FSM's approvalEntrySeq, which bumps on
//      every fresh waiting_approval entry → every flap minted a new signature →
//      the settle clock restarted. Fix: the settle signature is the modal
//      identity (message + buttons) only; the seq lives in a SEPARATE busy
//      signature used solely by the 5s re-entry guard.
//   ② a momentary generating flip reset the settle clock outright. Fix: a
//      bounded hysteresis keeps the in-progress settle gate warm across a brief
//      flip, only clearing it once the modal has genuinely stayed gone.
//
// These exercise maybeAutoApproveStatus() directly (constructed via
// Object.create to skip the native terminal backend), driving `now` manually so
// the settle math is deterministic. recordAutoApproval() runs synchronously on
// every fire, so a stubbed appendRuntimeSystemMessage is an exact fire counter.

const SETTLE_MS = 600
const HYSTERESIS_MS = 1500

type Harness = {
  instance: any
  fires: Array<{ message?: string; label?: string }>
  resolves: number[]
  call: (status: any, now: number) => void
}

const liveInstances: any[] = []

function makeHarness(): Harness {
  const fires: Array<{ message?: string; label?: string }> = []
  const resolves: number[] = []
  const instance = Object.create(CliProviderInstance.prototype) as any
  instance.type = 'claude-cli'
  instance.provider = { name: 'Claude', settings: {} }
  instance.settings = { autoApprove: true }
  instance.autoApproveBusy = false
  instance.autoApproveBusyTimer = null
  instance.autoApproveSettleTimer = null
  instance.lastAutoApprovalSignature = ''
  instance.pendingAutoApprovalSignature = ''
  instance.pendingAutoApprovalSince = 0
  instance.autoApproveInactiveSince = 0
  instance.adapter = {
    resolveModal: (i: number) => resolves.push(i),
    getStatus: () => ({ status: 'idle' }),
  }
  // recordAutoApproval → appendRuntimeSystemMessage; stub it as the fire sink.
  instance.appendRuntimeSystemMessage = (content: string) => { fires.push({ message: content }) }
  liveInstances.push(instance)
  return {
    instance,
    fires,
    resolves,
    call: (status: any, now: number) => instance.maybeAutoApproveStatus(status, now),
  }
}

afterEach(() => {
  // Clear any armed real timers so a stray settle/hysteresis re-check from one
  // test cannot bleed into the next.
  for (const inst of liveInstances.splice(0)) {
    if (inst.autoApproveSettleTimer) clearTimeout(inst.autoApproveSettleTimer)
    if (inst.autoApproveBusyTimer) clearTimeout(inst.autoApproveBusyTimer)
  }
})

const APPROVAL = (seq: number, message = 'Allow Bash command?', buttons = ['Yes', 'No']) => ({
  status: 'waiting_approval',
  approvalEntrySeq: seq,
  activeModal: { message, buttons },
})
const GENERATING = (seq = 9) => ({ status: 'generating', approvalEntrySeq: seq, activeModal: null })

describe('cli-provider auto-approve settle gate — fixB ③ seq-free settle signature', () => {
  it('does not restart the 600ms settle clock when approvalEntrySeq flaps on the same modal', () => {
    const h = makeHarness()
    // Same modal content re-observed with a bumped entry seq each time (the FSM
    // re-captures the modal on a button re-paint). Pre-fix this restarted the
    // clock every call and never reached SETTLE_MS.
    h.call(APPROVAL(1), 1000) // clock starts at 1000
    expect(h.fires.length).toBe(0)
    expect(h.instance.pendingAutoApprovalSince).toBe(1000)

    h.call(APPROVAL(2), 1400) // +400ms, seq bumped — clock must NOT restart
    expect(h.fires.length).toBe(0)
    expect(h.instance.pendingAutoApprovalSince).toBe(1000)

    h.call(APPROVAL(3), 1700) // +700ms cumulative ≥ 600 → fire
    expect(h.fires.length).toBe(1)
  })

  it('keeps the 5s busy re-entry guard working for distinct back-to-back approvals (seq in busy signature)', async () => {
    const h = makeHarness()
    // First approval settles and fires.
    h.call(APPROVAL(1), 1000)
    h.call(APPROVAL(1), 1700)
    expect(h.fires.length).toBe(1)
    expect(h.instance.autoApproveBusy).toBe(true)

    // Resolved → brief generating, then a SECOND distinct approval with the same
    // message/buttons but a fresh seq, arriving inside the 5s busy window. With
    // the seq retained in the busy signature it is NOT swallowed by the
    // re-entry guard, so it fires on its own settle.
    h.call(GENERATING(1), 1750)
    h.call(APPROVAL(2), 1800) // new settle clock starts (gate was cleared on fire)
    expect(h.fires.length).toBe(1)
    h.call(APPROVAL(2), 2450) // +650ms ≥ 600 → second fire
    expect(h.fires.length).toBe(2)

    // Both fires reach resolveModal (deferred via setTimeout(0)).
    await new Promise((r) => setTimeout(r, 10))
    expect(h.resolves.length).toBe(2)
    expect(h.resolves.every((i) => i === 0)).toBe(true)
  })
})

describe('cli-provider auto-approve settle gate — fixB ② generating-flip hysteresis', () => {
  it('preserves the in-progress settle clock across a brief generating flip', () => {
    const h = makeHarness()
    h.call(APPROVAL(1), 1000)
    expect(h.instance.pendingAutoApprovalSince).toBe(1000)

    // Generating flip 300ms in — within hysteresis, settle clock preserved.
    h.call(GENERATING(2), 1300)
    expect(h.instance.pendingAutoApprovalSince).toBe(1000)
    expect(h.instance.autoApproveInactiveSince).toBe(1300)

    // Modal returns with a bumped seq; the preserved clock means cumulative
    // settle time (now − 1000) decides firing, not a fresh window.
    h.call(APPROVAL(2), 1700) // 700ms since original start ≥ 600 → fire
    expect(h.fires.length).toBe(1)
  })

  it('clears the settle gate once the modal has genuinely stayed gone past the hysteresis bound', () => {
    const h = makeHarness()
    h.call(APPROVAL(1), 1000)
    expect(h.instance.pendingAutoApprovalSince).toBe(1000)

    h.call(GENERATING(2), 1300) // inactive since 1300
    expect(h.instance.pendingAutoApprovalSince).toBe(1000)

    // Still gone past 1300 + 1500 = 2800 → a real resolution, clear the gate so
    // a later modal re-settles from scratch (no stale-timestamp instant fire).
    h.call(GENERATING(2), 3000)
    expect(h.instance.pendingAutoApprovalSince).toBe(0)
    expect(h.instance.autoApproveInactiveSince).toBe(0)
    expect(h.fires.length).toBe(0)
  })

  it('combined: modal → generating → modal flap still reaches a single fire', () => {
    const h = makeHarness()
    h.call(APPROVAL(1), 1000)
    h.call(GENERATING(2), 1200) // flip, preserved
    h.call(APPROVAL(2), 1350) // back, not yet settled (350ms)
    expect(h.fires.length).toBe(0)
    h.call(GENERATING(3), 1450) // flip again, still preserved
    h.call(APPROVAL(3), 1700) // 700ms since start ≥ 600 → fire
    expect(h.fires.length).toBe(1)
  })
})

// Sanity floors so the constants the tests encode match the implementation.
describe('cli-provider auto-approve settle gate — constants', () => {
  it('uses the documented settle + hysteresis windows', () => {
    expect((CliProviderInstance as any).AUTO_APPROVE_SETTLE_MS).toBe(SETTLE_MS)
    expect((CliProviderInstance as any).AUTO_APPROVE_GATE_HYSTERESIS_MS).toBe(HYSTERESIS_MS)
  })
})
