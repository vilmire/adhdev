/**
 * Arms `TranscriptProjectionService` against a REAL seqscribe node for the
 * keyed chat topic — design 2026-09-28 (message-keyed storage) §4.5, §4.8,
 * §4.10, §5.5.
 *
 * ★ This is the ONLY module that appends to a `session.<id>.chat` topic.
 * `check:transcript-write-shape` fails the build if a `.chat` append appears
 * anywhere else, or if this module imports a v1 whole-snapshot encoder — the
 * whole point of the keyed storage is that no code path can go back to
 * rewriting the transcript per change.
 *
 * Responsibilities:
 *   - `appendChatFrame` — append one frame's rows (parts, heads/tombstones,
 *     meta, then commit) with their keys, all issued before any await so a
 *     group commit usually lands them in one transaction and `seq` stays
 *     contiguous in issue order (seqscribe log.ts `push` → FIFO flush).
 *   - compaction — after a commit, `pruneSuperseded(topic, {uptoRowid: W})`
 *     with W = the commit's rowid, when enough superseded rows or bytes piled
 *     up or a bubble went final (§4.8). Never below W, so the last committed
 *     version of a key an in-flight frame replaced always survives (I4).
 *   - restart — `readPersistedChat` (newest-per-key at/below W plus the torn
 *     tail above it) for the publisher state, and a message identity ledger
 *     seed (`d.*` ids, ords, revs, adopted `srcId`s) so ids survive a restart.
 */

import type { JsonValue } from 'seqscribe';
import { LOG } from '../logging/logger.js';
import {
    setMessageIdentitySeedProvider,
    type MessageIdentitySeed,
    type MessageIdentitySeedEntry,
} from '../chat/message-identity-ledger.js';
import type { SeqscribeNodeHandle } from './node.js';
import { ensureSessionChatTopic } from './transcript-activation.js';
import {
    CHAT_COMMIT_KEY,
    CHAT_META_KEY,
    CHAT_MSG_KIND,
    CHAT_PART_KIND,
    readChatMeta,
    readChatMsg,
    readChatPart,
} from './transcript-keyed-codec.js';
import type { KeyedChatFrame, PersistedChatRow, PersistedChatState } from './transcript-keyed-frame.js';
import type { TranscriptObservation } from './transcript-observation.js';
import { scanAllLatestPerKey } from './transcript-parity-actual.js';
import { redactSessionId } from './transcript-parity.js';
import { MAX_TRACKED_SESSIONS } from './transcript-publisher.js';
import type { TranscriptTopicClaimRegistry } from './transcript-topic-claim.js';

// ─── Compaction (§4.8) ──────────────────────────────────────────────────────

/** Superseded rows that trigger a `pruneSuperseded` pass. */
export const CHAT_PRUNE_TRIGGER_ROWS = 64;
/** Superseded bytes that trigger a pass. */
export const CHAT_PRUNE_TRIGGER_BYTES = 1024 * 1024;
/** Rows per `pruneSuperseded` call — the same step bound writer-gc uses. */
export const CHAT_PRUNE_STEP_ROWS = 250;
/** Upper bound on steps per pass, so one pass can never monopolize the loop. */
const CHAT_PRUNE_MAX_STEPS = 200;

export interface TranscriptChatRuntimeCounters {
    /** `pruneSuperseded` passes started. */
    prunePasses: number;
    /** Rows deleted by those passes (`chatPrunedRows`). */
    prunedRows: number;
    pruneErrors: number;
    /** Ledger seeds built from the topic after a restart. */
    ledgerSeeds: number;
}

let runtimeCounters: TranscriptChatRuntimeCounters = freshRuntimeCounters();

function freshRuntimeCounters(): TranscriptChatRuntimeCounters {
    return { prunePasses: 0, prunedRows: 0, pruneErrors: 0, ledgerSeeds: 0 };
}

/** Local-only diagnostics (`adhdev status`). */
export function transcriptChatRuntimeCounters(): TranscriptChatRuntimeCounters {
    return { ...runtimeCounters };
}

