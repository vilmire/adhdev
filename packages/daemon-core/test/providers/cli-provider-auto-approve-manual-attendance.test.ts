import { afterEach, describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import {
  AUTO_APPROVE_MANUAL_ATTENDANCE_SUPPRESS_MS,
  MANUAL_ATTENDANCE_COMMANDS,
  MANUAL_ATTENDANCE_PASSIVE_VIEW_COMMANDS,
  ManualAttendanceTracker,
} from '../../src/providers/manual-attendance.js'

// Defect② — base-node auto-approve must not swallow the controlbar.
//
// Root cause: shouldAutoApprove() is purely settings-based and
// maybeAutoApproveStatus() fires the approve key ~600ms after a modal settles,
// with no awareness of whether a human is actively driving the session. On a
// foreground / base-node session the auto-fire closes the modal before the user
// can pick a button or otherwise use the controlbar.
//
// Fix: a provider-common manual-attendance signal. While a human is attending
// the session by hand (foreground tab select_session/open_panel, controlbar
// invoke_provider_script/set_mode/change_model/set_thought_level, manual
// resolve_action, pty_input) auto-approve HOLDS — the modal stays visible — and
// resumes once the user goes idle. A background mesh worker never receives any
// of those commands, so it is never attended and its delegated auto-approve is
// unaffected.
//
// These exercise maybeAutoApproveStatus() directly via the same Object.create
// harness as cli-provider-auto-approve-settle.test.ts, driving `now` manually.

const SETTLE_MS = 600
const SUPPRESS_MS = AUTO_APPROVE_MANUAL_ATTENDANCE_SUPPRESS_MS

type Harness = {
  instance: any
  fires: Array<{ message?: string }>
  attend: (now: number) => void
  call: (status: any, now: number) => boolean
}

const liveInstances: any[] = []

function makeHarness(autoApprove = true): Harness {
  const fires: Array<{ message?: string }> = []
  const instance = Object.create(CliProviderInstance.prototype) as any
  instance.type = 'claude-cli'
  instance.provider = { name: 'Claude', settings: {} }
  instance.settings = { autoApprove }
  instance.autoApproveBusy = false
  instance.autoApproveBusyTimer = null
  instance.autoApproveSettleTimer = null
  instance.lastAutoApprovalSignature = ''
  instance.pendingAutoApprovalSignature = ''
  instance.pendingAutoApprovalSince = 0
  instance.autoApproveInactiveSince = 0
  // Object.create skips field initializers — wire the tracker by hand.
  instance.manualAttendance = new ManualAttendanceTracker()
  instance.adapter = {
    resolveModal: () => {},
    getStatus: () => ({ status: 'idle' }),
  }
  instance.appendRuntimeSystemMessage = (content: string) => { fires.push({ message: content }) }
  liveInstances.push(instance)
  return {
    instance,
    fires,
    attend: (now: number) => instance.noteManualInteraction(now),
    call: (status: any, now: number) => instance.maybeAutoApproveStatus(status, now),
  }
}

afterEach(() => {
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

describe('cli-provider auto-approve — manual-attendance suppression (defect②)', () => {
  it('does NOT auto-fire while the user is attending, even past the settle window', () => {
    const h = makeHarness()
    h.attend(1000) // user just used the controlbar
    // Modal observed and held stable well past SETTLE_MS — yet no fire, because
    // the human is attending. The modal must stay visible (return false).
    expect(h.call(APPROVAL(1), 1000)).toBe(false)
    expect(h.call(APPROVAL(1), 1000 + SETTLE_MS + 50)).toBe(false)
    expect(h.fires.length).toBe(0)
  })

  it('resumes auto-fire once the attendance window lapses (user went idle)', () => {
    const h = makeHarness()
    h.attend(1000)
    h.call(APPROVAL(1), 1200) // attended → held
    expect(h.fires.length).toBe(0)

    // Past the suppression window: a fresh settle clock starts, then fires.
    const lapsed = 1000 + SUPPRESS_MS + 10
    h.call(APPROVAL(1), lapsed)
    expect(h.fires.length).toBe(0) // settle clock restarts here
    h.call(APPROVAL(1), lapsed + SETTLE_MS + 20)
    expect(h.fires.length).toBe(1)
  })

  it('fires normally for an unattended (background worker) session — regression guard', () => {
    const h = makeHarness()
    // Never attended: behaves exactly as before — settles and fires.
    h.call(APPROVAL(1), 1000)
    h.call(APPROVAL(1), 1700) // ≥ 600ms settled → fire
    expect(h.fires.length).toBe(1)
  })

  it('a renewed interaction re-arms the hold across modals', () => {
    const h = makeHarness()
    h.attend(1000)
    h.call(APPROVAL(1), 1500) // held
    h.attend(1500) // user interacts again — window re-armed to 1500
    h.call(APPROVAL(1), 1000 + SUPPRESS_MS + 10) // would have lapsed off the first stamp, but re-armed
    expect(h.fires.length).toBe(0)
  })

  it('autoApproveEffectivelyActive reflects attendance', () => {
    const h = makeHarness()
    expect(h.instance.autoApproveEffectivelyActive('waiting_approval', 1000)).toBe(true)
    h.attend(1000)
    expect(h.instance.autoApproveEffectivelyActive('waiting_approval', 1200)).toBe(false)
    expect(h.instance.autoApproveEffectivelyActive('waiting_approval', 1000 + SUPPRESS_MS + 10)).toBe(true)
  })

  it('attendance is irrelevant when autoApprove is off', () => {
    const h = makeHarness(false)
    expect(h.instance.autoApproveEffectivelyActive('waiting_approval', 1000)).toBe(false)
    h.attend(1000)
    expect(h.instance.autoApproveEffectivelyActive('waiting_approval', 1200)).toBe(false)
  })
})

describe('manual-attendance command set — provider-common signal', () => {
  it('counts foreground + controlbar + manual-approval + terminal commands', () => {
    for (const cmd of [
      'select_session', 'open_panel', 'invoke_provider_script',
      'set_mode', 'change_model', 'set_thought_level', 'resolve_action', 'pty_input',
    ]) {
      expect(MANUAL_ATTENDANCE_COMMANDS.has(cmd)).toBe(true)
    }
  })

  it('does NOT count send_chat (coordinator task delegation) or passive reads', () => {
    for (const cmd of ['send_chat', 'read_chat', 'list_chats', 'new_chat', 'switch_chat']) {
      expect(MANUAL_ATTENDANCE_COMMANDS.has(cmd)).toBe(false)
    }
  })

  it('classifies select_session / open_panel as PASSIVE view-only', () => {
    expect(MANUAL_ATTENDANCE_PASSIVE_VIEW_COMMANDS.has('select_session')).toBe(true)
    expect(MANUAL_ATTENDANCE_PASSIVE_VIEW_COMMANDS.has('open_panel')).toBe(true)
    // Passive set is a strict subset of the full attendance set.
    for (const cmd of MANUAL_ATTENDANCE_PASSIVE_VIEW_COMMANDS) {
      expect(MANUAL_ATTENDANCE_COMMANDS.has(cmd)).toBe(true)
    }
    // Explicit-input commands are NOT passive.
    for (const cmd of ['invoke_provider_script', 'set_mode', 'resolve_action', 'pty_input']) {
      expect(MANUAL_ATTENDANCE_PASSIVE_VIEW_COMMANDS.has(cmd)).toBe(false)
    }
  })
})

describe('passive-view exclusion for delegated workers (defect② secondary, #137)', () => {
  it('a delegated worker ignores a passive view (select_session / open_panel)', () => {
    const h = makeHarness()
    h.instance.settings.meshNodeFor = 'mesh-1' // → isMeshWorkerSession() true
    // Passive peek at the worker's panel must NOT attend → auto-approve unheld.
    h.instance.noteManualInteraction(1000, { passive: true })
    expect(h.instance.manualAttendance.isAttended(1100)).toBe(false)
    // Delegated auto-approve therefore still fires normally.
    h.call(APPROVAL(1), 1200)
    h.call(APPROVAL(1), 1200 + SETTLE_MS + 20)
    expect(h.fires.length).toBe(1)
  })

  it('a delegated worker STILL attends on explicit input (passive:false)', () => {
    const h = makeHarness()
    h.instance.settings.meshNodeFor = 'mesh-1'
    h.instance.noteManualInteraction(1000, { passive: false }) // e.g. pty_input / resolve_action
    expect(h.instance.manualAttendance.isAttended(1100)).toBe(true)
    // ...so a human taking over the worker holds auto-approve.
    expect(h.call(APPROVAL(1), 1200)).toBe(false)
    expect(h.fires.length).toBe(0)
  })

  it('a FOREGROUND session still attends on a passive view (unchanged behavior)', () => {
    const h = makeHarness() // no mesh settings → isMeshWorkerSession() false
    h.instance.noteManualInteraction(1000, { passive: true })
    expect(h.instance.manualAttendance.isAttended(1100)).toBe(true)
    expect(h.call(APPROVAL(1), 1200)).toBe(false)
    expect(h.fires.length).toBe(0)
  })
})

describe('ManualAttendanceTracker', () => {
  it('is attended only within the suppression window', () => {
    const t = new ManualAttendanceTracker(1000)
    expect(t.isAttended(0)).toBe(false) // never noted
    t.note(5000)
    expect(t.isAttended(5500)).toBe(true)
    expect(t.isAttended(5999)).toBe(true)
    expect(t.isAttended(6000)).toBe(false) // exactly at window edge → expired
    expect(t.remainingMs(5400)).toBe(600)
    expect(t.remainingMs(6000)).toBe(0)
  })
})
