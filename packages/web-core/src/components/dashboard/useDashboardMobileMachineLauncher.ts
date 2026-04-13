import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DaemonData } from '../../types'
import { useDaemonMetadataLoader } from '../../hooks/useDaemonMetadataLoader'
import type { LaunchWorkspaceOption, WorkspaceLaunchKind } from '../../pages/machine/types'
import type { MobileMachineActionState } from './DashboardMobileChatShared'
import type { BrowseDirectoryResult } from '../machine/workspaceBrowse'
import { collectBrowsePathCandidates, getDefaultBrowseStartPath } from '../machine/workspaceBrowse'

interface LaunchProviderInfo {
    type: string
    displayName: string
    icon?: string
}

interface LaunchConfirmState {
    title: string
    description: string
    details: Array<{ label: string; value: string }>
    confirmLabel: string
    busyLabel?: string
    workspaceOptions?: LaunchWorkspaceOption[]
    showArgsInput?: boolean
    showModelInput?: boolean
    providerType?: string
}

interface UseDashboardMobileMachineLauncherOptions {
    selectedMachineEntry: DaemonData
    cliProviders: LaunchProviderInfo[]
    acpProviders: LaunchProviderInfo[]
    machineAction: MobileMachineActionState
    onBrowseDirectory: (path: string) => Promise<BrowseDirectoryResult>
    onListSavedSessions?: (providerType: string) => Promise<any[]>
}

function getDefaultLauncherKind(
    ideAvailable: boolean,
    cliCount: number,
    acpCount: number,
): WorkspaceLaunchKind | null {
    return ideAvailable ? 'ide' : cliCount > 0 ? 'cli' : acpCount > 0 ? 'acp' : null
}

