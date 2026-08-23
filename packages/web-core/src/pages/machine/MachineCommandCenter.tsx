import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import type { DaemonData } from '../../types'
import { formatRelativeTime } from '../../utils/time'
import { IconChat, IconClock, IconRefresh, IconWarning } from '../../components/Icons'
import type { ActiveConversation } from '../../components/dashboard/types'
import type { MachineRecentLaunch, ProviderInfo } from './types'
import { getConversationActivityAt } from '../../components/dashboard/conversation-sort'
import { getConversationMetaText, getConversationTitle } from '../../components/dashboard/conversation-presenters'
import { buildMachineRecentLaunchCardView } from '../../utils/machine-recent-launch-presenters'
import { buildDaemonUpdateStatusView } from '../../utils/daemon-update-status'

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
        <div className="flex items-center gap-2 text-2xs font-semibold text-text-muted tracking-[0.14em] uppercase">
            {icon}
            <span>{children}</span>
        </div>
    )
}

function SectionCard({ children, className = '' }: { children: ReactNode; className?: string }) {
    return (
        <div className={`rounded-2xl border border-border-subtle bg-bg-surface/70 backdrop-blur-sm p-3 ${className}`}>
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
    const { t } = useTranslation('common')
    const topCurrentConversations = currentConversations.slice(0, 6)
    const topRecentLaunches = recentLaunches.slice(0, 4)
    const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null
    const updateStatus = buildDaemonUpdateStatusView(machineEntry, appVersion)

    return (
        <div className="flex flex-col gap-4 md:min-w-[300px] md:max-w-[360px] shrink-0 md:h-full overflow-y-auto">
            {topCurrentConversations.length > 0 && (
                <div className="flex flex-col gap-2">
                    <SectionTitle icon={<IconChat size={13} />}>{t('machine.commandCenter.currentChats')}</SectionTitle>
                    <SectionCard>
                        <div className="flex flex-col gap-1.5">
                            {topCurrentConversations.map(conversation => {
                                const activityAt = getConversationActivityAt(conversation)
                                return (
                                    <button
                                        key={conversation.tabKey}
                                        type="button"
                                        className="flex flex-col gap-1 items-start text-left p-3 rounded-xl bg-bg-glass border border-transparent hover:border-border-default hover:bg-bg-glass transition-colors cursor-pointer group"
                                        onClick={() => onOpenConversation(conversation)}
                                    >
                                        <div className="flex items-center justify-between gap-3 w-full">
                                            {/* min-w-0: flex item's default min-width:auto floors the row at the
                                                title's content width, letting a long title push past the
                                                shrink-0 timestamp badge instead of truncating. */}
                                            <span className="text-sm font-semibold text-text-primary truncate min-w-0 group-hover:text-accent-primary transition-colors">
                                                {getConversationTitle(conversation)}
                                            </span>
                                            {activityAt > 0 && (
                                                <span className="text-2xs text-text-muted shrink-0">
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
                    <SectionTitle icon={<IconClock size={13} />}>{t('machine.commandCenter.recentLaunches')}</SectionTitle>
                    <SectionCard>
                        <div className="flex flex-col gap-1.5">
                            {topRecentLaunches.map(launch => {
                                const { metaText, updatedLabel } = buildMachineRecentLaunchCardView(launch)
                                return (
                                    <button
                                        key={launch.id}
                                        type="button"
                                        className="flex flex-col gap-1 items-start text-left p-3 rounded-xl bg-bg-glass border border-transparent hover:border-border-default hover:bg-bg-glass transition-colors cursor-pointer group"
                                        onClick={() => onOpenRecent(launch)}
                                    >
                                        <div className="flex items-center justify-between gap-3 w-full">
                                            {/* min-w-0: same flex min-width:auto issue as the chat list above —
                                                a long label pushes past the shrink-0 timestamp badge. */}
                                            <span className="text-sm font-semibold text-text-primary truncate min-w-0 group-hover:text-accent-primary transition-colors">
                                                {launch.label}
                                            </span>
                                            {updatedLabel && (
                                                <span className="text-2xs text-text-muted shrink-0">
                                                    {updatedLabel}
                                                </span>
                                            )}
                                        </div>
                                        <span className="text-xs text-text-secondary truncate w-full opacity-80">
                                            {metaText}
                                        </span>
                                    </button>
                                )
                            })}
                        </div>
                    </SectionCard>
                </div>
            )}

            {updateStatus.visible && (
                <div className="flex flex-col gap-2">
                    <SectionTitle icon={<IconWarning size={13} />}>{t('machine.commandCenter.daemonUpdate')}</SectionTitle>
                    <SectionCard className={updateStatus.tone === 'good' ? 'border-emerald-500/20 bg-emerald-500/5' : updateStatus.tone === 'info' ? 'border-sky-500/20 bg-sky-500/5' : 'border-amber-500/20 bg-amber-500/5'}>
                        <div className="flex flex-col gap-3">
                            <div className="text-sm font-semibold text-text-primary">
                                {updateStatus.title}
                            </div>
                            <div className="text-xs text-text-secondary leading-relaxed">
                                {updateStatus.description}
                                {updateStatus.targetVersion && (
                                    <span className="block mt-1 text-text-muted">
                                        Target: v{updateStatus.targetVersion}{updateStatus.channel ? ` (${updateStatus.channel})` : ''}
                                    </span>
                                )}
                            </div>
                            {updateStatus.showButton ? (
                                <button
                                    type="button"
                                    className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-amber-500/12 border border-amber-500/20 text-amber-300 hover:bg-amber-500/18 transition-colors"
                                    onClick={onUpgradeDaemon}
                                >
                                    <IconRefresh size={13} />
                                    <span className="text-sm font-medium">{updateStatus.buttonLabel}</span>
                                </button>
                            ) : (
                                <div className={updateStatus.tone === 'good' ? 'text-xs font-medium text-emerald-300' : 'text-xs font-medium text-sky-300'}>
                                    No preview update action is needed.
                                </div>
                            )}
                        </div>
                    </SectionCard>
                </div>
            )}
        </div>
    )
}
