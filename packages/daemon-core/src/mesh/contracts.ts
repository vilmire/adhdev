/**
 * Mesh contract v2 — first-class identity, scopes, and protocol version.
 *
 * Replaces the implicit conventions that grew across mesh-events.ts,
 * mesh-work-queue.ts, mesh-ledger.ts, and mesh-tools.ts where the same
 * concept (a coordinator, a session, a task status) appeared in different
 * shapes per file. The audit found:
 *
 *   - PendingMeshCoordinatorEvent had no targetCoordinatorDaemonId. All
 *     events were broadcast to every coordinator that drained them. Two
 *     coordinators sharing a mesh would each receive every event,
 *     leading to duplicate completion handling and missed targeting.
 *   - drainPendingMeshCoordinatorEvents accepted only meshId. The caller's
 *     coordinator identity was never available, so per-coordinator
 *     routing was impossible by construction.
 *   - Session identifier keys diverged across stores: targetSessionId /
 *     assignedSessionId / instanceId / runtimeSessionId / providerSessionId.
 *     resolveEventSessionId() tried four fallbacks per call.
 *   - No protocol version on the JSONL ledger or MeshRuntimeStore. Schema
 *     evolutions had no guard rail.
 *   - mesh_reconcile_ledger existed as a routine recovery tool, not as
 *     an incident-response escape hatch. That itself signals the routing
 *     layer cannot be trusted.
 *
 * This module introduces the types; the actual wiring lands in B2 (data
 * model + 3-way transactional store), B3 (MCP layer enforcement), and B4
 * (frontend consumption). B1 is intentionally non-breaking — it adds the
 * types and leaves runtime behaviour unchanged.
 */

import { daemonIdsEquivalent, machineCoreFromDaemonId } from '@adhdev/mesh-shared';

/** Provider type identifier (e.g. 'claude-cli', 'codex-cli', 'roo-code').
 *  Free-form string; no shared enum exists in daemon-core yet. */
type ProviderType = string;

// ─── Protocol version ────────────────────────────────────────────────────

export const MESH_PROTOCOL_VERSION_V1 = '1.0' as const;
export const MESH_PROTOCOL_VERSION_V2 = '2.0' as const;

export type MeshProtocolVersion =
  | typeof MESH_PROTOCOL_VERSION_V1
  | typeof MESH_PROTOCOL_VERSION_V2;

export const SUPPORTED_MESH_PROTOCOL_VERSIONS: readonly MeshProtocolVersion[] = [
  MESH_PROTOCOL_VERSION_V1,
  MESH_PROTOCOL_VERSION_V2,
] as const;

export function isSupportedMeshProtocolVersion(value: unknown): value is MeshProtocolVersion {
  return typeof value === 'string'
    && (SUPPORTED_MESH_PROTOCOL_VERSIONS as readonly string[]).includes(value);
}

// ─── Coordinator identity ────────────────────────────────────────────────

/**
 * Identity of a mesh coordinator. Required (non-optional) on every dispatch
 * and drain operation in v2 — opaque/missing identity is the audit's
 * smoking gun for routing failures and is structurally banned by the v2
 * types.
 *
 * - daemonId: the machineId of the daemon hosting the coordinator. Stable
 *   across coordinator restarts on the same machine.
 * - coordinatorRunId: a UUID generated when the coordinator process starts.
 *   Stable for the coordinator's lifetime, fresh on restart. Required so
 *   two coordinators on the same daemon (one CLI, one MCP) can be told
 *   apart without conflating their drains.
 * - sessionId: optional CLI coordinator session identifier (instanceId).
 *   Present when the coordinator is itself a CLI session, absent for
 *   pure MCP coordinators.
 */
export interface CoordinatorIdentity {
  readonly daemonId: string;
  readonly coordinatorRunId: string;
  readonly sessionId?: string;
}

export function coordinatorIdentityEquals(a: CoordinatorIdentity, b: CoordinatorIdentity): boolean {
  // daemonId compares by machine core: the same daemon answers to three
  // interchangeable id forms (mach_X / daemon_mach_X / standalone_mach_X), so a
  // raw `===` would treat one coordinator addressed under two forms as distinct.
  return daemonIdsEquivalent(a.daemonId, b.daemonId)
      && a.coordinatorRunId === b.coordinatorRunId
      && (a.sessionId ?? '') === (b.sessionId ?? '');
}

