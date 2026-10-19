export type P2pRelayFailureCode =
  | 'p2p_unavailable'
  | 'p2p_timeout'
  | 'p2p_not_connected'
  | 'p2p_datachannel_closed'
  | 'p2p_no_route'
  | 'p2p_daemon_offline'
  | 'ipc_command_timeout'
  | 'mesh_logic_or_provider_failure';

export interface P2pRelayFailureContext {
  command?: string;
  targetDaemonId?: string;
  meshCode?: string;
  connectionState?: string;
  nextRetryAt?: string;
  authEpoch?: number;
  recoverable?: boolean;
  retryRecommended?: boolean;
  code?: P2pRelayFailureCode;
}

export interface P2pRelayFailureClassification {
  code: P2pRelayFailureCode;
  reason: string;
  transport: 'p2p' | 'local_ipc' | 'unknown';
  recoverable: boolean;
  retryRecommended: boolean;
  nextAction: string;
  noFallbackReason: string;
}

export interface P2pRelayFailurePayload extends P2pRelayFailureClassification {
  success: false;
  error: string;
  command?: string;
  targetDaemonId?: string;
  meshCode?: string;
  connectionState?: string;
  nextRetryAt?: string;
  authEpoch?: number;
}

const NO_FALLBACK_REASON = 'This mesh operation needs a live peer-to-peer connection to the node, which is not open right now. This is often transient — the peer may be connecting, slow via TURN relay, or briefly offline. Wait a moment and retry, or re-establish the node\'s connection. Mesh commands use P2P only by design — there is no cloud/WS relay fallback.';
const P2P_NEXT_ACTION = 'The peer connection is recoverable. Wait a moment for the connection to establish (especially over TURN relay), then retry. If the node remains unreachable, check that the target daemon is running and online, then re-establish its connection.';
const LOCAL_IPC_TIMEOUT_NEXT_ACTION = 'The local daemon IPC command timed out while the daemon was busy or completing a heavy background operation. The node is local (not offline or P2P-disconnected), and the underlying operation may still complete in the background. Wait a moment and retry if needed.';
const LOCAL_IPC_TIMEOUT_NO_FALLBACK_REASON = 'This operation timed out waiting for a local daemon IPC response on the same machine. Do not treat this timeout as a P2P disconnection, an offline node, or a dirty working tree.';
const NON_P2P_NEXT_ACTION = 'Inspect the provider/command error and fix the underlying logic or configuration before retrying.';

function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const candidate = (error as any).error ?? (error as any).message ?? (error as any).reason;
    if (typeof candidate === 'string') return candidate;
  }
  return String(error || 'mesh relay command failed');
}

