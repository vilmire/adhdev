/**
 * ManagedWorkspacesSection — saved-workspace list and folder picker.
 *
 * Previously this lived inside OverviewTab, which made the System surface
 * own Workspaces. Hoisted into the dedicated Workspace tab where it belongs.
 *
 * Responsibilities:
 *   - List the machine's saved workspaces with their default-marker
 *   - Set default workspace via a select
 *   - Open the folder browser dialog to add a new workspace
 *   - Remove a saved workspace
 */
import { useCallback, useState } from 'react'
import { getWorkspaceDisplayLabel } from '../../utils/daemon-utils'
import Card from '../../components/Card'
import { IconFolder } from '../../components/Icons'
import type { MachineData, IdeSessionEntry, CliSessionEntry, AcpSessionEntry } from './types'
import type { useMachineActions } from './useMachineActions'
import WorkspaceBrowseDialog from '../../components/machine/WorkspaceBrowseDialog'
import {
    browseMachineDirectories,
    collectBrowsePathCandidates,
    getDefaultBrowseStartPath,
    type BrowseDirectoryEntry,
} from '../../components/machine/workspaceBrowse'

interface ManagedWorkspacesSectionProps {
    machineId: string
    machine: MachineData
    ideSessions: IdeSessionEntry[]
    cliSessions: CliSessionEntry[]
    acpSessions: AcpSessionEntry[]
    actions: ReturnType<typeof useMachineActions>
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
}

export default function ManagedWorkspacesSection({
    machineId,
    machine,
    ideSessions,
    cliSessions,
    acpSessions,
    actions,
    sendDaemonCommand,
}: ManagedWorkspacesSectionProps) {
    const {
        workspaceBusy,
        handleWorkspaceAdd, handleWorkspaceRemove, handleWorkspaceSetDefault,
    } = actions

    const [browseDialogOpen, setBrowseDialogOpen] = useState(false)
    const [browseCurrentPath, setBrowseCurrentPath] = useState('')
    const [browseDirectories, setBrowseDirectories] = useState<BrowseDirectoryEntry[]>([])
    const [browseBusy, setBrowseBusy] = useState(false)
    const [browseError, setBrowseError] = useState('')

    const loadBrowsePath = useCallback(async (path: string) => {
        setBrowseBusy(true)
        setBrowseError('')
        try {
            const result = await browseMachineDirectories(sendDaemonCommand, machineId, path)
            setBrowseCurrentPath(result.path)
            setBrowseDirectories(result.directories)
        } catch (error) {
            setBrowseError(error instanceof Error ? error.message : 'Could not load folder')
        } finally {
            setBrowseBusy(false)
        }
    }, [machineId, sendDaemonCommand])

    const openBrowseDialog = useCallback(() => {
        setBrowseDialogOpen(true)
        const activeWorkspacePaths = [
            ...ideSessions.map(session => session.workspace),
            ...cliSessions.map(session => session.workspace),
            ...acpSessions.map(session => session.workspace),
        ]
        const initialPath = getDefaultBrowseStartPath(
            machine.platform,
            collectBrowsePathCandidates(
                activeWorkspacePaths,
                machine.defaultWorkspacePath,
                (machine.workspaces || []).map(workspace => workspace.path),
            ),
        )
        void loadBrowsePath(initialPath)
    }, [acpSessions, cliSessions, ideSessions, loadBrowsePath, machine.defaultWorkspacePath, machine.platform, machine.workspaces])

    return (
        <>
            <Card padding="lg" className="mb-4">
                <div className="flex items-center justify-between gap-3 mb-3">
                    <div className="text-[11px] text-text-muted font-semibold uppercase tracking-wider flex items-center gap-1.5">
                        <IconFolder size={14} /> Workspaces
                    </div>
                    <button
                        type="button"
                        className="btn bg-bg-glass hover:bg-bg-glass-hover text-text-muted hover:text-text-primary px-3 py-1 rounded transition-colors text-xs"
                        disabled={workspaceBusy}
                        onClick={openBrowseDialog}
                    >+ Add workspace</button>
                </div>

                {(machine.workspaces || []).length === 0 ? (
                    <div className="text-[11px] text-text-muted py-4 text-center">
                        No saved workspaces yet. Click <span className="text-text-secondary">+ Add workspace</span> to pick a folder.
                    </div>
                ) : (
                    <ul className="space-y-1.5 max-h-72 overflow-y-auto">
                        {(machine.workspaces || []).map(w => {
                            const isDefault = w.id === machine.defaultWorkspaceId
                            return (
                                <li
                                    key={w.id}
                                    className={`flex items-start gap-2 text-[11px] rounded-lg border px-2.5 py-2 transition-colors ${
                                        isDefault
                                            ? 'border-yellow-500/30 bg-yellow-500/[0.05]'
                                            : 'border-border-subtle bg-bg-primary'
                                    }`}
                                >
                                    <button
                                        type="button"
                                        title={isDefault ? 'Default workspace — click to unset' : 'Set as default workspace'}
                                        disabled={workspaceBusy}
                                        onClick={() => void handleWorkspaceSetDefault(isDefault ? null : w.id)}
                                        className={`text-base leading-none shrink-0 transition-colors ${
                                            isDefault
                                                ? 'text-yellow-400 hover:text-yellow-300'
                                                : 'text-text-muted/40 hover:text-yellow-400'
                                        }`}
                                    >★</button>
                                    <div className="min-w-0 flex-1">
                                        <div className="font-medium text-text-primary truncate">
                                            {getWorkspaceDisplayLabel(w.path, w.label)}
                                        </div>
                                        <div className="font-mono text-text-muted truncate text-[10px]" title={w.path}>{w.path}</div>
                                    </div>
                                    <button
                                        type="button"
                                        className="text-[10px] text-red-400/90 hover:underline shrink-0"
                                        disabled={workspaceBusy}
                                        onClick={() => void handleWorkspaceRemove(w.id)}
                                    >Remove</button>
                                </li>
                            )
                        })}
                    </ul>
                )}
            </Card>

            {browseDialogOpen && (
                <WorkspaceBrowseDialog
                    title="Add workspace"
                    description="Browse the machine like a normal explorer, then add the current folder as a saved workspace."
                    currentPath={browseCurrentPath}
                    directories={browseDirectories}
                    busy={browseBusy}
                    error={browseError}
                    confirmLabel="Add workspace"
                    onClose={() => setBrowseDialogOpen(false)}
                    onNavigate={(path) => { void loadBrowsePath(path) }}
                    onConfirm={(path) => {
                        void (async () => {
                            if (!path) return
                            const added = await handleWorkspaceAdd(path)
                            if (added) setBrowseDialogOpen(false)
                        })()
                    }}
                />
            )}
        </>
    )
}
