// Daemon-to-daemon mesh RPC protocol: wire envelopes, per-peer / per-request state
// shapes, the connect / ack / retry / liveness constants, peer-close classification
// and the structured log routing. Transport-agnostic — it says nothing about HOW a
// frame reaches the peer: the cloud daemon rides a WebRTC DataChannel
// (packages/daemon-cloud daemon-mesh-manager.ts, whose ICE / signaling remainder
// stays in its mesh-p2p-protocol.ts), the standalone daemon a direct WebSocket
// (./ws-mesh-transport.ts). Moved here from daemon-cloud on 2026-10-07 so both
// transports share ONE protocol.

import { LOG } from '../../logging/logger.js';
import { classifyDuplicateMeshDispatch, encodeDuplicateMeshDispatchCode } from '../mesh-duplicate-dispatch.js';
import type { MeshPeerConnectionState } from './mesh-peer-types.js';
import { readTimeoutEnv } from './mesh-rpc-timeouts.js';
import { MeshChunkAssembler } from '@adhdev/mesh-shared';

// ─── Protocol envelopes ─────────────────────────────────────────────────────
// Versioned so a future change is rejected cleanly rather than mis-parsed.

export const PROTOCOL_VERSION = 1;

// High-frequency reconcile-poll commands whose successful sent/ack pair is pure
// churn in the log — these two run every ~4s reconcile tick and account for ~97%
// of the daemon log volume (get_pending_mesh_events drains the coordinator event
// queue; get_status_metadata is the light status poll — both classified as light
// polls at the mesh layer, see the light-poll note further down). Only their
// NORMAL request/response lifecycle events are demoted to DEBUG in logEvent();
// every other command and every error/anomaly event (send_failed, timeout,
// ack_timeout, response_orphan, …) stays at INFO regardless. Kept as a named set
// rather than inline string literals so the classification lives in one place.
const NOISY_POLL_COMMANDS = new Set<string>([
  'get_pending_mesh_events',
  'get_status_metadata',
]);

// Events emitted on the happy path — a demote candidate ONLY together with a
// NOISY_POLL_COMMANDS command. Any event not in this set (an error/anomaly) always
// logs at INFO so diagnostics are never lost.
const NORMAL_MESH_EVENTS = new Set<string>(['sent', 'ack_received', 'response_sent', 'response_received']);

// PEER-CLOSE-REASON: every failPeer() call site passes a `code`, but until now that
// code only ever reached peerDiagnostics (an in-memory map, not a log line) — so a
// `pc_state closed` line and a `pc_state failed` line looked identical in the log,
// and there was no way to tell "this daemon replaced the peer on purpose" apart from
// "the transport actually died" without cross-referencing peer_rebind's separate
// `peer_rebind` event by timestamp. failPeer is the single funnel every close path
// already goes through (see MeshPeerLifecycleListener doc comment above), so
// classifying the `code` there — once — covers every path for free.
//
// Five buckets, keyed off the codes call sites already pass:
//  - planned_replacement: this daemon tore the peer down on purpose to rebuild it
//    (auth-epoch rebind, manager shutdown) — never a transport problem.
//  - remote_or_manager_closed: the remote end (or a manual close instruction) ended
//    the DataChannel gracefully — the transport itself didn't error.
//  - timeout: no ack/result/handshake-completion arrived within budget.
//  - signal_rejected: the signaling server refused/could-not-relay the handshake —
//    happens before any DataChannel exists, so it's not a transport failure either.
//  - transport_failure: ICE/DTLS/SCTP actually broke (state=failed, relay carried no
//    data, N consecutive timeouts on an open peer with no liveness proof).
// Falls back to 'transport_failure' for an unrecognized code so a future call site
// that forgets to classify itself still reads as "something broke" rather than
// silently vanishing into an "unknown" bucket nobody watches.
type PeerCloseCategory =
  | 'planned_replacement'
  | 'remote_or_manager_closed'
  | 'timeout'
  | 'signal_rejected'
  | 'transport_failure';

