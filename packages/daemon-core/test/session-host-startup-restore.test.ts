import { describe, expect, it } from 'vitest'
import { shouldAutoRestoreHostedSessionsOnStartup } from '../src/session-host/startup-restore-policy.js'

describe('shouldAutoRestoreHostedSessionsOnStartup', () => {
  it('defaults to startup recovery enabled', () => {
    expect(shouldAutoRestoreHostedSessionsOnStartup({})).toBe(true)
  })

  it('allows explicit opt-in startup recovery through env override', () => {
    expect(shouldAutoRestoreHostedSessionsOnStartup({ ADHDEV_RESTORE_HOSTED_SESSIONS_ON_STARTUP: '1' } as NodeJS.ProcessEnv)).toBe(true)
    expect(shouldAutoRestoreHostedSessionsOnStartup({ ADHDEV_RESTORE_HOSTED_SESSIONS_ON_STARTUP: 'true' } as NodeJS.ProcessEnv)).toBe(true)
  })

  it('allows explicit opt-out startup recovery through env override', () => {
    expect(shouldAutoRestoreHostedSessionsOnStartup({ ADHDEV_RESTORE_HOSTED_SESSIONS_ON_STARTUP: '0' } as NodeJS.ProcessEnv)).toBe(false)
    expect(shouldAutoRestoreHostedSessionsOnStartup({ ADHDEV_RESTORE_HOSTED_SESSIONS_ON_STARTUP: 'false' } as NodeJS.ProcessEnv)).toBe(false)
    expect(shouldAutoRestoreHostedSessionsOnStartup({ ADHDEV_RESTORE_HOSTED_SESSIONS_ON_STARTUP: 'no' } as NodeJS.ProcessEnv)).toBe(false)
  })
})
