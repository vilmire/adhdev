import type { MuxRuntimePaneState, MuxWorkspaceSnapshot, MuxWriteOwner } from '../base-api'

export interface WebMuxSummary {
    workspaceLabel: string
    tabLabel: string
    splitCount: number
}

export function summarizeMuxWorkspace(snapshot: MuxWorkspaceSnapshot, fallbackWorkspaceLabel?: string): WebMuxSummary {
    const workspaceLabel = fallbackWorkspaceLabel || snapshot.workspace.title || snapshot.workspaceName
    const tabLabel = snapshot.workspace.title || workspaceLabel
    const splitCount = Object.keys(snapshot.workspace.panes || {}).length
    return {
        workspaceLabel,
        tabLabel,
        splitCount,
    }
}

export function describeMuxPaneKind(pane: MuxRuntimePaneState | null | undefined): string {
    if (!pane) return 'split'
    return pane.paneKind === 'mirror' ? 'mirror split' : 'split'
}

export function describeMuxOwner(owner: MuxWriteOwner | null | undefined): string {
    if (!owner) return 'view only'
    if (owner.ownerType === 'user') return 'you control'
    return 'agent controls'
}