export function useDashboardMobileMachineLauncher({
    selectedMachineEntry,
    cliProviders,
    acpProviders,
    machineAction,
    onBrowseDirectory,
    onListSavedSessions,
}: UseDashboardMobileMachineLauncherOptions) {
    const loadDaemonMetadata = useDaemonMetadataLoader()
    const [showAllRecent, setShowAllRecent] = useState(false)
    const hasIdeOptions = (selectedMachineEntry.detectedIdes?.length || 0) > 0
    const workspaceRows = useMemo(
        () => (selectedMachineEntry.workspaces || []).map(w => ({ id: w.id, path: w.path, label: w.label })),
        [selectedMachineEntry],
    )
    const defaultWorkspaceId = selectedMachineEntry.defaultWorkspaceId || null

    const [workspaceChoice, setWorkspaceChoice] = useState<string>(defaultWorkspaceId || (workspaceRows[0]?.id || ''))
    const [customWorkspacePath, setCustomWorkspacePath] = useState('')
    const [browseCurrentPath, setBrowseCurrentPath] = useState('')
    const [browseDirectories, setBrowseDirectories] = useState<Array<{ name: string; path: string }>>([])
    const [browseBusy, setBrowseBusy] = useState(false)
    const [browseError, setBrowseError] = useState('')
    const [browseDialogOpen, setBrowseDialogOpen] = useState(false)
    const [activeLauncherKind, setActiveLauncherKind] = useState<WorkspaceLaunchKind | null>(
        getDefaultLauncherKind(hasIdeOptions, cliProviders.length, acpProviders.length),
    )

    const launchConfirmActionRef = useRef<(() => Promise<void>) | null>(null)
    const [launchConfirm, setLaunchConfirm] = useState<LaunchConfirmState | null>(null)
    const launchConfirmWorkspaceKeyRef = useRef('__home__')
    const [launchConfirmWorkspaceKey, setLaunchConfirmWorkspaceKey] = useState('__home__')
    const [launchConfirmArgs, setLaunchConfirmArgs] = useState('')
    const [launchConfirmModel, setLaunchConfirmModel] = useState('')
    const [launchConfirmResumeId, setLaunchConfirmResumeId] = useState('')
    const [launchConfirmSavedSessions, setLaunchConfirmSavedSessions] = useState<any[]>([])
    const [launchConfirmSessionsLoading, setLaunchConfirmSessionsLoading] = useState(false)
    const [launchConfirmBusy, setLaunchConfirmBusy] = useState(false)
    const lastMachineIdRef = useRef<string | null>(null)

    useEffect(() => {
        const needsMetadata = !selectedMachineEntry.workspaces
            || !selectedMachineEntry.availableProviders
            || !selectedMachineEntry.detectedIdes
            || !selectedMachineEntry.recentLaunches
        if (!needsMetadata) return
        void loadDaemonMetadata(selectedMachineEntry.id, { minFreshMs: 30_000 }).catch(() => {})
    }, [loadDaemonMetadata, selectedMachineEntry])

    const resolvedWorkspacePath = workspaceChoice === '__custom__'
        ? customWorkspacePath.trim()
        : (workspaceRows.find(workspace => workspace.id === workspaceChoice)?.path || '')
    const canCreateMissingWorkspace = workspaceChoice === '__custom__'
        && !!resolvedWorkspacePath
        && machineAction.state === 'error'
        && /(Directory path is not valid or does not exist|Path does not exist)/i.test(machineAction.message)
    const savedWorkspacePath = workspaceChoice !== '__custom__'
        ? (workspaceRows.find(workspace => workspace.id === workspaceChoice)?.path || '')
        : ''
    const recentWorkspaceCandidates = useMemo(
        () => (selectedMachineEntry.recentLaunches || []).map(launch => launch.workspace),
        [selectedMachineEntry],
    )

    const loadBrowsePath = useCallback(async (path: string) => {
        setBrowseBusy(true)
        setBrowseError('')
        try {
            const result = await onBrowseDirectory(path)
            setBrowseCurrentPath(result.path)
            setCustomWorkspacePath(result.path)
            setBrowseDirectories(result.directories)
        } catch (error) {
            setBrowseError(error instanceof Error ? error.message : 'Could not load folder')
        } finally {
            setBrowseBusy(false)
        }
    }, [onBrowseDirectory])

    const openBrowseDialog = useCallback(() => {
        setWorkspaceChoice('__custom__')
        setBrowseDialogOpen(true)
        const initialPath = getDefaultBrowseStartPath(
            selectedMachineEntry.platform,
            collectBrowsePathCandidates(
                customWorkspacePath.trim(),
                savedWorkspacePath,
                recentWorkspaceCandidates,
                selectedMachineEntry.defaultWorkspacePath,
                workspaceRows.find(workspace => workspace.id === defaultWorkspaceId)?.path,
                workspaceRows.map(workspace => workspace.path),
            ),
        )
        void loadBrowsePath(initialPath)
    }, [
        customWorkspacePath,
        defaultWorkspaceId,
        loadBrowsePath,
        recentWorkspaceCandidates,
        savedWorkspacePath,
        selectedMachineEntry.platform,
        workspaceRows,
    ])

    const setWorkspaceSelectionFromOption = useCallback((selectedOption?: LaunchWorkspaceOption) => {
        if (selectedOption?.workspaceId) {
            setWorkspaceChoice(selectedOption.workspaceId)
            setCustomWorkspacePath('')
            return
        }
        if (selectedOption?.workspacePath) {
            setWorkspaceChoice('__custom__')
            setCustomWorkspacePath(selectedOption.workspacePath)
            return
        }
        setWorkspaceChoice('')
        setCustomWorkspacePath('')
    }, [])

    const handleWorkspaceChoiceChange = useCallback((nextValue: string) => {
        setWorkspaceChoice(nextValue)
        if (nextValue === '__custom__') {
            openBrowseDialog()
            return
        }
        setCustomWorkspacePath('')
    }, [openBrowseDialog])

    const chooseCustomWorkspacePath = useCallback((path: string) => {
        setWorkspaceChoice('__custom__')
        setCustomWorkspacePath(path)
    }, [])

    const openLaunchConfirm = useCallback((
        config: LaunchConfirmState & {
            selectedWorkspaceKey?: string
            initialArgs?: string
            initialModel?: string
        },
        action: () => Promise<void>,
    ) => {
        launchConfirmActionRef.current = action
        launchConfirmWorkspaceKeyRef.current = config.selectedWorkspaceKey || '__home__'
        setLaunchConfirmWorkspaceKey(config.selectedWorkspaceKey || '__home__')
        setLaunchConfirmArgs(config.initialArgs || '')
        setLaunchConfirmModel(config.initialModel || '')
        setLaunchConfirmResumeId('')
        setLaunchConfirmSavedSessions([])
        setLaunchConfirm(config)

        if (config.providerType && onListSavedSessions) {
            setLaunchConfirmSessionsLoading(true)
            onListSavedSessions(config.providerType)
                .then(sessions => setLaunchConfirmSavedSessions(sessions || []))
                .catch(err => console.warn('Failed to load saved sessions', err))
                .finally(() => setLaunchConfirmSessionsLoading(false))
        }
    }, [onListSavedSessions])

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

    const closeLaunchConfirm = useCallback(() => {
        launchConfirmActionRef.current = null
        setLaunchConfirm(null)
    }, [])

    const setLaunchConfirmWorkspaceKeyAndSync = useCallback((key: string) => {
        launchConfirmWorkspaceKeyRef.current = key
        setLaunchConfirmWorkspaceKey(key)
    }, [])

    useEffect(() => {
        if (lastMachineIdRef.current !== selectedMachineEntry.id) {
            lastMachineIdRef.current = selectedMachineEntry.id
            setWorkspaceChoice(defaultWorkspaceId || (workspaceRows[0]?.id || '__custom__'))
            setCustomWorkspacePath('')
            setBrowseCurrentPath('')
            setBrowseDirectories([])
            setBrowseError('')
            setBrowseDialogOpen(false)
            setActiveLauncherKind(getDefaultLauncherKind(hasIdeOptions, cliProviders.length, acpProviders.length))
        }
    }, [acpProviders.length, cliProviders.length, defaultWorkspaceId, hasIdeOptions, selectedMachineEntry.id, workspaceRows])

    useEffect(() => {
        if (workspaceChoice === '__custom__') return
        if (workspaceChoice && workspaceRows.some(workspace => workspace.id === workspaceChoice)) return
        setWorkspaceChoice(defaultWorkspaceId || (workspaceRows[0]?.id || '__custom__'))
    }, [defaultWorkspaceId, workspaceChoice, workspaceRows])

    useEffect(() => {
        if (activeLauncherKind === 'ide' && hasIdeOptions) return
        if (activeLauncherKind === 'cli' && cliProviders.length > 0) return
        if (activeLauncherKind === 'acp' && acpProviders.length > 0) return
        setActiveLauncherKind(getDefaultLauncherKind(hasIdeOptions, cliProviders.length, acpProviders.length))
    }, [activeLauncherKind, acpProviders.length, cliProviders.length, hasIdeOptions])

    return {
        showAllRecent,
        setShowAllRecent,
        hasIdeOptions,
        workspaceRows,
        defaultWorkspaceId,
        workspaceChoice,
        customWorkspacePath,
        browseCurrentPath,
        browseDirectories,
        browseBusy,
        browseError,
        browseDialogOpen,
        activeLauncherKind,
        launchConfirm,
        launchConfirmWorkspaceKeyRef,
        launchConfirmWorkspaceKey,
        launchConfirmArgs,
        launchConfirmModel,
        launchConfirmResumeId,
        launchConfirmSavedSessions,
        launchConfirmSessionsLoading,
        launchConfirmBusy,
        resolvedWorkspacePath,
        canCreateMissingWorkspace,
        openBrowseDialog,
        loadBrowsePath,
        handleWorkspaceChoiceChange,
        chooseCustomWorkspacePath,
        setCustomWorkspacePath,
        setBrowseDialogOpen,
        setActiveLauncherKind,
        openLaunchConfirm,
        handleConfirmLaunch,
        closeLaunchConfirm,
        setWorkspaceSelectionFromOption,
        setLaunchConfirmWorkspaceKeyAndSync,
        setLaunchConfirmArgs,
        setLaunchConfirmModel,
        setLaunchConfirmResumeId,
    }
}
