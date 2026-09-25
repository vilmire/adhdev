import { useTranslation } from 'react-i18next'
import type { DaemonData } from '../../types'
import { IconChevronLeft, IconMesh, IconMonitor, IconScroll, IconX } from '../Icons'
import PaneGroupContent from './PaneGroupContent'
import ConversationMetaChips from './ConversationMetaChips'
import type { ActiveConversation, CliConversationViewMode } from './types'
import { isCliConv } from './types'
import type { DashboardConversationCommands } from '../../hooks/useDashboardConversationCommands'
import { useRef } from 'react'
import type { CliTerminalHandle } from '../CliTerminal'
import CliViewModeToggle from './CliViewModeToggle'
import { getConversationTitle } from './conversation-presenters'
import InteractivePromptModal from '../interactive-prompt/InteractivePromptModal'
import { useInteractivePrompt } from '../../hooks/useInteractivePrompt'
import { getInteractivePromptScopeId } from './ApprovalBanner'

interface DashboardMobileChatRoomProps {
    selectedConversation: ActiveConversation
    isAcp: boolean
    isStandalone: boolean
    selectedIdeEntry?: DaemonData
    actionLogs: { routeId: string; text: string; timestamp: number }[]
    userName?: string
    /** ★ Forwarded verbatim to `PaneGroupContent`; see that prop's contract. */
    commands: DashboardConversationCommands
    onBack: () => void
    onOpenNativeConversation: (conversation: ActiveConversation) => void
    onOpenMachine: (conversation: ActiveConversation) => void
    onOpenHistory: (conversation: ActiveConversation) => void
    onOpenRemote: (conversation: ActiveConversation) => void
    onOpenMeshGraph?: (conversation: ActiveConversation) => void
    onStopCli?: (conversation?: ActiveConversation) => void | Promise<void>
    cliViewMode: CliConversationViewMode | null
    onSetCliViewMode: (mode: CliConversationViewMode) => void
}

export default function DashboardMobileChatRoom({
    selectedConversation,
    isAcp,
    isStandalone,
    selectedIdeEntry,
    actionLogs,
    userName,
    commands,
    onBack,
    onOpenNativeConversation,
    onOpenMachine,
    onOpenHistory,
    onOpenRemote,
    onOpenMeshGraph,
    onStopCli,
    cliViewMode,
    onSetCliViewMode,
}: DashboardMobileChatRoomProps) {
    const { t } = useTranslation('common')
    const terminalRef = useRef<CliTerminalHandle | null>(null)
    // Mobile chat owns a local selection that intentionally does not update the
    // desktop Dockview group selection. Scope the modal to that same local
    // conversation id used by PaneGroupContent's ApprovalBanner.
    const interactivePrompt = useInteractivePrompt(getInteractivePromptScopeId(selectedConversation))
    const isCli = isCliConv(selectedConversation) && !isAcp
    const isCliTerminal = isCli && cliViewMode === 'terminal'
    const meshGraphAvailable = !!selectedConversation.daemonId
        && !!(selectedConversation.coordinator?.meshId || selectedConversation.settings?.meshCoordinatorFor)
    const headerPaddingClass = isStandalone
        ? 'px-4 pt-3.5 pb-2.5'
        : 'px-4 pt-[calc(14px+env(safe-area-inset-top,0px))] pb-2.5'

    return (
        <>
            <div className={`flex items-center justify-between gap-3 ${headerPaddingClass} border-b border-border-subtle/70 bg-bg-primary backdrop-blur-md`}>
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <button
                        className="w-[34px] h-[34px] rounded-full border border-border-default bg-surface-primary/70 text-text-secondary shrink-0 inline-flex items-center justify-center hover:bg-surface-primary transition-colors"
                        onClick={onBack}
                        type="button"
                        aria-label={t('common.back')}
                    >
                        <IconChevronLeft size={18} />
                    </button>
                    <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                        <div className="flex items-center gap-2 text-[17px] leading-[26px] font-extrabold tracking-tight text-text-primary truncate">
                            {getConversationTitle(selectedConversation)}
                        </div>
                        <div className="min-w-0 max-w-full text-xs text-text-secondary">
                            <ConversationMetaChips
                                conversation={selectedConversation}
                                className="is-mobile-header"
                                interactive={false}
                                onOpenNativeConversation={() => onOpenNativeConversation(selectedConversation)}
                                onOpenMachine={() => onOpenMachine(selectedConversation)}
                            />
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {isCli && cliViewMode && (
                        <CliViewModeToggle mode={cliViewMode} onChange={onSetCliViewMode} compact />
                    )}
                    {isCli && onStopCli && (
                        <button
                            onClick={() => { void onStopCli(selectedConversation) }}
                            className="btn btn-secondary btn-sm"
                            title={t('cliStop.stopProcess')}
                            style={{
                                color: 'var(--status-error, #ef4444)',
                                borderColor: 'color-mix(in srgb, var(--status-error, #ef4444) 25%, transparent)',
                            }}
                        >
                            <IconX size={14} />
                        </button>
                    )}
                    {meshGraphAvailable && onOpenMeshGraph && (
                        <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => onOpenMeshGraph(selectedConversation)}
                            type="button"
                            title={t('mesh.openLiveGraph')}
                            aria-label={t('mesh.openLiveGraph')}
                        >
                            <IconMesh size={14} />
                        </button>
                    )}
                    <button className="btn btn-secondary btn-sm" onClick={() => onOpenHistory(selectedConversation)} type="button">
                        <IconScroll size={14} />
                    </button>
                    {!isAcp && !isCli && (
                        <button className="btn btn-secondary btn-sm" onClick={() => onOpenRemote(selectedConversation)} type="button">
                            <IconMonitor size={14} />
                        </button>
                    )}
                </div>
            </div>
            <div className="flex-1 min-h-0 flex flex-col bg-bg-primary relative">
                <PaneGroupContent
                    activeConv={selectedConversation}
                    clearToken={0}
                    isCliTerminal={isCliTerminal}
                    ideEntry={selectedIdeEntry}
                    terminalRef={terminalRef}
                    commands={commands}
                    actionLogs={actionLogs}
                    userName={userName}
                />
            </div>
            <InteractivePromptModal
                promptSession={interactivePrompt.promptSession}
                isSubmitting={interactivePrompt.isSubmitting}
                error={interactivePrompt.responseError}
                onSubmit={interactivePrompt.submit}
                onCancel={interactivePrompt.cancel}
            />
        </>
    )
}
