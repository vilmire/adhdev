import type { DaemonData } from '../types'

export type WebReleaseChannel = 'stable' | 'preview'
export type WebNpmTag = 'latest' | 'next'

export interface WebVersionUpdatePolicy {
    channel?: WebReleaseChannel
    npmTag?: WebNpmTag
    targetVersion?: string
    minVersion?: string
    updateCommand?: string
}

function normalizeChannel(value: unknown): WebReleaseChannel | null {
    if (typeof value !== 'string') return null
    const normalized = value.trim().toLowerCase()
    if (normalized === 'stable' || normalized === 'latest') return 'stable'
    if (normalized === 'preview' || normalized === 'next') return 'preview'
    return null
}

function normalizeNpmTag(value: unknown): WebNpmTag | null {
    if (typeof value !== 'string') return null
    const normalized = value.trim().toLowerCase()
    if (normalized === 'latest' || normalized === 'stable') return 'latest'
    if (normalized === 'next' || normalized === 'preview') return 'next'
    return null
}

function normalizeVersion(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const normalized = value.trim()
    return normalized.length > 0 ? normalized : null
}

export function getDaemonUpdatePolicy(daemon: DaemonData): WebVersionUpdatePolicy {
    const raw = daemon.updatePolicy && typeof daemon.updatePolicy === 'object'
        ? daemon.updatePolicy as WebVersionUpdatePolicy
        : {}
    const channel = normalizeChannel(raw.channel)
        || normalizeChannel(daemon.updateChannel)
        || normalizeChannel(daemon.releaseChannel)
        || undefined
    const npmTag = normalizeNpmTag(raw.npmTag)
        || (channel === 'preview' ? 'next' : channel === 'stable' ? 'latest' : undefined)
    const targetVersion = normalizeVersion(raw.targetVersion)
        || normalizeVersion(daemon.serverVersion)
        || undefined
    const minVersion = normalizeVersion(raw.minVersion) || undefined
    const updateCommand = normalizeVersion(raw.updateCommand)
        // Phase 3: --channel is retired on the CLI (accept-and-ignore); the
        // binary's build stamp already pins the track, so the fallback
        // command is track-agnostic.
        || (channel ? 'adhdev update' : undefined)

    return {
        ...(channel ? { channel } : {}),
        ...(npmTag ? { npmTag } : {}),
        ...(targetVersion ? { targetVersion } : {}),
        ...(minVersion ? { minVersion } : {}),
        ...(updateCommand ? { updateCommand } : {}),
    }
}

export function getDaemonUpdateTargetVersion(daemon: DaemonData, fallbackVersion: string | null = null): string | null {
    return getDaemonUpdatePolicy(daemon).targetVersion || fallbackVersion
}

export function getDaemonUpdateChannel(daemon: DaemonData): WebReleaseChannel | null {
    return getDaemonUpdatePolicy(daemon).channel || null
}

/**
 * Build the `daemon_upgrade` payload from the node's server-pushed update
 * policy.
 *
 * Returns null when no channel is resolvable, and the caller must treat that as
 * "do not send the command". This null-gate is the ONLY load-bearing behavior
 * here: an unresolvable channel means we don't know enough about the node to
 * ask it to upgrade, so we refuse rather than fire a command whose outcome we
 * can't predict.
 *
 * The payload itself is deliberately EMPTY. Since Phase 3 the release channel
 * is a build-time identity of the installed binary (track-identity.ts), so the
 * daemon always upgrades along its own build track and explicitly ignores every
 * channel hint a dashboard sends: commands/low-family/daemon-lifecycle.ts logs
 * `args.channel` / `args.updatePolicy.channel` / `args.npmTag` and drops them.
 * Assembling channel/npmTag/targetVersion/updatePolicy here therefore produced
 * a payload that no consumer read — and worse, one that LOOKED authoritative,
 * inviting the belief that a dashboard can retarget a node's channel. It
 * cannot. Regression coverage for the daemon side lives in daemon-core's
 * test/commands/daemon-upgrade-runtime-version.test.ts ("ignores
 * updatePolicy.channel from a stale dashboard one-click upgrade payload").
 *
 * NOTE: this concerns the RELEASE (npm dist-tag) channel axis only. The
 * PROVIDER channel axis is separate and still reads `config.updateChannel` as a
 * legacy fallback (providers/channel/contract.ts) — untouched by this.
 */
export function buildDaemonUpgradePayload(daemon: DaemonData | null | undefined): Record<string, unknown> | null {
    if (!daemon) return null
    // Resolve purely to decide whether we may send the command at all.
    if (!getDaemonUpdatePolicy(daemon).channel) return null
    return {}
}

/**
 * The node's own current channel, as reported by the daemon itself
 * (`updateChannel` is its saved config, `releaseChannel` its build channel).
 * Distinct from `updatePolicy.channel`, which is the server-pushed TARGET
 * channel — getDaemonUpdateChannel() merges the two and can't tell them apart.
 */
export function getDaemonCurrentChannel(daemon: DaemonData): WebReleaseChannel | null {
    return normalizeChannel(daemon.updateChannel) || normalizeChannel(daemon.releaseChannel)
}

/**
 * Label for the one-click upgrade action. Since Phase 3 the release channel
 * is a build-time identity of the installed binary, an upgrade can NEVER
 * switch channels — so this is always a plain version-update label; the
 * policy channel only selects the target version. To move between tracks the
 * user installs the other binary (adhdev vs adhdev-preview), not this button.
 */
export function buildDaemonUpgradeLabel(
    _daemon: DaemonData,
    opts: { targetVersion?: string | null; required?: boolean; fallback?: string } = {},
): string {
    const targetVersion = normalizeVersion(opts.targetVersion)
    if (targetVersion) return `Update to v${targetVersion}`
    return opts.fallback || (opts.required ? 'Update now' : 'Upgrade')
}
