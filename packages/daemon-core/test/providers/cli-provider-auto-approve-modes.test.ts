import { describe, expect, it, vi } from 'vitest'
import { applyAutoApproveModeLaunchArgs } from '../../src/commands/cli-session-binding.js'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'
import type { ProviderModule } from '../../src/providers/contracts.js'
import { withMinimalSpec } from '../helpers/minimal-spec.js';

const mockProvider: ProviderModule = {
  type: 'mock-modes-cli',
  name: 'Mock Modes CLI',
  category: 'cli',
  spawn: { command: 'mock-modes', args: ['--permission-mode=ask', '--base'] },
  autoApproveModes: {
    default: 'parsed',
    modes: [
      { id: 'parsed', label: 'Parsed approvals', strategy: 'pty-parse-default', risk: 'safe' },
      {
        id: 'launch',
        label: 'Launch approval bypass',
        strategy: 'launch-args',
        risk: 'caution',
        launchArgs: ['--trust-session'],
        removeArgs: ['--permission-mode'],
      },
      {
        id: 'auto',
        label: 'Auto with PTY fallback',
        strategy: 'launch-args',
        risk: 'caution',
        ptyFallback: true,
        launchArgs: ['--permission-mode', 'auto'],
      },
    ],
  },
}

function instanceWith(settings: Record<string, unknown>, provider: ProviderModule = mockProvider): any {
  const instance = new CliProviderInstance(withMinimalSpec(provider as any) as any, '/tmp/mock-modes') as any
  instance.settings = settings
  return instance
}

describe('CliProviderInstance.resolveAutoApproveMode', () => {
  it('keeps legacy boolean behavior for providers without mode metadata', () => {
    const legacyProvider = { ...mockProvider, autoApproveModes: undefined }
    expect(instanceWith({ autoApprove: true }, legacyProvider).resolveAutoApproveMode()).toEqual({
      active: true,
      strategy: 'pty-parse-default',
      modeId: 'legacy',
    })
    expect(instanceWith({ autoApprove: false }, legacyProvider).resolveAutoApproveMode().active).toBe(false)
  })

  it('gives autoApproveMode precedence over the legacy boolean and returns each strategy', () => {
    expect(instanceWith({ autoApprove: false, autoApproveMode: 'parsed' }).resolveAutoApproveMode()).toEqual({
      active: true,
      strategy: 'pty-parse-default',
      modeId: 'parsed',
    })
    expect(instanceWith({ autoApprove: false, autoApproveMode: 'launch' }).resolveAutoApproveMode()).toEqual({
      active: true,
      strategy: 'launch-args',
      modeId: 'launch',
    })
    expect(instanceWith({ autoApprove: true, autoApproveMode: 'stale' }).resolveAutoApproveMode().active).toBe(false)
  })

  it('rechecks dangerous delegated modes against the local provider spec', () => {
    const provider = {
      ...mockProvider,
      autoApproveModes: {
        default: 'danger',
        modes: [
          ...mockProvider.autoApproveModes!.modes,
          {
            id: 'danger',
            label: 'Dangerous bypass',
            strategy: 'launch-args' as const,
            risk: 'dangerous' as const,
            warning: 'Approval checks are bypassed.',
            launchArgs: ['--dangerously-skip-permissions'],
          },
        ],
      },
    }
    expect(instanceWith({
      autoApprove: true,
      launchedByCoordinator: true,
      delegatedWorkerDangerousModeAllow: false,
    }, provider).resolveAutoApproveMode()).toEqual({
      active: true,
      strategy: 'pty-parse-default',
      modeId: 'parsed',
    })
    expect(instanceWith({
      autoApproveMode: 'danger',
      launchedByCoordinator: true,
      delegatedWorkerDangerousModeAllow: true,
    }, provider).resolveAutoApproveMode().modeId).toBe('danger')
  })

  it('makes every PTY auto-approve path a no-op for launch-args mode', () => {
    const instance = instanceWith({ autoApproveMode: 'launch' })
    instance.autoApproveMaskSince = 123
    instance.pendingAutoApprovalSince = 123
    instance.adapter.resolveModal = vi.fn()

    const active = instance.maybeAutoApproveStatus({
      status: 'waiting_approval',
      activeModal: { message: 'Approve?', buttons: ['Yes', 'No'] },
    }, 1_000)

    expect(active).toBe(false)
    expect(instance.autoApproveMaskSince).toBe(0)
    expect(instance.pendingAutoApprovalSince).toBe(0)
    expect(instance.adapter.resolveModal).not.toHaveBeenCalled()
    expect(instance.autoApproveEffectivelyActive('waiting_approval', 1_000)).toBe(false)
  })
})

