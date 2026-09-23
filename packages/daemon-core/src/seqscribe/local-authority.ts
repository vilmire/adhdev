/**
 * seqscribe standalone local authority (C7-3).
 *
 * Design: docs/design/2026-09-23-wiring-unification.md §5 C7-3.
 *
 * ── The problem ──────────────────────────────────────────────────────────
 * `defineTopic` refuses any policy naming `finalityAuthority` unless the node
 * was built with `verifyFinality` (authority.ts / node.ts). Without a fleet
 * secret (`resolveFleetSecret` returns null — the normal state for a
 * standalone daemon that never completed the cloud `auth_ok` handshake),
 * `node.ts` pre-filters `mesh.<id>.handoff` and the other content topics out
 * of `defs` before `defineTopic` ever runs (§7.3's "Correction" — the library
 * never actually throws in practice, node.ts avoids it). That is correct for
 * a daemon that will never verify certificates from anyone, but standalone
 * still wants worker handoff notes (C10-1's content path) to work on a
 * single machine with zero fleet.
 *
 * ── The fix ──────────────────────────────────────────────────────────────
 * Mint a random 32-byte secret local to this machine, store it exactly like
 * fleet-secret.ts (0600 atomic write, same directory conventions), and build
 * an `hmacAuthority` from it with `ADHDEV_AUTHORITY_ID` unchanged (the
 * authority ID — not the secret value — is what `topicSchemaHash` hashes, so
 * a locally-minted secret never changes the fleet schema hash; see
 * authority.ts's own comment on this). `defineTopic` then succeeds for every
 * content topic, and this daemon can both write AND verify (against itself)
 * — which is exactly what a single, offline machine needs.
 *
 * ── "Verification present, issuance off" (§7.3's load-bearing correction) ──
 * `hmacAuthority()` is symmetric: one object carries both verify hooks and
 * sign/issue methods baked into the same HMAC closure (host.ts) — there is
 * no flag to build a verify-only authority (confirmed by direct read,
 * scratchpad phase-C-W6-brief.md §3). "Issuance off" for a locally-minted
 * secret is therefore enforced ENTIRELY by the caller never invoking
 * `startFleetFinalityLoop` for this authority, never by any property of the
 * authority object itself — node.ts must never pass `isCoordinator: true`
 * down this path. The object returned here CAN sign certs/directives if
 * anything ever calls `authority.signFinality`/`issueWriterDirective`
 * directly; the gate lives entirely at the call site, not here. See the
 * `LocalAuthorityHandle.local` flag below, which callers use to enforce that.
 */

import { randomBytes } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { AuthorityHooks } from 'seqscribe';
import { getConfigDir } from '../config/config.js';
import { LOG } from '../logging/logger.js';
import { createFleetAuthority } from './authority.js';

/** Credentials file name under the config dir. Mirrors fleet-secret.ts's naming and hygiene. */
export const LOCAL_AUTHORITY_SECRET_FILE = 'seqscribe-local-authority.json';

/** The on-disk record. No `version` field: unlike the fleet secret this is never server-reissued. */
export interface StoredLocalAuthoritySecret {
    secret: string;
}

function localAuthoritySecretPath(env?: NodeJS.ProcessEnv): string {
    return join(getConfigDir(env), LOCAL_AUTHORITY_SECRET_FILE);
}

/**
 * Load the stored local authority secret, or null when there is none usable.
 *
 * NEVER throws — same contract as loadStoredFleetSecret: a missing file is
 * the normal first-boot state, a malformed one is logged (without contents)
 * and treated as absent so the caller mints a fresh one.
 */
