/**
 * Mesh peer-secret store — per-peer HMAC keys for the standalone multi-machine
 * mesh (design: docs/design/2026-10-07-standalone-multi-machine-mesh.md §4.4
 * step 3).
 *
 * One record per (meshId, peerDaemonId). The host keeps a `role: 'host'`
 * record for every member it admitted; a member keeps a `role: 'member'`
 * record for the host it joined, plus `hostAddress` (where to dial). The
 * secret is 32 random bytes, base64, minted by the host at join time and
 * handed to the member exactly once in the join response.
 *
 * ── Deliberately NOT meshes.json ────────────────────────────────────────────
 * The mesh registry is a plain settings file that dashboards read and that
 * replication / export passes may carry. Secrets live in their own 0600
 * file with their own lifecycle, exactly like seqscribe/fleet-secret.ts and
 * local-authority.ts, so no "export my config" can ever carry them.
 *
 * ── Secret hygiene ──────────────────────────────────────────────────────────
 * The secret VALUE is never logged — not on success, not on failure, not
 * truncated. Change notifications carry (meshId, peerDaemonId, role) only.
 * A missing file is the normal pre-pairing state; a corrupt one is logged
 * ONCE (without contents) and treated as empty: an unreadable store must
 * degrade to "no peers paired", never wedge boot. Written atomically (tmp +
 * rename) at mode 0600 inside the 0700 config dir.
 *
 * Peer ids are stored and matched in canonical form (`canonicalDaemonId`) so
 * a `mach_X` / `daemon_mach_X` / `standalone_mach_X` lookup all hit the same
 * record — the CANON-IDENTITY class of bug (raw-form id comparison) must not
 * be reintroduced on the pairing path.
 */

import { randomBytes } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { canonicalDaemonId } from '@adhdev/mesh-shared';
import { getConfigDir } from '../../config/config.js';
import { LOG } from '../../logging/logger.js';

/** Credentials file name under the config dir. NOT meshes.json — see header. */
export const MESH_PEER_SECRETS_FILE = 'mesh-peer-secrets.json';

/** Current on-disk schema version. */
export const MESH_PEER_SECRETS_SCHEMA_VERSION = 1;

/** Which side of the pairing this record describes, from the LOCAL daemon's point of view. */
export type PeerSecretRole = 'host' | 'member';

export interface PeerSecretRecord {
    meshId: string;
    /** Always stored in canonical form (`canonicalDaemonId`). */
    peerDaemonId: string;
    role: PeerSecretRole;
    /** 32 random bytes, base64. Never logged. */
    secret: string;
    /** Member side only: `host:port` (or URL) the member dials to reach the host. */
    hostAddress?: string;
    /** ISO timestamp of when the record was first stored locally. */
    createdAt: string;
}

/**
 * Test / embedding seam. `filePath` wins over `env`; `env` is passed through
 * to `getConfigDir` (tests pin ADHDEV_CONFIG_DIR per tmp dir). With neither,
 * the live config dir is used.
 */
export interface PeerSecretStoreOptions {
    env?: NodeJS.ProcessEnv;
    filePath?: string;
}

/** What listeners receive. Deliberately carries no secret value. */
export interface PeerSecretsChange {
    kind: 'put' | 'remove';
    meshId: string;
    /** Canonical form. */
    peerDaemonId: string;
    role?: PeerSecretRole;
    /** The store file that changed, so multi-store tests / embeddings can filter. */
    filePath: string;
}

export type PeerSecretsListener = (change: PeerSecretsChange) => void;

interface StoredPeerSecretsFile {
    version: number;
    records: PeerSecretRecord[];
}

const listeners = new Set<PeerSecretsListener>();

/** Paths whose corrupt/unreadable state has already been warned about (warn once per path). */
const warnedPaths = new Set<string>();

export function resolvePeerSecretsPath(opts: PeerSecretStoreOptions = {}): string {
    if (opts.filePath && opts.filePath.trim()) return opts.filePath.trim();
    return join(getConfigDir(opts.env), MESH_PEER_SECRETS_FILE);
}

/** 32 random bytes, base64 — the shared HMAC key for one (mesh, peer) pair. */
export function mintPeerSecret(): string {
    return randomBytes(32).toString('base64');
}

function canonicalOrThrow(id: string, what: string): string {
    const canonical = canonicalDaemonId(id);
    if (!canonical) throw new Error(`${what} requires a non-empty peerDaemonId`);
    return canonical;
}

function isValidRecord(value: unknown): value is PeerSecretRecord {
    if (value === null || typeof value !== 'object') return false;
    const rec = value as Record<string, unknown>;
    if (typeof rec.meshId !== 'string' || rec.meshId.trim() === '') return false;
    if (typeof rec.peerDaemonId !== 'string' || !canonicalDaemonId(rec.peerDaemonId)) return false;
    if (rec.role !== 'host' && rec.role !== 'member') return false;
    if (typeof rec.secret !== 'string' || rec.secret.length === 0) return false;
    if (rec.hostAddress !== undefined && typeof rec.hostAddress !== 'string') return false;
    if (typeof rec.createdAt !== 'string' || rec.createdAt.trim() === '') return false;
    return true;
}

function normalizeRecord(rec: PeerSecretRecord): PeerSecretRecord {
    const out: PeerSecretRecord = {
        meshId: rec.meshId.trim(),
        peerDaemonId: canonicalOrThrow(rec.peerDaemonId, 'peer secret record'),
        role: rec.role,
        secret: rec.secret,
        createdAt: rec.createdAt,
    };
    if (rec.hostAddress !== undefined && rec.hostAddress.trim() !== '') {
        out.hostAddress = rec.hostAddress.trim();
    }
    return out;
}