/** TESTS ONLY. */
export function __resetTranscriptChatRuntimeForTests(): void {
    runtimeCounters = freshRuntimeCounters();
}

function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

// ─── Restart reads ──────────────────────────────────────────────────────────

function persistedRow(entry: { key?: string; kind: string; writer: string; payload: unknown }): PersistedChatRow | null {
    return typeof entry.key === 'string' ? { key: entry.key, kind: entry.kind, writer: entry.writer, payload: entry.payload } : null;
}

/**
 * What `topic` holds: newest-per-key rows at/below the last commit (W), and
 * the newest-per-key rows above it (a frame whose commit never landed).
 */
export function readPersistedChatTopic(node: SeqscribeNodeHandle, topic: string): PersistedChatState {
    const watermark = node.node.keyHead(topic, CHAT_COMMIT_KEY)?.rowid ?? null;
    const committed =
        watermark === null
            ? []
            : scanAllLatestPerKey(node, topic, { uptoRowid: watermark }).map(({ entry }) => persistedRow(entry));
    const torn = scanAllLatestPerKey(node, topic, { afterRowid: watermark ?? 0 }).map(({ entry }) => persistedRow(entry));
    return {
        committed: committed.filter((r): r is PersistedChatRow => r !== null),
        torn: torn.filter((r): r is PersistedChatRow => r !== null),
    };
}

/** The message identity ledger seed a persisted topic implies (§4.10). */
export function ledgerSeedFromPersisted(persisted: PersistedChatState): MessageIdentitySeed | null {
    let epoch = '';
    const parts = new Map<string, Map<number, string>>();
    const heads: { id: string; ord: string; rev: number; role: string; kind: string; body: unknown; srcId: string | null }[] = [];
    for (const row of persisted.committed) {
        if (row.key === CHAT_META_KEY) {
            epoch = readChatMeta(row.payload)?.ledgerEpoch ?? epoch;
        } else if (row.kind === CHAT_PART_KIND) {
            const part = readChatPart(row.payload);
            if (!part) continue;
            let map = parts.get(part.id);
            if (!map) parts.set(part.id, (map = new Map()));
            map.set(part.k, part.text);
        } else if (row.kind === CHAT_MSG_KIND) {
            const head = readChatMsg(row.payload);
            if (head) heads.push({ id: head.id, ord: head.ord, rev: head.rev, role: head.role, kind: head.kind, body: head.body, srcId: head.srcId });
        }
    }
    if (!epoch && heads.length === 0) return null;
    const entries: MessageIdentitySeedEntry[] = heads.map((h) => {
        const body = h.body as { text?: string; parts?: number };
        let text = typeof body.text === 'string' ? body.text : '';
        if (typeof body.parts === 'number') {
            const map = parts.get(h.id);
            text = '';
            for (let k = 0; k < body.parts; k += 1) text += map?.get(k) ?? '';
        }
        return { messageId: h.id, ord: h.ord, rev: h.rev, role: h.role, kind: h.kind, text, srcId: h.srcId };
    });
    return { epoch, entries };
}

// ─── The live publisher ─────────────────────────────────────────────────────

export interface LiveChatPublisher {
    appendChatFrame(sessionId: string, frame: KeyedChatFrame, observation: TranscriptObservation): Promise<void>;
    readPersistedChat(sessionId: string): PersistedChatState | null;
    /**
     * Claim + define + announce the session's topic without appending — the
     * projection's `activateSession` (first-paint warm-up). True when defined.
     */
    activateSession(sessionId: string): boolean;
    /** Registers the ledger seed provider; returns its disposer. */
    installLedgerSeed(): () => void;
}

interface PruneBacklog {
    rows: number;
    bytes: number;
    running: Promise<void> | null;
    supersedeOtherWriters: boolean;
}

/**
 * Build the `appendChatFrame`/`readPersistedChat` pair boot hands to
 * `configureTranscriptProjection`. `ownerDaemonId` is the same identity the
 * service's `daemonId()` reports.
 */
