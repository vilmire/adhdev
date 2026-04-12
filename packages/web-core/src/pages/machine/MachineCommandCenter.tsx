import type { ReactNode } from 'react'

import type { DaemonData } from '../../types'
import { formatRelativeTime } from '../../utils/time'
import { isVersionUpdateRequired } from '../../utils/version-update'
import { IconChat, IconClock, IconRefresh, IconWarning } from '../../components/Icons'
import type { ActiveConversation } from '../../components/dashboard/types'
import type { MachineRecentLaunch, ProviderInfo } from './types'
import { getConversationActivityAt } from '../../components/dashboard/conversation-sort'
import { getConversationMetaText, getConversationTitle } from '../../components/dashboard/conversation-presenters'

declare const __APP_VERSION__: string

interface MachineCommandCenterProps {
    machineEntry: DaemonData
    providers: ProviderInfo[]
    recentLaunches: MachineRecentLaunch[]
    currentConversations: ActiveConversation[]
    onUpgradeDaemon: () => void
    onOpenRecent: (launch: MachineRecentLaunch) => void
    onOpenConversation: (conversation: ActiveConversation) => void
}

function SectionTitle({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
    return (
        <div className="flex items-center gap-2 text-[11px] font-semibold text-text-muted tracking-[0.14em] uppercase">
            {icon}
            <span>{children}</span>
        </div>
    )
}

function SectionCard({ children, className = '' }: { children: ReactNode; className?: string }) {
    return (
        <div className={`rounded-2xl border border-[#ffffff0a] bg-bg-surface/70 backdrop-blur-sm p-3 ${className}`}>
            {children}
        </div>
    )
}

export default function MachineCommandCenter({
    machineEntry,
    providers: _providers,
    recentLaunches,
    currentConversations,
    onUpgradeDaemon,
    onOpenRecent,
    onOpenConversation,
}: MachineCommandCenterProps) {
    const topCurrentConversations = currentConversations.slice(0, 6)
    const topRecentLaunches = recentLaunches.slice(0, 4)
    const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null
    const requiresUpdate = isVersionUpdateRequired(machineEntry, appVersion)

    const formatKindLabel = (kind: MachineRecentLaunch['kind']) => {
        if (kind === 'ide') return 'IDE'
        if (kind === 'cli') return 'CLI'
        return 'ACP'
    }

    return (
        <div className="flex flex-col gap-4 md:min-w-[300px] md:max-w-[360px] shrink-0 md:h-full overflow-y-auto">
            {topCurrentConversations.length > 0 && (
                <div className="flex flex-col gap-2">
                    <SectionTitle icon={<IconChat size={13} />}>Current Chats</SectionTitle>
                    <SectionCard>
                        <div className="flex flex-col gap-1.5">
                            {topCurrentConversations.map(conversation => {
                                const activityAt = getConversationActivityAt(conversation)
                                return (
                                    <button
                                        key={conversation.tabKey}
                                        type="button"
                                        className="flex flex-col gap-1 items-start text-left p-3 rounded-xl bg-[#ffffff08] border border-transparent hover:border-[#ffffff12] hover:bg-[#ffffff0c] transition-colors cursor-pointer group"
                                        onClick={() => onOpenConversation(conversation)}
                                    >
                                        <div className="flex items-center justify-between gap-3 w-full">
                                            <span className="text-sm font-semibold text-text-primary truncate group-hover:text-accent-primary transition-colors">
                                                {getConversationTitle(conversation)}
                                            </span>
                                            {activityAt > 0 && (
                                                <span className="text-[11px] text-text-muted shrink-0">
                                                    {formatRelativeTime(activityAt)}
                                                </span>
                                            )}
                                        </div>
                                        <span className="text-xs text-text-secondary truncate w-full opacity-80">
                                            {getConversationMetaText(conversation)}
                                        </span>
                                    </button>
                                )
                            })}
                        </div>
                    </SectionCard>
                </div>
            )}

            {topRecentLaunches.length > 0 && (
                <div className="flex flex-col gap-2">
                    <SectionTitle icon={<IconClock size={13} />}>Recent Launches</SectionTitle>
                    <SectionCard>
                        <div className="flex flex-col gap-1.5">
                            {topRecentLaunches.map(launch => (
                                <button
                                    key={launch.id}
                                    type="button"
                                    className="flex flex-col gap-1 items-start text-left p-3 rounded-xl bg-[#ffffff08] border border-transparent hover:border-[#ffffff12] hover:bg-[#ffffff0c] transition-colors cursor-pointer group"
                                    onClick={() => onOpenRecent(launch)}
                                >
                                    <span className="text-sm font-semibold text-text-primary truncate w-full group-hover:text-accent-primary transition-colors">
                                        {launch.label}
                                    </span>
                                    <span className="text-xs text-text-secondary truncate w-full opacity-80">
                                        {formatKindLabel(launch.kind)}
                                        {launch.subtitle ? ` · ${launch.subtitle}` : ''}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </SectionCard>
                </div>
            )}

            {machineEntry.versionMismatch && (
                <div className="flex flex-col gap-2">
                    <SectionTitle icon={<IconWarning size={13} />}>Daemon Update</SectionTitle>
                    <SectionCard className="border-amber-500/20 bg-amber-500/5">
                        <div className="flex flex-col gap-3">
                            <div className="text-sm font-semibold text-text-primary">
                                {requiresUpdate ? 'Daemon update required' : 'Version mismatch detected'}
                            </div>
                            <div className="text-xs text-text-secondary leading-relaxed">
                                {requiresUpdate
                                    ? 'This machine is on an incompatible daemon version. Update it before starting more sessions.'
                                    : 'This machine is running a different daemon version than the current app. Update it before starting more sessions.'}
                            </div>
                            <button
                                type="button"
                                className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-amber-500/12 border border-amber-500/20 text-amber-300 hover:bg-amber-500/18 transition-colors"
                                onClick={onUpgradeDaemon}
                            >
                                <IconRefresh size={13} />
                                <span className="text-sm font-medium">Update daemon</span>
                            </button>
                        </div>
                    </SectionCard>
                </div>
            )}
        </div>
    )
}
