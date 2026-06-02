import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ActiveConversation } from './types'
import { IconMonitor, IconPlug, IconServer, IconLayers } from '../Icons'
import {
    getConversationIdeChipLabel,
    getConversationMachineId,
    getConversationMachineLabel,
    getConversationProviderLabel,
} from './conversation-selectors'
import { getDashboardActiveTabHref, getDashboardActiveTabKeyForConversation } from '../../utils/dashboard-route-paths'

interface ConversationMetaChipsProps {
    conversation: ActiveConversation
    className?: string
    onOpenNativeConversation?: () => void
    onOpenMachine?: () => void
    interactive?: boolean
    /** When true, only render mesh-node context chips for the tab-adjacent meta row. */
    meshOnly?: boolean
}

export default function ConversationMetaChips({
    conversation,
    className = '',
    onOpenNativeConversation,
    onOpenMachine,
    interactive = true,
    meshOnly = false,
}: ConversationMetaChipsProps) {
    const navigate = useNavigate()
    const machineId = getConversationMachineId(conversation)
    const machineLabel = meshOnly ? null : getConversationMachineLabel(conversation)
    const showIdeChip = !meshOnly && (conversation.transport === 'cdp-page' || conversation.transport === 'cdp-webview')
    const showExtensionChip = !meshOnly && conversation.streamSource === 'agent-stream' && !!conversation.agentName
    const showProviderChip = !meshOnly && !showExtensionChip && (conversation.transport === 'pty' || conversation.transport === 'acp')
    const providerChipLabel = getConversationProviderLabel(conversation)
    const ideChipLabel = getConversationIdeChipLabel(conversation)
    const isMeshNode = conversation.settings?.meshNodeFor;
    const meshQueueStats = conversation.meshQueueStats;
    const isMeshCoordinator = conversation.coordinator?.meshId || conversation.settings?.meshCoordinatorFor;

    if (!showIdeChip && !showExtensionChip && !showProviderChip && !machineLabel && !isMeshNode && !meshQueueStats) {
        return null;
    }

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
        const targetKey = getDashboardActiveTabKeyForConversation(conversation)
        if (!targetKey) return
        navigate(getDashboardActiveTabHref(targetKey))
    }, [conversation, navigate, onOpenNativeConversation])

    return (
        <div className={`conversation-meta-chips ${className}`.trim()}>
            {showIdeChip && (
                interactive ? (
                    <button
                        type="button"
                        className="conversation-meta-chip is-clickable"
                        onClick={handleOpenNativeConversation}
                        title={ideChipLabel}
                    >
                        <IconMonitor size={12} />
                        <span>{ideChipLabel}</span>
                    </button>
                ) : (
                    <span className="conversation-meta-chip" title={ideChipLabel}>
                        <IconMonitor size={12} />
                        <span>{ideChipLabel}</span>
                    </span>
                )
            )}
            {showExtensionChip && (
                <span className="conversation-meta-chip is-active" title={providerChipLabel}>
                    <IconPlug size={12} />
                    <span>{providerChipLabel}</span>
                </span>
            )}
            {showProviderChip && (
                <span className="conversation-meta-chip is-active" title={providerChipLabel}>
                    <IconPlug size={12} />
                    <span>{providerChipLabel}</span>
                </span>
            )}
            {machineLabel && (
                interactive ? (
                    <button
                        type="button"
                        className="conversation-meta-chip is-clickable"
                        onClick={handleOpenMachine}
                        title={machineLabel}
                    >
                        <IconServer size={12} />
                        <span>{machineLabel}</span>
                    </button>
                ) : (
                    <span className="conversation-meta-chip" title={machineLabel}>
                        <IconServer size={12} />
                        <span>{machineLabel}</span>
                    </span>
                )
            )}
            {isMeshNode && (
                <span className="conversation-meta-chip" title="Mesh node">
                    <IconServer size={12} />
                    <span>Mesh Node</span>
                </span>
            )}
            {isMeshCoordinator && meshQueueStats && (
                <span 
                    className={`conversation-meta-chip ${meshQueueStats.pending > 0 ? 'is-active' : ''}`}
                    style={meshQueueStats.failed > 0 ? { color: 'var(--color-red-400)', borderColor: 'var(--color-red-400)' } : undefined}
                    title={`Queue: ${meshQueueStats.pending} pending, ${meshQueueStats.assigned} assigned, ${meshQueueStats.completed} completed, ${meshQueueStats.failed} failed`}
                >
                    <IconLayers size={12} />
                    <span>
                        {meshQueueStats.pending} Pending
                    </span>
                </span>
            )}
        </div>
    )
}
