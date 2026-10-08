// WsMeshTransport — the standalone daemon's daemon↔daemon mesh RPC transport over a
// direct WebSocket (design: docs/design/2026-10-07-standalone-multi-machine-mesh.md
// §4.2). It is the WebSocket sibling of the cloud daemon's WebRTC DaemonMeshManager:
// both extend MeshRpcEndpoint, so request ids, rpc_req / rpc_ack / rpc_res framing,
// chunking and the settled-id memory are shared code. What lives here is the peer
// lifecycle only:
//
//   - MEMBER side (dial): addHostLink() dials ws://<host>/ws/mesh, runs the mutual
//     HMAC handshake (mesh-peer-handshake.ts) as initiator, and on success attaches
//     the socket to the host's peer entry. A dropped or failed dial is retried with
//     computeRecoverableRetryDelayMs (4s → … → 300s cap); the ladder restarts after a
//     connection that actually opened.
//   - HOST side (accept): the standalone server runs the responder handshake on the
//     upgraded socket and hands it to acceptPeerSocket(). The host never dials.
//
// Peers are keyed by canonical daemon id (`daemon_mach_<core>`). A peer can hold more
// than one socket ("attachment") at once — one per (direction, meshId) — because two
// daemons can each host a mesh the other is a member of. A new socket only REPLACES
// an older one in the same slot; a socket in a different slot is added alongside.
// Without that, the two cross links would keep replacing each other forever.
//
// sendCommand mirrors the cloud contract: same signature, same meshCodes
// (SELF_DIAL, QUEUE_OVERFLOW, PEER_NOT_CONNECTED, REQUEST_TIMEOUT, ACK_TIMEOUT, …)
// surfaced as P2pRelayFailureError, same connectWaitMs probe budget, same
// consecutive-timeout liveness teardown. Secrets are never logged.

import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { canonicalDaemonId, daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { LOG } from '../../logging/logger.js';
import { loadConfig } from '../../config/config.js';
import { P2pRelayFailureError } from '../p2p-relay-failure.js';
import { MeshRpcEndpoint } from './mesh-rpc-endpoint.js';
import { maskDaemonId } from './mask-daemon-id.js';
import { summarizeMeshCommandArgs } from './mesh-command-summarizer.js';
import { performMeshHandshake, MeshHandshakeError } from './mesh-peer-handshake.js';
import { resultTimeoutForCommand } from './mesh-rpc-timeouts.js';
import type { MeshPeerSnapshot } from './mesh-peer-types.js';
import { MESH_RPC_WS_PATH, meshHostWsUrl } from '../../shared/mesh-host-endpoints.js';
import {
    CONNECT_TIMEOUT_MS,
    LIVENESS_PROOF_WINDOW_MS,
    MAX_CONNECT_QUEUE,
    MAX_CONSECUTIVE_TIMEOUTS,
    MAX_RETAINED_PEERS,
    STRUCTURED_P2P_UNAVAILABLE_CODES,
    classifyPeerCloseReason,
    computeRecoverableRetryDelayMs,
    toMeshPeerSnapshotState,
    type FailureOptions,
    type MeshPeerLifecycleListener,
    type PendingRpc,
    type Peer,
    type PeerDiagnostic,
    type PeerState,
} from './mesh-rpc-protocol.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default WebSocket path of the mesh RPC lane on a standalone host (alias of shared MESH_RPC_WS_PATH). */
export const WS_MESH_RPC_PATH = MESH_RPC_WS_PATH;
/** Liveness: a ws ping is sent this often on every attached socket. */
export const WS_MESH_PING_INTERVAL_MS = 20_000;
/** Liveness: this many unanswered pings in a row terminate the socket. */
export const WS_MESH_MAX_MISSED_PONGS = 2;
/** Close code for a socket superseded by a newer one in the same slot. */
export const WS_MESH_CLOSE_REPLACED = 4409;
/** Close code for an explicit disconnect (revocation, link removal). */
export const WS_MESH_CLOSE_DISCONNECTED = 4000;
/** Close code when the transport shuts down. */
export const WS_MESH_CLOSE_SHUTDOWN = 1001;
/** Close code for a socket refused at accept time (self, or after shutdown). */
export const WS_MESH_CLOSE_REFUSED = 4403;

// Inbound frame ceiling on dialed sockets. Every frame that exceeds the mesh chunk
// threshold is split by MeshRpcEndpoint into ~16k-character chunks, so a legitimate
// frame never comes near this; it only bounds a misbehaving peer.
const WS_MESH_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

const WS_OPEN = 1;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WsMeshTransportOptions {
    /** This daemon's id (any form). Defaults to `daemon_<machineId>` from config. */
    localDaemonId?: string;
    /** Redial delay by consecutive-failure count (1-based). Default computeRecoverableRetryDelayMs. */
    retryDelayMs?: (attempt: number) => number;
    /** Member-side handshake budget per dial. Default the handshake module's 5s. */
    handshakeTimeoutMs?: number;
    /** Liveness ping cadence per socket. Default 20s. */
    pingIntervalMs?: number;
    /** Unanswered pings before a socket is terminated. Default 2. */
    maxMissedPongs?: number;
    /** How long a peer with no socket keeps its queue before CONNECT_TIMEOUT. Default CONNECT_TIMEOUT_MS. */
    connectTimeoutMs?: number;
}

export interface WsMeshHostLink {
    meshId: string;
    /** The host daemon's id (any form). */
    hostDaemonId: string;
    /** Full ws:// or wss:// URL of the host's mesh endpoint. */
    url: string;
    /** The pairing secret shared with this host for this mesh. Never logged. */
    secret: string;
}

export interface WsMeshAcceptedPeer {
    meshId: string;
    /** The daemon id the responder handshake proved (any form). */
    peerDaemonId: string;
}

export interface WsMeshPeerSummary {
    daemonId: string;
    state: PeerState;
    /** 'initiator' when this daemon dialed the newest socket, 'responder' when it accepted it. */
    role: 'initiator' | 'responder';
    meshIds: string[];
}

type Direction = 'outbound' | 'inbound';

interface Attachment {
    key: string;
    direction: Direction;
    meshId: string;
    ws: WebSocket;
    link?: HostLink;
    attachedAt: number;
    missedPongs: number;
    pingTimer?: NodeJS.Timeout;
    /** Set when this side terminated the socket for missing pongs. */
    livenessLost?: boolean;
}

interface WsPeer extends Peer {
    attachments: Map<string, Attachment>;
    /** Set once failPeer ran, so a late socket event cannot tear it down twice. */
    torn?: boolean;
}

interface HostLink {
    key: string;
    meshId: string;
    /** Canonical host daemon id. */
    hostDaemonId: string;
    url: string;
    secret: string;
    ws?: WebSocket;
    stopped: boolean;
    /** Consecutive failed dials / dropped connections since the last opened one. */
    failures: number;
    redialTimer?: NodeJS.Timeout;
    nextRetryAt?: string;
    lastFailureCode?: string;
    lastFailureAt?: string;
    lastConnectedAt?: string;
}

/**
 * Build the mesh endpoint URL from a stored host address: `ip:port`,
 * `hostname:port`, `[v6]:port`, a bare IPv6 literal, or an http(s)/ws(s) URL
 * (http→ws, https→wss; any path is replaced by `path`).
 */
export function meshWsUrlForHostAddress(hostAddress: string, path: string = MESH_RPC_WS_PATH): string {
    return meshHostWsUrl(hostAddress, path);
}

function canon(id: string): string {
    return canonicalDaemonId(id) ?? id.trim();
}

function rawToMessage(data: WebSocket.RawData): string | Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data)) return Buffer.concat(data);
    return Buffer.from(data as ArrayBuffer);
}

