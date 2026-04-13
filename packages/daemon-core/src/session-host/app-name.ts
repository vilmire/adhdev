export const DEFAULT_SESSION_HOST_APP_NAME = 'adhdev'
export const DEFAULT_STANDALONE_SESSION_HOST_APP_NAME = 'adhdev-standalone'

export function resolveSessionHostAppName(options: {
  standalone?: boolean
  env?: NodeJS.ProcessEnv
} = {}): string {
  const env = options.env || process.env
  const explicit = typeof env.ADHDEV_SESSION_HOST_NAME === 'string'
    ? env.ADHDEV_SESSION_HOST_NAME.trim()
    : ''

  if (explicit) return explicit
  return options.standalone ? DEFAULT_STANDALONE_SESSION_HOST_APP_NAME : DEFAULT_SESSION_HOST_APP_NAME
}
