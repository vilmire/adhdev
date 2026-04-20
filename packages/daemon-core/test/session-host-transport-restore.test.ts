import { describe, expect, it } from 'vitest'

import { shouldResumeAttachedSession } from '../src/cli-adapters/session-host-transport.js'

describe('shouldResumeAttachedSession', () => {
  it('resumes interrupted live runtimes', () => {
    expect(shouldResumeAttachedSession({ lifecycle: 'interrupted', meta: {} } as any)).toBe(true)
  })

  it('resumes restored stopped recovery snapshots', () => {
    expect(shouldResumeAttachedSession({
      lifecycle: 'stopped',
      meta: { restoredFromStorage: true, runtimeRecoveryState: 'orphan_snapshot' },
    } as any)).toBe(true)
  })

  it('does not resume plain stopped sessions', () => {
    expect(shouldResumeAttachedSession({ lifecycle: 'stopped', meta: {} } as any)).toBe(false)
  })
})