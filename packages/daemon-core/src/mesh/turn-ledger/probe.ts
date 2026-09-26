// ---------------------------------------------------------------------------
// turn-ledger/probe — read a session's live state and turn it into EVIDENCE
// ---------------------------------------------------------------------------
// Wiring-unification Phase C4 (C-W4). The coordinator-side probe that used to
// be spread over mesh-completion-synthesis (PHASE 4 transcript synth +
// acked-hold death backstop), mesh-reconcile-stranded-dispatch (assigned-row
// watchdogs, early-idle transcript completion, in-turn-progress redrive gate)
// and mesh-remote-event-pull (liveness / read_chat helpers). All of those
// DECIDED — they wrote terminal ledger rows, flipped queue rows, reclaimed.
// This module decides nothing: a probe reads, and what it read becomes
// `transcript_final` / `transcript_activity` / `turn_started{retro}` /
// `liveness` / `no_progress` evidence that the scheduler hands to
// the ledger (observe). The reducer (admission rules + hold table) is the only
// judge — a probe result is never a verdict.
//
// Layering: mesh/** may not value-import providers/** (check:boundaries), so
// the transcript analysis (final-assistant selection, trailing-tool count,
// native markers — all in providers/chat-message-normalization) is INJECTED as
// a `TranscriptAnalyzer` by the boot layer (boot/stages/loops.ts). The mapping
// from a read to evidence (`probeEvidence`) is pure and table-tested.
//
// Kept from mesh-remote-event-pull.ts (its pull half is deleted — cross-machine
// delivery is topic replication now): the read_chat envelope helpers, the
// P-γ per-daemon 5 s `get_status_metadata` cache, the registry-backed local
// session list (B4: 0 `get_status_metadata` calls for the local node), and
// `reprobeWorkerStatus` (transcript roster id 4).
// ---------------------------------------------------------------------------

import { canonicalDaemonId, type LivenessResult, type SummaryRef, type TurnEvidence } from '@adhdev/mesh-shared';
import type { DaemonComponents } from '../../boot/daemon-components.js';
import {
    readTranscriptForDaemonConsumer,
    TRANSCRIPT_STATUS_PROBE_MAX_AGE_MS,
    TRANSCRIPT_TERMINAL_EVIDENCE_MAX_AGE_MS,
} from '../transcript-daemon-consumer-read.js';
import { mapTranscriptSnapshotToReadChatPayload } from '../transcript-read-chat-adapter.js';
import type { ReplicatedTranscriptSnapshotV1 } from '../../seqscribe/transcript-projection.js';
import type { TurnPolicy } from './policy.js';
import type { HoldReason, TurnAttempt } from './types.js';

function str(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

// ─── read_chat / get_status_metadata envelope helpers (moved verbatim) ────

/**
 * Pull the read_chat payload out of whatever envelope the transport returned.
 * A local commandHandler.handle() returns the CommandResult directly; a remote
 * dispatchMeshCommand returns it possibly wrapped in { payload } / { result }.
 */
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
    return str(payload?.status).toLowerCase();
}

/**
 * PROJECTION-SELF-REFERENCE: the PROVIDER's own status verdict, independent of
 * any projected `status` a mesh-owned session's read_chat carries. Absent on an
 * older remote daemon → the projected status (the pre-fix behaviour, never a
 * fabricated idle).
 */
export function readChatPayloadProviderObservedStatus(payload: Record<string, unknown> | null): string {
    const observed = str(payload?.providerObservedStatus).toLowerCase();
    return observed || readChatPayloadStatus(payload);
}

/**
 * Pull the live session list out of a get_status_metadata result, tolerating
 * the same envelope shapes unwrapReadChatPayload handles.
 */
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

// ─── remote status probe (P-γ cache, moved verbatim) ──────────────────────

/** Same TTL as the MCP-side `probeStatusMetadataForNode` cache (P-γ). */
export const REMOTE_STATUS_PROBE_CACHE_TTL_MS = 5_000;

