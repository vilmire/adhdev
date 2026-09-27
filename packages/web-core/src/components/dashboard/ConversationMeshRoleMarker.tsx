/**
 * Coordinator marker — the mesh icon that flags "this conversation is a
 * Repo Mesh coordinator", shared by every surface that lists conversations.
 *
 * Owner decision (2026-09-27): a worker conversation looked identical to a
 * coordinator (same icon), so the icon is now coordinator-only and rendered
 * in the theme accent colour (`--mesh-coordinator`, themed to
 * `--accent-primary`) so it doubles as a "this one is the coordinator" cue.
 * Workers render no icon at all.
 *
 * The icon never shrinks (narrow tabs keep it while the title truncates). It
 * carries an accessible name and native tooltip ("Coordinator for <mesh>"),
 * safe inside buttons and draggable tabs where a focusable popover is not.
 */
import { useTranslation } from 'react-i18next'
import { IconMesh } from '../Icons'
import { cn } from '../../lib/utils'
import type { ActiveConversation } from './types'
import {
    getMeshRoleMeshLabel,
    isCoordinatorConversation,
    useConversationMeshRole,
    type ConversationMeshRole,
} from './conversation-mesh-role'

type MeshRoleSource = Pick<ActiveConversation, 'coordinator' | 'settings'>

export interface MeshRoleText {
    /** "Coordinator" / "Worker" */
    short: string
    /** "Coordinator for <mesh>" (or "Mesh coordinator" when the mesh is unknown) */
    full: string
    /** Mesh label shown after the role in subtitles (name, else id), or null. */
    mesh: string | null
}

export function useMeshRoleText(role: ConversationMeshRole): MeshRoleText | null {
    const { t } = useTranslation('common')
    if (!role.role) return null
    const mesh = getMeshRoleMeshLabel(role)
    if (role.role === 'coordinator') {
        return {
            short: t('dashboard.meshRole.coordinator'),
            full: mesh ? t('dashboard.meshRole.coordinatorFor', { mesh }) : t('dashboard.meshRole.coordinatorUnknownMesh'),
            mesh,
        }
    }
    return {
        short: t('dashboard.meshRole.worker'),
        full: mesh ? t('dashboard.meshRole.workerFor', { mesh }) : t('dashboard.meshRole.workerUnknownMesh'),
        mesh,
    }
}

/** Title text + role, for the `title` attribute of a row / tab. */
export function useConversationMeshRoleTitle(conversation: MeshRoleSource | null | undefined): string | null {
    const role = useConversationMeshRole(conversation)
    return useMeshRoleText(role)?.full ?? null
}

interface MarkerProps {
    conversation: MeshRoleSource | null | undefined
    className?: string
}

/** Compact icon placed immediately before the conversation title. Coordinator-only. */
export function MeshRoleIcon({ conversation, className, size = 12 }: MarkerProps & { size?: number }) {
    const role = useConversationMeshRole(conversation)
    const text = useMeshRoleText(role)
    if (!isCoordinatorConversation(conversation) || !text) return null
    return (
        <span
            role="img"
            aria-label={text.full}
            title={text.full}
            data-mesh-role={role.role}
            className={cn('mesh-role-icon', `is-${role.role}`, className)}
        >
            <IconMesh size={size} />
        </span>
    )
}
