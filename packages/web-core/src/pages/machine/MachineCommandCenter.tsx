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
import { InfoTip, Tooltip } from '../../components/ui/InfoTip'

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
    const updateTooltip = updateStatus.visible
        ? [
            t(updateStatus.descriptionKey),
            updateStatus.targetVersion
                ? (updateStatus.channel
                    ? t('machine.commandCenter.updateTargetWithChannel', { version: updateStatus.targetVersion, channel: t(`machine.commandCenter.updateChannel.${updateStatus.channel}`) })
                    : t('machine.commandCenter.updateTarget', { version: updateStatus.targetVersion }))
                : '',
        ].filter(Boolean).join('\n')
        : ''

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
                                const { metaText, updatedLabel } = buildMachineRecentLaunchCardView(launch, t)
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

            {/* Daemon update: a title and the button when there is something to do;
                otherwise one quiet "Up to date" chip. Explanations are in ⓘ/tooltip. */}
            {updateStatus.visible && updateStatus.showButton && (
                <div className="flex flex-col gap-2" data-testid="daemon-update-card">
                    <SectionTitle icon={<IconWarning size={13} />}>{t('machine.commandCenter.daemonUpdate')}</SectionTitle>
                    <SectionCard className="border-amber-500/20 bg-amber-500/5">
                        <div className="flex flex-col gap-3">
                            <div className="flex items-center gap-1 text-sm font-semibold text-text-primary">
                                {t(updateStatus.titleKey)}
                                <InfoTip content={updateTooltip} />
                            </div>
                            <button
                                type="button"
                                className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-amber-500/12 border border-amber-500/20 text-amber-300 hover:bg-amber-500/18 transition-colors"
                                onClick={onUpgradeDaemon}
                            >
                                <IconRefresh size={13} />
                                <span className="text-sm font-medium">{updateStatus.targetVersion ? t('machine.commandCenter.updateToVersion', { version: updateStatus.targetVersion }) : t('machine.commandCenter.updateDaemon')}</span>
                            </button>
                        </div>
                    </SectionCard>
                </div>
            )}
            {updateStatus.visible && !updateStatus.showButton && (
                <div data-testid="daemon-update-chip">
                    <Tooltip content={updateTooltip}>
                        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-2xs font-medium ${updateStatus.tone === 'good' ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-400' : 'border-border-subtle bg-bg-glass text-text-secondary'}`}>
                            {updateStatus.tone === 'good' ? t('machine.commandCenter.upToDate') : t('machine.commandCenter.updateStatusUnknown')}
                        </span>
                    </Tooltip>
                </div>
            )}
        </div>
    )
}
