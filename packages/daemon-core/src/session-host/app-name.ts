import { IDENTITY, getTrackIdentity } from '../track-identity.js'

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
 * The namespaces reserved for the global (non-standalone) daemons of EVERY track.
 * Kept separate from the default above: these are the names standalone must not
 * squat on, which is a distinct concern from the name this build defaults to.
 *
 * Both tracks, not just this build's: every PTY a daemon hosts inherits
 * ADHDEV_SESSION_HOST_NAME, so a stable `npx @adhdev/daemon-standalone` run from a
 * terminal inside a preview daemon's session saw 'adhdev-preview', adopted the
 * preview daemon's session-host pipe and pidfile, and on Windows stopped that host
 * as "running from a foreign install" — every live session on the machine died
 * (2026-10-06, clean-install e2e).
 */
const RESERVED_GLOBAL_SESSION_HOST_APP_NAMES: ReadonlySet<string> = new Set([
  getTrackIdentity('stable').sessionHostName,
  getTrackIdentity('preview').sessionHostName,
])

export const DEFAULT_STANDALONE_SESSION_HOST_APP_NAME = 'adhdev-standalone'

export interface SessionHostAppNameResolution {
  appName: string
  warning?: string
  source: 'default' | 'explicit' | 'reserved-standalone-fallback'
}

function getReservedStandaloneNamespaceWarning(name: string): string {
  return `Standalone session-host namespace '${name}' is reserved for the global daemon. `
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
    if (options.standalone && RESERVED_GLOBAL_SESSION_HOST_APP_NAMES.has(explicit)) {
      return {
        appName: DEFAULT_STANDALONE_SESSION_HOST_APP_NAME,
        warning: getReservedStandaloneNamespaceWarning(explicit),
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
