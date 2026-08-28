/**
 * seqscribe node lifecycle — one node per daemon process.
 *
 * Phase 0/1 of the seqscribe integration (design §1.2, §1.4). This owns the DB
 * handle, the writerId, the topic definitions, the authority wiring, and
 * shutdown. The fleet secret resolves env-var-first, then the auth_ok-persisted
 * store (fleet-secret.ts); with NO secret the node runs metadata-topics-only —
 * content topics require the secret (env or auth_ok-delivered) because their
 * policies name `finalityAuthority`, which the library refuses to define
 * without `verifyFinality`. Producers and consumers arrive via journal.ts and
 * later phases.
 *
 * ── Single-process ownership is not advisory ───────────────────────────────
 * Two processes on one seqscribe DB is corruption, not degraded mode
 * (host-guide §1). The better-sqlite3 adapter enforces this with `BEGIN
 * EXCLUSIVE` on a sibling `.lock` database — an OS-level lock that dies with
 * the process, so a crashed owner never wedges the DB. We therefore open a
 * SECOND connection purely to hold that lock. The lock is taken by the library
 * itself inside `createSeqscribe` (`Store.init`), not by us — see the note at
 * the acquire site for why calling `acquireOwnerLock()` here would break every
 * successful open. A second daemon on the same file fails to open and is
 * rejected rather than racing the first.
 */

import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import type BetterSqlite3 from 'better-sqlite3';
import type { Constants, SeqscribeNodeExt, SqliteHandle } from 'seqscribe';
import { betterSqlite3Handle, createSeqscribe, loadOrCreateWriterId } from 'seqscribe';
import { getConfigDir } from '../config/config.js';
import { LOG } from '../logging/logger.js';
import { loadBetterSqlite3 } from '../system/load-better-sqlite3.js';
import { createFleetAuthorityIfConfigured, startFleetFinalityLoop } from './authority.js';
import { loadStoredFleetSecret } from './fleet-secret.js';
import { baseTopicDefinitions, contentTopicsFor, type TopicDefinition } from './topics.js';

/** DB file name under the config dir (design §6.2 inventory). */
export const SEQSCRIBE_DB_NAME = 'seqscribe.db';

/**
 * writerId prefix (design D3). Deliberately NOT the daemonId: writerIds are
 * charter-restricted, are permanently sealed on retirement, and must be
 * re-issued when a machine is cloned. Reusing daemonId would couple identity
 * rotation to machine identity and manufacture a fork on any DB restore.
 */
export const WRITER_ID_PREFIX = 'adhdev';

export function getSeqscribeDbPath(): string {
    return join(getConfigDir(), SEQSCRIBE_DB_NAME);
}

export interface SeqscribeNodeOptions {
    /** Mesh ids to define event topics for. */
    meshIds?: readonly string[];
    /** Daemon id, exposed alongside writerId for operator correlation (D3). */
    daemonId?: string;
    /** Whether this daemon holds the coordinator/authority role (design D4). */
    isCoordinator?: boolean;
    /** Override the DB path — tests pass a tmp dir. */
    dbPath?: string;
    env?: NodeJS.ProcessEnv;
    /**
     * The fleet secret as persisted by the `auth_ok` path
     * (seqscribe/fleet-secret.ts). `undefined` = load from disk;
     * an explicit `null` = "known absent" (tests pin provisional mode without
     * touching the filesystem). The env var still wins over either — see
     * resolveFleetSecret in authority.ts.
     */
    storedFleetSecret?: string | null;
    /**
     * Library constants override (seqscribe `Constants`). TESTS ONLY — e.g. a
     * short FINALITY_WINDOW_MS. Production callers never set this: the defaults
     * are fleet-wide schema-adjacent tuning, not per-node preferences.
     */
    constants?: Partial<Constants>;
    /**
     * Finality issuance loop interval override. TESTS ONLY — the 1h default
     * (authority.ts `FINALITY_INTERVAL_MS`) is a fleet-wide cadence, and
     * production callers never set this; a short interval lets a test certify
     * finality on a human timescale. Ignored unless `isCoordinator` and an
     * authority is configured.
     */
    finalityIntervalMs?: number;
}

