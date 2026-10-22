/**
 * Model discovery registry — the in-memory cache, its TTL/SWR schedule, and
 * the read path the provider loader overlays from.
 *
 * ★This mirrors `quota/refresh.ts` deliberately, down to the axis split. It is
 * not an accident that the two look alike: they answer the same SHAPE of
 * question (a per-provider reading that costs something to obtain and is read
 * far more often than it changes), on the same 7-of-8 provider set, with the
 * same hazard (a timer that hits a third party's endpoint). Reusing the shape
 * means the cadence rules were argued once, not twice.
 *
 * THE READ PATH NEVER FETCHES. `readModelCache()` is a synchronous Map lookup
 * that cannot block, throw or await — because its caller is the provider
 * inventory, which is built on paths as hot as `git_status`. Read-triggered
 * revalidation is a SEPARATE function (`readModelCacheWithRevalidate`) that
 * only low-rate, human-facing surfaces call. Do not merge the two.
 */
'use strict';

import { LOG } from '../logging/logger.js';
import { discoverProviderModels, type ModelDiscoveryDeps } from './discover.js';
import { loadModelCache, saveModelCache } from './persist.js';
import type { ModelDiscoveryReason, ModelDiscoverySnapshot, ModelDiscoverySpec } from './types.js';
import { TRANSIENT_MODEL_DISCOVERY_FAILURE_KINDS } from './types.js';

/**
 * How long a SUCCESSFUL discovery stays authoritative before a read may
 * revalidate it.
 *
 * 24h, and deliberately much longer than any quota TTL: a quota number moves
 * within a work session, whereas a model list moves when a VENDOR SHIPS — on
 * the order of weeks. The cost profile points the same way, since several of
 * these commands go to the network (`agy models` prints "Fetching available
 * models..."). A day-long TTL keeps the picker current well inside the interval
 * that actually matters while making the probe effectively free.
 */
export const MODEL_DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a FAILED discovery is left alone before retrying.
 *
 * Much shorter than the success TTL, because the common failures are
 * transient-by-nature states the user can fix in seconds (signed out, offline)
 * and the fallback in force meanwhile is a stale manifest list. 30 minutes
 * retries soon enough to pick up a login without turning a persistent failure
 * into a spawn loop.
 */
export const MODEL_DISCOVERY_FAILURE_RETRY_MS = 30 * 60 * 1000;

/** Transient failures (network/timeout) get a faster retry than the general failure backoff. */
export const MODEL_DISCOVERY_TRANSIENT_RETRY_MS = 5 * 60 * 1000;

/** Provider entry the registry needs in order to discover. Structural, so any loader shape fits. */
export interface ModelDiscoveryTarget {
    type: string;
    modelDiscovery?: ModelDiscoverySpec;
    /** Resolved CLI path from provider detection; absent → not installed here. */
    binary?: string | null;
    /** Currently detected provider CLI version (from VersionArchive / detection). */
    cliVersion?: string | null;
}

interface InFlightDiscovery {
    cliVersion: string | undefined;
    promise: Promise<ModelDiscoverySnapshot>;
}

/** Process-local authoritative cache. The file in persist.ts is only its serialization. */
const cache = new Map<string, ModelDiscoverySnapshot>();
/** In-flight discoveries, so concurrent reads coalesce to one spawn per provider. */
const inFlight = new Map<string, InFlightDiscovery>();
let hydrated = false;

function normalizeCliVersion(version: string | null | undefined): string | undefined {
    const trimmed = typeof version === 'string' ? version.trim() : '';
    return trimmed ? trimmed : undefined;
}

/**
 * Rebuild the in-memory cache from disk. Safe to call unconditionally at boot;
 * a cache that cannot be read leaves the Map empty, which is the pre-discovery
 * state (→ manifest lists).
 */
export function hydrateModelCache(env: NodeJS.ProcessEnv = process.env): number {
    const stored = loadModelCache(env);
    if (stored) {
        for (const [provider, snapshot] of Object.entries(stored)) cache.set(provider, snapshot);
    }
    hydrated = true;
    return cache.size;
}

/** Test-only reset for the process-local cache and hydration state. */
export function resetModelCacheForTests(): void {
    cache.clear();
    inFlight.clear();
    hydrated = false;
}

/**
 * Synchronous, side-effect-free read. ★Cannot trigger a fetch — the absence of
 * that affordance is the contract that keeps this safe on hot paths.
 */
export function readModelCache(provider: string): ModelDiscoverySnapshot | undefined {
    return cache.get(provider);
}

/** Every cached snapshot, for the staleness/badge surface. */
export function readAllModelCache(): Record<string, ModelDiscoverySnapshot> {
    return Object.fromEntries(cache.entries());
}

