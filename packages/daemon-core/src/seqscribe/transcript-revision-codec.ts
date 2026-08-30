/**
 * `session.<safeSessionId>.transcript` complete-revision envelope (design §3.3).
 *
 * A snapshot is never carried in one seqscribe entry: the library caps a
 * single entry at `MAX_ENTRY_BYTES` (65,536 bytes, measured over JCS bytes —
 * `oss/vendor/seqscribe/src/constants.ts`), and a live transcript snapshot can
 * exceed that. So a snapshot becomes a host-level transaction-like envelope of
 * THREE seqscribe `LogEntry.kind`s appended in order by the single current
 * owner writer:
 *
 *   1. `transcript.revision.begin.v1`  — identity + expected chunk/byte/hash
 *   2. `transcript.revision.chunk.v1`  × N — base64 UTF-8 slices, indexed
 *   3. `transcript.revision.commit.v1` — identity/chunk/byte/hash repeated
 *
 * `encodeTranscriptRevision` is the producer half (splits + hashes).
 * `TranscriptRevisionAssembler` is the subscriber half (reassembles +
 * verifies, fail-closed on any mismatch). Both sides are pure/synchronous —
 * neither touches a seqscribe node — because this unit is the CODEC contract
 * only; wiring an assembler instance to a live SUB/`scanEntries` subscription
 * and an encoder call to a live `append` is §8 unit 3
 * ("dynamic transcript activation + daemon replica store").
 *
 * ── Portable on purpose: no `Buffer` ────────────────────────────────────────
 * §8 unit 5 ("web chat pane consumer cutover") reuses THIS module inside a
 * browser module worker (`oss/packages/web-core/src/transcript-transport`),
 * which has no Node `Buffer` global. Byte handling below therefore uses
 * `Uint8Array`/`TextEncoder`/`TextDecoder` and the local `bytesToBase64`/
 * `base64ToBytes` helpers — never `Buffer` — so the exact same compiled output
 * runs under Node (daemon/mcp-server/server) and an evergreen browser Worker
 * with byte-identical results. `atob`/`btoa` are global in both runtimes
 * (Node 18+, every evergreen browser).
 *
 * ── Ring is not durable — begin/commit is host visibility, not finality ────
 * `session.*.transcript` is a `ring` topic, explicitly exempt from seqscribe
 * finality/archive/durable-snapshot guarantees (SPEC.md §"ring exemption";
 * design §3.2). begin/commit does NOT reimplement durability — it exists so a
 * subscriber never treats a producer crash mid-revision (a still-valid partial
 * multi-append on a non-atomic ring) as a complete, displayable snapshot. The
 * assembler discards an incomplete/invalid in-flight revision and keeps
 * serving the last verified complete one.
 */

import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { jcs, sha256HexUtf8, type JsonValue } from 'seqscribe';
import type { ReplicatedTranscriptSnapshotV1 } from './transcript-projection.js';

// ─── Constants ───────────────────────────────────────────────────────────

export const TRANSCRIPT_REVISION_BEGIN_KIND = 'transcript.revision.begin.v1';
export const TRANSCRIPT_REVISION_CHUNK_KIND = 'transcript.revision.chunk.v1';
export const TRANSCRIPT_REVISION_COMMIT_KIND = 'transcript.revision.commit.v1';

/** UTF-8 byte size of one chunk payload's `dataBase64`-decoded slice. */
export const TRANSCRIPT_REVISION_CHUNK_BYTES = 36 * 1024;

/**
 * Ring rows a complete revision may occupy, begin+commit included (design
 * §3.3). 500-entry ring / 240 rows leaves room for the previous complete
 * revision (240 rows) AND the next in-flight one (240 rows) simultaneously,
 * with 20 rows of margin — see the "two generations" test in the suite for
 * this file, which pins that arithmetic.
 */
export const MAX_TRANSCRIPT_REVISION_ROWS = 240;

/** `MAX_TRANSCRIPT_REVISION_ROWS` minus the begin and commit rows. */
export const MAX_TRANSCRIPT_REVISION_CHUNKS = MAX_TRANSCRIPT_REVISION_ROWS - 2;