interface RemoteStatusProbeEntry {
    expiresAt: number;
    result: Promise<unknown>;
}

/** Per-components cache so two daemons (or two test fixtures) never share entries. */
const remoteStatusProbeCache = new WeakMap<object, Map<string, RemoteStatusProbeEntry>>();

/**
 * `get_status_metadata` for a REMOTE daemon, deduped + cached per canonical
 * daemon id. A rejected probe is evicted, never cached, so a transient failure
 * cannot poison the next tick.
 */
export function probeRemoteStatusMetadata(
    components: Pick<DaemonComponents, 'dispatchMeshCommand'>,
    daemonId: string,
    now: number = Date.now(),
): Promise<unknown> {
    const dispatchMeshCommand = components.dispatchMeshCommand;
    if (!dispatchMeshCommand) return Promise.reject(new Error('no mesh transport'));
    let cache = remoteStatusProbeCache.get(components);
    if (!cache) {
        cache = new Map();
        remoteStatusProbeCache.set(components, cache);
    }
    const key = canonicalDaemonId(daemonId) || daemonId;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) return cached.result;
    const result = Promise.resolve().then(() => dispatchMeshCommand(daemonId, 'get_status_metadata', {}));
    cache.set(key, { expiresAt: now + REMOTE_STATUS_PROBE_CACHE_TTL_MS, result });
    result.catch(() => {
        const entry = cache!.get(key);
        if (entry && entry.result === result) cache!.delete(key);
    });
    return result;
}

/**
 * This daemon's live sessions (`id` + `status`) from the session registry —
 * never by re-entering get_status_metadata (B4). `status` comes from the owning
 * CLI/ACP instance's state and is omitted for IDE/extension sessions.
 */
export function listLocalLiveSessions(components: Pick<DaemonComponents, 'sessionRegistry' | 'instanceManager'>): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const target of components.sessionRegistry.list()) {
        const status = localInstanceStatus(components, target.instanceKey || target.sessionId, target.transport);
        out.push({
            id: target.sessionId,
            sessionId: target.sessionId,
            providerType: target.providerType,
            transport: target.transport,
            ...(status ? { status } : {}),
        });
    }
    return out;
}

function localInstanceStatus(
    components: Pick<DaemonComponents, 'instanceManager'>,
    key: string,
    transport: string | undefined,
): string | undefined {
    if (transport !== 'pty' && transport !== 'acp') return undefined;
    try {
        const state = components.instanceManager.getInstance(key)?.getState?.();
        return str((state as { status?: unknown } | undefined)?.status).toLowerCase() || undefined;
    } catch {
        return undefined; // status is advisory — presence is what liveness needs
    }
}

/**
 * One fresh status read of a worker session (transcript roster id 4,
 * `daemon_worker_status_probe`). REMOTE: replica first, then the legacy
 * `read_chat`; LOCAL: the in-process `read_chat`. null = inconclusive.
 */
