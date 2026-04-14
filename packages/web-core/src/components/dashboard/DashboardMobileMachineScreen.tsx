import { IconChevronLeft, IconFolder } from '../Icons'
import type { DaemonData } from '../../types'
import { formatRelativeTime, type MobileConversationListItem, type MobileMachineActionState } from './DashboardMobileChatShared'
import type { ActiveConversation } from './types'
import type { MachineRecentLaunch, WorkspaceLaunchKind } from '../../pages/machine/types'
import { useMemo } from 'react'
import { getMachineDisplayName, getWorkspaceDisplayLabel } from '../../utils/daemon-utils'
import {
    getCliLaunchBusyLabel,
    getCliLaunchPrimaryActionLabel,
    getCliResumeSelectPlaceholder,
    getMachineLaunchBusyLabel,
    getMachineLaunchConfirmDescription,
    getMachineLaunchConfirmLabel,
    getMachineLaunchConfirmTitle,
    getRecentHistoryResumeConfirmDescription,
    getRecentHistoryResumeConfirmTitle,
    getSavedHistoryHelperLabel,
} from '../../utils/dashboard-launch-copy'
import { buildSavedHistorySummaryView } from '../../utils/saved-history-summary'
import DashboardMobileBottomNav, { type DashboardMobileSection } from './DashboardMobileBottomNav'
import WorkspaceBrowseDialog from '../machine/WorkspaceBrowseDialog'
import LaunchConfirmDialog from '../machine/LaunchConfirmDialog'
import type { BrowseDirectoryResult } from '../machine/workspaceBrowse'
import { buildLaunchWorkspaceOptions } from '../machine/launchWorkspaceOptions'
import { getConversationTitle, getMachineConversationCardSubtitle } from './conversation-presenters'
import { buildMachineRecentLaunchCardView } from '../../utils/machine-recent-launch-presenters'
import { useDashboardMobileMachineLauncher } from './useDashboardMobileMachineLauncher'

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
    onLaunchWorkspaceProvider: (kind: Extract<WorkspaceLaunchKind, 'cli' | 'acp'>, providerType: string, opts?: { workspaceId?: string | null; workspacePath?: string | null; args?: string; model?: string; resumeSessionId?: string | null }) => void
    onListSavedSessions?: (providerType: string) => Promise<any[]>
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
    onListSavedSessions,
}: DashboardMobileMachineScreenProps) {
    const formatKindLabel = (kind: MachineRecentLaunch['kind']) => {
        if (kind === 'ide') return 'IDE'
        if (kind === 'cli') return 'CLI'
        return 'ACP'
    }

    const topRecentLaunches = selectedMachineRecentLaunches.slice(0, 4)
    const topConversationItems = selectedMachineConversations.slice(0, 3)
    const launcher = useDashboardMobileMachineLauncher({
        selectedMachineEntry,
        cliProviders,
        acpProviders,
        machineAction,
        onBrowseDirectory,
        onListSavedSessions,
    })

    const recentLaunchCards = useMemo(() => topRecentLaunches.map(session => {
        const { metaText, updatedLabel } = buildMachineRecentLaunchCardView(session)
        return {
            key: `recent-launch:${session.id}`,
            primary: session.label,
            secondary: metaText,
            updatedLabel,
            onClick: () => {
                const { options, selectedKey } = buildLaunchWorkspaceOptions({
                    machine: {
                        workspaces: launcher.workspaceRows,
                        defaultWorkspaceId: launcher.defaultWorkspaceId,
                    },
                    currentWorkspacePath: session.workspace,
                })
                launcher.openLaunchConfirm({
                    title: session.kind === 'ide'
                        ? getMachineLaunchConfirmTitle('restart-ide', session.label)
                        : session.providerSessionId
                            ? getRecentHistoryResumeConfirmTitle(session.label)
                            : getMachineLaunchConfirmTitle('start-fresh', session.label),
                    description: session.kind === 'ide'
                        ? getMachineLaunchConfirmDescription('restart-ide')
                        : session.providerSessionId
                            ? getRecentHistoryResumeConfirmDescription()
                            : getMachineLaunchConfirmDescription('start-fresh'),
                    confirmLabel: session.kind === 'ide'
                        ? getMachineLaunchConfirmLabel('restart-ide')
                        : session.providerSessionId
                            ? getCliLaunchPrimaryActionLabel(true)
                            : getMachineLaunchConfirmLabel('start-fresh'),
                    busyLabel: session.kind === 'ide'
                        ? getMachineLaunchBusyLabel('restart-ide')
                        : session.providerSessionId
                            ? getCliLaunchBusyLabel(true)
                            : getMachineLaunchBusyLabel('start-fresh'),
                    workspaceOptions: options,
                    selectedWorkspaceKey: selectedKey,
                    details: [
                        { label: 'Mode', value: formatKindLabel(session.kind) },
                        ...(session.providerType ? [{ label: 'Provider', value: session.providerType }] : []),
                    ],
                }, async () => {
                    const selectedOption = options.find(option => option.key === launcher.launchConfirmWorkspaceKeyRef.current)
                    launcher.setWorkspaceSelectionFromOption(selectedOption)
                    await onOpenRecent({
                        ...session,
                        workspace: selectedOption?.workspacePath ?? null,
                    })
                })
            },
        }
    }), [launcher, onOpenRecent, topRecentLaunches])
    const conversationCards = useMemo(() => topConversationItems.map(item => ({
        key: `recent-chat:${item.conversation.tabKey}`,
        primary: getConversationTitle(item.conversation),
        secondary: getMachineConversationCardSubtitle(item.conversation, {
            timestampLabel: item.timestamp ? formatRelativeTime(item.timestamp) : null,
        }),
        unread: item.unread,
        onClick: () => onOpenConversation(item.conversation),
    })), [onOpenConversation, topConversationItems])
    const visibleRecentLaunchCards = launcher.showAllRecent ? recentLaunchCards : recentLaunchCards.slice(0, 4)
    const hasRecentLaunches = recentLaunchCards.length > 0
    const hasCurrentChats = conversationCards.length > 0
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
                {hasCurrentChats && (
                    <section className="flex flex-col gap-0">
                        <div className="text-[11px] font-extrabold tracking-[0.08em] uppercase text-text-muted px-4 pb-2">Current Chats</div>
                        <div className="grid grid-cols-1 gap-2.5 px-4">
                            {conversationCards.map(card => (
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
                    </section>
                )}

                {hasRecentLaunches && (
                    <section className="flex flex-col gap-0">
                        <div className="text-[11px] font-extrabold tracking-[0.08em] uppercase text-text-muted px-4 pb-2">Recent Launches</div>
                        <div className="grid grid-cols-1 gap-2.5 px-4">
                            {visibleRecentLaunchCards.map(card => (
                                <button
                                    key={card.key}
                                    className="flex flex-col gap-1 w-full text-left p-[14px] rounded-2xl border border-border-default/80 bg-surface-primary/90 text-text-primary"
                                    type="button"
                                    onClick={card.onClick}
                                >
                                    <div className="flex items-center justify-between gap-3 w-full">
                                        <span className="text-sm font-bold text-text-primary truncate">{card.primary}</span>
                                        {card.updatedLabel && (
                                            <span className="text-[11px] text-text-muted shrink-0">{card.updatedLabel}</span>
                                        )}
                                    </div>
                                    <span className="text-xs leading-relaxed text-text-secondary">
                                        {card.secondary}
                                    </span>
                                </button>
                            ))}
                        </div>
                        {recentLaunchCards.length > 4 && (
                            <div className="flex justify-center px-4 pt-2">
                                <button
                                    type="button"
                                    className="min-h-[34px] px-3.5 rounded-full border border-border-default/80 bg-surface-primary/90 text-text-secondary text-xs font-bold"
                                    onClick={() => launcher.setShowAllRecent(current => !current)}
                                >
                                    {launcher.showAllRecent ? 'Show fewer' : `Show ${recentLaunchCards.length - 4} more`}
                                </button>
                            </div>
                        )}
                    </section>
                )}

                {(launcher.hasIdeOptions || cliProviders.length > 0 || acpProviders.length > 0) && (
                    <section className="flex flex-col gap-0">
                        <div className="text-[11px] font-extrabold tracking-[0.08em] uppercase text-text-muted px-4 pb-2">Start</div>
                        <div className="grid grid-cols-1 gap-2.5 px-4">
                            <div className="flex flex-col gap-2.5 w-full p-3.5 rounded-2xl border border-border-default/80 bg-surface-primary/90">
                                <div className="text-sm font-bold text-text-primary">Workspace</div>
                                <div className="text-xs leading-relaxed text-text-secondary">
                                    Pick a saved workspace or browse folders before choosing IDE, CLI, or ACP.
                                </div>
                                <select
                                    value={launcher.workspaceChoice}
                                    onChange={(event) => launcher.handleWorkspaceChoiceChange(event.target.value)}
                                    className="w-full rounded-xl border border-border-default/90 bg-bg-primary/90 text-text-primary px-3 py-3 text-sm"
                                >
                                    {launcher.workspaceRows.length > 0 ? (
                                        <>
                                            {launcher.workspaceRows.map(workspace => (
                                                <option key={workspace.id} value={workspace.id}>
                                                    {workspace.id === launcher.defaultWorkspaceId ? '⭐ ' : ''}
                                                    {getWorkspaceDisplayLabel(workspace.path, workspace.label) || workspace.path}
                                                </option>
                                            ))}
                                            <option value="__custom__">Select workspace…</option>
                                        </>
                                    ) : (
                                        <option value="__custom__">Select workspace…</option>
                                    )}
                                </select>
                                {launcher.workspaceChoice === '__custom__' && (
                                    <div className="flex flex-col gap-2.5">
                                        <div className="rounded-2xl border border-border-default/80 bg-bg-primary/80 px-3.5 py-3">
                                            <div className="flex items-start gap-3">
                                                <span className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-accent-primary/10 text-accent-primary shrink-0">
                                                    <IconFolder size={17} />
                                                </span>
                                                <div className="min-w-0 flex-1">
                                                    <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-text-muted mb-1">Selected folder</div>
                                                    <div className="text-[12px] leading-relaxed text-text-primary break-all">
                                                        {launcher.resolvedWorkspacePath || launcher.browseCurrentPath || 'No folder selected yet.'}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                            <button
                                                type="button"
                                                className="inline-flex items-center justify-center min-h-[36px] px-3 rounded-xl border border-border-default/90 bg-bg-primary/90 text-text-secondary text-[12px] font-bold"
                                                onClick={launcher.openBrowseDialog}
                                            >
                                                Select workspace…
                                            </button>
                                            <button
                                                type="button"
                                                className="inline-flex items-center justify-center min-h-[36px] px-3 rounded-xl border border-accent-primary/30 bg-accent-primary/10 text-text-primary text-[12px] font-bold disabled:opacity-40"
                                                onClick={() => {
                                                    if (!launcher.resolvedWorkspacePath) return
                                                    onAddWorkspace(launcher.resolvedWorkspacePath)
                                                }}
                                                disabled={!launcher.resolvedWorkspacePath || launcher.browseBusy}
                                            >
                                                Save as workspace
                                            </button>
                                        </div>
                                    </div>
                                )}
                                {launcher.resolvedWorkspacePath && (
                                    <div className="text-[11px] leading-relaxed text-text-muted break-all">{launcher.resolvedWorkspacePath}</div>
                                )}
                            </div>
                        </div>
                        <div className="grid grid-cols-3 gap-2 px-4">
                            {launcher.hasIdeOptions && (
                                <button
                                    className={`min-h-[40px] rounded-full border text-xs font-bold ${launcher.activeLauncherKind === 'ide' ? 'border-accent-primary/30 bg-accent-primary/10 text-text-primary' : 'border-border-default/80 bg-surface-primary/90 text-text-secondary'}`}
                                    type="button"
                                    onClick={() => launcher.setActiveLauncherKind('ide')}
                                >
                                    IDE
                                </button>
                            )}
                            {cliProviders.length > 0 && (
                                <button
                                    className={`min-h-[40px] rounded-full border text-xs font-bold ${launcher.activeLauncherKind === 'cli' ? 'border-accent-primary/30 bg-accent-primary/10 text-text-primary' : 'border-border-default/80 bg-surface-primary/90 text-text-secondary'}`}
                                    type="button"
                                    onClick={() => launcher.setActiveLauncherKind('cli')}
                                >
                                    CLI
                                </button>
                            )}
                            {acpProviders.length > 0 && (
                                <button
                                    className={`min-h-[40px] rounded-full border text-xs font-bold ${launcher.activeLauncherKind === 'acp' ? 'border-accent-primary/30 bg-accent-primary/10 text-text-primary' : 'border-border-default/80 bg-surface-primary/90 text-text-secondary'}`}
                                    type="button"
                                    onClick={() => launcher.setActiveLauncherKind('acp')}
                                >
                                    ACP
                                </button>
                            )}
                        </div>
                        {launcher.activeLauncherKind && (
                            <div className="flex flex-col gap-2.5 px-4 pt-3">
                                <div className="text-xs font-bold text-text-secondary">
                                    {launcher.activeLauncherKind === 'ide'
                                        ? 'Choose an IDE'
                                        : launcher.activeLauncherKind === 'cli'
                                            ? 'Choose a CLI provider'
                                            : 'Choose an ACP provider'}
                                </div>
                                <div className="grid grid-cols-1 gap-2">
                                    {launcher.activeLauncherKind === 'ide'
                                        ? (selectedMachineEntry.detectedIdes || []).slice(0, 6).map(ide => (
                                            <button
                                                key={ide.type}
                                                type="button"
                                                className="flex flex-col items-start gap-1 w-full text-left p-3 rounded-2xl border border-border-default/80 bg-surface-primary/90 text-text-primary"
                                                onClick={() => {
                                                    const { options, selectedKey } = buildLaunchWorkspaceOptions({
                                                        machine: {
                                                            workspaces: launcher.workspaceRows,
                                                            defaultWorkspaceId: launcher.defaultWorkspaceId,
                                                        },
                                                        currentWorkspaceId: launcher.workspaceChoice !== '__custom__' ? launcher.workspaceChoice : null,
                                                        currentWorkspacePath: launcher.resolvedWorkspacePath,
                                                    })
                                                    launcher.openLaunchConfirm({
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
                                                        const selectedOption = options.find(option => option.key === launcher.launchConfirmWorkspaceKeyRef.current)
                                                        launcher.setWorkspaceSelectionFromOption(selectedOption)
                                                        onLaunchDetectedIde(ide.type, {
                                                            workspacePath: selectedOption?.workspacePath ?? null,
                                                        })
                                                    })
                                                }}
                                            >
                                                <span className="text-[13px] font-bold text-text-primary">{ide.name}</span>
                                                <span className="text-[11px] leading-relaxed text-text-muted break-all">
                                                    {launcher.resolvedWorkspacePath || 'Use selected workspace'}
                                                </span>
                                            </button>
                                        ))
                                        : (launcher.activeLauncherKind === 'cli' ? cliProviders : acpProviders).map(provider => (
                                            <button
                                                key={provider.type}
                                                type="button"
                                                className="flex flex-col items-start gap-1 w-full text-left p-3 rounded-2xl border border-border-default/80 bg-surface-primary/90 text-text-primary"
                                                onClick={() => {
                                                    const launchKind = launcher.activeLauncherKind === 'cli' ? 'cli' : 'acp'
                                                    const { options, selectedKey } = buildLaunchWorkspaceOptions({
                                                        machine: {
                                                            workspaces: launcher.workspaceRows,
                                                            defaultWorkspaceId: launcher.defaultWorkspaceId,
                                                        },
                                                        currentWorkspaceId: launcher.workspaceChoice !== '__custom__' ? launcher.workspaceChoice : null,
                                                        currentWorkspacePath: launcher.resolvedWorkspacePath,
                                                    })
                                                    launcher.openLaunchConfirm({
                                                        title: `Launch ${provider.displayName}?`,
                                                        description: 'Review or change the provider workspace before starting this session.',
                                                        confirmLabel: `Launch ${launchKind.toUpperCase()}`,
                                                        workspaceOptions: options,
                                                        selectedWorkspaceKey: selectedKey,
                                                        details: [
                                                            { label: 'Mode', value: launchKind.toUpperCase() },
                                                            { label: 'Provider', value: provider.displayName },
                                                        ],
                                                        showArgsInput: true,
                                                        showModelInput: launchKind === 'acp',
                                                        initialArgs: '',
                                                        initialModel: '',
                                                        providerType: provider.type,
                                                    }, async () => {
                                                        const selectedOption = options.find(option => option.key === launcher.launchConfirmWorkspaceKeyRef.current)
                                                        launcher.setWorkspaceSelectionFromOption(selectedOption)
                                                        onLaunchWorkspaceProvider(launchKind, provider.type, {
                                                            workspaceId: selectedOption?.workspaceId ?? null,
                                                            workspacePath: selectedOption?.workspacePath ?? null,
                                                            args: launcher.launchConfirmArgs,
                                                            model: launcher.launchConfirmModel,
                                                            resumeSessionId: launcher.launchConfirmResumeId || null,
                                                        })
                                                    })
                                                }}
                                            >
                                                <span className="text-[13px] font-bold text-text-primary">
                                                    {provider.icon ? `${provider.icon} ` : ''}{provider.displayName}
                                                </span>
                                                <span className="text-[11px] leading-relaxed text-text-muted break-all">
                                                    {launcher.resolvedWorkspacePath || 'Use selected workspace'}
                                                </span>
                                            </button>
                                        ))}
                                </div>
                            </div>
                        )}
                        {machineAction.message && (
                            <div className={`mx-4 mt-2.5 p-3 rounded-xl text-xs leading-relaxed ${machineAction.state === 'error' ? 'text-status-error bg-status-error/10' : 'text-text-secondary bg-surface-primary/90'}`}>
                                {machineAction.message}
                                {launcher.canCreateMissingWorkspace && (
                                    <div className="mt-2">
                                        <button
                                            type="button"
                                            className="inline-flex items-center justify-center min-h-[34px] px-4 rounded-lg bg-surface-primary text-text-primary font-bold text-xs"
                                            onClick={() => onAddWorkspace(launcher.resolvedWorkspacePath, { createIfMissing: true })}
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
            {launcher.browseDialogOpen && (
                <WorkspaceBrowseDialog
                    title="Select workspace"
                    description="Move through folders like a normal explorer, then use the current folder for this machine."
                    currentPath={launcher.browseCurrentPath}
                    directories={launcher.browseDirectories}
                    busy={launcher.browseBusy}
                    error={launcher.browseError}
                    confirmLabel="Use this folder"
                    onClose={() => launcher.setBrowseDialogOpen(false)}
                    onNavigate={(path) => { void launcher.loadBrowsePath(path) }}
                    onConfirm={(path) => {
                        launcher.chooseCustomWorkspacePath(path)
                        launcher.setBrowseDialogOpen(false)
                    }}
                />
            )}
            {launcher.launchConfirm && (
                <LaunchConfirmDialog
                    title={launcher.launchConfirm.title}
                    description={launcher.launchConfirm.description}
                    details={launcher.launchConfirm.details}
                    workspaceOptions={launcher.launchConfirm.workspaceOptions}
                    selectedWorkspaceKey={launcher.launchConfirmWorkspaceKey}
                    onWorkspaceChange={launcher.setLaunchConfirmWorkspaceKeyAndSync}
                    confirmLabel={launcher.launchConfirm.providerType
                        ? getCliLaunchPrimaryActionLabel(!!launcher.launchConfirmResumeId)
                        : launcher.launchConfirm.confirmLabel}
                    busyLabel={launcher.launchConfirm.providerType
                        ? undefined
                        : launcher.launchConfirm.busyLabel}
                    busy={launcher.launchConfirmBusy}
                    showArgsInput={launcher.launchConfirm.showArgsInput}
                    argsValue={launcher.launchConfirmArgs}
                    onArgsChange={launcher.setLaunchConfirmArgs}
                    showModelInput={launcher.launchConfirm.showModelInput}
                    modelValue={launcher.launchConfirmModel}
                    onModelChange={launcher.setLaunchConfirmModel}
                    historyProviderNode={
                        launcher.launchConfirm.providerType && (launcher.launchConfirmSessionsLoading || launcher.launchConfirmSavedSessions.length > 0) && (
                            <div className="rounded-xl border border-border-subtle bg-bg-primary px-3.5 py-3">
                                <div className="flex items-center justify-between mb-1">
                                    <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted">Resume saved history</div>
                                    {launcher.launchConfirmSessionsLoading && <div className="text-[10px] text-text-secondary font-medium">Loading...</div>}
                                </div>
                                <div className="text-[11px] text-text-secondary mb-2">{getSavedHistoryHelperLabel()}</div>
                                <div className="grid grid-cols-1 gap-2 mb-2">
                                    <input
                                        type="text"
                                        value={launcher.launchConfirmTextFilter}
                                        onChange={(e) => launcher.setLaunchConfirmTextFilter(e.target.value)}
                                        placeholder="Search title or preview"
                                        className="w-full rounded-lg border border-border-subtle bg-bg-secondary text-text-primary px-3 py-2 text-sm"
                                        disabled={launcher.launchConfirmBusy || launcher.launchConfirmSessionsLoading}
                                    />
                                    <input
                                        type="text"
                                        value={launcher.launchConfirmWorkspaceFilter}
                                        onChange={(e) => launcher.setLaunchConfirmWorkspaceFilter(e.target.value)}
                                        placeholder="Filter by workspace"
                                        className="w-full rounded-lg border border-border-subtle bg-bg-secondary text-text-primary px-3 py-2 text-sm"
                                        disabled={launcher.launchConfirmBusy || launcher.launchConfirmSessionsLoading}
                                    />
                                    <input
                                        type="text"
                                        value={launcher.launchConfirmModelFilter}
                                        onChange={(e) => launcher.setLaunchConfirmModelFilter(e.target.value)}
                                        placeholder="Filter by model"
                                        className="w-full rounded-lg border border-border-subtle bg-bg-secondary text-text-primary px-3 py-2 text-sm"
                                        disabled={launcher.launchConfirmBusy || launcher.launchConfirmSessionsLoading}
                                    />
                                    <select
                                        value={launcher.launchConfirmSortMode}
                                        onChange={(e) => launcher.setLaunchConfirmSortMode(e.target.value as 'recent' | 'oldest' | 'messages')}
                                        className="w-full rounded-lg border border-border-subtle bg-bg-secondary text-text-primary px-3 py-2 text-sm"
                                        disabled={launcher.launchConfirmBusy || launcher.launchConfirmSessionsLoading}
                                    >
                                        <option value="recent">Most recent</option>
                                        <option value="oldest">Oldest first</option>
                                        <option value="messages">Most messages</option>
                                    </select>
                                </div>
                                <label className="mb-2 flex items-center gap-2 text-[11px] text-text-muted">
                                    <input
                                        type="checkbox"
                                        checked={launcher.launchConfirmResumableOnly}
                                        onChange={(e) => launcher.setLaunchConfirmResumableOnly(e.target.checked)}
                                        disabled={launcher.launchConfirmBusy || launcher.launchConfirmSessionsLoading}
                                    />
                                    Resume-ready only
                                </label>
                                <select
                                    value={launcher.launchConfirmResumeId}
                                    onChange={(e) => launcher.setLaunchConfirmResumeId(e.target.value)}
                                    className="w-full rounded-lg border border-border-subtle bg-bg-secondary text-text-primary px-3 py-2 text-sm"
                                    disabled={launcher.launchConfirmBusy || launcher.launchConfirmSessionsLoading}
                                >
                                    <option value="">{getCliResumeSelectPlaceholder()}</option>
                                    {launcher.filteredLaunchConfirmSavedSessions.map(sess => (
                                        <option key={sess.providerSessionId} value={sess.providerSessionId} disabled={!sess.canResume}>
                                            {sess.title || sess.providerSessionId} {!sess.canResume ? '(workspace missing)' : ''}
                                        </option>
                                    ))}
                                </select>
                                {!launcher.launchConfirmSessionsLoading && launcher.launchConfirmSavedSessions.length > 0 && launcher.filteredLaunchConfirmSavedSessions.length === 0 && (
                                    <div className="mt-2 text-[11px] text-text-muted">No saved history matches these filters.</div>
                                )}
                                {launcher.launchConfirmResumeId && (() => {
                                    const selectedSession = launcher.filteredLaunchConfirmSavedSessions.find(
                                        sess => sess.providerSessionId === launcher.launchConfirmResumeId,
                                    )
                                    if (!selectedSession) return null
                                    const summary = buildSavedHistorySummaryView(selectedSession)
                                    return (
                                        <div className="mt-2 rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2.5 text-[11px] text-text-muted leading-relaxed">
                                            <div className="font-semibold text-text-primary truncate">{summary.title}</div>
                                            <div className="font-mono break-all mt-0.5">{summary.providerSessionId}</div>
                                            <div className="mt-1">{summary.metaLine}</div>
                                            {summary.updatedLabel && (
                                                <div className="mt-1 text-text-secondary">{summary.updatedLabel}</div>
                                            )}
                                            {summary.preview && (
                                                <div className="mt-2 line-clamp-2 text-text-secondary">{summary.preview}</div>
                                            )}
                                        </div>
                                    )
                                })()}
                            </div>
                        )
                    }
                    onConfirm={launcher.handleConfirmLaunch}
                    onCancel={launcher.closeLaunchConfirm}
                />
            )}
            {showBottomNav && (
                <DashboardMobileBottomNav section={section} onSectionChange={onSectionChange} />
            )}
        </>
    )
}
