import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DaemonData } from '../../types'
import { useDaemonMetadataLoader } from '../../hooks/useDaemonMetadataLoader'
import { compareMachineEntries, getMachineDisplayName, getWorkspaceDisplayLabel } from '../../utils/daemon-utils'
import {
    getLaunchPrimaryActionLabel,
    getLaunchPrimaryBusyLabel,
} from '../../utils/dashboard-launch-copy'
import { IconFolder, IconPlay, IconX } from '../Icons'
import WorkspaceBrowseDialog from '../machine/WorkspaceBrowseDialog'
import { collectBrowsePathCandidates, getDefaultBrowseStartPath, type BrowseDirectoryResult } from '../machine/workspaceBrowse'
import { getRecentLaunchArgs, pushRecentLaunchArgs } from '../../utils/recentLaunchArgs'
import HistoryModal from './HistoryModal'
import type { ActiveConversation } from './types'
import { createSavedHistoryFilterState, type SavedHistoryFilterState } from '../../utils/saved-history-filter-state'
import { shouldRefreshSavedHistoryOnModalOpen } from '../../utils/saved-history-load-state'
import SavedHistoryLaunchSection from '../SavedHistoryLaunchSection'
import LaunchSectionCard from '../LaunchSectionCard'
import { isLaunchableMachineProvider } from '../../utils/provider-activation'
import type { LaunchResult, MeshLaunchOption } from '../../hooks/useDashboardCommandActions'
import MeshCoordinatorManualSetupPanel from '../MeshCoordinatorManualSetupPanel'
import { buildManualCoordinatorSetup, type MeshCoordinatorManualSetup } from '../../utils/mesh-coordinator-setup'

type LaunchKind = 'ide' | 'cli' | 'acp'
type WorkspaceLaunchMode = 'workspace' | 'mesh'

interface SavedSessionOption {
    id: string
    providerSessionId: string
    providerType: string
    providerName: string
    kind: 'cli' | 'acp'
    title: string
    workspace?: string | null
    summaryMetadata?: DaemonData['summaryMetadata']
    preview?: string
    messageCount: number
    firstMessageAt: number
    lastMessageAt: number
    canResume: boolean
}

interface DashboardNewSessionDialogProps {
    machines: DaemonData[]
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
    onListMeshes: (machineId: string) => Promise<MeshLaunchOption[]>
    onLaunchMeshCoordinator: (machineId: string, meshId: string, cliType: string) => Promise<LaunchResult>
    onListSavedSessions: (machineId: string, providerType: string) => Promise<SavedSessionOption[]>
}

interface LaunchCategorySelectorProps {
    workspaceMode: WorkspaceLaunchMode
    activeKind: LaunchKind | null
    cliEnabled: boolean
    ideEnabled: boolean
    acpEnabled: boolean
    busy: boolean
    onSelect: (kind: LaunchKind) => void
}