export function coordinatorIdentityKey(identity: CoordinatorIdentity): string {
  // Stable string form for map keys and ledger payloads. Avoids the
  // {a:b, c:d} JSON.stringify ordering trap by enforcing field order. The
  // daemonId is normalized to its machine core so the key stays consistent with
  // coordinatorIdentityEquals — two equal identities addressed under different
  // daemon-id forms must produce the SAME key (else equal-but-distinct-key bug).
  const daemonCore = machineCoreFromDaemonId(identity.daemonId) ?? identity.daemonId;
  return `${daemonCore}|${identity.coordinatorRunId}|${identity.sessionId ?? ''}`;
}

// ─── Session handle ──────────────────────────────────────────────────────

/**
 * Unified mesh session identifier. v1 referred to "the session" with five
 * different field names depending on which store you were reading; v2
 * collapses them into one explicit handle that carries every disambiguator
 * a consumer might need.
 *
 * - nodeId: the mesh node this session belongs to (FK into mesh node table).
 * - sessionId: provider-instance identifier (the runtime session id).
 * - providerType: which provider category/type the session runs (e.g.
 *   'claude-cli', 'codex-cli', 'roo-code').
 * - coordinatorDaemonId: which coordinator dispatched the work that
 *   spawned this session. Used for completion event routing.
 * - assignedAt: ms epoch when the session was bound to its current task.
 */
export interface MeshSessionHandle {
  readonly nodeId: string;
  readonly sessionId: string;
  readonly providerType: ProviderType;
  readonly coordinatorDaemonId: string;
  readonly assignedAt: number;
}

export function meshSessionHandleKey(handle: MeshSessionHandle): string {
  return `${handle.nodeId}|${handle.sessionId}`;
}

// ─── Task status (canonical enum) ────────────────────────────────────────

/**
 * Single canonical task status enum. v1 had at least three overlapping
 * sets (queue / ledger / direct-dispatch). v2 consumers import from here.
 */
export const MESH_TASK_STATUSES = [
  'pending',
  'assigned',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
] as const;
export type MeshTaskStatus = typeof MESH_TASK_STATUSES[number];

export function isMeshTaskStatus(value: unknown): value is MeshTaskStatus {
  return typeof value === 'string'
    && (MESH_TASK_STATUSES as readonly string[]).includes(value);
}

// ─── Event scope ─────────────────────────────────────────────────────────

/**
 * Explicit scope for pending coordinator events. v1 had no scope: every
 * event was broadcast to every drainer. v2 forces producers to declare
 * intent.
 *
 * - 'unicast': delivered to exactly one coordinator (intendedFor). Other
 *   coordinators' drains skip it.
 * - 'broadcast': delivered to every coordinator on the mesh. Used for
 *   system-wide signals (e.g. mesh-wide policy changes). The v1 default
 *   becomes explicit here so audit tools can flag unintended broadcasts.
 * - 'system': delivered to the daemon-level handler, not coordinators.
 *   Reserved for infrastructure events that no coordinator should see
 *   (e.g. ledger reconciliation outcomes).
 */
export const MESH_EVENT_SCOPES = ['unicast', 'broadcast', 'system'] as const;
export type MeshEventScope = typeof MESH_EVENT_SCOPES[number];

export function isMeshEventScope(value: unknown): value is MeshEventScope {
  return typeof value === 'string'
    && (MESH_EVENT_SCOPES as readonly string[]).includes(value);
}

// ─── Pending coordinator event v2 ────────────────────────────────────────

/**
 * v2 shape of a pending coordinator event. Strict supersets of the v1
 * shape — every v1 field is preserved so existing readers do not break;
 * v2 fields (scope, dispatchedBy, intendedFor, protocolVersion) are
 * additive and consulted by v2-aware drainers only.
 *
 * Mixed v1/v2 events coexist during the rollout window. B2 fully cuts
 * over once every coordinator drain is v2-aware.
 */
export interface PendingMeshCoordinatorEventV2 {
  // v1 fields (preserved exactly)
  readonly event: string;
  readonly meshId: string;
  readonly nodeLabel: string;
  readonly nodeId?: string;
  readonly workspace?: string;
  readonly metadataEvent: Record<string, unknown>;
  readonly coordinatorMessage?: string;
  readonly queuedAt: number;

