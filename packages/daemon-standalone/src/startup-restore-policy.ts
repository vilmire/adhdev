export function shouldAutoRestoreHostedSessionsOnStartup(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = typeof env.ADHDEV_RESTORE_HOSTED_SESSIONS_ON_STARTUP === 'string'
    ? env.ADHDEV_RESTORE_HOSTED_SESSIONS_ON_STARTUP.trim().toLowerCase()
    : ''

  if (!raw) return true
  if (raw === '0' || raw === 'false' || raw === 'no') return false
  return raw === '1' || raw === 'true' || raw === 'yes'
}
