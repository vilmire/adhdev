/**
 * Track identity — the single source for "which release track is this binary?"
 * and every per-track constant derived from it (config dir name, default port,
 * server URL, service labels, npm dist-tag).
 *
 * Resolution precedence (highest first):
 *   1. Build-time injection `__ADHDEV_BUILD_CHANNEL__` — a literal baked into
 *      the bundle by tsup `define` (see build-stamp.mjs). This is the build
 *      stamp: a preview BUILD is self-identifying even on a machine whose
 *      config.json/env still say stable.
 *   2. `ADHDEV_BUILD_CHANNEL` env var — the same axis the web build already
 *      uses (packages/web-cloud/vite.config.ts); also the dev/test escape
 *      hatch when running from source where no define exists.
 *   3. 'stable' — absent or unrecognized values fail closed to stable.
 *
 * The axis name intentionally matches the web build's `ADHDEV_BUILD_CHANNEL`
 * (ci.yml stamps `stable`, deploy-preview-local.mjs stamps `preview`); this
 * module extends that existing axis to the CLI/daemon instead of inventing a
 * new one.
 *
 * This module is a PURE LEAF: zero imports (the build stamp is a declared
 * ambient identifier), so any config/logging/boot path can import it without
 * cycles and without pulling native addons. Config-dir PATH resolution lives
 * in config/config-dir.ts (the single path source); this module only decides
 * the track and its constants. daemon-early-crash-guard.ts (which must not
 * import anything beyond node builtins) mirrors the track resolution against
 * the same define — keep the two in sync.
 */

// Replaced at build time by tsup `define` (build-stamp.mjs). The `typeof`
// guard keeps this safe when the define is absent (tsx dev, vitest on src).
declare const __ADHDEV_BUILD_CHANNEL__: string | undefined;

export type BuildTrack = 'stable' | 'preview';

/** Env var that selects the build track when no build-time stamp exists. */
export const BUILD_CHANNEL_ENV_VAR = 'ADHDEV_BUILD_CHANNEL';

/**
 * Resolve the build track. Build-time injection wins over the env var; both
 * accept 'preview' or its npm dist-tag alias 'next' (mirrors
 * normalizeReleaseChannel in daemon-cloud's daemon-commands.ts); anything
 * else resolves to 'stable'.
 */
export function resolveBuildTrack(env: NodeJS.ProcessEnv = process.env): BuildTrack {
    const injected = typeof __ADHDEV_BUILD_CHANNEL__ !== 'undefined' ? __ADHDEV_BUILD_CHANNEL__ : undefined;
    const stamped = typeof injected === 'string' ? injected.trim() : '';
    const raw = (stamped || (env[BUILD_CHANNEL_ENV_VAR] ?? '').trim()).toLowerCase();
    return raw === 'preview' || raw === 'next' ? 'preview' : 'stable';
}

/** Process-wide build track, snapshotted at module load (env is fixed pre-launch). */
export const TRACK: BuildTrack = resolveBuildTrack();

export interface TrackIdentity {
    /** CLI binary name: 'adhdev' (stable) / 'adhdev-preview' (preview). */
    readonly binaryName: string;
    /** Home config dir name: '.adhdev' / '.adhdev-preview'. */
    readonly configDirName: string;
    /** Default daemon port: 19222 / 19223. */
    readonly defaultPort: number;
    /** API server origin. */
    readonly serverUrl: string;
    /** launchd Label for the service install. */
    readonly launchdLabel: string;
    /** Windows Startup VBS filename. */
    readonly vbsFileName: string;
    /** Session-host namespace (app name). */
    readonly sessionHostName: string;
    /** npm dist-tag the track publishes under. */
    readonly npmTag: 'latest' | 'next';
}

// Golden values mirror the code defaults they converge:
//   stable  — config.ts DEFAULT_CONFIG, ipc-protocol.ts DEFAULT_DAEMON_PORT,
//             daemon-cloud service-commands.ts LAUNCHD_LABEL / vbs name,
//             session-host/app-name.ts DEFAULT_SESSION_HOST_APP_NAME,
//             daemon-commands.ts CHANNEL_NPM_TAG / CHANNEL_SERVER_URL.
//   preview — daemon-cloud service-commands.ts PREVIEW_INSTANCE_DIR /
//             PREVIEW_DAEMON_PORT / PREVIEW_SESSION_HOST_NAME and the preview
//             rows of the same channel maps.
const STABLE_IDENTITY: TrackIdentity = {
    binaryName: 'adhdev',
    configDirName: '.adhdev',
    defaultPort: 19_222,
    serverUrl: 'https://api.adhf.dev',
    launchdLabel: 'dev.adhf.daemon',
    vbsFileName: 'adhdev-daemon.vbs',
    sessionHostName: 'adhdev',
    npmTag: 'latest',
};

const PREVIEW_IDENTITY: TrackIdentity = {
    binaryName: 'adhdev-preview',
    configDirName: '.adhdev-preview',
    defaultPort: 19_223,
    serverUrl: 'https://api-preview.adhf.dev',
    launchdLabel: 'dev.adhf.daemon.preview',
    vbsFileName: 'adhdev-daemon-preview.vbs',
    sessionHostName: 'adhdev-preview',
    npmTag: 'next',
};

export function getTrackIdentity(track: BuildTrack = TRACK): TrackIdentity {
    return track === 'preview' ? PREVIEW_IDENTITY : STABLE_IDENTITY;
}

/** Process-wide track identity, snapshotted at module load. */
export const IDENTITY: TrackIdentity = getTrackIdentity(TRACK);

/**
 * User-facing installer origin for the track — the host that serves
 * install.ps1 / install shell scripts and the dashboard:
 * 'https://adhf.dev' (stable) / 'https://dev.adhf.dev' (preview).
 *
 * Derived from the track, NOT from serverUrl: a custom/self-host serverUrl
 * must never reroute the vendor installer advice. Reinstall guidance that
 * prints `irm https://adhf.dev/...` on a preview track would silently
 * downgrade the user onto the stable track — the two tracks are separate
 * installs with separate config dirs and ports.
 */
export function getInstallOrigin(track: BuildTrack = TRACK): string {
    return track === 'preview' ? 'https://dev.adhf.dev' : 'https://adhf.dev';
}
