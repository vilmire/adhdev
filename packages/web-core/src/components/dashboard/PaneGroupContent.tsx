import { memo } from 'react'
import type { RefObject } from 'react'
import type { ActiveConversation } from './types'
import type { DaemonData } from '../../types'
import type { CliTerminalHandle } from '../CliTerminal'
import ApprovalBanner from './ApprovalBanner'
import CliTerminalPane from './CliTerminalPane'
import ChatPane from './ChatPane'
import type { PendingLocalMessage } from './conversation-message-snapshot'
import { IconWarning } from '../Icons'
import { useSessionModalSubscription } from '../../hooks/useSessionModalSubscription'
import type { ImageAttachment } from './ChatInputBar'

interface PaneGroupContentProps {
    activeConv: ActiveConversation
    clearToken: number
    isCliTerminal: boolean
    ideEntry?: DaemonData
    terminalRef: RefObject<CliTerminalHandle | null>
    handleModalButton: (button: string) => void
    handleRelaunch: () => void
    handleSendChat: (message: string, attachments?: ImageAttachment[]) => Promise<boolean>
    handleForceSendChat?: (message: string, attachments?: ImageAttachment[]) => Promise<boolean>
    isSendingChat: boolean
    sendFeedbackMessage?: string | null
    pendingLocalMessage?: PendingLocalMessage | null
    handleFocusAgent: () => void
    isFocusingAgent: boolean
    actionLogs: { routeId: string; text: string; timestamp: number }[]
    userName?: string
    scrollToBottomRequestNonce?: number
    isInputActive?: boolean
    isVisible?: boolean
}

export function getPaneGroupContentChildVisibility(parentIsVisible: boolean | undefined, localIsVisible = true): boolean {
    return (parentIsVisible ?? true) && localIsVisible
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
    handleForceSendChat,
    isSendingChat,
    sendFeedbackMessage = null,
    pendingLocalMessage = null,
    handleFocusAgent,
    isFocusingAgent,
    actionLogs,
    userName,
    scrollToBottomRequestNonce,
    isInputActive = true,
    isVisible = true,
}: PaneGroupContentProps) {
    const showTerminalPane = isCliTerminal
    const showChatPane = !isCliTerminal
    const terminalPaneVisible = getPaneGroupContentChildVisibility(isVisible, showTerminalPane)
    const chatPaneVisible = getPaneGroupContentChildVisibility(isVisible, showChatPane)
    const paneVisible = getPaneGroupContentChildVisibility(isVisible)
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
    // Shared between the pty layout's chat sub-pane (toggled against the
    // terminal sub-pane via `chatPaneVisible`) and the non-pty layout (always
    // locally visible, `paneVisible`) — the only real difference between the
    // two call sites is which visibility flag applies, so it stays a parameter
    // rather than being duplicated. A prop present on one ChatPane call but
    // not the other previously drifted silently because every command prop
    // here is optional (no compiler error on omission) — see :170-189 memo
    // comparator, which already tracks all of them.
    const renderChatPane = (visible: boolean) => (
        <ChatPane
            activeConv={effectiveConv}
            ideEntry={ideEntry}
            handleSendChat={handleSendChat}
            handleForceSendChat={handleForceSendChat}
            isSendingChat={isSendingChat}
            sendFeedbackMessage={sendFeedbackMessage}
            pendingLocalMessage={pendingLocalMessage}
            handleFocusAgent={handleFocusAgent}
            isFocusingAgent={isFocusingAgent}
            actionLogs={actionLogs}
            userName={userName}
            scrollToBottomRequestNonce={scrollToBottomRequestNonce}
            isInputActive={isInputActive && visible}
            isVisible={visible}
        />
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
                            className="btn btn-sm bg-yellow-500/15 text-yellow-500 border border-yellow-500/30 text-3xs whitespace-nowrap shrink-0"
                            onClick={handleRelaunch}
                        >Relaunch with CDP</button>
                    </div>
                </div>
            ) : null}

            {effectiveConv.transport === 'pty' ? (
                <div style={{ position: 'relative', minHeight: 0, flex: '1 1 0%', width: '100%', overflow: 'hidden' }}>
                    <div
                        aria-hidden={!isCliTerminal}
                        style={{
                            position: 'absolute',
                            inset: 0,
                            display: 'flex',
                            minHeight: 0,
                            width: '100%',
                            flexDirection: 'column',
                            visibility: showTerminalPane ? 'visible' : 'hidden',
                            pointerEvents: showTerminalPane ? 'auto' : 'none',
                        }}
                    >
                        <CliTerminalPane
                            activeConv={effectiveConv}
                            clearToken={clearToken}
                            terminalRef={terminalRef}
                            handleSendChat={handleSendChat}
                            isSendingChat={isSendingChat}
                            sendFeedbackMessage={sendFeedbackMessage}
                            isVisible={terminalPaneVisible}
                            isInputActive={isInputActive && terminalPaneVisible}
                        />
                    </div>
                    <div
                        aria-hidden={isCliTerminal}
                        style={{
                            position: 'absolute',
                            inset: 0,
                            display: 'flex',
                            minHeight: 0,
                            width: '100%',
                            flexDirection: 'column',
                            visibility: showChatPane ? 'visible' : 'hidden',
                            pointerEvents: showChatPane ? 'auto' : 'none',
                        }}
                    >
                        {renderChatPane(chatPaneVisible)}
                    </div>
                </div>
            ) : renderChatPane(paneVisible)}
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
    && prev.handleForceSendChat === next.handleForceSendChat
    && prev.isSendingChat === next.isSendingChat
    && prev.sendFeedbackMessage === next.sendFeedbackMessage
    && prev.pendingLocalMessage === next.pendingLocalMessage
    && prev.handleFocusAgent === next.handleFocusAgent
    && prev.isFocusingAgent === next.isFocusingAgent
    && prev.actionLogs === next.actionLogs
    && prev.userName === next.userName
    && prev.scrollToBottomRequestNonce === next.scrollToBottomRequestNonce
    && prev.isInputActive === next.isInputActive
    && prev.isVisible === next.isVisible
));

export default PaneGroupContent
