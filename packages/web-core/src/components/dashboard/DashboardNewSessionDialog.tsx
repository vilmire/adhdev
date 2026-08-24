import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DaemonData } from '../../types'
import { useDaemonMetadataLoader } from '../../hooks/useDaemonMetadataLoader'
import { compareMachineEntries, getMachineDisplayName, getWorkspaceDisplayLabel } from '../../utils/daemon-utils'
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
import { modelOptionsForProvider, thinkingOptionsForProvider } from '../../utils/provider-priority'
import type { LaunchResult, MeshLaunchOption } from '../../hooks/useDashboardCommandActions'
import MeshCoordinatorManualSetupPanel from '../MeshCoordinatorManualSetupPanel'
import { buildManualCoordinatorSetup, type MeshCoordinatorManualSetup } from '../../utils/mesh-coordinator-setup'
import ModalPortal from '../ui/ModalPortal'
import { LAUNCH_CATEGORY_LABELS } from './launch-category-labels'
import {
    AutoApproveModeSelector,
    DangerousAutoApproveModeDialog,
    LegacyAutoApproveToggle,
} from './AutoApproveModeSelector'
import {
    buildAutoApproveLaunchSettings,
    deriveAutoApproveModeRisk,
    resolveInitialAutoApproveModeId,
} from '../../utils/auto-approve-modes'
import type { AutoApproveMode } from '@adhdev/daemon-core'

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
    onLaunchIde: (machineId: string, ideType: string, opts?: { workspacePath?: string | null }) => Promise<{ ok: boolean; error?: string; code?: string }>
    onLaunchProvider: (
        machineId: string,
        kind: 'cli' | 'acp',
        providerType: string,
        opts?: {
            workspaceId?: string | null
            workspacePath?: string | null
            useHome?: boolean
            resumeSessionId?: string | null
            cliArgs?: string[]
            initialModel?: string | null
            initialThinkingLevel?: string | null
            settings?: {
                autoApprove?: boolean
                autoApproveMode?: string
            }
        },
    ) => Promise<{ ok: boolean; error?: string; code?: string }>
    onListMeshes: (machineId: string) => Promise<MeshLaunchOption[]>
    onLaunchMeshCoordinator: (
        machineId: string,
        meshId: string,
        cliType: string,
        opts?: {
            initialModel?: string | null
            initialThinkingLevel?: string | null
            settings?: { autoApprove?: boolean; autoApproveMode?: string }
        },
    ) => Promise<LaunchResult>
    onListSavedSessions: (machineId: string, providerType: string) => Promise<SavedSessionOption[]>
    // Preselect target when the dialog is opened from somewhere that already
    // knows the machine/workspace (e.g. the machine page's workspace list).
    // The workspace id is applied once, as soon as the machine's workspace rows
    // are available — manual machine switches afterwards drop it.
    initialMachineId?: string | null
    initialWorkspaceId?: string | null
    // 'mesh' opens the dialog in coordinator mode; initialMeshWorkspacePath is
    // then matched (once, by normalized path) against the loaded mesh options
    // to preselect the mesh rooted at that workspace.
    initialLaunchMode?: WorkspaceLaunchMode | null
    initialMeshWorkspacePath?: string | null
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
    const { t } = useTranslation()
    if (workspaceMode === 'mesh') return null

    return (
        <div className="rounded-xl border border-border-subtle bg-bg-primary px-4 py-3">
            <div className="text-3xs uppercase tracking-[0.08em] text-text-muted mb-2">{t('newSession.category')}</div>
            <div className="flex flex-wrap gap-2">
                {([
                    { id: 'cli', label: LAUNCH_CATEGORY_LABELS.cli, enabled: cliEnabled },
                    { id: 'ide', label: LAUNCH_CATEGORY_LABELS.ide, enabled: ideEnabled },
                    { id: 'acp', label: LAUNCH_CATEGORY_LABELS.acp, enabled: acpEnabled },
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
    initialMachineId,
    initialWorkspaceId,
    initialLaunchMode,
    initialMeshWorkspacePath,
}: DashboardNewSessionDialogProps) {
    const { t } = useTranslation()
    const loadDaemonMetadata = useDaemonMetadataLoader()
    const sortedMachines = useMemo(
        () => [...machines].sort(compareMachineEntries),
        [machines],
    )
    const [selectedMachineId, setSelectedMachineId] = useState(() => {
        if (initialMachineId && machines.some(machine => machine.id === initialMachineId)) return initialMachineId
        return [...machines].sort(compareMachineEntries)[0]?.id || ''
    })
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
    const [legacyAutoApprove, setLegacyAutoApprove] = useState(false)
    const [selectedAutoApproveModeId, setSelectedAutoApproveModeId] = useState('')
    const [pendingDangerousMode, setPendingDangerousMode] = useState<AutoApproveMode | null>(null)
    // Brain-routing overrides for this session: model + thinking level, best-effort.
    const [initialModel, setInitialModel] = useState('')
    const [initialThinkingLevel, setInitialThinkingLevel] = useState('')
    // When true, the model field is a free-text input (user picked "Custom…" in the
    // model dropdown) instead of a select of the provider's suggested models.
    const [modelIsCustom, setModelIsCustom] = useState(false)
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
    // Message tone drives the banner styling. Previously inferred by substring-
    // matching the English message text; tracked explicitly now so the copy can be
    // translated without breaking the success/error styling.
    const [messageTone, setMessageTone] = useState<'info' | 'error'>('error')
    const [meshManualSetup, setMeshManualSetup] = useState<MeshCoordinatorManualSetup | null>(null)
    const [browseDialogOpen, setBrowseDialogOpen] = useState(false)
    const [browseCurrentPath, setBrowseCurrentPath] = useState('')
    const [browseDirectories, setBrowseDirectories] = useState<Array<{ name: string; path: string }>>([])
    const [browseBusy, setBrowseBusy] = useState(false)
    const [browseError, setBrowseError] = useState('')
    const [savingWorkspace, setSavingWorkspace] = useState(false)
    const initializedMachineIdRef = useRef<string | null>(null)
    // One-shot preselect target: consumed as soon as the requested workspace id
    // shows up in the selected machine's rows, dropped on a manual machine switch.
    const pendingInitialWorkspaceIdRef = useRef<string | null>(initialWorkspaceId || null)
    // One-shot mesh-mode preselect: mode applied on first init, mesh matched by
    // workspace path once the machine's mesh options load.
    const pendingInitialLaunchModeRef = useRef<WorkspaceLaunchMode | null>(initialLaunchMode || null)
    const pendingInitialMeshWorkspaceRef = useRef<string | null>(initialMeshWorkspacePath || null)
    const savedSessionsRequestSeqRef = useRef(0)

    useEffect(() => {
        if (!selectedMachineId && sortedMachines[0]?.id) {
            const preferred = initialMachineId && sortedMachines.some(machine => machine.id === initialMachineId)
                ? initialMachineId
                : sortedMachines[0].id
            setSelectedMachineId(preferred)
        }
    }, [initialMachineId, selectedMachineId, sortedMachines])

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
            meta: ide.running ? t('newSession.detectedLocally') : t('newSession.availableToOpen'),
        })),
        [selectedMachine, t],
    )
    const providerTargets = useMemo(
        () => activeKind === 'cli'
            ? cliProviders.map(provider => ({
                id: provider.type,
                label: provider.displayName || provider.type,
                meta: '',
            }))
            : activeKind === 'acp'
                ? acpProviders.map(provider => ({
                    id: provider.type,
                    label: provider.displayName || provider.type,
                    meta: '',
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
    // Model + thinking dropdown options for the currently-selected provider (cli or
    // acp). Advisory lists from the provider manifest; model still accepts free text.
    const activeLaunchProvider = useMemo(
        () => [...cliProviders, ...acpProviders].find(p => p.type === selectedTarget) as any,
        [cliProviders, acpProviders, selectedTarget],
    )
    const autoApproveModes = activeKind === 'cli'
        ? activeLaunchProvider?.autoApproveModes
        : undefined
    const autoApproveModesFingerprint = JSON.stringify(autoApproveModes || null)
    const initialAutoApproveModeId = resolveInitialAutoApproveModeId(autoApproveModes)
    // Shared provider-option lookup — same source the slot editor and MAGI editor
    // read, so a provider's model/thinking lists come from one place.
    const modelOptionsForTarget = useMemo(
        () => modelOptionsForProvider(activeLaunchProvider ? [activeLaunchProvider] : [], activeLaunchProvider?.type),
        [activeLaunchProvider],
    )
    const thinkingLevelOptionsForTarget = useMemo(() => {
        const list = thinkingOptionsForProvider(activeLaunchProvider ? [activeLaunchProvider] : [], activeLaunchProvider?.type)
        // Fall back to the standard levels when the provider declares none.
        return list.length ? list : ['low', 'medium', 'high']
    }, [activeLaunchProvider])
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
            setMeshError(error instanceof Error ? error.message : t('newSession.errorLoadMeshes'))
        } finally {
            setMeshLoading(false)
        }
    }, [onListMeshes, t])

    useEffect(() => {
        if (!selectedMachine) return

        const machineChanged = initializedMachineIdRef.current !== selectedMachine.id
        if (machineChanged) {
            // A machine switch after the first init means the user navigated away
            // from the preselected machine — the pending preselects no longer apply.
            if (initializedMachineIdRef.current !== null) {
                pendingInitialWorkspaceIdRef.current = null
                pendingInitialLaunchModeRef.current = null
                pendingInitialMeshWorkspaceRef.current = null
            }
            initializedMachineIdRef.current = selectedMachine.id
            const pendingLaunchMode = pendingInitialLaunchModeRef.current
            pendingInitialLaunchModeRef.current = null
            setWorkspaceMode(pendingLaunchMode || 'workspace')
            const pendingWorkspaceId = pendingInitialWorkspaceIdRef.current
            if (pendingWorkspaceId && workspaceRows.some(workspace => workspace.id === pendingWorkspaceId)) {
                pendingInitialWorkspaceIdRef.current = null
                setWorkspaceChoice(pendingWorkspaceId)
            } else {
                setWorkspaceChoice(defaultWorkspaceId || workspaceRows[0]?.id || '__home__')
            }
            setCustomWorkspacePath('')
            setMeshOptions([])
            setSelectedMeshId('')
            setMeshLoadedMachineId(null)
            setMeshError('')
            setActiveKind(getDefaultLaunchKind(selectedMachine))
            setSelectedTarget('')
            setLaunchArgs('')
            setLegacyAutoApprove(false)
            setSelectedAutoApproveModeId('')
            setPendingDangerousMode(null)
            setInitialModel('')
            setInitialThinkingLevel('')
            setModelIsCustom(false)
            setSelectedResumeSessionId('')
            setSavedSessions([])
            setSavedSessionsLoaded(false)
            setSavedSessionsError('')
            setResumeHistoryFilters(createSavedHistoryFilterState())
            setMessage('')
            setMeshManualSetup(null)
            return
        }

        // Workspace rows can arrive after the first init (metadata load) — apply
        // the pending preselect the moment its row exists.
        const pendingWorkspaceId = pendingInitialWorkspaceIdRef.current
        if (pendingWorkspaceId && workspaceRows.some(workspace => workspace.id === pendingWorkspaceId)) {
            pendingInitialWorkspaceIdRef.current = null
            setWorkspaceChoice(pendingWorkspaceId)
        } else {
            setWorkspaceChoice(prev => {
                if (prev === '__custom__' || prev === '__home__') return prev
                if (workspaceRows.some(workspace => workspace.id === prev)) return prev
                return defaultWorkspaceId || workspaceRows[0]?.id || '__home__'
            })
        }

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

    // Apply the one-shot mesh preselect as soon as the options are in: the
    // machine page hands us the workspace path, so match the mesh rooted there.
    useEffect(() => {
        const pendingMeshWorkspace = pendingInitialMeshWorkspaceRef.current
        if (!pendingMeshWorkspace || meshOptions.length === 0) return
        pendingInitialMeshWorkspaceRef.current = null
        const matchedMesh = meshOptions.find(mesh => normalizePath(mesh.workspace) === normalizePath(pendingMeshWorkspace))
        if (matchedMesh) setSelectedMeshId(matchedMesh.id)
    }, [meshOptions])

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

    // Reset the brain-routing overrides when the provider changes — a model/thinking
    // value from one provider (e.g. codex gpt-5.5) is meaningless for another (claude).
    useEffect(() => {
        setInitialModel('')
        setInitialThinkingLevel('')
        setModelIsCustom(false)
    }, [selectedTarget])

    // A dangerous registry default must never become active merely because its
    // manifest was downloaded. Provider changes reset to a non-dangerous default;
    // dangerous choices are committed only by the confirmation dialog below.
    useEffect(() => {
        setSelectedAutoApproveModeId(initialAutoApproveModeId)
        setLegacyAutoApprove(false)
        setPendingDangerousMode(null)
    }, [autoApproveModesFingerprint, initialAutoApproveModeId, selectedMachine?.id, selectedTarget])

    const requestAutoApproveMode = useCallback((mode: AutoApproveMode) => {
        if (deriveAutoApproveModeRisk(mode) === 'dangerous') {
            setPendingDangerousMode(mode)
            return
        }
        setSelectedAutoApproveModeId(mode.id)
    }, [])

    const launchAutoApproveSettings = useMemo(
        () => buildAutoApproveLaunchSettings(autoApproveModes, selectedAutoApproveModeId, legacyAutoApprove),
        [autoApproveModes, legacyAutoApprove, selectedAutoApproveModeId],
    )

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
                setSavedSessionsError(error instanceof Error ? error.message : t('newSession.errorLoadSavedSessions'))
            })
            .finally(() => {
                if (savedSessionsRequestSeqRef.current !== requestSeq) return
                setSavedSessionsLoading(false)
                setSavedSessionsLoaded(true)
            })
    }, [onListSavedSessions, t])

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
            // Saved session with no recorded workspace → resume in the home directory.
            // Send useHome:true so the launch handler doesn't fall through to the daemon's
            // workspace-required rejection (same null/null defect as the "Home directory" pick).
            return { workspaceId: null, workspacePath: null, useHome: true }
        }
        const matchedWorkspace = workspaceRows.find(workspace => normalizePath(workspace.path) === normalizePath(sessionWorkspace))
        if (matchedWorkspace) {
            return { workspaceId: matchedWorkspace.id, workspacePath: null, useHome: false }
        }
        return { workspaceId: null, workspacePath: sessionWorkspace, useHome: false }
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
                setBrowseError(error instanceof Error ? error.message : t('newSession.errorLoadFolder'))
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
                setBrowseError(error instanceof Error ? error.message : t('newSession.errorLoadFolder'))
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
            setMessageTone('error')
            setMessage(result.error || t('newSession.errorSaveWorkspace'))
            return
        }
        setMessageTone('info')
        setMessage(t('newSession.workspaceSaved'))
    }, [onSaveWorkspace, resolvedWorkspacePath, selectedMachine, t])

    const handleLaunch = useCallback(async () => {
        if (!selectedMachine) return
        if (workspaceMode === 'mesh') {
            if (!selectedMeshId || !selectedTarget) return
            setBusy(true)
            setMessage('')
            setMeshManualSetup(null)
            const result = await onLaunchMeshCoordinator(selectedMachine.id, selectedMeshId, selectedTarget, {
                initialModel: initialModel.trim() ? initialModel.trim() : null,
                initialThinkingLevel: initialThinkingLevel.trim() ? initialThinkingLevel.trim() : null,
                settings: launchAutoApproveSettings,
            })
            setBusy(false)
            if (!result.ok) {
                if (result.code === 'mesh_coordinator_manual_mcp_setup_required' && result.manualSetup) {
                    setMeshManualSetup(result.manualSetup)
                    setMessageTone('info')
                    setMessage(t('newSession.errorManualMcpSetup'))
                    return
                }
                setMessageTone('error')
                setMessage(result.error || t('newSession.errorStartMeshCoordinator'))
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
                // "Home directory" choice carries null id + null path; send useHome:true so the
                // daemon resolves os.homedir() instead of rejecting with the workspace-required error.
                useHome: workspaceChoice === '__home__',
                resumeSessionId: activeKind === 'cli' && selectedResumeSessionId ? selectedResumeSessionId : null,
                cliArgs: parsedArgs,
                initialModel: initialModel.trim() ? initialModel.trim() : null,
                initialThinkingLevel: initialThinkingLevel.trim() ? initialThinkingLevel.trim() : null,
                settings: launchAutoApproveSettings,
            })
        setBusy(false)
        if (!result.ok) {
            setMessageTone('error')
            setMessage(result.code === 'WORKSPACE_LAUNCH_CONTEXT_REQUIRED'
                ? t('newSession.errorWorkspaceContextRequired')
                : (result.error || t('newSession.errorStartSession')))
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
        initialModel,
        initialThinkingLevel,
        launchAutoApproveSettings,
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
        t,
    ])

    const isCliResume = activeKind === 'cli' && !!selectedResumeSessionId
    const primaryActionLabel = workspaceMode === 'mesh'
        ? t('newSession.startMeshCoordinator')
        : activeKind === 'cli'
            ? (isCliResume ? t('newSession.resumeSavedHistory') : t('newSession.startFresh'))
            : activeKind === 'ide'
                ? t('newSession.startIde')
                : activeKind === 'acp'
                    ? t('newSession.startAcpSession')
                    : t('newSession.start')
    const primaryBusyLabel = workspaceMode === 'mesh'
        ? t('newSession.startingCoordinator')
        : activeKind === 'cli'
            ? (isCliResume ? t('newSession.resumingSavedHistory') : t('newSession.startingFresh'))
            : activeKind === 'ide'
                ? t('newSession.startingIde')
                : activeKind === 'acp'
                    ? t('newSession.startingAcpSession')
                    : t('newSession.starting')
    const useMachineDropdown = sortedMachines.length > 5

    if (!selectedMachine) {
        return null
    }

    return (
        <>
            <ModalPortal>
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
                                {t('newSession.title')}
                            </h2>
                        </div>
                        <button
                            type="button"
                            className="inline-flex items-center justify-center w-8 h-8 rounded-full border border-border-subtle bg-bg-primary text-text-secondary hover:text-text-primary hover:bg-surface-primary transition-colors shrink-0"
                            onClick={onClose}
                            aria-label={t('newSession.close')}
                        >
                            <IconX size={16} />
                        </button>
                    </div>

                    <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 sm:px-5 sm:py-4 space-y-4">
                        {/* Machine picker only when more than one machine is connected. */}
                        {sortedMachines.length > 1 && (
                            <LaunchSectionCard title={t('newSession.machine')}>
                                {useMachineDropdown ? (
                                    <select
                                        aria-label={t('newSession.machine')}
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
                                    <div className="flex flex-wrap gap-2" role="group" aria-label={t('newSession.machine')}>
                                        {sortedMachines.map(machine => {
                                            const label = getMachineDisplayName(machine, { fallbackId: machine.id })
                                            const selected = selectedMachine.id === machine.id
                                            return (
                                                <button
                                                    key={machine.id}
                                                    type="button"
                                                    aria-label={t('newSession.selectMachine', { name: label })}
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
                            title={t('newSession.workspace')}
                            action={workspaceMode === 'workspace' ? (
                                <button
                                    type="button"
                                    className="btn btn-secondary btn-sm"
                                    onClick={openBrowseDialog}
                                    disabled={busy}
                                >
                                    {t('newSession.browse')}
                                </button>
                            ) : undefined}
                        >
                            <div className="mb-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('newSession.launchTargetType')}>
                                {([
                                    { id: 'workspace', label: t('newSession.modeWorkspace'), desc: t('newSession.modeWorkspaceDesc') },
                                    { id: 'mesh', label: t('newSession.modeMesh'), desc: t('newSession.modeMeshDesc') },
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
                                        <div className="mt-0.5 text-2xs opacity-80">{option.desc}</div>
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
                                        <option value="__home__">{t('newSession.homeDirectory')}</option>
                                        {workspaceRows.map(workspace => (
                                            <option key={workspace.id} value={workspace.id}>
                                                {workspace.id === defaultWorkspaceId ? '★ ' : ''}{getWorkspaceDisplayLabel(workspace.path, workspace.label) || workspace.path}
                                            </option>
                                        ))}
                                        <option value="__custom__">{t('newSession.customFolder')}</option>
                                    </select>
                                    <div className="mt-2 text-2xs text-text-muted break-all">
                                        {workspaceChoice === '__home__'
                                            ? t('newSession.launchWithoutWorkspace')
                                            : resolvedWorkspacePath || t('newSession.selectWorkspaceFolder')}
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
                                                {t('newSession.selectFolder')}
                                            </button>
                                            <button
                                                type="button"
                                                className="btn btn-secondary btn-sm"
                                                onClick={handleSaveCurrentWorkspace}
                                                disabled={busy || savingWorkspace}
                                            >
                                                {savingWorkspace ? t('newSession.saving') : t('newSession.saveWorkspace')}
                                            </button>
                                        </div>
                                    )}
                                </>
                            ) : (
                                <div className="space-y-3">
                                    {meshLoading && (
                                        <div className="text-sm text-text-muted">{t('newSession.loadingMeshes')}</div>
                                    )}
                                    {!meshLoading && meshError && (
                                        <div className="rounded-lg border border-status-error/25 bg-status-error/10 px-3 py-2 text-sm text-status-error">
                                            {meshError}
                                        </div>
                                    )}
                                    {!meshLoading && !meshError && meshOptions.length === 0 && (
                                        <div className="rounded-lg border border-border-subtle bg-bg-secondary/40 px-3 py-2 text-sm text-text-muted">
                                            {t('newSession.noMeshes')}
                                        </div>
                                    )}
                                    {meshOptions.length > 0 && (
                                        <div className="grid grid-cols-1 gap-2" role="radiogroup" aria-label={t('newSession.mesh')}>
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
                                                        {mesh.repoIdentity || t('newSession.repoMesh')}{typeof mesh.nodesCount === 'number' ? ` · ${t('newSession.nodeCount', { count: mesh.nodesCount })}` : ''}
                                                    </div>
                                                    {mesh.workspace && (
                                                        <div className="mt-1 text-2xs text-text-muted break-all">{t('newSession.coordinatorWorkspace', { path: mesh.workspace })}</div>
                                                    )}
                                                </button>
                                            ))}
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
                            <div className="text-3xs uppercase tracking-[0.08em] text-text-muted mb-2">
                                {activeKind === 'ide' ? t('newSession.chooseIde') : activeKind === 'cli' ? t('newSession.chooseCliProvider') : t('newSession.chooseAcpProvider')}
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
                                        {target.meta && <div className="text-xs text-text-secondary mt-1">{target.meta}</div>}
                                    </button>
                                ))}
                                {providerTargets.length === 0 && (
                                    <div className="text-sm text-text-muted">
                                        {t('newSession.noProviders')}
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
                            <LaunchSectionCard title={t('newSession.startupArguments')}>
                                <input
                                    type="text"
                                    value={launchArgs}
                                    onChange={(event) => setLaunchArgs(event.target.value)}
                                    placeholder={t('newSession.optionalFlags')}
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

                        {((workspaceMode === 'mesh' && !!selectedTarget) || (workspaceMode !== 'mesh' && activeKind === 'cli')) && (
                            <LaunchSectionCard title={t('newSession.autoApproveMode')}>
                                {autoApproveModes ? (
                                    <AutoApproveModeSelector
                                        config={autoApproveModes}
                                        selectedModeId={selectedAutoApproveModeId}
                                        disabled={busy}
                                        onSelectMode={requestAutoApproveMode}
                                    />
                                ) : (
                                    <LegacyAutoApproveToggle
                                        checked={legacyAutoApprove}
                                        disabled={busy}
                                        onChange={setLegacyAutoApprove}
                                    />
                                )}
                            </LaunchSectionCard>
                        )}

                        {((workspaceMode === 'mesh' && !!selectedTarget) || (workspaceMode !== 'mesh' && activeKind !== 'ide')) && (
                            <LaunchSectionCard title={t('newSession.modelAndThinking')}>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                    <label className="flex flex-col gap-1">
                                        <span className="text-2xs text-text-muted">{t('newSession.model')}</span>
                                        {modelOptionsForTarget.length > 0 && !modelIsCustom ? (
                                            <select
                                                value={modelOptionsForTarget.includes(initialModel) ? initialModel : ''}
                                                onChange={(event) => {
                                                    if (event.target.value === '__custom__') {
                                                        setModelIsCustom(true)
                                                        setInitialModel('')
                                                    } else {
                                                        setInitialModel(event.target.value)
                                                    }
                                                }}
                                                className="w-full rounded-lg border border-border-subtle bg-bg-secondary text-text-primary px-3 py-2.5 text-sm"
                                                disabled={busy}
                                            >
                                                <option value="">{t('newSession.providerDefault')}</option>
                                                {modelOptionsForTarget.map((m: string) => <option key={m} value={m}>{m}</option>)}
                                                <option value="__custom__">{t('newSession.custom')}</option>
                                            </select>
                                        ) : (
                                            <>
                                                <input
                                                    type="text"
                                                    value={initialModel}
                                                    onChange={(event) => setInitialModel(event.target.value)}
                                                    placeholder={t('newSession.typeModelName')}
                                                    className="w-full rounded-lg border border-border-subtle bg-bg-secondary text-text-primary px-3 py-2.5 text-sm"
                                                    disabled={busy}
                                                    autoFocus={modelIsCustom}
                                                />
                                                {modelOptionsForTarget.length > 0 && (
                                                    <button
                                                        type="button"
                                                        className="self-start text-2xs text-accent-primary bg-transparent border-none cursor-pointer p-0"
                                                        onClick={() => { setModelIsCustom(false); setInitialModel('') }}
                                                        disabled={busy}
                                                    >
                                                        {t('newSession.backToModelList')}
                                                    </button>
                                                )}
                                            </>
                                        )}
                                    </label>
                                    <label className="flex flex-col gap-1">
                                        <span className="text-2xs text-text-muted">{t('newSession.thinkingLevel')}</span>
                                        <select
                                            value={initialThinkingLevel}
                                            onChange={(event) => setInitialThinkingLevel(event.target.value)}
                                            className="w-full rounded-lg border border-border-subtle bg-bg-secondary text-text-primary px-3 py-2.5 text-sm"
                                            disabled={busy}
                                        >
                                            <option value="">{t('newSession.providerDefault')}</option>
                                            {thinkingLevelOptionsForTarget.map((l: string) => <option key={l} value={l}>{l}</option>)}
                                        </select>
                                    </label>
                                </div>
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
                            <div className={`rounded-xl border px-4 py-3 text-sm ${messageTone === 'info' ? 'border-accent/25 bg-accent/10 text-text-primary' : 'border-status-error/25 bg-status-error/10 text-status-error'}`}>
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
                            {t('common.cancel')}
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
            </ModalPortal>

            {browseDialogOpen && (
                <WorkspaceBrowseDialog
                    title={t('newSession.selectWorkspaceTitle')}
                    description={t('newSession.selectWorkspaceDescription')}
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
                            useHome: launchTarget.useHome,
                            resumeSessionId: session.providerSessionId,
                            settings: launchAutoApproveSettings,
                        }).then((result) => {
                            if (!result.ok) {
                                setMessageTone('error')
                                setMessage(result.code === 'WORKSPACE_LAUNCH_CONTEXT_REQUIRED'
                                    ? t('newSession.errorWorkspaceContextRequired')
                                    : (result.error || t('newSession.errorResumeSession')))
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
            {pendingDangerousMode && (
                <DangerousAutoApproveModeDialog
                    mode={pendingDangerousMode}
                    onConfirm={() => {
                        setSelectedAutoApproveModeId(pendingDangerousMode.id)
                        setPendingDangerousMode(null)
                    }}
                    onCancel={() => setPendingDangerousMode(null)}
                />
            )}
        </>
    )
}
