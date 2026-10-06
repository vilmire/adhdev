// The request/response half of the daemon mesh transport, as the base class of
// every concrete transport (cloud DaemonMeshManager over WebRTC, standalone
// WsMeshTransport over a direct WebSocket): request ids, the rpc_req / rpc_ack /
// rpc_res / probe frames on an open peer channel (with MESH-IMAGE-CHUNKING split /
// reassembly), and the settled-id memory that makes a late duplicate reply a no-op.
// The only thing it asks of `peer.dc` is `sendMessage(json)` / `isOpen()`. The peer
// lifecycle, connection establishment and failure policy stay in the subclass,
// which supplies the hooks declared abstract below. Moved here from daemon-cloud on
// 2026-10-07.

import { LOG } from '../../logging/logger.js';
import { loadConfig } from '../../config/config.js';
import {
    MeshChunkAssembler,
    meshFrameNeedsChunking,
    splitMeshFrame,
    type MeshChunkAcceptResult,
} from '@adhdev/mesh-shared';
import { summarizeMeshCommandArgs, summarizeMeshCommandResult } from './mesh-command-summarizer.js';
import { maskDaemonId } from './mask-daemon-id.js';
import {
    ACK_TIMEOUT_MS,
    PROTOCOL_VERSION,
    SETTLED_ID_RETENTION_MS,
    encodeMeshHandlerErrorCode,
    logMeshCommandEvent,
    type FailureOptions,
    type PendingRpc,
    type Peer,
    type RpcAckEnvelope,
    type RpcProbeAckEnvelope,
    type RpcRequestEnvelope,
    type RpcResponseEnvelope,
} from './mesh-rpc-protocol.js';
import type { P2pRelayFailureError } from '../p2p-relay-failure.js';

export abstract class MeshRpcEndpoint {

