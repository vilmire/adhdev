import type { DaemonData } from '../../types'
import { IconChevronLeft, IconMonitor, IconScroll } from '../Icons'
import ChatPane from './ChatPane'
import CliTerminalPane from './CliTerminalPane'
import ConversationMetaChips from './ConversationMetaChips'
import type { ActiveConversation } from './types'
import { isCliConv } from './types'
import { useRef } from 'react'
import type { CliTerminalHandle } from '../CliTerminal'

interface DashboardMobileChatRoomProps {
    selectedConversation: ActiveConversation
    isAcp: boolean
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
    handleSendChat: (message: string, images?: string[]) => Promise<void>
    handleFocusAgent: () => Promise<void>
}

export default function DashboardMobileChatRoom({
    selectedConversation,
    isAcp,
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
    handleSendChat,
    handleFocusAgent,
}: DashboardMobileChatRoomProps) {
    const terminalRef = useRef<CliTerminalHandle | null>(null)
    const isCli = isCliConv(selectedConversation) && !isAcp

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
                            {selectedConversation.displayPrimary || selectedConversation.agentName}
                        </div>
                        <div className="dashboard-mobile-chat-subtitle">
                            <ConversationMetaChips
                                conversation={selectedConversation}
                                onOpenNativeConversation={() => onOpenNativeConversation(selectedConversation)}
                                onOpenMachine={() => onOpenMachine(selectedConversation)}
                            />
                        </div>
                    </div>
                </div>
                <div className="dashboard-mobile-chat-toolbar">
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
            <div className="dashboard-mobile-chat-thread">
                {isCli ? (
                    <CliTerminalPane
                        activeConv={selectedConversation}
                        terminalRef={terminalRef}
                        handleSendChat={handleSendChat}
                        isSendingChat={isSendingChat}
                    />
                ) : (
                    <ChatPane
                        key={selectedConversation.tabKey}
                        activeConv={selectedConversation}
                        ideEntry={selectedIdeEntry}
                        showMetaChips={false}
                        handleSendChat={handleSendChat}
                        isSendingChat={isSendingChat}
                        handleFocusAgent={handleFocusAgent}
                        isFocusingAgent={isFocusingAgent}
                        actionLogs={actionLogs}
                        userName={userName}
                    />
                )}
            </div>
        </>
    )
}
