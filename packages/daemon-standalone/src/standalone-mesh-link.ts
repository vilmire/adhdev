/**
 * Standalone multi-machine mesh glue (design 2026-10-07 §4.3).
 *
 * Owns this daemon's daemon⇄daemon links over direct WebSockets and connects
 * them to the staged boot exactly where the cloud daemon connects its WebRTC
 * mesh manager:
 *
 *   - `bootConfig()`  → `DaemonBootConfig.mesh` (dispatch, peer status, the
 *                       transcript peer resolver — read lazily, like cloud's
 *                       `this.seqscribe`, because the seqscribe link only exists
 *                       after the boot opened the node);
 *   - `attach()`      → inbound commands into the host runtime with source
 *                       `mesh` and the handshake-proven sender stamped
 *                       (cloud `CloudCommandTransports.handleMeshCommand`),
 *                       peer-open → `router.noteMeshPeerOpened`, then
 *                       `router.noteMeshTransportReady()`;
 *   - member links    → one `WsMeshTransport.addHostLink` + one seqscribe
 *                       replication loop per member-role pairing secret,
 *                       reconciled at attach and on every secrets-store change;
 *   - host lanes      → `/ws/mesh` and `/ws/mesh-seqscribe` upgrades run the
 *                       responder handshake against the host-role secrets and
 *                       hand the proven socket to the transport / seqscribe link.
 *
 * Secrets: read from the peer-secret store on demand; never logged, never put
 * into a frame other than the handshake's HMAC proofs. Daemon ids are logged
 * masked.
 */
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import {
  LOG,
  MESH_SENDER_DAEMON_ID_ARG,
  MESH_RPC_WS_PATH,
  MESH_SEQSCRIBE_WS_PATH,
  WS_MESH_CLOSE_REFUSED,
  WsMeshTransport,
  canonicalDaemonId,
  getPeerSecret,
  listPeerSecrets,
  maskDaemonId,
  meshWsUrlForHostAddress,
  onPeerSecretsChanged,
  performMeshHandshake,
  resolveMeshConnectWaitMs,
  resolvePeerSecretsPath,
  stripStatusProbeMarker,
  withMeshDirectDispatch,
  type DaemonBootConfig,
  type MeshListenAddress,
  type MeshHandshakeFailureCode,
  type PeerSecretRecord,
  type PeerSecretsChange,
  type PeerSecretStoreOptions,
  type StandaloneMeshSeqscribe,
  type WsMeshTransportOptions,
} from '@adhdev/daemon-core';

/**
 * Inbound frame ceiling for both mesh lanes. RPC frames above the endpoint's
 * chunk threshold are already split (~16k chars); seqscribe frames are capped
 * at its MAX_FRAME_BYTES (256 KiB). 4 MiB leaves ample headroom while keeping a
 * misbehaving peer far below the `ws` default of 100 MiB.
 */
export const STANDALONE_MESH_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

export type StandaloneMeshLane = 'rpc' | 'seqscribe';

/** The slice of `StandaloneMeshSeqscribe` this glue drives (a fake in tests). */
export type StandaloneMeshSeqscribeLink = Pick<
  StandaloneMeshSeqscribe,
  'attachHostLink' | 'acceptMemberSocket' | 'resolveTranscriptPeer' | 'detachMesh' | 'close'
>;

export type StandaloneMeshBootConfig = NonNullable<DaemonBootConfig['mesh']>;

export interface StandaloneMeshLinkOptions {
  /** This daemon's status identity (`standalone_<machineId>`); canonicalised for the handshake. */
  readonly localDaemonId: string;
  /** Peer-secret store location (test seam; default = the live config dir). */
  readonly secretStore?: PeerSecretStoreOptions;
  /** Handshake budget on both lanes and both sides (default: the handshake module's 5 s). */
  readonly handshakeTimeoutMs?: number;
  /** Transport tuning (test seam). `localDaemonId` / `handshakeTimeoutMs` come from above. */
  readonly transport?: Omit<WsMeshTransportOptions, 'localDaemonId' | 'handshakeTimeoutMs'>;
}

export interface StandaloneMeshLinkAttachDeps {
  /** The host runtime's single command entry (`DaemonHostRuntime.execute`). */
  execute(command: string, args: Record<string, unknown>, source: 'mesh'): Promise<unknown>;
  /** Router lifecycle hooks (`DaemonCommandRouter`). */
  readonly router: {
    noteMeshPeerOpened(daemonId: string): void;
    noteMeshTransportReady(): void;
  };
  /** The daemon⇄daemon replication link; null when the seqscribe node did not open. */
  readonly seqscribe: StandaloneMeshSeqscribeLink | null;
}