  // v2 additions
  readonly protocolVersion: MeshProtocolVersion;
  /**
   * Idempotency key. A UUID generated ONCE at emit time and preserved verbatim
   * across every store (SQLite payload + column, JSONL) and the P2P relay
   * boundary. The receiving drain uses eventId as the authoritative dedup key
   * (B3): an event whose eventId was already drained is skipped even if its
   * content fingerprint differs. Distinct from the content fingerprint, which
   * stays the v1 dedup mechanism during rollout.
   */
  readonly eventId: string;
  readonly scope: MeshEventScope;
  readonly dispatchedBy: CoordinatorIdentity;
  /**
   * Required when scope === 'unicast', forbidden otherwise. Drainers MUST
   * skip unicast events whose intendedFor does not equal their own identity.
   */
  readonly intendedFor?: CoordinatorIdentity;
}

// ─── Ledger entry v2 ─────────────────────────────────────────────────────

/**
 * v2 ledger entry additions. The originatingCoordinator field is the
 * source of truth that lets completion events route back to the
 * coordinator that dispatched the task. v1's "worker settings carried it
 * if it happened to be set" approach is replaced.
 */
export interface MeshLedgerOriginatingCoordinatorV2 {
  readonly originatingCoordinator: CoordinatorIdentity;
  readonly protocolVersion: MeshProtocolVersion;
}

// ─── Validation primitives ───────────────────────────────────────────────

export class MeshContractViolationError extends Error {
  readonly violationPath: string;
  readonly protocolVersion: MeshProtocolVersion;
  constructor(
    protocolVersion: MeshProtocolVersion,
    violationPath: string,
    detail: string,
  ) {
    super(`mesh contract ${protocolVersion} violation at ${violationPath}: ${detail}`);
    this.name = 'MeshContractViolationError';
    this.violationPath = violationPath;
    this.protocolVersion = protocolVersion;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function assertCoordinatorIdentity(raw: unknown, path: string): CoordinatorIdentity {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MeshContractViolationError(MESH_PROTOCOL_VERSION_V2, path, 'must be an object');
  }
  const obj = raw as Record<string, unknown>;
  if (!isNonEmptyString(obj.daemonId)) {
    throw new MeshContractViolationError(MESH_PROTOCOL_VERSION_V2, `${path}.daemonId`, 'must be a non-empty string');
  }
  if (!isNonEmptyString(obj.coordinatorRunId)) {
    throw new MeshContractViolationError(MESH_PROTOCOL_VERSION_V2, `${path}.coordinatorRunId`, 'must be a non-empty string');
  }
  const sessionId = obj.sessionId;
  if (sessionId !== undefined && !isNonEmptyString(sessionId)) {
    throw new MeshContractViolationError(MESH_PROTOCOL_VERSION_V2, `${path}.sessionId`, 'must be a non-empty string when provided');
  }
  return sessionId !== undefined
    ? { daemonId: obj.daemonId, coordinatorRunId: obj.coordinatorRunId, sessionId }
    : { daemonId: obj.daemonId, coordinatorRunId: obj.coordinatorRunId };
}

export function assertPendingMeshCoordinatorEventV2(raw: unknown, path = '$'): PendingMeshCoordinatorEventV2 {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MeshContractViolationError(MESH_PROTOCOL_VERSION_V2, path, 'must be an object');
  }
  const obj = raw as Record<string, unknown>;
  if (!isSupportedMeshProtocolVersion(obj.protocolVersion)) {
    throw new MeshContractViolationError(MESH_PROTOCOL_VERSION_V2, `${path}.protocolVersion`, `must be one of ${SUPPORTED_MESH_PROTOCOL_VERSIONS.join(', ')}`);
  }
  if (!isNonEmptyString(obj.eventId)) {
    throw new MeshContractViolationError(MESH_PROTOCOL_VERSION_V2, `${path}.eventId`, 'must be a non-empty string');
  }
  if (!isMeshEventScope(obj.scope)) {
    throw new MeshContractViolationError(MESH_PROTOCOL_VERSION_V2, `${path}.scope`, `must be one of ${MESH_EVENT_SCOPES.join(', ')}`);
  }
  if (!isNonEmptyString(obj.event)) {
    throw new MeshContractViolationError(MESH_PROTOCOL_VERSION_V2, `${path}.event`, 'must be a non-empty string');
  }
  if (!isNonEmptyString(obj.meshId)) {
    throw new MeshContractViolationError(MESH_PROTOCOL_VERSION_V2, `${path}.meshId`, 'must be a non-empty string');
  }
  const dispatchedBy = assertCoordinatorIdentity(obj.dispatchedBy, `${path}.dispatchedBy`);

