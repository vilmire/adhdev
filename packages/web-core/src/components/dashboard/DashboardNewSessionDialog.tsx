import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DaemonData } from '../../types'
import { compareMachineEntries, getMachineDisplayName, getWorkspaceDisplayLabel } from '../../utils/daemon-utils'
import { IconFolder, IconPlay, IconX } from '../Icons'
import WorkspaceBrowseDialog from '../machine/WorkspaceBrowseDialog'
import { getDefaultBrowseStartPath, type BrowseDirectoryResult } from '../machine/workspaceBrowse'

type LaunchKind = 'ide' | 'cli' | 'acp'

interface DashboardNewSessionDialogProps {
    machines: DaemonData[]
    onClose: () => void
    onBrowseDirectory: (machineId: string, path: string) => Promise<BrowseDirectoryResult>
    onSaveWorkspace: (machineId: string, path: string) => Promise<{ ok: boolean; error?: string }>
    onLaunchIde: (machineId: string, ideType: string, opts?: { workspacePath?: string | null }) => Promise<{ ok: boolean; error?: string }>
    onLaunchProvider: (
        machineId: string,
        kind: 'cli' | 'acp',
        providerType: string,
        opts?: { workspaceId?: string | null; workspacePath?: string | null },
    ) => Promise<{ ok: boolean; error?: string }>
}

function getDefaultLaunchKind(machine: DaemonData | undefined) {
    if (!machine) return null
    const hasIde = (machine.detectedIdes?.length || 0) > 0
    const providers = machine.availableProviders || []
    if (hasIde) return 'ide' as const
    if (providers.some(provider => provider.category === 'cli')) return 'cli' as const
    if (providers.some(provider => provider.category === 'acp')) return 'acp' as const
    return null
}

