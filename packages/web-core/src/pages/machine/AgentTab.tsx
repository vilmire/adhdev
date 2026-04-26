/**
 * AgentTab — Unified agent management component for IDE, CLI, and ACP.
 *
 * All three categories share:
 *   1. Launch form (provider selector + dir + args + buttons)
 *   2. Running agents list with status badges and actions
 *   3. Running session management
 *
 * Category-specific features are handled via conditional rendering:
 *   - IDE: Detected IDEs list, extension toggles, Control button, multi-window
 *   - ACP: Model field in launch form, model/plan badges, chat button
 *   - CLI: Simplest — just the base
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { isManagedStatusWorking, normalizeManagedStatus } from '@adhdev/daemon-core/status/normalize'
import {
    isExpectedCliViewModeTransportError,
    shouldRetainOptimisticCliViewModeOverrideOnError,
} from '../../components/dashboard/cliViewModeOverrides'
import { formatIdeType, getWorkspaceDisplayLabel } from '../../utils/daemon-utils'
import {
    getLaunchPrimaryActionLabel,
    getLaunchPrimaryBusyLabel,
    getMachineLaunchBusyLabel,
    getMachineLaunchConfirmDescription,
    getMachineLaunchConfirmLabel,
    getMachineLaunchConfirmTitle,
    getRecentHistoryResumeConfirmDescription,
    getRecentHistoryResumeConfirmTitle,
} from '../../utils/dashboard-launch-copy'
import { getDashboardActiveTabHref } from '../../utils/dashboard-route-paths'
import { createSavedHistoryFilterState, type SavedHistoryFilterState } from '../../utils/saved-history-filter-state'
import { IconChat, IconMonitor, IconSearch, IconPlay, IconRefresh, IconX } from '../../components/Icons'
import type { MachineData, IdeSessionEntry, CliSessionEntry, AcpSessionEntry, ProviderInfo } from './types'
import type { useMachineActions } from './useMachineActions'
import HistoryModal, { type SavedSessionHistoryEntry } from '../../components/dashboard/HistoryModal'
import type { ActiveConversation } from '../../components/dashboard/types'
import { describeMuxOwner } from '../../utils/mux-ui'
import CliViewModeToggle from '../../components/dashboard/CliViewModeToggle'
import WorkspaceBrowseDialog from '../../components/machine/WorkspaceBrowseDialog'
import LaunchConfirmDialog from '../../components/machine/LaunchConfirmDialog'
import SavedHistoryLaunchSection from '../../components/SavedHistoryLaunchSection'
import { browseMachineDirectories, collectBrowsePathCandidates, getDefaultBrowseStartPath, type BrowseDirectoryEntry } from '../../components/machine/workspaceBrowse'
import { buildLaunchWorkspaceOptions } from '../../components/machine/launchWorkspaceOptions'
import type { LaunchWorkspaceOption } from './types'
import { getRecentLaunchArgs, pushRecentLaunchArgs } from '../../utils/recentLaunchArgs'
import { shouldRefreshSavedHistoryOnModalOpen } from '../../utils/saved-history-load-state'
import { isLaunchableMachineProvider, type LaunchableProviderCategory } from '../../utils/provider-activation'

type AgentCategory = LaunchableProviderCategory

interface SavedSessionOption extends SavedSessionHistoryEntry {}

// Union type for running entries
type AgentEntry = IdeSessionEntry | CliSessionEntry | AcpSessionEntry

interface AgentTabProps {
    category: AgentCategory
    machine: MachineData
    machineId: string
    providers: ProviderInfo[]
    managedEntries: AgentEntry[]
    getIcon: (type: string) => string
    actions: ReturnType<typeof useMachineActions>
    /** Required for IDE extension toggles */
    sendDaemonCommand?: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
    initialWorkspaceId?: string | null
    initialWorkspacePath?: string | null
}

// ─── Category Config ────────────────────────────────
const CATEGORY_CONFIG = {
    ide: { label: 'IDE', plural: 'IDEs', accent: 'border-blue-500/[0.12]' },
    cli: { label: 'CLI', plural: 'CLIs', accent: 'border-violet-500/[0.12]' },
    acp: { label: 'ACP Agent', plural: 'ACP agents', accent: 'border-emerald-500/[0.12]' },
} as const