function readStructuredFailure(error: unknown): Partial<P2pRelayFailurePayload> {
  if (!error || typeof error !== 'object') return {};
  const value = error as Record<string, unknown>;
  return {
    ...(typeof value.code === 'string' ? { code: value.code as P2pRelayFailureCode } : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(value.transport === 'p2p' || value.transport === 'local_ipc' || value.transport === 'unknown' ? { transport: value.transport } : {}),
    ...(typeof value.recoverable === 'boolean' ? { recoverable: value.recoverable } : {}),
    ...(typeof value.retryRecommended === 'boolean' ? { retryRecommended: value.retryRecommended } : {}),
    ...(typeof value.nextAction === 'string' ? { nextAction: value.nextAction } : {}),
    ...(typeof value.noFallbackReason === 'string' ? { noFallbackReason: value.noFallbackReason } : {}),
    ...(typeof value.meshCode === 'string' ? { meshCode: value.meshCode } : {}),
    ...(typeof value.connectionState === 'string' ? { connectionState: value.connectionState } : {}),
    ...(typeof value.nextRetryAt === 'string' ? { nextRetryAt: value.nextRetryAt } : {}),
    ...(typeof value.authEpoch === 'number' ? { authEpoch: value.authEpoch } : {}),
  };
}

function reasonForCode(code: P2pRelayFailureCode): string {
  switch (code) {
    case 'p2p_timeout': return 'daemon_mesh_p2p_timeout';
    case 'p2p_not_connected': return 'daemon_mesh_p2p_not_connected';
    case 'p2p_datachannel_closed': return 'daemon_mesh_p2p_datachannel_closed';
    case 'p2p_no_route': return 'daemon_mesh_p2p_no_route';
    case 'p2p_daemon_offline': return 'daemon_mesh_target_offline';
    case 'p2p_unavailable': return 'daemon_mesh_p2p_transport_unavailable';
    case 'ipc_command_timeout': return 'local_daemon_ipc_timeout';
    case 'mesh_logic_or_provider_failure': return 'mesh_logic_or_provider_failure';
  }
}

export function classifyP2pRelayFailure(error: unknown, _context: P2pRelayFailureContext = {}): P2pRelayFailureClassification {
  const message = messageFromError(error);
  const structured = readStructuredFailure(error);

  if (
    structured.code === 'ipc_command_timeout'
    || structured.transport === 'local_ipc'
  ) {
    return {
      code: 'ipc_command_timeout',
      reason: structured.reason || reasonForCode('ipc_command_timeout'),
      transport: 'local_ipc',
      recoverable: structured.recoverable ?? true,
      retryRecommended: structured.retryRecommended ?? true,
      nextAction: structured.nextAction || LOCAL_IPC_TIMEOUT_NEXT_ACTION,
      noFallbackReason: structured.noFallbackReason || LOCAL_IPC_TIMEOUT_NO_FALLBACK_REASON,
    };
  }

  // Structured transport metadata is authoritative. This path prevents a local IPC
  // hop from reclassifying a typed P2P error by parsing its human prose.
  if (
    structured.code
    && structured.code !== 'mesh_logic_or_provider_failure'
    && structured.transport === 'p2p'
  ) {
    return {
      code: structured.code,
      reason: structured.reason || reasonForCode(structured.code),
      transport: 'p2p',
      recoverable: structured.recoverable ?? true,
      retryRecommended: structured.retryRecommended ?? true,
      nextAction: structured.nextAction || P2P_NEXT_ACTION,
      noFallbackReason: structured.noFallbackReason || NO_FALLBACK_REASON,
    };
  }

  // Strip diagnostic workspace/nodeId key-value tokens before scanning prose for P2P
  // keywords so paths like `/repo/services` ("ice") or `/repo/peer-tools` ("peer")
  // cannot misclassify a local IPC timeout as a P2P transport failure.
  const messageWithoutDiagnosticPaths = message.replace(/\b(?:workspace|nodeId)='[^']*'/gi, '');
  const hasP2pSignal =
    /\b(?:p2p|peer|datachannel|webrtc|ice|mesh_relay_command|daemon_mesh_p2p_transport)\b|node-datachannel/i.test(
      messageWithoutDiagnosticPaths,
    );
  const hasFailureSignal = /unavailable|missing|failed|failure|timeout|timed out|not connected|closed|disconnected|offline|no route|route unavailable|cannot send|cannot establish/i.test(message);
  const isLocalIpcTimeout = Boolean(
    error && typeof error === 'object' && (error as any).ipcTimeout === true,
  ) || /daemon ipc\b.*timed out/i.test(message);
  const ipcCommand =
    (error && typeof error === 'object' && typeof (error as any).ipcCommand === 'string'
      ? (error as any).ipcCommand
      : undefined)
    ?? /\bcommand='([^']+)'/i.exec(message)?.[1];
  const ipcRelayedCommand =
    (error && typeof error === 'object' && typeof (error as any).ipcRelayedCommand === 'string'
      ? (error as any).ipcRelayedCommand
      : undefined)
    ?? /\brelayedCommand='([^']+)'/i.exec(message)?.[1];
  const ipcTargetDaemonId =
    (error && typeof error === 'object' && typeof (error as any).ipcTargetDaemonId === 'string'
      ? (error as any).ipcTargetDaemonId
      : undefined)
    ?? /\btargetDaemonId='([^']+)'/i.exec(message)?.[1];
  const isExplicitLocalIpcCommand = Boolean(
    ipcCommand
    && ipcCommand !== 'mesh_relay_command'
    && !ipcRelayedCommand
    && !ipcTargetDaemonId
    && !_context.targetDaemonId,
  );

  // Validation errors that merely mention mesh_relay_command are not transport failures.
  if (/requires targetdaemonid and command|providerpriority|no inference provider|permission denied|read-only|not a member/i.test(message)) {
    return {
      code: 'mesh_logic_or_provider_failure',
      reason: 'mesh_logic_or_provider_failure',
      transport: 'unknown',
      recoverable: false,
      retryRecommended: false,
      nextAction: NON_P2P_NEXT_ACTION,
      noFallbackReason: NO_FALLBACK_REASON,
    };
  }

  // A bare local daemon IPC command timeout (not wrapping mesh_relay_command or P2P)
  // is a recoverable local IPC timeout, NOT an unrecoverable logic/provider error and
  // NOT a P2P disconnection.
  if (isLocalIpcTimeout && (isExplicitLocalIpcCommand || !hasP2pSignal)) {
    return {
      code: 'ipc_command_timeout',
      reason: 'local_daemon_ipc_timeout',
      transport: 'local_ipc',
      recoverable: true,
      retryRecommended: true,
      nextAction: LOCAL_IPC_TIMEOUT_NEXT_ACTION,
      noFallbackReason: LOCAL_IPC_TIMEOUT_NO_FALLBACK_REASON,
    };
  }

  let code: P2pRelayFailureCode | null = null;
  let reason = '';

  if (/timeout|timed out/i.test(message) && (hasP2pSignal || /mesh transport/i.test(message))) {
    code = 'p2p_timeout';
    reason = 'daemon_mesh_p2p_timeout';
  } else if (/no route|route unavailable/i.test(message)) {
    code = 'p2p_no_route';
    reason = 'daemon_mesh_p2p_no_route';
  } else if (/offline|not owned|not found|not connected to server/i.test(message) && /daemon|peer|target/i.test(message)) {
    code = 'p2p_daemon_offline';
    reason = 'daemon_mesh_target_offline';
  } else if (/closed|disconnected/i.test(message) && (hasP2pSignal || /state changed/i.test(message))) {
    code = 'p2p_datachannel_closed';
    reason = 'daemon_mesh_p2p_datachannel_closed';
  } else if (/not connected|cannot send|cannot establish|probe gave up/i.test(message) && hasP2pSignal) {
    code = 'p2p_not_connected';
    reason = 'daemon_mesh_p2p_not_connected';
  } else if (hasP2pSignal && hasFailureSignal) {
    code = 'p2p_unavailable';
    reason = 'daemon_mesh_p2p_transport_unavailable';
  }

  if (!code) {
    return {
      code: 'mesh_logic_or_provider_failure',
      reason: 'mesh_logic_or_provider_failure',
      transport: 'unknown',
      recoverable: false,
      retryRecommended: false,
      nextAction: NON_P2P_NEXT_ACTION,
      noFallbackReason: NO_FALLBACK_REASON,
    };
  }

  return {
    code,
    reason,
    transport: 'p2p',
    recoverable: true,
    retryRecommended: true,
    nextAction: P2P_NEXT_ACTION,
    noFallbackReason: NO_FALLBACK_REASON,
  };
}