export default function DashboardNewSessionDialog({
    machines,
    onClose,
    onBrowseDirectory,
    onSaveWorkspace,
    onLaunchIde,
    onLaunchProvider,
}: DashboardNewSessionDialogProps) {
    const sortedMachines = useMemo(
        () => [...machines].sort(compareMachineEntries),
        [machines],
    )
    const [selectedMachineId, setSelectedMachineId] = useState(sortedMachines[0]?.id || '')
    const selectedMachine = useMemo(
        () => sortedMachines.find(machine => machine.id === selectedMachineId) || sortedMachines[0],
        [selectedMachineId, sortedMachines],
    )
    const workspaceRows = useMemo(
        () => ((selectedMachine as any)?.workspaces || []) as Array<{ id: string; path: string; label?: string }>,
        [selectedMachine],
    )
    const defaultWorkspaceId = ((selectedMachine as any)?.defaultWorkspaceId as string | null | undefined) || null
    const [workspaceChoice, setWorkspaceChoice] = useState<string>('')
    const [customWorkspacePath, setCustomWorkspacePath] = useState('')
    const [activeKind, setActiveKind] = useState<LaunchKind | null>(getDefaultLaunchKind(sortedMachines[0]))
    const [selectedTarget, setSelectedTarget] = useState('')
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState('')
    const [browseDialogOpen, setBrowseDialogOpen] = useState(false)
    const [browseCurrentPath, setBrowseCurrentPath] = useState('')
    const [browseDirectories, setBrowseDirectories] = useState<Array<{ name: string; path: string }>>([])
    const [browseBusy, setBrowseBusy] = useState(false)
    const [browseError, setBrowseError] = useState('')
    const [savingWorkspace, setSavingWorkspace] = useState(false)
    const initializedMachineIdRef = useRef<string | null>(null)

    useEffect(() => {
        if (!selectedMachineId && sortedMachines[0]?.id) {
            setSelectedMachineId(sortedMachines[0].id)
        }
    }, [selectedMachineId, sortedMachines])

    const cliProviders = useMemo(
        () => ((selectedMachine?.availableProviders || []).filter(provider => provider.category === 'cli')),
        [selectedMachine],
    )
    const acpProviders = useMemo(
        () => ((selectedMachine?.availableProviders || []).filter(provider => provider.category === 'acp')),
        [selectedMachine],
    )
    const ideTargets = useMemo(
        () => (selectedMachine?.detectedIdes || []).map(ide => ({
            id: ide.type,
            label: ide.name || ide.type,
            meta: ide.running ? 'Detected locally' : 'Available to open',
        })),
        [selectedMachine],
    )
    const providerTargets = useMemo(
        () => activeKind === 'cli'
            ? cliProviders.map(provider => ({
                id: provider.type,
                label: provider.displayName || provider.type,
                meta: 'CLI provider',
            }))
            : activeKind === 'acp'
                ? acpProviders.map(provider => ({
                    id: provider.type,
                    label: provider.displayName || provider.type,
                    meta: 'ACP provider',
                }))
                : ideTargets,
        [acpProviders, activeKind, cliProviders, ideTargets],
    )

    useEffect(() => {
        if (!selectedMachine) return

        const machineChanged = initializedMachineIdRef.current !== selectedMachine.id
        if (machineChanged) {
            initializedMachineIdRef.current = selectedMachine.id
            setWorkspaceChoice(defaultWorkspaceId || workspaceRows[0]?.id || '__home__')
            setCustomWorkspacePath('')
            setActiveKind(getDefaultLaunchKind(selectedMachine))
            setSelectedTarget('')
            setMessage('')
            return
        }

        setWorkspaceChoice(prev => {
            if (prev === '__custom__' || prev === '__home__') return prev
            if (workspaceRows.some(workspace => workspace.id === prev)) return prev
            return defaultWorkspaceId || workspaceRows[0]?.id || '__home__'
        })

        setActiveKind(prev => {
            if (prev === 'ide' && ideTargets.length > 0) return prev
            if (prev === 'cli' && cliProviders.length > 0) return prev
            if (prev === 'acp' && acpProviders.length > 0) return prev
            return getDefaultLaunchKind(selectedMachine)
        })
    }, [acpProviders.length, cliProviders.length, defaultWorkspaceId, ideTargets.length, selectedMachine, workspaceRows])

    useEffect(() => {
        if (!activeKind) return
        if (providerTargets.some(target => target.id === selectedTarget)) return
        setSelectedTarget(providerTargets[0]?.id || '')
    }, [activeKind, providerTargets, selectedTarget])

    const resolvedWorkspacePath = workspaceChoice === '__custom__'
        ? customWorkspacePath.trim()
        : workspaceChoice === '__home__'
            ? ''
            : (workspaceRows.find(workspace => workspace.id === workspaceChoice)?.path || '')

    const openBrowseDialog = useCallback(() => {
        if (!selectedMachine) return
        setWorkspaceChoice('__custom__')
        setBrowseDialogOpen(true)
        setBrowseError('')
        const initialPath = getDefaultBrowseStartPath(selectedMachine.platform, [
            customWorkspacePath.trim(),
            resolvedWorkspacePath,
            workspaceRows.find(workspace => workspace.id === defaultWorkspaceId)?.path,
            workspaceRows[0]?.path,
        ])
        setBrowseBusy(true)
        void onBrowseDirectory(selectedMachine.id, initialPath)
            .then(result => {
                setBrowseCurrentPath(result.path)
                setCustomWorkspacePath(result.path)
                setBrowseDirectories(result.directories)
            })
            .catch(error => {
                setBrowseError(error instanceof Error ? error.message : 'Could not load folder')
            })
            .finally(() => setBrowseBusy(false))
    }, [customWorkspacePath, defaultWorkspaceId, onBrowseDirectory, resolvedWorkspacePath, selectedMachine, workspaceRows])

    const navigateBrowsePath = useCallback((path: string) => {
        if (!selectedMachine) return
        setBrowseBusy(true)
        setBrowseError('')
        void onBrowseDirectory(selectedMachine.id, path)
            .then(result => {
                setBrowseCurrentPath(result.path)
                setCustomWorkspacePath(result.path)
                setBrowseDirectories(result.directories)
            })
            .catch(error => {
                setBrowseError(error instanceof Error ? error.message : 'Could not load folder')
            })
            .finally(() => setBrowseBusy(false))
    }, [onBrowseDirectory, selectedMachine])

    const handleSaveCurrentWorkspace = useCallback(async () => {
        if (!selectedMachine || !resolvedWorkspacePath) return
        setSavingWorkspace(true)
        setMessage('')
        const result = await onSaveWorkspace(selectedMachine.id, resolvedWorkspacePath)
        setSavingWorkspace(false)
        if (!result.ok) {
            setMessage(result.error || 'Could not save workspace')
            return
        }
        setMessage('Workspace saved. It will appear in the list once the machine state refreshes.')
    }, [onSaveWorkspace, resolvedWorkspacePath, selectedMachine])

    const handleLaunch = useCallback(async () => {
        if (!selectedMachine || !activeKind || !selectedTarget) return
        setBusy(true)
        setMessage('')
        const result = activeKind === 'ide'
            ? await onLaunchIde(selectedMachine.id, selectedTarget, {
                workspacePath: resolvedWorkspacePath || null,
            })
            : await onLaunchProvider(selectedMachine.id, activeKind, selectedTarget, {
                workspaceId: workspaceChoice !== '__home__' && workspaceChoice !== '__custom__' ? workspaceChoice : null,
                workspacePath: workspaceChoice === '__custom__' ? resolvedWorkspacePath || null : null,
            })
        setBusy(false)
        if (!result.ok) {
            setMessage(result.error || 'Could not start session')
            return
        }
        onClose()
    }, [activeKind, onClose, onLaunchIde, onLaunchProvider, resolvedWorkspacePath, selectedMachine, selectedTarget, workspaceChoice])

    if (!selectedMachine) {
        return null
    }

    return (
        <>
            <div
                className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/60 backdrop-blur-[2px]"
                role="dialog"
                aria-modal="true"
                aria-labelledby="dashboard-new-title"
            >
                <div className="w-full max-w-3xl max-h-[min(88vh,860px)] rounded-2xl border border-border-subtle bg-bg-secondary shadow-xl overflow-hidden flex flex-col">
                    <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border-subtle">
                        <div className="min-w-0">
                            <h2 id="dashboard-new-title" className="m-0 text-base font-semibold text-text-primary">
                                New session
                            </h2>
                            <p className="m-0 mt-1 text-xs leading-relaxed text-text-muted">
                                Pick a machine, choose a workspace, then start IDE, CLI, or ACP without leaving the dashboard.
                            </p>
                        </div>
                        <button
                            type="button"
                            className="inline-flex items-center justify-center w-8 h-8 rounded-full border border-border-subtle bg-bg-primary text-text-secondary hover:text-text-primary hover:bg-surface-primary transition-colors shrink-0"
                            onClick={onClose}
                            aria-label="Close new session dialog"
                        >
                            <IconX size={16} />
                        </button>
                    </div>

                    <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
                        <div className="rounded-xl border border-border-subtle bg-bg-primary px-4 py-3">
                            <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-1">Machine</div>
                            <select
                                value={selectedMachine.id}
                                onChange={(event) => setSelectedMachineId(event.target.value)}
                                className="w-full rounded-lg border border-border-subtle bg-bg-secondary text-text-primary px-3 py-2.5 text-sm"
                                disabled={busy}
                            >
                                {sortedMachines.map(machine => (
                                    <option key={machine.id} value={machine.id}>
                                        {getMachineDisplayName(machine, { fallbackId: machine.id })}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div className="rounded-xl border border-border-subtle bg-bg-primary px-4 py-3">
                            <div className="flex items-center justify-between gap-3 mb-2">
                                <div>
                                    <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted">Workspace</div>
                                    <div className="text-xs text-text-secondary mt-1">Saved workspace is preferred. Home and custom folders are still available.</div>
                                </div>
                                <button
                                    type="button"
                                    className="btn btn-secondary btn-sm"
                                    onClick={openBrowseDialog}
                                    disabled={busy}
                                >
                                    Browse…
                                </button>
                            </div>
                            <select
                                value={workspaceChoice}
                                onChange={(event) => {
                                    const next = event.target.value
                                    setWorkspaceChoice(next)
                                    if (next === '__custom__') {
                                        openBrowseDialog()
                                    } else {
                                        setMessage('')
                                    }
                                }}
                                className="w-full rounded-lg border border-border-subtle bg-bg-secondary text-text-primary px-3 py-2.5 text-sm"
                                disabled={busy}
                            >
                                <option value="__home__">Home directory</option>
                                {workspaceRows.map(workspace => (
                                    <option key={workspace.id} value={workspace.id}>
                                        {workspace.id === defaultWorkspaceId ? '⭐ ' : ''}{getWorkspaceDisplayLabel(workspace.path, workspace.label) || workspace.path}
                                    </option>
                                ))}
                                <option value="__custom__">Custom folder…</option>
                            </select>
                            <div className="mt-2 text-[11px] text-text-muted break-all">
                                {workspaceChoice === '__home__'
                                    ? 'Launch without a workspace.'
                                    : resolvedWorkspacePath || 'Select a workspace folder.'}
                            </div>
                            {workspaceChoice === '__custom__' && resolvedWorkspacePath && (
                                <div className="mt-3 flex flex-wrap gap-2">
                                    <button
                                        type="button"
                                        className="btn btn-secondary btn-sm"
                                        onClick={openBrowseDialog}
                                        disabled={busy}
                                    >
                                        <IconFolder size={14} />
                                        Select folder
                                    </button>
                                    <button
                                        type="button"
                                        className="btn btn-secondary btn-sm"
                                        onClick={handleSaveCurrentWorkspace}
                                        disabled={busy || savingWorkspace}
                                    >
                                        {savingWorkspace ? 'Saving…' : 'Save workspace'}
                                    </button>
                                </div>
                            )}
                        </div>

                        <div className="rounded-xl border border-border-subtle bg-bg-primary px-4 py-3">
                            <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-2">Category</div>
                            <div className="flex flex-wrap gap-2">
                                {([
                                    { id: 'ide', label: 'IDE', enabled: ideTargets.length > 0 },
                                    { id: 'cli', label: 'CLI', enabled: cliProviders.length > 0 },
                                    { id: 'acp', label: 'ACP', enabled: acpProviders.length > 0 },
                                ] as const).map(kind => (
                                    <button
                                        key={kind.id}
                                        type="button"
                                        className={`btn btn-sm ${activeKind === kind.id ? 'btn-primary' : 'btn-secondary'}`}
                                        onClick={() => setActiveKind(kind.id)}
                                        disabled={!kind.enabled || busy}
                                    >
                                        {kind.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="rounded-xl border border-border-subtle bg-bg-primary px-4 py-3">
                            <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-2">
                                {activeKind === 'ide' ? 'Choose IDE' : activeKind === 'cli' ? 'Choose CLI provider' : 'Choose ACP provider'}
                            </div>
                            <div className="grid grid-cols-1 gap-2">
                                {providerTargets.map(target => (
                                    <button
                                        key={target.id}
                                        type="button"
                                        className={`w-full rounded-xl border px-3.5 py-3 text-left transition-colors ${selectedTarget === target.id ? 'border-accent bg-accent/10' : 'border-border-subtle bg-bg-secondary/40 hover:bg-bg-secondary/70'}`}
                                        onClick={() => setSelectedTarget(target.id)}
                                        disabled={busy}
                                    >
                                        <div className="text-sm font-semibold text-text-primary">{target.label}</div>
                                        <div className="text-xs text-text-secondary mt-1">{target.meta}</div>
                                    </button>
                                ))}
                                {providerTargets.length === 0 && (
                                    <div className="text-sm text-text-muted">Nothing available for this category on the selected machine.</div>
                                )}
                            </div>
                        </div>

                        {message && (
                            <div className={`rounded-xl border px-4 py-3 text-sm ${message.includes('saved') || message.includes('requested') ? 'border-accent/25 bg-accent/10 text-text-primary' : 'border-status-error/25 bg-status-error/10 text-status-error'}`}>
                                {message}
                            </div>
                        )}
                    </div>

                    <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border-subtle bg-bg-secondary">
                        <button
                            type="button"
                            className="machine-btn text-xs"
                            onClick={onClose}
                            disabled={busy}
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            className="btn btn-primary h-9 px-4 text-sm font-semibold inline-flex items-center gap-2"
                            onClick={handleLaunch}
                            disabled={busy || !activeKind || !selectedTarget || (workspaceChoice === '__custom__' && !resolvedWorkspacePath)}
                        >
                            <IconPlay size={14} />
                            {busy ? 'Starting…' : 'Start session'}
                        </button>
                    </div>
                </div>
            </div>

            {browseDialogOpen && (
                <WorkspaceBrowseDialog
                    title="Select workspace"
                    description="Pick the folder that should be used for this new session."
                    currentPath={browseCurrentPath}
                    directories={browseDirectories}
                    busy={browseBusy}
                    error={browseError}
                    onClose={() => setBrowseDialogOpen(false)}
                    onNavigate={navigateBrowsePath}
                    onConfirm={(path) => {
                        setCustomWorkspacePath(path)
                        setBrowseCurrentPath(path)
                        setWorkspaceChoice('__custom__')
                        setBrowseDialogOpen(false)
                    }}
                />
            )}
        </>
    )
}
