import { describe, expect, it, vi } from 'vitest'
import { applyAutoApproveModeLaunchArgs } from '../../src/commands/cli-manager.js'
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