function warnOnce(path: string, message: string): void {
    if (warnedPaths.has(path)) return;
    warnedPaths.add(path);
    LOG.warn('MeshPeerSecrets', message);
}

/**
 * Read every record. NEVER throws and never logs file contents: a missing
 * file is the normal pre-pairing state; an unreadable or malformed one is
 * warned about once and treated as empty. Individual malformed records are
 * dropped (and counted in the warning) while the valid ones are kept.
 */
function readRecords(path: string): PeerSecretRecord[] {
    if (!existsSync(path)) return [];
    let raw: string;
    try {
        raw = readFileSync(path, 'utf-8');
    } catch (err) {
        warnOnce(path, `peer secrets file unreadable (${err instanceof Error ? err.message : String(err)}); treating as empty`);
        return [];
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // Never log `raw`: the file is a credentials store and a malformed one
        // may still contain secrets in a shifted shape.
        warnOnce(path, 'peer secrets file is malformed JSON; treating as empty');
        return [];
    }
    const records = parsed !== null && typeof parsed === 'object'
        ? (parsed as Partial<StoredPeerSecretsFile>).records
        : undefined;
    if (!Array.isArray(records)) {
        warnOnce(path, 'peer secrets file has an unexpected shape; treating as empty');
        return [];
    }
    const valid: PeerSecretRecord[] = [];
    let dropped = 0;
    for (const entry of records) {
        if (isValidRecord(entry)) valid.push(normalizeRecord(entry));
        else dropped += 1;
    }
    if (dropped > 0) {
        warnOnce(path, `peer secrets file contains ${dropped} malformed record(s); ignoring them`);
    }
    return valid;
}

/**
 * Atomic 0600 write: tmp file + rename + defensive re-chmod (rename does not
 * carry the mode onto an existing destination on every platform). Same shape
 * as fleet-secret.ts / local-authority.ts.
 */
function writeRecords(path: string, records: PeerSecretRecord[]): void {
    const dir = dirname(path);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const body: StoredPeerSecretsFile = { version: MESH_PEER_SECRETS_SCHEMA_VERSION, records };
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(body, null, 2), { encoding: 'utf-8', mode: 0o600 });
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
}

function emit(change: PeerSecretsChange): void {
    for (const listener of Array.from(listeners)) {
        try {
            listener(change);
        } catch (err) {
            LOG.warn(
                'MeshPeerSecrets',
                `change listener threw (${err instanceof Error ? err.message : String(err)})`,
            );
        }
    }
}

/** Every stored record (copies — mutating the result never touches the store). */
export function listPeerSecrets(opts: PeerSecretStoreOptions = {}): PeerSecretRecord[] {
    return readRecords(resolvePeerSecretsPath(opts)).map((rec) => ({ ...rec }));
}

/** Lookup by (meshId, peerDaemonId) — the id is matched in canonical form. */
export function getPeerSecret(
    meshId: string,
    peerDaemonId: string,
    opts: PeerSecretStoreOptions = {},
): PeerSecretRecord | null {
    const canonical = canonicalDaemonId(peerDaemonId);
    const mesh = typeof meshId === 'string' ? meshId.trim() : '';
    if (!canonical || !mesh) return null;
    const found = readRecords(resolvePeerSecretsPath(opts))
        .find((rec) => rec.meshId === mesh && rec.peerDaemonId === canonical);
    return found ? { ...found } : null;
}

/**
 * Insert or replace the record for (meshId, peerDaemonId). Validates its
 * input and THROWS on a bad record — the caller (the pairing command) owns
 * validating what it was handed, and silently dropping a secret would leave
 * the peer un-dialable with no signal why.
 */
export function putPeerSecret(record: PeerSecretRecord, opts: PeerSecretStoreOptions = {}): void {
    if (!isValidRecord(record)) {
        throw new Error('putPeerSecret requires { meshId, peerDaemonId, role, secret, createdAt } with non-empty strings');
    }
    const normalized = normalizeRecord(record);
    const path = resolvePeerSecretsPath(opts);
    const others = readRecords(path)
        .filter((rec) => !(rec.meshId === normalized.meshId && rec.peerDaemonId === normalized.peerDaemonId));
    writeRecords(path, [...others, normalized]);
    emit({
        kind: 'put',
        meshId: normalized.meshId,
        peerDaemonId: normalized.peerDaemonId,
        role: normalized.role,
        filePath: path,
    });
}

/** Remove the record for (meshId, peerDaemonId). Returns whether one existed. */
export function removePeerSecret(
    meshId: string,
    peerDaemonId: string,
    opts: PeerSecretStoreOptions = {},
): boolean {
    const canonical = canonicalDaemonId(peerDaemonId);
    const mesh = typeof meshId === 'string' ? meshId.trim() : '';
    if (!canonical || !mesh) return false;
    const path = resolvePeerSecretsPath(opts);
    const all = readRecords(path);
    const removed = all.find((rec) => rec.meshId === mesh && rec.peerDaemonId === canonical);
    if (!removed) return false;
    const kept = all.filter((rec) => !(rec.meshId === mesh && rec.peerDaemonId === canonical));
    writeRecords(path, kept);
    emit({ kind: 'remove', meshId: mesh, peerDaemonId: canonical, role: removed.role, filePath: path });
    return true;
}

/**
 * In-process change notifications after every successful put/remove.
 * Returns the unsubscribe function. Listeners never receive secret values.
 */
export function onPeerSecretsChanged(listener: PeerSecretsListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Test seam: forget "already warned" state so corrupt-file warnings fire again. */
export function resetPeerSecretsWarningsForTest(): void {
    warnedPaths.clear();
}
