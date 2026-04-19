export const DEFAULT_SESSION_HOST_APP_NAME = 'adhdev'
export const DEFAULT_STANDALONE_SESSION_HOST_APP_NAME = 'adhdev-standalone'

export interface SessionHostAppNameResolution {
  appName: string
  warning?: string
  source: 'default' | 'explicit' | 'reserved-standalone-fallback'
}

function getReservedStandaloneNamespaceWarning(): string {
  return `Standalone session-host namespace '${DEFAULT_SESSION_HOST_APP_NAME}' is reserved for the global daemon. `
    + `Falling back to '${DEFAULT_STANDALONE_SESSION_HOST_APP_NAME}' for this standalone run.`
}

export function resolveSessionHostAppNameResolution(options: {
  standalone?: boolean
  env?: NodeJS.ProcessEnv
} = {}): SessionHostAppNameResolution {
  const env = options.env || process.env
  const explicit = typeof env.ADHDEV_SESSION_HOST_NAME === 'string'
    ? env.ADHDEV_SESSION_HOST_NAME.trim()
    : ''

  if (explicit) {
    if (options.standalone && explicit === DEFAULT_SESSION_HOST_APP_NAME) {
      return {
        appName: DEFAULT_STANDALONE_SESSION_HOST_APP_NAME,
        warning: getReservedStandaloneNamespaceWarning(),
        source: 'reserved-standalone-fallback',
      }
    }
    return {
      appName: explicit,
      source: 'explicit',
    }
  }
  return {
    appName: options.standalone ? DEFAULT_STANDALONE_SESSION_HOST_APP_NAME : DEFAULT_SESSION_HOST_APP_NAME,
    source: 'default',
  }
}

export function resolveSessionHostAppName(options: {
  standalone?: boolean
  env?: NodeJS.ProcessEnv
} = {}): string {
  return resolveSessionHostAppNameResolution(options).appName
}
