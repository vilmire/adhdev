/**
 * The ONE place that decides a conversation's Repo Mesh role.
 *
 * - coordinator: the session runs a mesh's coordinator. The daemon stamps
 *   `coordinator.meshId` on the session (survives restart via the registry);
 *   the launch envelope also carries `settings.meshCoordinatorFor`.
 * - worker: a session a coordinator dispatched onto a mesh node —
 *   `settings.meshNodeFor` (the mesh id), or `settings.launchedByCoordinator`
 *   when the mesh id was not stamped.
 * A coordinator marker wins when both are present.
 *
 * Every surface (dashboard header, dockview tabs, hidden list, mobile inbox,
 * mobile chat header, machine chat lists) reads this helper, so "is this a
 * coordinator?" never drifts between them. The mesh *name* comes from the
 * mesh name registry, which is filled by mesh list / status reads other
 * surfaces already make — reading it never triggers a network call.
 */
import { useSyncExternalStore } from 'react'
import type { ActiveConversation } from './types'
import { getMeshName, getMeshNamesVersion, subscribeMeshNames } from '../../utils/mesh-name-registry'

export type ConversationMeshRoleKind = 'coordinator' | 'worker'

export interface ConversationMeshRole {
    role: ConversationMeshRoleKind | null
    meshId: string | null
    /** Human mesh name when known; null when only the id is known. */
    meshName: string | null
}

type MeshRoleSource = Pick<ActiveConversation, 'coordinator' | 'settings'>

const NO_ROLE: ConversationMeshRole = Object.freeze({ role: null, meshId: null, meshName: null }) as ConversationMeshRole

function readId(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function getConversationMeshRole(
    conversation: MeshRoleSource | null | undefined,
    resolveMeshName: (meshId: string) => string | null = getMeshName,
): ConversationMeshRole {
    if (!conversation) return NO_ROLE
    const settings = (conversation.settings || {}) as Record<string, unknown>
    const coordinatorMeshId = readId(conversation.coordinator?.meshId) || readId(settings.meshCoordinatorFor)
    if (coordinatorMeshId) {
        return { role: 'coordinator', meshId: coordinatorMeshId, meshName: resolveMeshName(coordinatorMeshId) }
    }
    const workerMeshId = readId(settings.meshNodeFor)
    if (workerMeshId) {
        return { role: 'worker', meshId: workerMeshId, meshName: resolveMeshName(workerMeshId) }
    }
    if (settings.launchedByCoordinator === true) {
        return { role: 'worker', meshId: null, meshName: null }
    }
    return NO_ROLE
}

export function isCoordinatorConversation(conversation: MeshRoleSource | null | undefined): boolean {
    return getConversationMeshRole(conversation).role === 'coordinator'
}

/** The mesh graph opens from a coordinator conversation bound to a daemon. */
export function isMeshGraphAvailableFor(conversation: (MeshRoleSource & { daemonId?: string }) | null | undefined): boolean {
    return !!conversation?.daemonId && isCoordinatorConversation(conversation)
}

/** Label for the mesh: its name, else its id, else null. */
export function getMeshRoleMeshLabel(role: ConversationMeshRole): string | null {
    return role.meshName || role.meshId
}

/** React binding: re-renders when a mesh name is learned. */
export function useConversationMeshRole(conversation: MeshRoleSource | null | undefined): ConversationMeshRole {
    useSyncExternalStore(subscribeMeshNames, getMeshNamesVersion, getMeshNamesVersion)
    return getConversationMeshRole(conversation)
}