/** A handshake frame (kind `mesh_*`) that was buffered alongside the RPC frames. */
function isHandshakeFrame(data: WebSocket.RawData): boolean {
    try {
        const parsed = JSON.parse(rawToMessage(data).toString('utf8'));
        return typeof parsed?.kind === 'string' && parsed.kind.startsWith('mesh_');
    } catch {
        return false;
    }
}

// ─── Transport ────────────────────────────────────────────────────────────────

export class WsMeshTransport extends MeshRpcEndpoint {
    private readonly localDaemonId: string;
    private readonly retryDelayMs: (attempt: number) => number;
    private readonly handshakeTimeoutMs: number | undefined;
    private readonly pingIntervalMs: number;
    private readonly maxMissedPongs: number;
    private readonly connectTimeoutMs: number;

    private peers = new Map<string, WsPeer>();
    private links = new Map<string, HostLink>();
    private peerDiagnostics = new Map<string, PeerDiagnostic>();
    private peerLifecycleListeners = new Set<MeshPeerLifecycleListener>();
    private announcedOpenPeers = new Set<string>();
    private closed = false;

    constructor(options: WsMeshTransportOptions = {}) {
        super();
        const configured = options.localDaemonId ?? (() => {
            const machineId = loadConfig().machineId;
            return machineId ? `daemon_${machineId}` : '';
        })();
        this.localDaemonId = configured ? canon(configured) : '';
        this.retryDelayMs = options.retryDelayMs ?? ((attempt) => computeRecoverableRetryDelayMs(attempt));
        this.handshakeTimeoutMs = options.handshakeTimeoutMs;
        this.pingIntervalMs = options.pingIntervalMs ?? WS_MESH_PING_INTERVAL_MS;
        this.maxMissedPongs = options.maxMissedPongs ?? WS_MESH_MAX_MISSED_PONGS;
        this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
        // Request / chunk ids only have to be unique per sender; the random suffix keeps
        // two transports in one process (tests, embedding) from sharing a prefix.
        this.idNonce = `${this.idNonce}_${randomBytes(3).toString('hex')}`;
    }

    // ─── Public API ─────────────────────────────────────────────────────────────

    /** Register the inbound-command handler. It returns a result or throws. */
    public onCommand(
        callback: (senderDaemonId: string, command: string, args: Record<string, unknown>) => Promise<unknown>,
    ): void {
        this.commandCallback = callback;
    }

    /**
     * Subscribe to peer open/close. A peer is "open" once at least one socket is
     * attached; it closes when its last socket goes (or it is torn down). Peers that
     * are already open are replayed to a late subscriber. Returns an unsubscribe.
     */
    public onPeerLifecycle(listener: MeshPeerLifecycleListener): () => void {
        this.peerLifecycleListeners.add(listener);
        for (const peer of this.peers.values()) {
            if (peer.state === 'connected') {
                this.announcedOpenPeers.add(peer.daemonId);
                try { listener.onPeerOpen(peer.daemonId, this.connectionHandle(peer)); } catch { /* listener owns its errors */ }
            }
        }
        return () => { this.peerLifecycleListeners.delete(listener); };
    }

