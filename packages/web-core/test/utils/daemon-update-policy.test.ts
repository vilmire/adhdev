import { describe, expect, it } from 'vitest'
import type { DaemonData } from '../../src/types'
import {
  buildDaemonUpgradePayload,
  getDaemonUpdateChannel,
  getDaemonUpdateTargetVersion,
} from '../../src/utils/daemon-update-policy'

describe('daemon update policy helpers', () => {
  it('builds a preview one-click upgrade payload from server updatePolicy', () => {
    const daemon: DaemonData = {
      id: 'machine-1',
      type: 'adhdev-daemon',
      status: 'online',
      version: '0.9.75',
      versionMismatch: true,
      releaseChannel: 'preview',
      updateChannel: 'preview',
      serverVersion: '0.9.76-rc.2',
      updatePolicy: {
        channel: 'preview',
        npmTag: 'next',
        targetVersion: '0.9.76-rc.2',
        updateCommand: 'adhdev update --channel preview',
      },
    }

    expect(getDaemonUpdateChannel(daemon)).toBe('preview')
    expect(getDaemonUpdateTargetVersion(daemon, '0.9.75')).toBe('0.9.76-rc.2')
    expect(buildDaemonUpgradePayload(daemon)).toEqual({
      channel: 'preview',
      npmTag: 'next',
      targetVersion: '0.9.76-rc.2',
      updatePolicy: {
        channel: 'preview',
        npmTag: 'next',
        targetVersion: '0.9.76-rc.2',
        updateCommand: 'adhdev update --channel preview',
      },
    })
  })

  it('falls back to releaseChannel/serverVersion when compact payload lacks full policy', () => {
    const daemon: DaemonData = {
      id: 'machine-2',
      type: 'adhdev-daemon',
      status: 'online',
      version: '0.9.75',
      releaseChannel: 'preview',
      serverVersion: '0.9.76-rc.2',
    }

    expect(buildDaemonUpgradePayload(daemon)).toEqual({
      channel: 'preview',
      npmTag: 'next',
      targetVersion: '0.9.76-rc.2',
      updatePolicy: {
        channel: 'preview',
        npmTag: 'next',
        targetVersion: '0.9.76-rc.2',
        updateCommand: 'adhdev update --channel preview',
      },
    })
  })
})
