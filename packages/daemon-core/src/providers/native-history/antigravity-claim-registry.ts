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
 * same inputs (the instance id), so the instance can release its claims
 * deterministically on shutdown.
 *
 * Since Stage 4 (kimi transcript claims) the storage and stale-claim semantics
 * live in the generalized transcript-claim-registry; this module keeps the
 * proven antigravity-facing API as a thin wrapper so the dispatcher, the
 * provider instance, and the existing tests are untouched.
 *
 * OSS code (AGPL-3.0). Must not import from packages/ (proprietary).
 */
'use strict';

import {
  CLAIM_STALE_MS as TRANSCRIPT_CLAIM_STALE_MS,
  claimTranscript,
  isTranscriptClaimedByOther,
  transcriptClaimOwner,
  releaseTranscript,
  releaseTranscriptOwner,
  transcriptClaimOwnerToken,
  __resetTranscriptClaimRegistry,
} from './transcript-claim-registry.js';

/** A claim older than this with no refresh is reclaimable (owner presumed dead)
 *  when no liveness probe is installed. */
export const CLAIM_STALE_MS = TRANSCRIPT_CLAIM_STALE_MS;

function normalizeUuid(uuid: string): string {
  return String(uuid || '').trim().toLowerCase();
}

/**
 * Derive the per-session owner token, keyed ONLY on the stable instanceId
 * (== the session registry sessionId == the read path's targetSessionId). Both
 * the dispatcher (read side) and the provider instance (claim/release side) pass
 * this same id, so their tokens always agree and the claim isolation holds.
 *
 * Returns '' when no instanceId is available — the caller then skips claiming
 * (the exclusion checks still run against existing claims). This is the SSOT
 * rule: there is exactly ONE token form. The removed legacy fallback derived a
 * `spawn:<workspace>:<sessionStartedAtMs>` token from the spawn timestamp when
 * the instanceId was missing; because one session's spawn time is sampled
 * independently at three sites (instance startedAt, adapter spawnedAtMs, registry
 * spawnedAtMs) those never matched, so the SAME session's instance-side and
 * read-side tokens silently diverged and the claim mutual-exclusion collapsed
 * (the antigravity conversation crosswire). An empty token (skip-claim) is
 * strictly safer than a token that disagrees with the same session's other
 * token. workspace/sessionStartedAtMs are kept in the signature for call-site
 * compatibility but no longer affect the token.
 */
export function antigravityOwnerToken(
  workspace: string,
  sessionStartedAtMs: number,
  instanceId?: string,
): string {
  void workspace; void sessionStartedAtMs;
  return transcriptClaimOwnerToken(instanceId);
}

/**
 * Claim `uuid` for `owner`. Succeeds (and refreshes) when the conversation is
 * unclaimed, already owned by this owner, or held by a stale (abandoned) owner.
 * Fails when a DIFFERENT live owner holds it. Returns whether `owner` holds the
 * claim after the call.
 */
export function claimAntigravityConversation(uuid: string, owner: string, now: number = Date.now()): boolean {
  return claimTranscript(normalizeUuid(uuid), owner, now) !== 'denied';
}

/** True when `uuid` is held by a live owner OTHER than `owner`. */
export function isAntigravityConversationClaimedByOther(uuid: string, owner: string, now: number = Date.now()): boolean {
  return isTranscriptClaimedByOther(normalizeUuid(uuid), owner, now);
}

/** The live owner of `uuid`, or undefined when unclaimed or stale. */
export function antigravityConversationOwner(uuid: string, now: number = Date.now()): string | undefined {
  return transcriptClaimOwner(normalizeUuid(uuid), now);
}

/** Release a single conversation, only if held by `owner` (or `owner` empty). */
export function releaseAntigravityConversation(uuid: string, owner?: string): void {
  releaseTranscript(normalizeUuid(uuid), owner);
}

/** Release every conversation held by `owner` (called on session shutdown). */
export function releaseAntigravityOwner(owner: string): void {
  releaseTranscriptOwner(owner);
}

/** Test-only: wipe all claims so each test starts from a clean registry. */
export function __resetAntigravityClaimRegistry(): void {
  __resetTranscriptClaimRegistry();
}
