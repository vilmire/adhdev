/**
 * antigravity-claim-registry — daemon-local conversation ownership map.
 *
 * Antigravity CLI writes each conversation into its own per-session SQLite db
 * at ~/.gemini/antigravity-cli/conversations/<uuid>.db. But before a daemon
 * session has resolved its provider session id, the discovery resolver used to
 * fall back to "the newest .db on disk by mtime". Two sessions started within a
 * few ms of each other on ONE daemon therefore both grabbed the SAME newest
 * store — so one session's injected prompt and the other's assistant completion
 * cross-routed, and an unrelated turn completed the wrong task (RCA: a
 * coordinator session ended up reading the owner's conversation .db, and the
 * coordinator's own injected instruction was absent from the bound store).
 *
 * This registry records which live daemon session currently owns a given
 * conversation uuid. The discovery resolver (dispatcher.resolveAntigravityPath)
 * consults it to:
 *   (1) never hand a conversation already owned by a DIFFERENT live session to
 *       an as-yet-unbound one — two sessions can never resolve to the same .db;
 *   (2) LOCK a session to the first conversation it binds, so a later, newer
 *       .db on disk cannot re-bind an already-bound session on a subsequent
 *       mtime-ordered read.
 *
 * Ownership is keyed by a per-session owner token (see antigravityOwnerToken)
 * that BOTH the resolver and the provider instance derive identically from the
 * same inputs (workspace + spawn time, or the instance id), so the instance can
 * release its claims deterministically on shutdown.
 *
 * A claim not refreshed within CLAIM_STALE_MS is treated as abandoned — a
 * safety net for a session that died without an explicit release. Live sessions
 * poll native history far more frequently than this window, so an active owner
 * never lapses; only a crashed/leaked owner's claim ages out.
 *
 * OSS code (AGPL-3.0). Must not import from packages/ (proprietary).
 */
'use strict';

interface ConversationClaim {
  owner: string;
  /** Last time this owner (re)confirmed the claim. Only consulted by the
   *  stale-claim safety net; an active owner refreshes it on every resolve. */
  refreshedAtMs: number;
}

const claimsByUuid = new Map<string, ConversationClaim>();

/** A claim older than this with no refresh is reclaimable (owner presumed dead). */
export const CLAIM_STALE_MS = 10 * 60 * 1000;

function normalizeUuid(uuid: string): string {
  return String(uuid || '').trim().toLowerCase();
}

/**
 * Derive the per-session owner token. Both the dispatcher (from the read input:
 * workspace + sessionStartedAtMs) and the provider instance (from its
 * workingDir + startedAt, or its instanceId) call this with the same inputs so
 * claims and releases line up. Returns '' when there is no stable identity to
 * key on (e.g. a workspace-less discovery with no spawn time) — the caller then
 * skips claiming but the exclusion checks still run against existing claims.
 */
export function antigravityOwnerToken(
  workspace: string,
  sessionStartedAtMs: number,
  instanceId?: string,
): string {
  const iid = typeof instanceId === 'string' ? instanceId.trim() : '';
  if (iid) return `iid:${iid}`;
  if (typeof sessionStartedAtMs === 'number' && sessionStartedAtMs > 0) {
    const ws = String(workspace || '').trim().toLowerCase();
    return `spawn:${ws}:${sessionStartedAtMs}`;
  }
  return '';
}

/**
 * Claim `uuid` for `owner`. Succeeds (and refreshes) when the conversation is
 * unclaimed, already owned by this owner, or held by a stale (abandoned) owner.
 * Fails when a DIFFERENT live owner holds it. Returns whether `owner` holds the
 * claim after the call.
 */
export function claimAntigravityConversation(uuid: string, owner: string, now: number = Date.now()): boolean {
  const key = normalizeUuid(uuid);
  if (!key || !owner) return false;
  const existing = claimsByUuid.get(key);
  if (existing && existing.owner !== owner && (now - existing.refreshedAtMs) < CLAIM_STALE_MS) {
    return false;
  }
  claimsByUuid.set(key, { owner, refreshedAtMs: now });
  return true;
}

/** True when `uuid` is held by a live owner OTHER than `owner`. */
export function isAntigravityConversationClaimedByOther(uuid: string, owner: string, now: number = Date.now()): boolean {
  const key = normalizeUuid(uuid);
  if (!key) return false;
  const existing = claimsByUuid.get(key);
  if (!existing) return false;
  if (existing.owner === owner) return false;
  return (now - existing.refreshedAtMs) < CLAIM_STALE_MS;
}

/** The live owner of `uuid`, or undefined when unclaimed or stale. */
export function antigravityConversationOwner(uuid: string, now: number = Date.now()): string | undefined {
  const key = normalizeUuid(uuid);
  if (!key) return undefined;
  const existing = claimsByUuid.get(key);
  if (!existing) return undefined;
  if ((now - existing.refreshedAtMs) >= CLAIM_STALE_MS) return undefined;
  return existing.owner;
}

/** Release a single conversation, only if held by `owner` (or `owner` empty). */
export function releaseAntigravityConversation(uuid: string, owner?: string): void {
  const key = normalizeUuid(uuid);
  if (!key) return;
  const existing = claimsByUuid.get(key);
  if (existing && (!owner || existing.owner === owner)) claimsByUuid.delete(key);
}

/** Release every conversation held by `owner` (called on session shutdown). */
export function releaseAntigravityOwner(owner: string): void {
  if (!owner) return;
  for (const [key, claim] of claimsByUuid) {
    if (claim.owner === owner) claimsByUuid.delete(key);
  }
}

/** Test-only: wipe all claims so each test starts from a clean registry. */
export function __resetAntigravityClaimRegistry(): void {
  claimsByUuid.clear();
}
