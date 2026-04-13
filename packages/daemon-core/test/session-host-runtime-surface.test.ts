import { describe, expect, it } from 'vitest'
import {
  getSessionHostRecoveryLabel,
  getSessionHostSurfaceKind,
  isSessionHostLiveRuntime,
  isSessionHostRecoverySnapshot,
  partitionSessionHostRecords,
} from '../src/session-host/runtime-surface'

describe('session host runtime surface helpers', () => {
  it('treats running and interrupted records as live runtimes', () => {
    expect(isSessionHostLiveRuntime({ lifecycle: 'running' })).toBe(true)
    expect(isSessionHostLiveRuntime({ lifecycle: 'interrupted' })).toBe(true)
    expect(getSessionHostSurfaceKind({ lifecycle: 'starting' })).toBe('live_runtime')
  })

  it('treats restored stopped records as recovery snapshots', () => {
    const record = {
      lifecycle: 'stopped',
      meta: {
        restoredFromStorage: true,
        runtimeRecoveryState: 'orphan_snapshot',
      },
    }
    expect(isSessionHostRecoverySnapshot(record)).toBe(true)
    expect(getSessionHostSurfaceKind(record)).toBe('recovery_snapshot')
    expect(getSessionHostRecoveryLabel(record.meta)).toBe('snapshot recovered')
  })

  it('keeps plain stopped records out of the live runtime section', () => {
    const record = {
      lifecycle: 'stopped',
      meta: {},
    }
    expect(isSessionHostLiveRuntime(record)).toBe(false)
    expect(isSessionHostRecoverySnapshot(record)).toBe(false)
    expect(getSessionHostSurfaceKind(record)).toBe('inactive_record')
  })

  it('partitions records into live runtimes, recovery snapshots, and inactive records', () => {
    const result = partitionSessionHostRecords([
      { lifecycle: 'running', meta: { providerSessionId: 'live-1' } },
      { lifecycle: 'failed', meta: { restoredFromStorage: true, runtimeRecoveryState: 'resume_failed' } },
      { lifecycle: 'stopped', meta: {} },
    ])

    expect(result.liveRuntimes).toHaveLength(1)
    expect(result.recoverySnapshots).toHaveLength(1)
    expect(result.inactiveRecords).toHaveLength(1)
  })
})
