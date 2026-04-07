import { IconChevronLeft, IconFolder } from '../Icons'
import type { DaemonData } from '../../types'
import { formatRelativeTime, type MobileConversationListItem, type MobileMachineActionState } from './DashboardMobileChatShared'
import type { ActiveConversation } from './types'
import type { MachineRecentLaunch, WorkspaceLaunchKind } from '../../pages/machine/types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getMachineDisplayName, getWorkspaceDisplayLabel } from '../../utils/daemon-utils'
import DashboardMobileBottomNav, { type DashboardMobileSection } from './DashboardMobileBottomNav'
import WorkspaceBrowseDialog from '../machine/WorkspaceBrowseDialog'
import LaunchConfirmDialog from '../machine/LaunchConfirmDialog'
import type { BrowseDirectoryResult } from '../machine/workspaceBrowse'
import { getDefaultBrowseStartPath } from '../machine/workspaceBrowse'
import { buildLaunchWorkspaceOptions } from '../machine/launchWorkspaceOptions'
import type { LaunchWorkspaceOption } from '../../pages/machine/types'

interface LaunchProviderInfo {
    type: string
    displayName: string
    icon?: string
}

interface DashboardMobileMachineScreenProps {
    selectedMachineEntry: DaemonData
    selectedMachineConversations: MobileConversationListItem[]
    selectedMachineRecentLaunches: MachineRecentLaunch[]
    cliProviders: LaunchProviderInfo[]
    acpProviders: LaunchProviderInfo[]
    selectedMachineNeedsUpgrade: boolean
    appVersion: string | null
    machineAction: MobileMachineActionState
    isStandalone: boolean
    section: DashboardMobileSection
    showBottomNav: boolean
    onBack: () => void
    onSectionChange: (section: DashboardMobileSection) => void
    onOpenConversation: (conversation: ActiveConversation) => void
    onOpenRecent: (launch: MachineRecentLaunch) => void
    onOpenMachineDetails: () => void
    onMachineUpgrade: () => void
    onLaunchDetectedIde: (ideType: string, opts?: { workspacePath?: string | null }) => void
    onAddWorkspace: (path: string, opts?: { createIfMissing?: boolean }) => void
    onBrowseDirectory: (path: string) => Promise<BrowseDirectoryResult>
    onLaunchWorkspaceProvider: (kind: Extract<WorkspaceLaunchKind, 'cli' | 'acp'>, providerType: string, opts?: { workspaceId?: string | null; workspacePath?: string | null }) => void
}

