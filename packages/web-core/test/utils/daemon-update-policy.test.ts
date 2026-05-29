import { describe, expect, it } from 'vitest'
import type { DaemonData } from '../../src/types'
import {
  buildDaemonUpgradePayload,
  getDaemonUpdateChannel,
  getDaemonUpdateTargetVersion,
} from '../../src/utils/daemon-update-policy'
import { buildDaemonUpdateStatusView } from '../../src/utils/daemon-update-status'

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

  it('shows the preview update button when the daemon is behind the preview target', () => {
    const daemon: DaemonData = {
      id: 'machine-3',
      type: 'adhdev-daemon',
      status: 'online',
      version: '0.9.82-rc.100',
      versionMismatch: true,
      updatePolicy: {
        channel: 'preview',
        npmTag: 'next',
        targetVersion: '0.9.82-rc.118',
      },
    }

    expect(buildDaemonUpdateStatusView(daemon, '0.9.82-rc.118')).toMatchObject({
      visible: true,
      showButton: true,
      title: 'Version mismatch detected',
      buttonLabel: 'Update to preview',
      targetVersion: '0.9.82-rc.118',
      channel: 'preview',
    })
  })

  it('hides the preview update button with an explicit up-to-date status when current', () => {
    const daemon: DaemonData = {
      id: 'machine-4',
      type: 'adhdev-daemon',
      status: 'online',
      version: '0.9.82-rc.118',
      updatePolicy: {
        channel: 'preview',
        npmTag: 'next',
        targetVersion: '0.9.82-rc.118',
      },
    }

    expect(buildDaemonUpdateStatusView(daemon, '0.9.82-rc.118')).toMatchObject({
      visible: true,
      showButton: false,
      title: 'Preview daemon is up to date',
      targetVersion: '0.9.82-rc.118',
      channel: 'preview',
      tone: 'good',
    })
  })

  it('uses a safe preview status when the preview target identity is unknown', () => {
    const daemon: DaemonData = {
      id: 'machine-5',
      type: 'adhdev-daemon',
      status: 'online',
      version: '0.9.82-rc.118',
      updateChannel: 'preview',
    }

    expect(buildDaemonUpdateStatusView(daemon, null)).toMatchObject({
      visible: true,
      showButton: false,
      title: 'Preview update status unknown',
      targetVersion: null,
      channel: 'preview',
      tone: 'info',
    })
  })
})
