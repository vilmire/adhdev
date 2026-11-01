/**
 * LIGHT-TASK: the ONE central claim-exclusion rule (design §6).
 *
 *  - a light row is claimable only by the light session the dispatcher pinned it to
 *    (`targetSessionId`) AND that was launched into the row's workspace;
 *  - a light session (one bound to a light workspace) claims nothing else;
 *  - every other session never claims a light row — in particular, the idle session of
 *    the base node must never run a light task inside the coordinator's own checkout.
 */
import { sessionIdsEquivalent } from '@adhdev/mesh-shared';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';

export function lightClaimAllows(
    candidate: Pick<MeshWorkQueueEntry, 'light' | 'targetSessionId' | 'lightWorkspaceId'>,
    sessionId: string,
    sessionLightWorkspaceId: string | undefined,
): boolean {
    if (!candidate.light) return !sessionLightWorkspaceId;
    if (!sessionLightWorkspaceId) return false;
    return !!candidate.targetSessionId
        && sessionIdsEquivalent(candidate.targetSessionId, sessionId)
        && candidate.lightWorkspaceId === sessionLightWorkspaceId;
}
