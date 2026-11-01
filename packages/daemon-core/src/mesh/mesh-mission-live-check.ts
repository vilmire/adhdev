/**
 * Owner verdict on one `live_check` item (rc.37, "Works" / "Doesn't work" in Needs You).
 *
 *   works        → item `done`   + an evidence item "Live check passed …"
 *   doesnt_work  → item `failed` + an evidence item "Live check FAILED …" (the item stays visible in
 *                  Needs You until the owner re-checks or the coordinator re-adds it)
 *
 * Both write an `item_state_changed` mission event (`via` / `verdict` / `note`), bump the mission
 * version and notify the change channel. The item text and note live in the local mesh runtime
 * store only — nothing here touches the server status path.
 */
import { normalizeMissionItemInput, truncateMissionText } from '@adhdev/mesh-shared';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { addNormalizedItem } from './mesh-mission-structured.js';
import { notifyMissionChanged } from './mesh-mission-change-notifier.js';

export const LIVE_CHECK_NOTE_MAX = 200;
export type LiveCheckVerdict = 'works' | 'doesnt_work';
export type LiveCheckVia = 'dashboard' | 'cli' | 'push';

export type LiveCheckResolveResult =
    | { ok: true; meshId: string; missionId: string; itemId: string; state: 'done' | 'failed'; evidenceItemId?: string; unchanged?: true }
    | { ok: false; code: string; error: string };

export function isLiveCheckVerdict(v: unknown): v is LiveCheckVerdict {
    return v === 'works' || v === 'doesnt_work';
}

export function resolveLiveCheck(
    req: { meshId: string; itemId: string; verdict: LiveCheckVerdict; note?: string },
    actor: { via: LiveCheckVia },
    nowMs: number = Date.now(),
): LiveCheckResolveResult {
    const s = MeshRuntimeStore.getInstance();
    const note = typeof req.note === 'string' ? truncateMissionText(req.note.replace(/\s+/g, ' ').trim(), LIVE_CHECK_NOTE_MAX) : '';
    const target: 'done' | 'failed' = req.verdict === 'works' ? 'done' : 'failed';
    const result = s.transaction((): LiveCheckResolveResult => {
        const items = s.missionItems();
        const item = items.getItem(req.meshId, req.itemId);
        if (!item || item.kind !== 'live_check') {
            return { ok: false, code: 'live_check_not_found', error: `no live_check item '${req.itemId}' on this mesh` };
        }
        if (item.state !== 'open' && item.state !== 'failed') {
            return { ok: false, code: 'live_check_not_open', error: `live check is ${item.state} — it can no longer be resolved` };
        }
        const nowIso = new Date(nowMs).toISOString();
        const where = item.machine ? ` on ${item.machine}` : '';
        const text = truncateMissionText(
            `Live check ${target === 'done' ? 'passed' : 'FAILED'}${where}: ${item.text}${note ? ` — ${note}` : ''}`,
            300,
        );
        const n = normalizeMissionItemInput({
            kind: 'evidence', text, dedupe_key: `live-check-result:${item.id}:${nowMs}`,
        });
        let evidenceItemId: string | undefined;
        if (!('error' in n)) {
            evidenceItemId = addNormalizedItem(req.meshId, item.missionId, n.item, 'owner', 'daemon').id;
        }
        items.updateItem(req.meshId, item.id, { state: target });
        items.appendEvent(req.meshId, item.missionId, 'item_state_changed', 'owner', {
            itemId: item.id, from: item.state, to: target, verdict: req.verdict, via: actor.via,
            ...(note ? { note } : {}), ...(evidenceItemId ? { evidenceItemId } : {}),
        });
        items.bumpVersion(req.meshId, item.missionId, nowIso);
        return { ok: true, meshId: req.meshId, missionId: item.missionId, itemId: item.id, state: target, ...(evidenceItemId ? { evidenceItemId } : {}) };
    });
    if (result.ok) notifyMissionChanged(req.meshId);
    return result;
}