export default function DashboardMobileMachineScreen({
    selectedMachineEntry,
    selectedMachineConversations,
    selectedMachineRecentLaunches,
    cliProviders,
    acpProviders,
    selectedMachineNeedsUpgrade,
    appVersion,
    machineAction,
    isStandalone,
    section,
    showBottomNav,
    onBack,
    onSectionChange,
    onOpenConversation,
    onOpenRecent,
    onOpenMachineDetails,
    onMachineUpgrade,
    onLaunchDetectedIde,
    onAddWorkspace,
    onBrowseDirectory,
    onLaunchWorkspaceProvider,
}: DashboardMobileMachineScreenProps) {
    const getDefaultLauncherKind = (
        ideAvailable: boolean,
        cliCount: number,
        acpCount: number,
    ): WorkspaceLaunchKind | null => (
        ideAvailable ? 'ide' : cliCount > 0 ? 'cli' : acpCount > 0 ? 'acp' : null
    )

    const [showAllRecent, setShowAllRecent] = useState(false)
    const formatKindLabel = (kind: MachineRecentLaunch['kind']) => {
        if (kind === 'ide') return 'IDE'
        if (kind === 'cli') return 'CLI'
        return 'ACP'
    }

    const topRecentLaunches = selectedMachineRecentLaunches.slice(0, 4)
    const topConversationItems = selectedMachineConversations.slice(0, 3)
    const hasIdeOptions = (selectedMachineEntry.detectedIdes?.length || 0) > 0
    const workspaceRows = useMemo(() => ((selectedMachineEntry as any).workspaces || []) as Array<{ id: string; path: string; label?: string }>, [selectedMachineEntry])
    const defaultWorkspaceId = ((selectedMachineEntry as any).defaultWorkspaceId as string | null | undefined) || null
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
    const [launchConfirm, setLaunchConfirm] = useState<{
        title: string
        description: string
        details: Array<{ label: string; value: string }>
        confirmLabel: string
        workspaceOptions?: LaunchWorkspaceOption[]
    } | null>(null)
    const launchConfirmWorkspaceKeyRef = useRef('__home__')
    const [launchConfirmWorkspaceKey, setLaunchConfirmWorkspaceKey] = useState('__home__')
    const [launchConfirmBusy, setLaunchConfirmBusy] = useState(false)
    const lastMachineIdRef = useRef<string | null>(null)
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
        const initialPath = getDefaultBrowseStartPath(selectedMachineEntry.platform, [
            customWorkspacePath.trim(),
            savedWorkspacePath,
            workspaceRows.find(workspace => workspace.id === defaultWorkspaceId)?.path,
            workspaceRows[0]?.path,
        ])
        void loadBrowsePath(initialPath)
    }, [customWorkspacePath, defaultWorkspaceId, loadBrowsePath, savedWorkspacePath, selectedMachineEntry.platform, workspaceRows])

    const openLaunchConfirm = useCallback((
        config: {
            title: string
            description: string
            details: Array<{ label: string; value: string }>
            confirmLabel: string
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

    const recentCards = useMemo(() => {
        const launchCards = topRecentLaunches.map(session => ({
            key: `recent-launch:${session.id}`,
            type: 'session' as const,
            primary: session.label,
            secondary: `${formatKindLabel(session.kind)}${session.subtitle ? ` · ${session.subtitle}` : ''}`,
            unread: false,
            onClick: () => {
                const { options, selectedKey } = buildLaunchWorkspaceOptions({
                    machine: {
                        workspaces: workspaceRows,
                        defaultWorkspaceId,
                    },
                    currentWorkspacePath: session.workspace,
                })
                openLaunchConfirm({
                    title: `Launch ${session.label}?`,
                    description: 'Recent launches require one more confirmation before they run.',
                    confirmLabel: 'Launch',
                    workspaceOptions: options,
                    selectedWorkspaceKey: selectedKey,
                    details: [
                        { label: 'Mode', value: formatKindLabel(session.kind) },
                        ...(session.providerType ? [{ label: 'Provider', value: session.providerType }] : []),
                    ],
                }, async () => {
                    const selectedOption = options.find(option => option.key === launchConfirmWorkspaceKeyRef.current)
                    if (selectedOption?.workspaceId) {
                        setWorkspaceChoice(selectedOption.workspaceId)
                        setCustomWorkspacePath('')
                    } else if (selectedOption?.workspacePath) {
                        setWorkspaceChoice('__custom__')
                        setCustomWorkspacePath(selectedOption.workspacePath)
                    } else {
                        setWorkspaceChoice('')
                        setCustomWorkspacePath('')
                    }
                    await onOpenRecent({
                        ...session,
                        workspace: selectedOption?.workspacePath ?? null,
                    })
                })
            },
        }))
        const conversationCards = topConversationItems.map(item => ({
            key: `recent-chat:${item.conversation.tabKey}`,
            type: 'conversation' as const,
            primary: item.conversation.displayPrimary,
            secondary: `Chat${item.conversation.displaySecondary ? ` · ${item.conversation.displaySecondary}` : ''}${item.timestamp ? ` · ${formatRelativeTime(item.timestamp)}` : ''}`,
            unread: item.unread,
            onClick: () => onOpenConversation(item.conversation),
        }))
        return [...launchCards, ...conversationCards]
    }, [defaultWorkspaceId, onOpenConversation, onOpenRecent, openLaunchConfirm, topConversationItems, topRecentLaunches, workspaceRows])
    const visibleRecentCards = showAllRecent ? recentCards : recentCards.slice(0, 5)
    const hasRecentItems = recentCards.length > 0
    const headerPaddingClass = isStandalone
        ? 'px-4 pt-4 pb-3'
        : 'px-4 pt-[calc(16px+env(safe-area-inset-top,0px))] pb-3'

    return (
        <>
            <div className={`flex items-center justify-between gap-3 ${headerPaddingClass} border-b border-border-subtle/70 bg-bg-primary backdrop-blur-md`}>
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <button
                        className="w-[34px] h-[34px] rounded-full border border-border-default bg-surface-primary/70 text-text-secondary shrink-0 inline-flex items-center justify-center hover:bg-surface-primary transition-colors"
                        onClick={onBack}
                        type="button"
                        aria-label="Back"
                    >
                        <IconChevronLeft size={18} />
                    </button>
                    <div className="min-w-0 flex flex-col gap-0.5">
                        <div className="flex items-center gap-2 text-[17px] font-extrabold tracking-tight text-text-primary truncate">
                            {getMachineDisplayName(selectedMachineEntry, { fallbackId: selectedMachineEntry.id })}
                        </div>
                        <div className="min-w-0 flex items-center flex-wrap gap-1.5 text-xs text-text-secondary truncate">
                            {(selectedMachineEntry.platform || 'machine')}
                            {selectedMachineEntry.version ? ` · v${selectedMachineEntry.version}` : ''}
                        </div>
                    </div>
                </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto py-2 flex flex-col gap-2 -webkit-overflow-scrolling-touch">
                {hasRecentItems && (
                    <section className="flex flex-col gap-0">
                        <div className="text-[11px] font-extrabold tracking-[0.08em] uppercase text-text-muted px-4 pb-2">Recent</div>
                        <div className="grid grid-cols-1 gap-2.5 px-4">
                            {visibleRecentCards.map(card => (
                                <button
                                    key={card.key}
                                    className={`flex flex-col gap-1 w-full text-left p-[14px] rounded-2xl border ${card.unread ? 'border-accent-primary/25 bg-accent-primary/5' : 'border-border-default/80 bg-surface-primary/90'} text-text-primary`}
                                    type="button"
                                    onClick={card.onClick}
                                >
                                    <span className="text-sm font-bold text-text-primary">{card.primary}</span>
                                    <span className="text-xs leading-relaxed text-text-secondary">
                                        {card.secondary}
                                    </span>
                                </button>
                            ))}
                        </div>
                        {recentCards.length > 5 && (
                            <div className="flex justify-center px-4 pt-2">
                                <button
                                    type="button"
                                    className="min-h-[34px] px-3.5 rounded-full border border-border-default/80 bg-surface-primary/90 text-text-secondary text-xs font-bold"
                                    onClick={() => setShowAllRecent(current => !current)}
                                >
                                    {showAllRecent ? 'Show fewer' : `Show ${recentCards.length - 5} more`}
                                </button>
                            </div>
                        )}
                    </section>
                )}

                {(hasIdeOptions || cliProviders.length > 0 || acpProviders.length > 0) && (
                    <section className="flex flex-col gap-0">
                        <div className="text-[11px] font-extrabold tracking-[0.08em] uppercase text-text-muted px-4 pb-2">Start</div>
                        <div className="grid grid-cols-1 gap-2.5 px-4">
                            <div className="flex flex-col gap-2.5 w-full p-3.5 rounded-2xl border border-border-default/80 bg-surface-primary/90">
                                <div className="text-sm font-bold text-text-primary">Workspace</div>
                                <div className="text-xs leading-relaxed text-text-secondary">
                                    Pick a saved workspace or browse folders before choosing IDE, CLI, or ACP.
                                </div>
                                <select
                                    value={workspaceChoice}
                                    onChange={(event) => {
                                        const nextValue = event.target.value
                                        setWorkspaceChoice(nextValue)
                                        if (nextValue === '__custom__') {
                                            openBrowseDialog()
                                            return
                                        }
                                        setCustomWorkspacePath('')
                                    }}
                                    className="w-full rounded-xl border border-border-default/90 bg-bg-primary/90 text-text-primary px-3 py-3 text-sm"
                                >
                                    {workspaceRows.length > 0 ? (
                                        <>
                                            {workspaceRows.map(workspace => (
                                                <option key={workspace.id} value={workspace.id}>
                                                    {workspace.id === defaultWorkspaceId ? '⭐ ' : ''}
                                                    {getWorkspaceDisplayLabel(workspace.path, workspace.label) || workspace.path}
                                                </option>
                                            ))}
                                            <option value="__custom__">Select workspace…</option>
                                        </>
                                    ) : (
                                        <option value="__custom__">Select workspace…</option>
                                    )}
                                </select>
                                {workspaceChoice === '__custom__' && (
                                    <div className="flex flex-col gap-2.5">
                                        <div className="rounded-2xl border border-border-default/80 bg-bg-primary/80 px-3.5 py-3">
                                            <div className="flex items-start gap-3">
                                                <span className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-accent-primary/10 text-accent-primary shrink-0">
                                                    <IconFolder size={17} />
                                                </span>
                                                <div className="min-w-0 flex-1">
                                                    <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-text-muted mb-1">Selected folder</div>
                                                    <div className="text-[12px] leading-relaxed text-text-primary break-all">
                                                        {resolvedWorkspacePath || browseCurrentPath || 'No folder selected yet.'}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                            <button
                                                type="button"
                                                className="inline-flex items-center justify-center min-h-[36px] px-3 rounded-xl border border-border-default/90 bg-bg-primary/90 text-text-secondary text-[12px] font-bold"
                                                onClick={openBrowseDialog}
                                            >
                                                Select workspace…
                                            </button>
                                            <button
                                                type="button"
                                                className="inline-flex items-center justify-center min-h-[36px] px-3 rounded-xl border border-accent-primary/30 bg-accent-primary/10 text-text-primary text-[12px] font-bold disabled:opacity-40"
                                                onClick={() => {
                                                    if (!resolvedWorkspacePath) return
                                                    onAddWorkspace(resolvedWorkspacePath)
                                                }}
                                                disabled={!resolvedWorkspacePath || browseBusy}
                                            >
                                                Save as workspace
                                            </button>
                                        </div>
                                    </div>
                                )}
                                {resolvedWorkspacePath && (
                                    <div className="text-[11px] leading-relaxed text-text-muted break-all">{resolvedWorkspacePath}</div>
                                )}
                            </div>
                        </div>
                        <div className="grid grid-cols-3 gap-2 px-4">
                            {hasIdeOptions && (
                                <button
                                    className={`min-h-[40px] rounded-full border text-xs font-bold ${activeLauncherKind === 'ide' ? 'border-accent-primary/30 bg-accent-primary/10 text-text-primary' : 'border-border-default/80 bg-surface-primary/90 text-text-secondary'}`}
                                    type="button"
                                    onClick={() => setActiveLauncherKind('ide')}
                                >
                                    IDE
                                </button>
                            )}
                            {cliProviders.length > 0 && (
                                <button
                                    className={`min-h-[40px] rounded-full border text-xs font-bold ${activeLauncherKind === 'cli' ? 'border-accent-primary/30 bg-accent-primary/10 text-text-primary' : 'border-border-default/80 bg-surface-primary/90 text-text-secondary'}`}
                                    type="button"
                                    onClick={() => setActiveLauncherKind('cli')}
                                >
                                    CLI
                                </button>
                            )}
                            {acpProviders.length > 0 && (
                                <button
                                    className={`min-h-[40px] rounded-full border text-xs font-bold ${activeLauncherKind === 'acp' ? 'border-accent-primary/30 bg-accent-primary/10 text-text-primary' : 'border-border-default/80 bg-surface-primary/90 text-text-secondary'}`}
                                    type="button"
                                    onClick={() => setActiveLauncherKind('acp')}
                                >
                                    ACP
                                </button>
                            )}
                        </div>
                        {activeLauncherKind && (
                            <div className="flex flex-col gap-2.5 px-4 pt-3">
                                <div className="text-xs font-bold text-text-secondary">
                                    {activeLauncherKind === 'ide'
                                        ? 'Choose an IDE'
                                        : activeLauncherKind === 'cli'
                                            ? 'Choose a CLI provider'
                                            : 'Choose an ACP provider'}
                                </div>
                                <div className="grid grid-cols-1 gap-2">
                                    {activeLauncherKind === 'ide'
                                        ? (selectedMachineEntry.detectedIdes || []).slice(0, 6).map(ide => (
                                            <button
                                                key={ide.type}
                                                type="button"
                                                className="flex flex-col items-start gap-1 w-full text-left p-3 rounded-2xl border border-border-default/80 bg-surface-primary/90 text-text-primary"
                                                onClick={() => {
                                                    const { options, selectedKey } = buildLaunchWorkspaceOptions({
                                                        machine: {
                                                            workspaces: workspaceRows,
                                                            defaultWorkspaceId,
                                                        },
                                                        currentWorkspaceId: workspaceChoice !== '__custom__' ? workspaceChoice : null,
                                                        currentWorkspacePath: resolvedWorkspacePath,
                                                    })
                                                    openLaunchConfirm({
                                                        title: `Launch ${ide.name}?`,
                                                        description: 'Review or change the target folder before opening this IDE.',
                                                        confirmLabel: 'Launch IDE',
                                                        workspaceOptions: options,
                                                        selectedWorkspaceKey: selectedKey,
                                                        details: [
                                                            { label: 'Mode', value: 'IDE' },
                                                            { label: 'Provider', value: ide.name },
                                                        ],
                                                    }, async () => {
                                                        const selectedOption = options.find(option => option.key === launchConfirmWorkspaceKeyRef.current)
                                                        if (selectedOption?.workspaceId) {
                                                            setWorkspaceChoice(selectedOption.workspaceId)
                                                            setCustomWorkspacePath('')
                                                        } else if (selectedOption?.workspacePath) {
                                                            setWorkspaceChoice('__custom__')
                                                            setCustomWorkspacePath(selectedOption.workspacePath)
                                                        } else {
                                                            setWorkspaceChoice('')
                                                            setCustomWorkspacePath('')
                                                        }
                                                        onLaunchDetectedIde(ide.type, {
                                                            workspacePath: selectedOption?.workspacePath ?? null,
                                                        })
                                                    })
                                                }}
                                            >
                                                <span className="text-[13px] font-bold text-text-primary">{ide.name}</span>
                                                <span className="text-[11px] leading-relaxed text-text-muted break-all">
                                                    {resolvedWorkspacePath || 'Use selected workspace'}
                                                </span>
                                            </button>
                                        ))
                                        : (activeLauncherKind === 'cli' ? cliProviders : acpProviders).map(provider => (
                                            <button
                                                key={provider.type}
                                                type="button"
                                                className="flex flex-col items-start gap-1 w-full text-left p-3 rounded-2xl border border-border-default/80 bg-surface-primary/90 text-text-primary"
                                                onClick={() => {
                                                    const { options, selectedKey } = buildLaunchWorkspaceOptions({
                                                        machine: {
                                                            workspaces: workspaceRows,
                                                            defaultWorkspaceId,
                                                        },
                                                        currentWorkspaceId: workspaceChoice !== '__custom__' ? workspaceChoice : null,
                                                        currentWorkspacePath: resolvedWorkspacePath,
                                                    })
                                                    openLaunchConfirm({
                                                        title: `Launch ${provider.displayName}?`,
                                                        description: 'Review or change the provider workspace before starting this session.',
                                                        confirmLabel: `Launch ${activeLauncherKind.toUpperCase()}`,
                                                        workspaceOptions: options,
                                                        selectedWorkspaceKey: selectedKey,
                                                        details: [
                                                            { label: 'Mode', value: activeLauncherKind.toUpperCase() },
                                                            { label: 'Provider', value: provider.displayName },
                                                        ],
                                                    }, async () => {
                                                        const selectedOption = options.find(option => option.key === launchConfirmWorkspaceKeyRef.current)
                                                        if (selectedOption?.workspaceId) {
                                                            setWorkspaceChoice(selectedOption.workspaceId)
                                                            setCustomWorkspacePath('')
                                                        } else if (selectedOption?.workspacePath) {
                                                            setWorkspaceChoice('__custom__')
                                                            setCustomWorkspacePath(selectedOption.workspacePath)
                                                        } else {
                                                            setWorkspaceChoice('')
                                                            setCustomWorkspacePath('')
                                                        }
                                                        onLaunchWorkspaceProvider(activeLauncherKind, provider.type, {
                                                            workspaceId: selectedOption?.workspaceId ?? null,
                                                            workspacePath: selectedOption?.workspacePath ?? null,
                                                        })
                                                    })
                                                }}
                                            >
                                                <span className="text-[13px] font-bold text-text-primary">
                                                    {provider.icon ? `${provider.icon} ` : ''}{provider.displayName}
                                                </span>
                                                <span className="text-[11px] leading-relaxed text-text-muted break-all">
                                                    {resolvedWorkspacePath || 'Use selected workspace'}
                                                </span>
                                            </button>
                                        ))}
                                </div>
                            </div>
                        )}
                        {machineAction.message && (
                            <div className={`mx-4 mt-2.5 p-3 rounded-xl text-xs leading-relaxed ${machineAction.state === 'error' ? 'text-status-error bg-status-error/10' : 'text-text-secondary bg-surface-primary/90'}`}>
                                {machineAction.message}
                                {canCreateMissingWorkspace && (
                                    <div className="mt-2">
                                        <button
                                            type="button"
                                            className="inline-flex items-center justify-center min-h-[34px] px-4 rounded-lg bg-surface-primary text-text-primary font-bold text-xs"
                                            onClick={() => onAddWorkspace(resolvedWorkspacePath, { createIfMissing: true })}
                                        >
                                            Create folder
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                    </section>
                )}

                <section className="flex flex-col gap-0">
                    <div className="text-[11px] font-extrabold tracking-[0.08em] uppercase text-text-muted px-4 pb-2">Inspect</div>
                    <div className="grid grid-cols-1 gap-2.5 px-4">
                        {selectedMachineNeedsUpgrade && (
                            <button
                                className="flex flex-col gap-1 w-full text-left p-[14px] rounded-2xl border border-accent-primary/25 bg-accent-primary/5 text-text-primary"
                                type="button"
                                onClick={onMachineUpgrade}
                            >
                                <span className="text-sm font-bold text-text-primary">Update to v{appVersion}</span>
                                <span className="text-xs leading-relaxed text-text-secondary">
                                    Restart this machine with the latest daemon
                                </span>
                            </button>
                        )}
                        <button
                            className="flex flex-col gap-1 w-full text-left p-[14px] rounded-2xl border border-border-default/80 bg-surface-primary/90 text-text-primary"
                            type="button"
                            onClick={onOpenMachineDetails}
                        >
                            <span className="text-sm font-bold text-text-primary">Machine details</span>
                            <span className="text-xs leading-relaxed text-text-secondary">
                                Sessions, providers, system info, and logs
                            </span>
                        </button>
                    </div>
                </section>
            </div>
            {browseDialogOpen && (
                <WorkspaceBrowseDialog
                    title="Select workspace"
                    description="Move through folders like a normal explorer, then use the current folder for this machine."
                    currentPath={browseCurrentPath}
                    directories={browseDirectories}
                    busy={browseBusy}
                    error={browseError}
                    confirmLabel="Use this folder"
                    onClose={() => setBrowseDialogOpen(false)}
                    onNavigate={(path) => { void loadBrowsePath(path) }}
                    onConfirm={(path) => {
                        setCustomWorkspacePath(path)
                        setWorkspaceChoice('__custom__')
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
                    busy={launchConfirmBusy}
                    onConfirm={handleConfirmLaunch}
                    onCancel={() => {
                        launchConfirmActionRef.current = null
                        setLaunchConfirm(null)
                    }}
                />
            )}
            {showBottomNav && (
                <DashboardMobileBottomNav section={section} onSectionChange={onSectionChange} />
            )}
        </>
    )
}
