import { describe, expect, it } from 'vitest'
import type { DaemonData } from '../../src/types'
import {
  buildDaemonUpgradeLabel,
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
        // Phase 3: the derived fallback command no longer carries --channel —
        // the installed binary's build stamp pins the track.
        updateCommand: 'adhdev update',
      },
    })
  })

  it('labels a behind-target daemon on its current channel as a version update, not a channel switch', () => {
    const daemon: DaemonData = {
      id: 'machine-3',
      type: 'adhdev-daemon',
      status: 'online',
      version: '0.9.82-rc.100',
      versionMismatch: true,
      updateChannel: 'preview',
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
      buttonLabel: 'Update to v0.9.82-rc.118',
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

describe('buildDaemonUpgradePayload fail-closed behavior', () => {
  it('returns null when no channel is resolvable from the node policy fields', () => {
    // An empty payload would make the daemon fall back to saved config /
    // 'stable' — a silent downgrade + channel retarget. Never send it.
    const daemon: DaemonData = {
      id: 'machine-6',
      type: 'adhdev-daemon',
      status: 'online',
      version: '1.0.28-rc.18',
    }

    expect(buildDaemonUpgradePayload(daemon)).toBeNull()
    expect(buildDaemonUpgradePayload(null)).toBeNull()
    expect(buildDaemonUpgradePayload(undefined)).toBeNull()
  })

  it('carries the explicit channel when the policy is present', () => {
    const daemon: DaemonData = {
      id: 'machine-7',
      type: 'adhdev-daemon',
      status: 'online',
      version: '1.0.28-rc.18',
      updatePolicy: { channel: 'preview', npmTag: 'next', targetVersion: '1.0.28-rc.20' },
    }

    expect(buildDaemonUpgradePayload(daemon)).toMatchObject({
      channel: 'preview',
      npmTag: 'next',
      targetVersion: '1.0.28-rc.20',
    })
  })
})

describe('buildDaemonUpgradeLabel', () => {
  const base: DaemonData = {
    id: 'machine-8',
    type: 'adhdev-daemon',
    status: 'online',
    version: '1.0.28-rc.18',
  }

  it('labels a version update when the node channel already equals the policy channel', () => {
    const daemon: DaemonData = {
      ...base,
      updateChannel: 'preview',
      updatePolicy: { channel: 'preview', npmTag: 'next', targetVersion: '1.0.28-rc.20' },
    }

    expect(buildDaemonUpgradeLabel(daemon, { targetVersion: '1.0.28-rc.20' })).toBe('Update to v1.0.28-rc.20')
  })

  it('never labels a channel switch — tracks are build-time identities since Phase 3', () => {
    // A stable binary shown a preview policy used to get a 'Switch to preview'
    // button. An upgrade can no longer switch channels (the build stamp pins
    // the track), so even a mismatched node/policy channel pair is labeled as
    // a plain version update.
    const daemon: DaemonData = {
      ...base,
      updateChannel: 'stable',
      updatePolicy: { channel: 'preview', npmTag: 'next', targetVersion: '1.0.28-rc.20' },
    }

    expect(buildDaemonUpgradeLabel(daemon, { targetVersion: '1.0.28-rc.20' })).toBe('Update to v1.0.28-rc.20')
  })

  it('falls back to the version-update label when the node channel is unknown', () => {
    const daemon: DaemonData = {
      ...base,
      updatePolicy: { channel: 'preview', npmTag: 'next', targetVersion: '1.0.28-rc.20' },
    }

    expect(buildDaemonUpgradeLabel(daemon, { targetVersion: '1.0.28-rc.20' })).toBe('Update to v1.0.28-rc.20')
    expect(buildDaemonUpgradeLabel(daemon, { required: true })).toBe('Update now')
    expect(buildDaemonUpgradeLabel(daemon)).toBe('Upgrade')
  })
})