  if (obj.scope === 'unicast') {
    if (!obj.intendedFor) {
      throw new MeshContractViolationError(MESH_PROTOCOL_VERSION_V2, `${path}.intendedFor`, 'unicast scope requires intendedFor');
    }
  } else if (obj.intendedFor !== undefined) {
    throw new MeshContractViolationError(MESH_PROTOCOL_VERSION_V2, `${path}.intendedFor`, 'only unicast scope may set intendedFor');
  }
  const intendedFor = obj.intendedFor
    ? assertCoordinatorIdentity(obj.intendedFor, `${path}.intendedFor`)
    : undefined;

  const metadata = obj.metadataEvent && typeof obj.metadataEvent === 'object' && !Array.isArray(obj.metadataEvent)
    ? (obj.metadataEvent as Record<string, unknown>)
    : null;
  if (!metadata) {
    throw new MeshContractViolationError(MESH_PROTOCOL_VERSION_V2, `${path}.metadataEvent`, 'must be an object');
  }
  const queuedAt = typeof obj.queuedAt === 'number' && Number.isFinite(obj.queuedAt) ? obj.queuedAt : null;
  if (queuedAt === null) {
    throw new MeshContractViolationError(MESH_PROTOCOL_VERSION_V2, `${path}.queuedAt`, 'must be a finite number');
  }

  return {
    event: obj.event,
    meshId: obj.meshId,
    nodeLabel: isNonEmptyString(obj.nodeLabel) ? obj.nodeLabel : '',
    nodeId: typeof obj.nodeId === 'string' ? obj.nodeId : undefined,
    workspace: typeof obj.workspace === 'string' ? obj.workspace : undefined,
    metadataEvent: metadata,
    coordinatorMessage: typeof obj.coordinatorMessage === 'string' ? obj.coordinatorMessage : undefined,
    queuedAt,
    protocolVersion: obj.protocolVersion,
    eventId: obj.eventId,
    scope: obj.scope,
    dispatchedBy,
    ...(intendedFor ? { intendedFor } : {}),
  };
}

// ─── Routing helper ──────────────────────────────────────────────────────

/**
 * Decide whether a v2 pending event should be delivered to the given drainer.
 * Centralised so every drain implementation uses the same rule.
 *
 *   - 'broadcast': always delivered.
 *   - 'system': never delivered to coordinators (system handler only).
 *   - 'unicast': delivered iff intendedFor matches drainer identity.
 *
 * v1 events (no scope / no protocolVersion) are treated as broadcast for
 * backward compatibility during rollout; B3 tightens this so v1 events
 * are quarantined to a dedicated drain endpoint instead.
 */
export function shouldDeliverPendingEventToCoordinator(
  event: PendingMeshCoordinatorEventV2,
  drainer: CoordinatorIdentity,
): boolean {
  if (event.scope === 'system') return false;
  if (event.scope === 'broadcast') return true;
  if (!event.intendedFor) return false;
  return coordinatorIdentityEquals(event.intendedFor, drainer);
}

// ─── Emit-side scope defaulting (B2a) ────────────────────────────────────────

/**
 * Terminal task events. In v2 these are unicast: a completion/failure/approval
 * belongs to exactly the coordinator (session) that dispatched the task, so
 * delivering it to a sibling coordinator on the same daemon is a routing bug.
 * The names match the v1 producer event strings queued by the emit call sites
 * (mesh-event-forwarding, mesh-events-stale, router-refine).
 */
const TERMINAL_TASK_EVENTS: ReadonlySet<string> = new Set([
  'agent:generating_completed',
  'agent:stopped',
  'refine:completed',
  'refine:failed',
  'refine:accepted',
]);

/**
 * Infrastructure/system events that no coordinator should surface — ledger
 * consistency and dispatch-plane signals. Delivered to the daemon-level handler
 * only (scope 'system').
 */
const SYSTEM_EVENTS: ReadonlySet<string> = new Set([
  'mesh:dispatch_blocked',
]);

