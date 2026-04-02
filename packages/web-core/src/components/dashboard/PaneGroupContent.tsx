import { memo, useCallback } from 'react'
import type { RefObject } from 'react'
import type { ActiveConversation } from './types'
import type { DaemonData } from '../../types'
import type { CliTerminalHandle } from '../CliTerminal'
import ApprovalBanner from './ApprovalBanner'
import CliTerminalPane from './CliTerminalPane'
import ChatPane from './ChatPane'
import ScreenshotViewer from '../ScreenshotViewer'
import { IconWarning } from '../Icons'

interface PaneGroupContentProps {
    activeConv: ActiveConversation
    clearToken: number
    isCli: boolean
    ideEntry?: DaemonData
    screenshotUrl?: string
    clearScreenshot: () => void
    terminalRef: RefObject<CliTerminalHandle | null>
    handleModalButton: (button: string) => void
    handleRelaunch: () => void
    handleSendChat: (message: string) => void
    isSendingChat: boolean
    handleFocusAgent: () => void
    isFocusingAgent: boolean
    actionLogs: { ideId: string; text: string; timestamp: number }[]
    userName?: string
}

const PaneGroupContent = memo(function PaneGroupContent({
    activeConv,
    clearToken,
    isCli,
    ideEntry,
    screenshotUrl,
    clearScreenshot,
    terminalRef,
    handleModalButton,
    handleRelaunch,
    handleSendChat,
    isSendingChat,
    handleFocusAgent,
    isFocusingAgent,
    actionLogs,
    userName,
}: PaneGroupContentProps) {
    const handleDismissScreenshot = useCallback(() => {
        clearScreenshot()
    }, [clearScreenshot])

    return (
        <>
            <ApprovalBanner activeConv={activeConv} onModalButton={handleModalButton} />

            <div className="desktop-only px-3 pt-1 pb-2">
                {!isCli && activeConv.transport !== 'acp' && screenshotUrl ? (
                    <ScreenshotViewer
                        screenshotUrl={screenshotUrl}
                        mode="preview"
                        onDismiss={handleDismissScreenshot}
                    />
                ) : (!isCli && activeConv.transport !== 'acp' && activeConv.cdpConnected === false) ? (
                    <div className="flex items-center gap-2.5 px-3.5 py-2 bg-yellow-500/[0.08] border border-yellow-500/20 rounded-lg text-xs text-text-secondary">
                        <span className="text-sm"><IconWarning size={14} /></span>
                        <span className="flex-1">CDP not connected — chat history & screenshots unavailable.</span>
                        <button
                            className="btn btn-sm bg-yellow-500/15 text-yellow-500 border border-yellow-500/30 text-[10px] whitespace-nowrap shrink-0"
                            onClick={handleRelaunch}
                        >Relaunch with CDP</button>
                    </div>
                ) : null}
            </div>

            {isCli ? (
                <CliTerminalPane
                    activeConv={activeConv}
                    clearToken={clearToken}
                    terminalRef={terminalRef}
                    handleSendChat={handleSendChat}
                    isSendingChat={isSendingChat}
                />
            ) : (
                <ChatPane
                    activeConv={activeConv}
                    ideEntry={ideEntry}
                    handleSendChat={handleSendChat}
                    isSendingChat={isSendingChat}
                    handleFocusAgent={handleFocusAgent}
                    isFocusingAgent={isFocusingAgent}
                    actionLogs={actionLogs}
                    userName={userName}
                />
            )}
        </>
    )
}, (prev, next) => (
    prev.activeConv === next.activeConv
    && prev.isCli === next.isCli
    && prev.ideEntry === next.ideEntry
    && prev.screenshotUrl === next.screenshotUrl
    && prev.terminalRef === next.terminalRef
    && prev.handleModalButton === next.handleModalButton
    && prev.handleRelaunch === next.handleRelaunch
    && prev.handleSendChat === next.handleSendChat
    && prev.isSendingChat === next.isSendingChat
    && prev.handleFocusAgent === next.handleFocusAgent
    && prev.isFocusingAgent === next.isFocusingAgent
    && prev.actionLogs === next.actionLogs
    && prev.userName === next.userName
));

export default PaneGroupContent
