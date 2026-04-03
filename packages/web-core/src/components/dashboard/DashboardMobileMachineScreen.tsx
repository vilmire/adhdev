import { IconChevronLeft } from '../Icons'
import type { DaemonData } from '../../types'
import { formatRelativeTime, type MobileConversationListItem, type MobileMachineActionState } from './DashboardMobileChatShared'
import type { ActiveConversation } from './types'
import type { MachineRecentSession, WorkspaceLaunchKind } from '../../pages/machine/types'
import { useEffect, useMemo, useRef, useState } from 'react'

interface LaunchProviderInfo {
    type: string
    displayName: string
    icon?: string
}

interface DashboardMobileMachineScreenProps {
    selectedMachineEntry: DaemonData
    selectedMachineConversations: MobileConversationListItem[]
    selectedMachineRecentSessions: MachineRecentSession[]
    cliProviders: LaunchProviderInfo[]
    acpProviders: LaunchProviderInfo[]
    selectedMachineNeedsUpgrade: boolean
    appVersion: string | null
    machineAction: MobileMachineActionState
    onBack: () => void
    onOpenConversation: (conversation: ActiveConversation) => void
    onOpenRecent: (session: MachineRecentSession) => void
    onOpenMachineDetails: () => void
    onMachineUpgrade: () => void
    onLaunchDetectedIde: (ideType: string, opts?: { workspacePath?: string | null }) => void
    onAddWorkspace: (path: string, opts?: { createIfMissing?: boolean }) => void
    onLaunchWorkspaceProvider: (kind: Extract<WorkspaceLaunchKind, 'cli' | 'acp'>, providerType: string, opts?: { workspaceId?: string | null; workspacePath?: string | null }) => void
}

