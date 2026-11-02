/** Dedupe-key marker of a transfer-approval decision item. */
export const TRANSFER_DECISION_KEY_PREFIX = 'project-transfer:';

/** `k:project-transfer:<id>` (the stored dedupe key) -> transfer id, or null. */
export function transferIdFromDecisionKey(dedupeKey: string | undefined): string | null {
  const key = dedupeKey ?? '';
  const p = `k:${TRANSFER_DECISION_KEY_PREFIX}`;
  if (!key.startsWith(p)) return null;
  const id = key.slice(p.length);
  return /^[0-9a-f]{32}$/.test(id) ? id : null;
}
