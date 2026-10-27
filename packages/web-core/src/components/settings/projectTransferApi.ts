/** Wire contract for the project-transfer commands (names mirror daemon-core; no value imports from it). */
export type SendCommand = (daemonId: string, type: string, payload?: any) => Promise<any>

export interface TransferView {
    id: string
    role: 'source' | 'target'
    peerDaemonId: string
    state: string
    errorCode?: string
    finalName: string
    publishedName?: string
    sourceWorkspaceId: string
    targetWorkspaceId: string
    selectionDigest: string
    previewExpiresAt: number
    totalBytes: number
    bytesDone: number
    fileCount: number
    entries: Array<{ path: string; kind: 'file' | 'dir'; size?: number }>
    excluded: Array<{ path: string; reason: string }>
    localApproved: boolean
    peerApproved: boolean
}

export interface BrowseEntry { name: string; kind: 'file' | 'dir' | 'other'; size?: number; excluded?: string }

export const TERMINAL_TRANSFER_STATES = new Set(['completed', 'failed', 'cancelled', 'expired', 'revoked'])

/** Standalone returns the raw body, cloud wraps it once under `result`. */
export function unwrapBody(raw: unknown): Record<string, any> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const outer = raw as Record<string, any>
    return outer.result && typeof outer.result === 'object' && !Array.isArray(outer.result) ? outer.result : outer
}

export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`
    const units = ['KB', 'MB', 'GB']
    let v = n / 1024
    let i = 0
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
    return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`
}

export async function call(send: SendCommand, daemonId: string, cmd: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    return unwrapBody(await send(daemonId, cmd, args))
}
