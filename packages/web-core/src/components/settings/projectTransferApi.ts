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
    /** Network path of the latest established link; `relay` = bytes crossed a TURN relay. */
    path?: 'direct' | 'relay'
    targetMode?: 'new_folder' | 'existing_path'
    /** Set when a coordinator or the assistant (not the owner) asked for this transfer. */
    requestedBy?: { role: 'coordinator' | 'assistant'; sessionId?: string }
    /** existing_path preview (replaced file names are for the owner only). */
    overwrite?: {
        targetDir: string
        digest: string
        newCount: number
        replacedCount: number
        replaced: Array<{ path: string; size: number }>
        reverted?: boolean
        revertible?: boolean
    }
    /** The owner decision (To-do) waiting on an agent request. */
    decision?: { meshId: string; itemId: string }
}

/** Does this state's title already say the outcome (so the state word is not repeated)? */
export const TITLE_SAYS_OUTCOME = new Set(['completed', 'failed', 'cancelled', 'expired'])

/** Locale key (under settings.projectTransfer) of a transfer row title: direction while active, outcome once finished. */
export function transferTitleKey(role: 'source' | 'target', state: string): string {
    const src = role === 'source'
    switch (state) {
        case 'completed': return src ? 'roleTitle.sourceDone' : 'roleTitle.targetDone'
        case 'failed': return src ? 'roleTitle.sourceFailed' : 'roleTitle.targetFailed'
        case 'cancelled': return 'roleTitle.cancelled'
        case 'expired': return 'roleTitle.expired'
        default: return src ? 'roleSource' : 'roleTarget'
    }
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
