import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DaemonData } from '../../types'
import { useDaemonMetadataLoader } from '../../hooks/useDaemonMetadataLoader'
import { compareMachineEntries, getMachineDisplayName, getWorkspaceDisplayLabel } from '../../utils/daemon-utils'
import {
    getCliLaunchBusyLabel,
    getCliLaunchPrimaryActionLabel,
    getCliResumeSelectPlaceholder,
    getHostedRuntimeReviewButtonLabel,
    getOpenHistoryLabel,
} from '../../utils/dashboard-launch-copy'
import { IconFolder, IconPlay, IconServer, IconX } from '../Icons'
import WorkspaceBrowseDialog from '../machine/WorkspaceBrowseDialog'
import { collectBrowsePathCandidates, getDefaultBrowseStartPath, type BrowseDirectoryResult } from '../machine/workspaceBrowse'
import { getRecentLaunchArgs, pushRecentLaunchArgs } from '../../utils/recentLaunchArgs'
import HistoryModal from './HistoryModal'
import type { ActiveConversation } from './types'
import DashboardMobileSessionHostSheet from './DashboardMobileSessionHostSheet'
import { getMobileMachineConnectionLabel } from './dashboard-mobile-chat-mode-helpers'

type LaunchKind = 'ide' | 'cli' | 'acp'

interface SavedSessionOption {
    id: string
    providerSessionId: string
    providerType: string
    providerName: string
    kind: 'cli' | 'acp'
    title: string
    workspace?: string | null
    currentModel?: string
    preview?: string
    messageCount: number
    firstMessageAt: number
    lastMessageAt: number
    canResume: boolean
}

interface DashboardNewSessionDialogProps {
    machines: DaemonData[]
    conversations: ActiveConversation[]
    ides: DaemonData[]
    onClose: () => void
    onBrowseDirectory: (machineId: string, path: string) => Promise<BrowseDirectoryResult>
    onSaveWorkspace: (machineId: string, path: string) => Promise<{ ok: boolean; error?: string }>
    onLaunchIde: (machineId: string, ideType: string, opts?: { workspacePath?: string | null }) => Promise<{ ok: boolean; error?: string }>
    onLaunchProvider: (
        machineId: string,
        kind: 'cli' | 'acp',
        providerType: string,
        opts?: {
            workspaceId?: string | null
            workspacePath?: string | null
            resumeSessionId?: string | null
            cliArgs?: string[]
            initialModel?: string | null
        },
    ) => Promise<{ ok: boolean; error?: string }>
    onListSavedSessions: (machineId: string, providerType: string) => Promise<SavedSessionOption[]>
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
    onOpenConversation: (conversation: ActiveConversation) => void
}

function getDefaultLaunchKind(machine: DaemonData | undefined) {
    if (!machine) return null
    const providers = machine.availableProviders || []
    if (providers.some(provider => provider.category === 'cli' && provider.installed !== false)) return 'cli' as const
    const hasIde = (machine.detectedIdes?.length || 0) > 0
    if (hasIde) return 'ide' as const
    if (providers.some(provider => provider.category === 'acp' && provider.installed !== false)) return 'acp' as const
    return null
}

