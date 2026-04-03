import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ActiveConversation } from './types'
import { IconMonitor, IconPlug, IconServer } from '../Icons'
import { formatIdeType } from '../../utils/daemon-utils'

interface ConversationMetaChipsProps {
    conversation: ActiveConversation
    className?: string
    onOpenNativeConversation?: () => void
    onOpenMachine?: () => void
}

export default function ConversationMetaChips({
    conversation,
    className = '',
    onOpenNativeConversation,
    onOpenMachine,
}: ConversationMetaChipsProps) {
    const navigate = useNavigate()
    const machineId = conversation.daemonId || conversation.ideId?.split(':')[0] || conversation.ideId
    const showIdeChip = conversation.transport === 'cdp-page' || conversation.transport === 'cdp-webview'
    const showExtensionChip = conversation.streamSource === 'agent-stream' && !!conversation.agentName
    const ideChipLabel = (() => {
        if (conversation.streamSource === 'agent-stream') {
            const parentIdeLabel = conversation.displaySecondary?.split('·')[0]?.trim()
            if (parentIdeLabel) return parentIdeLabel
        }
        return formatIdeType(conversation.ideType || '')
    })()

    const handleOpenMachine = useCallback(() => {
        if (onOpenMachine) {
            onOpenMachine()
            return
        }
        if (!machineId) return
        navigate('/dashboard', { state: { openMachineId: machineId } })
    }, [machineId, navigate, onOpenMachine])

    const handleOpenNativeConversation = useCallback(() => {
        if (onOpenNativeConversation) {
            onOpenNativeConversation()
            return
        }
        const targetSessionId = conversation.streamSource === 'agent-stream'
            ? conversation.nativeSessionId
            : conversation.sessionId
        if (!targetSessionId) return
        navigate(`/dashboard?activeTab=${encodeURIComponent(targetSessionId)}`)
    }, [conversation.nativeSessionId, conversation.sessionId, conversation.streamSource, navigate, onOpenNativeConversation])

    return (
        <div className={`conversation-meta-chips ${className}`.trim()}>
            {showIdeChip && (
                <button
                    type="button"
                    className="conversation-meta-chip is-clickable"
                    onClick={handleOpenNativeConversation}
                    title={ideChipLabel}
                >
                    <IconMonitor size={12} />
                    <span>{ideChipLabel}</span>
                </button>
            )}
            {showExtensionChip && (
                <span className="conversation-meta-chip is-active" title={conversation.agentName}>
                    <IconPlug size={12} />
                    <span>{conversation.agentName}</span>
                </span>
            )}
            {conversation.machineName && (
                <button
                    type="button"
                    className="conversation-meta-chip is-clickable"
                    onClick={handleOpenMachine}
                    title={conversation.machineName}
                >
                    <IconServer size={12} />
                    <span>{conversation.machineName}</span>
                </button>
            )}
        </div>
    )
}
