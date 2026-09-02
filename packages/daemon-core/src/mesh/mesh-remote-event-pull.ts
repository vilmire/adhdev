// ---------------------------------------------------------------------------
// mesh-remote-event-pull — cloud P2P remote-node pull helpers for the reconcile loop
// ---------------------------------------------------------------------------
// Extracted from mesh-reconcile-loop.ts (A-3 god-module decomposition, pure move,
// no behavior change). These helpers implement the reconcile loop's cloud-only
// PHASE that pulls pending coordinator events + worker status from REMOTE worker
// node daemons over P2P (get_pending_mesh_events / read_chat / get_status_metadata)
// and the payload-unwrapping utilities that tolerate the varied transport envelope
// shapes a local commandHandler vs. a remote dispatchMeshCommand returns.
//
// mesh-completion-synthesis.ts (the PHASE-4 synth) consumes several of these
// (unwrapReadChatPayload, readChatPayloadStatus, reprobeWorkerStatus,
// realTerminalEmitPendingForTask, collectLiveNodesWithSessions); the reconcile
// loop itself consumes pullRemoteNodeQueues.
// ---------------------------------------------------------------------------

import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import type { LocalMeshEntry } from '../repo-mesh-types.js';
import { getPendingMeshCoordinatorEvents, serializeV2EnvelopeToWire } from './mesh-events-pending.js';
import type { PendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import { handleMeshForwardEvent } from './mesh-events-coordinator.js';
import { readNonEmptyString } from './mesh-events-utils.js';
import { canonicalDaemonId, daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { daemonIdListIncludes } from './mesh-reconcile-identity.js';
import {
    readTranscriptForDaemonConsumer,
    TRANSCRIPT_STATUS_PROBE_MAX_AGE_MS,
} from './transcript-daemon-consumer-read.js';

// ─── Pull pacing (RECONCILE-PULL-FLOOD, M-MESH-INFRA-0829 follow-up) ────────
// Live measurement (2026-08-30, preview coordinator, rc.45): the 4s reconcile
// tick issued ~90 get_pending_mesh_events (~25 req/s sustained, 82% to a
// single daemon, all empty) and pinned the daemon at 114% CPU — a self-DoS
// that also starved the P2P signal channel (SIGNAL_RATE_LIMIT/CONNECT_TIMEOUT).
// Three multipliers, all fixed here:
//   1. NO PER-DAEMON DEDUP — pullRemoteNodeQueues iterated mesh.nodes (config ∪
//      inline cache) verbatim; remote-cloned worktree nodes alias the SAME
//      remote daemon once per clone, so one daemon was pulled N_nodes × N_ids
//      per tick. Fix: one pull-set per unique remote daemon per tick.
//   2. NO EMPTY-RESPONSE BACKOFF — a daemon whose queue stayed empty was
//      re-polled at full 4s cadence forever. Fix: after a few consecutive
//      all-empty rounds the daemon is skipped with an exponential backoff
//      capped at 30s (event delay stays seconds, never minutes). LOSSLESS:
//      the remote queue keeps undrained rows, so a skip delays delivery, it
//      never drops it; any non-empty round resets pacing instantly.
//   3. REDRIVE-GATE FAN-OUT — the DELIVERED-NOT-CONSUMED last-chance pull ran
//      per stranded row, so K rows on one daemon multiplied into K pull-sets
//      per tick. Fix: an optional per-daemon throttle window; rows sharing a
//      daemon reuse the first row's pull (the drain is daemon-scoped, so the
//      second pull could only ever re-see what the first just consumed).

// Backoff tunables. The first REMOTE_PULL_EMPTY_ROUNDS_BEFORE_BACKOFF empty
// rounds keep the full tick cadence so a bursty event flow is never delayed;
// only a sustained empty daemon backs off.
const REMOTE_PULL_EMPTY_ROUNDS_BEFORE_BACKOFF = 3;
const REMOTE_PULL_BACKOFF_BASE_MS = 8_000; // 2 ticks
export const REMOTE_PULL_BACKOFF_MAX_MS = 30_000;
// Redrive-gate throttle: at most one last-chance pull per daemon per window.
// Well under the 4s tick so a genuinely fresh check is never stale next tick.
export const REDRIVE_PULL_MIN_INTERVAL_MS = 2_000;

interface RemotePullBackoff { emptyRounds: number; nextPullAtMs: number; }
const remotePullBackoffByDaemon = new Map<string, RemotePullBackoff>();
const lastRedrivePullAtMs = new Map<string, number>();

/** @internal Test-only: clear pacing state between cases. */
export function __resetRemoteEventPullPacingForTests(): void {
    remotePullBackoffByDaemon.clear();
    lastRedrivePullAtMs.clear();
}

// Exponential backoff per consecutive empty round past the grace rounds:
// 8s, 16s, then pinned at the 30s cap.
export function resolveRemotePullBackoffMs(backoffRound: number): number {
    const shift = Math.max(0, Math.min(backoffRound - 1, 8));
    return Math.min(REMOTE_PULL_BACKOFF_MAX_MS, REMOTE_PULL_BACKOFF_BASE_MS * 2 ** shift);
}

function pullBackoffKey(meshId: string, daemonId: string): string {
    // Keep pacing stable when the same daemon alternates between its bare,
    // daemon_, and standalone_ identity forms across cache refreshes.
    return `${meshId}::${canonicalDaemonId(daemonId) ?? daemonId}`;
}

function isRemotePullBackedOff(meshId: string, daemonId: string, nowMs: number): boolean {
    const state = remotePullBackoffByDaemon.get(pullBackoffKey(meshId, daemonId));
    return !!state && nowMs < state.nextPullAtMs;
}

function noteRemotePullResult(meshId: string, daemonId: string, result: PullFromNodeResult, nowMs: number): void {
    const key = pullBackoffKey(meshId, daemonId);
    if (result.received > 0) {
        remotePullBackoffByDaemon.delete(key);
        return;
    }
    if (!result.reached) return; // transport failure: not evidence of an empty queue — leave the streak alone
    const prev = remotePullBackoffByDaemon.get(key);
    const emptyRounds = (prev?.emptyRounds ?? 0) + 1;
    const backoffRound = emptyRounds - REMOTE_PULL_EMPTY_ROUNDS_BEFORE_BACKOFF + 1;
    remotePullBackoffByDaemon.set(key, {
        emptyRounds,
        nextPullAtMs: emptyRounds >= REMOTE_PULL_EMPTY_ROUNDS_BEFORE_BACKOFF
            ? nowMs + resolveRemotePullBackoffMs(backoffRound)
            : 0,
    });
}

// What a single-node pull round-trip learned. `reached` distinguishes a
// confirmed-empty queue (backoff evidence) from a transport failure (no
// evidence — the peer pre-check already skips disconnected daemons).
export interface PullFromNodeResult {
    received: number;
    reached: boolean;
}

const NOT_REACHED: PullFromNodeResult = { received: 0, reached: false };

// Cloud-only: poll each remote worker node daemon for pending coordinator events
// and re-inject them locally via handleMeshForwardEvent (which re-queues +
// surfaces to the live coordinator on the next tick / immediately if idle).
//
// Scoping: the remote handler (get_pending_mesh_events) drains its queue filtered
// by coordinatorDaemonId — returning events targeted at that id OR unscoped, and
// leaving events targeted at a *different* coordinator. A remote worker stamps the
// coordinator id in one of SEVERAL forms (the canonical status id `standalone_`/
// `daemon_<machineId>` stamped by the MCP layer, the bare machineId stamped by the
// local queue path, OR — most commonly for remote launches — the coordinator mesh
// node's config-form `daemonId`, which resolveCoordinatorDaemonId prefers and which
// is NOT canonicalised). `candidateDaemonIds` is the already-expanded self-identity
// set (resolveCoordinatorSelfIds: runtime drain ids ∪ this daemon's mesh-config node/
// host id forms), so we pull ONCE PER candidate id and a completion stamped with any
// of them is recovered. The remote drain is atomic (drained=1), so issuing multiple
// pulls cannot double-deliver — the first pull that matches consumes the event; the
// rest see nothing. When no ids resolve we fall back to a single unscoped pull.
export async function pullRemoteNodeQueues(
    components: DaemonComponents,
    mesh: LocalMeshEntry,
    localDaemonId: string | undefined,
    candidateDaemonIds: string[],
): Promise<void> {
    const dispatchMeshCommand = components.dispatchMeshCommand;
    if (!dispatchMeshCommand) return;
    const meshId = mesh.id;

    // One args object per candidate coordinator-id form, or a single unscoped pull
    // when none resolve.
    const pulls: Array<Record<string, unknown>> = candidateDaemonIds.length > 0
        ? candidateDaemonIds.map(id => ({ meshId, coordinatorDaemonId: id }))
        : [{ meshId }];

    // Per-daemon dedup (pacing fix 1): remote-cloned worktree nodes alias the
    // SAME daemon once per clone entry (config ∪ inline cache), and the pull is
    // daemon-scoped — the remote handler drains its whole queue for the mesh,
    // not a per-node slice — so pulling once per node ENTRY re-issued the
    // identical drain N_aliases × N_ids per tick. Fold aliases (equivalence-
    // aware, so `daemon_mach_X`/`mach_X` forms collapse too) and pull each
    // unique daemon once per candidate id.
    const uniqueNodes: Array<{ daemonId?: string }> = [];
    const seenDaemonIds = new Set<string>();
    for (const node of mesh.nodes) {
        const nodeDaemonId = readNonEmptyString(node.daemonId);
        if (!nodeDaemonId) continue;
        const daemonKey = canonicalDaemonId(nodeDaemonId) ?? nodeDaemonId;
        if (seenDaemonIds.has(daemonKey)) continue;
        seenDaemonIds.add(daemonKey);
        uniqueNodes.push(node);
    }

    // Parallelize across daemons: a single connected-but-slow daemon must not
    // serially block the others for the rest of the tick. Each daemon callback
    // is fully self-contained (local/candidate skip, peer-connected pre-check,
    // empty-backoff gate, per-candidate pulls, extract→re-inject) and
    // best-effort — allSettled swallows per-daemon errors.
    await Promise.allSettled(uniqueNodes.map(node => (async () => {
        const nodeDaemonId = readNonEmptyString(node.daemonId);
        if (nodeDaemonId && isRemotePullBackedOff(meshId, nodeDaemonId, Date.now())) return;
        const result = await pullPendingEventsFromNode(components, meshId, node, localDaemonId, candidateDaemonIds, pulls);
        if (nodeDaemonId) noteRemotePullResult(meshId, nodeDaemonId, result, Date.now());
    })()));
}

// Pull one node's pending coordinator events and re-inject them locally via
// handleMeshForwardEvent (which runs the delivery-consume + re-queue paths). Factored
// out of pullRemoteNodeQueues so the reconcile loop can also issue a TARGETED single-node
// pull on demand — specifically, the DELIVERED-NOT-CONSUMED redrive gate calls this for
// one node right before it would re-drive, so a worker's already-emitted (but not-yet-
// pulled) agent:generating_started is consumed IN-PROCESS this tick instead of waiting for
// the next PHASE 1 pull. That closes the redrive-vs-consume race: the redrive gate reads
// taskDeliveryConsumed() AFTER this pull has had its chance to flip the delivery row.
// Returns silently on any skip/error — every caller treats it as best-effort.
//
// `opts.minIntervalSinceLastPullMs` (pacing fix 3): skip when this daemon was
// already pulled within the window. The drain is daemon-scoped, so a second
// pull inside the same tick can only re-see what the first just consumed —
// the redrive gate calls this PER STRANDED ROW, and K rows on one daemon used
// to multiply into K pull-sets per tick.
export async function pullPendingEventsFromNode(
    components: DaemonComponents,
    meshId: string,
    node: { daemonId?: string },
    localDaemonId: string | undefined,
    candidateDaemonIds: string[],
    pulls: Array<Record<string, unknown>>,
    opts?: { minIntervalSinceLastPullMs?: number },
): Promise<PullFromNodeResult> {
    const dispatchMeshCommand = components.dispatchMeshCommand;
    if (!dispatchMeshCommand) return NOT_REACHED;
    const nodeDaemonId = readNonEmptyString(node.daemonId);
    // Skip nodes without a daemon, and nodes on THIS daemon (their events are
    // already in the local queue drained in PHASE 2). "This daemon" is matched
    // against the full self-identity set (candidateDaemonIds), not just the bare
    // localDaemonId — a self node can be registered under the config-form daemonId
    // (`daemon_<machineId>`) which would NOT equal bare localDaemonId, and pulling
    // from ourselves over P2P is both wasteful and a self-dispatch hazard.
    if (!nodeDaemonId) return NOT_REACHED;
    if (daemonIdsEquivalent(nodeDaemonId, localDaemonId)) return NOT_REACHED;
    if (daemonIdListIncludes(candidateDaemonIds, nodeDaemonId)) return NOT_REACHED;

    // Peer-connected pre-check (EVENT-DELIVERY-DELAY fix(a) + OFFLINE-NODE-FANOUT):
    // a degraded peer whose DataChannel is not open would sink this pull into
    // peer.connectQueue and stall until CONNECT_TIMEOUT_MS (90s), formerly freezing
    // the whole serial loop and delaying completion-event recovery from healthy
    // nodes. Skip such a node THIS tick and retry next tick — LOSSLESS: an
    // unconnected peer has not drained anything (drained=0 preserved), so its events
    // are recovered whole on the next successful tick. Skip = delay, never loss.
    //   • getter WIRED (cloud) → a null/undefined snapshot means "no peer object
    //     right now" = NOT connected (a powered-off node whose failPeer just deleted
    //     the peer each cycle). Treat it EXACTLY like state !== 'connected' and skip;
    //     dialing here would re-queue for another 90s (the null-race the guard is
    //     meant to prevent). Only a snapshot with state === 'connected' proceeds.
    //   • getter UNWIRED (standalone) → DO NOT skip; fall through to the legacy path
    //     so this stays regression-free (the standalone case the guard's history
    //     references).
    const getPeerStatus = components.getMeshPeerConnectionStatus;
    if (getPeerStatus) {
        const peerSnapshot = getPeerStatus(nodeDaemonId);
        if (!peerSnapshot || String(peerSnapshot.state) !== 'connected') return NOT_REACHED;
    }

    // Per-daemon throttle (pacing fix 3): the redrive gate calls this once per
    // stranded row; rows aliasing one daemon share the first row's drain.
    const throttleKey = pullBackoffKey(meshId, nodeDaemonId);
    if (opts?.minIntervalSinceLastPullMs) {
        const lastPullAt = lastRedrivePullAtMs.get(throttleKey);
        if (lastPullAt !== undefined && Date.now() - lastPullAt < opts.minIntervalSinceLastPullMs) {
            return NOT_REACHED;
        }
    }

    let received = 0;
    let completedPulls = 0;
    // Stamp a targeted redrive attempt before awaiting transport. PHASE 1 does
    // not write this map: the last-chance pull intentionally runs after PHASE 1
    // to close an event-arrived-during-this-tick race. Only later stranded rows
    // on the same daemon reuse this first targeted drain.
    if (opts?.minIntervalSinceLastPullMs) lastRedrivePullAtMs.set(throttleKey, Date.now());
    for (const pendingEventArgs of pulls) {
        let events: unknown;
        try {
            events = await dispatchMeshCommand(nodeDaemonId, 'get_pending_mesh_events', pendingEventArgs);
        } catch {
            // Remote pull is best-effort; the node may be offline. Retry next tick.
            break; // node unreachable — don't bother with the other id form this tick.
        }
        const extracted = extractPendingEventsResult(events);
        // A returned error/malformed envelope is not proof of an empty queue.
        // Do not advance empty backoff from it; retry on the next tick.
        if (!extracted.confirmed) break;
        completedPulls++;
        received += extracted.events.length;
        const list = extracted.events.filter(e => readNonEmptyString(e?.meshId) === meshId);
        for (const event of list) {
            const payload = buildForwardPayloadFromPending(event);
            if (!payload.event || !payload.meshId) continue;
            try {
                handleMeshForwardEvent(components, payload);
            } catch { /* best-effort re-inject */ }
        }
    }
    return { received, reached: completedPulls === pulls.length };
}

// Pull the read_chat payload out of whatever envelope the transport returned.
// A local commandHandler.handle() returns the CommandResult directly; a remote
// dispatchMeshCommand returns it possibly wrapped in { payload } / { result }.
export function unwrapReadChatPayload(raw: unknown): Record<string, unknown> | null {
    let cursor: unknown = raw;
    for (let depth = 0; depth < 4 && cursor && typeof cursor === 'object'; depth++) {
        const record = cursor as Record<string, unknown>;
        if (Array.isArray(record.messages)) return record;
        if (record.payload && typeof record.payload === 'object') { cursor = record.payload; continue; }
        if (record.result && typeof record.result === 'object') { cursor = record.result; continue; }
        if (record.data && typeof record.data === 'object') { cursor = record.data; continue; }
        break;
    }
    return cursor && typeof cursor === 'object' ? cursor as Record<string, unknown> : null;
}

export function readChatPayloadStatus(payload: Record<string, unknown> | null): string {
    return readNonEmptyString(payload?.status).toLowerCase();
}

/**
 * PROJECTION-SELF-REFERENCE: the PROVIDER's own status verdict, independent of
 * the Stage 6 turn-ledger projection that overwrites `status` for mesh-owned
 * sessions (see read-chat-presentation.ts).
 *
 * The transcript completion poll must read THIS rather than `status`: gating the
 * ledger's terminal write on a value derived from the ledger's own stage is a
 * closed cycle that wedges a finished turn at `generating` permanently.
 *
 * FAIL-SAFE FALLBACK: when the field is absent — an older remote daemon, or any
 * payload that predates it — we return the projected `status` instead. That is
 * the pre-fix behaviour, so a mixed-version mesh degrades to "wedge is still
 * possible on the old node", never to "a mid-turn worker reads idle". Falling
 * back to 'idle' here would invent a turn-end from a missing field, which is the
 * one direction this whole path must never fail in.
 */
export function readChatPayloadProviderObservedStatus(payload: Record<string, unknown> | null): string {
    const observed = readNonEmptyString(payload?.providerObservedStatus).toLowerCase();
    return observed || readChatPayloadStatus(payload);
}

// R4e fix (3): peek the pending-events queue for a REAL (worker-emitted) terminal completion
// already queued for a task — used to yield the in-flight synth to the worker's own emit. Broad
// peek (no daemon-id scoping) matched precisely by taskId, so a worker stamp in any daemon-id form
// is still recognized. Best-effort: a peek failure returns false (proceed to synth — never block
// delivery). A prior SYNTH's still-queued pending event also names this taskId, but a synth always
// writes its terminal ledger atomically, so hasTerminalLedgerAfterDispatch downstream already
// no-ops that case — this guard is specifically for an as-yet-unledgered worker emit in flight.
export function realTerminalEmitPendingForTask(meshId: string, taskId: string): boolean {
    let pending: readonly PendingMeshCoordinatorEvent[];
    try {
        pending = getPendingMeshCoordinatorEvents(meshId);
    } catch {
        return false;
    }
    return pending.some(e =>
        readNonEmptyString(e.metadataEvent?.taskId) === taskId
        && (e.event === 'agent:generating_completed' || e.event === 'agent:stopped'));
}

// R4e fix (2): one fresh read_chat status read for the worker session, via the same local/remote
// transport PHASE 4 uses. Returns the lowercased status, or null when the read is inconclusive
// (transport error, success:false, no payload) — callers treat null as "no new evidence, proceed".
//
// ── §8 unit 7: roster id 4 `daemon_worker_status_probe` (design §4) ─────────
// The replica hop runs FIRST for a REMOTE worker, then this function's original
// local/remote `read_chat` exactly as before. Losslessness is trivial here and
// that is the point of taking this consumer first: the only field read is
// `payload.status` (`readChatPayloadStatus`), which the transcript wire carries
// verbatim as `snapshot.status` — the SAME `effectiveStatus` the producer's
// `read_chat` last mile computed, not a re-derivation.
//
// LOCAL nodes never take the replica hop: their `read_chat` is an in-process
// call against the provider source, which §4's roster note keeps as-is.
//
// The roster's fallback note — "불충분하면 기존 local/remote `read_chat`; null의
// 기존 fail-open 의미 유지" — is why a declined replica read falls THROUGH to
// the legacy call rather than returning null: null means "inconclusive, proceed"
// to every caller, so answering null on a mere replica miss would silently
// convert a would-be conclusive probe into a fail-open one.
export async function reprobeWorkerStatus(
    components: DaemonComponents,
    args: { isLocalNode: boolean; nodeDaemonId: string; readArgs: Record<string, unknown> },
): Promise<string | null> {
    if (!args.isLocalNode) {
        const replica = readTranscriptForDaemonConsumer({
            consumerId: 'daemon_worker_status_probe',
            ownerDaemonId: args.nodeDaemonId,
            rawSessionId: readNonEmptyString(args.readArgs.sessionId),
            maxAgeMs: TRANSCRIPT_STATUS_PROBE_MAX_AGE_MS,
            store: components.transcriptReplicaStore,
        });
        if (replica.snapshot) return replica.snapshot.status.toLowerCase();
    }
    try {
        if (args.isLocalNode) {
            const r = await components.commandHandler.handle('read_chat', args.readArgs);
            if (r && (r as { success?: boolean }).success === false) return null;
            return readChatPayloadStatus(unwrapReadChatPayload(r));
        }
        if (components.dispatchMeshCommand) {
            const r = await components.dispatchMeshCommand(args.nodeDaemonId, 'read_chat', args.readArgs);
            const p = unwrapReadChatPayload(r);
            if (p && (p as { success?: boolean }).success === false) return null;
            return readChatPayloadStatus(p);
        }
    } catch {
        return null;
    }
    return null;
}

// Probe each node for its live session list (get_status_metadata) and return mesh.nodes
// decorated with a `sessions` array — the shape buildMeshActiveWork / sessionStatusFromNodes
// consume to decide whether a dispatched session is still present. Best-effort: an unreachable
// node yields an empty session list rather than throwing.
export async function collectLiveNodesWithSessions(
    components: DaemonComponents,
    mesh: LocalMeshEntry,
    selfIds: string[],
    localDaemonId: string | undefined,
): Promise<any[]> {
    const dispatchMeshCommand = components.dispatchMeshCommand;
    return Promise.all(mesh.nodes.map(async (node) => {
        const nodeDaemonId = readNonEmptyString(node.daemonId);
        const isLocalNode = !nodeDaemonId
            || daemonIdListIncludes(selfIds, nodeDaemonId)
            || daemonIdsEquivalent(nodeDaemonId, localDaemonId);
        // Peer-connected pre-check (EVENT-DELIVERY-DELAY fix(a) + OFFLINE-NODE-FANOUT):
        // mirror pullRemoteNodeQueues. Without this the 90s connect-deadline block
        // re-enters via this Promise.all — a degraded remote's get_status_metadata sinks
        // into peer.connectQueue and stalls the whole prune probe. Only call the remote
        // when the peer is 'connected'; an unconnected peer is left undecorated (empty
        // session list), same as unreachable.
        //   • getter WIRED (cloud) → a null snapshot means "no peer object right now" =
        //     NOT connected (offline node whose failPeer deleted the peer). Skip (leave
        //     undecorated) rather than dialing into another 90s connect wait — the same
        //     null-race harden as pullRemoteNodeQueues.
        //   • getter UNWIRED (standalone) → do NOT skip, fall through (regression-free).
        if (!isLocalNode) {
            const getPeerStatus = components.getMeshPeerConnectionStatus;
            if (getPeerStatus) {
                const peerSnapshot = getPeerStatus(nodeDaemonId);
                if (!peerSnapshot || String(peerSnapshot.state) !== 'connected') return node;
            }
        }
        let statusResult: unknown;
        try {
            if (isLocalNode) {
                // get_status_metadata is a LOW-family registry command, not a
                // DaemonCommandHandler switch case — so it must be dispatched
                // through the router (which consults lowFamilyRegistry before
                // delegating to commandHandler). Calling commandHandler.handle()
                // directly falls through to `Unknown command: get_status_metadata`
                // and leaves the local node's live-session list empty in the mesh
                // graph. See router.execute() / low-family/index.ts.
                statusResult = await components.router.execute('get_status_metadata', {}, 'mesh');
            } else if (dispatchMeshCommand) {
                statusResult = await dispatchMeshCommand(nodeDaemonId, 'get_status_metadata', {});
            } else {
                return node; // remote node, no P2P transport — leave undecorated
            }
        } catch {
            return node; // unreachable — leave undecorated (empty session list)
        }
        const sessions = extractStatusMetadataSessions(statusResult);
        return sessions.length > 0 ? { ...node, sessions } : node;
    }));
}

// Pull the live session list out of a get_status_metadata result, tolerating the same
// envelope shapes unwrapReadChatPayload handles (direct CommandResult or { payload }/{ result }).
export function extractStatusMetadataSessions(raw: unknown): any[] {
    let cursor: unknown = raw;
    for (let depth = 0; depth < 4 && cursor && typeof cursor === 'object'; depth++) {
        const record = cursor as Record<string, unknown>;
        const status = record.status && typeof record.status === 'object' ? record.status as Record<string, unknown> : undefined;
        if (status && Array.isArray(status.sessions)) return status.sessions;
        if (Array.isArray(record.sessions)) return record.sessions;
        if (record.payload && typeof record.payload === 'object') { cursor = record.payload; continue; }
        if (record.result && typeof record.result === 'object') { cursor = record.result; continue; }
        if (record.data && typeof record.data === 'object') { cursor = record.data; continue; }
        break;
    }
    return [];
}

function extractPendingEventsResult(raw: unknown): { events: any[]; confirmed: boolean } {
    // Mirror unwrapReadChatPayload / extractStatusMetadataSessions: a local
    // commandHandler.handle() returns `{ success, events }` directly, but a
    // remote dispatchMeshCommand may wrap the same CommandResult in
    // `{ payload }` / `{ result }` / `{ data }`. Walking those envelopes is
    // required for PHASE 1 to see a worker's queued worktree_bootstrap_* (or
    // any other pending event) instead of silently extracting `[]`.
    let cursor: unknown = raw;
    for (let depth = 0; depth < 4 && cursor && typeof cursor === 'object'; depth++) {
        if (Array.isArray(cursor)) return { events: cursor, confirmed: true };
        const record = cursor as Record<string, unknown>;
        if (record.success === false) return { events: [], confirmed: false };
        if (Array.isArray(record.events)) return { events: record.events, confirmed: true };
        if (record.payload && typeof record.payload === 'object') { cursor = record.payload; continue; }
        if (record.result && typeof record.result === 'object') { cursor = record.result; continue; }
        if (record.data && typeof record.data === 'object') { cursor = record.data; continue; }
        break;
    }
    return { events: [], confirmed: false };
}

export function extractPendingEvents(raw: unknown): any[] {
    return extractPendingEventsResult(raw).events;
}

// Flatten a queued PendingMeshCoordinatorEvent into the flat payload shape
// handleMeshForwardEvent expects (mirrors the MCP buildMeshForwardPayloadFromPendingEvent).
export function buildForwardPayloadFromPending(event: any): Record<string, unknown> {
    const metadata = event?.metadataEvent && typeof event.metadataEvent === 'object'
        ? event.metadataEvent as Record<string, unknown>
        : {};
    return {
        event: readNonEmptyString(event?.event),
        meshId: readNonEmptyString(event?.meshId),
        nodeId: readNonEmptyString(event?.nodeId) || readNonEmptyString(metadata.meshNodeId),
        workspace: readNonEmptyString(event?.workspace) || readNonEmptyString(metadata.workspace),
        // Preserve the originating coordinator session id across the relay. It is normally
        // carried inside metadataEvent.meshCoordinatorSessionId (spread below), but pass the
        // top-level field through explicitly too so the handleMeshForwardEvent whitelist
        // recovers it regardless of which carrier the producing daemon used.
        ...(readNonEmptyString(event?.targetCoordinatorSessionId)
            ? { targetCoordinatorSessionId: readNonEmptyString(event.targetCoordinatorSessionId) }
            : {}),
        // RC32: same explicit passthrough for the coordinator DAEMON anchor. A sessionless
        // refine terminal event carries no meshCoordinatorSessionId, so this top-level
        // field is the only carrier the receive-side relay whitelist
        // (buildRelayMetadataEvent) can recover the return address from.
        ...(readNonEmptyString(event?.targetCoordinatorDaemonId)
            ? { targetCoordinatorDaemonId: readNonEmptyString(event.targetCoordinatorDaemonId) }
            : {}),
        ...metadata,
        // NOTIF-MISS (FIX 3): surface the dispatch task id at the TOP LEVEL so the relay's
        // received-stage trace (and buildRelayMetadataEvent) recovers it regardless of which
        // carrier the producing daemon used. The metadata spread above may carry the id only as
        // `meshActiveTaskId` (a worker provider event), leaving top-level `taskId` unset and the
        // received stage rendering `task=-`. Resolve both carriers into an explicit `taskId` so
        // dedup stays task-scoped end-to-end. Only set when a non-empty id exists (no clobber to
        // undefined when neither is present).
        ...((): Record<string, unknown> => {
            const tid = readNonEmptyString(metadata.taskId) || readNonEmptyString(metadata.meshActiveTaskId);
            return tid ? { taskId: tid } : {};
        })(),
        // T4 (B3b): carry the v2 envelope (protocolVersion/eventId/scope/dispatchedBy/
        // intendedFor) across the P2P relay boundary at the TOP LEVEL. These live on the
        // pending event itself, not inside metadataEvent, so without this the remote pull
        // re-queue would re-stamp a fresh eventId — breaking cross-machine idempotency and
        // downgrading the relayed completion to v1 broadcast routing. Spread LAST so the
        // authoritative envelope always wins over any stale key the metadata spread carried.
        ...serializeV2EnvelopeToWire(event as PendingMeshCoordinatorEvent),
    };
}
