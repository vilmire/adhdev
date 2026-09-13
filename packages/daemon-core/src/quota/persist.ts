/**
 * Quota cache persistence — the file backing behind the in-memory Map.
 *
 * WHY: `refresh.ts` holds the authoritative snapshots in a process-local Map,
 * which dies with the daemon. A restart therefore reported nothing until the
 * boot refresh finished (and nothing at all for a provider whose fetch fails),
 * so a machine that had perfectly good numbers a second ago looked like it had
 * never reported. This module lets the Map be rebuilt from disk instantly.
 *
 * WHAT THIS IS NOT: a second source of truth. The Map stays authoritative at
 * runtime and this file is only its serialization — one logical store, written
 * after each refresh and read once at boot. In particular this does NOT replace
 * `~/.adhdev/claude-statusline/quota.json`: that file is Claude's *acquisition
 * channel* (a wrapper in another process writes it, the claude fetcher reads
 * it), not a competing cache, and it keeps its own path and lifecycle.
 *
 * THE READ PATH IS NOT TOUCHED. `readQuotaCache()` must stay a synchronous,
 * side-effect-free Map lookup — it runs inside every `git_status`, which
 * `mesh_status` calls per node. Hydration is a separate one-shot at boot.
 */
'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared';
import { LOG } from '../logging/logger.js';
import { adhdevHome } from './statusline/paths.js';

/**
 * Bumped only when a stored shape can no longer be read as-is. A file whose
 * version does not match is ignored (and overwritten on the next save) rather
 * than migrated — the cache is disposable by construction, so re-measuring
 * costs one refresh cycle and is always safe.
 */
export const QUOTA_CACHE_VERSION = 1;

/** `<configDir>/quota/` — honours the same track-aware root as the statusline bridge. */
export function quotaCacheDir(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(adhdevHome(env), 'quota');
}

export function quotaCachePath(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(quotaCacheDir(env), 'cache.json');
}

export interface QuotaCacheFile {
    version: number;
    updatedAt: number;
    providers: Record<string, MeshNodeFactsProviderQuota>;
}

/**
 * Does this snapshot carry a reading worth surviving a restart?
 *
 * "A reading" is any measured axis: the rolling session/weekly windows, or the
 * per-pool `buckets` a provider like antigravity reports (whose session/weekly
 * are only a worst-bucket collapse and can both be null while buckets hold the
 * real numbers). Deliberately shape-based rather than `status === 'ok'`: a
 * carried-forward entry (metadata.lastGoodWindows) is a non-ok snapshot that
 * still holds genuine numbers, and it is precisely the one we must keep.
 */
function holdsReading(entry: MeshNodeFactsProviderQuota | undefined): boolean {
    if (!entry) return false;
    if (entry.session !== null && entry.session !== undefined) return true;
    if (entry.weekly !== null && entry.weekly !== undefined) return true;
    return Array.isArray(entry.buckets) && entry.buckets.length > 0;
}

/**
 * ★THE CLOBBER BARRIER (owner report 2026-09-13: antigravity quota showed a
 * bald "Antigravity access token expired — run `agy`…" instead of the last
 * numbers, and STAYED there across restarts).
 *
 * Carry-forward (refresh.ts) keeps the last good numbers in memory, but the
 * file is what a restart reads back, and it was overwritten with whatever the
 * tick produced — including a transient failure carrying NO numbers. That made
 * the failure sticky in a way the in-memory path never was:
 *
 *   tick fails transiently → numberless error persisted (last-good erased)
 *   → restart hydrates the ERROR → carry-forward now has no `prev` reading to
 *   carry → persists the error again → permanently numberless until a live
 *   token appears.
 *
 * Antigravity is the case that cannot self-heal out of that loop: its
 * credential store holds OAuth tokens, not buckets, so there is no second
 * source to rebuild a reading from (unlike codex, which re-derives one from its
 * rollout logs). Once the file lost the numbers they were gone until the user
 * ran `agy` by hand.
 *
 * So: a provider entry that holds NO reading never overwrites a stored entry
 * that does. The fresh failure's status/error/failureKind still win — we keep
 * the numbers and their original `updatedAt`, not the stale verdict — which is
 * the same "retained numbers, fresh failure signal" contract carry-forward
 * applies in memory, and the retained axes are marked `lastGoodWindows` so no
 * reader mistakes them for a live measurement.
 */