    /**
     * MEMBER side: keep a link to a mesh host. Dials now and redials with backoff
     * whenever the socket drops or the handshake fails, until removeHostLink/close.
     * Re-adding the same (mesh, host) with the same url and secret is a no-op; with a
     * different url or secret the old link is replaced.
     */
    public addHostLink(link: WsMeshHostLink): void {
        if (this.closed) throw new Error('WsMeshTransport is closed');
        const meshId = typeof link.meshId === 'string' ? link.meshId.trim() : '';
        const hostDaemonId = typeof link.hostDaemonId === 'string' ? canon(link.hostDaemonId) : '';
        if (!meshId || !hostDaemonId) throw new Error('addHostLink requires meshId and hostDaemonId');
        if (typeof link.url !== 'string' || !/^wss?:\/\//i.test(link.url)) throw new Error('addHostLink requires a ws:// or wss:// url');
        if (typeof link.secret !== 'string' || !link.secret) throw new Error('addHostLink requires a secret');
        if (this.isSelfDial(hostDaemonId)) throw new Error('addHostLink refused: the host is this daemon');

        const key = `${meshId}|${hostDaemonId}`;
        const existing = this.links.get(key);
        if (existing && existing.url === link.url && existing.secret === link.secret) return;
        if (existing) this.stopLink(existing, 'Mesh host link replaced');

        const fresh: HostLink = { key, meshId, hostDaemonId, url: link.url, secret: link.secret, stopped: false, failures: 0 };
        this.links.set(key, fresh);
        this.logEvent('link_added', { targetDaemonId: hostDaemonId, meshId });
        this.dial(fresh);
    }

    /**
     * MEMBER side: stop dialing a host and close its socket(s). With `meshId`, only
     * that mesh's link is removed; without it, every link to the host. Returns
     * whether any link existed.
     */
    public removeHostLink(hostDaemonId: string, meshId?: string): boolean {
        const host = canon(hostDaemonId);
        let removed = false;
        for (const link of Array.from(this.links.values())) {
            if (!daemonIdsEquivalent(link.hostDaemonId, host)) continue;
            if (meshId !== undefined && link.meshId !== meshId) continue;
            this.stopLink(link, 'Mesh host link removed');
            removed = true;
        }
        return removed;
    }

    /**
     * HOST side: adopt a socket whose responder handshake already succeeded. Call it
     * in the handshake's continuation, without awaiting anything else first, so no
     * RPC frame can arrive while the socket has no message listener. A socket for a
     * member that already has one in the same mesh replaces it (the old one is
     * closed with WS_MESH_CLOSE_REPLACED and its requests are failed recoverably).
     */
    public acceptPeerSocket(ws: WebSocket, accepted: WsMeshAcceptedPeer): void {
        const peerDaemonId = typeof accepted?.peerDaemonId === 'string' ? canon(accepted.peerDaemonId) : '';
        const meshId = typeof accepted?.meshId === 'string' ? accepted.meshId : '';
        if (this.closed || !peerDaemonId || !meshId || this.isSelfDial(peerDaemonId)) {
            try { ws.close(WS_MESH_CLOSE_REFUSED, this.closed ? 'shutdown' : 'refused'); } catch { /* already closed */ }
            return;
        }
        if (ws.readyState !== WS_OPEN) return;
        this.attachSocket(peerDaemonId, ws, 'inbound', meshId, undefined, []);
    }

    /**
     * Tear down every socket to a peer now (e.g. its pairing was revoked) and fail
     * its requests with PEER_DISCONNECTED. A host link to it keeps redialing — call
     * removeHostLink to stop that. Returns whether a peer existed.
     */
    public disconnectPeer(daemonId: string, reason = 'Mesh peer disconnected'): boolean {
        const peer = this.peers.get(canon(daemonId));
        if (!peer) return false;
        this.failPeer(peer, reason, 'closed', 'PEER_DISCONNECTED', {}, WS_MESH_CLOSE_DISCONNECTED);
        return true;
    }

    /** Send a mesh command to a peer daemon and resolve with its result. Rejects with
     *  a P2pRelayFailureError on any transport or handler failure. `connectWaitMs`
     *  bounds only the "no open socket yet" wait of THIS request (PEER_NOT_CONNECTED),
     *  leaving the peer and any redial untouched; omit it to wait the full connect
     *  deadline. */
    public sendCommand(
        targetDaemonId: string,
        command: string,
        args: Record<string, unknown> = {},
        timeoutMs?: number,
        connectWaitMs?: number,
    ): Promise<unknown> {
        const target = typeof targetDaemonId === 'string' ? canon(targetDaemonId) : '';
        if (this.closed) {
            return Promise.reject(this.failure('Mesh transport is shut down', command, target, 'MANAGER_SHUTDOWN'));
        }
        if (!target) {
            return Promise.reject(this.failure('Mesh command needs a target daemon id', command, target, 'NO_PEER'));
        }
        if (this.isSelfDial(target)) {
            return Promise.reject(this.failure(
                `Refusing to send mesh command '${command}' to this daemon's own id; route via the local router instead.`,
                command, target, 'SELF_DIAL',
            ));
        }

        const isBackgroundPoll = typeof connectWaitMs === 'number' && Number.isFinite(connectWaitMs) && connectWaitMs > 0;
        const retained = this.peerDiagnostics.get(target);
        if (!this.peers.has(target) && retained) {
            // Same gate as the cloud transport: background polls do not pile onto a peer
            // that just dropped while its reconnect is scheduled; a targeted command does.
            const retryAt = retained.nextRetryAt ? Date.parse(retained.nextRetryAt) : NaN;
            const retryBlocked = isBackgroundPoll && Number.isFinite(retryAt) && retryAt > Date.now();
            if (!retained.recoverable || retryBlocked) {
                return Promise.reject(this.failure(
                    retained.recoverable
                        ? 'Mesh peer connection dropped; reconnect is already scheduled.'
                        : 'Mesh peer was definitively rejected.',
                    command, target, retained.lastFailureCode || 'PEER_NOT_CONNECTED',
                    { recoverable: retained.recoverable, retryRecommended: retained.recoverable, nextRetryAt: retained.nextRetryAt },
                ));
            }
        }

        const peer = this.getOrCreatePeer(target, 'initiator', 'demand');
        peer.lastCommandAt = new Date().toISOString();

        return new Promise<unknown>((resolve, reject) => {
            const id = `${this.idNonce}:${this.idSeq++}`;
            const resultTimeoutMs = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
                ? timeoutMs
                : resultTimeoutForCommand(command);
            const pending: PendingRpc = { id, command, args, resolve, reject, queuedAt: new Date().toISOString(), resultTimeoutMs };

            if (peer.state === 'connected' && peer.dc.isOpen()) {
                this.writeRequest(peer, pending);
                return;
            }
            if (peer.connectQueue.length >= MAX_CONNECT_QUEUE) {
                reject(this.failure(
                    `Mesh connect queue full (${MAX_CONNECT_QUEUE}) for ${maskDaemonId(target)}; peer is not connecting fast enough.`,
                    command, target, 'QUEUE_OVERFLOW',
                ));
                return;
            }
            this.logEvent('queued', {
                requestId: id, command, targetDaemonId: target, queuedAt: pending.queuedAt,
                peerState: peer.state, argsSummary: summarizeMeshCommandArgs(command, args),
                attempt: peer.attempt, joinedInflightConnect: peer.state === 'connecting',
                connectAgeMs: Date.now() - Date.parse(peer.createdAt),
            });
            peer.connectQueue.push(pending);
            if (isBackgroundPoll) {
                pending.connectWaitDeadlineAt = Date.now() + (connectWaitMs as number);
                this.armConnectWait(peer, pending);
            }
        });
    }

    /** Connection authority for one peer: live state, else the host link's dial
     *  state, else the bounded terminal diagnostic. Null when nothing is known. */
    public getPeerConnectionStatus(targetDaemonId: string): MeshPeerSnapshot | null {
        const target = canon(targetDaemonId);
        const link = this.linkForHost(target);
        const peer = this.peers.get(target);
        if (peer) {
            const liveAt = peer.openedAt ?? peer.createdAt;
            return {
                perspective: 'selected_coordinator',
                source: 'mesh_peer_status',
                reported: true,
                state: toMeshPeerSnapshotState(peer.state),
                transport: 'direct',
                directPeerTruthSatisfied: peer.state === 'connected' && peer.dc.isOpen(),
                authority: 'live_peer',
                cached: false,
                ageMs: Math.max(0, Date.now() - Date.parse(liveAt)),
                reason: peer.reason,
                lastStateChangeAt: liveAt,
                lastConnectedAt: peer.openedAt ?? link?.lastConnectedAt,
                lastCommandAt: peer.lastCommandAt,
                ...(peer.state !== 'connected' && link?.lastFailureCode
                    ? { lastFailureCode: link.lastFailureCode, lastFailureAt: link.lastFailureAt, nextRetryAt: link.nextRetryAt }
                    : {}),
                attempt: peer.attempt,
                authEpoch: 0,
                linkIsPresence: true,
            };
        }
        const diagnostic = this.peerDiagnostics.get(target);
        if (link) {
            const dialing = !!link.ws;
            const handshakeRejected = !dialing && !!link.lastFailureCode?.startsWith('HANDSHAKE_');
            const state = dialing ? 'connecting' : handshakeRejected ? 'failed' : 'disconnected';
            const lastStateChangeAt = link.lastFailureAt ?? link.lastConnectedAt ?? new Date().toISOString();
            return {
                perspective: 'selected_coordinator',
                source: 'mesh_peer_status',
                reported: true,
                state,
                transport: 'direct',
                directPeerTruthSatisfied: false,
                authority: 'cached_terminal_diagnostic',
                cached: true,
                ageMs: Math.max(0, Date.now() - Date.parse(lastStateChangeAt)),
                reason: dialing
                    ? 'Dialing the mesh host.'
                    : handshakeRejected
                        ? 'The mesh host rejected the pairing handshake; redial is scheduled.'
                        : 'The mesh host is unreachable; redial is scheduled.',
                lastStateChangeAt,
                lastConnectedAt: link.lastConnectedAt ?? diagnostic?.lastConnectedAt,
                lastCommandAt: diagnostic?.lastCommandAt,
                lastFailureCode: link.lastFailureCode,
                lastFailureAt: link.lastFailureAt,
                attempt: link.failures,
                nextRetryAt: link.nextRetryAt,
                authEpoch: 0,
                linkIsPresence: true,
            };
        }
        if (!diagnostic) return null;
        const lastStateChangeAt = diagnostic.lastFailureAt ?? diagnostic.lastConnectedAt ?? new Date().toISOString();
        return {
            perspective: 'selected_coordinator',
            source: 'mesh_peer_status',
            reported: true,
            state: toMeshPeerSnapshotState(diagnostic.state),
            transport: 'direct',
            directPeerTruthSatisfied: false,
            authority: 'cached_terminal_diagnostic',
            cached: true,
            ageMs: Math.max(0, Date.now() - Date.parse(lastStateChangeAt)),
            reason: 'Last mesh connection ended; cached metadata is not live peer authority.',
            lastStateChangeAt,
            lastConnectedAt: diagnostic.lastConnectedAt,
            lastCommandAt: diagnostic.lastCommandAt,
            lastFailureCode: diagnostic.lastFailureCode,
            lastFailureAt: diagnostic.lastFailureAt,
            attempt: diagnostic.attempt,
            nextRetryAt: diagnostic.nextRetryAt,
            authEpoch: diagnostic.authEpoch,
            linkIsPresence: true,
        };
    }

    /** Every live peer entry (connecting or connected). */
    public listPeers(): WsMeshPeerSummary[] {
        return Array.from(this.peers.values()).map((peer) => {
            const newest = this.newestAttachment(peer);
            return {
                daemonId: peer.daemonId,
                state: peer.state,
                role: newest ? (newest.direction === 'outbound' ? 'initiator' : 'responder') : peer.role,
                meshIds: Array.from(new Set(Array.from(peer.attachments.values()).map((a) => a.meshId))),
            };
        });
    }

    /** Stop every link and timer, fail every queued and inflight request with
     *  MANAGER_SHUTDOWN, and close every socket. Idempotent. */
    public close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const link of Array.from(this.links.values())) this.stopLink(link, 'Mesh transport shutting down', true);
        for (const peer of Array.from(this.peers.values())) {
            this.failPeer(peer, 'Mesh transport shutting down', 'closed', 'MANAGER_SHUTDOWN', {}, WS_MESH_CLOSE_SHUTDOWN);
        }
        this.peers.clear();
    }

    // ─── Member side: dialing ───────────────────────────────────────────────────

    private dial(link: HostLink): void {
        if (link.stopped || this.closed || link.ws) return;
        this.logEvent('connect_begin', { targetDaemonId: link.hostDaemonId, meshId: link.meshId, attempt: link.failures + 1, role: 'initiator' });
        let ws: WebSocket;
        try {
            ws = new WebSocket(link.url, { perMessageDeflate: false, maxPayload: WS_MESH_MAX_PAYLOAD_BYTES });
        } catch (err: any) {
            LOG.warn('Mesh', `[Mesh] Cannot dial mesh host ${maskDaemonId(link.hostDaemonId)}: ${err?.message || err}`);
            this.scheduleRedial(link, 'DIAL_FAILED');
            return;
        }
        link.ws = ws;
        // Owned for the socket's whole life: `ws` throws on an 'error' with no listener.
        ws.on('error', (err) => {
            LOG.debug('Mesh', `[Mesh] mesh socket error (${maskDaemonId(link.hostDaemonId)}): ${err?.message || err}`);
        });
        // Registered BEFORE the handshake's own listener: frames that arrive in the
        // same tick as mesh_ok (after the handshake detached) are kept, not lost.
        const early: WebSocket.RawData[] = [];
        const onEarly = (data: WebSocket.RawData): void => { early.push(data); };
        ws.on('message', onEarly);

        performMeshHandshake(ws, 'initiator', {
            meshId: link.meshId,
            daemonId: this.localDaemonId,
            serverDaemonIdExpected: link.hostDaemonId,
            secret: link.secret,
        }, this.handshakeTimeoutMs).then(() => {
            ws.off('message', onEarly);
            if (link.stopped || this.closed || link.ws !== ws) {
                try { ws.close(1000, 'link_stopped'); } catch { /* already closed */ }
                if (link.ws === ws) link.ws = undefined;
                return;
            }
            if (ws.readyState !== WS_OPEN) {
                link.ws = undefined;
                this.scheduleRedial(link, 'DIAL_FAILED');
                return;
            }
            link.failures = 0;
            link.nextRetryAt = undefined;
            link.lastFailureCode = undefined;
            link.lastFailureAt = undefined;
            link.lastConnectedAt = new Date().toISOString();
            this.attachSocket(link.hostDaemonId, ws, 'outbound', link.meshId, link, early.filter((d) => !isHandshakeFrame(d)));
        }, (err: unknown) => {
            ws.off('message', onEarly);
            if (link.ws === ws) link.ws = undefined;
            const code = err instanceof MeshHandshakeError ? err.code : 'socket_closed';
            const failureCode = code === 'socket_closed' ? 'DIAL_FAILED' : `HANDSHAKE_${code.toUpperCase()}`;
            this.logEvent('dial_failed', { targetDaemonId: link.hostDaemonId, meshId: link.meshId, code: failureCode, attempt: link.failures + 1 });
            this.scheduleRedial(link, failureCode);
        });
    }

    private scheduleRedial(link: HostLink, failureCode: string): void {
        link.lastFailureCode = failureCode;
        link.lastFailureAt = new Date().toISOString();
        if (link.stopped || this.closed || link.redialTimer) return;
        link.failures += 1;
        const delay = Math.max(0, this.retryDelayMs(link.failures));
        link.nextRetryAt = new Date(Date.now() + delay).toISOString();
        link.redialTimer = setTimeout(() => {
            link.redialTimer = undefined;
            link.nextRetryAt = undefined;
            this.dial(link);
        }, delay);
        if (typeof link.redialTimer.unref === 'function') link.redialTimer.unref();
    }

    private stopLink(link: HostLink, reason: string, shuttingDown = false): void {
        link.stopped = true;
        if (link.redialTimer) { clearTimeout(link.redialTimer); link.redialTimer = undefined; }
        link.nextRetryAt = undefined;
        if (this.links.get(link.key) === link) this.links.delete(link.key);
        const ws = link.ws;
        link.ws = undefined;
        // An attached link socket is released through its peer so the peer only fails
        // when it was the last socket; a still-handshaking one is just closed.
        for (const peer of this.peers.values()) {
            for (const attachment of Array.from(peer.attachments.values())) {
                if (attachment.link !== link) continue;
                if (shuttingDown) continue; // close() fails the whole peer right after
                this.releaseAttachment(peer, attachment, reason, 'LINK_REMOVED', WS_MESH_CLOSE_DISCONNECTED);
            }
        }
        if (ws && ws.readyState !== WebSocket.CLOSED) {
            try { ws.close(shuttingDown ? WS_MESH_CLOSE_SHUTDOWN : 1000, 'link_removed'); } catch { /* already closed */ }
        }
        this.logEvent('link_removed', { targetDaemonId: link.hostDaemonId, meshId: link.meshId });
    }

    private linkForHost(hostDaemonId: string): HostLink | undefined {
        let found: HostLink | undefined;
        for (const link of this.links.values()) {
            if (!daemonIdsEquivalent(link.hostDaemonId, hostDaemonId)) continue;
            // Prefer the link that is dialing right now, as the most current signal.
            if (!found || (link.ws && !found.ws)) found = link;
        }
        return found;
    }

    // ─── Peers and sockets ──────────────────────────────────────────────────────

    private getOrCreatePeer(daemonId: string, role: 'initiator' | 'responder', cause: string): WsPeer {
        const existing = this.peers.get(daemonId);
        if (existing && !existing.torn && (existing.state === 'connecting' || existing.state === 'connected')) return existing;
        if (existing) this.peers.delete(daemonId);

        const peer: WsPeer = {
            daemonId,
            role,
            state: 'connecting',
            reason: this.linkForHost(daemonId)
                ? 'Dialing the mesh host.'
                : 'Waiting for the peer daemon to connect to this host.',
            pc: null,
            dc: null,
            remoteDescriptionSet: false,
            pendingRemoteCandidates: [],
            connectQueue: [],
            inflight: new Map(),
            createdAt: new Date().toISOString(),
            consecutiveTimeouts: 0,
            authEpoch: 0,
            attempt: (this.peerDiagnostics.get(daemonId)?.attempt ?? 0) + 1,
            isRelay: false,
            attachments: new Map(),
        };
        peer.dc = {
            sendMessage: (json: string) => {
                const attachment = this.newestAttachment(peer, true);
                if (!attachment) throw new Error('mesh WebSocket is not open');
                attachment.ws.send(json);
            },
            isOpen: () => !!this.newestAttachment(peer, true),
            close: () => { /* sockets are closed by failPeer */ },
        };
        this.peers.set(daemonId, peer);
        this.logEvent('peer_created', { targetDaemonId: daemonId, attempt: peer.attempt, cause });

        // Bounds how long requests may queue while no socket exists. Never fires once
        // a socket is attached (the timer is cleared there).
        peer.connectTimer = setTimeout(() => {
            if (peer.state === 'connecting') {
                this.failPeer(peer, `Mesh peer did not connect within ${this.connectTimeoutMs}ms`, 'failed', 'CONNECT_TIMEOUT');
            }
        }, this.connectTimeoutMs);
        if (typeof peer.connectTimer.unref === 'function') peer.connectTimer.unref();
        return peer;
    }

    private newestAttachment(peer: WsPeer, openOnly = false): Attachment | undefined {
        let best: Attachment | undefined;
        for (const attachment of peer.attachments.values()) {
            if (openOnly && attachment.ws.readyState !== WS_OPEN) continue;
            if (!best || attachment.attachedAt >= best.attachedAt) best = attachment;
        }
        return best;
    }

    private attachSocket(
        daemonId: string,
        ws: WebSocket,
        direction: Direction,
        meshId: string,
        link: HostLink | undefined,
        earlyFrames: WebSocket.RawData[],
    ): void {
        let peer = this.getOrCreatePeer(daemonId, direction === 'outbound' ? 'initiator' : 'responder', 'socket');
        const key = `${direction}|${meshId}`;
        if (peer.attachments.has(key)) {
            // A newer socket for the same slot (the member reconnected, or its process
            // restarted): this is a new connection, so the old peer is torn down — its
            // inflight requests fail recoverably — and a fresh one takes the socket.
            this.logEvent('peer_replaced', { targetDaemonId: daemonId, meshId, direction });
            this.failPeer(peer, 'Mesh peer connection replaced by a newer connection', 'closed', 'PEER_REPLACED', {}, WS_MESH_CLOSE_REPLACED);
            peer = this.getOrCreatePeer(daemonId, direction === 'outbound' ? 'initiator' : 'responder', 'replacement');
        }

        const attachment: Attachment = { key, direction, meshId, ws, link, attachedAt: Date.now(), missedPongs: 0 };
        peer.attachments.set(key, attachment);

        if (direction === 'inbound') {
            // The handshake helper removed its listeners; keep one so `ws` never throws.
            ws.on('error', (err) => {
                LOG.debug('Mesh', `[Mesh] mesh socket error (${maskDaemonId(daemonId)}): ${err?.message || err}`);
            });
        }
        ws.on('message', (data: WebSocket.RawData) => {
            attachment.missedPongs = 0;
            if (peer.attachments.get(key) !== attachment) return;
            this.onMessage(peer, rawToMessage(data));
        });
        ws.on('pong', () => { attachment.missedPongs = 0; });
        ws.on('close', (code: number) => this.onSocketClosed(peer, attachment, code));

        attachment.pingTimer = setInterval(() => this.pingAttachment(peer, attachment), this.pingIntervalMs);
        if (typeof attachment.pingTimer.unref === 'function') attachment.pingTimer.unref();

        this.logEvent('socket_attached', {
            targetDaemonId: daemonId, meshId, direction, sockets: peer.attachments.size,
            queuedRequests: peer.connectQueue.length,
        });

        for (const frame of earlyFrames) this.onMessage(peer, rawToMessage(frame));

        if (peer.state !== 'connected') {
            peer.state = 'connected';
            peer.openedAt = new Date().toISOString();
            peer.reason = 'Connected directly over WebSocket.';
            peer.probeConfirmed = true;
            peer.connectionSucceeded = true;
            if (peer.connectTimer) { clearTimeout(peer.connectTimer); peer.connectTimer = undefined; }
            this.peerDiagnostics.delete(daemonId);
            this.peerDiagnostics.set(daemonId, {
                state: 'connected',
                lastConnectedAt: peer.openedAt,
                lastCommandAt: peer.lastCommandAt,
                authEpoch: 0,
                attempt: 0,
                recoverable: true,
            });
            this.trimOldest(this.peerDiagnostics);
            this.logEvent('dc_open', {
                targetDaemonId: daemonId, attempt: peer.attempt, transport: 'direct', meshId, direction,
                connectMs: Date.now() - Date.parse(peer.createdAt), queuedRequests: peer.connectQueue.length,
            });
            this.emitPeerOpen(peer);
        }
        this.flushConnectQueue(peer);
    }

    private pingAttachment(peer: WsPeer, attachment: Attachment): void {
        if (peer.attachments.get(attachment.key) !== attachment) {
            if (attachment.pingTimer) { clearInterval(attachment.pingTimer); attachment.pingTimer = undefined; }
            return;
        }
        if (attachment.missedPongs >= this.maxMissedPongs) {
            attachment.livenessLost = true;
            this.logEvent('liveness_lost', {
                targetDaemonId: peer.daemonId, meshId: attachment.meshId, missedPongs: attachment.missedPongs,
            });
            if (attachment.pingTimer) { clearInterval(attachment.pingTimer); attachment.pingTimer = undefined; }
            try { attachment.ws.terminate(); } catch { /* already gone */ }
            // 'close' follows asynchronously; release now so no request is written into
            // a socket already known to be dead.
            this.releaseAttachment(peer, attachment, 'Mesh peer stopped answering pings', 'PEER_UNRESPONSIVE');
            return;
        }
        attachment.missedPongs += 1;
        try { attachment.ws.ping(); } catch { /* close handler cleans up */ }
    }

    private onSocketClosed(peer: WsPeer, attachment: Attachment, code: number): void {
        if (attachment.pingTimer) { clearInterval(attachment.pingTimer); attachment.pingTimer = undefined; }
        const link = attachment.link;
        if (link && link.ws === attachment.ws) {
            link.ws = undefined;
            this.scheduleRedial(link, attachment.livenessLost ? 'PEER_UNRESPONSIVE' : 'SOCKET_CLOSED');
        }
        if (peer.attachments.get(attachment.key) !== attachment) return;
        this.releaseAttachment(
            peer, attachment,
            `Mesh WebSocket closed (code ${code})`,
            attachment.livenessLost ? 'PEER_UNRESPONSIVE' : 'DATACHANNEL_CLOSED',
        );
    }

    /** Drop one socket from a peer; the peer is torn down only when it was the last. */
    private releaseAttachment(peer: WsPeer, attachment: Attachment, reason: string, code: string, closeCode?: number): void {
        if (peer.attachments.get(attachment.key) !== attachment) return;
        peer.attachments.delete(attachment.key);
        if (attachment.pingTimer) { clearInterval(attachment.pingTimer); attachment.pingTimer = undefined; }
        if (closeCode !== undefined && attachment.ws.readyState !== WebSocket.CLOSED) {
            try { attachment.ws.close(closeCode, code.toLowerCase()); } catch { /* already closed */ }
        }
        if (peer.torn) return;
        if (peer.attachments.size > 0) {
            this.logEvent('socket_released', { targetDaemonId: peer.daemonId, meshId: attachment.meshId, code, sockets: peer.attachments.size });
            return;
        }
        this.failPeer(peer, reason, code === 'DATACHANNEL_CLOSED' ? 'closed' : 'failed', code);
    }

    private connectionHandle(peer: WsPeer): { createDataChannel(label: string): unknown; daemonId: string } {
        return {
            daemonId: peer.daemonId,
            createDataChannel(): unknown {
                throw new Error('The WebSocket mesh transport has no auxiliary data channels; use the /ws/mesh-seqscribe lane.');
            },
        };
    }

    // ─── MeshRpcEndpoint hooks ──────────────────────────────────────────────────

    protected emitPeerOpen(peer: Peer): void {
        if (this.announcedOpenPeers.has(peer.daemonId)) return;
        this.announcedOpenPeers.add(peer.daemonId);
        const handle = this.connectionHandle(peer as WsPeer);
        for (const listener of this.peerLifecycleListeners) {
            try { listener.onPeerOpen(peer.daemonId, handle); } catch { /* listener owns its errors */ }
        }
    }

    private emitPeerClosed(daemonId: string): void {
        if (!this.announcedOpenPeers.delete(daemonId)) return;
        for (const listener of this.peerLifecycleListeners) {
            try { listener.onPeerClosed(daemonId); } catch { /* listener owns its errors */ }
        }
    }

    protected flushConnectQueue(peer: Peer): void {
        const queue = peer.connectQueue;
        peer.connectQueue = [];
        for (const pending of queue) this.writeRequest(peer, pending);
    }

    /** Consecutive request timeouts on an open peer with no recent round trip mean
     *  the link is dead even though the socket never closed: tear it down. */
    protected noteRequestTimeout(peer: Peer): void {
        if (peer.state !== 'connected') return;
        peer.consecutiveTimeouts += 1;
        if (peer.consecutiveTimeouts < MAX_CONSECUTIVE_TIMEOUTS) return;
        const sinceSuccess = peer.lastSuccessAt !== undefined ? Date.now() - peer.lastSuccessAt : Infinity;
        if (sinceSuccess <= LIVENESS_PROOF_WINDOW_MS) {
            this.logEvent('liveness_retained', {
                targetDaemonId: peer.daemonId, consecutiveTimeouts: peer.consecutiveTimeouts,
                threshold: MAX_CONSECUTIVE_TIMEOUTS, msSinceLastSuccess: sinceSuccess, livenessWindowMs: LIVENESS_PROOF_WINDOW_MS,
            });
            peer.consecutiveTimeouts = 0;
            return;
        }
        this.logEvent('liveness_lost', {
            targetDaemonId: peer.daemonId, consecutiveTimeouts: peer.consecutiveTimeouts,
            threshold: MAX_CONSECUTIVE_TIMEOUTS, msSinceLastSuccess: sinceSuccess,
        });
        this.failPeer(
            peer as WsPeer,
            `Mesh peer ${maskDaemonId(peer.daemonId)} is unresponsive (${peer.consecutiveTimeouts} consecutive timeouts); tearing down for a fresh reconnect`,
            'failed', 'PEER_UNRESPONSIVE', {}, WS_MESH_CLOSE_DISCONNECTED,
        );
    }

    protected failure(
        message: string,
        command: string,
        targetDaemonId: string,
        meshCode: string,
        options: FailureOptions = {},
    ): P2pRelayFailureError {
        const code = meshCode === 'PEER_NOT_CONNECTED'
            ? 'p2p_not_connected'
            : meshCode === 'CONNECT_TIMEOUT' || meshCode === 'REQUEST_TIMEOUT' || meshCode === 'ACK_TIMEOUT' || meshCode === 'PEER_UNRESPONSIVE'
                ? 'p2p_timeout'
                : /CLOSED|LIVENESS|STALL/.test(meshCode)
                    ? 'p2p_datachannel_closed'
                    : STRUCTURED_P2P_UNAVAILABLE_CODES.has(meshCode)
                        ? 'p2p_unavailable'
                        : undefined;
        return new P2pRelayFailureError(message, {
            command,
            targetDaemonId,
            meshCode,
            code,
            connectionState: this.peers.get(targetDaemonId)?.state
                ?? this.peerDiagnostics.get(targetDaemonId)?.state
                ?? 'disconnected',
            authEpoch: 0,
            recoverable: options.recoverable ?? (code ? true : undefined),
            retryRecommended: options.retryRecommended ?? (code ? true : undefined),
            nextRetryAt: options.nextRetryAt,
        });
    }

    // ─── Failure handling ───────────────────────────────────────────────────────

    private armConnectWait(peer: Peer, pending: PendingRpc): void {
        if (!pending.connectWaitDeadlineAt) return;
        const waitMs = Math.max(0, pending.connectWaitDeadlineAt - Date.now());
        pending.connectWaitTimer = setTimeout(() => {
            const idx = peer.connectQueue.indexOf(pending);
            if (idx === -1) return;
            peer.connectQueue.splice(idx, 1);
            pending.connectWaitTimer = undefined;
            this.rememberSettled(pending.id);
            this.logEvent('probe_connect_wait_expired', {
                requestId: pending.id, command: pending.command, targetDaemonId: peer.daemonId,
                connectWaitMs: waitMs, peerState: peer.state,
            });
            const link = this.linkForHost(peer.daemonId);
            const nextRetryAt = link?.nextRetryAt ?? new Date(Date.now() + this.retryDelayMs(1)).toISOString();
            pending.reject(this.failure(
                `Peer ${maskDaemonId(peer.daemonId)} not connected within the bounded handshake budget (probe gave up; background reconnect continues)`,
                pending.command, peer.daemonId, 'PEER_NOT_CONNECTED',
                { recoverable: true, retryRecommended: true, nextRetryAt },
            ));
        }, waitMs);
        if (typeof pending.connectWaitTimer.unref === 'function') pending.connectWaitTimer.unref();
    }

    /** Move a peer to a terminal state, close its sockets and reject everything it
     *  owns. Idempotent: a second call (a late socket event) is a no-op. */
    private failPeer(
        peer: WsPeer,
        reason: string,
        state: PeerState = 'failed',
        code = 'PEER_FAILED',
        options: FailureOptions = {},
        closeCode = WS_MESH_CLOSE_DISCONNECTED,
    ): void {
        if (peer.torn) return;
        peer.torn = true;
        peer.state = state;
        peer.reason = reason;
        if (peer.connectTimer) { clearTimeout(peer.connectTimer); peer.connectTimer = undefined; }
        peer.chunkAssembler?.reset();

        const drain = (pending: PendingRpc): void => {
            if (pending.requestTimer) clearTimeout(pending.requestTimer);
            if (pending.ackTimer) clearTimeout(pending.ackTimer);
            if (pending.connectWaitTimer) clearTimeout(pending.connectWaitTimer);
            this.rememberSettled(pending.id);
            pending.reject(this.failure(reason, pending.command, peer.daemonId, code, options));
        };
        const queued = peer.connectQueue;
        peer.connectQueue = [];
        const inflight = Array.from(peer.inflight.values());
        peer.inflight.clear();

        const attachments = Array.from(peer.attachments.values());
        peer.attachments.clear();
        for (const attachment of attachments) {
            if (attachment.pingTimer) { clearInterval(attachment.pingTimer); attachment.pingTimer = undefined; }
            if (attachment.ws.readyState !== WebSocket.CLOSED) {
                try { attachment.ws.close(closeCode, code.toLowerCase()); } catch { /* already closed */ }
            }
        }

        const prior = this.peerDiagnostics.get(peer.daemonId);
        const recoverable = options.recoverable ?? true;
        const link = this.linkForHost(peer.daemonId);
        const nextRetryAt = options.nextRetryAt
            ?? (recoverable ? link?.nextRetryAt ?? new Date(Date.now() + this.retryDelayMs(1)).toISOString() : undefined);
        this.peerDiagnostics.delete(peer.daemonId);
        this.peerDiagnostics.set(peer.daemonId, {
            state,
            lastFailureCode: code,
            lastFailureAt: new Date().toISOString(),
            lastConnectedAt: peer.openedAt ?? prior?.lastConnectedAt,
            lastCommandAt: peer.lastCommandAt ?? prior?.lastCommandAt,
            nextRetryAt,
            authEpoch: 0,
            attempt: peer.connectionSucceeded ? 0 : peer.attempt ?? prior?.attempt ?? 1,
            recoverable,
        });
        this.trimOldest(this.peerDiagnostics);
        if (this.peers.get(peer.daemonId) === peer) this.peers.delete(peer.daemonId);

        // Reject after the peer left the map, so a caller that retries from its
        // rejection handler starts a fresh peer instead of joining the dead one.
        for (const pending of queued) drain(pending);
        for (const pending of inflight) drain(pending);

        this.logEvent('peer_closed', {
            targetDaemonId: peer.daemonId,
            category: classifyPeerCloseReason(code),
            code,
            state,
            attempt: peer.attempt,
            recoverable,
            connectionSucceeded: peer.connectionSucceeded === true,
            sockets: attachments.length,
            sinceConnectBeginMs: Date.now() - Date.parse(peer.createdAt),
            sinceOpenedMs: peer.openedAt !== undefined ? Date.now() - Date.parse(peer.openedAt) : undefined,
        });
        this.emitPeerClosed(peer.daemonId);
    }

    private trimOldest<T>(map: Map<string, T>): void {
        while (map.size > MAX_RETAINED_PEERS) {
            const oldest = map.keys().next().value;
            if (oldest === undefined) break;
            map.delete(oldest);
        }
    }

    // ─── Misc ───────────────────────────────────────────────────────────────────

    /** True when `targetDaemonId` is this daemon under any equivalent id form. */
    private isSelfDial(targetDaemonId: string): boolean {
        return !!this.localDaemonId && daemonIdsEquivalent(targetDaemonId, this.localDaemonId);
    }
}
