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
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { getWorkspaceDisplayLabel } from '../../utils/daemon-utils'
import { useDashboardMeshOverrides } from '../../context/DashboardMeshContext'
import Card from '../../components/Card'
import ConfirmDialog from '../../components/ConfirmDialog'
import { IconFolder, IconPlus, IconTrash } from '../../components/Icons'
import type { MachineData, IdeSessionEntry, CliSessionEntry, AcpSessionEntry } from './types'
import type { useMachineActions } from './useMachineActions'
import WorkspaceBrowseDialog from '../../components/machine/WorkspaceBrowseDialog'
import {
    browseMachineDirectories,
    collectBrowsePathCandidates,
    getDefaultBrowseStartPath,
    type BrowseDirectoryEntry,
} from '../../components/machine/workspaceBrowse'

function normalizeWorkspacePath(path: string): string {
    return path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

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

    const { t } = useTranslation('common')
    const navigate = useNavigate()
    const meshOverrides = useDashboardMeshOverrides()
    const [browseDialogOpen, setBrowseDialogOpen] = useState(false)
    // Normalized workspace paths that are the root of a repo mesh on this
    // machine — those rows additionally offer a "+ mesh" coordinator launch.
    const [meshWorkspacePaths, setMeshWorkspacePaths] = useState<Set<string>>(() => new Set())
    // In-app remove confirmation (window.confirm is auto-dismissed in embedded
    // browsers, which made the old confirm-gated remove a silent no-op there).
    const [removeTarget, setRemoveTarget] = useState<{ id: string; label: string } | null>(null)

    useEffect(() => {
        let cancelled = false
        void (async () => {
            try {
                let workspaces: Array<string | null | undefined> = []
                if (meshOverrides?.listMeshes) {
                    workspaces = (await meshOverrides.listMeshes(machineId)).map(mesh => mesh.workspace)
                } else {
                    const raw: any = await sendDaemonCommand(machineId, 'list_meshes', {})
                    const result = raw?.result ?? raw
                    const meshes = Array.isArray(result?.meshes) ? result.meshes : []
                    workspaces = meshes.map((mesh: any) => (
                        Array.isArray(mesh?.nodes) && mesh.nodes.length > 0 ? String(mesh.nodes[0]?.workspace || '') : null
                    ))
                }
                if (cancelled) return
                setMeshWorkspacePaths(new Set(
                    workspaces.filter((path): path is string => !!path).map(normalizeWorkspacePath),
                ))
            } catch {
                // Mesh list is an enhancement — rows just won't show the mesh shortcut.
            }
        })()
        return () => { cancelled = true }
    }, [machineId, meshOverrides, sendDaemonCommand])

    // Same effect as the dashboard header "+" button, but preselected on this
    // machine + workspace. The dialog lives on the dashboard route (that's where
    // the launch handlers and the resulting session tab are), so we navigate
    // there with a one-shot open request instead of duplicating the launch stack.
    const openNewSessionForWorkspace = useCallback((workspaceId: string) => {
        navigate('/dashboard', { state: { openNewSession: { machineId, workspaceId } } })
    }, [machineId, navigate])

    const openNewMeshSessionForWorkspace = useCallback((workspaceId: string, workspacePath: string) => {
        navigate('/dashboard', {
            state: { openNewSession: { machineId, workspaceId, mode: 'mesh', meshWorkspacePath: workspacePath } },
        })
    }, [machineId, navigate])
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
                    <div className="text-2xs text-text-muted font-semibold uppercase tracking-wider flex items-center gap-1.5">
                        <IconFolder size={14} /> {t('machine.managedWorkspaces.title')}
                    </div>
                    <button
                        type="button"
                        className="btn bg-bg-glass hover:bg-bg-glass-hover text-text-muted hover:text-text-primary px-3 py-1 rounded transition-colors text-xs"
                        disabled={workspaceBusy}
                        onClick={openBrowseDialog}
                    >+ {t('machine.managedWorkspaces.addWorkspace')}</button>
                </div>

                {(machine.workspaces || []).length === 0 ? (
                    <div className="text-2xs text-text-muted py-4 text-center">
                        {t('machine.managedWorkspaces.empty', { button: t('machine.managedWorkspaces.addWorkspace') })}
                    </div>
                ) : (
                    <ul className="space-y-1.5 max-h-72 overflow-y-auto">
                        {(machine.workspaces || []).map(w => {
                            const isDefault = w.id === machine.defaultWorkspaceId
                            return (
                                <li
                                    key={w.id}
                                    className={`flex items-start gap-2 text-2xs rounded-lg border px-2.5 py-2 transition-colors ${
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
                                        <div className="font-mono text-text-muted truncate text-3xs" title={w.path}>{w.path}</div>
                                    </div>
                                    <button
                                        type="button"
                                        title={t('machine.managedWorkspaces.newSession')}
                                        className="btn shrink-0 flex items-center gap-1 bg-bg-glass hover:bg-bg-glass-hover text-text-muted hover:text-text-primary px-2 py-1 rounded transition-colors text-3xs"
                                        disabled={workspaceBusy}
                                        onClick={() => openNewSessionForWorkspace(w.id)}
                                    ><IconPlus size={11} />{t('machine.managedWorkspaces.newSessionShort')}</button>
                                    {meshWorkspacePaths.has(normalizeWorkspacePath(w.path)) && (
                                        <button
                                            type="button"
                                            title={t('machine.managedWorkspaces.newMeshSession')}
                                            className="btn shrink-0 flex items-center gap-1 bg-bg-glass hover:bg-bg-glass-hover text-text-muted hover:text-text-primary px-2 py-1 rounded transition-colors text-3xs"
                                            disabled={workspaceBusy}
                                            onClick={() => openNewMeshSessionForWorkspace(w.id, w.path)}
                                        ><IconPlus size={11} />{t('machine.managedWorkspaces.newMeshSessionShort')}</button>
                                    )}
                                    <button
                                        type="button"
                                        title={t('machine.managedWorkspaces.remove')}
                                        aria-label={t('machine.managedWorkspaces.remove')}
                                        className="shrink-0 p-1 rounded text-text-muted/60 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                                        disabled={workspaceBusy}
                                        onClick={() => setRemoveTarget({ id: w.id, label: getWorkspaceDisplayLabel(w.path, w.label) })}
                                    ><IconTrash size={13} /></button>
                                </li>
                            )
                        })}
                    </ul>
                )}
            </Card>

            {browseDialogOpen && (
                <WorkspaceBrowseDialog
                    title={t('machine.managedWorkspaces.addWorkspace')}
                    description={t('machine.managedWorkspaces.addDialogDescription')}
                    currentPath={browseCurrentPath}
                    directories={browseDirectories}
                    busy={browseBusy}
                    error={browseError}
                    confirmLabel={t('machine.managedWorkspaces.addWorkspace')}
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

            {removeTarget && (
                <ConfirmDialog
                    title={t('machine.managedWorkspaces.removeConfirmTitle')}
                    description={t('machine.managedWorkspaces.removeConfirmDescription', { label: removeTarget.label })}
                    confirmLabel={t('machine.managedWorkspaces.remove')}
                    tone="danger"
                    busy={workspaceBusy}
                    onCancel={() => setRemoveTarget(null)}
                    onConfirm={() => {
                        const target = removeTarget
                        setRemoveTarget(null)
                        if (target) void handleWorkspaceRemove(target.id)
                    }}
                />
            )}
        </>
    )
}
