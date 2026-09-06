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
import type { DashboardConversationCommands } from '../../hooks/useDashboardConversationCommands'

interface PaneGroupContentProps {
    activeConv: ActiveConversation
    clearToken: number
    isCliTerminal: boolean
    ideEntry?: DaemonData
    terminalRef: RefObject<CliTerminalHandle | null>
    /**
     * ★ The whole conversation-command surface as ONE required prop. Previously
     * these were 11 loose optional props, so a newly added field silently
     * defaulted at any call site that forgot it — a runtime defect the compiler
     * could not catch. Required + bundled means omitting the wiring is a build
     * error. Pass the `useDashboardConversationCommands` return value directly.
     */
    commands: DashboardConversationCommands
    actionLogs: { routeId: string; text: string; timestamp: number }[]
    userName?: string
    // ★ Layout concerns, NOT command wiring — these legitimately differ per
    // surface (dockview tracks panel visibility/focus; mobile renders one pane
    // at a time), so they stay optional and are not part of `commands`.
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
    commands,
    actionLogs,
    userName,
    scrollToBottomRequestNonce,
    isInputActive = true,
    isVisible = true,
}: PaneGroupContentProps) {
    const {
        handleModalButton,
        handleRelaunch,
        handleSendChat,
        handleSendNowQueued,
        isSendingChat,
        sendFeedbackMessage,
        pendingLocalMessage,
        handleFocusAgent,
        isFocusingAgent,
    } = commands
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
    // not the other previously drifted silently because ChatPane's own command
    // props are all optional (no compiler error on omission); this single
    // closure removes the second site the drift needed. The `commands` bundle
    // guards the inbound half of the same defect — together they mean a command
    // can neither arrive unwired nor reach only one of the two panes.
    const renderChatPane = (visible: boolean) => (
        <ChatPane
            activeConv={effectiveConv}
            ideEntry={ideEntry}
            handleSendChat={handleSendChat}
            handleSendNowQueued={handleSendNowQueued}
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
    // ★ One reference check replaces the 9 hand-enumerated command fields. This
    // is only equivalent because `useDashboardConversationCommands` memoizes its
    // return on exactly those fields — if that `useMemo` is ever removed, this
    // comparison fails every render and the pane re-renders constantly.
    && prev.commands === next.commands
    && prev.actionLogs === next.actionLogs
    && prev.userName === next.userName
    && prev.scrollToBottomRequestNonce === next.scrollToBottomRequestNonce
    && prev.isInputActive === next.isInputActive
    && prev.isVisible === next.isVisible
));

export default PaneGroupContent
