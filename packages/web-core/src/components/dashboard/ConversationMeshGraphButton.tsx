/**
 * Dedicated Mesh graph button for a coordinator conversation.
 *
 * Owner decision (2026-09-27): the graph is opened often and the button is
 * the visual cue that "this conversation is a coordinator", so it stays a
 * visible button in the pane toolbar / mobile chat header rather than an
 * item in the "…" menu. It renders nothing for any other conversation.
 */
import { useTranslation } from 'react-i18next'
import { IconMesh } from '../Icons'
import { cn } from '../../lib/utils'
import type { ActiveConversation } from './types'
import { isMeshGraphAvailableFor } from './conversation-mesh-role'
import { useConversationMeshRoleTitle } from './ConversationMeshRoleMarker'
import { preloadDashboardMeshGraphDialog } from './LazyDashboardMeshGraphDialog'

export interface ConversationMeshGraphButtonProps {
    conversation: ActiveConversation
    onOpenMeshGraph?: (conversation: ActiveConversation) => void
    /** Show the "Mesh graph" text next to the icon (desktop, wide screens). */
    showLabel?: boolean
    iconSize?: number
    className?: string
}

export default function ConversationMeshGraphButton({
    conversation,
    onOpenMeshGraph,
    showLabel = false,
    iconSize = 14,
    className,
}: ConversationMeshGraphButtonProps) {
    const { t } = useTranslation('common')
    const roleTitle = useConversationMeshRoleTitle(conversation)
    if (!onOpenMeshGraph || !isMeshGraphAvailableFor(conversation)) return null
    const label = roleTitle
        ? `${t('dashboard.meshRole.openMeshGraph')} · ${roleTitle}`
        : t('dashboard.meshRole.openMeshGraph')
    return (
        <button
            type="button"
            data-testid="conversation-mesh-graph-button"
            onClick={() => onOpenMeshGraph(conversation)}
            // Warm the lazily loaded graph chunk on intent.
            onPointerEnter={() => { void preloadDashboardMeshGraphDialog() }}
            onFocus={() => { void preloadDashboardMeshGraphDialog() }}
            className={cn('btn btn-secondary btn-sm dashboard-header-mesh-button inline-flex items-center gap-1.5', className)}
            title={label}
            aria-label={label}
        >
            <IconMesh size={iconSize} />
            {showLabel && <span className="hidden lg:inline">{t('dashboard.header.meshGraph')}</span>}
        </button>
    )
}