export async function reprobeWorkerStatus(
    components: DaemonComponents,
    args: { isLocalNode: boolean; nodeDaemonId: string; readArgs: Record<string, unknown> },
): Promise<string | null> {
    if (!args.isLocalNode) {
        const replica = readTranscriptForDaemonConsumer({
            consumerId: 'daemon_worker_status_probe',
            ownerDaemonId: args.nodeDaemonId,
            rawSessionId: str(args.readArgs.sessionId),
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

// ─── transcript observation (the analyzer is injected) ────────────────────

/**
 * What a transcript read showed, reduced to the scalars admission needs. The
 * text of the final assistant bubble (`finalSummary`) is carried only so the
 * runner can append it to `mesh.<id>.handoff`; it never enters evidence.
 */
export interface TranscriptObservation {
    /** Provider's own status verdict (lowercased); '' = not reported. */
    providerObservedStatus: string;
    /** A parked approval/question modal with real buttons. */
    activeModal: boolean;
    /** Final assistant bubble selected at/after the turn start (epoch ms). */
    finalAssistantAt?: number;
    finalSummary?: string;
    /** The final summary self-attributes to this turn (worker-result JSON). */
    selfAttributing: boolean;
    /** Tool/terminal bubbles after the selected final assistant. */
    trailingActivity: number;
    /** Newest bubble of ANY kind (epoch ms). */
    newestActivityAt?: number;
    /** Newest agent-side (non-user, non-system) bubble at/after the turn start. */
    newestAgentActivityAt?: number;
    /** A native history read happened for a provider with a native turn signal. */
    nativeRead: boolean;
    /** Scoped native turn-terminal marker, when one was found. */
    nativeMarker?: { outcome: 'completed' | 'aborted'; turnId?: string };
}

export type TranscriptAnalyzer = (
    payload: Record<string, unknown>,
    ctx: { turnStartedAtMs?: number; providerType?: string },
) => TranscriptObservation;

/** What one probe of one attempt's session saw. */
export interface TurnProbeRead {
    /** Is the session still hosted? `unknown` = no way to tell this tick (no transport / peer down). */
    presence: 'present' | 'absent' | 'unknown';
    /** Provider-observed status, when a status source answered. */
    status?: string;
    /** undefined = not read (not needed); null = a read was attempted and failed. */
    transcript?: TranscriptObservation | null;
}

// ─── the pure mapping: read → evidence ────────────────────────────────────

export interface ProbeEvidenceContext {
    nowMs: number;
    observedBy: string;
    policy: TurnPolicy;
    /** Handoff pointer for the final summary text (transcript_final only). */
    summary?: SummaryRef;
}

const BUSY_STATUSES = new Set(['generating', 'waiting_approval', 'waiting_choice', 'starting', 'thinking', 'busy']);

/** The turn's start boundary: a transcript bubble older than this belongs to a prior turn. */
export function turnStartBoundary(attempt: TurnAttempt): number {
    return attempt.consumedAt ?? attempt.deliveredAt ?? attempt.acceptedAt;
}

/**
 * Map one read to the evidence the reducer should see. PURE.
 *
 *   absent                          → liveness{dead}          (R31 reclaim)
 *   unknown presence                → liveness{unknown}       (R32u grace hold; once per streak)
 *   present, transcript read failed → liveness{read_failed}   (R31a / R31 on the 3rd)
 *   accepted/delivered + post-delivery agent bubble → turn_started{retro} (R4)
 *   busy status                     → liveness{alive} (+ transcript_activity when newer)
 *   idle + final assistant this turn → transcript_final{coordinator_probe} (admission decides)
 *   idle, no final, stalled ≥ stallNoticeMs → no_progress
 *   anything else                   → liveness{alive}
 *
 * The probe never emits a terminal verdict: transcript_final is admitted
 * strong / weak / held by the reducer's admission rules, exactly like the
 * provider-side evidence.
 */
export function probeEvidence(attempt: TurnAttempt, read: TurnProbeRead, ctx: ProbeEvidenceContext): TurnEvidence[] {
    const base = {
        at: ctx.nowMs,
        source: 'coordinator_probe' as const,
        sessionId: attempt.sessionId,
        attemptRef: { attemptId: attempt.attemptId, generation: attempt.generation },
        observedBy: ctx.observedBy,
    };
    const eventId = (kind: string): string => `probe:${attempt.attemptId}:g${attempt.generation}:${kind}:${ctx.nowMs}`;
    const liveness = (result: LivenessResult): TurnEvidence => ({ ...base, eventId: eventId(`liveness_${result}`), kind: 'liveness', result });

    if (read.presence === 'absent') return [liveness('dead')];
    // A peer that stays unreachable would otherwise re-record `unknown` on
    // every probe; the first one already armed the grace hold (R32u).
    if (read.presence === 'unknown') return attempt.lastLiveness === 'unknown' ? [] : [liveness('unknown')];
    if (read.transcript === null) return [liveness('read_failed')];

    const t = read.transcript;
    const boundary = turnStartBoundary(attempt);
    const status = (t?.providerObservedStatus || read.status || '').toLowerCase();

    if (attempt.state === 'accepted' || attempt.state === 'delivered') {
        // The in-turn-progress gate (STARTED-REDRIVE-NATIVE-SOURCE-BLINDSPOT):
        // a native-source provider emits no PTY turn start, so any agent bubble
        // after delivery is the proof the prompt was consumed.
        if (t?.newestAgentActivityAt !== undefined && t.newestAgentActivityAt >= boundary) {
            return [{ ...base, eventId: eventId('turn_started'), kind: 'turn_started', retro: true }];
        }
        return [];
    }

    if (status && BUSY_STATUSES.has(status)) {
        const out: TurnEvidence[] = [liveness('alive')];
        if (t?.newestActivityAt !== undefined && t.newestActivityAt > (attempt.lastActivityAt ?? 0)) {
            out.push({ ...base, eventId: eventId('transcript_activity'), kind: 'transcript_activity', newestActivityAt: t.newestActivityAt });
        }
        return out;
    }

    if (t && status === 'idle') {
        const finalThisTurn = t.finalAssistantAt !== undefined && t.finalAssistantAt >= boundary;
        if (finalThisTurn || t.nativeMarker) {
            return [{
                ...base,
                eventId: eventId('transcript_final'),
                kind: 'transcript_final',
                selfAttributing: t.selfAttributing && finalThisTurn,
                nativeRead: t.nativeRead,
                ...(t.nativeMarker ? { nativeMarker: t.nativeMarker } : {}),
                live: {
                    modal: t.activeModal,
                    adapterPending: false,
                    trailingTool: t.trailingActivity > 0,
                    ...(t.newestActivityAt !== undefined ? { newestActivityAt: t.newestActivityAt } : {}),
                },
                ...(finalThisTurn ? { messageAt: t.finalAssistantAt! } : {}),
                ...(ctx.summary ? { summary: ctx.summary } : {}),
            }];
        }
        const quietSince = Math.max(attempt.lastActivityAt ?? 0, boundary, t.newestActivityAt ?? 0);
        const stalledMs = Math.max(0, ctx.nowMs - quietSince);
        if (stalledMs >= ctx.policy.stallNoticeMs && !t.activeModal) {
            return [{
                ...base,
                eventId: eventId('no_progress'),
                kind: 'no_progress',
                stalledMs,
                observedStatus: 'idle',
                finalAssistantPresent: false,
            }];
        }
    }
    return [liveness('alive')];
}

// ─── which attempts want a transcript read ────────────────────────────────

/** Holds whose release depends on what the transcript says right now. */
export const TRANSCRIPT_PROBE_HOLDS: readonly HoldReason[] = ['weak_candidate', 'live_pending', 'transcript_quiet'];

/**
 * A status read alone answers "alive"; only these cases need the transcript
 * (a final assistant, trailing tools, the retro-start bubble).
 */
export function wantsTranscript(attempt: TurnAttempt, holds: readonly HoldReason[], status: string | undefined): boolean {
    if (attempt.state === 'accepted' || attempt.state === 'delivered' || attempt.state === 'finalizing') return true;
    if (holds.some((h) => TRANSCRIPT_PROBE_HOLDS.includes(h))) return true;
    const s = (status ?? '').toLowerCase();
    return s === '' || !BUSY_STATUSES.has(s);
}

// ─── the IO side: read one attempt's session ──────────────────────────────

/** Where an attempt's session lives, as resolved by targets.ts. */
export type ProbeLocation =
    | { kind: 'local' }
    | { kind: 'remote'; daemonId: string; workspace?: string }
    | { kind: 'unknown' };

export interface TurnProbeReader {
    read(attempt: TurnAttempt, location: ProbeLocation, holds: readonly HoldReason[]): Promise<TurnProbeRead>;
}

/**
 * A remote node's session list as the coordinator HOLDS it (member-pushed
 * runtime summary, mesh/mesh-node-git-state.ts). Returned only when trustworthy
 * — pushed by the member (changes arrive within the push debounce) and the
 * member is still pushing; null otherwise (no entry, a coordinator-probe
 * snapshot, stale, or an older member that does not push its runtime).
 */
export interface HeldRemoteSessions {
    sessions: ReadonlyArray<{ id: string; instanceId?: string; sessionId?: string; status?: string }>;
    /** Epoch ms the member observed this list. */
    observedAt: number;
    /** The member hit its per-summary session cap — absence proves nothing. */
    truncated?: boolean;
}

/**
 * A held list proves a session ABSENT only when it was observed at least this
 * long after the attempt's turn boundary (member ↔ coordinator clock skew, and
 * the launch → push debounce, must not turn into a false `dead`).
 */
export const HELD_ABSENCE_MARGIN_MS = 10_000;

export interface ComponentsProbeReaderOptions {
    analyzer: TranscriptAnalyzer;
    now?: () => number;
    /**
     * Held remote session presence/status. When it answers, the per-daemon
     * `get_status_metadata` round trip is skipped; transcript content still
     * comes from the replica / read_chat.
     */
    readHeldSessions?: (attempt: TurnAttempt, daemonId: string) => HeldRemoteSessions | null;
}

type ProbeComponents = Pick<DaemonComponents,
    'sessionRegistry' | 'instanceManager' | 'commandHandler' | 'dispatchMeshCommand' | 'getMeshPeerConnectionStatus' | 'transcriptReplicaStore'>;

function readArgsFor(attempt: TurnAttempt, workspace?: string): Record<string, unknown> {
    return {
        sessionId: attempt.sessionId,
        targetSessionId: attempt.sessionId,
        tailLimit: 10,
        // P0-2: include the activity surface — without it the trailing-tool
        // veto is blind (the 2026-08 mid-turn kimi incident).
        includeActivity: true,
        ...(workspace ? { workspace } : {}),
        ...(attempt.providerType ? { agentType: attempt.providerType, providerType: attempt.providerType } : {}),
    };
}

function replicaPayload(snapshot: ReplicatedTranscriptSnapshotV1): Record<string, unknown> {
    // `turnTerminalMarkers` stays ABSENT (the wire carries none): a replica read
    // takes the message-shape admission rules — weaker, never a fabricated veto.
    return mapTranscriptSnapshotToReadChatPayload(snapshot, {
        omittedBefore: snapshot.coverage.omittedBefore,
        stale: false,
    }) as unknown as Record<string, unknown>;
}

/** The production reader: registry + in-process read_chat locally; cached status + replica/P2P read remotely. */
export function createComponentsProbeReader(components: ProbeComponents, options: ComponentsProbeReaderOptions): TurnProbeReader {
    const now = options.now ?? (() => Date.now());
    const analyze = (payload: Record<string, unknown> | null, attempt: TurnAttempt): TranscriptObservation | null => {
        if (!payload || (payload as { success?: boolean }).success === false) return null;
        return options.analyzer(payload, {
            turnStartedAtMs: turnStartBoundary(attempt),
            ...(attempt.providerType ? { providerType: attempt.providerType } : {}),
        });
    };

    async function readLocal(attempt: TurnAttempt, holds: readonly HoldReason[]): Promise<TurnProbeRead> {
        const target = components.sessionRegistry.get(attempt.sessionId);
        const instance = target ? null : components.instanceManager.getInstance(attempt.sessionId);
        if (!target && !instance) return { presence: 'absent' };
        const status = localInstanceStatus(components, target?.instanceKey || attempt.sessionId, target?.transport ?? 'pty');
        if (!wantsTranscript(attempt, holds, status)) return { presence: 'present', ...(status ? { status } : {}) };
        try {
            const result = await components.commandHandler.handle('read_chat', readArgsFor(attempt));
            return { presence: 'present', ...(status ? { status } : {}), transcript: analyze(unwrapReadChatPayload(result), attempt) };
        } catch {
            return { presence: 'present', ...(status ? { status } : {}), transcript: null };
        }
    }

    async function readRemote(attempt: TurnAttempt, daemonId: string, workspace: string | undefined, holds: readonly HoldReason[]): Promise<TurnProbeRead> {
        const dispatch = components.dispatchMeshCommand;
        if (!dispatch) return { presence: 'unknown' };
        // Peer-connected pre-check (OFFLINE-NODE-FANOUT): a degraded remote's probe
        // must not sink into the connect queue. Getter unwired (standalone) → try.
        const getPeer = components.getMeshPeerConnectionStatus;
        if (getPeer) {
            const peer = getPeer(daemonId);
            if (!peer || String(peer.state) !== 'connected') return { presence: 'unknown' };
        }
        // Presence / status from the coordinator-HELD runtime when it is live
        // (member-pushed, still pushing). "Absent" from held state is trusted only
        // when the observation postdates this attempt's dispatch — a session just
        // launched may not have been pushed yet — and the list was not truncated;
        // otherwise (and for older members) the live per-daemon probe answers.
        let row: any;
        const held = options.readHeldSessions?.(attempt, daemonId) ?? null;
        const heldRow = held?.sessions.find((s) => str(s.id) === attempt.sessionId || str(s.sessionId) === attempt.sessionId || str(s.instanceId) === attempt.sessionId);
        if (heldRow) {
            row = heldRow;
        } else if (held && !held.truncated && held.sessions.length > 0
            && held.observedAt > turnStartBoundary(attempt) + HELD_ABSENCE_MARGIN_MS) {
            return { presence: 'absent' };
        } else {
            let sessions: any[];
            try {
                sessions = extractStatusMetadataSessions(await probeRemoteStatusMetadata(components, daemonId, now()));
            } catch {
                return { presence: 'unknown' };
            }
            row = sessions.find((s) => str(s?.id) === attempt.sessionId || str(s?.sessionId) === attempt.sessionId);
            if (!row) return sessions.length > 0 ? { presence: 'absent' } : { presence: 'unknown' };
        }
        const status = str(row.status).toLowerCase() || undefined;
        if (!wantsTranscript(attempt, holds, status)) return { presence: 'present', ...(status ? { status } : {}) };
        const replica = readTranscriptForDaemonConsumer({
            consumerId: 'daemon_terminal_evidence',
            ownerDaemonId: daemonId,
            rawSessionId: attempt.sessionId,
            maxAgeMs: TRANSCRIPT_TERMINAL_EVIDENCE_MAX_AGE_MS,
            store: components.transcriptReplicaStore,
        });
        if (replica.snapshot) {
            return { presence: 'present', ...(status ? { status } : {}), transcript: analyze(replicaPayload(replica.snapshot), attempt) };
        }
        try {
            const result = await dispatch(daemonId, 'read_chat', readArgsFor(attempt, workspace));
            return { presence: 'present', ...(status ? { status } : {}), transcript: analyze(unwrapReadChatPayload(result), attempt) };
        } catch {
            return { presence: 'present', ...(status ? { status } : {}), transcript: null };
        }
    }

    return {
        read(attempt, location, holds) {
            if (location.kind === 'local') return readLocal(attempt, holds);
            if (location.kind === 'remote') return readRemote(attempt, location.daemonId, location.workspace, holds);
            return Promise.resolve({ presence: 'unknown' });
        },
    };
}
