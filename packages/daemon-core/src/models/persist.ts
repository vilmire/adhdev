/**
 * Model-discovery cache persistence — the file behind the in-memory Map.
 *
 * ★THIS FILE EXISTS SO THE MANIFEST NEVER HAS TO BE WRITTEN.
 *
 * Provider manifests live in a content-addressed, digest-verified channel
 * store: the daemon checks each object's digest against the channel pointer
 * before activating it. Writing a discovered model list back into
 * `provider.v1.json` would change those bytes and break that verification —
 * turning a routine model refresh into a channel-integrity failure. So the
 * discovered list lands HERE, beside the quota cache, and is merged at READ
 * time (`overlay.ts`). The manifest stays exactly as it was signed.
 *
 * Sibling of `quota/persist.ts` by design — same directory root, same
 * temp-then-rename write, same "every failure resolves to no cache" read. The
 * one intentional difference is the permissions: quota snapshots may carry the
 * signed-in account's email and are 0600, whereas a model list is not a
 * secret. It is still written 0600 so the two caches cannot be told apart by
 * their mode, and because nothing needs to read it but this daemon.
 */
'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';

import { LOG } from '../logging/logger.js';
import { adhdevHome } from '../quota/statusline/paths.js';
import type { ModelDiscoverySnapshot } from './types.js';

/**
 * Bumped only when a stored shape can no longer be read as-is. A mismatched
 * file is ignored and overwritten rather than migrated: the cache is disposable
 * by construction — losing it costs one discovery cycle and is always safe.
 */
export const MODEL_CACHE_VERSION = 1;

/** `<configDir>/models/` — honours the same track-aware root as the quota cache. */
export function modelCacheDir(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(adhdevHome(env), 'models');
}

export function modelCachePath(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(modelCacheDir(env), 'discovery.json');
}

export interface ModelCacheFile {
    version: number;
    updatedAt: number;
    providers: Record<string, ModelDiscoverySnapshot>;
}

/**
 * Persist the current snapshots. Never throws — a cache that cannot be written
 * is a lost optimisation, not a failure of the discovery that produced it.
 */
export function saveModelCache(
    providers: Record<string, ModelDiscoverySnapshot>,
    env: NodeJS.ProcessEnv = process.env,
    nowMs: number = Date.now(),
): boolean {
    const file = modelCachePath(env);
    const temp = `${file}.${process.pid}.tmp`;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const payload: ModelCacheFile = { version: MODEL_CACHE_VERSION, updatedAt: nowMs, providers };
        fs.writeFileSync(temp, JSON.stringify(payload), { encoding: 'utf-8', mode: 0o600 });
        fs.renameSync(temp, file);
        return true;
    } catch (e: any) {
        LOG.warn('Models', `Model cache save failed (in-memory cache unaffected): ${e?.message || e}`);
        try { fs.unlinkSync(temp); } catch { /* best-effort temp cleanup */ }
        return false;
    }
}

/**
 * Read the persisted snapshots, or undefined when there is nothing usable.
 *
 * Every failure mode — absent, unreadable, malformed, wrong version, wrong
 * shape — resolves to "no cache", which is the state a daemon is in before its
 * first discovery. That is what makes this safe to call unconditionally at
 * boot: the worst case is the behaviour we already had (manifest lists).
 */
export function loadModelCache(env: NodeJS.ProcessEnv = process.env): Record<string, ModelDiscoverySnapshot> | undefined {
    let raw: string;
    try {
        raw = fs.readFileSync(modelCachePath(env), 'utf-8');
    } catch {
        return undefined; // absent (the normal first-run case) or unreadable
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        LOG.warn('Models', 'Model cache file is not valid JSON — starting with an empty cache');
        return undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record.version !== MODEL_CACHE_VERSION) {
        LOG.info('Models', `Ignoring model cache written by a different version (${String(record.version)})`);
        return undefined;
    }
    const providers = record.providers;
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return undefined;

    // One corrupt entry must not discard the providers that round-tripped cleanly.
    const restored: Record<string, ModelDiscoverySnapshot> = {};
    for (const [provider, value] of Object.entries(providers as Record<string, unknown>)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const entry = value as Record<string, unknown>;
        // `status` is how a reader tells "looked and failed" from "never looked";
        // `models` must be an array or the overlay cannot use it.
        if (typeof entry.status !== 'string' || !Array.isArray(entry.models)) continue;
        restored[provider] = entry as unknown as ModelDiscoverySnapshot;
    }
    return Object.keys(restored).length > 0 ? restored : undefined;
}