// ─── Portable byte/base64 helpers (no `Buffer`) ─────────────────────────────

/** `Uint8Array` → base64, via a binary string — safe under Node and browsers. */
function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    return btoa(binary);
}

/** base64 → `Uint8Array`. Throws (caller catches) on non-base64 input. */
function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

// ─── Wire envelope shapes ────────────────────────────────────────────────

export interface TranscriptRevisionIdentity {
    readonly sessionId: string;
    readonly producerDaemonId: string;
    readonly producerWriterId: string;
    readonly producerEpoch: string;
    readonly revision: number;
}

export interface TranscriptRevisionBeginV1 extends TranscriptRevisionIdentity {
    readonly v: 1;
    readonly snapshotBytes: number;
    readonly chunks: number;
    readonly snapshotSha256: string;
    readonly observedAt: string;
}

export interface TranscriptRevisionChunkV1 {
    readonly v: 1;
    readonly sessionId: string;
    readonly producerEpoch: string;
    readonly revision: number;
    readonly index: number;
    readonly chunks: number;
    readonly dataBase64: string;
}

export interface TranscriptRevisionCommitV1 extends TranscriptRevisionIdentity {
    readonly v: 1;
    readonly snapshotBytes: number;
    readonly chunks: number;
    readonly snapshotSha256: string;
    readonly committedAt: string;
}

// ─── Producer: encode a snapshot into begin/chunk*/commit ──────────────────

export type TranscriptRevisionEncodeResult =
    | {
          readonly ok: true;
          readonly begin: TranscriptRevisionBeginV1;
          readonly chunks: readonly TranscriptRevisionChunkV1[];
          readonly commit: TranscriptRevisionCommitV1;
      }
    | {
          readonly ok: false;
          readonly reason: 'projection_oversize';
          readonly chunkCount: number;
          readonly snapshotBytes: number;
      };

/**
 * Split `snapshot` into a begin/chunks/commit envelope set.
 *
 * Oversize (> `MAX_TRANSCRIPT_REVISION_CHUNKS` chunks, ~8.3 MiB of
 * uncompressed JSON) is NOT silently truncated — the owner-confirmed policy
 * (design §7.2 item 3 / §9 confirmation 3) is: no content-loss truncation, the
 * caller (§8 unit 2's publisher) must treat this as `projection_oversize` and
 * fall back the whole call to legacy `read_chat`.
 */
export function encodeTranscriptRevision(
    snapshot: ReplicatedTranscriptSnapshotV1,
    identity: TranscriptRevisionIdentity,
    now: () => string = () => new Date().toISOString(),
): TranscriptRevisionEncodeResult {
    const json = jcs(snapshot as unknown as JsonValue);
    const bytes = new TextEncoder().encode(json);
    const snapshotSha256 = sha256HexUtf8(json);
    const chunkCount = Math.max(1, Math.ceil(bytes.length / TRANSCRIPT_REVISION_CHUNK_BYTES));

    if (chunkCount > MAX_TRANSCRIPT_REVISION_CHUNKS) {
        return { ok: false, reason: 'projection_oversize', chunkCount, snapshotBytes: bytes.length };
    }

    const begin: TranscriptRevisionBeginV1 = {
        v: 1,
        ...identity,
        snapshotBytes: bytes.length,
        chunks: chunkCount,
        snapshotSha256,
        observedAt: now(),
    };

    const chunks: TranscriptRevisionChunkV1[] = [];
    for (let index = 0; index < chunkCount; index++) {
        const start = index * TRANSCRIPT_REVISION_CHUNK_BYTES;
        const slice = bytes.subarray(start, start + TRANSCRIPT_REVISION_CHUNK_BYTES);
        chunks.push({
            v: 1,
            sessionId: identity.sessionId,
            producerEpoch: identity.producerEpoch,
            revision: identity.revision,
            index,
            chunks: chunkCount,
            dataBase64: bytesToBase64(slice),
        });
    }

    const commit: TranscriptRevisionCommitV1 = {
        v: 1,
        ...identity,
        snapshotBytes: bytes.length,
        chunks: chunkCount,
        snapshotSha256,
        committedAt: now(),
    };

    return { ok: true, begin, chunks, commit };
}