export function mergeLastGoodForPersist(
    fresh: Record<string, MeshNodeFactsProviderQuota>,
    stored: Record<string, MeshNodeFactsProviderQuota> | undefined,
): Record<string, MeshNodeFactsProviderQuota> {
    if (!stored) return fresh;
    const merged: Record<string, MeshNodeFactsProviderQuota> = {};
    for (const [provider, entry] of Object.entries(fresh)) {
        const prior = stored[provider];
        if (holdsReading(entry) || !holdsReading(prior)) {
            merged[provider] = entry;
            continue;
        }
        merged[provider] = {
            ...entry,
            session: prior.session,
            weekly: prior.weekly,
            ...(prior.monthly !== undefined ? { monthly: prior.monthly } : {}),
            ...(prior.buckets !== undefined ? { buckets: prior.buckets } : {}),
            // The numbers keep the age of the observation that produced them,
            // never the age of the failure that could not replace them.
            updatedAt: prior.updatedAt,
            metadata: { ...entry.metadata, lastGoodWindows: true },
        };
    }
    // A provider absent from `fresh` was pruned on purpose (the enable gate
    // drops a disabled provider's entry), so it is NOT resurrected from disk.
    return merged;
}

/**
 * Persist the current snapshots.
 *
 * Written temp-then-rename (the pattern the statusline wrapper already uses, see
 * quota/statusline/wrapper-source.ts) so a reader can never observe a
 * half-written file, and 0600 because a snapshot may carry the signed-in
 * account's email — see QuotaMetadata.accountEmail. Never throws: a cache that
 * cannot be written is a lost optimisation, not a failure of the refresh that
 * produced the numbers.
 */
export function saveQuotaCache(
    providers: Record<string, MeshNodeFactsProviderQuota>,
    env: NodeJS.ProcessEnv = process.env,
    nowMs: number = Date.now(),
): boolean {
    const file = quotaCachePath(env);
    const temp = `${file}.${process.pid}.tmp`;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const payload: QuotaCacheFile = { version: QUOTA_CACHE_VERSION, updatedAt: nowMs, providers };
        fs.writeFileSync(temp, JSON.stringify(payload), { encoding: 'utf-8', mode: 0o600 });
        fs.renameSync(temp, file);
        return true;
    } catch (e: any) {
        LOG.warn('Quota', `Quota cache save failed (in-memory cache unaffected): ${e?.message || e}`);
        try { fs.unlinkSync(temp); } catch { /* best-effort temp cleanup */ }
        return false;
    }
}

/**
 * Read the persisted snapshots, or undefined when there is nothing usable.
 *
 * Every failure mode — absent file, unreadable file, malformed JSON, wrong
 * version, wrong shape — resolves to "no cache", which is exactly the state a
 * daemon is in before its first refresh. That is what makes this safe to call
 * unconditionally at boot: the worst case is the behaviour we already had.
 */
export function loadQuotaCache(env: NodeJS.ProcessEnv = process.env): Record<string, MeshNodeFactsProviderQuota> | undefined {
    let raw: string;
    try {
        raw = fs.readFileSync(quotaCachePath(env), 'utf-8');
    } catch {
        return undefined; // absent (the normal first-run case) or unreadable
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        LOG.warn('Quota', 'Quota cache file is not valid JSON — starting with an empty cache');
        return undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record.version !== QUOTA_CACHE_VERSION) {
        LOG.info('Quota', `Ignoring quota cache written by a different version (${String(record.version)})`);
        return undefined;
    }
    const providers = record.providers;
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return undefined;

    // Keep only entries that still look like a snapshot. A single corrupt entry
    // must not discard the providers that round-tripped cleanly.
    const restored: Record<string, MeshNodeFactsProviderQuota> = {};
    for (const [provider, value] of Object.entries(providers as Record<string, unknown>)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const entry = value as Record<string, unknown>;
        // `status` is the field a reader keys on to tell "looked and failed"
        // from "never reported"; without it the entry cannot be interpreted.
        if (typeof entry.status !== 'string') continue;
        restored[provider] = entry as unknown as MeshNodeFactsProviderQuota;
    }
    return Object.keys(restored).length > 0 ? restored : undefined;
}