export interface SeqscribeNodeHandle {
    node: SeqscribeNodeExt;
    writerId: string;
    daemonId: string | null;
    dbPath: string;
    topics: TopicDefinition[];
    /** True when a fleet secret was configured and certificates can be verified. */
    authorityEnabled: boolean;
    /** Non-null only on the coordinator with an authority configured. */
    finalityLoop: { stop(): void } | null;
    /**
     * Register a teardown callback to run inside `close()`, BEFORE `node.close()`.
     *
     * Exists for the Beacon transport (seqscribe/beacon.ts), which is armed
     * later than node open — the cloud host has to hand it a WS transport that
     * does not exist yet at this point — and must still be stopped when the node
     * goes down, whoever initiates that. Without this the beacon would be torn
     * down only on the paths that happen to hold its handle, and a `close()`
     * from anywhere else would leave it armed against a closing node.
     *
     * ★ Ordering matters: these run before `node.close()`, so a stop callback may
     * still touch the node. Callbacks are one-shot and a throwing one is
     * swallowed — a teardown hook must never be able to block node shutdown.
     */
    onClose(fn: () => void): void;
    close(): Promise<void>;
}

/**
 * Open the daemon's seqscribe node.
 *
 * Throws only for genuinely unrecoverable conditions (no better-sqlite3, DB
 * unopenable). Callers treat a throw as "seqscribe unavailable" and continue —
 * Phase 0 has no consumer that depends on it, and later phases run behind
 * shadow/primary flags precisely so this stays non-fatal.
 */
