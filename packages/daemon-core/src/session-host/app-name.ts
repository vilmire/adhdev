export const DEFAULT_SESSION_HOST_APP_NAME = 'adhdev'
export const DEFAULT_STANDALONE_SESSION_HOST_APP_NAME = 'adhdev-standalone'

function validateStandaloneSessionHostAppName(explicit: string): void {
  if (explicit !== DEFAULT_SESSION_HOST_APP_NAME) return
  throw new Error(
    `Standalone session-host namespace '${DEFAULT_SESSION_HOST_APP_NAME}' is reserved for the global daemon. `
    + `Use '${DEFAULT_STANDALONE_SESSION_HOST_APP_NAME}' or another non-default namespace.`,
  )
}

export function resolveSessionHostAppName(options: {
  standalone?: boolean
  env?: NodeJS.ProcessEnv
} = {}): string {
  const env = options.env || process.env
  const explicit = typeof env.ADHDEV_SESSION_HOST_NAME === 'string'
    ? env.ADHDEV_SESSION_HOST_NAME.trim()
    : ''

  if (explicit) {
    if (options.standalone) validateStandaloneSessionHostAppName(explicit)
    return explicit
  }
  return options.standalone ? DEFAULT_STANDALONE_SESSION_HOST_APP_NAME : DEFAULT_SESSION_HOST_APP_NAME
}
