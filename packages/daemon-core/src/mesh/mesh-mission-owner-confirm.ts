/**
 * Owner-abandon confirmation follow-up (structured-missions design §5.1, acceptance 11):
 * the decision a coordinator's `owner_abandoned` close creates carries two options,
 * "Correct" and "Reopen". "Correct" just answers (and so closes) the item; "Reopen"
 * additionally reopens the mission — status back to active, its carried-over open items
 * restored (the same restore the plain reopen in mesh-mission-structured.ts performs).
 */
import { OWNER_ABANDON_CONFIRM_KEY_PREFIX, OWNER_ABANDON_CONFIRM_OPTIONS } from '@adhdev/mesh-shared';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { getMeshMission } from './mesh-missions.js';
import { upsertStructuredMission } from './mesh-mission-structured.js';
import { LOG } from '../logging/logger.js';

const REOPEN_LABEL = OWNER_ABANDON_CONFIRM_OPTIONS[1].toLowerCase();

export interface OwnerConfirmReopenResult {
    reopened: boolean;
    missionId?: string;
    restoredItems?: number;
}

/**
 * Called after an answer was recorded for `itemId`. A no-op unless the item is an
 * owner-abandon confirmation answered with "Reopen" and its mission is still closed.
 */
export function applyOwnerConfirmationAnswer(meshId: string, itemId: string): OwnerConfirmReopenResult {
    const item = MeshRuntimeStore.getInstance().missionItems().getItem(meshId, itemId);
    const key = item?.dedupeKey ?? '';
    const d = item?.decision;
    if (!item || !d?.answer || !key.startsWith(`k:${OWNER_ABANDON_CONFIRM_KEY_PREFIX}`)) return { reopened: false };
    const picked = d.answer.optionId ? d.options.find(o => o.id === d.answer!.optionId) : undefined;
    if (!picked || picked.label.trim().toLowerCase() !== REOPEN_LABEL) return { reopened: false };
    const missionId = key.slice(`k:${OWNER_ABANDON_CONFIRM_KEY_PREFIX}`.length)
        || item.refs.find(r => r.kind === 'mission')?.value
        || '';
    const mission = missionId ? getMeshMission(meshId, missionId) : null;
    if (!mission || (mission.status !== 'completed' && mission.status !== 'abandoned')) return { reopened: false };
    try {
        const { result } = upsertStructuredMission(meshId, { id: mission.id, title: '', status: 'active' }, { actor: 'daemon' });
        return { reopened: true, missionId: mission.id, ...(result.restoredItems ? { restoredItems: result.restoredItems } : {}) };
    } catch (e: any) {
        LOG.warn('MissionDecision', `reopen of ${mission.id} after owner confirmation failed: ${e?.message || e}`);
        return { reopened: false };
    }
}
