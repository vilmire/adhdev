import { describe, expect, it } from 'vitest'
import { shouldAutoRestoreHostedSessionsOnStartup } from '../src/session-host/startup-restore-policy.js'

describe('shouldAutoRestoreHostedSessionsOnStartup', () => {
  it('defaults to explicit-only startup recovery', () => {
    expect(shouldAutoRestoreHostedSessionsOnStartup({})).toBe(false)
  })

  it('allows opt-in startup recovery through env override', () => {
    expect(shouldAutoRestoreHostedSessionsOnStartup({ ADHDEV_RESTORE_HOSTED_SESSIONS_ON_STARTUP: '1' } as NodeJS.ProcessEnv)).toBe(true)
    expect(shouldAutoRestoreHostedSessionsOnStartup({ ADHDEV_RESTORE_HOSTED_SESSIONS_ON_STARTUP: 'true' } as NodeJS.ProcessEnv)).toBe(true)
  })
})
