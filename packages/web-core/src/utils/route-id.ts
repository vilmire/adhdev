import type { DaemonData } from '../types'

export interface ParsedDaemonRouteId {
    daemonId: string
    targetSessionId?: string
}

export function parseDaemonRouteId(routeId: string): ParsedDaemonRouteId {
    const parts = routeId.split(':')
    if (parts.length >= 3 && (parts[1] === 'ide' || parts[1] === 'cli' || parts[1] === 'acp')) {
        return {
            daemonId: parts[0],
            targetSessionId: parts.slice(2).join(':') || undefined,
        }
    }
    return { daemonId: routeId }
}

export function applyRouteTarget(
    routeId: string,
    payload: Record<string, unknown>,
): { daemonId: string; payload: Record<string, unknown> } {
    const parsed = parseDaemonRouteId(routeId)
    return {
        daemonId: parsed.daemonId,
        payload: {
            ...payload,
            ...(parsed.targetSessionId && !payload.targetSessionId
                ? { targetSessionId: parsed.targetSessionId }
                : {}),
        },
    }
}

type DaemonRouteEntry = Pick<DaemonData, 'id'> & Partial<DaemonData> & { doId?: string | null }

export function extractDaemonId(entry: DaemonRouteEntry): string {
    return entry.doId || parseDaemonRouteId(entry.id).daemonId || entry.id
}

export function collectDaemonIds(ides: DaemonData[]): Set<string> {
    const ids = new Set<string>()
    for (const ide of ides) {
        const daemonId = extractDaemonId(ide)
        if (daemonId) ids.add(daemonId)
    }
    return ids
}
