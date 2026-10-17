/**
 * Worker permission policy — auto-approve ON answers tool-permission prompts
 * with the least-privilege ONE-TIME option only, never a persistent grant;
 * directory-trust prompts for a different directory are never answered; each
 * answer leaves a local audit log line and nothing else.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import { ManualAttendanceTracker } from '../../src/providers/manual-attendance.js'
import {
  isPersistentApprovalGrantLabel,
  modalAllowsAutoApproval,
  pickAutoApprovalButton,
  pickLeastPrivilegeApprovalButton,
} from '../../src/providers/approval-utils.js'
import { selectAutoApprovalButton } from '../../src/providers/completion/approval-gate.js'
import { formatAutoApprovalLogLine } from '../../src/providers/cli-provider-modal-park.js'

const SETTLE_MS = 600
const live: any[] = []

function harness(settings: Record<string, unknown> = { autoApprove: true }) {
  const fires: string[] = []
  const resolves: number[] = []
  const events: any[] = []
  const logs: string[] = []
  const instance = Object.create(CliProviderInstance.prototype) as any
  instance.type = 'claude-cli'
  instance.instanceId = 'sess-1'
  instance.workingDir = '/work/wt'
  instance.provider = { name: 'Claude', settings: {} }
  instance.settings = settings
  instance.autoApproveBusy = false
  instance.autoApproveBusyTimer = null
  instance.autoApproveSettleTimer = null
  instance.lastAutoApprovalSignature = ''
  instance.pendingAutoApprovalSignature = ''
  instance.pendingAutoApprovalSince = 0
  instance.autoApproveInactiveSince = 0
  instance.autoApproveMaskSince = 0
  instance.stalledApprovalNudgeEpisode = 0
  instance.autoApproveLastModalSeenAt = 0
  instance.lastAutoApproveFiredAt = 0
  instance.manualAttendance = new ManualAttendanceTracker()
  instance.adapter = { resolveModal: (i: number) => resolves.push(i), getStatus: () => ({ status: 'idle' }) }
  instance.appendRuntimeSystemMessage = (content: string) => { fires.push(content) }
  instance.pushEvent = (e: any) => { events.push(e) }
  instance.logAutoApproval = (message: unknown, label: string, buttons: string[]) => { logs.push(formatAutoApprovalLogLine(instance, message, label, buttons)) }
  live.push(instance)
  const run = async (status: any) => {
    instance.maybeAutoApproveStatus(status, 1_000)
    instance.maybeAutoApproveStatus(status, 1_000 + SETTLE_MS + 10)
    await new Promise((r) => setTimeout(r, 0))
  }
  return { instance, fires, resolves, events, logs, run }
}

afterEach(() => {
  for (const inst of live.splice(0)) {
    if (inst.autoApproveSettleTimer) clearTimeout(inst.autoApproveSettleTimer)
    if (inst.autoApproveBusyTimer) clearTimeout(inst.autoApproveBusyTimer)
  }
})

const approval = (buttons: string[], providerApproval?: Record<string, unknown>, message = 'Allow Bash command?\n$ npm test') => ({
  status: 'waiting_approval',
  approvalEntrySeq: 1,
  activeModal: { message, buttons, kind: 'approval' },
  ...(providerApproval ? { providerApproval } : {}),
})

describe('persistent grant classification', () => {
  it.each([
    'Always allow',
    '2. Yes, allow all edits in tmp/ during this session (shift+tab)',
    "2. Yes, and don't ask again for: codex --version",
    'Approve for this session',
    'Yes, allow reading from etc/ from this project',
    'Add Shell(git status) to allowlist?',
    'Run Everything',
    'Allow always',
    'Yes, I trust this folder',
  ])('%s is persistent', (label) => {
    expect(isPersistentApprovalGrantLabel(label)).toBe(true)
  })

  it.each(['1. Yes', 'Allow once', 'Run (once)', 'Yes, proceed', 'Approve once', 'Accept', 'No'])('%s is one-time', (label) => {
    expect(isPersistentApprovalGrantLabel(label)).toBe(false)
  })
})

describe('pickLeastPrivilegeApprovalButton', () => {
  it('picks the one-time option even when a provider hint ranks the persistent grant first', () => {
    // grok-style order: the standing grant is button 1.
    expect(pickLeastPrivilegeApprovalButton(['Yes, always allow this tool', 'Yes, proceed', 'No'], { approvalPositiveHints: ['always allow', 'yes'] } as any))
      .toEqual({ index: 1, label: 'Yes, proceed' })
  })

  it('maps the pick back to the original index across skipped persistent options', () => {
    expect(pickLeastPrivilegeApprovalButton(['Add Shell(git status) to allowlist?', 'Run Everything', 'Run (once)', 'Skip']))
      .toEqual({ index: 2, label: 'Run (once)' })
  })

  it('refuses when only persistent grants and declines are offered', () => {
    expect(pickLeastPrivilegeApprovalButton(['Always allow', 'Approve for this session', 'Deny'])).toEqual({ index: -1, label: '' })
  })
})

describe('IDE/extension auto-approval pick', () => {
  it('leaves any modal that offers a standing grant for the person (IDE clicks match fuzzily)', () => {
    expect(pickAutoApprovalButton(['Always allow', 'Allow once', 'Deny'])).toEqual({ index: -1, label: '' })
    expect(pickAutoApprovalButton(['Allow once', 'Deny'])).toEqual({ index: 0, label: 'Allow once' })
  })
  it('refuses persistent-only modals but keeps the script default for button-less ones', () => {
    expect(modalAllowsAutoApproval({ buttons: ['Always allow', 'Allow for this session'] })).toBe(false)
    expect(modalAllowsAutoApproval({ buttons: [] })).toBe(true)
    expect(modalAllowsAutoApproval({ buttons: ['Accept', 'Reject'] })).toBe(true)
  })
})

describe('selectAutoApprovalButton (CLI gate policy)', () => {
  const host = { provider: { name: 'X' } as any }
  it('refuses a setup/trust prompt whose displayed directory is not the runtime worktree', () => {
    expect(selectAutoApprovalButton(host, ['Yes, proceed', 'No, quit'], {
      type: 'provider_setup', runtimeDirectory: '/repo-wt/feature', displayedDirectory: '/repo',
    })).toBeNull()
  })
  it('keeps the established pick for a setup prompt about the runtime worktree itself', () => {
    expect(selectAutoApprovalButton(host, ['Yes, I trust this folder', 'No, exit'], {
      type: 'provider_setup', runtimeDirectory: '/repo-wt/feature/', displayedDirectory: '/repo-wt/feature',
    })).toEqual({ index: 0, label: 'Yes, I trust this folder' })
    expect(selectAutoApprovalButton(host, ['Yes, I trust this folder', 'No, exit'], {
      type: 'provider_setup', runtimeDirectory: '/repo-wt/feature', displayedDirectory: null,
    })).toEqual({ index: 0, label: 'Yes, I trust this folder' })
  })
  it('applies the one-time rule to tool permissions', () => {
    expect(selectAutoApprovalButton(host, ['Yes', "Yes, and don't ask again", 'No'], { type: 'tool_permission' }))
      .toEqual({ index: 0, label: 'Yes' })
    expect(selectAutoApprovalButton(host, ['Always allow', 'Deny'], { type: 'tool_permission' })).toBeNull()
  })
})

describe('maybeAutoApproveStatus — least privilege end to end', () => {
  it('presses the one-time option and logs asked text / button / session / task without notifying anyone', async () => {
    const h = harness({ autoApprove: true, meshActiveTaskId: 'task-7', meshNodeFor: 'mesh-1' })
    await h.run(approval(['Yes, always allow Bash(npm test)', 'Yes', 'No'], { type: 'tool_permission', modalKey: 'modal:a' }))
    expect(h.resolves).toEqual([1])
    expect(h.events).toEqual([])
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toContain('session=sess-1')
    expect(h.logs[0]).toContain('task=task-7')
    expect(h.logs[0]).toContain('button="Yes"')
    expect(h.logs[0]).toContain('asked="Allow Bash command? $ npm test"')
  })

  it('never presses a persistent grant when no one-time option exists', async () => {
    const h = harness()
    await h.run(approval(['Always allow', 'Approve for this session', 'Deny'], { type: 'tool_permission', modalKey: 'modal:b' }))
    expect(h.resolves).toEqual([])
    expect(h.fires).toEqual([])
    expect(h.logs).toEqual([])
  })

  it('unmasks a persistent-only prompt for the owner\'s own session; a mesh worker stays masked for its coordinator nudge', () => {
    const persistentOnly = approval(['Always allow', 'Approve for this session', 'Deny'], { type: 'tool_permission', modalKey: 'modal:c' })
    const own = harness()
    own.instance.isMeshWorkerSession = () => false
    expect(own.instance.maybeAutoApproveStatus(persistentOnly, 1_000)).toBe(false)
    const worker = harness()
    worker.instance.isMeshWorkerSession = () => true
    expect(worker.instance.maybeAutoApproveStatus(persistentOnly, 1_000)).toBe(true)
    expect(own.resolves).toEqual([])
    expect(worker.resolves).toEqual([])
  })

  it('does not answer a directory-trust prompt for a different directory', async () => {
    const h = harness()
    await h.run(approval(['Yes, proceed', 'No, quit'], {
      type: 'provider_setup', modalKey: 'modal:c', runtimeDirectory: '/repo-wt/x', displayedDirectory: '/repo',
    }, 'Do you trust the contents of this directory?'))
    expect(h.resolves).toEqual([])
  })

  it('formats the audit line without a mesh task as "-"', () => {
    const h = harness({ autoApprove: true })
    expect(formatAutoApprovalLogLine(h.instance, 'q', 'Yes', ['Yes', 'No'])).toMatch(/^\[claude-cli\] auto-approved \(one-time\) session=sess-1 mesh=- task=- /)
  })
})