const PEER_CLOSE_CATEGORY_BY_CODE: Record<string, PeerCloseCategory> = {
  AUTH_EPOCH_REBIND: 'planned_replacement',
  LOCAL_AUTH_EPOCH_CHANGED: 'planned_replacement',
  REMOTE_AUTH_EPOCH_CHANGED: 'planned_replacement',
  MANAGER_SHUTDOWN: 'planned_replacement',
  DATACHANNEL_CLOSED: 'remote_or_manager_closed',
  PC_STATE_CLOSED: 'remote_or_manager_closed',
  CONNECT_TIMEOUT: 'timeout',
  ACK_TIMEOUT: 'timeout',
  REQUEST_TIMEOUT: 'timeout',
  PEER_UNRESPONSIVE: 'timeout',
  SIGNAL_REJECTED: 'signal_rejected',
  SIGNAL_TARGET_OFFLINE: 'signal_rejected',
  SIGNAL_RATE_LIMIT: 'signal_rejected',
  SIGNAL_RELAY_FAILED: 'signal_rejected',
  PC_STATE_FAILED: 'transport_failure',
  ICE_LIVENESS_LOST: 'transport_failure',
  RELAY_DATA_STALL: 'transport_failure',
  SIGNAL_DESCRIPTION_FAILED: 'transport_failure',
};

export function classifyPeerCloseReason(code: string): PeerCloseCategory {
  return PEER_CLOSE_CATEGORY_BY_CODE[code] ?? 'transport_failure';
}

export interface RpcRequestEnvelope {
  v: number;
  kind: 'rpc_req';
  id: string;
  command: string;
  args: Record<string, unknown>;
}