export function openSeqscribeNode(opts: SeqscribeNodeOptions = {}): SeqscribeNodeHandle {
    const dbPath = opts.dbPath ?? getSeqscribeDbPath();
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

    const Database = loadBetterSqlite3();
    const db = new Database(dbPath) as BetterSqlite3.Database;
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');

    // Sibling lock DB: a separate connection whose BEGIN EXCLUSIVE is the
    // cross-process owner lock. Kept in its own file so the lock transaction
    // never blocks real writes on the data DB.
    let lockDb: BetterSqlite3.Database | null = null;
    try {
        lockDb = new Database(`${dbPath}.lock`) as BetterSqlite3.Database;
    } catch (err) {
        LOG.warn(
            'Seqscribe',
            `owner lock unavailable (${err instanceof Error ? err.message : String(err)}); continuing without cross-process lock`,
        );
    }

    const storage: SqliteHandle = betterSqlite3Handle(db, lockDb ?? undefined);

    const closeHandles = (): void => {
        try {
            lockDb?.close();
        } catch {
            /* already gone */
        }
        try {
            db.close();
        } catch {
            /* already gone */
        }
    };

    // NOTE: do NOT call `storage.acquireOwnerLock()` here. `Store.init` — which
    // runs inside `createSeqscribe` below — acquires it itself, and the adapter
    // tracks ownership with an in-process flag that makes a second acquire throw
    // `DB already owned by this process`. Taking it early turns every successful
    // open into a spurious ownership error.
    //
    // `loadOrCreateWriterId` therefore runs BEFORE the lock exists. That is safe:
    // it only touches its own `sq_meta` row, and a genuine second owner is still
    // rejected a moment later when Store.init fails to take the file lock.
    const writerId = loadOrCreateWriterId(storage, { prefix: WRITER_ID_PREFIX });

    // Authority hooks are needed on EVERY node (verification), not just the
    // coordinator (issuance). Absent secret = provisional-only operation.
    // `undefined` storedFleetSecret means "read the auth_ok-persisted store";
    // an explicit value (null included) is the caller's pinned answer.
    const storedSecret =
        opts.storedFleetSecret !== undefined
            ? opts.storedFleetSecret
            : loadStoredFleetSecret(opts.env ?? process.env)?.secret ?? null;
    const authority = createFleetAuthorityIfConfigured(opts.env ?? process.env, storedSecret);

    let node: SeqscribeNodeExt;
    try {
        node = createSeqscribe({
            writerId,
            storage,
            ...(authority ? { authority: authority.hooks } : {}),
            ...(opts.constants ? { constants: opts.constants } : {}),
        });
    } catch (err) {
        // ERR_DB_OWNED means another process holds the file lock. Proceeding
        // would be the corruption host-guide §1 forbids, so release what we
        // opened and surface it as a plain, greppable message.
        closeHandles();
        const message = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: string } | null)?.code;
        if (code === 'ERR_DB_OWNED') {
            throw new Error(`seqscribe DB is owned by another process: ${message}`);
        }
        throw err;
    }

    // Without a fleet secret the node runs METADATA-TOPICS-ONLY. defineTopic
    // throws on ANY policy that sets `finalityAuthority` when verifyFinality is
    // absent — and since Phase 1 all three content topics name the authority
    // (topics.ts), that filter subsumes the old `owned`-register skip
    // (`config.settings` has both). Metadata topics (mesh events, fleet status)
    // stay defined and keep syncing in provisional mode; content topics require
    // the secret, env-delivered or auth_ok-delivered.
    const allDefs = baseTopicDefinitions(opts.meshIds ?? []);
    const defs = authority ? allDefs : allDefs.filter((d) => d.policy.finalityAuthority === undefined);
    if (!authority) {
        LOG.info(
            'Seqscribe',
            'no fleet secret configured — running metadata-topics-only; content topics require the fleet secret (env or auth_ok-delivered)',
        );
    }

    for (const def of defs) {
        node.defineTopic(def.topic, def.policy);
    }

    // Issuance is coordinator-only: two hosts signing under one authority id
    // race their generation counters and the fleet rejects both as bad_cert.
    const finalityLoop =
        opts.isCoordinator && authority
            ? startFleetFinalityLoop(node, {
                  topics: contentTopicsFor(defs),
                  authority: authority.authority,
                  intervalMs: opts.finalityIntervalMs,
              })
            : null;

    // Anomaly logging (library P22/P24). Without this the replication signals
    // exist only inside the library and a host mid-incident cannot see them.
    //
    // The `Anomaly` payload is `{ kind, entry? }` — the library carries no peer
    // or topic detail on the sync signals, so the log line is the kind plus the
    // node-level context we already hold. `entry` is deliberately NOT logged:
    // it is a LogEntry and its payload is user/agent content.
    //
    // Severity split: `sync_hot` is informational by the library's own
    // definition (bulk catch-up is normal and it never throttles), but it is
    // logged at WARN because it only fires at ≥32 MiB in 60s — at that volume a
    // host reading the log wants to see it next to `sync_stalled` rather than
    // buried in INFO. `sync_stalled` is the actionable one.
    let unsubAnomaly: (() => void) | null = null;
    try {
        unsubAnomaly = node.onAnomaly((anomaly) => {
            try {
                if (anomaly.kind === 'sync_stalled') {
                    LOG.warn(
                        'Seqscribe',
                        `sync stalled writer=${writerId} — WANT rounds toward a peer stopped progressing; ` +
                            'check get_status_metadata seqscribe.stalledStreams / applyRejects',
                    );
                } else if (anomaly.kind === 'sync_hot') {
                    LOG.warn(
                        'Seqscribe',
                        `sync hot writer=${writerId} — bulk sync traffic crossed the rate window ` +
                            '(informational, not throttled); see seqscribe.syncHotspots in get_status_metadata',
                    );
                } else {
                    LOG.warn('Seqscribe', `anomaly kind=${anomaly.kind} writer=${writerId}`);
                }
            } catch {
                /* a logging failure must never propagate into the library */
            }
        });
    } catch (err) {
        LOG.warn(
            'Seqscribe',
            `anomaly subscription failed: ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    LOG.info(
        'Seqscribe',
        `node open writer=${writerId} topics=${defs.length} authority=${authority ? 'on' : 'off'}${opts.isCoordinator ? ' role=coordinator' : ''}`,
    );

    // Teardown callbacks registered after open (currently: the Beacon transport).
    const closeCallbacks: (() => void)[] = [];

    let closed = false;
    const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        // Before finality/anomaly teardown and before node.close(), so a
        // callback may still use the node (the beacon's stop() calls into it).
        while (closeCallbacks.length > 0) {
            const fn = closeCallbacks.shift()!;
            try {
                fn();
            } catch (err) {
                LOG.warn(
                    'Seqscribe',
                    `close callback failed: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
        try {
            finalityLoop?.stop();
        } catch {
            /* noop */
        }
        try {
            unsubAnomaly?.();
        } catch {
            /* noop */
        }
        // Order matters: close the node (flushes and detaches peers) before
        // releasing the lock and the connections underneath it.
        try {
            await node.close();
        } catch (err) {
            LOG.warn(
                'Seqscribe',
                `node close failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        try {
            storage.releaseOwnerLock();
        } catch {
            /* noop */
        }
        closeHandles();
    };

    return {
        node,
        writerId,
        daemonId: opts.daemonId ?? null,
        dbPath,
        topics: defs,
        authorityEnabled: authority !== null,
        finalityLoop,
        onClose: (fn: () => void) => {
            // A callback registered after close() has already run would never
            // fire, so run it immediately rather than silently dropping it.
            if (closed) {
                try {
                    fn();
                } catch {
                    /* noop */
                }
                return;
            }
            closeCallbacks.push(fn);
        },
        close,
    };
}
