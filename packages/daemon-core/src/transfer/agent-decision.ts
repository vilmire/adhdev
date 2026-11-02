/**
 * Owner decision for an agent-requested transfer (owner decision 2026-11-02 section 6).
 * The decision is an ordinary owner-decision item (To-do drawer + decision push) marked by its
 * dedupe key. It carries counts and machine/project labels only: never file names or paths.
 * The dashboard answers it by sending the owner `project_transfer_approve` (or cancel) to BOTH
 * daemons; the recorded answer itself approves nothing.
 */
import { MeshRuntimeStore } from '../mesh/mesh-runtime-store.js';
import { upsertStructuredMission } from '../mesh/mesh-mission-structured.js';
import { TRANSFER_DECISION_KEY_PREFIX } from './agent-decision-key.js';
import type { TransferRecord } from './store.js';

export { TRANSFER_DECISION_KEY_PREFIX, transferIdFromDecisionKey } from './agent-decision-key.js';

function mb(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface TransferDecisionLabels { from: string; to: string }

/** Push-safe question (the server clamps it to 80 characters): counts and a target label only. */
export function transferQuestion(rec: TransferRecord, labels: TransferDecisionLabels): string {
  const files = rec.selection.entries.filter((e) => e.kind === 'file').length;
  const replaced = rec.overwrite?.replaced.length ?? 0;
  const who = rec.requestedBy?.role === 'assistant' ? 'Assistant' : 'Coordinator';
  const base = `${who}: send ${files} files (${mb(rec.totalBytes)}) to ${clip(labels.to, 14)}`;
  return clip(replaced > 0 ? `${base}, replaces ${replaced}?` : `${base}?`, 120);
}

export function transferContext(rec: TransferRecord, labels: TransferDecisionLabels, relayPossible: boolean): string {
  const files = rec.selection.entries.filter((e) => e.kind === 'file').length;
  const o = rec.overwrite;
  const parts = [
    `${labels.from} -> ${labels.to}`,
    `${files} files, ${mb(rec.totalBytes)}, ${rec.selection.excluded.length} excluded`,
    o ? `${o.newFiles.length} new, ${o.replaced.length} replaced (originals are backed up for 7 days)` : 'into a new folder',
    relayPossible ? 'may use a relay if no direct connection' : 'direct connection only',
    'Approve here sends your approval to both machines.',
  ];
  return clip(parts.join('. '), 580);
}

export function raiseTransferDecision(meshId: string, rec: TransferRecord, labels: TransferDecisionLabels, relayPossible: boolean): { itemId: string } | { error: string } {
  const { result } = upsertStructuredMission(meshId, {
    toCarryOver: true,
    itemsAdd: [{
      kind: 'decision',
      question: transferQuestion(rec, labels),
      context: transferContext(rec, labels, relayPossible),
      options: [{ label: 'Approve' }, { label: 'Reject' }],
      allowFreeText: false,
      urgency: 'normal',
      dueAt: new Date(rec.previewExpiresAt).toISOString(),
      onDue: 'remind',
      dedupe_key: `${TRANSFER_DECISION_KEY_PREFIX}${rec.id}`,
    }],
  }, { actor: 'daemon' });
  const r = result.itemResults[0];
  if (!r || r.error) return { error: r?.error ?? 'the decision was not recorded' };
  if (!r.id) return { error: 'the decision was not recorded' };
  return { itemId: r.id };
}

/** Close the open decision of a transfer that ended without the owner (expired, cancelled, failed). */
export function withdrawTransferDecision(meshId: string, itemId: string, reason: string): void {
  try {
    const items = MeshRuntimeStore.getInstance().missionItems();
    const found = items.getItem(meshId, itemId);
    if (!found || found.state !== 'open') return;
    items.updateItem(meshId, itemId, { state: 'withdrawn' });
    items.appendEvent(meshId, found.missionId, 'item_state_changed', 'daemon', { itemId, from: 'open', to: 'withdrawn', reason });
  } catch { /* the decision store is best effort */ }
}