/** How long a snapshot may rest before a read-triggered revalidate is worthwhile. */
function dueAfterMs(snapshot: ModelDiscoverySnapshot): number {
    if (snapshot.status === 'ok') return MODEL_DISCOVERY_TTL_MS;
    // A declared-undiscoverable provider is never due: there is nothing to retry.
    if (snapshot.status === 'not-supported') return Number.POSITIVE_INFINITY;
    if (snapshot.failureKind && TRANSIENT_MODEL_DISCOVERY_FAILURE_KINDS.has(snapshot.failureKind)) {
        return MODEL_DISCOVERY_TRANSIENT_RETRY_MS;
    }
    return MODEL_DISCOVERY_FAILURE_RETRY_MS;
}

/**
 * Determine why a provider's model snapshot is due for discovery, or `null`
 * when the cached snapshot is still fresh and valid for `currentCliVersion`.
 *
 * Reasons:
 * - `'boot'`: no cached snapshot exists for this provider yet.
 * - `'no_version'`: cached snapshot has no recorded `cliVersion` (legacy
 *   `discovery.json` predating version-tracked caching, or an unversioned
 *   capture after a CLI version becomes known).
 * - `'version_changed'`: cached `snapshot.cliVersion` differs from the
 *   currently detected `currentCliVersion`.
 * - `'ttl'`: TTL (for `ok`) or retry backoff (for `error`/`unavailable`) has
 *   elapsed since `snapshot.fetchedAt`.
 */
export function getModelSnapshotDueReason(
    snapshot: ModelDiscoverySnapshot | undefined,
    nowMs: number = Date.now(),
    currentCliVersion?: string | null,
): ModelDiscoveryReason | null {
    if (!snapshot) return 'boot';
    // A declared-undiscoverable provider is never due: there is nothing to retry.
    if (snapshot.status === 'not-supported') return null;

    const recordedVersion = normalizeCliVersion(snapshot.cliVersion);
    const detectedVersion = normalizeCliVersion(currentCliVersion);

    if (!recordedVersion) {
        // Legacy snapshots (`status === 'ok'` with no recorded `cliVersion`,
        // like DesktopA's 2026-10-18 discovery.json) are always treated as stale
        // so existing machines repair themselves on the next daemon start
        // without manual file deletion. Non-ok snapshots with no version also
        // invalidate as soon as a CLI version is detected.
        if (snapshot.status === 'ok' || detectedVersion) {
            return 'no_version';
        }
    } else if (detectedVersion && recordedVersion !== detectedVersion) {
        return 'version_changed';
    }

    const due = dueAfterMs(snapshot);
    if (!Number.isFinite(due)) return null;
    // Scheduling reads `fetchedAt` (last ATTEMPT), never `updatedAt` (last
    // successful capture) — same two-clock rule as the quota cache.
    if (nowMs - (snapshot.fetchedAt || 0) >= due) return 'ttl';
    return null;
}

export function isModelSnapshotDue(
    snapshot: ModelDiscoverySnapshot | undefined,
    nowMs: number = Date.now(),
    currentCliVersion?: string | null,
): boolean {
    return getModelSnapshotDueReason(snapshot, nowMs, currentCliVersion) !== null;
}

/**
 * Discover one provider now, coalescing concurrent callers, and persist the
 * result. Never throws.
 */
export async function refreshProviderModels(
    target: ModelDiscoveryTarget,
    deps: ModelDiscoveryDeps = {},
    env: NodeJS.ProcessEnv = process.env,
    reason?: ModelDiscoveryReason,
): Promise<ModelDiscoverySnapshot> {
    const requestedVersion = normalizeCliVersion(target.cliVersion ?? deps.cliVersion);
    const existing = inFlight.get(target.type);
    if (existing) {
        if (existing.cliVersion === requestedVersion || !requestedVersion) {
            return existing.promise;
        }
        // An earlier discovery is in-flight for a different (older or unknown)
        // CLI version — e.g. `agy models` triggered agy's self-updater while
        // running, and version detection observed the new version before the
        // old run finished. Wait for the old run to settle, then re-run if the
        // cache still does not reflect `requestedVersion`.
        await existing.promise.catch(() => { /* settled */ });
        const afterExisting = cache.get(target.type);
        const postReason = getModelSnapshotDueReason(afterExisting, deps.now?.() ?? Date.now(), requestedVersion);
        if (!postReason) {
            return afterExisting!;
        }
        return refreshProviderModels(target, deps, env, postReason);
    }

    const prior = cache.get(target.type);
    const effectiveReason: ModelDiscoveryReason =
        reason
        ?? getModelSnapshotDueReason(prior, deps.now?.() ?? Date.now(), requestedVersion)
        ?? 'boot';

    const promise = (async () => {
        const snapshot = await discoverProviderModels(
            target.type,
            target.modelDiscovery,
            target.binary || undefined,
            requestedVersion ? { ...deps, cliVersion: requestedVersion } : deps,
        );
        // ★CARRY-FORWARD: a failed refresh must not erase a good list. Keep the
        // previous models and their original `updatedAt`, while the fresh
        // failure's status/kind wins — the same "retained numbers, fresh failure
        // signal" contract the quota cache applies (quota/persist.ts). Without
        // this, one offline moment would drop a discovered picker back to the
        // stale manifest until the next successful probe.
        const currentPrior = cache.get(target.type);
        const merged: ModelDiscoverySnapshot =
            snapshot.status !== 'ok' && currentPrior?.status === 'ok' && currentPrior.models.length > 0
                ? { ...snapshot, models: currentPrior.models, updatedAt: currentPrior.updatedAt }
                : snapshot;
        cache.set(target.type, merged);
        LOG.info(
            'Models',
            `[${target.type}] model discovery: ${merged.models.length} models, cliVersion=${merged.cliVersion ?? 'unknown'}, reason=${effectiveReason}, status=${merged.status}`,
        );
        try {
            saveModelCache(readAllModelCache(), env);
        } catch { /* cache write is an optimisation, never a failure of discovery */ }
        return merged;
    })().finally(() => {
        if (inFlight.get(target.type)?.promise === promise) {
            inFlight.delete(target.type);
        }
    });

    inFlight.set(target.type, { cliVersion: requestedVersion, promise });
    return promise;
}

