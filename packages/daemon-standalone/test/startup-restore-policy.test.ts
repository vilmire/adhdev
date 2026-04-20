import { test } from 'node:test'
import * as assert from 'node:assert/strict'

import { shouldAutoRestoreHostedSessionsOnStartup } from '../src/startup-restore-policy.js'

test('startup restore defaults to enabled in standalone', () => {
  assert.equal(shouldAutoRestoreHostedSessionsOnStartup({}), true)
})

test('startup restore allows explicit opt-out in standalone', () => {
  assert.equal(shouldAutoRestoreHostedSessionsOnStartup({ ADHDEV_RESTORE_HOSTED_SESSIONS_ON_STARTUP: '0' } as NodeJS.ProcessEnv), false)
  assert.equal(shouldAutoRestoreHostedSessionsOnStartup({ ADHDEV_RESTORE_HOSTED_SESSIONS_ON_STARTUP: 'false' } as NodeJS.ProcessEnv), false)
  assert.equal(shouldAutoRestoreHostedSessionsOnStartup({ ADHDEV_RESTORE_HOSTED_SESSIONS_ON_STARTUP: 'no' } as NodeJS.ProcessEnv), false)
})

test('startup restore allows explicit opt-in in standalone', () => {
  assert.equal(shouldAutoRestoreHostedSessionsOnStartup({ ADHDEV_RESTORE_HOSTED_SESSIONS_ON_STARTUP: '1' } as NodeJS.ProcessEnv), true)
  assert.equal(shouldAutoRestoreHostedSessionsOnStartup({ ADHDEV_RESTORE_HOSTED_SESSIONS_ON_STARTUP: 'true' } as NodeJS.ProcessEnv), true)
  assert.equal(shouldAutoRestoreHostedSessionsOnStartup({ ADHDEV_RESTORE_HOSTED_SESSIONS_ON_STARTUP: 'yes' } as NodeJS.ProcessEnv), true)
})