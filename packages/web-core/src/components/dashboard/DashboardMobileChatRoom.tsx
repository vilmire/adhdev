import { useTranslation } from 'react-i18next'
import type { DaemonData } from '../../types'
import { IconChevronLeft, IconX } from '../Icons'
import ConversationActionsMenu from './ConversationActionsMenu'
import ConversationMeshGraphButton from './ConversationMeshGraphButton'
import { MeshRoleIcon } from './ConversationMeshRoleMarker'
import PaneGroupContent from './PaneGroupContent'
import type { ActiveConversation, CliConversationViewMode } from './types'
import { isCliConv } from './types'
import type { DashboardConversationCommands } from '../../hooks/useDashboardConversationCommands'
import { useCallback, useRef } from 'react'
import type { CliTerminalHandle } from '../CliTerminal'
import CliViewModeToggle from './CliViewModeToggle'
import { getConversationTabMetaText, getConversationTitle } from './conversation-presenters'
import InteractivePromptModal from '../interactive-prompt/InteractivePromptModal'
import { useInteractivePrompt } from '../../hooks/useInteractivePrompt'
import { getInteractivePromptScopeId } from './ApprovalBanner'
import TodoButton from '../needs-you/TodoButton'

interface DashboardMobileChatRoomProps {
    selectedConversation: ActiveConversation
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
    isStandalone,
    selectedIdeEntry,
    actionLogs,
    userName,
    commands,
    onBack,
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
    const isCli = isCliConv(selectedConversation)
    const isCliTerminal = isCli && cliViewMode === 'terminal'
    // Owner-attention notice: the only affordance is opening the terminal view.
    const handleOpenTerminal = useCallback(() => onSetCliViewMode('terminal'), [onSetCliViewMode])
    const headerPaddingClass = isStandalone
        ? 'px-4 pt-3.5 pb-2.5'
        : 'px-4 pt-[calc(14px+var(--mobile-flow-header-safe-top,0px))] pb-2.5'

    return (
        <>
            <div className={`relative z-20 shrink-0 flex flex-col gap-2 ${headerPaddingClass} border-b border-border-subtle/70 bg-bg-primary`}>
                <div className="mobile-room-header-row flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        <button
                            className="mobile-room-back shrink-0 inline-flex items-center justify-center"
                            onClick={onBack}
                            type="button"
                            aria-label={t('common.back')}
                        >
                            <IconChevronLeft size={20} />
                        </button>
                        <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                            <div className="flex items-center gap-1.5 min-w-0 text-[17px] leading-[26px] font-extrabold tracking-tight text-text-primary">
                                <MeshRoleIcon conversation={selectedConversation} size={15} />
                                <span className="min-w-0 truncate">{getConversationTitle(selectedConversation)}</span>
                            </div>
                            <div className="min-w-0 max-w-full text-xs text-text-secondary">
                                {/* The desktop tab's own meta line ("Codex CLI · macbook"), one
                                    line truncated at its end — not per-item pills. */}
                                <span className="mobile-room-header-meta block truncate">{getConversationTabMetaText(selectedConversation)}</span>
                            </div>
                        </div>
                    </div>
                    <div className="mobile-room-header-actions flex items-center justify-end gap-1 shrink-0">
                        <TodoButton />
                        {isCli && cliViewMode && (
                            <CliViewModeToggle mode={cliViewMode} onChange={onSetCliViewMode} compact />
                        )}
                        {isCli && onStopCli && (
                            <button
                                onClick={() => { void onStopCli(selectedConversation) }}
                                className="btn btn-icon is-danger"
                                title={t('cliStop.stopProcess')}
                                aria-label={t('cliStop.stopProcess')}
                            >
                                <IconX size={17} />
                            </button>
                        )}
                        <ConversationMeshGraphButton
                            conversation={selectedConversation}
                            onOpenMeshGraph={onOpenMeshGraph}
                        />
                        <ConversationActionsMenu
                            conversation={selectedConversation}
                            onOpenHistory={onOpenHistory}
                            onOpenRemote={onOpenRemote}
                            iconSize={18}
                        />
                    </div>
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
                    onOpenTerminal={isCli ? handleOpenTerminal : undefined}
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