/**
 * Default the v2 scope for an event by its producer event name (design decision
 * §3). Terminal task events → unicast (routed to the originating coordinator).
 * Ledger-consistency / dispatch-plane events → system. Everything else — node
 * lifecycle and progress signals — → broadcast, which also matches v1's
 * implicit "deliver to any coordinator" behaviour, so an unstamped v1 event and
 * a v2-stamped-as-broadcast event route identically during rollout.
 */
export function defaultScopeForEvent(eventName: string): MeshEventScope {
  if (SYSTEM_EVENTS.has(eventName)) return 'system';
  if (TERMINAL_TASK_EVENTS.has(eventName)) return 'unicast';
  return 'broadcast';
}

/**
 * The v2 envelope stamp applied to a pending coordinator event at emit time.
 * Additive over the v1 shape: every field is consulted by v2-aware drainers
 * only, so a v1 reader that ignores them is unaffected.
 */
export interface PendingEventEmitStampV2 {
  readonly protocolVersion: typeof MESH_PROTOCOL_VERSION_V2;
  readonly eventId: string;
  readonly scope: MeshEventScope;
  readonly dispatchedBy: CoordinatorIdentity;
  readonly intendedFor?: CoordinatorIdentity;
}

/**
 * Build a coordinator identity from the loosely-typed fields the v1 emit call
 * sites already carry (a daemonId, and — sometimes — a coordinator session id).
 * Returns undefined when no usable daemonId is present; the caller then leaves
 * the event unstamped (v1, broadcast-treated) rather than fabricating identity.
 * coordinatorRunId is not known at every emit site yet (B2 wires the registry),
 * so it falls back to the daemonId — a stable, non-empty value that keeps the
 * identity well-formed for assertCoordinatorIdentity without inventing a UUID
 * that would differ per emit and defeat equality.
 */
export function coordinatorIdentityFromEmitFields(fields: {
  daemonId?: string | null;
  coordinatorRunId?: string | null;
  sessionId?: string | null;
}): CoordinatorIdentity | undefined {
  const daemonId = typeof fields.daemonId === 'string' && fields.daemonId.length > 0 ? fields.daemonId : undefined;
  if (!daemonId) return undefined;
  const coordinatorRunId = typeof fields.coordinatorRunId === 'string' && fields.coordinatorRunId.length > 0
    ? fields.coordinatorRunId
    : daemonId;
  const sessionId = typeof fields.sessionId === 'string' && fields.sessionId.length > 0 ? fields.sessionId : undefined;
  return sessionId !== undefined
    ? { daemonId, coordinatorRunId, sessionId }
    : { daemonId, coordinatorRunId };
}

/**
 * Compute the v2 emit stamp for an event (B2a). `eventId` MUST be supplied by
 * the caller (generated via crypto.randomUUID at the daemon-core boundary so
 * this module stays dependency-free and deterministically testable). Scope
 * defaults from the event name unless explicitly overridden.
 *
 * When `dispatchedBy` cannot be constructed (no coordinator daemon known),
 * returns undefined: the event stays a v1 (unstamped) event and is broadcast-
 * treated during rollout, exactly as before — no regression, no fabricated
 * identity. When the resolved scope is 'unicast' but no `intendedFor` is
 * available, the scope is downgraded to 'broadcast' so the stamp never violates
 * the "unicast requires intendedFor" contract (a terminal event that cannot be
 * addressed to its originator is safest delivered broadly, not dropped).
 */
export function buildPendingEventEmitStamp(opts: {
  eventName: string;
  eventId: string;
  dispatchedBy?: CoordinatorIdentity;
  intendedFor?: CoordinatorIdentity;
  scope?: MeshEventScope;
}): PendingEventEmitStampV2 | undefined {
  if (!opts.dispatchedBy) return undefined;
  let scope: MeshEventScope = opts.scope ?? defaultScopeForEvent(opts.eventName);
  let intendedFor = opts.intendedFor;
  if (scope === 'unicast' && !intendedFor) {
    // No addressable target for a unicast event — fall back to broadcast so the
    // stamp is contract-valid and the event is still delivered (never dropped).
    scope = 'broadcast';
  }
  if (scope !== 'unicast') intendedFor = undefined;
  return {
    protocolVersion: MESH_PROTOCOL_VERSION_V2,
    eventId: opts.eventId,
    scope,
    dispatchedBy: opts.dispatchedBy,
    ...(intendedFor ? { intendedFor } : {}),
  };
}