export function isP2pRelayTransportFailure(error: unknown): boolean {
  const classification = classifyP2pRelayFailure(error);
  return classification.recoverable === true && classification.transport === 'p2p';
}

export function buildP2pRelayFailurePayload(error: unknown, context: P2pRelayFailureContext = {}): P2pRelayFailurePayload {
  const classification = classifyP2pRelayFailure(error, context);
  const structured = readStructuredFailure(error);
  return {
    success: false,
    ...classification,
    error: messageFromError(error),
    ...(context.command ? { command: context.command } : {}),
    ...(context.targetDaemonId ? { targetDaemonId: context.targetDaemonId } : {}),
    ...((context.meshCode || structured.meshCode) ? { meshCode: context.meshCode || structured.meshCode } : {}),
    ...((context.connectionState || structured.connectionState) ? { connectionState: context.connectionState || structured.connectionState } : {}),
    ...((context.nextRetryAt || structured.nextRetryAt) ? { nextRetryAt: context.nextRetryAt || structured.nextRetryAt } : {}),
    ...((context.authEpoch ?? structured.authEpoch) !== undefined ? { authEpoch: context.authEpoch ?? structured.authEpoch } : {}),
  };
}

export class P2pRelayFailureError extends Error {
  code: P2pRelayFailureCode;
  reason: string;
  transport: 'p2p' | 'local_ipc' | 'unknown';
  recoverable: boolean;
  retryRecommended: boolean;
  nextAction: string;
  noFallbackReason: string;
  command?: string;
  targetDaemonId?: string;
  meshCode?: string;
  connectionState?: string;
  nextRetryAt?: string;
  authEpoch?: number;

  constructor(message: string, context: P2pRelayFailureContext = {}) {
    super(message);
    this.name = 'P2pRelayFailureError';
    const payload = buildP2pRelayFailurePayload({
      message,
      ...(context.code ? { code: context.code } : {}),
      ...(context.recoverable !== undefined ? { recoverable: context.recoverable } : {}),
      ...(context.retryRecommended !== undefined ? { retryRecommended: context.retryRecommended } : {}),
      transport: context.code === 'ipc_command_timeout' ? 'local_ipc' : (context.code ? 'p2p' : undefined),
      meshCode: context.meshCode,
      connectionState: context.connectionState,
      nextRetryAt: context.nextRetryAt,
      authEpoch: context.authEpoch,
    }, context);
    this.code = context.code ?? payload.code;
    this.reason = payload.reason;
    this.transport = payload.transport;
    this.recoverable = context.recoverable ?? payload.recoverable;
    this.retryRecommended = context.retryRecommended ?? payload.retryRecommended;
    this.nextAction = payload.nextAction;
    this.noFallbackReason = payload.noFallbackReason;
    this.command = context.command;
    this.targetDaemonId = context.targetDaemonId;
    this.meshCode = context.meshCode;
    this.connectionState = context.connectionState;
    this.nextRetryAt = context.nextRetryAt;
    this.authEpoch = context.authEpoch;
  }
}