describe('ptyFallback on launch-args modes', () => {
  it('keeps resolving ptyFallback onto the resolved mode only when the flag is set', () => {
    expect(instanceWith({ autoApproveMode: 'auto' }).resolveAutoApproveMode()).toEqual({
      active: true,
      strategy: 'launch-args',
      modeId: 'auto',
      ptyFallback: true,
    })
    expect(instanceWith({ autoApproveMode: 'launch' }).resolveAutoApproveMode().ptyFallback).toBeUndefined()
  })

  it('answers PTY prompts for a launch-args mode with ptyFallback, but not without it', () => {
    expect(instanceWith({ autoApproveMode: 'auto' }).shouldUsePtyAutoApprove()).toBe(true)
    expect(instanceWith({ autoApproveMode: 'launch' }).shouldUsePtyAutoApprove()).toBe(false)
    expect(instanceWith({ autoApproveMode: 'parsed' }).shouldUsePtyAutoApprove()).toBe(true)
    expect(instanceWith({ autoApprove: false }).shouldUsePtyAutoApprove()).toBe(false)
    expect(instanceWith({ autoApproveMode: 'stale' }).shouldUsePtyAutoApprove()).toBe(false)
  })

  it('presses the one-time Yes on a 2-button approval under the auto mode', async () => {
    const instance = instanceWith({ autoApproveMode: 'auto' })
    instance.adapter.resolveModalMatched = vi.fn(() => true)
    instance.appendRuntimeSystemMessage = vi.fn()
    const status = {
      status: 'waiting_approval',
      approvalEntrySeq: 1,
      activeModal: {
        message: 'Reads outside the working directories are blocked. Allow this read?',
        buttons: ['Yes', 'No'],
      },
    }
    instance.maybeAutoApproveStatus(status, 1_000)
    expect(instance.adapter.resolveModalMatched).not.toHaveBeenCalled()
    expect(instance.maybeAutoApproveStatus(status, 1_700)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(instance.adapter.resolveModalMatched).toHaveBeenCalledTimes(1)
    expect(instance.adapter.resolveModalMatched).toHaveBeenCalledWith(0)
  })

  it('refuses a "don\'t ask again" option under the auto mode', async () => {
    const instance = instanceWith({ autoApproveMode: 'auto' })
    instance.adapter.resolveModalMatched = vi.fn(() => true)
    instance.appendRuntimeSystemMessage = vi.fn()
    const status = {
      status: 'waiting_approval',
      approvalEntrySeq: 1,
      activeModal: { message: 'Allow command?', buttons: ["Yes, and don't ask again", 'Yes', 'No'] },
    }
    instance.maybeAutoApproveStatus(status, 1_000)
    instance.maybeAutoApproveStatus(status, 1_700)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(instance.adapter.resolveModalMatched).not.toHaveBeenCalledWith(0)
  })
})

describe('applyAutoApproveModeLaunchArgs', () => {
  it('removes conflicting base args and injects the selected mode launch args', () => {
    const result = applyAutoApproveModeLaunchArgs(mockProvider, ['--resume', 'session-1'], {
      autoApproveMode: 'launch',
    })

    expect(result.provider?.spawn?.args).toEqual(['--base'])
    expect(result.cliArgs).toEqual(['--trust-session', '--resume', 'session-1'])
    expect(mockProvider.spawn?.args).toEqual(['--permission-mode=ask', '--base'])
  })
})
