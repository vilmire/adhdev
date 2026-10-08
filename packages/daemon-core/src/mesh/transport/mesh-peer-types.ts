export type MeshPeerConnectionState = 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

export type MeshPeerSnapshot = {
  perspective: 'selected_coordinator';
  source: 'mesh_peer_status';
  state: MeshPeerConnectionState;
  transport: 'direct' | 'relay' | 'unknown';
  reported: true;
  /** Whether this snapshot can satisfy direct peer authority right now. */
  directPeerTruthSatisfied: boolean;
  /** Live native state or a bounded terminal projection retained after teardown. */
  authority: 'live_peer' | 'cached_terminal_diagnostic';
  cached: boolean;
  ageMs: number;
  reason?: string;
  /**
   * Round-trip time in ms for the selected candidate pair, sampled from the
   * native PeerConnection when connected. Omitted when the transport layer does
   * not report a usable RTT yet (e.g. still connecting, or rtt() returns <= 0).
   */
  rttMs?: number;
  lastStateChangeAt: string;
  lastConnectedAt?: string;
  lastCommandAt?: string;
  lastFailureCode?: string;
  lastFailureAt?: string;
  attempt?: number;
  nextRetryAt?: string;
  authEpoch?: number;
  /**
   * The link IS the peer daemon's presence: the transport keeps exactly one
   * persistent link per paired peer and the peer holds it open for as long as
   * it runs (standalone direct WebSocket — the member dials, the host accepts,
   * both ping). A link that is not `connected` then means the peer is not
   * reachable, so mesh_status derives the node's machineStatus from it
   * (mesh/mesh-node-link-presence.ts). Absent for demand-dialed transports
   * (cloud WebRTC), whose link state is not presence.
   */
  linkIsPresence?: boolean;
};
