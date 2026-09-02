/**
 * `mesh_read_chat_display` replica read — design §4 (roster id 3), §8 unit 6
 * ("mesh_read_chat remote display cutover").
 *
 * ── Why mcp-server does not open the replica DB itself ─────────────────────
 * Design §4 ("별도 프로세스 경계"): `seqscribe.db` is single-process-owned by
 * the daemon (see `seqscribe/node.ts`'s header). mcp-server is a SEPARATE
 * process, so it reads a remote session's transcript replica through the
 * COORDINATOR daemon's local IPC — `ensure_transcript_subscription` /
 * `read_transcript_replica`, the two low-family commands §8 unit 3 built for
 * exactly this caller (`daemon-core/src/commands/low-family/transcript-
 * replica.ts`). Both go over `ctx.transport.command(...)` — the LOCAL
 * coordinator daemon — never `meshCommand`, which would relay to the remote
 * worker daemon and defeat the entire point (the replica exists so the
 * coordinator does not have to make a per-read P2P round trip, §1.3:
 * "원격 세션의 반복 mesh_read_chat P2P RPC 중 replica로 무손실 대체 가능한
 * 읽기").
 *
 * ── Fallback order is FIXED (design §6 acceptance) ─────────────────────────
 *   replica  →  live P2P `read_chat`  →  cached ledger summary
 * This module owns only the FIRST hop and always degrades by returning null;
 * it never throws, so the two existing hops in `meshReadChat` stay exactly as
 * they were. A replica read that fails for ANY reason — no store, no
 * subscription, no complete revision, IPC down, malformed answer — is
 * indistinguishable to the caller from "replica not available", which is the
 * only safe direction: a wrong transcript is worse than a slower one.
 *
 * ── Scope guards are deliberately NOT duplicated here ──────────────────────
 * `read_chat`'s node-workspace scope guard (`chat-commands-scope.ts`) and the
 * provider/session identity resolution in `meshReadChat` stay untouched
 * (design §8 unit 6: "local `read_chat`, cached-summary semantics, provider
 * scope guards 무변경"). The replica's own defense is different in KIND and
 * already applied upstream: `TranscriptReplicaStore` re-checks the assembled
 * `(ownerDaemonId, rawSessionId)` identity against the caller's key on every
 * complete revision (§3.5), so a snapshot that reaches us is already
 * owner-and-session-verified. Re-implementing a workspace guard over a
 * snapshot that carries no workspace field would be theatre.
 *
 * ── ★ What this hop does in production TODAY ───────────────────────────────
 * It RUNS — `mesh_read_chat` is a live MCP tool (`server.ts`'s dispatch), so
 * unlike §8 unit 5's adapter this code is not inert scaffolding. But it will
 * currently always DECLINE, because `CommandRouterDeps.resolveTranscriptPeer`
 * is deliberately left unset (`daemon-core/src/boot/daemon-lifecycle.ts`, and
 * see its doc comment): without a peer resolver `ensure_transcript_
 * subscription` answers `ipc_unavailable`, no SUB is ever attached, and
 * `TranscriptReplicaStore.getReplica` therefore has no entry to serve. The
 * observable production behaviour is: every remote read takes hop 2 and is
 * labelled `transcriptFallbackReason: 'ipc_unavailable'`.
 *
 * That is the correct state for this unit, not a defect: the fallback ORDER
 * and the parity of the replica-sourced payload are what §8 unit 6 owns, and
 * both are exercised by tests. Wiring the transport-layer peer resolver is a
 * separate change in `packages/daemon-cloud` / `daemon-standalone` (the
 * packages that actually own the peer map), and once it lands this hop starts
 * serving with no edit here. The `transcriptFallbackReason` telemetry is how
 * an operator will SEE it flip.
 *
 * ── LOCAL nodes never take this path ───────────────────────────────────────
 * The roster entry covers REMOTE transcript display. A local node's
 * `read_chat` is a direct in-process call with no P2P cost and is the
 * provider-source authority — §4's roster note keeps it as-is. The caller
 * gates on `isLocalControlPlaneNode` before invoking this module.
 */

import {
    mapTranscriptSnapshotToReadChatPayload,
    type ReplicatedTranscriptSnapshotV1,
    type TranscriptReadChatPayload,
} from '@adhdev/daemon-core';

/**
 * Why `unknown`-typed rather than importing `MeshContext`: this module needs
 * only the local-command capability, and narrowing the dependency keeps it
 * unit-testable without constructing a whole mesh context.
 */
