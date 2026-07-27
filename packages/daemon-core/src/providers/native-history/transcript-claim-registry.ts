/**
 * transcript-claim-registry — daemon-local transcript ownership map.
 *
 * Generalized form of the antigravity conversation-claim registry (see
 * antigravity-claim-registry.ts, now a thin wrapper over this module). The
 * proven semantics are unchanged:
 *
 *   - one transcript key (an antigravity conversation uuid, a kimi wire.jsonl
 *     path, …) is owned by AT MOST ONE live daemon session at a time;
 *   - claiming is keyed by a per-session owner token derived ONLY from the
 *     stable instanceId (== the session registry sessionId == the read path's
 *     targetSessionId), so the read side and the provider-instance side always
 *     derive the identical token (the removed spawn-timestamp token form is what
 *     collapsed the original isolation — never reintroduce it);
 *   - a claim is refreshed on every successful resolve by its owner, so an
 *     active owner never lapses.
 *
 * Stale-claim safety: a claim is reclaimable only when the owning session is
 * DEMONSTRABLY inactive:
 *   - when a liveness probe is installed (production wires it to the session
 *     registry, see boot/daemon-lifecycle.ts), the probe is authoritative: a
 *     dead owner is reclaimable immediately, a LIVE owner is never stolen —
 *     even past CLAIM_STALE_MS (an idle live session may not refresh for a
 *     long time and must not lose its transcript to a same-cwd sibling);
 *   - without a probe (unit tests, early boot) the time-based CLAIM_STALE_MS
 *     window is the fallback safety net for an owner that died without an
 *     explicit release.
 *
 * Everything is process-local and synchronous (a plain Map), so concurrent
 * same-workspace claim attempts serialize on the event loop: exactly one
 * claimant wins, the loser is denied and must fail closed.
 *
 * OSS code (AGPL-3.0). Must not import from packages/ (proprietary).
 */
'use strict';

import { LOG } from '../../logging/logger.js';

interface TranscriptClaim {
  owner: string;
  /** Last time this owner (re)confirmed the claim. Only consulted by the
   *  time-based stale fallback; a probe-confirmed live owner is never
   *  reclaimed regardless of age. */
  refreshedAtMs: number;
}

const claimsByKey = new Map<string, TranscriptClaim>();

/** A claim older than this with no refresh is reclaimable (owner presumed dead)
 *  when no liveness probe is installed. */
export const CLAIM_STALE_MS = 10 * 60 * 1000;

/** The verdict of one claim attempt. */
export type ClaimVerdict = 'claimed' | 'stale_reclaimed' | 'denied';

/**
 * Optional liveness probe: given an owner token, return true when the owning
 * session is demonstrably LIVE (present in the session registry), false when
 * it is demonstrably dead. Unknown/foreign owner forms must return true (never
 * steal what we cannot prove dead). Installed once at daemon boot; tests
 * install their own deterministic probe.
 */
let livenessProbe: ((owner: string) => boolean) | null = null;

export function setTranscriptClaimLivenessProbe(probe: ((owner: string) => boolean) | null): void {
  livenessProbe = typeof probe === 'function' ? probe : null;
}

/**
 * Derive the per-session owner token, keyed ONLY on the stable instanceId
 * (== the session registry sessionId == the read path's targetSessionId). Both
 * the read side (chat-history pipeline) and the provider instance (release on
 * dispose) pass this same id, so their tokens always agree and the claim
 * isolation holds.
 *
 * Returns '' when no instanceId is available — the caller then skips claiming
 * (the exclusion checks still run against existing claims). This is the SSOT
 * rule: there is exactly ONE token form. An empty token (skip-claim) is
 * strictly safer than a token that disagrees with the same session's other
 * token.
 */
export function transcriptClaimOwnerToken(instanceId?: string): string {
  const iid = typeof instanceId === 'string' ? instanceId.trim() : '';
  return iid ? `iid:${iid}` : '';
}

function normalizeKey(key: string): string {
  return String(key || '').trim();
}

/** True when the existing claim's owner is demonstrably dead and the claim may
 *  be reclaimed. Probe authoritative when installed; time-based fallback else. */
function isReclaimable(existing: TranscriptClaim, now: number): boolean {
  if (livenessProbe) {
    try { return livenessProbe(existing.owner) === false; } catch { return false; }
  }
  return (now - existing.refreshedAtMs) >= CLAIM_STALE_MS;
}

/**
 * Claim `key` for `owner`. Succeeds (and refreshes) when the key is unclaimed,
 * already owned by this owner, or held by a demonstrably dead owner (reclaimed).
 * Fails ('denied') when a DIFFERENT live owner holds it — a live claimant is
 * never stolen.
 */
export function claimTranscript(key: string, owner: string, now: number = Date.now()): ClaimVerdict {
  const k = normalizeKey(key);
  if (!k || !owner) return 'denied';
  const existing = claimsByKey.get(k);
  if (existing && existing.owner !== owner) {
    if (!isReclaimable(existing, now)) {
      LOG.info('TranscriptClaim', `decision=already_claimed key=${k} owner=${owner} holder=${existing.owner}`);
      return 'denied';
    }
    LOG.info('TranscriptClaim', `decision=stale_reclaimed key=${k} owner=${owner} previousOwner=${existing.owner}`);
    claimsByKey.set(k, { owner, refreshedAtMs: now });
    return 'stale_reclaimed';
  }
  if (!existing) {
    LOG.info('TranscriptClaim', `decision=claimed key=${k} owner=${owner}`);
  }
  claimsByKey.set(k, { owner, refreshedAtMs: now });
  return 'claimed';
}

/** True when `key` is held by a live owner OTHER than `owner`. */
export function isTranscriptClaimedByOther(key: string, owner: string, now: number = Date.now()): boolean {
  const k = normalizeKey(key);
  if (!k) return false;
  const existing = claimsByKey.get(k);
  if (!existing) return false;
  if (existing.owner === owner) return false;
  return !isReclaimable(existing, now);
}

/** The live owner of `key`, or undefined when unclaimed or demonstrably dead. */
export function transcriptClaimOwner(key: string, now: number = Date.now()): string | undefined {
  const k = normalizeKey(key);
  if (!k) return undefined;
  const existing = claimsByKey.get(k);
  if (!existing) return undefined;
  if (isReclaimable(existing, now)) return undefined;
  return existing.owner;
}

/** Release a single key, only if held by `owner` (or `owner` empty). */
export function releaseTranscript(key: string, owner?: string): void {
  const k = normalizeKey(key);
  if (!k) return;
  const existing = claimsByKey.get(k);
  if (existing && (!owner || existing.owner === owner)) {
    LOG.info('TranscriptClaim', `decision=released key=${k} owner=${existing.owner}`);
    claimsByKey.delete(k);
  }
}

/** Release every key held by `owner` (called on session shutdown). */
export function releaseTranscriptOwner(owner: string): void {
  if (!owner) return;
  for (const [key, claim] of claimsByKey) {
    if (claim.owner === owner) {
      LOG.info('TranscriptClaim', `decision=released key=${key} owner=${owner}`);
      claimsByKey.delete(key);
    }
  }
}

/** Test-only: wipe all claims so each test starts from a clean registry. */
export function __resetTranscriptClaimRegistry(): void {
  claimsByKey.clear();
  livenessProbe = null;
}