/**
 * The ws:// URL a member dials for one lane, from the host address stored with
 * its pairing secret. Accepts what an operator types or the pairing flow keeps:
 * `host:port`, `[v6]:port`, a bare IPv6 literal, or an http(s)/ws(s) URL with
 * any path / query (the scheme maps http→ws, https→wss; the path is replaced).
 */
export function meshPeerWsUrl(hostAddress: string, path: string): string {
  return meshWsUrlForHostAddress(hostAddress, path);
}

/**
 * Run one inbound mesh command: the handshake-proven sender is stamped as an
 * extra so it OVERRIDES anything the peer put in its own args (the router's
 * mesh sender gate reads only that stamp), and `_meshDirectDispatch` marks it
 * as already routed here (never re-forwarded). Mirrors cloud
 * `CloudCommandTransports.handleMeshCommand`.
 */
export function executeInboundMeshCommand(
  execute: StandaloneMeshLinkAttachDeps['execute'],
  senderDaemonId: string,
  command: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return execute(command, withMeshDirectDispatch(args, { [MESH_SENDER_DAEMON_ID_ARG]: senderDaemonId }), 'mesh');
}

interface AppliedMemberLink {
  readonly meshId: string;
  readonly hostDaemonId: string;
  /** url + secret: a change of either re-establishes both lanes. Never logged. */
  readonly fingerprint: string;
}

function memberLinkKey(meshId: string, hostDaemonId: string): string {
  return `${meshId}|${hostDaemonId}`;
}

function failureCode(error: unknown): MeshHandshakeFailureCode | 'error' {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? (code as MeshHandshakeFailureCode) : 'error';
}

const noop = (): void => { /* close follows */ };