export function LaunchCategorySelector({
    workspaceMode,
    activeKind,
    cliEnabled,
    ideEnabled,
    acpEnabled,
    busy,
    onSelect,
}: LaunchCategorySelectorProps) {
    if (workspaceMode === 'mesh') return null

    return (
        <div className="rounded-xl border border-border-subtle bg-bg-primary px-4 py-3">
            <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-2">Category</div>
            <div className="flex flex-wrap gap-2">
                {([
                    { id: 'cli', label: 'CLI', enabled: cliEnabled },
                    { id: 'ide', label: 'Workspace', enabled: ideEnabled },
                    { id: 'acp', label: 'ACP', enabled: acpEnabled },
                ] as const).map(kind => (
                    <button
                        key={kind.id}
                        type="button"
                        className={`btn btn-sm ${activeKind === kind.id ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => onSelect(kind.id)}
                        disabled={!kind.enabled || busy}
                    >
                        {kind.label}
                    </button>
                ))}
            </div>
        </div>
    )
}

function getDefaultLaunchKind(machine: DaemonData | undefined) {
    if (!machine) return null
    const providers = machine.availableProviders || []
    if (providers.some(provider => isLaunchableMachineProvider(provider, 'cli'))) return 'cli' as const
    const hasIde = (machine.detectedIdes?.length || 0) > 0
    if (hasIde) return 'ide' as const
    if (providers.some(provider => isLaunchableMachineProvider(provider, 'acp'))) return 'acp' as const
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
    ides,
    onClose,
    onBrowseDirectory,
    onSaveWorkspace,
    onLaunchIde,
    onLaunchProvider,
    onListMeshes,
    onLaunchMeshCoordinator,
    onListSavedSessions,
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
    const [workspaceMode, setWorkspaceMode] = useState<WorkspaceLaunchMode>('workspace')
    const [workspaceChoice, setWorkspaceChoice] = useState<string>('')
    const [customWorkspacePath, setCustomWorkspacePath] = useState('')
    const [meshOptions, setMeshOptions] = useState<MeshLaunchOption[]>([])
    const [selectedMeshId, setSelectedMeshId] = useState('')
    const [meshLoading, setMeshLoading] = useState(false)
    const [meshLoadedMachineId, setMeshLoadedMachineId] = useState<string | null>(null)
    const [meshError, setMeshError] = useState('')
    const [activeKind, setActiveKind] = useState<LaunchKind | null>(getDefaultLaunchKind(sortedMachines[0]))
    const [selectedTarget, setSelectedTarget] = useState('')
    const [launchArgs, setLaunchArgs] = useState('')
    const [recentArgsOptions, setRecentArgsOptions] = useState<string[]>([])
    const [selectedResumeSessionId, setSelectedResumeSessionId] = useState('')
    const [savedSessions, setSavedSessions] = useState<SavedSessionOption[]>([])
    const [savedSessionsLoading, setSavedSessionsLoading] = useState(false)
    const [savedSessionsLoaded, setSavedSessionsLoaded] = useState(false)
    const [savedSessionsError, setSavedSessionsError] = useState('')
    const [resumeHistoryOpen, setResumeHistoryOpen] = useState(false)
    const [resumeHistoryFilters, setResumeHistoryFilters] = useState<SavedHistoryFilterState>(() => createSavedHistoryFilterState())
    const [resumingSavedSessionId, setResumingSavedSessionId] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState('')
    const [meshManualSetup, setMeshManualSetup] = useState<MeshCoordinatorManualSetup | null>(null)
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

    // Held-first prefetch: warm a machine's metadata as soon as the user hovers or
    // focuses its picker entry, so switching to it shows the held snapshot with no
    // empty-state flash. The loader is a background SWR freshen — cheap to call and
    // deduped/throttled internally.
    const prefetchMachineMetadata = useCallback((machineId: string) => {
        if (!machineId) return
        void loadDaemonMetadata(machineId, { minFreshMs: 30_000 }).catch(() => {})
    }, [loadDaemonMetadata])

    const cliProviders = useMemo(
        () => ((selectedMachine?.availableProviders || []).filter(provider => isLaunchableMachineProvider(provider, 'cli'))),
        [selectedMachine],
    )
    const acpProviders = useMemo(
        () => ((selectedMachine?.availableProviders || []).filter(provider => isLaunchableMachineProvider(provider, 'acp'))),
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

    const selectedMesh = useMemo(
        () => meshOptions.find(mesh => mesh.id === selectedMeshId) || null,
        [meshOptions, selectedMeshId],
    )
    const selectedCliProvider = useMemo(
        () => cliProviders.find(provider => provider.type === selectedTarget) || null,
        [cliProviders, selectedTarget],
    )
    const providerMeshManualSetup = useMemo(
        () => buildManualCoordinatorSetup(selectedCliProvider?.meshCoordinator, {
            meshId: selectedMesh?.id || '',
            workspace: selectedMesh?.workspace || '',
        }),
        [selectedCliProvider, selectedMesh],
    )
    const visibleMeshManualSetup = meshManualSetup || providerMeshManualSetup

    const loadMeshes = useCallback(async (machineId: string) => {
        setMeshLoading(true)
        setMeshError('')
        try {
            const meshes = await onListMeshes(machineId)
            setMeshOptions(meshes)
            setSelectedMeshId(prev => meshes.some(mesh => mesh.id === prev) ? prev : (meshes[0]?.id || ''))
            setMeshLoadedMachineId(machineId)
        } catch (error) {
            setMeshOptions([])
            setSelectedMeshId('')
            setMeshLoadedMachineId(machineId)
            setMeshError(error instanceof Error ? error.message : 'Could not load meshes')
        } finally {
            setMeshLoading(false)
        }
    }, [onListMeshes])

    useEffect(() => {
        if (!selectedMachine) return

        const machineChanged = initializedMachineIdRef.current !== selectedMachine.id
        if (machineChanged) {
            initializedMachineIdRef.current = selectedMachine.id
            setWorkspaceMode('workspace')
            setWorkspaceChoice(defaultWorkspaceId || workspaceRows[0]?.id || '__home__')
            setCustomWorkspacePath('')
            setMeshOptions([])
            setSelectedMeshId('')
            setMeshLoadedMachineId(null)
            setMeshError('')
            setActiveKind(getDefaultLaunchKind(selectedMachine))
            setSelectedTarget('')
            setLaunchArgs('')
            setSelectedResumeSessionId('')
            setSavedSessions([])
            setSavedSessionsLoaded(false)
            setSavedSessionsError('')
            setResumeHistoryFilters(createSavedHistoryFilterState())
            setMessage('')
            setMeshManualSetup(null)
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
        if (!selectedMachine || workspaceMode !== 'mesh') return
        if (meshLoadedMachineId === selectedMachine.id || meshLoading) return
        void loadMeshes(selectedMachine.id)
    }, [loadMeshes, meshLoadedMachineId, meshLoading, selectedMachine, workspaceMode])

    useEffect(() => {
        if (workspaceMode !== 'mesh') return
        if (activeKind !== 'cli' && cliProviders.length > 0) {
            setActiveKind('cli')
        }
    }, [activeKind, cliProviders.length, workspaceMode])

    useEffect(() => {
        if (!activeKind) return
        if (providerTargets.some(target => target.id === selectedTarget)) return
        setSelectedTarget(providerTargets[0]?.id || '')
    }, [activeKind, providerTargets, selectedTarget])

    useEffect(() => {
        setMeshManualSetup(null)
    }, [selectedMachine?.id, selectedMeshId, selectedTarget, workspaceMode])

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
                setSavedSessionsLoaded(true)
            })
    }, [onListSavedSessions])

    const loadRecentArgs = useCallback((machineId: string, providerType: string) => {
        setRecentArgsOptions(getRecentLaunchArgs(machineId, providerType))
    }, [])

    useEffect(() => {
        savedSessionsRequestSeqRef.current += 1
        setSelectedResumeSessionId('')
        setResumeHistoryFilters(createSavedHistoryFilterState())
        if (!selectedMachine || !selectedTarget || activeKind === 'ide') {
            setRecentArgsOptions([])
        } else {
            loadRecentArgs(selectedMachine.id, selectedTarget)
        }
        setSavedSessionsLoaded(false)
        setSavedSessions([])
        setSavedSessionsError('')
        setSavedSessionsLoading(false)
        if (activeKind !== 'cli') {
            return
        }
        if (!selectedMachine || !selectedTarget) {
            return
        }
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

    const selectedSavedSession = useMemo(
        () => savedSessions.find(session => session.providerSessionId === selectedResumeSessionId) || null,
        [savedSessions, selectedResumeSessionId],
    )

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
            workspacePath: resolvedWorkspacePath,
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
        if (!selectedMachine) return
        if (workspaceMode === 'mesh') {
            if (!selectedMeshId || !selectedTarget) return
            setBusy(true)
            setMessage('')
            setMeshManualSetup(null)
            const result = await onLaunchMeshCoordinator(selectedMachine.id, selectedMeshId, selectedTarget)
            setBusy(false)
            if (!result.ok) {
                if (result.code === 'mesh_coordinator_manual_mcp_setup_required' && result.manualSetup) {
                    setMeshManualSetup(result.manualSetup)
                    setMessage('Manual MCP setup required before this provider can act as mesh coordinator.')
                    return
                }
                setMessage(result.error || 'Could not start mesh coordinator')
                return
            }
            onClose()
            return
        }
        if (!activeKind || !selectedTarget) return
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
        onLaunchMeshCoordinator,
        onLaunchProvider,
        resolvedWorkspacePath,
        selectedMachine,
        selectedMeshId,
        selectedResumeSessionId,
        selectedTarget,
        workspaceChoice,
        workspaceMode,
    ])

    const primaryActionLabel = workspaceMode === 'mesh'
        ? 'Start mesh coordinator'
        : activeKind
            ? getLaunchPrimaryActionLabel(activeKind, activeKind === 'cli' && !!selectedResumeSessionId)
            : 'Start'
    const primaryBusyLabel = workspaceMode === 'mesh'
        ? 'Starting coordinator…'
        : activeKind
            ? getLaunchPrimaryBusyLabel(activeKind, activeKind === 'cli' && !!selectedResumeSessionId)
            : 'Starting…'
    const useMachineDropdown = sortedMachines.length > 5

    if (!selectedMachine) {
        return null
    }

    return (
        <>
            <div
                className="fixed inset-0 z-[var(--z-modal)] flex items-end justify-center overflow-y-auto bg-black/60 backdrop-blur-[2px] px-2 pt-[calc(8px+env(safe-area-inset-top,0px))] pb-[calc(8px+env(safe-area-inset-bottom,0px))] sm:items-center sm:p-4"
                role="dialog"
                aria-modal="true"
                aria-labelledby="dashboard-new-title"
            >
                <div className="w-full max-w-3xl max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-16px)] sm:max-h-[min(88vh,860px)] rounded-[24px] sm:rounded-2xl border border-border-subtle bg-bg-secondary shadow-xl overflow-hidden flex flex-col">
                    <div className="flex items-start justify-between gap-3 px-4 py-4 sm:px-5 border-b border-border-subtle shrink-0">
                        <div className="min-w-0">
                            <h2 id="dashboard-new-title" className="m-0 text-base font-semibold text-text-primary">
                                Start session
                            </h2>
                            <p className="m-0 mt-1 text-xs leading-relaxed text-text-muted">
                                Pick a machine and workspace, then choose whether to start fresh or resume saved history.
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

                    <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 sm:px-5 sm:py-4 space-y-4">
                        {/* Machine picker only when more than one machine is connected. */}
                        {sortedMachines.length > 1 && (
                            <LaunchSectionCard title="Machine">
                                {useMachineDropdown ? (
                                    <select
                                        aria-label="Machine"
                                        value={selectedMachine.id}
                                        onChange={(event) => setSelectedMachineId(event.target.value)}
                                        onFocus={() => sortedMachines.forEach(machine => prefetchMachineMetadata(machine.id))}
                                        className="w-full rounded-lg border border-border-subtle bg-bg-secondary text-text-primary px-3 py-2.5 text-sm"
                                        disabled={busy}
                                    >
                                        {sortedMachines.map(machine => (
                                            <option key={machine.id} value={machine.id}>
                                                {getMachineDisplayName(machine, { fallbackId: machine.id })}
                                            </option>
                                        ))}
                                    </select>
                                ) : (
                                    <div className="flex flex-wrap gap-2" role="group" aria-label="Machine">
                                        {sortedMachines.map(machine => {
                                            const label = getMachineDisplayName(machine, { fallbackId: machine.id })
                                            const selected = selectedMachine.id === machine.id
                                            return (
                                                <button
                                                    key={machine.id}
                                                    type="button"
                                                    aria-label={`Select machine ${label}`}
                                                    aria-pressed={selected}
                                                    className={`inline-flex min-w-0 items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors ${selected ? 'border-accent bg-accent/10 text-text-primary' : 'border-border-subtle bg-bg-secondary/60 text-text-secondary hover:bg-bg-secondary hover:text-text-primary'}`}
                                                    onClick={() => setSelectedMachineId(machine.id)}
                                                    onMouseEnter={() => prefetchMachineMetadata(machine.id)}
                                                    onFocus={() => prefetchMachineMetadata(machine.id)}
                                                    disabled={busy}
                                                    title={label}
                                                >
                                                    <span className={`h-2 w-2 shrink-0 rounded-full ${machine.status === 'offline' ? 'bg-text-muted' : 'bg-emerald-500'}`} />
                                                    <span className="truncate">{label}</span>
                                                </button>
                                            )
                                        })}
                                    </div>
                                )}
                            </LaunchSectionCard>
                        )}

                        <LaunchSectionCard
                            title="Workspace"
                            description="Start from a normal workspace, or select a repo mesh and run a mesh coordinator."
                            action={workspaceMode === 'workspace' ? (
                                <button
                                    type="button"
                                    className="btn btn-secondary btn-sm"
                                    onClick={openBrowseDialog}
                                    disabled={busy}
                                >
                                    Browse…
                                </button>
                            ) : undefined}
                        >
                            <div className="mb-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Launch target type">
                                {([
                                    { id: 'workspace', label: 'Workspace', desc: 'Normal session' },
                                    { id: 'mesh', label: 'Mesh', desc: 'Coordinator session' },
                                ] as const).map(option => (
                                    <button
                                        key={option.id}
                                        type="button"
                                        role="radio"
                                        aria-checked={workspaceMode === option.id}
                                        className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${workspaceMode === option.id ? 'border-accent bg-accent/10 text-text-primary' : 'border-border-subtle bg-bg-secondary/40 text-text-secondary hover:bg-bg-secondary/70 hover:text-text-primary'}`}
                                        onClick={() => {
                                            setWorkspaceMode(option.id)
                                            setMessage('')
                                            if (option.id === 'mesh' && selectedMachine && meshLoadedMachineId !== selectedMachine.id && !meshLoading) {
                                                void loadMeshes(selectedMachine.id)
                                            }
                                        }}
                                        disabled={busy}
                                    >
                                        <div className="text-sm font-semibold">{option.label}</div>
                                        <div className="mt-0.5 text-[11px] opacity-80">{option.desc}</div>
                                    </button>
                                ))}
                            </div>

                            {workspaceMode === 'workspace' ? (
                                <>
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
                                </>
                            ) : (
                                <div className="space-y-3">
                                    {meshLoading && (
                                        <div className="text-sm text-text-muted">Loading meshes…</div>
                                    )}
                                    {!meshLoading && meshError && (
                                        <div className="rounded-lg border border-status-error/25 bg-status-error/10 px-3 py-2 text-sm text-status-error">
                                            {meshError}
                                        </div>
                                    )}
                                    {!meshLoading && !meshError && meshOptions.length === 0 && (
                                        <div className="rounded-lg border border-border-subtle bg-bg-secondary/40 px-3 py-2 text-sm text-text-muted">
                                            No repo meshes are configured on this machine. Create or sync a mesh first, then reopen this picker.
                                        </div>
                                    )}
                                    {meshOptions.length > 0 && (
                                        <div className="grid grid-cols-1 gap-2" role="radiogroup" aria-label="Mesh">
                                            {meshOptions.map(mesh => (
                                                <button
                                                    key={mesh.id}
                                                    type="button"
                                                    role="radio"
                                                    aria-checked={selectedMeshId === mesh.id}
                                                    className={`w-full rounded-xl border px-3.5 py-3 text-left transition-colors ${selectedMeshId === mesh.id ? 'border-accent bg-accent/10' : 'border-border-subtle bg-bg-secondary/40 hover:bg-bg-secondary/70'}`}
                                                    onClick={() => setSelectedMeshId(mesh.id)}
                                                    disabled={busy}
                                                >
                                                    <div className="text-sm font-semibold text-text-primary">{mesh.name}</div>
                                                    <div className="mt-1 text-xs text-text-secondary">
                                                        {mesh.repoIdentity || 'Repo mesh'}{typeof mesh.nodesCount === 'number' ? ` · ${mesh.nodesCount} node${mesh.nodesCount === 1 ? '' : 's'}` : ''}
                                                    </div>
                                                    {mesh.workspace && (
                                                        <div className="mt-1 text-[11px] text-text-muted break-all">Coordinator workspace: {mesh.workspace}</div>
                                                    )}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                    {selectedMesh && (
                                        <div className="text-[11px] text-text-muted">
                                            Mesh coordinators use the selected CLI provider and the mesh's configured coordinator workspace.
                                        </div>
                                    )}
                                </div>
                            )}
                        </LaunchSectionCard>

                        <LaunchCategorySelector
                            workspaceMode={workspaceMode}
                            activeKind={activeKind}
                            cliEnabled={cliProviders.length > 0}
                            ideEnabled={ideTargets.length > 0}
                            acpEnabled={acpProviders.length > 0}
                            busy={busy}
                            onSelect={setActiveKind}
                        />

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

                        {workspaceMode === 'mesh' && visibleMeshManualSetup && (
                            <MeshCoordinatorManualSetupPanel
                                setup={visibleMeshManualSetup}
                                providerName={selectedCliProvider?.displayName || selectedCliProvider?.name || selectedTarget}
                            />
                        )}

                        {workspaceMode !== 'mesh' && activeKind !== 'ide' && (
                            <LaunchSectionCard title="Startup arguments">
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
                            </LaunchSectionCard>
                        )}

                        {workspaceMode !== 'mesh' && activeKind === 'cli' && (
                            <SavedHistoryLaunchSection
                                busy={busy}
                                savedSessionsLoading={savedSessionsLoading}
                                savedSessionsError={savedSessionsError}
                                selectedSession={selectedSavedSession}
                                onRefresh={() => {
                                    if (!selectedMachine || !selectedTarget) return
                                    void loadSavedSessions(selectedMachine.id, selectedTarget)
                                }}
                                onOpenHistory={() => {
                                    if (!selectedMachine || !selectedTarget) return
                                    setResumeHistoryOpen(true)
                                    if (shouldRefreshSavedHistoryOnModalOpen({
                                        hasLoadedInitialResults: savedSessionsLoaded,
                                        isLoading: savedSessionsLoading,
                                    })) {
                                        void loadSavedSessions(selectedMachine.id, selectedTarget)
                                    }
                                }}
                                onClearSelection={() => setSelectedResumeSessionId('')}
                            />
                        )}

                        {message && (
                            <div className={`rounded-xl border px-4 py-3 text-sm ${message.includes('saved') || message.includes('requested') || message.includes('Manual MCP setup') ? 'border-accent/25 bg-accent/10 text-text-primary' : 'border-status-error/25 bg-status-error/10 text-status-error'}`}>
                                {message}
                            </div>
                        )}
                    </div>

                    <div className="flex items-center justify-end gap-2 px-4 py-[calc(12px+env(safe-area-inset-bottom,0px))] sm:px-5 sm:py-4 border-t border-border-subtle bg-bg-secondary shrink-0">
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
                            disabled={busy
                                || (workspaceMode === 'mesh'
                                    ? (!selectedMeshId || !selectedTarget || activeKind !== 'cli' || meshLoading)
                                    : (!activeKind || !selectedTarget || (workspaceChoice === '__custom__' && !resolvedWorkspacePath)))}
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
                    savedHistoryFilters={resumeHistoryFilters}
                    missingWorkspaceResumePath={resolvedWorkspacePath || null}
                    onSavedHistoryFiltersChange={setResumeHistoryFilters}
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
        </>
    )
}