export interface TranscriptReplicaTransport {
    command(type: string, args?: Record<string, unknown>): Promise<any>;
}

export interface TranscriptReplicaReadOutcome {
    /** Null when the replica could not answer — the caller falls through. */
    readonly payload: TranscriptReadChatPayload | null;
    /**
     * Why the replica did not answer, for the caller's telemetry. One of
     * daemon-core's `TranscriptConsumerFallbackReason` literals when the
     * daemon supplied one; otherwise a locally-named reason. Null on success.
     */
    readonly fallbackReason: string | null;
}

function unwrap(result: any): any {
    // The IPC layer sometimes nests the handler's object under `payload`/`result`
    // (mesh-tools-internal's `unwrapCommandPayload` does the same lift). Kept
    // local so this module has no dependency on the mesh-tools barrel.
    if (result && typeof result === 'object') {
        if (result.payload && typeof result.payload === 'object') return result.payload;
        if (result.result && typeof result.result === 'object') return result.result;
    }
    return result;
}

function readReason(value: any, fallback: string): string {
    return typeof value?.reason === 'string' && value.reason.trim() ? value.reason.trim() : fallback;
}

/**
 * Minimal structural verification before a snapshot is allowed to ANSWER a
 * read. The daemon-side store already validated identity/completeness, but
 * this crosses a process boundary as untyped JSON, so the fields this
 * consumer actually reads are checked to exist and be the right primitive
 * kind. A miss falls back rather than rendering a half-empty transcript.
 *
 * ★ This is an allow-list check, not a deny-list sanitizer: it asserts the
 * REQUIRED shape and refuses otherwise. It must never be rewritten as
 * "delete the bad keys and continue".
 */
function isUsableSnapshot(value: any): value is ReplicatedTranscriptSnapshotV1 {
    if (!value || typeof value !== 'object') return false;
    if (value.schemaVersion !== 1) return false;
    if (typeof value.sessionId !== 'string' || !value.sessionId) return false;
    if (typeof value.status !== 'string' || !value.status) return false;
    if (!Array.isArray(value.messages)) return false;
    if (!value.coverage || typeof value.coverage !== 'object') return false;
    if (typeof value.coverage.totalMessageCount !== 'number') return false;
    if (typeof value.coverage.omittedBefore !== 'boolean') return false;
    if (!value.provenance || typeof value.provenance !== 'object') return false;
    if (typeof value.revision !== 'number') return false;
    if (typeof value.observedAt !== 'string' || !value.observedAt) return false;
    return true;
}

/**
 * Attempt the replica hop. Returns `{payload: null, fallbackReason}` for every
 * non-answer; never throws.
 *
 * `stale` is carried from the snapshot's own freshness signal rather than
 * recomputed: design §5.5's staleness gate belongs to the producer/store, and
 * a second clock here would be a second authority (same reasoning as the
 * status field — see the adapter's header).
 */
export async function readTranscriptReplicaForDisplay(
    transport: TranscriptReplicaTransport,
    key: { ownerDaemonId: string; rawSessionId: string },
): Promise<TranscriptReplicaReadOutcome> {
    if (!key.ownerDaemonId || !key.rawSessionId) {
        return { payload: null, fallbackReason: 'no_node' };
    }

    // Ensure the coordinator daemon holds a SUB for this key. A not-ready
    // answer is NOT fatal on its own — a subscription attached by an earlier
    // read may still have a complete revision — but it is the common reason we
    // will fall through, so its reason is what we report if the read then
    // misses too.
    let ensureReason: string | null = null;
    try {
        const ensured = unwrap(await transport.command('ensure_transcript_subscription', key));
        if (ensured?.ready !== true) ensureReason = readReason(ensured, 'ipc_unavailable');
    } catch {
        ensureReason = 'ipc_unavailable';
    }

    let read: any;
    try {
        read = unwrap(await transport.command('read_transcript_replica', key));
    } catch {
        return { payload: null, fallbackReason: ensureReason ?? 'ipc_unavailable' };
    }

    if (read?.available !== true) {
        return { payload: null, fallbackReason: ensureReason ?? readReason(read, 'no_complete_revision') };
    }
    if (!isUsableSnapshot(read.snapshot)) {
        return { payload: null, fallbackReason: 'revision_invalid' };
    }

    const snapshot = read.snapshot;
    return {
        payload: mapTranscriptSnapshotToReadChatPayload(snapshot, {
            omittedBefore: snapshot.coverage.omittedBefore,
            stale: read.stale === true,
        }),
        fallbackReason: null,
    };
}