export class StandaloneMeshLink {
  readonly transport: WsMeshTransport;
  private readonly localDaemonId: string;
  private readonly secretStore: PeerSecretStoreOptions;
  private readonly secretsPath: string;
  private readonly handshakeTimeoutMs: number | undefined;
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: STANDALONE_MESH_MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });
  private seqscribe: StandaloneMeshSeqscribeLink | null = null;
  private readonly applied = new Map<string, AppliedMemberLink>();
  private readonly disposers: Array<() => void> = [];
  private attached = false;
  private closed = false;
  private listenAddress: MeshListenAddress | null = null;

  constructor(options: StandaloneMeshLinkOptions) {
    this.localDaemonId = canonicalDaemonId(options.localDaemonId) ?? options.localDaemonId.trim();
    this.secretStore = options.secretStore ?? {};
    this.secretsPath = resolvePeerSecretsPath(this.secretStore);
    this.handshakeTimeoutMs = options.handshakeTimeoutMs;
    this.transport = new WsMeshTransport({
      ...(options.transport ?? {}),
      localDaemonId: this.localDaemonId,
      ...(options.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: options.handshakeTimeoutMs } : {}),
    });
  }

  /** `DaemonBootConfig.mesh` — the same contract cloud fills from its WebRTC mesh manager. */
  bootConfig(): StandaloneMeshBootConfig {
    return {
      dispatchMeshCommand: (daemonId, command, args) => this.dispatchCommand(daemonId, command, args),
      getMeshPeerConnectionStatus: (daemonId) => this.transport.getPeerConnectionStatus(daemonId),
      // The host pairing card's address candidates (get_mesh_host_pairing).
      getMeshListenAddress: () => this.listenAddress,
      // Read at call time: the seqscribe link is attached after the boot.
      resolveTranscriptPeer: (daemonId) => this.seqscribe?.resolveTranscriptPeer(daemonId) ?? null,
    };
  }

  /**
   * Send one command to a paired daemon — the boot's `dispatchMeshCommand` and
   * the coordinator's `mesh_relay_command` (standalone-mesh-relay.ts) share it.
   * OFFLINE-NODE-FANOUT / STATUS-REFRESH (cloud parity): probes get the short
   * connect-wait budget; the status marker never reaches the peer.
   */
  dispatchCommand(daemonId: string, command: string, args: Record<string, unknown>): Promise<unknown> {
    const connectWaitMs = resolveMeshConnectWaitMs(command, args);
    const dispatchArgs = stripStatusProbeMarker(args);
    return this.transport.sendCommand(daemonId, command, dispatchArgs, undefined, connectWaitMs);
  }

  /** Record where the HTTP server (and so the mesh lanes) actually listens. */
  setListenAddress(address: MeshListenAddress | null): void {
    this.listenAddress = address ? { host: address.host, port: address.port } : null;
  }

  /** Connect the links to the booted runtime and start dialing paired hosts. Call once. */
  attach(deps: StandaloneMeshLinkAttachDeps): void {
    if (this.closed || this.attached) return;
    this.attached = true;
    this.seqscribe = deps.seqscribe;
    this.transport.onCommand((sender, command, args) => {
      LOG.info('Mesh', `[Mesh] Incoming direct-WS command '${command}' from ${maskDaemonId(sender)}`);
      return executeInboundMeshCommand(deps.execute, sender, command, args);
    });
    this.disposers.push(this.transport.onPeerLifecycle({
      onPeerOpen: (daemonId) => deps.router.noteMeshPeerOpened(daemonId),
      onPeerClosed: () => { /* the next open re-handshakes */ },
    }));
    this.disposers.push(onPeerSecretsChanged((change) => this.onSecretsChanged(change)));
    this.reconcileMemberLinks();
    deps.router.noteMeshTransportReady();
  }

  /**
   * Whether an inbound upgrade on `lane` can be served: attached, not closed,
   * at least one HOST-role pairing secret exists (only a member of a mesh this
   * daemon hosts may dial in), and — for the replication lane — the seqscribe
   * link is up.
   */
  isAvailable(lane: StandaloneMeshLane): boolean {
    if (!this.attached || this.closed) return false;
    if (lane === 'seqscribe' && !this.seqscribe) return false;
    return listPeerSecrets(this.secretStore).some((record) => record.role === 'host');
  }

  /**
   * Upgrade a routed `/ws/mesh` or `/ws/mesh-seqscribe` request, then admit the
   * socket only through the responder handshake. The proven `{meshId,
   * peerDaemonId}` is handed over in the handshake's continuation with nothing
   * awaited in between, so no post-handshake frame can arrive unheard.
   */
  handleUpgrade(lane: StandaloneMeshLane, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const remote = (req.socket?.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.acceptInbound(lane, ws, remote));
  }

  private acceptInbound(lane: StandaloneMeshLane, ws: WebSocket, remote: string): void {
    // An 'error' with no listener would throw and take the daemon down.
    ws.on('error', noop);
    if (this.closed || !this.attached) {
      try { ws.close(WS_MESH_CLOSE_REFUSED, 'unavailable'); } catch { /* noop */ }
      return;
    }
    performMeshHandshake(ws, 'responder', {
      localDaemonId: this.localDaemonId,
      resolveSecret: (meshId, peerDaemonId) => this.resolveInboundSecret(meshId, peerDaemonId),
    }, this.handshakeTimeoutMs).then((proven) => {
      if (lane === 'rpc') {
        this.transport.acceptPeerSocket(ws, proven);
      } else if (this.seqscribe && !this.closed) {
        this.seqscribe.acceptMemberSocket(proven.meshId, proven.peerDaemonId, ws);
      } else {
        try { ws.close(1013, 'mesh replication unavailable'); } catch { /* noop */ }
        return;
      }
      LOG.info('Mesh', `[Mesh] Accepted ${lane} link from ${maskDaemonId(proven.peerDaemonId)} (mesh ${proven.meshId})`);
    }, (error: unknown) => {
      // The handshake already closed the socket (4401). The claimed id is not
      // proven, so it is not logged — only where the attempt came from.
      LOG.info('Mesh', `[Mesh] Refused inbound ${lane} link from ${remote}: handshake ${failureCode(error)}`);
    });
  }

  /** Only HOST-role records admit an inbound dialer: we host that mesh, they are its member. */
  private resolveInboundSecret(meshId: string, peerDaemonId: string): string | null {
    const record = getPeerSecret(meshId, peerDaemonId, this.secretStore);
    return record && record.role === 'host' ? record.secret : null;
  }

  private onSecretsChanged(change: PeerSecretsChange): void {
    if (this.closed || change.filePath !== this.secretsPath) return;
    if (change.kind === 'remove') {
      // Revoke (either role): drop every live socket to that peer now. Links
      // still backed by another pairing redial and re-prove themselves.
      this.seqscribe?.detachMesh(change.meshId, change.peerDaemonId);
      if (this.transport.disconnectPeer(change.peerDaemonId, 'Mesh pairing revoked')) {
        LOG.info('Mesh', `[Mesh] Disconnected ${maskDaemonId(change.peerDaemonId)}: pairing for mesh ${change.meshId} removed`);
      }
    }
    this.reconcileMemberLinks();
  }

  /** Make the dialed host links match the member-role records in the store. */
  private reconcileMemberLinks(): void {
    if (this.closed) return;
    const desired = new Map<string, PeerSecretRecord>();
    for (const record of listPeerSecrets(this.secretStore)) {
      if (record.role !== 'member') continue;
      if (!record.hostAddress) {
        LOG.warn('Mesh', `[Mesh] Paired host ${maskDaemonId(record.peerDaemonId)} (mesh ${record.meshId}) has no stored address — cannot dial it`);
        continue;
      }
      desired.set(memberLinkKey(record.meshId, record.peerDaemonId), record);
    }
    for (const [key, link] of this.applied) {
      if (desired.has(key)) continue;
      this.applied.delete(key);
      this.transport.removeHostLink(link.hostDaemonId, link.meshId);
      this.seqscribe?.detachMesh(link.meshId, link.hostDaemonId);
      LOG.info('Mesh', `[Mesh] Stopped dialing ${maskDaemonId(link.hostDaemonId)} (mesh ${link.meshId})`);
    }
    for (const [key, record] of desired) this.applyMemberLink(key, record);
  }

  private applyMemberLink(key: string, record: PeerSecretRecord): void {
    let rpcUrl: string;
    try {
      rpcUrl = meshPeerWsUrl(record.hostAddress ?? '', MESH_RPC_WS_PATH);
    } catch (error) {
      LOG.warn('Mesh', `[Mesh] Paired host ${maskDaemonId(record.peerDaemonId)} has an unusable address: ${(error as Error).message}`);
      return;
    }
    const fingerprint = `${rpcUrl}\n${record.secret}`;
    if (this.applied.get(key)?.fingerprint === fingerprint) return;
    try {
      this.transport.addHostLink({ meshId: record.meshId, hostDaemonId: record.peerDaemonId, url: rpcUrl, secret: record.secret });
    } catch (error) {
      LOG.warn('Mesh', `[Mesh] Cannot link to ${maskDaemonId(record.peerDaemonId)} (mesh ${record.meshId}): ${(error as Error).message}`);
      return;
    }
    this.applied.set(key, { meshId: record.meshId, hostDaemonId: record.peerDaemonId, fingerprint });
    this.seqscribe?.attachHostLink(record.meshId, record.peerDaemonId, () => this.dialReplication(record.meshId, record.peerDaemonId));
    LOG.info('Mesh', `[Mesh] Dialing mesh host ${maskDaemonId(record.peerDaemonId)} (mesh ${record.meshId})`);
  }

  /**
   * One replication dial: open `/ws/mesh-seqscribe`, prove ourselves as the
   * member, resolve with the open socket and no handshake listeners left. No
   * internal retry — the seqscribe reconnect loop owns redial and backoff. The
   * record is re-read per dial so a rotated secret or address is picked up.
   */
  private async dialReplication(meshId: string, hostDaemonId: string): Promise<WebSocket> {
    const record = getPeerSecret(meshId, hostDaemonId, this.secretStore);
    if (this.closed || !record || record.role !== 'member' || !record.hostAddress) {
      throw new Error('mesh pairing no longer present');
    }
    const ws = new WebSocket(meshPeerWsUrl(record.hostAddress, MESH_SEQSCRIBE_WS_PATH), {
      perMessageDeflate: false,
      maxPayload: STANDALONE_MESH_MAX_PAYLOAD_BYTES,
    });
    ws.on('error', noop);
    await performMeshHandshake(ws, 'initiator', {
      meshId: record.meshId,
      daemonId: this.localDaemonId,
      serverDaemonIdExpected: record.peerDaemonId,
      secret: record.secret,
    }, this.handshakeTimeoutMs);
    return ws;
  }

  /** Stop dialing, close every mesh socket, detach from the store. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const dispose of this.disposers.splice(0)) {
      try { dispose(); } catch { /* noop */ }
    }
    this.applied.clear();
    try { this.seqscribe?.close(); } catch { /* noop */ }
    this.seqscribe = null;
    this.transport.close();
    for (const client of this.wss.clients) {
      try { client.terminate(); } catch { /* noop */ }
    }
    this.wss.close();
  }
}