function normalizePath(path: string | null | undefined) {
    return String(path || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase()
}

export default function AgentTab({
    category, machine, machineId, providers, managedEntries, getIcon, actions, sendDaemonCommand,
    initialWorkspaceId,
    initialWorkspacePath,
}: AgentTabProps) {
    const navigate = useNavigate()
    const {
        handleLaunchIde, handleStopCli, handleRestartIde, handleStopIde,
        handleDetectIdes,
        launchingIde, launchingAgentType, addLog,
    } = actions
    const [copiedRuntimeKey, setCopiedRuntimeKey] = useState<string | null>(null)
    const openSessionInDashboard = useCallback((sessionId: string) => {
        if (!sessionId) return
        navigate(getDashboardActiveTabHref(sessionId))
    }, [navigate])

    const config = CATEGORY_CONFIG[category]
    const isIde = category === 'ide'
    const isAcp = category === 'acp'
    const categoryProviders = useMemo(
        () => providers.filter(provider => isLaunchableMachineProvider(provider, category)),
        [category, providers],
    )
    const providerLabelMap = useMemo(
        () => new Map(categoryProviders.map(provider => [provider.type, provider.displayName || provider.type])),
        [categoryProviders],
    )

    // ─── Launch Form State ──────────────────────────
    const [selectedType, setSelectedType] = useState('')
    const [launchArgs, setLaunchArgs] = useState('')
    const [recentArgsOptions, setRecentArgsOptions] = useState<string[]>([])
    const [launchModel, setLaunchModel] = useState('')
    const [selectedResumeSessionId, setSelectedResumeSessionId] = useState('')
    const [savedSessions, setSavedSessions] = useState<SavedSessionOption[]>([])
    const [savedSessionsLoading, setSavedSessionsLoading] = useState(false)
    const [savedSessionsLoaded, setSavedSessionsLoaded] = useState(false)
    const [savedSessionsError, setSavedSessionsError] = useState('')
    const [resumeHistoryOpen, setResumeHistoryOpen] = useState(false)
    const [resumeHistoryFilters, setResumeHistoryFilters] = useState<SavedHistoryFilterState>(() => createSavedHistoryFilterState())
    const [resumingSavedSessionId, setResumingSavedSessionId] = useState<string | null>(null)
    // Workspace selection: workspace-id | '__custom__' | '' (home)
    const [selectedWorkspace, setSelectedWorkspace] = useState(
        initialWorkspacePath ? '__custom__' : (initialWorkspaceId || machine.defaultWorkspaceId || ''),
    )
    const [customPath, setCustomPath] = useState(initialWorkspacePath || '')
    const [pendingLaunchTypes, setPendingLaunchTypes] = useState<string[]>([])
    const [browseDialogOpen, setBrowseDialogOpen] = useState(false)
    const [browseCurrentPath, setBrowseCurrentPath] = useState('')
    const [browseDirectories, setBrowseDirectories] = useState<BrowseDirectoryEntry[]>([])
    const [browseBusy, setBrowseBusy] = useState(false)
    const [browseError, setBrowseError] = useState('')
    const launchConfirmActionRef = useRef<(() => Promise<void>) | null>(null)
    const [launchConfirm, setLaunchConfirm] = useState<{
        title: string
        description: string
        details: Array<{ label: string; value: string }>
        confirmLabel: string
        busyLabel?: string
        workspaceOptions?: LaunchWorkspaceOption[]
    } | null>(null)
    const launchConfirmWorkspaceKeyRef = useRef('__home__')
    const [launchConfirmWorkspaceKey, setLaunchConfirmWorkspaceKey] = useState('__home__')
    const [launchConfirmBusy, setLaunchConfirmBusy] = useState(false)
    const savedSessionsRequestSeqRef = useRef(0)
    const visiblePendingLaunches = pendingLaunchTypes
        .filter(type => !managedEntries.some(entry => entry.type === type && normalizeManagedStatus(entry.status) !== 'stopped'))
    const pendingTimeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

    // Auto-selection of providers removed to enforce 2-step setup

    // Auto-select default workspace when machine data loads
    useEffect(() => {
        if (machine.defaultWorkspaceId && !selectedWorkspace) {
            setSelectedWorkspace(machine.defaultWorkspaceId)
        }
    }, [machine.defaultWorkspaceId])

    useEffect(() => {
        if (initialWorkspacePath) {
            setSelectedWorkspace('__custom__')
            setCustomPath(initialWorkspacePath)
            return
        }
        if (initialWorkspaceId) {
            setSelectedWorkspace(initialWorkspaceId)
            setCustomPath('')
        }
    }, [initialWorkspaceId, initialWorkspacePath])

    useEffect(() => {
        if (isIde) return
        if (!selectedType) return
        if (categoryProviders.some(provider => provider.type === selectedType)) return
        setSelectedType('')
        setSelectedResumeSessionId('')
    }, [categoryProviders, isIde, selectedType])

    // Resolve the actual workspace path from selection
    const resolvedWorkspacePath = (() => {
        if (selectedWorkspace === '__custom__') return customPath.trim()
        if (!selectedWorkspace) return ''
        const ws = (machine.workspaces || []).find(w => w.id === selectedWorkspace)
        return ws?.path || ''
    })()

    const clearPendingLaunch = useCallback((type: string) => {
        const timeout = pendingTimeoutsRef.current[type]
        if (timeout) {
            clearTimeout(timeout)
            delete pendingTimeoutsRef.current[type]
        }
        setPendingLaunchTypes(prev => (
            prev.includes(type) ? prev.filter(item => item !== type) : prev
        ))
    }, [])

    const announcedPendingLaunchesRef = useRef<Set<string>>(new Set())

    const loadBrowsePath = useCallback(async (path: string) => {
        if (!sendDaemonCommand) return
        setBrowseBusy(true)
        setBrowseError('')
        try {
            const result = await browseMachineDirectories(sendDaemonCommand, machineId, path)
            setBrowseCurrentPath(result.path)
            setCustomPath(result.path)
            setBrowseDirectories(result.directories)
        } catch (error) {
            setBrowseError(error instanceof Error ? error.message : 'Could not load folder')
        } finally {
            setBrowseBusy(false)
        }
    }, [machineId, sendDaemonCommand])

    const openBrowseDialog = useCallback(() => {
        if (!sendDaemonCommand) return
        setSelectedWorkspace('__custom__')
        setBrowseDialogOpen(true)
        const activeWorkspacePaths = managedEntries.map(entry => entry.workspace)
        const initialPath = getDefaultBrowseStartPath(
            machine.platform,
            collectBrowsePathCandidates(
                customPath.trim(),
                resolvedWorkspacePath,
                initialWorkspacePath,
                activeWorkspacePaths,
                machine.defaultWorkspacePath,
                (machine.workspaces || []).map(workspace => workspace.path),
            ),
        )
        void loadBrowsePath(initialPath)
    }, [customPath, initialWorkspacePath, loadBrowsePath, machine.defaultWorkspacePath, machine.platform, machine.workspaces, managedEntries, resolvedWorkspacePath, sendDaemonCommand])

    const applySavedSessionWorkspace = useCallback((session: SavedSessionOption) => {
        const workspacePath = String(session.workspace || '').trim()
        if (!workspacePath) return
        const matchedWorkspace = (machine.workspaces || []).find(workspace => normalizePath(workspace.path) === normalizePath(workspacePath))
        if (matchedWorkspace) {
            setSelectedWorkspace(matchedWorkspace.id)
            setCustomPath('')
            return
        }
        setSelectedWorkspace('__custom__')
        setCustomPath(workspacePath)
    }, [machine.workspaces])

    const resolveSavedSessionLaunchTarget = useCallback((session: SavedSessionOption) => {
        const workspacePath = String(session.workspace || '').trim()
        if (!workspacePath) {
            return { workspaceId: null, workspacePath: '', useHome: true }
        }
        const matchedWorkspace = (machine.workspaces || []).find(workspace => normalizePath(workspace.path) === normalizePath(workspacePath))
        if (matchedWorkspace) {
            return { workspaceId: matchedWorkspace.id, workspacePath: '', useHome: false }
        }
        return { workspaceId: null, workspacePath, useHome: false }
    }, [machine.workspaces])

    const loadSavedSessions = useCallback(async (providerType: string) => {
        if (!sendDaemonCommand || !providerType || category !== 'cli') {
            setSavedSessions([])
            setSavedSessionsLoading(false)
            setSavedSessionsLoaded(false)
            setSavedSessionsError('')
            return
        }
        const requestSeq = savedSessionsRequestSeqRef.current + 1
        savedSessionsRequestSeqRef.current = requestSeq
        setSavedSessionsLoading(true)
        setSavedSessionsError('')
        try {
            const raw: any = await sendDaemonCommand(machineId, 'list_saved_sessions', {
                providerType,
                kind: 'cli',
                limit: 30,
            })
            if (savedSessionsRequestSeqRef.current !== requestSeq) return
            const result = raw?.result ?? raw
            setSavedSessions(Array.isArray(result?.sessions) ? result.sessions : [])
        } catch (error) {
            if (savedSessionsRequestSeqRef.current !== requestSeq) return
            setSavedSessions([])
            setSavedSessionsError(error instanceof Error ? error.message : 'Could not load saved sessions')
        } finally {
            if (savedSessionsRequestSeqRef.current === requestSeq) {
                setSavedSessionsLoading(false)
                setSavedSessionsLoaded(true)
            }
        }
    }, [category, machineId, sendDaemonCommand])

    const resumeHistoryConversation = useMemo<ActiveConversation | null>(() => {
        if (category !== 'cli' || !selectedType) return null
        const providerLabel = providerLabelMap.get(selectedType) || selectedType
        return {
            routeId: machineId,
            daemonId: machineId,
            providerSessionId: selectedResumeSessionId || undefined,
            transport: 'pty',
            mode: 'chat',
            agentName: providerLabel,
            agentType: selectedType,
            status: 'idle',
            title: providerLabel,
            messages: [],
            ideType: selectedType,
            workspaceName: resolvedWorkspacePath,
            displayPrimary: providerLabel,
            displaySecondary: 'CLI',
            streamSource: 'native',
            tabKey: `machine:${machineId}:resume-history:${selectedType}`,
        }
    }, [category, machineId, providerLabelMap, resolvedWorkspacePath, selectedResumeSessionId, selectedType])

    const loadRecentArgs = useCallback((providerType: string) => {
        if (category === 'ide' || !providerType) {
            setRecentArgsOptions([])
            return
        }
        setRecentArgsOptions(getRecentLaunchArgs(machineId, providerType))
    }, [category, machineId])

    useEffect(() => {
        savedSessionsRequestSeqRef.current += 1
        setSelectedResumeSessionId('')
        loadRecentArgs(selectedType)
        setSavedSessionsLoaded(false)
        setSavedSessions([])
        setSavedSessionsError('')
        setSavedSessionsLoading(false)
        if (category !== 'cli' || !selectedType) {
            return
        }
    }, [category, loadRecentArgs, loadSavedSessions, selectedType])

    const selectedSavedSession = useMemo(
        () => savedSessions.find(session => session.providerSessionId === selectedResumeSessionId) || null,
        [savedSessions, selectedResumeSessionId],
    )

    useEffect(() => {
        if (!selectedResumeSessionId) return
        const selectedSession = savedSessions.find(session => session.providerSessionId === selectedResumeSessionId)
        if (selectedSession?.canResume) return
        setSelectedResumeSessionId('')
    }, [savedSessions, selectedResumeSessionId])

    const openLaunchConfirm = useCallback((
        config: {
            title: string
            description: string
            details: Array<{ label: string; value: string }>
            confirmLabel: string
            busyLabel?: string
            workspaceOptions?: LaunchWorkspaceOption[]
            selectedWorkspaceKey?: string
        },
        action: () => Promise<void>,
    ) => {
        launchConfirmActionRef.current = action
        launchConfirmWorkspaceKeyRef.current = config.selectedWorkspaceKey || '__home__'
        setLaunchConfirmWorkspaceKey(config.selectedWorkspaceKey || '__home__')
        setLaunchConfirm(config)
    }, [])

    const handleConfirmLaunch = useCallback(() => {
        if (!launchConfirmActionRef.current) return
        setLaunchConfirmBusy(true)
        void launchConfirmActionRef.current()
            .finally(() => {
                launchConfirmActionRef.current = null
                setLaunchConfirmBusy(false)
                setLaunchConfirm(null)
            })
    }, [])

    const markPendingLaunch = useCallback((type: string) => {
        if (!type) return
        setPendingLaunchTypes(prev => (prev.includes(type) ? prev : [...prev, type]))
        const existing = pendingTimeoutsRef.current[type]
        if (existing) clearTimeout(existing)
        pendingTimeoutsRef.current[type] = setTimeout(() => {
            setPendingLaunchTypes(prev => (
                prev.includes(type) ? prev.filter(item => item !== type) : prev
            ))
            delete pendingTimeoutsRef.current[type]
        }, 20000)
    }, [])

    useEffect(() => {
        for (const entry of managedEntries) {
            if (normalizeManagedStatus(entry.status) !== 'stopped') {
                if (pendingLaunchTypes.includes(entry.type) && !announcedPendingLaunchesRef.current.has(entry.type)) {
                    announcedPendingLaunchesRef.current.add(entry.type)
                    addLog('info', `${providerLabelMap.get(entry.type) || entry.type} launched`, true)
                }
                clearPendingLaunch(entry.type)
            }
        }
        const activeTypes = new Set(managedEntries
            .filter(entry => normalizeManagedStatus(entry.status) !== 'stopped')
            .map(entry => entry.type))
        announcedPendingLaunchesRef.current.forEach(type => {
            if (!pendingLaunchTypes.includes(type) && !activeTypes.has(type)) {
                announcedPendingLaunchesRef.current.delete(type)
            }
        })
    }, [addLog, clearPendingLaunch, managedEntries, pendingLaunchTypes, providerLabelMap])

    useEffect(() => () => {
        Object.values(pendingTimeoutsRef.current).forEach(clearTimeout)
        pendingTimeoutsRef.current = {}
    }, [])

    // ─── IDE Extension State ────────────────────────
    const [ideExtensions, setIdeExtensions] = useState<Record<string, { type: string; name: string; enabled: boolean }[]>>({})
    const [extToggling, setExtToggling] = useState<string | null>(null)

    useEffect(() => {
        if (!isIde || !machineId || !sendDaemonCommand) return
        const fetchExtensions = async () => {
            try {
                const res: any = await sendDaemonCommand(machineId, 'get_ide_extensions', {})
                const payload = res?.result || res
                if (payload?.success && payload?.ideExtensions) setIdeExtensions(payload.ideExtensions)
            } catch { /* silent */ }
        }
        fetchExtensions()
    }, [isIde, machineId, sendDaemonCommand])

    // ─── Helpers ────────────────────────────────────
    const getName = (entry: AgentEntry) =>
        isIde ? formatIdeType(entry.type)
            : category === 'cli' ? (entry as CliSessionEntry).cliName
                : (entry as AcpSessionEntry).acpName

    const launchableIdes = isIde ? (machine.detectedIdes || []) : []

    const executeLaunch = useCallback(async (opts?: {
        type?: string
        workspacePath?: string
        workspaceId?: string | null
        useHome?: boolean
        argsStr?: string
        model?: string
        resumeSessionId?: string | null
    }) => {
        const launchType = opts?.type || selectedType
        const workspacePath = opts?.workspacePath ?? resolvedWorkspacePath
        if (isIde) {
            const launched = await handleLaunchIde(
                launchType,
                workspacePath ? { workspace: workspacePath } : undefined,
            )
            if (launched) markPendingLaunch(launchType)
            return
        }
        const launched = await actions.runLaunchCliCore({
            cliType: launchType,
            dir: opts?.workspaceId ? undefined : workspacePath || undefined,
            workspaceId: opts?.workspaceId || undefined,
            useHome: opts?.useHome || (!opts?.workspaceId && !workspacePath),
            argsStr: opts?.argsStr ?? (launchArgs || undefined),
            model: opts?.model ?? (isAcp ? launchModel || undefined : undefined),
            resumeSessionId: opts?.resumeSessionId || (!isAcp && category === 'cli' && launchType === selectedType ? selectedResumeSessionId || undefined : undefined),
        })
        if (launched.success || launched.pending) {
            const argsToPersist = opts?.argsStr ?? launchArgs
            if (!isIde && argsToPersist?.trim()) {
                pushRecentLaunchArgs(machineId, launchType, argsToPersist)
                loadRecentArgs(launchType)
            }
            markPendingLaunch(launchType)
            if (launched.success && launched.sessionId) openSessionInDashboard(launched.sessionId)
        }
    }, [
        actions,
        handleLaunchIde,
        isAcp,
        isIde,
        launchArgs,
        launchModel,
        loadRecentArgs,
        markPendingLaunch,
        machineId,
        openSessionInDashboard,
        resolvedWorkspacePath,
        selectedResumeSessionId,
        selectedType,
    ])

    const primaryActionLabel = getLaunchPrimaryActionLabel(
        isIde ? 'ide' : isAcp ? 'acp' : 'cli',
        !isIde && !isAcp && !!selectedResumeSessionId,
    )
    const primaryBusyLabel = getLaunchPrimaryBusyLabel(
        isIde ? 'ide' : isAcp ? 'acp' : 'cli',
        !isIde && !isAcp && !!selectedResumeSessionId,
    )

    const handleLaunch = () => {
        const providerName = isIde
            ? formatIdeType(selectedType)
            : (providerLabelMap.get(selectedType) || selectedType)
        const isCliResume = !isIde && !isAcp && !!selectedResumeSessionId
        const { options, selectedKey } = buildLaunchWorkspaceOptions({
            machine,
            currentWorkspaceId: selectedWorkspace && selectedWorkspace !== '__custom__' ? selectedWorkspace : null,
            currentWorkspacePath: resolvedWorkspacePath,
        })
        openLaunchConfirm({
            title: isCliResume ? getRecentHistoryResumeConfirmTitle(providerName) : getMachineLaunchConfirmTitle('start-fresh', providerName),
            description: isCliResume ? getRecentHistoryResumeConfirmDescription() : getMachineLaunchConfirmDescription('start-fresh'),
            confirmLabel: primaryActionLabel,
            busyLabel: primaryBusyLabel,
            workspaceOptions: options,
            selectedWorkspaceKey: selectedKey,
            details: [
                { label: 'Mode', value: config.label },
                { label: 'Provider', value: providerName },
                ...(!isIde && category === 'cli' && selectedResumeSessionId
                    ? [{
                        label: 'Resume',
                        value: savedSessions.find(session => session.providerSessionId === selectedResumeSessionId)?.title || selectedResumeSessionId,
                    }]
                    : []),
                ...(!isIde && launchArgs.trim() ? [{ label: 'Arguments', value: launchArgs.trim() }] : []),
                ...(isAcp && launchModel.trim() ? [{ label: 'Model', value: launchModel.trim() }] : []),
            ],
        }, async () => {
            const selectedOption = options.find(option => option.key === launchConfirmWorkspaceKeyRef.current)
            if (selectedOption?.workspaceId) {
                setSelectedWorkspace(selectedOption.workspaceId)
                setCustomPath('')
            } else if (selectedOption?.workspacePath) {
                setSelectedWorkspace('__custom__')
                setCustomPath(selectedOption.workspacePath)
            } else {
                setSelectedWorkspace('')
                setCustomPath('')
            }
            await executeLaunch({
                workspaceId: selectedOption?.workspaceId ?? null,
                workspacePath: selectedOption?.workspacePath ?? '',
                useHome: !selectedOption?.workspaceId && !selectedOption?.workspacePath,
            })
        })
    }

    const handleStop = (entry: AgentEntry) => {
        if (isIde) {
            handleStopIde(entry as IdeSessionEntry)
        } else {
            handleStopCli(entry.type, (entry as CliSessionEntry).workspace, entry.id)
        }
    }

    const setCliViewMode = useCallback(async (
        entry: CliSessionEntry,
        mode: 'chat' | 'terminal',
        openInDashboard = false,
    ) => {
        if (entry.mode === mode) {
            if (openInDashboard && entry.sessionId) openSessionInDashboard(entry.sessionId)
            return
        }
        if (!sendDaemonCommand || !entry.sessionId) {
            if (openInDashboard && entry.sessionId) openSessionInDashboard(entry.sessionId)
            return
        }
        try {
            await sendDaemonCommand(machineId, 'set_cli_view_mode', {
                targetSessionId: entry.sessionId,
                cliType: entry.type,
                mode,
            })
            if (openInDashboard) openSessionInDashboard(entry.sessionId)
        } catch (error) {
            const shouldRetainOverride = shouldRetainOptimisticCliViewModeOverrideOnError(error)
            if (!isExpectedCliViewModeTransportError(error)) {
                console.error('Failed to switch CLI view mode:', error)
            } else {
                console.warn(
                    shouldRetainOverride
                        ? 'CLI view mode result was lost after send; dashboard open will trust the requested mode:'
                        : 'Skipped CLI view mode switch:',
                    error instanceof Error ? error.message : String(error),
                )
            }
        }
    }, [machineId, openSessionInDashboard, sendDaemonCommand])

    // ─── Workspace Selector (shared across all categories) ───
    const workspaceSelector = (
        <div className="mb-3">
            <div className="flex gap-2 items-center flex-wrap">
                <select
                    value={selectedWorkspace}
                    onChange={e => {
                        const nextValue = e.target.value
                        setSelectedWorkspace(nextValue)
                        if (nextValue === '__custom__' && sendDaemonCommand) {
                            openBrowseDialog()
                            return
                        }
                        if (nextValue !== '__custom__') setCustomPath('')
                    }}
                    className="px-3 py-1.5 rounded-md min-w-[200px] flex-1 text-sm bg-bg-primary border border-[#ffffff1a] focus:border-accent-primary focus:outline-none transition-colors"
                >
                    {(machine.workspaces || []).length > 0 ? (
                        <>
                            <option value="">(no workspace — launch in home)</option>
                            {(machine.workspaces || []).map(w => (
                                <option key={w.id} value={w.id}>
                                    {w.id === machine.defaultWorkspaceId ? '⭐ ' : ''}
                                    {getWorkspaceDisplayLabel(w.path, w.label)}
                                </option>
                            ))}
                            <option value="__custom__">{sendDaemonCommand ? '📁 Select workspace…' : '✏️ Custom path…'}</option>
                        </>
                    ) : (
                        <>
                            <option value="">(no workspaces saved — add in Overview tab)</option>
                            <option value="__custom__">{sendDaemonCommand ? '📁 Select workspace…' : '✏️ Custom path…'}</option>
                        </>
                    )}
                </select>
                {selectedWorkspace === '__custom__' && (
                    sendDaemonCommand ? (
                        <button
                            type="button"
                            className="px-3 py-1.5 rounded-md text-sm bg-bg-primary border border-[#ffffff1a] hover:border-accent-primary text-text-secondary hover:text-text-primary transition-colors"
                            onClick={openBrowseDialog}
                        >
                            Select workspace…
                        </button>
                    ) : (
                        <input
                            type="text"
                            placeholder="Enter absolute path…"
                            value={customPath}
                            onChange={e => setCustomPath(e.target.value)}
                            className="px-3 py-1.5 rounded-md flex-1 min-w-[200px] text-sm bg-bg-primary border border-[#ffffff1a] focus:border-accent-primary focus:outline-none transition-colors"
                            autoFocus
                        />
                    )
                )}
            </div>
            <div className="mt-1.5 text-[10px] text-text-muted">
                {selectedWorkspace === '__custom__'
                    ? (resolvedWorkspacePath
                        ? <span className="font-mono truncate block" title={resolvedWorkspacePath}>{resolvedWorkspacePath}</span>
                        : (sendDaemonCommand ? 'Browse to a folder before launching there.' : 'Enter an absolute path to launch there.'))
                    : resolvedWorkspacePath
                        ? (
                            <>
                                <span className="font-medium text-text-secondary">
                                    {selectedWorkspace === machine.defaultWorkspaceId ? 'Default workspace' : 'Selected workspace'}
                                </span>
                                <span className="font-mono truncate block" title={resolvedWorkspacePath}>{resolvedWorkspacePath}</span>
                            </>
                        )
                        : 'No workspace selected. This launches in the home directory.'}
            </div>
        </div>
    )

    return (
        <div>
            {/* ═══ Launch Form ═══ */}
            <div className={`px-5 py-5 rounded-xl mb-6 bg-bg-secondary border ${config.accent} relative overflow-hidden`}>
                <div className="absolute top-0 left-0 w-full height-[1px] bg-gradient-to-r from-transparent via-[#ffffff20] to-transparent" />
                <div className="text-[11px] text-text-muted font-semibold uppercase tracking-wider mb-4 flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent-primary/60" />
                    Select {config.label} to Launch
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {isIde ? (
                        launchableIdes.length > 0 ? launchableIdes.map(d => {
                            const matchingEntry = managedEntries.find(m => (m.type || '').toLowerCase() === (d.type || '').toLowerCase() && normalizeManagedStatus(m.status) !== 'stopped')
                            const isRunning = d.running || !!matchingEntry
                            const isReady = !!matchingEntry && (matchingEntry as IdeSessionEntry).cdpConnected
                            const isPending = pendingLaunchTypes.includes(d.type || d.id || '')
                            const isSelected = selectedType === (d.type || '')
                            
                            return (
                                <button
                                    key={d.type}
                                    onClick={() => {
                                        if (isReady && matchingEntry) {
                                            const targetSessionId = (matchingEntry as IdeSessionEntry).sessionId
                                            if (targetSessionId) {
                                                navigate(getDashboardActiveTabHref(targetSessionId), { state: { openRemoteForTabKey: targetSessionId } })
                                            } else {
                                                navigate('/dashboard', { state: { openRemoteForTabKey: matchingEntry.id } })
                                            }
                                            return
                                        }
                                        if (isPending) return
                                        setSelectedType(prev => prev === (d.type || '') ? '' : (d.type || ''))
                                    }}
                                    disabled={!!launchingIde || isPending}
                                    className={`flex flex-col items-center justify-center p-3.5 gap-2 rounded-xl border transition-all cursor-pointer group ${
                                        isReady ? 'bg-green-500/10 border-green-500/20 hover:bg-green-500/20' : 
                                        isSelected ? 'bg-accent-primary/10 border-accent-primary scale-[1.02] shadow-glow' : 'bg-bg-primary border-[#ffffff1a] hover:bg-[#ffffff0c] hover:border-[#ffffff30]'
                                    }`}
                                    style={{ opacity: (launchingIde && launchingIde !== d.type) ? 0.4 : 1 }}
                                >
                                    <div className="relative">
                                        <span className="text-2xl drop-shadow-sm transition-transform group-hover:scale-110 block">{getIcon(d.type)}</span>
                                        {isRunning && <span className={`absolute -top-1 -right-1 w-2 h-2 rounded-full ${isReady ? 'bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.6)]' : 'bg-orange-500 shadow-[0_0_6px_rgba(249,115,22,0.6)] animate-pulse'}`} />}
                                    </div>
                                    <div className="flex flex-col items-center">
                                        <span className="text-xs font-semibold text-text-primary text-center">
                                            {d.name || formatIdeType(d.type)}
                                        </span>
                                        <span className={`text-[9px] mt-0.5 uppercase tracking-wider font-medium ${isReady ? 'text-green-400' : isPending ? 'text-orange-400' : isSelected ? 'text-accent-primary' : 'text-text-muted'}`}>
                                            {isReady ? 'Open Session' : isPending ? 'Starting...' : isSelected ? 'Configure' : 'Select'}
                                        </span>
                                    </div>
                                </button>
                            )
                        }) : (
                            <div className="col-span-full py-6 flex flex-col items-center justify-center bg-bg-primary/50 border border-dashed border-[#ffffff1a] rounded-xl text-xs text-text-muted italic gap-2">
                                No IDEs detected.
                                <button onClick={handleDetectIdes} className="btn bg-[#ffffff0a] hover:bg-[#ffffff14] text-text-muted hover:text-text-primary px-3 py-1.5 rounded-lg flex items-center gap-1.5"><IconSearch size={14} /> Scan System</button>
                            </div>
                        )
                    ) : (
                        categoryProviders.length > 0 ? categoryProviders.map((p: any) => {
                            const isSelected = selectedType === p.type
                            const isPending = pendingLaunchTypes.includes(p.type)
                            const matchingEntry = managedEntries.find(m => m.type === p.type && normalizeManagedStatus(m.status) !== 'stopped')
                            const isRunning = !!matchingEntry
                            
                            return (
                                <button
                                    key={p.type}
                                    onClick={() => setSelectedType(prev => prev === p.type ? '' : p.type)}
                                    className={`flex flex-col items-center justify-center p-3.5 gap-2 rounded-xl border transition-all cursor-pointer group ${
                                        isSelected ? 'bg-accent-primary/10 border-accent-primary scale-[1.02] shadow-glow' : 'bg-bg-primary border-[#ffffff1a] hover:bg-[#ffffff0c] hover:border-[#ffffff30]'
                                    }`}
                                >
                                    <div className="relative">
                                        <span className="text-2xl drop-shadow-sm transition-transform group-hover:scale-110 block">{p.icon}</span>
                                        {isRunning && <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.6)]" />}
                                    </div>
                                    <div className="flex flex-col items-center">
                                        <span className="text-xs font-semibold text-text-primary text-center">
                                            {p.displayName}
                                        </span>
                                        <span className={`text-[9px] mt-0.5 uppercase tracking-wider font-medium ${isPending ? 'text-orange-400' : isSelected ? 'text-accent-primary' : 'text-text-muted'}`}>
                                            {isPending ? 'Starting...' : isSelected ? 'Configure' : 'Select'}
                                        </span>
                                    </div>
                                </button>
                            )
                        }) : (
                            <div className="col-span-full py-6 text-center bg-bg-primary/50 border border-dashed border-[#ffffff1a] rounded-xl text-xs text-text-muted">
                                No usable {category.toUpperCase()} providers available.
                                <div className="mt-1 text-[11px] text-text-muted">
                                    Set a custom executable path in Providers if the binary is installed outside the default location.
                                </div>
                            </div>
                        )
                    )}
                </div>

                {/* Configuration Panel (2-step setup) */}
                {selectedType && (isIde ? launchableIdes.find(d => d.type === selectedType) : categoryProviders.find(p => p.type === selectedType)) && (
                    <div className="mt-5 pt-5 border-t border-[#ffffff1a] flex flex-col gap-4 animate-in slide-in-from-top-2 fade-in duration-200">
                        <div className="text-[11px] text-text-muted font-semibold uppercase tracking-wider flex items-center justify-between">
                            <span>Launch Settings</span>
                            <span className="text-accent-primary font-bold">{isIde ? formatIdeType(selectedType) : providerLabelMap.get(selectedType) || selectedType}</span>
                        </div>
                        
                        {workspaceSelector}
                        
                        {!isIde && (
                            <div className="flex flex-col gap-3">
                                {!isAcp && category === 'cli' && (
                                    <SavedHistoryLaunchSection
                                        busy={!!launchingAgentType || !!launchingIde || pendingLaunchTypes.includes(selectedType)}
                                        savedSessionsLoading={savedSessionsLoading}
                                        savedSessionsError={savedSessionsError}
                                        selectedSession={selectedSavedSession}
                                        onRefresh={() => void loadSavedSessions(selectedType)}
                                        onOpenHistory={() => {
                                            if (!selectedType) return
                                            setResumeHistoryOpen(true)
                                            if (shouldRefreshSavedHistoryOnModalOpen({
                                                hasLoadedInitialResults: savedSessionsLoaded,
                                                isLoading: savedSessionsLoading,
                                            })) {
                                                void loadSavedSessions(selectedType)
                                            }
                                        }}
                                        onClearSelection={() => setSelectedResumeSessionId('')}
                                    />
                                )}

                                <div className="flex flex-col sm:flex-row gap-3">
                                    {isAcp && (
                                        <div className="flex flex-col gap-1.5 flex-1">
                                            <span className="text-[10px] font-semibold text-text-secondary uppercase">Target Model</span>
                                            <input
                                                type="text"
                                                placeholder="Leave empty for default"
                                                value={launchModel}
                                                onChange={e => setLaunchModel(e.target.value)}
                                                className="px-3 py-2 rounded-md text-sm bg-bg-primary border border-[#ffffff1a] focus:border-accent-primary focus:outline-none transition-colors w-full"
                                            />
                                        </div>
                                    )}
                                    <div className="flex flex-col gap-1.5 flex-1">
                                        <span className="text-[10px] font-semibold text-text-secondary uppercase">Startup Arguments</span>
                                        <input
                                            type="text"
                                            placeholder="Optional flags..."
                                            value={launchArgs}
                                            onChange={e => setLaunchArgs(e.target.value)}
                                            className="px-3 py-2 rounded-md text-sm bg-bg-primary border border-[#ffffff1a] focus:border-accent-primary focus:outline-none transition-colors w-full"
                                        />
                                        {recentArgsOptions.length > 0 && (
                                            <div className="flex flex-wrap gap-1.5 mt-1.5">
                                                {recentArgsOptions.map(argsOption => (
                                                    <button
                                                        key={argsOption}
                                                        type="button"
                                                        className="btn btn-secondary btn-sm"
                                                        onClick={() => setLaunchArgs(argsOption)}
                                                        title={argsOption}
                                                    >
                                                        {argsOption}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}
                        
                        <div className="flex justify-end mt-2">
                            <button
                                onClick={handleLaunch}
                                disabled={!!launchingAgentType || !!launchingIde || pendingLaunchTypes.includes(selectedType)}
                                className="btn btn-primary h-9 px-6 font-bold transition-all flex items-center gap-2 hover:shadow-glow hover:-translate-y-px"
                            >
                                {launchingAgentType === selectedType || launchingIde === selectedType ? '⏳ Launching...' : '▶ Launch'}
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* ═══ Running Agents ═══ */}
            <div className="text-[11px] text-text-muted font-semibold uppercase tracking-wider mb-2.5">
                Running ({managedEntries.length + pendingLaunchTypes.filter(type => !managedEntries.some(entry => entry.type === type && normalizeManagedStatus(entry.status) !== 'stopped')).length})
            </div>

            {managedEntries.length === 0 && visiblePendingLaunches.length === 0 ? (
                <div className="py-7.5 px-5 text-center rounded-xl bg-bg-secondary border border-dashed border-border-subtle text-text-muted text-[13px] mb-5">
                    No {config.plural} running
                </div>
            ) : (
                <div className="flex flex-col gap-2.5 mb-5">
                    {visiblePendingLaunches.map(type => (
                            <div key={`pending:${type}`} className="px-4.5 py-3.5 rounded-xl bg-bg-secondary" style={{ border: '1px solid color-mix(in srgb, var(--status-warning) 20%, transparent)' }}>
                                <div className="flex justify-between items-center">
                                    <div className="flex items-center gap-2.5">
                                        <span className="text-lg">{getIcon(type)}</span>
                                        <div>
                                            <div className="font-semibold text-[13px] text-text-primary">
                                                {isIde ? formatIdeType(type) : (providerLabelMap.get(type) || type)}
                                            </div>
                                            <div className="text-[11px] text-text-muted">
                                                {launchingAgentType === type
                                                    ? 'Launching process...'
                                                    : 'Waiting for process and session to register...'}
                                            </div>
                                        </div>
                                    </div>
                                    <span
                                        className="px-2 py-0.5 rounded-md text-[10px] font-semibold"
                                        style={{ background: 'color-mix(in srgb, var(--status-warning) 8%, transparent)', color: 'var(--status-warning)' }}
                                    >
                                        starting
                                    </span>
                                </div>
                            </div>
                        ))}
                    {managedEntries.map(entry => {
                        const ide = isIde ? (entry as IdeSessionEntry) : null
                        const cli = !isIde && !isAcp ? (entry as CliSessionEntry) : null
                        const normalizedStatus = normalizeManagedStatus(entry.status)

                        return (
                            <div key={entry.id} className="px-4.5 py-3.5 rounded-xl bg-bg-secondary border border-border-subtle">
                                <div className="flex justify-between items-center mb-2">
                                    <div className="flex items-center gap-2.5">
                                        <span className="text-lg">{getIcon(entry.type)}</span>
                                        <div>
                                            <div className="font-semibold text-[13px] text-text-primary">
                                                {getName(entry)}
                                                {ide?.version && <span className="text-[10px] text-text-muted ml-1.5">v{ide.version}</span>}
                                            </div>
                                            <div className="text-[11px] text-text-muted flex gap-2">
                                                <span>{entry.workspace || '—'}</span>
                                                {cli?.mode && (
                                                    <span className={cli.mode === 'chat' ? 'text-violet-400' : 'text-text-secondary'}>
                                                        {cli.mode === 'chat' ? 'Chat view' : 'Terminal view'}
                                                    </span>
                                                )}
                                            </div>
                                            {cli && (cli.runtimeKey || cli.runtimeWriteOwner) && (
                                                <div className="text-[10px] text-text-muted flex gap-2 mt-0.5 flex-wrap">
                                                    {cli.runtimeKey && (
                                                        <>
                                                            <span className="text-text-secondary">Local terminal:</span>
                                                            <span className="font-mono text-text-secondary">adhdev attach {cli.runtimeKey}</span>
                                                            <button
                                                                type="button"
                                                                className="flex items-center justify-center px-1.5 py-0.5 rounded text-[9px] bg-[#ffffff0a] hover:bg-[#ffffff14] border border-[#ffffff0a] text-text-muted hover:text-text-primary transition-colors cursor-pointer"
                                                                onClick={() => {
                                                                    void navigator.clipboard?.writeText(`adhdev attach ${cli.runtimeKey}`)
                                                                    setCopiedRuntimeKey(cli.runtimeKey || null)
                                                                    window.setTimeout(() => {
                                                                        setCopiedRuntimeKey((current) => (current === cli.runtimeKey ? null : current))
                                                                    }, 1200)
                                                                }}
                                                            >
                                                                {copiedRuntimeKey === cli.runtimeKey ? 'Copied' : 'Copy'}
                                                            </button>
                                                        </>
                                                    )}
                                                    {cli.runtimeWriteOwner && (
                                                        <span style={{ color: cli.runtimeWriteOwner.ownerType === 'user' ? 'var(--status-warning)' : undefined }} className={cli.runtimeWriteOwner.ownerType !== 'user' ? 'text-violet-400' : ''}>
                                                            {describeMuxOwner(cli.runtimeWriteOwner)}
                                                        </span>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        <span className={`px-2 py-0.5 rounded-md text-[10px] font-semibold ${
                                            normalizedStatus === 'stopped' ? 'bg-red-500/[0.08] text-red-500'
                                                : normalizedStatus === 'generating' ? 'bg-orange-500/[0.08] text-orange-400'
                                                    : 'bg-green-500/[0.08] text-green-500'
                                        }`}>{normalizedStatus}</span>
                                        {/* IDE: Control + Restart */}
                                        {isIde && (
                                            <>
                                                <button
                                                    onClick={() => {
                                                        const targetSessionId = (entry as IdeSessionEntry).sessionId
                                                        if (targetSessionId) {
                                                            navigate(getDashboardActiveTabHref(targetSessionId), {
                                                                state: { openRemoteForTabKey: targetSessionId },
                                                            })
                                                            return
                                                        }
                                                        navigate('/dashboard', {
                                                            state: { openRemoteForTabKey: entry.id },
                                                        })
                                                    }}
                                                    className="flex items-center justify-center w-7 h-7 rounded bg-[#ffffff0a] hover:bg-[#ffffff14] text-text-primary transition-colors cursor-pointer"
                                                    title="Open remote control"
                                                >
                                                    <IconMonitor size={13} />
                                                </button>
                                                <button
                                                    onClick={() => {
                                                        const restartWorkspace = (entry as IdeSessionEntry).workspace || ''
                                                        const { options, selectedKey } = buildLaunchWorkspaceOptions({
                                                            machine,
                                                            currentWorkspacePath: restartWorkspace,
                                                        })
                                                        openLaunchConfirm({
                                                            title: getMachineLaunchConfirmTitle('restart-ide', formatIdeType(entry.type)),
                                                            description: getMachineLaunchConfirmDescription('restart-ide'),
                                                            confirmLabel: getMachineLaunchConfirmLabel('restart-ide'),
                                                            busyLabel: getMachineLaunchBusyLabel('restart-ide'),
                                                            workspaceOptions: options,
                                                            selectedWorkspaceKey: selectedKey,
                                                            details: [
                                                                { label: 'Mode', value: 'IDE' },
                                                                { label: 'Provider', value: formatIdeType(entry.type) },
                                                            ],
                                                        }, async () => {
                                                            const selectedOption = options.find(option => option.key === launchConfirmWorkspaceKeyRef.current)
                                                            const nextWorkspacePath = selectedOption?.workspacePath ?? ''
                                                            if (nextWorkspacePath && nextWorkspacePath !== restartWorkspace) {
                                                                await executeLaunch({
                                                                    type: entry.type,
                                                                    workspacePath: nextWorkspacePath,
                                                                })
                                                                return
                                                            }
                                                            await handleRestartIde(entry as IdeSessionEntry)
                                                        })
                                                    }}
                                                    className="flex items-center justify-center w-7 h-7 rounded bg-[#ffffff0a] hover:bg-orange-500/20 text-orange-400 transition-colors cursor-pointer"
                                                    title="Restart"
                                                >
                                                    <IconRefresh size={14} />
                                                </button>
                                            </>
                                        )}
                                        {/* ACP: Chat */}
                                        {isAcp && (
                                            <button
                                                onClick={() => {
                                                    const targetSessionId = (entry as AcpSessionEntry).sessionId
                                                    if (targetSessionId) openSessionInDashboard(targetSessionId)
                                                }}
                                                className="flex items-center justify-center w-7 h-7 rounded bg-[#ffffff0a] hover:bg-[#ffffff14] disabled:opacity-50 disabled:cursor-not-allowed text-text-primary transition-colors cursor-pointer"
                                                title="View chat"
                                                disabled={!(entry as AcpSessionEntry).sessionId}
                                            ><IconChat size={14} /></button>
                                        )}
                                        {cli && normalizedStatus !== 'stopped' && (
                                            <>
                                                {cli.mode && (
                                                    <CliViewModeToggle
                                                        mode={cli.mode}
                                                        onChange={(mode) => void setCliViewMode(cli, mode, false)}
                                                        compact
                                                    />
                                                )}
                                                <button
                                                    onClick={() => {
                                                        const targetSessionId = (entry as CliSessionEntry).sessionId
                                                        if (targetSessionId) openSessionInDashboard(targetSessionId)
                                                    }}
                                                    className="flex items-center justify-center w-7 h-7 rounded bg-[#ffffff0a] hover:bg-[#ffffff14] disabled:opacity-50 disabled:cursor-not-allowed text-text-primary transition-colors cursor-pointer"
                                                    title="Open current view in dashboard"
                                                    disabled={!(entry as CliSessionEntry).sessionId}
                                                >
                                                    {cli.mode === 'chat' ? <IconChat size={14} /> : <IconMonitor size={13} />}
                                                </button>
                                            </>
                                        )}
                                        {/* All: Stop / Restart */}
                                        {normalizedStatus === 'stopped' ? (
                                            <button
                                                onClick={() => {
                                                    const workspacePath = entry.workspace || ''
                                                    const providerName = isIde
                                                        ? formatIdeType(entry.type)
                                                        : getName(entry)
                                                    const { options, selectedKey } = buildLaunchWorkspaceOptions({
                                                        machine,
                                                        currentWorkspacePath: workspacePath,
                                                    })
                                                    openLaunchConfirm({
                                                        title: getMachineLaunchConfirmTitle('restart-stopped', providerName),
                                                        description: getMachineLaunchConfirmDescription('restart-stopped'),
                                                        confirmLabel: getMachineLaunchConfirmLabel('restart-stopped'),
                                                        busyLabel: getMachineLaunchBusyLabel('restart-stopped'),
                                                        workspaceOptions: options,
                                                        selectedWorkspaceKey: selectedKey,
                                                        details: [
                                                            { label: 'Mode', value: config.label },
                                                            { label: 'Provider', value: providerName },
                                                        ],
                                                    }, async () => {
                                                        const selectedOption = options.find(option => option.key === launchConfirmWorkspaceKeyRef.current)
                                                        await executeLaunch({
                                                            type: entry.type,
                                                            workspaceId: selectedOption?.workspaceId ?? null,
                                                            workspacePath: selectedOption?.workspacePath ?? '',
                                                            useHome: !selectedOption?.workspaceId && !selectedOption?.workspacePath,
                                                        })
                                                    })
                                                }}
                                                disabled={pendingLaunchTypes.includes(entry.type)}
                                                className="flex items-center justify-center w-7 h-7 rounded bg-[#ffffff0a] hover:bg-green-500/20 text-green-400 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                                                title="Restart"
                                            >
                                                {pendingLaunchTypes.includes(entry.type) ? '⏳' : <IconPlay size={14} />}
                                            </button>
                                        ) : (
                                            <button onClick={() => handleStop(entry)} className="flex items-center justify-center w-7 h-7 rounded bg-[#ffffff0a] hover:bg-red-500/20 text-red-400 transition-colors cursor-pointer" title="Stop">
                                                <IconX size={14} />
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {/* IDE: AI Agents */}
                                {ide && ide.aiAgents.length > 0 && (
                                    <div className="flex gap-1 mb-2 flex-wrap">
                                        {ide.aiAgents.map(a => (
                                            <span key={a.id} className={`px-2 py-0.5 rounded-md text-[10px] ${
                                                isManagedStatusWorking(a.status) ? 'bg-orange-500/[0.08] text-orange-400' : 'bg-indigo-500/[0.06] text-indigo-400'
                                            }`}>{a.name} · {normalizeManagedStatus(a.status)}</span>
                                        ))}
                                    </div>
                                )}

                                {/* IDE: Extension Toggles */}
                                {ide && (ideExtensions[ide.type] || []).length > 0 && sendDaemonCommand && (
                                    <div className="mt-2 pt-2 border-t border-border-subtle">
                                        <div className="text-[10px] text-text-muted font-semibold uppercase tracking-wider mb-1.5">Extensions</div>
                                        <div className="flex flex-wrap gap-2">
                                            {(ideExtensions[ide.type] || []).map(ext => (
                                                <button
                                                    key={ext.type}
                                                    disabled={extToggling === `${ide.type}.${ext.type}`}
                                                    onClick={async () => {
                                                        const key = `${ide.type}.${ext.type}`;
                                                        setExtToggling(key);
                                                        try {
                                                            await sendDaemonCommand(machineId, 'set_ide_extension', {
                                                                ideType: ide.type,
                                                                extensionType: ext.type,
                                                                enabled: !ext.enabled,
                                                            });
                                                            setIdeExtensions(prev => ({
                                                                ...prev,
                                                                [ide.type]: (prev[ide.type] || []).map(e =>
                                                                    e.type === ext.type ? { ...e, enabled: !e.enabled } : e
                                                                ),
                                                            }));
                                                        } catch (e) {
                                                            console.error('Extension toggle failed:', e);
                                                        } finally {
                                                            setExtToggling(null);
                                                        }
                                                    }}
                                                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-colors duration-150 cursor-pointer ${
                                                        ext.enabled
                                                            ? 'bg-accent-primary/10 border-accent-primary/20 text-accent-primary-light'
                                                            : 'bg-bg-glass border-border-subtle text-text-muted'
                                                    }`}
                                                >
                                                    <span className={`w-1.5 h-1.5 rounded-full ${
                                                        ext.enabled ? 'bg-accent-primary shadow-glow' : 'bg-zinc-600'
                                                    }`} />
                                                    {ext.name}
                                                    <span className="text-[9px] font-normal">{ext.enabled ? 'ON' : 'OFF'}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}
            {browseDialogOpen && sendDaemonCommand && (
                <WorkspaceBrowseDialog
                    title="Select workspace"
                    description="Choose a folder in a regular explorer-style dialog, then use it as the launch target."
                    currentPath={browseCurrentPath}
                    directories={browseDirectories}
                    busy={browseBusy}
                    error={browseError}
                    confirmLabel="Use this folder"
                    onClose={() => setBrowseDialogOpen(false)}
                    onNavigate={(path) => { void loadBrowsePath(path) }}
                    onConfirm={(path) => {
                        setCustomPath(path)
                        setSelectedWorkspace('__custom__')
                        setBrowseDialogOpen(false)
                    }}
                />
            )}
            {launchConfirm && (
                <LaunchConfirmDialog
                    title={launchConfirm.title}
                    description={launchConfirm.description}
                    details={launchConfirm.details}
                    workspaceOptions={launchConfirm.workspaceOptions}
                    selectedWorkspaceKey={launchConfirmWorkspaceKey}
                    onWorkspaceChange={(key) => {
                        launchConfirmWorkspaceKeyRef.current = key
                        setLaunchConfirmWorkspaceKey(key)
                    }}
                    confirmLabel={launchConfirm.confirmLabel}
                    busyLabel={launchConfirm.busyLabel}
                    busy={launchConfirmBusy}
                    onConfirm={handleConfirmLaunch}
                    onCancel={() => {
                        launchConfirmActionRef.current = null
                        setLaunchConfirm(null)
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
                    onSavedHistoryFiltersChange={setResumeHistoryFilters}
                    onClose={() => setResumeHistoryOpen(false)}
                    onNewChat={() => {
                        setSelectedResumeSessionId('')
                        setResumeHistoryOpen(false)
                    }}
                    onSwitchSession={() => {}}
                    onRefreshHistory={() => { void loadSavedSessions(selectedType) }}
                    onResumeSavedSession={(session) => {
                        if (!session.canResume) return
                        if (resumingSavedSessionId) return
                        const launchTarget = resolveSavedSessionLaunchTarget(session)
                        setSelectedResumeSessionId(session.providerSessionId)
                        applySavedSessionWorkspace(session)
                        setResumingSavedSessionId(session.providerSessionId)
                        setResumeHistoryOpen(false)
                        void executeLaunch({
                            type: session.providerType,
                            workspaceId: launchTarget.workspaceId,
                            workspacePath: launchTarget.workspacePath,
                            useHome: launchTarget.useHome,
                            resumeSessionId: session.providerSessionId,
                        }).finally(() => {
                            setResumingSavedSessionId(current => (
                                current === session.providerSessionId ? null : current
                            ))
                        })
                    }}
                />
            )}
        </div>
    )
}
