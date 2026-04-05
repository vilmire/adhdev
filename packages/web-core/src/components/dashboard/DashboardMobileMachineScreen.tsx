import { IconChevronLeft } from '../Icons'
import type { DaemonData } from '../../types'
import { formatRelativeTime, type MobileConversationListItem, type MobileMachineActionState } from './DashboardMobileChatShared'
import type { ActiveConversation } from './types'
import type { MachineRecentLaunch, WorkspaceLaunchKind } from '../../pages/machine/types'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getMachineDisplayName } from '../../utils/daemon-utils'
import DashboardMobileBottomNav, { type DashboardMobileSection } from './DashboardMobileBottomNav'

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
    const recentCards = useMemo(() => {
        const launchCards = topRecentLaunches.map(session => ({
            key: `recent-launch:${session.id}`,
            type: 'session' as const,
            primary: session.label,
            secondary: `${formatKindLabel(session.kind)}${session.subtitle ? ` · ${session.subtitle}` : ''}`,
            unread: false,
            onClick: () => onOpenRecent(session),
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
    }, [onOpenConversation, onOpenRecent, topConversationItems, topRecentLaunches])
    const visibleRecentCards = showAllRecent ? recentCards : recentCards.slice(0, 5)
    const hasRecentItems = recentCards.length > 0
    const hasIdeOptions = (selectedMachineEntry.detectedIdes?.length || 0) > 0
    const workspaceRows = useMemo(() => ((selectedMachineEntry as any).workspaces || []) as Array<{ id: string; path: string; label?: string }>, [selectedMachineEntry])
    const defaultWorkspaceId = ((selectedMachineEntry as any).defaultWorkspaceId as string | null | undefined) || null
    const [workspaceChoice, setWorkspaceChoice] = useState<string>(defaultWorkspaceId || (workspaceRows[0]?.id || ''))
    const [customWorkspacePath, setCustomWorkspacePath] = useState('')
    const [activeLauncherKind, setActiveLauncherKind] = useState<WorkspaceLaunchKind | null>(
        getDefaultLauncherKind(hasIdeOptions, cliProviders.length, acpProviders.length),
    )
    const lastMachineIdRef = useRef<string | null>(null)
    const resolvedWorkspacePath = workspaceChoice === '__custom__'
        ? customWorkspacePath.trim()
        : (workspaceRows.find(workspace => workspace.id === workspaceChoice)?.path || '')
    const canCreateMissingWorkspace = workspaceChoice === '__custom__'
        && !!resolvedWorkspacePath
        && machineAction.state === 'error'
        && /(Directory path is not valid or does not exist|Path does not exist)/i.test(machineAction.message)

    useEffect(() => {
        if (lastMachineIdRef.current !== selectedMachineEntry.id) {
            lastMachineIdRef.current = selectedMachineEntry.id
            setWorkspaceChoice(defaultWorkspaceId || (workspaceRows[0]?.id || '__custom__'))
            setCustomWorkspacePath('')
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

    return (
        <>
            <div className="flex items-center justify-between gap-3 px-4 pt-[calc(16px+env(safe-area-inset-top,0px))] pb-3 border-b border-border-subtle/70 bg-bg-primary backdrop-blur-md">
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
                                    Pick a saved workspace or enter a path before choosing IDE, CLI, or ACP.
                                </div>
                                <select
                                    value={workspaceChoice}
                                    onChange={(event) => {
                                        setWorkspaceChoice(event.target.value)
                                        if (event.target.value !== '__custom__') setCustomWorkspacePath('')
                                    }}
                                    className="w-full rounded-xl border border-border-default/90 bg-bg-primary/90 text-text-primary px-3 py-3 text-sm"
                                >
                                    {workspaceRows.length > 0 ? (
                                        <>
                                            {workspaceRows.map(workspace => (
                                                <option key={workspace.id} value={workspace.id}>
                                                    {workspace.id === defaultWorkspaceId ? '⭐ ' : ''}
                                                    {workspace.label || workspace.path.split('/').filter(Boolean).pop() || workspace.path}
                                                </option>
                                            ))}
                                            <option value="__custom__">Custom path…</option>
                                        </>
                                    ) : (
                                        <option value="__custom__">Enter workspace path…</option>
                                    )}
                                </select>
                                {workspaceChoice === '__custom__' && (
                                    <>
                                        <input
                                            type="text"
                                            value={customWorkspacePath}
                                            onChange={(event) => setCustomWorkspacePath(event.target.value)}
                                            placeholder="/absolute/path"
                                            className="w-full rounded-xl border border-border-default/90 bg-bg-primary/90 text-text-primary px-3 py-3 text-sm"
                                        />
                                        <button
                                            type="button"
                                            className="inline-flex items-center justify-center min-h-[40px] rounded-xl border border-accent-primary/30 bg-accent-primary/10 text-text-primary text-[13px] font-bold"
                                            onClick={() => {
                                                if (!resolvedWorkspacePath) return
                                                onAddWorkspace(resolvedWorkspacePath)
                                            }}
                                        >
                                            Save workspace
                                        </button>
                                    </>
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
                                                onClick={() => onLaunchDetectedIde(ide.type, {
                                                    workspacePath: resolvedWorkspacePath || null,
                                                })}
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
                                                onClick={() => onLaunchWorkspaceProvider(activeLauncherKind, provider.type, {
                                                    workspaceId: workspaceChoice !== '__custom__' ? workspaceChoice : null,
                                                    workspacePath: resolvedWorkspacePath || null,
                                                })}
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
            {showBottomNav && (
                <DashboardMobileBottomNav section={section} onSectionChange={onSectionChange} />
            )}
        </>
    )
}
