/**
 * Coordinator / worker markers — one visual language for "this conversation
 * is part of a Repo Mesh", shared by every surface that lists conversations.
 *
 *   coordinator → mesh icon before the title (neutral text colour; amber stays
 *                 the only accent). No text label — the icon is the cue.
 *   worker      → the same icon, muted.
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

/** Compact icon placed immediately before the conversation title. */
export function MeshRoleIcon({ conversation, className, size = 12 }: MarkerProps & { size?: number }) {
    const role = useConversationMeshRole(conversation)
    const text = useMeshRoleText(role)
    if (!role.role || !text) return null
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
