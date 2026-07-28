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
        || (channel ? `adhdev update --channel ${channel}` : undefined)

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
 * policy. Returns null when no channel is resolvable: sending an empty payload
 * makes the daemon fall back to its saved config or 'stable', which can
 * silently downgrade the node and retarget it to another channel. Callers must
 * treat null as "do not send the command".
 */
export function buildDaemonUpgradePayload(daemon: DaemonData | null | undefined): Record<string, unknown> | null {
    if (!daemon) return null
    const policy = getDaemonUpdatePolicy(daemon)
    if (!policy.channel) return null
    return {
        channel: policy.channel,
        ...(policy.npmTag ? { npmTag: policy.npmTag } : {}),
        ...(policy.targetVersion ? { targetVersion: policy.targetVersion } : {}),
        updatePolicy: policy,
    }
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
 * Label for the one-click upgrade action. The action targets the server-pushed
 * policy channel: when the node's current channel already IS that channel this
 * is a plain version update ('Update to v{target}'); only when the channels
 * actually differ is it a channel switch ('Switch to preview' / 'Switch to
 * stable'). When the node's channel is unknown we can't prove a switch, so we
 * fall back to the version-update label.
 */
export function buildDaemonUpgradeLabel(
    daemon: DaemonData,
    opts: { targetVersion?: string | null; required?: boolean; fallback?: string } = {},
): string {
    const policyChannel = daemon.updatePolicy && typeof daemon.updatePolicy === 'object'
        ? normalizeChannel((daemon.updatePolicy as WebVersionUpdatePolicy).channel)
        : null
    const currentChannel = getDaemonCurrentChannel(daemon)
    if (policyChannel && currentChannel && policyChannel !== currentChannel) {
        return `Switch to ${policyChannel}`
    }
    const targetVersion = normalizeVersion(opts.targetVersion)
    if (targetVersion) return `Update to v${targetVersion}`
    return opts.fallback || (opts.required ? 'Update now' : 'Upgrade')
}
