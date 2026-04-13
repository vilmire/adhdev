export function shouldAutoRestoreHostedSessionsOnStartup(env = process.env) {
  const raw = typeof env.ADHDEV_RESTORE_HOSTED_SESSIONS_ON_STARTUP === 'string'
    ? env.ADHDEV_RESTORE_HOSTED_SESSIONS_ON_STARTUP.trim().toLowerCase()
    : ''

  return raw === '1' || raw === 'true' || raw === 'yes'
}