export function loadStoredLocalAuthoritySecret(env?: NodeJS.ProcessEnv): string | null {
    const path = localAuthoritySecretPath(env);
    if (!existsSync(path)) return null;
    let raw: string;
    try {
        raw = readFileSync(path, 'utf-8');
    } catch (err) {
        LOG.warn(
            'Seqscribe',
            `local authority secret file unreadable (${err instanceof Error ? err.message : String(err)}); minting a fresh one`,
        );
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (
            parsed !== null &&
            typeof parsed === 'object' &&
            typeof (parsed as StoredLocalAuthoritySecret).secret === 'string' &&
            (parsed as StoredLocalAuthoritySecret).secret.length > 0
        ) {
            return (parsed as StoredLocalAuthoritySecret).secret;
        }
    } catch {
        /* malformed JSON — fall through to the warn below */
    }
    LOG.warn('Seqscribe', 'local authority secret file is malformed; minting a fresh one');
    return null;
}

/**
 * Persist a newly minted local authority secret. Same atomic-write shape as
 * fleet-secret.ts's storeFleetSecret: tmp file at mode 0600 inside the 0700
 * config dir, then rename, then a defensive re-chmod (rename does not always
 * carry the mode onto an existing destination on every platform).
 *
 * The secret VALUE is never logged, matching fleet-secret.ts's hygiene rule.
 */
export function storeLocalAuthoritySecret(secret: string, env?: NodeJS.ProcessEnv): void {
    if (typeof secret !== 'string' || secret.length === 0) {
        throw new Error('storeLocalAuthoritySecret requires a non-empty secret string');
    }
    const dir = getConfigDir(env);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const path = join(dir, LOCAL_AUTHORITY_SECRET_FILE);
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ secret } satisfies StoredLocalAuthoritySecret, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
    });
    try {
        renameSync(tmp, path);
    } catch (err) {
        try {
            unlinkSync(tmp);
        } catch {
            /* already gone */
        }
        throw err;
    }
    try {
        chmodSync(path, 0o600);
    } catch {
        /* Windows etc. not supported */
    }
    LOG.info('Seqscribe', 'local authority secret minted (standalone, no fleet secret configured)');
}

/** 32 random bytes, hex-encoded — same shape a server-issued fleet secret would take. */
function mintLocalAuthoritySecret(): string {
    return randomBytes(32).toString('hex');
}

/**
 * Load-or-mint the local authority secret, persisting a fresh one on first
 * use. Never throws: a write failure degrades to an in-memory-only secret
 * for this process (logged), rather than blocking node open.
 */
export function loadOrCreateLocalAuthoritySecret(env?: NodeJS.ProcessEnv): string {
    const existing = loadStoredLocalAuthoritySecret(env);
    if (existing) return existing;
    const minted = mintLocalAuthoritySecret();
    try {
        storeLocalAuthoritySecret(minted, env);
    } catch (err) {
        LOG.warn(
            'Seqscribe',
            `failed to persist local authority secret (${err instanceof Error ? err.message : String(err)}); using an in-memory secret for this process only`,
        );
    }
    return minted;
}

export interface LocalAuthorityHandle {
    hooks: AuthorityHooks;
    /**
     * Always true for the object this module returns — callers (node.ts) use
     * this to assert they never pass `isCoordinator: true` for a
     * locally-minted authority. There is no library-level verify-only mode
     * (see file header): this flag is the ONLY gate against a future
     * refactor accidentally starting the issuance loop for a machine with no
     * fleet to certify for.
     */
    local: true;
}

/**
 * Build a local (single-machine) authority from a load-or-mint secret. The
 * authority id is always `ADHDEV_AUTHORITY_ID` (createFleetAuthority's
 * default) — never overridden — so `topicSchemaHash` is identical to a
 * fleet-secret-backed authority; only the secret VALUE differs, and the
 * schema hash never depends on it (authority.ts's own comment on this).
 */
export function createLocalAuthority(env?: NodeJS.ProcessEnv): LocalAuthorityHandle {
    const secret = loadOrCreateLocalAuthoritySecret(env);
    const authority = createFleetAuthority({ secret });
    return { hooks: authority, local: true };
}