export interface RpcResponseEnvelope {
  v: number;
  kind: 'rpc_res';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/**
 * DUP-CLAIM-REBIND: map a handler rejection onto the response envelope's error CODE.
 *
 * The envelope only preserves `code` and `message`, and the sender surfaces `code` as
 * `meshCode` on the rejection — so `code` is the one channel a caller can act on
 * structurally. Almost every handler error is opaque to the caller and keeps the
 * historical `HANDLER_ERROR`. The single exception is a duplicate mesh dispatch, where
 * the answer carries data the coordinator must have (which live session already holds
 * the task) to rebind its turn ledger rather than cancel the attempt.
 */
export function encodeMeshHandlerErrorCode(err: unknown): string {
  const duplicate = classifyDuplicateMeshDispatch(err);
  if (duplicate) return encodeDuplicateMeshDispatchCode(duplicate.holderSessionId);
  return 'HANDLER_ERROR';
}

// Sent by the responder the instant a request envelope is received, BEFORE the
// handler runs. It tells the sender "your request was delivered and is being
// worked on" so a slow handler (a cross-machine git op behind TURN) is not
// mistaken for a lost request. Old daemons never emit it — the sender degrades
// gracefully by falling back to the result deadline alone (see PendingRpc).
export interface RpcAckEnvelope {
  v: number;
  kind: 'rpc_ack';
  id: string;
}

// RELAY-DATA-STALL health probe (P2P-1). A TURN relay can report the DataChannel
// "open" (DTLS handshake completed) yet never actually carry SCTP application data
// — a relay-data-stall where every subsequent request times out and the peer dies
// with liveness_lost into an endless reconnect loop (the win32 mesh-command-only
// failure, since chat/terminal ride a separate daemon-p2p path). DataChannel
// onOpen is therefore NOT trusted as "connection healthy" on its own: the instant
// it opens we send ONE lightweight probe and require a probe_ack round trip to
// confirm real data can flow. No probe_ack within PROBE_TIMEOUT_MS = relay-data-
// stall → fail the peer so the next sendCommand rebuilds a fresh PeerConnection
// that re-gathers ICE. An old daemon that doesn't echo probe_ack would look stalled,
// so a probe is only ENFORCED on a relay candidate pair (where the stall actually
// happens); a direct pair opens healthy and is not gated. The probe is sent once
// per open and stops the moment its ack returns, so a healthy link pays one frame.
export interface RpcProbeEnvelope {
  v: number;
  kind: 'rpc_probe';
  id: string;
}

export interface RpcProbeAckEnvelope {
  v: number;
  kind: 'rpc_probe_ack';
  id: string;
}

// Connect deadline bounds "DataChannel not open yet". A cross-machine,
// TURN-relayed handshake (ICE gather + TURN allocation + DTLS across two
// residential networks) routinely needs >15s. The default is 90s (P2P-2): a win32
// relay answer was observed arriving 25–45s late and racing the old 45s ceiling —
// the late answer landed on an already-torn-down PeerConnection, so the dial never
// completed and the reconnect loop spun forever. 90s comfortably outlives that late
// answer. Same machine (host candidates) opens in well under a second; this ceiling
// only affects genuinely slow relay paths, and reconnect is cheap (the reconcile
// loop retries every tick), so erring long here just avoids spurious teardown.
export const CONNECT_TIMEOUT_MS = readTimeoutEnv('MESH_RPC_CONNECT_TIMEOUT_MS', 90_000);

// RELAY-DATA-STALL probe deadline (P2P-1). How long after DataChannel open we wait
// for the probe_ack round trip before declaring a relay-data-stall and tearing the
// peer down. Short — a probe_ack is a pure-transport round trip with no handler work
// — but generous enough to absorb one relay RTT plus jitter. Env-overridable,
// clamped by readTimeoutEnv to a sane floor.
export const PROBE_TIMEOUT_MS = readTimeoutEnv('MESH_RPC_HEALTH_PROBE_TIMEOUT_MS', 8_000);

// How long the sender waits for the responder's rpc_ack before giving up on
// delivery — but ONLY for peers already proven to speak the ack protocol. For an
// old (no-ack) peer this deadline is inert and the result deadline is the sole
// safety net (graceful degrade). Kept short: an ack is sent before any handler
// work, so its round trip is pure transport latency.
export const ACK_TIMEOUT_MS = readTimeoutEnv('MESH_RPC_ACK_TIMEOUT_MS', 10_000);

// A wedged `connecting` peer must not accumulate unbounded promises.
export const MAX_CONNECT_QUEUE = 64;

// OFFLINE-NODE-FANOUT: default per-request probe budget for a probe-class mesh
// command whose target peer's DataChannel is not open yet. A fan-out probe (status /
// get_pending / reconcile read) to a peer that is not connected must give up FAST
// rather than sit in peer.connectQueue until CONNECT_TIMEOUT_MS (90s) — an offline
// (powered-off) node otherwise blocks every coordinator fan-out for ~90s. When a
// probe request is not written within this budget it is rejected with
// PEER_NOT_CONNECTED and the peer/connectTimer/background dial are left UNTOUCHED, so
// the reconcile loop keeps retrying the connection exactly as before. A caller that
// legitimately wants to wait for a slow relay to open (a targeted, connect-intent
// command) omits connectWaitMs and inherits the full CONNECT_TIMEOUT_MS as before.
// Env-overridable, clamped by readTimeoutEnv to a sane floor. Defined in the
// dependency-free mesh-rpc-timeouts leaf so the dispatch site imports it without
// pulling node-datachannel; re-exported below for the historical import surface.

// How long a settled request id is remembered (per time bucket) so a late duplicate
// response/ack is recognised as a no-op rather than logged as an orphan. Sized to
// comfortably exceed the longest single-request lifetime — CONNECT_TIMEOUT_MS (45s)
// plus the longest result budget (git ops, 90s) — so the id outlives any straggler
// reply for it. With 2-bucket rotation an id is kept 1×–2× this window, then forgotten.
export const SETTLED_ID_RETENTION_MS = 180_000;

// Liveness escalation: how many *consecutive* request timeouts on an already-open
// (connected) peer prove the transport is dead even though node-datachannel never
// emitted a state change. A coordinator network change leaves the peer stuck
// `connected` while every request times out — libdatachannel can take many minutes
// (or, observed live, hours) to escalate to `closed`, and only then does the
// reconcile-driven rebuild fire. Counting consecutive timeouts catches that and
// proactively tears the peer down so the next sendCommand rebuilds with fresh local
// ICE candidates. Any ack or response resets the counter, so a healthy peer with one
// slow/lost reply is never torn down — only a peer whose every reply stops arriving.
// Kept conservative to avoid false positives on a transiently slow-but-alive link.
// (A plain count, not a timeout — so it is read directly rather than via
// readTimeoutEnv, whose [1s,120s] millisecond clamp would reject a small integer.)
export const MAX_CONSECUTIVE_TIMEOUTS = (() => {
  const raw = process.env.MESH_RPC_MAX_CONSECUTIVE_TIMEOUTS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 3;
})();

// Liveness-proof window: if this peer completed a successful round trip (ack OR
// response) within this window, the transport is provably alive RIGHT NOW, so a
// heavy command timing out means *command-slow*, not *connection-dead* — do not
// tear the peer down. This is the "command-slow ≠ connection-dead" guard: a remote
// `git_status` can legitimately overrun its result deadline (win32 submodule
// fan-out) while light polls (get_pending_mesh_events / get_status_metadata) keep
// succeeding every few seconds on the SAME peer. Without this guard, three such
// heavy timeouts in a row tear down a peer whose light traffic is flowing fine —
// classifying a slow command as a dead transport (the Windows health:degraded
// p2p_relay_failure misclassification). Sized to comfortably exceed the light-poll
// cadence (~4s observed) plus jitter so a genuinely live peer always trips it, yet
// short enough that a truly wedged peer (no traffic at all) still tears down after
// the window lapses. Env-overridable, clamped to a sane floor.
export const LIVENESS_PROOF_WINDOW_MS = (() => {
  const raw = process.env.MESH_RPC_LIVENESS_PROOF_WINDOW_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : 20_000;
})();

// ─── Peer state machine ─────────────────────────────────────────────────────

export type PeerState = 'connecting' | 'connected' | 'closing' | 'closed' | 'failed';

export interface PendingRpc {
  id: string;
  command: string;
  args: Record<string, unknown>;
  resolve: (val: unknown) => void;
  reject: (err: Error) => void;
  queuedAt: string;
  sentAt?: string;
  // Per-command result deadline; armed at write time, cleared on rpc_res. This is
  // the single safety net that always runs, so an old (no-ack) peer still degrades
  // gracefully — a slow-but-eventual result resolves before this fires.
  requestTimer?: NodeJS.Timeout;
  // Optional caller override of the result deadline.
  resultTimeoutMs: number;
  // Delivery (ack) deadline; armed at write time, cleared once an rpc_ack arrives.
  // Only rejects for peers proven to speak ack (see Peer.supportsAck) — otherwise
  // it is a no-op and the result deadline alone governs.
  ackTimer?: NodeJS.Timeout;
  acked?: boolean;
  // OFFLINE-NODE-FANOUT: per-request probe budget for the "channel not open yet"
  // wait. Armed only when this request is queued behind an unopened channel; cleared
  // the instant the request is written (flushConnectQueue → writeRequest) or the peer
  // is torn down (failPeer). When it fires it rejects ONLY this queued request with
  // PEER_NOT_CONNECTED and leaves the peer + its connectTimer + the background dial
  // untouched — so a fan-out probe to an offline node gives up in ~seconds instead of
  // inheriting the 90s CONNECT_TIMEOUT_MS, while the reconcile-driven retry keeps
  // running exactly as before.
  connectWaitTimer?: NodeJS.Timeout;
  connectWaitDeadlineAt?: number;
}

/**
 * The mesh RPC lane. Historically the only label this transport ever created,
 * and inbound channels were bound without inspecting their label at all. It is
 * now a named constant because a SECOND lane (seqscribe replication) shares the
 * same PeerConnection, which makes the label load-bearing: see the
 * `pc.onDataChannel` guard in ensurePeer.
 */
export const MESH_RPC_DATA_CHANNEL_LABEL = 'mesh_data';

/**
 * Observer for the mesh transport's peer lifecycle.
 *
 * `onPeerOpen` fires when a peer's RPC channel is open AND usable — for a relay
 * pair that means after the health probe confirms, not merely on `onOpen`, so a
 * subscriber never receives a peer that cannot actually carry data.
 * `onPeerClosed` fires exactly once per peer teardown, from the single
 * `failPeer` funnel that every failure path already goes through.
 */
export interface MeshPeerLifecycleListener {
  onPeerOpen(daemonId: string, connection: { createDataChannel(label: string): unknown }): void;
  onPeerClosed(daemonId: string): void;
}

export interface Peer {
  daemonId: string;
  role: 'initiator' | 'responder';
  state: PeerState;
  reason?: string;
  pc: any;
  dc: any;
  remoteDescriptionSet: boolean;
  pendingRemoteCandidates: Array<{ candidate: string; mid: string }>;
  // Requests issued before the channel opened — flushed on open, failed on connect-timeout.
  connectQueue: PendingRpc[];
  // Requests written to an open channel, keyed by request id, awaiting a response.
  inflight: Map<string, PendingRpc>;
  connectTimer?: NodeJS.Timeout;
  isRelay?: boolean;
  // Set true the first time this peer replies with an rpc_ack. Until then the
  // ack-deadline is treated as inert (graceful degrade for old daemons that never
  // ack). Once proven, an ack-timeout becomes a real delivery failure.
  supportsAck?: boolean;
  createdAt: string;
  openedAt?: string;
  lastCommandAt?: string;
  // Wall-clock of the most recent successful round trip on this peer — set on every
  // ack AND every response (either proves a live round trip). Distinct from
  // lastCommandAt (send-time, set before any reply). Read by noteRequestTimeout to
  // decide whether a request timeout reflects a dead transport (no recent success)
  // or merely a slow heavy command on a peer that is otherwise answering — the
  // "command-slow ≠ connection-dead" guard. See LIVENESS_PROOF_WINDOW_MS.
  lastSuccessAt?: number;
  // Consecutive request timeouts on this open peer with no intervening ack/response.
  // Reset to 0 on any ack or response (proof the link is alive). When it crosses
  // MAX_CONSECUTIVE_TIMEOUTS the peer is treated as transport-dead and torn down even
  // though node-datachannel never emitted a state change. See writeRequest's timeout.
  consecutiveTimeouts: number;
  // RELAY-DATA-STALL probe (P2P-1). Set when the post-open health probe is sent;
  // cleared the moment its probe_ack returns. The timer fires a relay-data-stall
  // teardown if no ack arrives. probeConfirmed marks a peer that already passed the
  // probe so it is never re-probed (or, for a direct pair, was never gated).
  probeId?: string;
  probeTimer?: NodeJS.Timeout;
  probeConfirmed?: boolean;
  // MESH-IMAGE-CHUNKING: reassembly state for oversized inbound frames. Created lazily
  // on the first chunk so a peer that never sends one costs nothing, and dropped with
  // the peer so a torn-down connection cannot leave partial frames pinned in memory.
  chunkAssembler?: MeshChunkAssembler;
  authEpoch: number;
  attempt: number;
  // P2P-RECONNECT-BACKOFF: set once this peer's DataChannel actually opened. A
  // connection that PROVED it works restarts the backoff ladder from the base
  // delay when it later drops, instead of inheriting the failure streak that
  // preceded it.
  connectionSucceeded?: boolean;
  remoteIncarnation?: string;
  acceptsCurrentRemoteEpoch?: boolean;
}

export interface PeerDiagnostic {
  state: PeerState;
  lastFailureCode?: string;
  lastFailureAt?: string;
  lastConnectedAt?: string;
  lastCommandAt?: string;
  nextRetryAt?: string;
  authEpoch: number;
  attempt: number;
  recoverable: boolean;
}

export interface FailureOptions {
  recoverable?: boolean;
  retryRecommended?: boolean;
  nextRetryAt?: string;
}

export const MAX_RETAINED_PEERS = 256;
// P2P-RECONNECT-BACKOFF: a recoverable peer failure schedules the next dial. The
// delay was a FLAT 4s, which is correct for a transient blip (WiFi handover, a short
// sleep) but pathological for a machine that is simply powered OFF: a permanently
// unreachable target was re-dialed every 4s forever — measured at 11,651 attempts /
// 0 successes in one day against one powered-down node, burning ~32% daemon CPU and
// relaying 45–95 ICE candidates per minute through the signaling server for nothing.
//
// So the delay now grows with the per-target attempt count while keeping the FIRST
// retry as fast as it ever was:
//   delay(attempt) = min(CAP, BASE * 2^(attempt-1)) - jitter
// 4s → 8s → 16s → 32s → 64s → 128s → 256s → 300s (capped from attempt 8 on).
//
// The cap is mandatory and deliberately modest: the whole point is that a machine
// which comes BACK reconnects on its own, so the worst-case wait after power-on is
// one cap interval. Unbounded growth would trade a retry storm for a node that never
// returns.
const RECOVERABLE_RETRY_BASE_DELAY_MS = 4_000;
const RECOVERABLE_RETRY_CAP_MS = 300_000;
// Jitter is subtractive (0 … 25% off the top) rather than additive so it can never
// push the first retry beyond the 4s the transient-blip case depends on. It matters
// because these peers fail in CORRELATED batches — a signaling-server hiccup or a
// laptop lid closing fails every peer at the same instant, and without jitter their
// backoffs stay phase-locked forever, reproducing the very thundering herd the cap
// is meant to defuse. Applied only from the second attempt on, so attempt 1 is
// exactly the historical 4s and stays trivially assertable.
const RECOVERABLE_RETRY_JITTER_RATIO = 0.25;

/**
 * Exponential backoff for the next recoverable reconnect, by PER-TARGET attempt
 * count. `attempt` is 1-based (the first attempt against a peer is 1) and is read
 * from that peer's own diagnostics, so one dead node's backoff can never slow a
 * different, healthy node's reconnect.
 */
export function computeRecoverableRetryDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const n = Number.isFinite(attempt) && attempt > 1 ? Math.floor(attempt) : 1;
  // 2^(n-1) via shift-free math; clamp the exponent so a long-lived dead peer
  // cannot overflow into Infinity before the cap is applied.
  const growth = Math.min(2 ** Math.min(n - 1, 32), RECOVERABLE_RETRY_CAP_MS);
  const base = Math.min(RECOVERABLE_RETRY_BASE_DELAY_MS * growth, RECOVERABLE_RETRY_CAP_MS);
  if (n === 1) return base;
  const jitter = base * RECOVERABLE_RETRY_JITTER_RATIO * random();
  return Math.max(RECOVERABLE_RETRY_BASE_DELAY_MS, Math.round(base - jitter));
}
export const STRUCTURED_P2P_UNAVAILABLE_CODES = new Set([
  'NO_TRANSPORT',
  'NO_PEER',
  'PEER_FAILED',
  'SEND_FAILED',
  'QUEUE_OVERFLOW',
  'SIGNAL_RATE_LIMIT',
  'SIGNAL_RELAY_FAILED',
  'AUTH_EPOCH_REBIND',
  'REMOTE_AUTH_EPOCH_CHANGED',
  'LOCAL_AUTH_EPOCH_CHANGED',
  // PEER-CLOSE-REASON: these replace what used to be the generic PEER_FAILED
  // default at their call sites (pc.onStateChange 'failed' mid-handshake, and a
  // failed setRemoteDescription) — same public error contract (p2p_unavailable),
  // just a more specific meshCode for logs/diagnostics.
  'PC_STATE_FAILED',
  'SIGNAL_DESCRIPTION_FAILED',
  'MANAGER_SHUTDOWN',
]);

