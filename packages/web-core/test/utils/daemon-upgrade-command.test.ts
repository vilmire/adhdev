import { describe, expect, it, vi } from 'vitest'
import type { DaemonData } from '../../src/types'
import {
  DAEMON_UPGRADE_POLICY_UNAVAILABLE_MESSAGE,
  runDaemonUpgradeCommand,
} from '../../src/utils/daemon-upgrade-command'

describe('runDaemonUpgradeCommand', () => {
  it('does not send the command and surfaces an actionable error when the node policy is unavailable', async () => {
    const sendDaemonCommand = vi.fn()
    const machine: DaemonData = {
      id: 'machine-1',
      type: 'adhdev-daemon',
      status: 'online',
      version: '1.0.28-rc.18',
    }

    const result = await runDaemonUpgradeCommand(sendDaemonCommand, 'machine-1', machine)

    expect(sendDaemonCommand).not.toHaveBeenCalled()
    expect(result).toEqual({ state: 'error', message: DAEMON_UPGRADE_POLICY_UNAVAILABLE_MESSAGE })
  })

  it('does not send the command when the machine entry is missing entirely', async () => {
    const sendDaemonCommand = vi.fn()

    const result = await runDaemonUpgradeCommand(sendDaemonCommand, 'machine-1', undefined)

    expect(sendDaemonCommand).not.toHaveBeenCalled()
    expect(result.state).toBe('error')
  })

  it('sends the upgrade — with no channel hint — when the policy resolves a channel', async () => {
    const sendDaemonCommand = vi.fn().mockResolvedValue({ result: { upgraded: true, version: '1.0.28-rc.20' } })
    const machine: DaemonData = {
      id: 'machine-1',
      type: 'adhdev-daemon',
      status: 'online',
      version: '1.0.28-rc.18',
      updateChannel: 'preview',
      updatePolicy: { channel: 'preview', npmTag: 'next', targetVersion: '1.0.28-rc.20' },
    }

    const result = await runDaemonUpgradeCommand(sendDaemonCommand, 'machine-1', machine)

    // A resolvable channel gates whether we send at all; the payload itself is
    // empty because the daemon upgrades along its own build track and discards
    // any channel hint (see buildDaemonUpgradePayload).
    expect(sendDaemonCommand).toHaveBeenCalledWith('machine-1', 'daemon_upgrade', {})
    expect(result.state).toBe('done')
  })

  it('surfaces daemon-side failures as errors', async () => {
    const sendDaemonCommand = vi.fn().mockResolvedValue({ result: { error: 'boom' } })
    const machine: DaemonData = {
      id: 'machine-1',
      type: 'adhdev-daemon',
      status: 'online',
      version: '1.0.28-rc.18',
      updatePolicy: { channel: 'preview', npmTag: 'next', targetVersion: '1.0.28-rc.20' },
    }

    const result = await runDaemonUpgradeCommand(sendDaemonCommand, 'machine-1', machine)

    expect(result).toEqual({ state: 'error', message: 'boom' })
  })
})