export function createLiveChatPublisher(
    node: SeqscribeNodeHandle,
    claims: TranscriptTopicClaimRegistry,
    ownerDaemonId: string,
): LiveChatPublisher {
    const backlog = new Map<string, PruneBacklog>();

    const activate = (sessionId: string): string | null => {
        const activation = ensureSessionChatTopic(node, claims, sessionId, ownerDaemonId);
        return activation.ok ? activation.topic : null;
    };

    const prune = async (topic: string, entry: PruneBacklog): Promise<void> => {
        const watermark = node.node.keyHead(topic, CHAT_COMMIT_KEY)?.rowid;
        if (watermark === undefined) return;
        const supersedeOtherWriters = entry.supersedeOtherWriters;
        entry.supersedeOtherWriters = false;
        runtimeCounters.prunePasses++;
        try {
            for (let step = 0; step < CHAT_PRUNE_MAX_STEPS; step += 1) {
                const { prunedRows } = await node.node.pruneSuperseded(topic, {
                    uptoRowid: watermark,
                    maxRows: CHAT_PRUNE_STEP_ROWS,
                    ...(supersedeOtherWriters ? { supersedeOtherWriters: true } : {}),
                });
                runtimeCounters.prunedRows += prunedRows;
                if (prunedRows < CHAT_PRUNE_STEP_ROWS) break;
                await yieldToEventLoop();
            }
        } catch (error) {
            runtimeCounters.pruneErrors++;
            LOG.warn('Seqscribe', `transcript chat prune failed topic=${topic}: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const scheduleCompaction = (topic: string, frame: KeyedChatFrame): void => {
        let entry = backlog.get(topic);
        if (!entry) {
            entry = { rows: 0, bytes: 0, running: null, supersedeOtherWriters: false };
            backlog.set(topic, entry);
            while (backlog.size > MAX_TRACKED_SESSIONS) backlog.delete(backlog.keys().next().value as string);
        }
        entry.rows += frame.supersededRows;
        entry.bytes += frame.supersededBytes;
        if (frame.commit.baseReason === 'writer_change') entry.supersedeOtherWriters = true;
        const due =
            entry.rows >= CHAT_PRUNE_TRIGGER_ROWS ||
            entry.bytes >= CHAT_PRUNE_TRIGGER_BYTES ||
            frame.finalized ||
            entry.supersedeOtherWriters;
        if (!due || entry.running) return;
        entry.rows = 0;
        entry.bytes = 0;
        const owned = entry;
        owned.running = prune(topic, owned).finally(() => {
            owned.running = null;
        });
    };

    return {
        async appendChatFrame(sessionId: string, frame: KeyedChatFrame): Promise<void> {
            const topic = activate(sessionId);
            if (!topic) throw new Error(`transcript chat topic unavailable session=${redactSessionId(sessionId)}`);
            const log = node.node.log(topic);
            // Issue every append before awaiting any: order comes from ISSUE
            // order (the log's FIFO queue assigns `seq` sequentially), so the
            // commit is always the frame's last row, and a group commit usually
            // lands the frame in one transaction (a failed flush rolls back the
            // whole batch — never a commit without its rows).
            const appends: Promise<unknown>[] = frame.rows.map((row) =>
                log.append(row.kind, row.payload as JsonValue, { key: row.key }),
            );
            await Promise.all(appends);
            scheduleCompaction(topic, frame);
        },

        activateSession(sessionId: string): boolean {
            return activate(sessionId) !== null;
        },

        readPersistedChat(sessionId: string): PersistedChatState | null {
            const topic = activate(sessionId);
            if (!topic) return null;
            return readPersistedChatTopic(node, topic);
        },

        installLedgerSeed(): () => void {
            setMessageIdentitySeedProvider((sessionKey) => {
                // Ledger keys fall back to `provider:<type>` when a read has no
                // session id — there is no topic to rebuild those from.
                if (!sessionKey || sessionKey.startsWith('provider:')) return null;
                const topic = activate(sessionKey);
                if (!topic) return null;
                const seed = ledgerSeedFromPersisted(readPersistedChatTopic(node, topic));
                if (seed) runtimeCounters.ledgerSeeds++;
                return seed;
            });
            return () => setMessageIdentitySeedProvider(null);
        },
    };
}