  // Settled request ids, so a duplicate/late response is a no-op instead of an
  // orphan-log. Bounded by time-bucket rotation so it cannot grow without limit:
  // ids accumulate in `current`; every SETTLED_ID_RETENTION_MS the older bucket is
  // dropped, `current` becomes `previous`, and a fresh `current` starts. wasSettled()
  // checks both buckets, so an id is remembered for between 1× and 2× the retention
  // window — long enough that any late duplicate (a request may sit inflight up to
  // CONNECT_TIMEOUT_MS + the longest result budget) has surely already arrived.
  protected settledIdsCurrent = new Set<string>();
  protected settledIdsPrevious = new Set<string>();
  protected settledIdsRotatedAt = Date.now();
  protected idNonce = `${loadConfig().machineId ?? 'mesh'}_${process.pid}`;
  protected idSeq = 0;
  protected commandCallback?: (
    senderDaemonId: string,
    command: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;

  // ─── Request / response ─────────────────────────────────────────────────────

  /**
   * MESH-IMAGE-CHUNKING: write one envelope to a peer, splitting it across chunk frames
   * when it exceeds what a single DataChannel message can carry.
   *
   * Every mesh frame used to go out as one `sendMessage(JSON.stringify(envelope))`. That
   * held while args were small text, but a coordinator dispatching an image puts a
   * multi-MB base64 part in `args`, which the transport cannot carry in one frame — the
   * send throws or the frame vanishes and the dispatch dies silently. Oversized frames
   * now ride the same split/reassemble scheme the dashboard P2P path has used in
   * production (`daemon-p2p/data-channel-router.ts`), ported into `@adhdev/mesh-shared`.
   *
   * Small frames — every frame before this change — still take the identical single-send
   * path, so the common case is byte-for-byte unchanged.
   *
   * Returns false on refusal/failure WITHOUT throwing; the caller owns the error surface
   * (a request rejects its promise, a best-effort ack just logs). A payload past the
   * chunk cap is refused explicitly rather than truncated.
   */
  protected writeEnvelope(peer: Peer, envelope: unknown, describe: string): boolean {
    let json: string;
    try {
      json = JSON.stringify(envelope);
    } catch (err: any) {
      LOG.warn('Mesh', `[Mesh] Failed to serialize ${describe}: ${err?.message || err}`);
      return false;
    }

    if (!meshFrameNeedsChunking(json)) {
      peer.dc.sendMessage(json);
      return true;
    }

    const chunkId = `${this.idNonce}:chunk:${this.idSeq++}`;
    const split = splitMeshFrame(json, chunkId, PROTOCOL_VERSION);
    if (!split.ok) {
      // Explicit refusal — never a partial send. The caller turns this into an error the
      // operator can act on, rather than a frame that silently never arrives.
      LOG.warn('Mesh', `[Mesh] Refusing to send oversized ${describe} to ${maskDaemonId(peer.daemonId)}: ${split.reason} (${split.detail})`);
      this.logEvent('chunked_send_refused', {
        targetDaemonId: peer.daemonId, reason: split.reason, detail: split.detail, bytes: json.length,
      });
      return false;
    }

    this.logEvent('chunked_send', {
      targetDaemonId: peer.daemonId, chunkId, chunks: split.chunks.length, bytes: json.length,
    });
    for (const chunk of split.chunks) {
      // A throw mid-stream aborts the rest: the receiver's partial is swept at its TTL
      // and the caller fails now, instead of the frame hanging until its deadline.
      peer.dc.sendMessage(JSON.stringify(chunk));
    }
    return true;
  }

  protected writeRequest(peer: Peer, pending: PendingRpc): void {
    // OFFLINE-NODE-FANOUT: the channel opened before the probe budget lapsed — the
    // request is being written, so cancel its connect-wait timer (it would otherwise
    // fire later and try to reject an already-inflight request).
    if (pending.connectWaitTimer) { clearTimeout(pending.connectWaitTimer); pending.connectWaitTimer = undefined; }
    const envelope: RpcRequestEnvelope = {
      v: PROTOCOL_VERSION, kind: 'rpc_req', id: pending.id, command: pending.command, args: pending.args,
    };
    try {
      // MESH-IMAGE-CHUNKING: an image-bearing dispatch is split across frames here.
      // A refusal (past the chunk cap) is a failed send, not a silent drop.
      if (!this.writeEnvelope(peer, envelope, `rpc_req ${pending.command}`)) {
        const message = `mesh request payload could not be sent (too large for the mesh transport)`;
        this.logEvent('send_failed', { requestId: pending.id, command: pending.command, targetDaemonId: peer.daemonId, error: message });
        pending.reject(this.failure(message, pending.command, peer.daemonId, 'PAYLOAD_TOO_LARGE'));
        return;
      }
    } catch (err: any) {
      const message = err?.message || 'P2P DataChannel send failed';
      this.logEvent('send_failed', { requestId: pending.id, command: pending.command, targetDaemonId: peer.daemonId, error: message });
      pending.reject(this.failure(message, pending.command, peer.daemonId, 'SEND_FAILED'));
      return;
    }
    pending.sentAt = new Date().toISOString();
    peer.inflight.set(pending.id, pending);
    this.logEvent('sent', {
      requestId: pending.id, command: pending.command, targetDaemonId: peer.daemonId,
      queuedAt: pending.queuedAt, sentAt: pending.sentAt,
      queueWaitMs: Date.parse(pending.sentAt) - Date.parse(pending.queuedAt),
      attempt: peer.attempt,
      resultTimeoutMs: pending.resultTimeoutMs, ackTimeoutMs: ACK_TIMEOUT_MS,
      transport: peer.isRelay === true ? 'relay' : peer.isRelay === false ? 'direct' : 'unknown',
      argsSummary: summarizeMeshCommandArgs(pending.command, pending.args),
    });
    // Result deadline — the always-on safety net. Rejects ONLY this request; never
    // tears down the peer. Uses the per-command value so a slow cross-machine git op
    // gets the long budget and a cheap probe a short one.
    pending.requestTimer = setTimeout(() => {
      if (!peer.inflight.has(pending.id)) return;
      peer.inflight.delete(pending.id);
      this.rememberSettled(pending.id);
      if (pending.ackTimer) { clearTimeout(pending.ackTimer); pending.ackTimer = undefined; }
      this.logEvent('timeout', {
        requestId: pending.id, command: pending.command, targetDaemonId: peer.daemonId,
        sentAt: pending.sentAt, acked: pending.acked === true, resultTimeoutMs: pending.resultTimeoutMs,
      });
      pending.reject(this.failure(
        `P2P mesh command '${pending.command}' to ${maskDaemonId(peer.daemonId)} timed out after ${pending.resultTimeoutMs}ms`,
        pending.command, peer.daemonId, 'REQUEST_TIMEOUT',
      ));
      this.noteRequestTimeout(peer);
    }, pending.resultTimeoutMs);
    if (typeof pending.requestTimer.unref === 'function') pending.requestTimer.unref();

    // Ack deadline — bounds "delivered yet?". For an ack-capable peer, no ack within
    // ACK_TIMEOUT_MS means the request never reached a working handler, so fail fast
    // rather than waiting out the (possibly long) result deadline. For an old peer
    // that never acks (supportsAck still falsy) this is inert: it logs and lets the
    // result deadline govern — graceful degrade.
    pending.ackTimer = setTimeout(() => {
      if (!peer.inflight.has(pending.id) || pending.acked) return;
      if (peer.supportsAck) {
        peer.inflight.delete(pending.id);
        this.rememberSettled(pending.id);
        if (pending.requestTimer) { clearTimeout(pending.requestTimer); pending.requestTimer = undefined; }
        this.logEvent('ack_timeout', {
          requestId: pending.id, command: pending.command, targetDaemonId: peer.daemonId, sentAt: pending.sentAt,
        });
        pending.reject(this.failure(
          `P2P mesh command '${pending.command}' to ${maskDaemonId(peer.daemonId)} was not acknowledged within ${ACK_TIMEOUT_MS}ms (delivery failure)`,
          pending.command, peer.daemonId, 'ACK_TIMEOUT',
        ));
        // This request is settled here (requestTimer cleared above), so the result
        // deadline won't also fire — count it toward the liveness escalation now.
        this.noteRequestTimeout(peer);
      } else {
        // No proof this peer acks — leave the result deadline as the sole guard. The
        // result-deadline timeout (noteRequestTimeout there) is the single counting
        // point for a no-ack peer, so deliberately do NOT count here too.
        this.logEvent('ack_missing_degrade', {
          requestId: pending.id, command: pending.command, targetDaemonId: peer.daemonId, sentAt: pending.sentAt,
        });
      }
    }, ACK_TIMEOUT_MS);
    if (typeof pending.ackTimer.unref === 'function') pending.ackTimer.unref();
  }

  protected onMessage(peer: Peer, msg: string | Buffer): void {
    let data: any;
    try {
      data = JSON.parse(typeof msg === 'string' ? msg : msg.toString('utf8'));
    } catch (e: any) {
      LOG.warn('Mesh', `[Mesh] Failed to parse P2P message: ${e.message}`);
      return;
    }

    // MESH-IMAGE-CHUNKING: reassemble a split frame before dispatching it. A chunk is
    // never an envelope in its own right — it only becomes one once the group completes.
    if (MeshChunkAssembler.isChunkFrame(data)) {
      const reassembled = this.acceptChunk(peer, data);
      if (reassembled === undefined) return; // still partial, or explicitly failed
      data = reassembled;
    }

    if (data?.kind === 'rpc_req' && typeof data.command === 'string') {
      this.handleIncomingRequest(peer, data as RpcRequestEnvelope);
      return;
    }
    if (data?.kind === 'rpc_ack' && typeof data.id === 'string') {
      this.handleIncomingAck(peer, data as RpcAckEnvelope);
      return;
    }
    if (data?.kind === 'rpc_res' && typeof data.id === 'string') {
      this.handleIncomingResponse(peer, data as RpcResponseEnvelope);
      return;
    }
    // RELAY-DATA-STALL probe (P2P-1). A probe is answered with a probe_ack the instant
    // it lands (no handler work) — that round trip is the proof real data flows.
    if (data?.kind === 'rpc_probe' && typeof data.id === 'string') {
      this.writeProbeAck(peer, data.id as string);
      return;
    }
    if (data?.kind === 'rpc_probe_ack' && typeof data.id === 'string') {
      this.handleIncomingProbeAck(peer, data as RpcProbeAckEnvelope);
      return;
    }
    // Unknown / wrong-version frame — ignore rather than mis-handle.
    this.logEvent('frame_ignored', { targetDaemonId: peer.daemonId, kind: data?.kind, v: data?.v });
  }

  /**
   * MESH-IMAGE-CHUNKING: feed one inbound chunk to this peer's assembler.
   *
   * Returns the reassembled frame when the group completes, or `undefined` when the
   * frame is still partial OR was explicitly rejected. A rejection is never silent: it
   * is logged with its typed reason, and when the broken frame was a REQUEST we answer
   * with an error envelope so the sender fails fast with a real explanation instead of
   * waiting out its deadline. (A broken inbound RESPONSE cannot be answered — its
   * request's own deadline is the backstop — so it is logged and dropped.)
   */
  protected acceptChunk(peer: Peer, frame: unknown): unknown | undefined {
    if (!peer.chunkAssembler) peer.chunkAssembler = new MeshChunkAssembler();
    let result: MeshChunkAcceptResult;
    try {
      result = peer.chunkAssembler.accept(frame);
    } catch (err: any) {
      LOG.warn('Mesh', `[Mesh] Chunk reassembly threw for ${maskDaemonId(peer.daemonId)}: ${err?.message || err}`);
      return undefined;
    }

    if (result.status === 'partial') return undefined;
    if (result.status === 'complete') return result.frame;

    LOG.warn('Mesh', `[Mesh] Discarding chunked frame from ${maskDaemonId(peer.daemonId)}: ${result.reason} (${result.detail})`);
    this.logEvent('chunk_reassembly_failed', {
      senderDaemonId: peer.daemonId, reason: result.reason, detail: result.detail, chunkId: result.chunkId,
    });
    return undefined;
  }

  protected handleIncomingRequest(peer: Peer, req: RpcRequestEnvelope): void {
    this.logEvent('incoming', {
      requestId: req.id, command: req.command, senderDaemonId: peer.daemonId,
      argsSummary: summarizeMeshCommandArgs(req.command, req.args ?? {}),
    });
    // Acknowledge delivery BEFORE any handler work so the sender knows the request
    // landed and switches from "is it lost?" to "it's running" — a slow handler is
    // then never mistaken for a dropped request.
    this.writeAck(peer, req.id);
    if (!this.commandCallback) {
      this.writeResponse(peer, req.id, false, undefined, req.command, { code: 'NO_HANDLER', message: 'No mesh command handler registered' });
      return;
    }
    this.commandCallback(peer.daemonId, req.command, req.args ?? {})
      .then((result) => this.writeResponse(peer, req.id, true, result, req.command))
      .catch((err: any) => this.writeResponse(peer, req.id, false, undefined, req.command, {
        // DUP-CLAIM-REBIND: the envelope preserves `error.code` verbatim (the sender maps it
        // onto meshCode), so a handler answer the CALLER must act on structurally rides the
        // code rather than the prose message. A duplicate mesh dispatch is such an answer:
        // "you already have this task, and session X is working it" — the coordinator rebinds
        // its turn ledger onto X instead of cancelling the attempt. Everything else keeps the
        // opaque HANDLER_ERROR code exactly as before.
        code: encodeMeshHandlerErrorCode(err),
        message: err?.message || String(err),
      }));
  }

  protected writeAck(peer: Peer, id: string): void {
    if (!peer.dc?.isOpen?.()) return;
    const envelope: RpcAckEnvelope = { v: PROTOCOL_VERSION, kind: 'rpc_ack', id };
    try {
      peer.dc.sendMessage(JSON.stringify(envelope));
    } catch (err: any) {
      // Ack is best-effort: a failed ack just means the sender falls back to the
      // result deadline. Never throw out of the receive path.
      LOG.warn('Mesh', `[Mesh] Failed to send rpc_ack: ${err.message}`);
    }
  }

  /** Echo a probe_ack the instant a health probe lands — pure transport round trip,
   *  no handler work. Best-effort: a failed send just means the prober's deadline
   *  fires and the relay is (correctly) judged stalled. */
  protected writeProbeAck(peer: Peer, id: string): void {
    if (!peer.dc?.isOpen?.()) return;
    const envelope: RpcProbeAckEnvelope = { v: PROTOCOL_VERSION, kind: 'rpc_probe_ack', id };
    try {
      peer.dc.sendMessage(JSON.stringify(envelope));
    } catch (err: any) {
      LOG.warn('Mesh', `[Mesh] Failed to send rpc_probe_ack: ${err?.message || err}`);
    }
  }

  /** A probe_ack returned: the relay provably carries data. Confirm the peer, cancel
   *  the stall deadline, and flush the queued requests that waited on the probe. A
   *  stale/duplicate probe_ack (wrong or already-confirmed id) is a no-op. */
  protected handleIncomingProbeAck(peer: Peer, ack: RpcProbeAckEnvelope): void {
    if (peer.probeConfirmed || ack.id !== peer.probeId) return;
    peer.probeConfirmed = true;
    peer.lastSuccessAt = Date.now();
    if (peer.probeTimer) { clearTimeout(peer.probeTimer); peer.probeTimer = undefined; }
    this.logEvent('relay_probe_ack', { targetDaemonId: peer.daemonId, probeId: ack.id });
    // The relay is now proven to carry data — this, not dc.onOpen, is when a
    // relay peer becomes usable, so it is where the second lane may attach.
    this.emitPeerOpen(peer);
    this.flushConnectQueue(peer);
  }

  protected writeResponse(peer: Peer, id: string, ok: boolean, result?: unknown, command?: string, error?: { code: string; message: string }): void {
    if (!peer.dc?.isOpen?.()) {
      this.logEvent('response_send_failed', { requestId: id, targetDaemonId: peer.daemonId, error: 'P2P not open' });
      return;
    }
    const envelope: RpcResponseEnvelope = { v: PROTOCOL_VERSION, kind: 'rpc_res', id, ok, ...(ok ? { result } : { error }) };
    try {
      // A result can be large in its own right (read_chat tails, git diffs), so the
      // response path gets the same chunking treatment as the request path.
      if (!this.writeEnvelope(peer, envelope, 'rpc_res')) {
        // The result cannot be delivered — answer with an error envelope instead of
        // leaving the caller to time out with no explanation. The error envelope is
        // tiny, so it always fits inline.
        const fallback: RpcResponseEnvelope = {
          v: PROTOCOL_VERSION, kind: 'rpc_res', id, ok: false,
          error: { code: 'PAYLOAD_TOO_LARGE', message: 'mesh response payload exceeded the mesh transport limit' },
        };
        try { peer.dc.sendMessage(JSON.stringify(fallback)); } catch { /* best-effort */ }
        this.logEvent('response_send_failed', { requestId: id, targetDaemonId: peer.daemonId, error: 'payload_too_large' });
        return;
      }
      this.logEvent('response_sent', {
        requestId: id, command, targetDaemonId: peer.daemonId, ok,
        // Use the command-aware summarizer (matching response_received) so a non-git
        // command like get_pending_mesh_events falls to its default rather than being
        // forced into a git-shaped, all-null summary that spams the log every poll.
        resultSummary: ok ? summarizeMeshCommandResult(command ?? '', result) : null,
        error: error?.message,
      });
    } catch (err: any) {
      LOG.warn('Mesh', `[Mesh] Failed to send rpc_res: ${err.message}`);
    }
  }

  protected handleIncomingAck(peer: Peer, ack: RpcAckEnvelope): void {
    // The peer speaks the ack protocol — record it so future ack-timeouts are real.
    peer.supportsAck = true;
    const pending = peer.inflight.get(ack.id);
    if (!pending || pending.acked) return; // already settled or duplicate ack
    pending.acked = true;
    // Proof the link is alive — clear the consecutive-timeout liveness counter so a
    // healthy peer that had one slow/lost reply is never torn down, and stamp the
    // success time so a later heavy-command timeout is judged against this proof.
    peer.consecutiveTimeouts = 0;
    peer.lastSuccessAt = Date.now();
    // Delivery confirmed: cancel the ack deadline. The result deadline keeps running
    // — the request is "in progress", and the per-command result budget governs how
    // long the handler may take.
    if (pending.ackTimer) { clearTimeout(pending.ackTimer); pending.ackTimer = undefined; }
    this.logEvent('ack_received', {
      requestId: ack.id, command: pending.command, targetDaemonId: peer.daemonId,
      sentAt: pending.sentAt, resultTimeoutMs: pending.resultTimeoutMs,
      attempt: peer.attempt,
      ackMs: pending.sentAt ? Date.now() - Date.parse(pending.sentAt) : undefined,
    });
  }

  protected handleIncomingResponse(peer: Peer, res: RpcResponseEnvelope): void {
    const pending = peer.inflight.get(res.id);
    if (!pending) {
      // Already settled (e.g. timed out) or a duplicate — no-op, no spam.
      if (!this.wasSettled(res.id)) {
        this.logEvent('response_orphan', { requestId: res.id, targetDaemonId: peer.daemonId, ok: res.ok });
      }
      return;
    }
    peer.inflight.delete(res.id);
    this.rememberSettled(res.id);
    // A response (ok or error) is proof the link is alive — reset the liveness
    // counter and stamp the success time. A handler-level error still means the
    // transport delivered the round trip, which is exactly what the counter is meant
    // to detect the absence of; the lastSuccessAt stamp lets a subsequent slow
    // heavy-command timeout be recognised as command-slow, not connection-dead.
    peer.consecutiveTimeouts = 0;
    peer.lastSuccessAt = Date.now();
    if (pending.requestTimer) clearTimeout(pending.requestTimer);
    if (pending.ackTimer) clearTimeout(pending.ackTimer);
    this.logEvent('response_received', {
      requestId: res.id, command: pending.command, targetDaemonId: peer.daemonId,
      queuedAt: pending.queuedAt, sentAt: pending.sentAt, ok: res.ok,
      resultSummary: res.ok ? summarizeMeshCommandResult(pending.command, res.result) : null,
      error: res.ok ? undefined : res.error?.message,
    });
    if (res.ok) {
      pending.resolve(res.result);
    } else {
      pending.reject(this.failure(res.error?.message || 'P2P command failed', pending.command, peer.daemonId, res.error?.code || 'HANDLER_ERROR'));
    }
  }

  // ─── Settled-id bookkeeping (bounded) ───────────────────────────────────────

  /** Rotate the time buckets if the retention window has elapsed: drop the older
   *  bucket, age the current one, and start a fresh current bucket. */
  protected rotateSettledIdsIfDue(): void {
    if (Date.now() - this.settledIdsRotatedAt < SETTLED_ID_RETENTION_MS) return;
    this.settledIdsPrevious = this.settledIdsCurrent;
    this.settledIdsCurrent = new Set<string>();
    this.settledIdsRotatedAt = Date.now();
  }

  /** Record a request id as settled so a late duplicate reply is a no-op. */
  protected rememberSettled(id: string): void {
    this.rotateSettledIdsIfDue();
    this.settledIdsCurrent.add(id);
  }

  /** Whether a request id was already settled (checks both live buckets). */
  protected wasSettled(id: string): boolean {
    this.rotateSettledIdsIfDue();
    return this.settledIdsCurrent.has(id) || this.settledIdsPrevious.has(id);
  }

  /** The structured [MeshCommand] log line (an instance seam: tests observe it). */
  protected logEvent(event: string, fields: Record<string, unknown>): void {
    logMeshCommandEvent(event, fields);
  }

  // ─── Hooks supplied by DaemonMeshManager ───────────────────────────────────

  /** A typed P2P relay failure for `command` to `targetDaemonId`. */
  protected abstract failure(message: string, command: string, targetDaemonId: string, meshCode: string, options?: FailureOptions): P2pRelayFailureError;
  /** Count a request timeout against the peer's liveness (may tear the peer down). */
  protected abstract noteRequestTimeout(peer: Peer): void;
  /** The relay is proven to carry data: announce the peer as open. */
  protected abstract emitPeerOpen(peer: Peer): void;
  /** Write the requests that queued while the peer was connecting. */
  protected abstract flushConnectQueue(peer: Peer): void;
}
