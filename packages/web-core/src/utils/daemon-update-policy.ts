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

export function buildDaemonUpgradePayload(daemon: DaemonData): Record<string, unknown> {
    const policy = getDaemonUpdatePolicy(daemon)
    return {
        ...(policy.channel ? { channel: policy.channel } : {}),
        ...(policy.npmTag ? { npmTag: policy.npmTag } : {}),
        ...(policy.targetVersion ? { targetVersion: policy.targetVersion } : {}),
        ...(Object.keys(policy).length > 0 ? { updatePolicy: policy } : {}),
    }
}