export default function DashboardMobileMachineScreen({
    selectedMachineEntry,
    selectedMachineConversations,
    selectedMachineRecentSessions,
    cliProviders,
    acpProviders,
    selectedMachineNeedsUpgrade,
    appVersion,
    machineAction,
    onBack,
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
    const formatKindLabel = (kind: MachineRecentSession['kind']) => {
        if (kind === 'ide') return 'IDE'
        if (kind === 'cli') return 'CLI'
        return 'ACP'
    }

    const topRecentSessions = selectedMachineRecentSessions.slice(0, 4)
    const topConversationItems = selectedMachineConversations.slice(0, 3)
    const recentCards = useMemo(() => {
        const sessionCards = topRecentSessions.map(session => ({
            key: `recent-session:${session.id}`,
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
        return [...sessionCards, ...conversationCards]
    }, [onOpenConversation, onOpenRecent, topConversationItems, topRecentSessions])
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
            <div className="dashboard-mobile-chat-header">
                <div className="dashboard-mobile-chat-header-row">
                    <button
                        className="dashboard-mobile-chat-back"
                        onClick={onBack}
                        type="button"
                        aria-label="Back"
                    >
                        <IconChevronLeft size={18} />
                    </button>
                    <div className="dashboard-mobile-chat-title-block">
                        <div className="dashboard-mobile-chat-title">
                            {selectedMachineEntry.nickname || selectedMachineEntry.hostname || selectedMachineEntry.id}
                        </div>
                        <div className="dashboard-mobile-chat-subtitle">
                            {(selectedMachineEntry.platform || 'machine')}
                            {selectedMachineEntry.version ? ` · v${selectedMachineEntry.version}` : ''}
                        </div>
                    </div>
                </div>
            </div>

            <div className="dashboard-mobile-chat-inbox">
                {hasRecentItems && (
                    <section className="dashboard-mobile-chat-section">
                        <div className="dashboard-mobile-chat-section-title">Recent</div>
                        <div className="dashboard-mobile-machine-command-grid">
                            {visibleRecentCards.map(card => (
                                <button
                                    key={card.key}
                                    className={`dashboard-mobile-machine-command-card${card.unread ? ' is-primary' : ''}`}
                                    type="button"
                                    onClick={card.onClick}
                                >
                                    <span className="dashboard-mobile-machine-command-label">{card.primary}</span>
                                    <span className="dashboard-mobile-machine-command-meta">
                                        {card.secondary}
                                    </span>
                                </button>
                            ))}
                        </div>
                        {recentCards.length > 5 && (
                            <div className="dashboard-mobile-machine-more-row">
                                <button
                                    type="button"
                                    className="dashboard-mobile-machine-more-btn"
                                    onClick={() => setShowAllRecent(current => !current)}
                                >
                                    {showAllRecent ? 'Show fewer' : `Show ${recentCards.length - 5} more`}
                                </button>
                            </div>
                        )}
                    </section>
                )}

                {(hasIdeOptions || cliProviders.length > 0 || acpProviders.length > 0) && (
                    <section className="dashboard-mobile-chat-section">
                        <div className="dashboard-mobile-chat-section-title">Start</div>
                        <div className="dashboard-mobile-machine-command-grid">
                            <div className="dashboard-mobile-machine-workspace-card">
                                <div className="dashboard-mobile-machine-command-label">Workspace</div>
                                <div className="dashboard-mobile-machine-command-meta">
                                    Pick a saved workspace or enter a path before choosing IDE, CLI, or ACP.
                                </div>
                                <select
                                    value={workspaceChoice}
                                    onChange={(event) => {
                                        setWorkspaceChoice(event.target.value)
                                        if (event.target.value !== '__custom__') setCustomWorkspacePath('')
                                    }}
                                    className="dashboard-mobile-machine-workspace-select"
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
                                            className="dashboard-mobile-machine-workspace-input"
                                        />
                                        <button
                                            type="button"
                                            className="dashboard-mobile-machine-workspace-save"
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
                                    <div className="dashboard-mobile-machine-workspace-preview">{resolvedWorkspacePath}</div>
                                )}
                            </div>
                        </div>
                        <div className="dashboard-mobile-machine-openwith">
                            {hasIdeOptions && (
                                <button
                                    className={`dashboard-mobile-machine-openwith-btn${activeLauncherKind === 'ide' ? ' is-active' : ''}`}
                                    type="button"
                                    onClick={() => setActiveLauncherKind('ide')}
                                >
                                    IDE
                                </button>
                            )}
                            {cliProviders.length > 0 && (
                                <button
                                    className={`dashboard-mobile-machine-openwith-btn${activeLauncherKind === 'cli' ? ' is-active' : ''}`}
                                    type="button"
                                    onClick={() => setActiveLauncherKind('cli')}
                                >
                                    CLI
                                </button>
                            )}
                            {acpProviders.length > 0 && (
                                <button
                                    className={`dashboard-mobile-machine-openwith-btn${activeLauncherKind === 'acp' ? ' is-active' : ''}`}
                                    type="button"
                                    onClick={() => setActiveLauncherKind('acp')}
                                >
                                    ACP
                                </button>
                            )}
                        </div>
                        {activeLauncherKind && (
                            <div className="dashboard-mobile-machine-provider-picker">
                                <div className="dashboard-mobile-machine-provider-title">
                                    {activeLauncherKind === 'ide'
                                        ? 'Choose an IDE'
                                        : activeLauncherKind === 'cli'
                                            ? 'Choose a CLI provider'
                                            : 'Choose an ACP provider'}
                                </div>
                                <div className="dashboard-mobile-machine-provider-grid">
                                    {activeLauncherKind === 'ide'
                                        ? selectedMachineEntry.detectedIdes.slice(0, 6).map(ide => (
                                            <button
                                                key={ide.type}
                                                type="button"
                                                className="dashboard-mobile-machine-provider-btn"
                                                onClick={() => onLaunchDetectedIde(ide.type, {
                                                    workspacePath: resolvedWorkspacePath || null,
                                                })}
                                            >
                                                <span className="dashboard-mobile-machine-provider-name">{ide.name}</span>
                                                <span className="dashboard-mobile-machine-provider-meta">
                                                    {resolvedWorkspacePath || 'Use selected workspace'}
                                                </span>
                                            </button>
                                        ))
                                        : (activeLauncherKind === 'cli' ? cliProviders : acpProviders).map(provider => (
                                            <button
                                                key={provider.type}
                                                type="button"
                                                className="dashboard-mobile-machine-provider-btn"
                                                onClick={() => onLaunchWorkspaceProvider(activeLauncherKind, provider.type, {
                                                    workspaceId: workspaceChoice !== '__custom__' ? workspaceChoice : null,
                                                    workspacePath: resolvedWorkspacePath || null,
                                                })}
                                            >
                                                <span className="dashboard-mobile-machine-provider-name">
                                                    {provider.icon ? `${provider.icon} ` : ''}{provider.displayName}
                                                </span>
                                                <span className="dashboard-mobile-machine-provider-meta">
                                                    {resolvedWorkspacePath || 'Use selected workspace'}
                                                </span>
                                            </button>
                                        ))}
                                </div>
                            </div>
                        )}
                        {machineAction.message && (
                            <div className={`dashboard-mobile-machine-action-note is-${machineAction.state}`}>
                                {machineAction.message}
                                {canCreateMissingWorkspace && (
                                    <div className="dashboard-mobile-machine-action-cta-row">
                                        <button
                                            type="button"
                                            className="dashboard-mobile-machine-action-cta"
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

                <section className="dashboard-mobile-chat-section">
                    <div className="dashboard-mobile-chat-section-title">Inspect</div>
                    <div className="dashboard-mobile-machine-command-grid">
                        {selectedMachineNeedsUpgrade && (
                            <button
                                className="dashboard-mobile-machine-command-card is-primary"
                                type="button"
                                onClick={onMachineUpgrade}
                            >
                                <span className="dashboard-mobile-machine-command-label">Update to v{appVersion}</span>
                                <span className="dashboard-mobile-machine-command-meta">
                                    Restart this machine with the latest daemon
                                </span>
                            </button>
                        )}
                        <button
                            className="dashboard-mobile-machine-command-card"
                            type="button"
                            onClick={onOpenMachineDetails}
                        >
                            <span className="dashboard-mobile-machine-command-label">Machine details</span>
                            <span className="dashboard-mobile-machine-command-meta">
                                Sessions, providers, system info, and logs
                            </span>
                        </button>
                    </div>
                </section>
            </div>
        </>
    )
}
