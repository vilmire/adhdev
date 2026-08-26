/**
 * seqscribe fleet secret — local persistence for the server-issued secret.
 *
 * Phase 1 of the seqscribe integration (design §1.4, D7). The fleet secret
 * arrives via the daemon's `auth_ok` handshake from the cloud server; the
 * proprietary daemon-cloud package writes it through this module the moment it
 * lands, and `openSeqscribeNode` reads it back on boot (see authority.ts for
 * the resolution priority — env var first, then this store, then provisional).
 *
 * ── Deliberately NOT config.json ────────────────────────────────────────────
 * The design's D7 direction is secrets OUT of config.json: it recommends
 * separating even `machineSecret` into a credentials file (mode 0600) as
 * defense in depth, independent of the settings whitelist. This new secret
 * starts separated — its own file, its own permissions, its own lifecycle —
 * so a future "export my config" or a settings-register replication pass can
 * never carry it by accident.
 *
 * ── Secret hygiene ──────────────────────────────────────────────────────────
 * The secret VALUE is never logged from this module — not on success, not on
 * failure, not even truncated. The on-disk shape is validated before use and
 * anything malformed is treated as "no secret" (provisional mode) rather than
 * a boot failure: a corrupt credentials file must degrade the fleet to
 * provisional sync, never wedge the daemon.
 *
 * Written atomically (tmp file + rename) so a crash mid-write cannot leave a
 * truncated file that a later boot would mistake for a valid secret — and
 * cannot leave the PREVIOUS good secret half-overwritten either.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getConfigDir } from '../config/config.js';
import { LOG } from '../logging/logger.js';

/** Credentials file name under the config dir. NOT config.json — see header. */
export const FLEET_SECRET_FILE = 'seqscribe-fleet-secret.json';

/** The on-disk record. `version` is monotonic (server-issued), ≥ 1. */
export interface StoredFleetSecret {
    secret: string;
    version: number;
}

function fleetSecretPath(env?: NodeJS.ProcessEnv): string {
    return join(getConfigDir(env), FLEET_SECRET_FILE);
}

/**
 * Load the stored fleet secret, or null when there is none usable.
 *
 * NEVER throws: a missing file is the normal pre-auth state, and a malformed
 * one (bad JSON, wrong shape) is logged — WITHOUT the file contents — and
 * treated as absent. Callers fall through to provisional mode either way.
 */
export function loadStoredFleetSecret(env?: NodeJS.ProcessEnv): StoredFleetSecret | null {
    const path = fleetSecretPath(env);
    if (!existsSync(path)) return null;
    let raw: string;
    try {
        raw = readFileSync(path, 'utf-8');
    } catch (err) {
        LOG.warn(
            'Seqscribe',
            `fleet secret file unreadable (${err instanceof Error ? err.message : String(err)}); ignoring it`,
        );
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (
            parsed !== null &&
            typeof parsed === 'object' &&
            typeof (parsed as StoredFleetSecret).secret === 'string' &&
            (parsed as StoredFleetSecret).secret.length > 0 &&
            Number.isInteger((parsed as StoredFleetSecret).version) &&
            (parsed as StoredFleetSecret).version >= 1
        ) {
            const { secret, version } = parsed as StoredFleetSecret;
            return { secret, version };
        }
    } catch {
        /* malformed JSON — fall through to the warn below */
    }
    // Never log `raw` or the parsed value: the file is a credentials store and
    // even a malformed one may contain the secret in a shifted shape.
    LOG.warn('Seqscribe', 'fleet secret file is malformed; ignoring it (provisional mode)');
    return null;
}

/**
 * Persist the fleet secret delivered by `auth_ok`.
 *
 * Validates its input and THROWS on it — the caller (the daemon-cloud auth
 * path) owns validating the server's message, and silently dropping a bad
 * secret would leave the node in provisional mode with no signal why. The
 * write itself is atomic (tmp + rename) at mode 0600 inside the 0700 config
 * dir, matching the config.json write conventions.
 */
export function storeFleetSecret(secret: string, version: number, env?: NodeJS.ProcessEnv): void {
    if (typeof secret !== 'string' || secret.length === 0) {
        throw new Error('storeFleetSecret requires a non-empty secret string');
    }
    if (!Number.isInteger(version) || version < 1) {
        throw new Error('storeFleetSecret requires an integer version >= 1');
    }
    const dir = getConfigDir(env);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const path = join(dir, FLEET_SECRET_FILE);
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ secret, version } satisfies StoredFleetSecret, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
    });
    try {
        renameSync(tmp, path);
    } catch (err) {
        // Rename failed — the new secret is NOT in place; remove the tmp file
        // so a later boot cannot pick up a stray partial write, then surface.
        try {
            unlinkSync(tmp);
        } catch {
            /* already gone */
        }
        throw err;
    }
    // renameSync does not carry the mode onto an already-existing destination
    // on every platform — assert 0600 on the final path too.
    try {
        chmodSync(path, 0o600);
    } catch {
        /* Windows etc. not supported */
    }
    // Deliberately logs version only — never the secret value.
    LOG.info('Seqscribe', `fleet secret stored (v${version})`);
}
