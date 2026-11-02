/**
 * Host handoff protocol types (design docs/design/2026-11-01-assistant-session-handoff.md §7).
 *
 * The canonical host role plus host-owned data move from a SOURCE daemon to a
 * TARGET daemon of the same mesh behind a verified snapshot and a positive ACK.
 * Both sides keep a durable phase journal. Source stop precedes target admission;
 * an unavailable interval is allowed, but uncertainty never revives the source.
 */

// v2 requires a source-stop attestation; v1 peers could activate before source stop.
export const HOST_HANDOFF_PROTOCOL = 2;

/** Peer verbs (daemon <-> daemon, mesh source only). The owner verb is `mesh_host_handoff`. */
export const HOST_HANDOFF_VERB = {
    owner: 'mesh_host_handoff',
    capability: 'mesh_host_handoff_capability',
    chunk: 'mesh_host_handoff_chunk',
    ack: 'mesh_host_handoff_ack',
    activate: 'mesh_host_handoff_activate',
    status: 'mesh_host_handoff_status',
    discard: 'mesh_host_handoff_discard',
    /** Previous host (or the new one) -> other members: the signed host transfer certificate. */
    certificate: 'mesh_host_handoff_certificate',
} as const;
export type HostHandoffPeerVerb = Exclude<typeof HOST_HANDOFF_VERB[keyof typeof HOST_HANDOFF_VERB], 'mesh_host_handoff'>;

export type SourcePhase =
    | 'preflight' | 'freezing' | 'frozen' | 'exporting' | 'exported' | 'awaiting_ack' | 'acked'
    | 'activating' | 'committed' | 'aborted' | 'uncertain';
export type TargetPhase = 'importing' | 'staged' | 'verified' | 'acked' | 'activating' | 'active' | 'discarded';
export type HandoffRole = 'source' | 'target';

/** Phases after which nothing may change any more. */
export const SOURCE_TERMINAL: ReadonlySet<SourcePhase> = new Set(['committed', 'aborted']);
export const TARGET_TERMINAL: ReadonlySet<TargetPhase> = new Set(['active', 'discarded']);

export const HOST_HANDOFF_CHUNK_BYTES = 256 * 1024;
export const HOST_HANDOFF_FREEZE_TIMEOUT_MS = 5 * 60_000;
export const HOST_HANDOFF_ACK_TIMEOUT_MS = 2 * 60_000;
export const HOST_HANDOFF_PROBE_BASE_MS = 30_000;
export const HOST_HANDOFF_PROBE_MAX_MS = 5 * 60_000;
/** Source data stays read-only this long after commit (owner decision H6). */
export const HOST_HANDOFF_RETENTION_MS = 14 * 24 * 60 * 60_000;

export interface TableSpec {
    table: string;
    /** Column holding the mesh id. */
    meshColumn: string;
    /** Ordering for a deterministic export (and deterministic digests). */
    orderBy: string;
    /** Static, code-owned scope for child tables that have no mesh_id. One bound mesh id. */
    scopeSql?: string;
    parentTable?: string;
    parentColumn?: string;
}

export interface ManifestTable { rows: number; columns: string[] }
export interface ManifestChunk { seq: number; sha256: string; bytes: number }

export interface HandoffLaunchPlan { provider: string; model?: string; thinkingLevel?: string; targetNodeId?: string }

export interface HandoffManifest {
    launchPlan?: HandoffLaunchPlan;
    protocol: number;
    handoffId: string;
    meshId: string;
    fromDaemonId: string;
    toDaemonId: string;
    /** The source's host epoch when the snapshot was cut. */
    hostEpoch: number;
    /** `hostEpoch + 1`: the epoch the target will hold. */
    nextEpoch: number;
    tables: Record<string, ManifestTable>;
    /** sha256 of the canonical mesh-config payload. */
    configDigest: string;
    chunks: ManifestChunk[];
    /** sha256 chain over the chunk hashes + header: the identity both sides compare. */
    digest: string;
}

export interface HandoffRecord {
    launchPlan?: HandoffLaunchPlan;
    handoffId: string;
    role: HandoffRole;
    meshId: string;
    peerDaemonId: string;
    phase: SourcePhase | TargetPhase;
    /** The epoch being established (`hostEpoch + 1`). */
    epoch: number;
    manifestDigest?: string;
    rowCounts?: Record<string, number>;
    targetNodeId?: string;
    createdAt: number;
    updatedAt: number;
    abortReason?: string;
    /** Source: when the durable commit intent was written (before `activate` is sent). */
    commitIntentAt?: number;
    /** Source: the target's origin-grant public key (from the capability probe); goes into the signed certificate. */
    targetPublicKey?: string;
    probeCount?: number;
    lastProbeAt?: number;
}

export type HandoffErrorCode =
    | 'handoff_in_progress' | 'not_host' | 'target_not_member' | 'target_offline' | 'target_is_self'
    | 'peer_capability_unconfirmed' | 'insufficient_disk' | 'target_not_launchable'
    | 'writer_checkpoint_pending' | 'freeze_timeout' | 'coordinator_not_quiescent'
    | 'chunk_hash_mismatch' | 'manifest_mismatch' | 'ack_mismatch' | 'ack_timeout' | 'verify_failed'
    | 'handoff_aborted' | 'handoff_unknown' | 'wrong_peer' | 'stale_epoch' | 'abort_requires_target_confirmation'
    | 'already_committed' | 'not_staged' | 'activate_failed' | 'invalid_args' | 'hold_failed' | 'state_preservation_unverified';

export interface PreflightCheck { id: string; ok: boolean; code?: HandoffErrorCode; detail?: string }

/** The ACK is an explicit statement that the staged snapshot verified. Silence is never success. */
export interface HandoffAck {
    handoffId: string;
    meshId: string;
    epoch: number;
    manifestDigest: string;
    rowCounts: Record<string, number>;
    targetDaemonId: string;
    readiness: { coordinatorLaunchable: boolean };
}

export interface PeerResult {
    success: boolean;
    code?: HandoffErrorCode | string;
    error?: string;
    [k: string]: unknown;
}

export interface HostTransferCertificate {
    /** Signed assertion made only after the source's trusted runtime census proved stop. */
    sourceStopped?: true;
    sourceStopProof?: { sessionIds: string[]; checkedAt: number; censusComplete: true };
    meshId: string;
    newHostDaemonId: string;
    newHostNodeId?: string;
    hostEpoch: number;
    newHostPublicKey: string;
    handoffId: string;
    previousHostDaemonId: string;
    issuedAt: number;
    /** Ed25519 signature (base64url) by the PREVIOUS host's origin-grant key over the canonical payload. */
    signature: string;
}
