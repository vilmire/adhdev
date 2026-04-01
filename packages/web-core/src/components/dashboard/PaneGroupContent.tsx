import type { MutableRefObject, RefObject } from 'react'
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
    isCli: boolean
    ides: DaemonData[]
    screenshotMap: Record<string, string>
    setScreenshotMap: (m: Record<string, string>) => void
    ptyBuffers: MutableRefObject<Map<string, string[]>>
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

export default function PaneGroupContent({
    activeConv,
    isCli,
    ides,
    screenshotMap,
    setScreenshotMap,
    ptyBuffers,
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
    return (
        <>
            <ApprovalBanner activeConv={activeConv} onModalButton={handleModalButton} />

            <div className="desktop-only px-3 pt-1 pb-2">
                {!isCli && activeConv.transport !== 'acp' && screenshotMap[activeConv.ideId] ? (
                    <ScreenshotViewer
                        screenshotUrl={screenshotMap[activeConv.ideId]}
                        mode="preview"
                        onDismiss={() => {
                            const next = { ...screenshotMap }
                            delete next[activeConv.ideId]
                            setScreenshotMap(next)
                        }}
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
                    ptyBuffers={ptyBuffers}
                    terminalRef={terminalRef}
                    handleSendChat={handleSendChat}
                    isSendingChat={isSendingChat}
                />
            ) : (
                <ChatPane
                    activeConv={activeConv}
                    ides={ides}
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
}