/**
 * Read with stale-while-revalidate: return what we have IMMEDIATELY and kick
 * off a background refresh when the entry is due.
 *
 * ★For human-facing surfaces only (opening a picker, loading the providers
 * tab). The hot inventory path calls `readModelCache()` and cannot fetch.
 */
export function readModelCacheWithRevalidate(
    target: ModelDiscoveryTarget,
    deps: ModelDiscoveryDeps = {},
    env: NodeJS.ProcessEnv = process.env,
): ModelDiscoverySnapshot | undefined {
    const snapshot = cache.get(target.type);
    const nowMs = deps.now?.() ?? Date.now();
    const reason = getModelSnapshotDueReason(snapshot, nowMs, target.cliVersion ?? deps.cliVersion);
    if (reason) {
        void refreshProviderModels(target, deps, env, reason).catch(() => { /* background */ });
    }
    return snapshot;
}

/**
 * Refresh every due provider. Called at boot and on demand; sequential rather
 * than parallel because each entry may spawn a CLI and this is background work
 * with no deadline.
 */
export async function refreshDueModelDiscovery(
    targets: ModelDiscoveryTarget[],
    deps: ModelDiscoveryDeps = {},
    env: NodeJS.ProcessEnv = process.env,
): Promise<{ refreshed: string[]; skipped: string[] }> {
    if (!hydrated) hydrateModelCache(env);
    const refreshed: string[] = [];
    const skipped: string[] = [];
    for (const target of targets) {
        if (!target?.type || !target.modelDiscovery) { skipped.push(target?.type || '(unnamed)'); continue; }
        const nowMs = deps.now?.() ?? Date.now();
        const reason = getModelSnapshotDueReason(
            cache.get(target.type),
            nowMs,
            target.cliVersion ?? deps.cliVersion,
        );
        if (!reason) { skipped.push(target.type); continue; }
        try {
            const snapshot = await refreshProviderModels(target, deps, env, reason);
            refreshed.push(target.type);
            if (snapshot.status !== 'ok' && snapshot.status !== 'not-supported') {
                LOG.debug?.('Models', `[${target.type}] discovery ${snapshot.failureKind}: ${snapshot.error} — manifest list stands`);
            }
        } catch (e: any) {
            // refreshProviderModels already swallows; this is pure belt-and-braces.
            LOG.warn('Models', `[${target.type}] discovery threw unexpectedly: ${e?.message || e}`);
            skipped.push(target.type);
        }
    }
    return { refreshed, skipped };
}

/**
 * Hook into provider CLI version-change detection (`VersionArchive.onVersionChange`)
 * so a self-updating CLI that upgrades seconds after boot discovery immediately
 * invalidates its stale snapshot and re-runs discovery in the same daemon
 * lifetime without waiting for the 24h TTL.
 */
export function registerModelDiscoveryVersionHook(
    archive: { onVersionChange?: (listener: (type: string, version: string, previousVersion: string | null) => void) => () => void } | null | undefined,
    resolveTarget: (type: string, cliVersion: string) => ModelDiscoveryTarget | undefined,
    deps: ModelDiscoveryDeps = {},
    env: NodeJS.ProcessEnv = process.env,
): () => void {
    if (!archive || typeof archive.onVersionChange !== 'function') return () => {};
    return archive.onVersionChange((type, version) => {
        try {
            const target = resolveTarget(type, version);
            if (!target?.type || !target.modelDiscovery || target.modelDiscovery.kind === 'none') return;
            void refreshDueModelDiscovery([{ ...target, cliVersion: version }], deps, env).catch(() => {
                /* background; manifest lists stand */
            });
        } catch {
            /* fail-soft */
        }
    });
}

