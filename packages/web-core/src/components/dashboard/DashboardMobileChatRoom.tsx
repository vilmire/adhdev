import type { DaemonData } from '../../types'
import { IconChevronLeft, IconMonitor, IconScroll, IconX } from '../Icons'
import PaneGroupContent from './PaneGroupContent'
import ConversationMetaChips from './ConversationMetaChips'
import type { ActiveConversation, CliConversationViewMode } from './types'
import { isCliConv } from './types'
import { useRef } from 'react'
import type { CliTerminalHandle } from '../CliTerminal'
import CliViewModeToggle from './CliViewModeToggle'

interface DashboardMobileChatRoomProps {
    selectedConversation: ActiveConversation
    isAcp: boolean
    isStandalone: boolean
    selectedIdeEntry?: DaemonData
    actionLogs: { ideId: string; text: string; timestamp: number }[]
    userName?: string
    isSendingChat: boolean
    isFocusingAgent: boolean
    onBack: () => void
    onOpenNativeConversation: (conversation: ActiveConversation) => void
    onOpenMachine: (conversation: ActiveConversation) => void
    onOpenHistory: (conversation: ActiveConversation) => void
    onOpenRemote: (conversation: ActiveConversation) => void
    onHideConversation?: (conversation: ActiveConversation) => void
    onStopCli?: (conversation?: ActiveConversation) => void | Promise<void>
    cliViewMode: CliConversationViewMode | null
    onSetCliViewMode: (mode: CliConversationViewMode) => void
    handleSendChat: (message: string, images?: string[]) => Promise<void>
    handleFocusAgent: () => Promise<void>
    handleModalButton: (button: string) => void
    handleRelaunch: () => void
}

export default function DashboardMobileChatRoom({
    selectedConversation,
    isAcp,
    isStandalone,
    selectedIdeEntry,
    actionLogs,
    userName,
    isSendingChat,
    isFocusingAgent,
    onBack,
    onOpenNativeConversation,
    onOpenMachine,
    onOpenHistory,
    onOpenRemote,
    onHideConversation,
    onStopCli,
    cliViewMode,
    onSetCliViewMode,
    handleSendChat,
    handleFocusAgent,
    handleModalButton,
    handleRelaunch,
}: DashboardMobileChatRoomProps) {
    const terminalRef = useRef<CliTerminalHandle | null>(null)
    const isCli = isCliConv(selectedConversation) && !isAcp
    const isCliTerminal = isCli && cliViewMode === 'terminal'
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
                        aria-label="Back"
                    >
                        <IconChevronLeft size={18} />
                    </button>
                    <div className="min-w-0 flex flex-col gap-0.5">
                        <div className="flex items-center gap-2 text-[17px] font-extrabold tracking-tight text-text-primary truncate">
                            {selectedConversation.displayPrimary || selectedConversation.agentName}
                        </div>
                        <div className="min-w-0 overflow-hidden text-xs text-text-secondary">
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
                            title="Stop CLI process"
                            style={{
                                color: 'var(--status-error, #ef4444)',
                                borderColor: 'color-mix(in srgb, var(--status-error, #ef4444) 25%, transparent)',
                            }}
                        >
                            <IconX size={14} />
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
                    {onHideConversation && (
                        <button className="btn btn-secondary btn-sm" onClick={() => onHideConversation(selectedConversation)} type="button" title="Close chat">
                            <IconX size={14} />
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
                    handleModalButton={handleModalButton}
                    handleRelaunch={handleRelaunch}
                    handleSendChat={handleSendChat}
                    isSendingChat={isSendingChat}
                    handleFocusAgent={handleFocusAgent}
                    isFocusingAgent={isFocusingAgent}
                    actionLogs={actionLogs}
                    userName={userName}
                />
            </div>
        </>
    )
}
