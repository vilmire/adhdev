import { IDENTITY } from '../track-identity.js'

/**
 * The session-host namespace this BUILD owns ('adhdev' stable /
 * 'adhdev-preview' preview).
 *
 * Previously hardcoded to 'adhdev', which meant a preview daemon only avoided
 * colliding with the stable install because the service installer happened to
 * export ADHDEV_SESSION_HOST_NAME. Any preview daemon started WITHOUT that env
 * — a manual `adhdev-preview daemon`, a dev run, or an upgrade helper that lost
 * the environment — silently adopted the stable namespace and shared the
 * stable install's session host.
 */
export const DEFAULT_SESSION_HOST_APP_NAME = IDENTITY.sessionHostName

/**
 * The namespace reserved for the global (non-standalone) daemon of THIS track.
 * Kept separate from the default above: this is the name standalone must not
 * squat on, which is a distinct concern from the name this build defaults to.
 */
const RESERVED_GLOBAL_SESSION_HOST_APP_NAME = IDENTITY.sessionHostName

export const DEFAULT_STANDALONE_SESSION_HOST_APP_NAME = 'adhdev-standalone'

export interface SessionHostAppNameResolution {
  appName: string
  warning?: string
  source: 'default' | 'explicit' | 'reserved-standalone-fallback'
}

function getReservedStandaloneNamespaceWarning(): string {
  return `Standalone session-host namespace '${RESERVED_GLOBAL_SESSION_HOST_APP_NAME}' is reserved for the global daemon. `
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
    if (options.standalone && explicit === RESERVED_GLOBAL_SESSION_HOST_APP_NAME) {
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