/**
 * The structured [MeshCommand] log line. Routed by level so the ~4s reconcile polls
 * don't drown the log: a NORMAL sent/ack for a high-frequency poll command → DEBUG
 * (recoverable via logLevel=debug); every other command, and every error/anomaly
 * event even for a poll command, stays at INFO.
 */
export function logMeshCommandEvent(event: string, fields: Record<string, unknown>): void {
  // Route the level so the ~4s reconcile polls don't drown the log: a NORMAL
  // sent/ack for a high-frequency poll command → DEBUG (recoverable via
  // logLevel=debug, suppressed under the prod default INFO). Everything else —
  // any other command, and every error/anomaly event even for a poll command —
  // stays at INFO for diagnostic value.
  const command = typeof fields.command === 'string' ? fields.command : undefined;
  const responseSucceeded = (event === 'response_sent' || event === 'response_received')
    ? fields.ok === true
    : true;
  const demote = NORMAL_MESH_EVENTS.has(event) && responseSucceeded
    && !!command && NOISY_POLL_COMMANDS.has(command);
  const emit = demote ? LOG.debug.bind(LOG) : LOG.info.bind(LOG);
  try {
    emit('Mesh', `[MeshCommand] ${JSON.stringify({ event, ...fields })}`);
  } catch {
    emit('Mesh', `[MeshCommand] ${event}`);
  }
}

export function toMeshPeerSnapshotState(state: PeerState): MeshPeerConnectionState {
  switch (state) {
    case 'connecting': return 'connecting';
    case 'connected': return 'connected';
    case 'closing': return 'disconnected';
    case 'closed': return 'closed';
    case 'failed': return 'failed';
  }
}
