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
};