// ─── Subscriber: reassemble + verify ────────────────────────────────────────

/**
 * One row as the subscriber's SUB/`scanEntries` projection presents it. The
 * assembler reads only `writer`/`seq`/`kind`/`payload` — the same projection
 * SUB rows already carry — so it never needs the full `LogEntry`.
 */
export interface TranscriptRevisionRow {
    readonly writer: string;
    readonly seq: number;
    readonly kind: string;
    readonly payload: unknown;
}

export type TranscriptRevisionRejectReason =
    | 'wrong_writer'
    | 'wrong_session'
    | 'wrong_owner'
    | 'schema_version_unsupported'
    | 'chunk_without_begin'
    | 'commit_without_begin'
    | 'chunk_index_out_of_range'
    | 'duplicate_chunk_index'
    | 'missing_chunk'
    | 'chunk_count_mismatch'
    | 'byte_count_mismatch'
    | 'invalid_base64'
    | 'invalid_utf8'
    | 'invalid_json'
    | 'hash_mismatch'
    | 'revision_identity_mismatch';

export type TranscriptRevisionIngestResult =
    | { readonly status: 'begin_accepted' }
    | { readonly status: 'chunk_accepted' }
    | {
          readonly status: 'complete';
          readonly snapshot: ReplicatedTranscriptSnapshotV1;
          readonly identity: TranscriptRevisionIdentity;
      }
    | { readonly status: 'rejected'; readonly reason: TranscriptRevisionRejectReason };

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

interface InFlightRevision {
    identity: TranscriptRevisionIdentity;
    totalChunks: number;
    snapshotBytes: number;
    snapshotSha256: string;
    chunkBuffers: Map<number, Uint8Array>;
}

/**
 * Reassembles begin/chunk/commit rows for ONE `(ownerDaemonId, rawSessionId)`
 * key into verified complete snapshots, discarding anything partial or
 * inconsistent. One instance per subscribed session — this is the "assembler"
 * §3.7 says the `TranscriptReplicaStore` owns per key.
 *
 * `expectedOwnerWriterId`, when supplied, gates EVERY row (begin, chunk, and
 * commit alike) — "다른 writer가 끼면 owner/writer gate가 그 revision을 거부한다"
 * (design §3.3). Passing it undefined is only for tests that want to exercise
 * the codec in isolation from routing/ownership.
 */
export class TranscriptRevisionAssembler {
    private inFlight: InFlightRevision | null = null;
    private complete: { snapshot: ReplicatedTranscriptSnapshotV1; identity: TranscriptRevisionIdentity } | null =
        null;

    constructor(private readonly expectedOwnerWriterId?: string) {}

    /** The last verified complete revision, or null if none has landed yet. */
    getLatestComplete(): { snapshot: ReplicatedTranscriptSnapshotV1; identity: TranscriptRevisionIdentity } | null {
        return this.complete;
    }

    ingestRow(row: TranscriptRevisionRow): TranscriptRevisionIngestResult {
        if (this.expectedOwnerWriterId !== undefined && row.writer !== this.expectedOwnerWriterId) {
            return { status: 'rejected', reason: 'wrong_writer' };
        }
        switch (row.kind) {
            case TRANSCRIPT_REVISION_BEGIN_KIND:
                return this.ingestBegin(row.payload);
            case TRANSCRIPT_REVISION_CHUNK_KIND:
                return this.ingestChunk(row.payload);
            case TRANSCRIPT_REVISION_COMMIT_KIND:
                return this.ingestCommit(row.payload);
            default:
                return { status: 'rejected', reason: 'schema_version_unsupported' };
        }
    }

