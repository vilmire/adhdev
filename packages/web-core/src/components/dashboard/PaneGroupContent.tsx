import { memo } from 'react'
import type { RefObject } from 'react'
import type { ActiveConversation } from './types'
import type { DaemonData } from '../../types'
import type { CliTerminalHandle } from '../CliTerminal'
import ApprovalBanner from './ApprovalBanner'
import CliTerminalPane from './CliTerminalPane'
import ChatPane from './ChatPane'
import { IconWarning } from '../Icons'
import { useSessionModalSubscription } from '../../hooks/useSessionModalSubscription'

interface PaneGroupContentProps {
    activeConv: ActiveConversation
    clearToken: number
    isCliTerminal: boolean
    ideEntry?: DaemonData
    terminalRef: RefObject<CliTerminalHandle | null>
    handleModalButton: (button: string) => void
    handleRelaunch: () => void
    handleSendChat: (message: string) => void
    isSendingChat: boolean
    handleFocusAgent: () => void
    isFocusingAgent: boolean
    actionLogs: { routeId: string; text: string; timestamp: number }[]
    userName?: string
    scrollToBottomRequestNonce?: number
    isInputActive?: boolean
}

const PaneGroupContent = memo(function PaneGroupContent({
    activeConv,
    clearToken,
    isCliTerminal,
    ideEntry,
    terminalRef,
    handleModalButton,
    handleRelaunch,
    handleSendChat,
    isSendingChat,
    handleFocusAgent,
    isFocusingAgent,
    actionLogs,
    userName,
    scrollToBottomRequestNonce,
    isInputActive = true,
}: PaneGroupContentProps) {
    const modalState = useSessionModalSubscription(activeConv)
    const effectiveConv: ActiveConversation = (
        modalState.status || modalState.modalMessage || modalState.modalButtons
            ? {
                ...activeConv,
                ...(modalState.status ? { status: modalState.status } : {}),
                ...(modalState.modalMessage !== undefined ? { modalMessage: modalState.modalMessage } : {}),
                ...(modalState.modalButtons !== undefined ? { modalButtons: modalState.modalButtons } : {}),
            }
            : activeConv
    )
    return (
        <>
            <ApprovalBanner activeConv={effectiveConv} onModalButton={handleModalButton} />

            {(effectiveConv.transport !== 'pty' && effectiveConv.transport !== 'acp' && effectiveConv.cdpConnected === false) ? (
                <div className="desktop-only px-3 pt-1 pb-2">
                    <div className="flex items-center gap-2.5 px-3.5 py-2 bg-yellow-500/[0.08] border border-yellow-500/20 rounded-lg text-xs text-text-secondary">
                        <span className="text-sm"><IconWarning size={14} /></span>
                        <span className="flex-1">CDP not connected — chat history & screenshots unavailable.</span>
                        <button
                            className="btn btn-sm bg-yellow-500/15 text-yellow-500 border border-yellow-500/30 text-[10px] whitespace-nowrap shrink-0"
                            onClick={handleRelaunch}
                        >Relaunch with CDP</button>
                    </div>
                </div>
            ) : null}

            {effectiveConv.transport === 'pty' ? (
                <>
                    <div style={{ display: isCliTerminal ? 'flex' : 'none', minHeight: 0, flex: '1 1 0%', width: '100%', flexDirection: 'column' }}>
                        <CliTerminalPane
                            activeConv={effectiveConv}
                            clearToken={clearToken}
                            terminalRef={terminalRef}
                            handleSendChat={handleSendChat}
                            isSendingChat={isSendingChat}
                            isVisible={isCliTerminal}
                        />
                    </div>
                    {!isCliTerminal && (
                        <div style={{ display: 'flex', minHeight: 0, flex: '1 1 0%', width: '100%', flexDirection: 'column' }}>
                            <ChatPane
                                activeConv={effectiveConv}
                                ideEntry={ideEntry}
                                handleSendChat={handleSendChat}
                                isSendingChat={isSendingChat}
                                handleFocusAgent={handleFocusAgent}
                                isFocusingAgent={isFocusingAgent}
                                actionLogs={actionLogs}
                                userName={userName}
                                scrollToBottomRequestNonce={scrollToBottomRequestNonce}
                                isInputActive={isInputActive}
                            />
                        </div>
                    )}
                </>
            ) : (
                <ChatPane
                    activeConv={effectiveConv}
                    ideEntry={ideEntry}
                    handleSendChat={handleSendChat}
                    isSendingChat={isSendingChat}
                    handleFocusAgent={handleFocusAgent}
                    isFocusingAgent={isFocusingAgent}
                    actionLogs={actionLogs}
                    userName={userName}
                    scrollToBottomRequestNonce={scrollToBottomRequestNonce}
                    isInputActive={isInputActive}
                />
            )}
        </>
    )
}, (prev, next) => (
    prev.activeConv === next.activeConv
    && prev.isCliTerminal === next.isCliTerminal
    && prev.ideEntry === next.ideEntry
    && prev.terminalRef === next.terminalRef
    && prev.handleModalButton === next.handleModalButton
    && prev.handleRelaunch === next.handleRelaunch
    && prev.handleSendChat === next.handleSendChat
    && prev.isSendingChat === next.isSendingChat
    && prev.handleFocusAgent === next.handleFocusAgent
    && prev.isFocusingAgent === next.isFocusingAgent
    && prev.actionLogs === next.actionLogs
    && prev.userName === next.userName
    && prev.scrollToBottomRequestNonce === next.scrollToBottomRequestNonce
    && prev.isInputActive === next.isInputActive
));

export default PaneGroupContent