function normalizePath(path: string | null | undefined) {
    return String(path || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase()
}

export default function DashboardNewSessionDialog({
    machines,
    conversations,
    ides,
    onClose,
    onBrowseDirectory,
    onSaveWorkspace,
    onLaunchIde,
    onLaunchProvider,
    onListSavedSessions,
    sendDaemonCommand,
    onOpenConversation,
}: DashboardNewSessionDialogProps) {
    const loadDaemonMetadata = useDaemonMetadataLoader()
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
        () => (selectedMachine?.workspaces || []).map(w => ({ id: w.id, path: w.path, label: w.label })),
        [selectedMachine],
    )
    const defaultWorkspaceId = selectedMachine?.defaultWorkspaceId || null
    const [workspaceChoice, setWorkspaceChoice] = useState<string>('')
    const [customWorkspacePath, setCustomWorkspacePath] = useState('')
    const [activeKind, setActiveKind] = useState<LaunchKind | null>(getDefaultLaunchKind(sortedMachines[0]))
    const [selectedTarget, setSelectedTarget] = useState('')
    const [launchArgs, setLaunchArgs] = useState('')
    const [recentArgsOptions, setRecentArgsOptions] = useState<string[]>([])
    const [selectedResumeSessionId, setSelectedResumeSessionId] = useState('')
    const [savedSessions, setSavedSessions] = useState<SavedSessionOption[]>([])
    const [savedSessionsLoading, setSavedSessionsLoading] = useState(false)
    const [savedSessionsError, setSavedSessionsError] = useState('')
    const [resumeHistoryOpen, setResumeHistoryOpen] = useState(false)
    const [sessionHostOpen, setSessionHostOpen] = useState(false)
    const [resumingSavedSessionId, setResumingSavedSessionId] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState('')
    const [browseDialogOpen, setBrowseDialogOpen] = useState(false)
    const [browseCurrentPath, setBrowseCurrentPath] = useState('')
    const [browseDirectories, setBrowseDirectories] = useState<Array<{ name: string; path: string }>>([])
    const [browseBusy, setBrowseBusy] = useState(false)
    const [browseError, setBrowseError] = useState('')
    const [savingWorkspace, setSavingWorkspace] = useState(false)
    const initializedMachineIdRef = useRef<string | null>(null)
    const savedSessionsRequestSeqRef = useRef(0)

    useEffect(() => {
        if (!selectedMachineId && sortedMachines[0]?.id) {
            setSelectedMachineId(sortedMachines[0].id)
        }
    }, [selectedMachineId, sortedMachines])

    useEffect(() => {
        if (!selectedMachine) return
        const needsMetadata = !selectedMachine.workspaces
            || !selectedMachine.availableProviders
            || !selectedMachine.detectedIdes
            || !selectedMachine.recentLaunches
        if (!needsMetadata) return
        void loadDaemonMetadata(selectedMachine.id, { minFreshMs: 30_000 }).catch(() => {})
    }, [loadDaemonMetadata, selectedMachine])

    const cliProviders = useMemo(
        () => ((selectedMachine?.availableProviders || []).filter(provider => provider.category === 'cli' && provider.installed !== false)),
        [selectedMachine],
    )
    const acpProviders = useMemo(
        () => ((selectedMachine?.availableProviders || []).filter(provider => provider.category === 'acp' && provider.installed !== false)),
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
            setLaunchArgs('')
            setSelectedResumeSessionId('')
            setSavedSessions([])
            setSavedSessionsError('')
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

    const loadSavedSessions = useCallback(async (machineId: string, providerType: string) => {
        const requestSeq = savedSessionsRequestSeqRef.current + 1
        savedSessionsRequestSeqRef.current = requestSeq
        setSavedSessionsLoading(true)
        setSavedSessionsError('')
        return onListSavedSessions(machineId, providerType)
            .then((sessions) => {
                if (savedSessionsRequestSeqRef.current !== requestSeq) return
                setSavedSessions(sessions)
            })
            .catch((error) => {
                if (savedSessionsRequestSeqRef.current !== requestSeq) return
                setSavedSessions([])
                setSavedSessionsError(error instanceof Error ? error.message : 'Could not load saved sessions')
            })
            .finally(() => {
                if (savedSessionsRequestSeqRef.current !== requestSeq) return
                setSavedSessionsLoading(false)
            })
    }, [onListSavedSessions])

    const loadRecentArgs = useCallback((machineId: string, providerType: string) => {
        setRecentArgsOptions(getRecentLaunchArgs(machineId, providerType))
    }, [])

    useEffect(() => {
        setSelectedResumeSessionId('')
        if (!selectedMachine || !selectedTarget || activeKind === 'ide') {
            setRecentArgsOptions([])
        } else {
            loadRecentArgs(selectedMachine.id, selectedTarget)
        }
        if (activeKind !== 'cli') {
            setSavedSessions([])
            setSavedSessionsError('')
            setSavedSessionsLoading(false)
            return
        }
        if (!selectedMachine || !selectedTarget) {
            setSavedSessions([])
            setSavedSessionsError('')
            setSavedSessionsLoading(false)
            return
        }
        void loadSavedSessions(selectedMachine.id, selectedTarget)
    }, [activeKind, loadRecentArgs, loadSavedSessions, selectedMachine, selectedTarget])

    useEffect(() => {
        if (!selectedResumeSessionId) return
        const selectedSession = savedSessions.find(session => session.providerSessionId === selectedResumeSessionId)
        if (selectedSession?.canResume) return
        setSelectedResumeSessionId('')
    }, [savedSessions, selectedResumeSessionId])

    const resolvedWorkspacePath = workspaceChoice === '__custom__'
        ? customWorkspacePath.trim()
        : workspaceChoice === '__home__'
            ? ''
            : (workspaceRows.find(workspace => workspace.id === workspaceChoice)?.path || '')

    const machineSessionWorkspaceCandidates = useMemo(
        () => {
            if (!selectedMachine) return []
            return ides
                .filter(entry => entry.id !== selectedMachine.id && entry.daemonId === selectedMachine.id)
                .map(entry => entry.workspace)
        },
        [ides, selectedMachine],
    )

    const machineRecentWorkspaceCandidates = useMemo(
        () => (selectedMachine?.recentLaunches || []).map(launch => launch.workspace),
        [selectedMachine],
    )

    const applySavedSessionWorkspace = useCallback((session: SavedSessionOption) => {
        const sessionWorkspace = String(session.workspace || '').trim()
        if (!sessionWorkspace) return
        const matchedWorkspace = workspaceRows.find(workspace => normalizePath(workspace.path) === normalizePath(sessionWorkspace))
        if (matchedWorkspace) {
            setWorkspaceChoice(matchedWorkspace.id)
            setCustomWorkspacePath('')
            return
        }
        setWorkspaceChoice('__custom__')
        setCustomWorkspacePath(sessionWorkspace)
    }, [workspaceRows])

    const resolveSavedSessionLaunchTarget = useCallback((session: SavedSessionOption) => {
        const sessionWorkspace = String(session.workspace || '').trim()
        if (!sessionWorkspace) {
            return { workspaceId: null, workspacePath: null }
        }
        const matchedWorkspace = workspaceRows.find(workspace => normalizePath(workspace.path) === normalizePath(sessionWorkspace))
        if (matchedWorkspace) {
            return { workspaceId: matchedWorkspace.id, workspacePath: null }
        }
        return { workspaceId: null, workspacePath: sessionWorkspace }
    }, [workspaceRows])

    const resumeHistoryConversation = useMemo<ActiveConversation | null>(() => {
        if (activeKind !== 'cli' || !selectedMachine || !selectedTarget) return null
        const providerLabel = cliProviders.find(provider => provider.type === selectedTarget)?.displayName || selectedTarget
        return {
            routeId: selectedMachine.id,
            daemonId: selectedMachine.id,
            providerSessionId: selectedResumeSessionId || undefined,
            transport: 'pty',
            mode: 'chat',
            agentName: providerLabel,
            agentType: selectedTarget,
            status: 'idle',
            title: providerLabel,
            messages: [],
            ideType: selectedTarget,
            workspaceName: resolvedWorkspacePath,
            displayPrimary: providerLabel,
            displaySecondary: 'CLI',
            streamSource: 'native',
            tabKey: `dashboard:new-session:resume-history:${selectedMachine.id}:${selectedTarget}`,
            machineName: getMachineDisplayName(selectedMachine, { fallbackId: selectedMachine.id }),
        }
    }, [activeKind, cliProviders, resolvedWorkspacePath, selectedMachine, selectedResumeSessionId, selectedTarget])

    const openBrowseDialog = useCallback(() => {
        if (!selectedMachine) return
        setWorkspaceChoice('__custom__')
        setBrowseDialogOpen(true)
        setBrowseError('')
        const initialPath = getDefaultBrowseStartPath(
            selectedMachine.platform,
            collectBrowsePathCandidates(
                customWorkspacePath.trim(),
                resolvedWorkspacePath,
                machineSessionWorkspaceCandidates,
                machineRecentWorkspaceCandidates,
                selectedMachine.defaultWorkspacePath,
                workspaceRows.find(workspace => workspace.id === defaultWorkspaceId)?.path,
                workspaceRows.map(workspace => workspace.path),
            ),
        )
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
    }, [
        customWorkspacePath,
        defaultWorkspaceId,
        machineRecentWorkspaceCandidates,
        machineSessionWorkspaceCandidates,
        onBrowseDirectory,
        resolvedWorkspacePath,
        selectedMachine,
        workspaceRows,
    ])

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
        const parsedArgs = launchArgs.trim()
            ? launchArgs.trim().split(/\s+/).filter(Boolean)
            : []
        const result = activeKind === 'ide'
            ? await onLaunchIde(selectedMachine.id, selectedTarget, {
                workspacePath: resolvedWorkspacePath || null,
            })
            : await onLaunchProvider(selectedMachine.id, activeKind, selectedTarget, {
                workspaceId: workspaceChoice !== '__home__' && workspaceChoice !== '__custom__' ? workspaceChoice : null,
                workspacePath: workspaceChoice === '__custom__' ? resolvedWorkspacePath || null : null,
                resumeSessionId: activeKind === 'cli' && selectedResumeSessionId ? selectedResumeSessionId : null,
                cliArgs: parsedArgs,
            })
        setBusy(false)
        if (!result.ok) {
            setMessage(result.error || 'Could not start session')
            return
        }
        if (activeKind !== 'ide' && launchArgs.trim()) {
            pushRecentLaunchArgs(selectedMachine.id, selectedTarget, launchArgs)
            loadRecentArgs(selectedMachine.id, selectedTarget)
        }
        onClose()
    }, [
        activeKind,
        launchArgs,
        loadRecentArgs,
        onClose,
        onLaunchIde,
        onLaunchProvider,
        resolvedWorkspacePath,
        selectedMachine,
        selectedResumeSessionId,
        selectedTarget,
        workspaceChoice,
    ])

    const primaryActionLabel = activeKind === 'cli'
        ? getCliLaunchPrimaryActionLabel(!!selectedResumeSessionId)
        : activeKind === 'ide'
            ? 'Start IDE'
            : activeKind === 'acp'
                ? 'Start ACP session'
                : 'Start'
    const primaryBusyLabel = activeKind === 'cli'
        ? getCliLaunchBusyLabel(!!selectedResumeSessionId)
        : 'Starting…'

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
                                Start or recover session
                            </h2>
                            <p className="m-0 mt-1 text-xs leading-relaxed text-text-muted">
                                Pick a machine and workspace, then choose whether to start fresh, resume saved history, or recover a hosted runtime.
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

                        {activeKind === 'cli' && (
                            <div className="rounded-xl border border-border-subtle bg-bg-primary px-4 py-3">
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted">Hosted runtimes</div>
                                        <div className="text-xs text-text-secondary mt-1">
                                            Review live runtimes, recovery snapshots, and recover or restart options without leaving this launch flow.
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        className="btn btn-secondary btn-sm"
                                        disabled={busy || !selectedMachine}
                                        onClick={() => setSessionHostOpen(true)}
                                    >
                                        <IconServer size={14} />
                                        {getHostedRuntimeReviewButtonLabel()}
                                    </button>
                                </div>
                            </div>
                        )}

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
                                    { id: 'cli', label: 'CLI', enabled: cliProviders.length > 0 },
                                    { id: 'ide', label: 'IDE', enabled: ideTargets.length > 0 },
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
                                    <div className="text-sm text-text-muted">
                                        Nothing usable for this category on the selected machine. Set a custom executable path in Providers if the binary lives outside the default location.
                                    </div>
                                )}
                            </div>
                        </div>

                        {activeKind !== 'ide' && (
                            <div className="rounded-xl border border-border-subtle bg-bg-primary px-4 py-3">
                                <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-1">Startup arguments</div>
                                <input
                                    type="text"
                                    value={launchArgs}
                                    onChange={(event) => setLaunchArgs(event.target.value)}
                                    placeholder="Optional flags..."
                                    className="w-full rounded-lg border border-border-subtle bg-bg-secondary text-text-primary px-3 py-2.5 text-sm"
                                    disabled={busy}
                                />
                                {recentArgsOptions.length > 0 && (
                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                        {recentArgsOptions.map(argsOption => (
                                            <button
                                                key={argsOption}
                                                type="button"
                                                className="btn btn-secondary btn-sm"
                                                onClick={() => setLaunchArgs(argsOption)}
                                                disabled={busy}
                                                title={argsOption}
                                            >
                                                {argsOption}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {activeKind === 'cli' && (
                            <div className="rounded-xl border border-border-subtle bg-bg-primary px-4 py-3">
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted">Resume saved history</div>
                                        <div className="text-xs text-text-secondary mt-1">Pick a saved CLI session when you want continuity. Leave this empty to start fresh.</div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            type="button"
                                            className="btn btn-secondary btn-sm"
                                            disabled={busy || !selectedMachine || !selectedTarget || savedSessionsLoading}
                                            onClick={() => {
                                                if (!selectedMachine || !selectedTarget) return
                                                void loadSavedSessions(selectedMachine.id, selectedTarget)
                                            }}
                                        >
                                            {savedSessionsLoading ? 'Loading…' : 'Refresh'}
                                        </button>
                                        <button
                                            type="button"
                                            className="btn btn-secondary btn-sm"
                                            disabled={busy || !selectedMachine || !selectedTarget}
                                            onClick={() => {
                                                if (!selectedMachine || !selectedTarget) return
                                                setResumeHistoryOpen(true)
                                                void loadSavedSessions(selectedMachine.id, selectedTarget)
                                            }}
                                        >
                                            {getOpenHistoryLabel()}
                                        </button>
                                    </div>
                                </div>
                                <div className="mt-2">
                                    <select
                                        value={selectedResumeSessionId}
                                        onChange={(event) => {
                                            const nextId = event.target.value
                                            setSelectedResumeSessionId(nextId)
                                            if (!nextId) return
                                            const session = savedSessions.find(item => item.providerSessionId === nextId)
                                            if (!session || !session.canResume) return
                                            applySavedSessionWorkspace(session)
                                        }}
                                        className="w-full rounded-lg border border-border-subtle bg-bg-secondary text-text-primary px-3 py-2.5 text-sm"
                                        disabled={busy || savedSessionsLoading}
                                    >
                                        <option value="">{getCliResumeSelectPlaceholder()}</option>
                                        {savedSessions.map(session => (
                                            <option
                                                key={session.providerSessionId}
                                                value={session.providerSessionId}
                                                disabled={!session.canResume}
                                            >
                                                {session.title || session.providerSessionId}
                                                {!session.canResume ? ' (workspace missing)' : ''}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                {selectedResumeSessionId && (() => {
                                    const selectedSession = savedSessions.find(session => session.providerSessionId === selectedResumeSessionId)
                                    if (!selectedSession) return null
                                    return (
                                        <div className="mt-2 text-[11px] text-text-muted leading-relaxed">
                                            <div className="font-mono break-all">{selectedSession.providerSessionId}</div>
                                            <div className="mt-1">
                                                {selectedSession.workspace || 'Workspace unknown'}
                                                {selectedSession.currentModel ? ` · ${selectedSession.currentModel}` : ''}
                                            </div>
                                        </div>
                                    )
                                })()}
                                {savedSessionsError && (
                                    <div className="mt-2 text-[11px] text-status-error">
                                        {savedSessionsError}
                                    </div>
                                )}
                                {!savedSessionsLoading && !savedSessionsError && savedSessions.length === 0 && (
                                    <div className="mt-2 text-[11px] text-text-muted">
                                        No saved sessions found for this provider yet.
                                    </div>
                                )}
                            </div>
                        )}

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
                            {busy ? primaryBusyLabel : primaryActionLabel}
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
            {resumeHistoryOpen && resumeHistoryConversation && (
                <HistoryModal
                    activeConv={resumeHistoryConversation}
                    ides={[]}
                    isCreatingChat={false}
                    isRefreshingHistory={savedSessionsLoading}
                    savedSessions={savedSessions}
                    isSavedSessionsLoading={savedSessionsLoading}
                    isResumingSavedSessionId={resumingSavedSessionId}
                    onClose={() => setResumeHistoryOpen(false)}
                    onNewChat={() => {
                        setSelectedResumeSessionId('')
                        setResumeHistoryOpen(false)
                    }}
                    onSwitchSession={() => {}}
                    onRefreshHistory={() => {
                        if (!selectedMachine || !selectedTarget) return
                        void loadSavedSessions(selectedMachine.id, selectedTarget)
                    }}
                    onResumeSavedSession={(session) => {
                        if (!selectedMachine || !selectedTarget || resumingSavedSessionId || !session.canResume) return
                        const launchTarget = resolveSavedSessionLaunchTarget(session)
                        setSelectedResumeSessionId(session.providerSessionId)
                        applySavedSessionWorkspace(session)
                        setResumingSavedSessionId(session.providerSessionId)
                        setResumeHistoryOpen(false)
                        setBusy(true)
                        setMessage('')
                        void onLaunchProvider(selectedMachine.id, 'cli', selectedTarget, {
                            workspaceId: launchTarget.workspaceId,
                            workspacePath: launchTarget.workspacePath,
                            resumeSessionId: session.providerSessionId,
                        }).then((result) => {
                            if (!result.ok) {
                                setMessage(result.error || 'Could not resume session')
                                return
                            }
                            onClose()
                        }).finally(() => {
                            setBusy(false)
                            setResumingSavedSessionId(current => (
                                current === session.providerSessionId ? null : current
                            ))
                        })
                    }}
                />
            )}
            {sessionHostOpen && selectedMachine && (
                <DashboardMobileSessionHostSheet
                    machineCards={[{
                        id: selectedMachine.id,
                        label: getMachineDisplayName(selectedMachine, { fallbackId: selectedMachine.id }),
                        subtitle: [selectedMachine.platform || 'machine', getMobileMachineConnectionLabel(selectedMachine)].filter(Boolean).join(' · '),
                        unread: 0,
                        total: 0,
                        latestConversation: null,
                        preview: '',
                    }]}
                    conversations={conversations}
                    ides={ides}
                    initialMachineId={selectedMachine.id}
                    sendDaemonCommand={sendDaemonCommand}
                    onOpenConversation={(conversation) => {
                        setSessionHostOpen(false)
                        onClose()
                        onOpenConversation(conversation)
                    }}
                    onClose={() => setSessionHostOpen(false)}
                />
            )}
        </>
    )
}