    private ingestBegin(payload: unknown): TranscriptRevisionIngestResult {
        const begin = payload as Partial<TranscriptRevisionBeginV1> | null;
        if (
            !begin ||
            begin.v !== 1 ||
            typeof begin.sessionId !== 'string' ||
            typeof begin.producerDaemonId !== 'string' ||
            typeof begin.producerWriterId !== 'string' ||
            typeof begin.producerEpoch !== 'string' ||
            typeof begin.revision !== 'number' ||
            typeof begin.snapshotBytes !== 'number' ||
            typeof begin.chunks !== 'number' ||
            typeof begin.snapshotSha256 !== 'string'
        ) {
            return { status: 'rejected', reason: 'schema_version_unsupported' };
        }

        // A new begin always replaces any stale in-flight buffer (e.g. the
        // producer crashed mid-revision and restarted) without touching the
        // last verified complete snapshot — see the header note on ring
        // non-atomicity.
        this.inFlight = {
            identity: {
                sessionId: begin.sessionId,
                producerDaemonId: begin.producerDaemonId,
                producerWriterId: begin.producerWriterId,
                producerEpoch: begin.producerEpoch,
                revision: begin.revision,
            },
            totalChunks: begin.chunks,
            snapshotBytes: begin.snapshotBytes,
            snapshotSha256: begin.snapshotSha256,
            chunkBuffers: new Map(),
        };
        return { status: 'begin_accepted' };
    }

    private ingestChunk(payload: unknown): TranscriptRevisionIngestResult {
        const chunk = payload as Partial<TranscriptRevisionChunkV1> | null;
        if (!chunk || chunk.v !== 1) return { status: 'rejected', reason: 'schema_version_unsupported' };

        const inFlight = this.inFlight;
        if (!inFlight) return { status: 'rejected', reason: 'chunk_without_begin' };

        if (
            chunk.sessionId !== inFlight.identity.sessionId ||
            chunk.producerEpoch !== inFlight.identity.producerEpoch ||
            chunk.revision !== inFlight.identity.revision
        ) {
            this.inFlight = null;
            return { status: 'rejected', reason: 'wrong_session' };
        }
        if (chunk.chunks !== inFlight.totalChunks) {
            this.inFlight = null;
            return { status: 'rejected', reason: 'chunk_count_mismatch' };
        }
        if (typeof chunk.index !== 'number' || chunk.index < 0 || chunk.index >= inFlight.totalChunks) {
            this.inFlight = null;
            return { status: 'rejected', reason: 'chunk_index_out_of_range' };
        }
        if (inFlight.chunkBuffers.has(chunk.index)) {
            this.inFlight = null;
            return { status: 'rejected', reason: 'duplicate_chunk_index' };
        }
        if (typeof chunk.dataBase64 !== 'string' || !BASE64_RE.test(chunk.dataBase64)) {
            this.inFlight = null;
            return { status: 'rejected', reason: 'invalid_base64' };
        }

        let decoded: Uint8Array;
        try {
            decoded = base64ToBytes(chunk.dataBase64);
        } catch {
            this.inFlight = null;
            return { status: 'rejected', reason: 'invalid_base64' };
        }
        inFlight.chunkBuffers.set(chunk.index, decoded);
        return { status: 'chunk_accepted' };
    }

    private ingestCommit(payload: unknown): TranscriptRevisionIngestResult {
        const commit = payload as Partial<TranscriptRevisionCommitV1> | null;
        if (!commit || commit.v !== 1) return { status: 'rejected', reason: 'schema_version_unsupported' };

        const inFlight = this.inFlight;
        if (!inFlight) return { status: 'rejected', reason: 'commit_without_begin' };
        // A commit is one-shot regardless of outcome: a rejected commit must
        // not leave a stale in-flight buffer for a later, unrelated commit to
        // complete against.
        this.inFlight = null;

        // ★ Strict on purpose: begin and commit are two `LogEntry.kind`s written
        // from ONE `identity` object inside a single `encodeTranscriptRevision`
        // call (see `{ ...identity }` spread into both below) — never two
        // different "resolve my own daemon id" call sites at different times.
        // A mismatch here can only mean a spliced/corrupted envelope pair (a
        // commit that does not belong to this begin), which is exactly what
        // this check must catch — canonicalizing would let a commit forged
        // with a differently-formatted-but-equivalent producerDaemonId slip an
        // unrelated revision past the pairing check.
        if (
            commit.sessionId !== inFlight.identity.sessionId ||
            commit.producerDaemonId !== inFlight.identity.producerDaemonId || // canon-ok: begin/commit envelope self-consistency (one identity object, one encode call), not cross-path daemon-id resolution — see comment above
            commit.producerWriterId !== inFlight.identity.producerWriterId ||
            commit.producerEpoch !== inFlight.identity.producerEpoch ||
            commit.revision !== inFlight.identity.revision
        ) {
            return { status: 'rejected', reason: 'revision_identity_mismatch' };
        }
        if (
            commit.chunks !== inFlight.totalChunks ||
            commit.snapshotBytes !== inFlight.snapshotBytes ||
            commit.snapshotSha256 !== inFlight.snapshotSha256
        ) {
            return { status: 'rejected', reason: 'chunk_count_mismatch' };
        }
        if (inFlight.chunkBuffers.size !== inFlight.totalChunks) {
            return { status: 'rejected', reason: 'missing_chunk' };
        }

        const ordered: Uint8Array[] = [];
        for (let index = 0; index < inFlight.totalChunks; index++) {
            const buf = inFlight.chunkBuffers.get(index);
            if (!buf) return { status: 'rejected', reason: 'missing_chunk' };
            ordered.push(buf);
        }
        const combined = concatBytes(ordered);
        if (combined.length !== inFlight.snapshotBytes) {
            return { status: 'rejected', reason: 'byte_count_mismatch' };
        }

        let json: string;
        try {
            // ★ `ignoreBOM: false` is explicit, not decorative: DOM's
            // `TextDecoderOptions` makes it optional, but `@cloudflare/workers-types`'
            // `TextDecoderConstructorOptions` (what `packages/server`'s
            // DOM-less `lib: ["ES2022"]` tsconfig resolves `TextDecoder` from,
            // since this file became reachable from that package's typecheck
            // via §8 unit 2's `transcript-publisher.ts` import chain) requires
            // it. Omitting it type-checks fine under a DOM lib and fails only
            // under the Workers lib — exactly the asymmetry that let it ship
            // unnoticed in unit 1.
            json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(combined);
        } catch {
            return { status: 'rejected', reason: 'invalid_utf8' };
        }

        if (sha256HexUtf8(json) !== inFlight.snapshotSha256) {
            return { status: 'rejected', reason: 'hash_mismatch' };
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(json);
        } catch {
            return { status: 'rejected', reason: 'invalid_json' };
        }

        const snapshot = parsed as Partial<ReplicatedTranscriptSnapshotV1> | null;
        if (!snapshot || snapshot.schemaVersion !== 1) {
            return { status: 'rejected', reason: 'schema_version_unsupported' };
        }
        if (snapshot.sessionId !== inFlight.identity.sessionId) {
            return { status: 'rejected', reason: 'wrong_session' };
        }
        // Unlike the begin/commit envelope pairing above, the snapshot BODY's
        // `producerDaemonId` is populated by the publisher's observation
        // builder (§8 unit 2), a separate call site from whatever stamped the
        // envelope identity at `encodeTranscriptRevision` time. Two "resolve my
        // own daemon id" call sites in one producer process is exactly the
        // cross-path variance `daemonIdsEquivalent` exists for (see
        // fleet-status-peer-view.ts:157 for the same pattern: wire-embedded
        // daemonId vs. a separately-tracked identity) — a raw `!==` here would
        // reject a legitimate revision merely because one side used
        // `mach_X` and the other `daemon_mach_X` for the same machine.
        if (
            !daemonIdsEquivalent(snapshot.producerDaemonId, inFlight.identity.producerDaemonId) ||
            snapshot.producerWriterId !== inFlight.identity.producerWriterId ||
            snapshot.producerEpoch !== inFlight.identity.producerEpoch ||
            snapshot.revision !== inFlight.identity.revision
        ) {
            return { status: 'rejected', reason: 'wrong_owner' };
        }

        this.complete = { snapshot: snapshot as ReplicatedTranscriptSnapshotV1, identity: inFlight.identity };
        return { status: 'complete', snapshot: this.complete.snapshot, identity: inFlight.identity };
    }
}
