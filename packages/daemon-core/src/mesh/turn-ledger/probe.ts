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
// registry-backed local session list (B4: 0 `get_status_metadata` calls for the
// local node), and `reprobeWorkerStatus` (transcript roster id 4).
//
// A REMOTE session's presence / status comes ONLY from the coordinator-held
// runtime the member pushes (mesh-node-git-state.ts) — there is no per-daemon
// `get_status_metadata` pull (data-path audit 2026-09-29, owner principle ④).
// No live hold → `unknown` plus a push request (`requestHeldPush`), never a read.
// ---------------------------------------------------------------------------

import { type LivenessResult, type SummaryRef, type TurnEvidence } from '@adhdev/mesh-shared';
import type { DaemonComponents } from '../../boot/daemon-components.js';
import { extractSessionPtyPid, type CpuActivity, type SessionProcessTreeInspection } from '../../process/session-process-tree.js';
import { readSessionBackgroundProcesses, type ProcessTableSource } from '../../process/process-table-snapshot.js';
import {
    readTranscriptForDaemonConsumer,
    TRANSCRIPT_STATUS_PROBE_MAX_AGE_MS,
    TRANSCRIPT_TERMINAL_EVIDENCE_MAX_AGE_MS,
} from '../transcript-daemon-consumer-read.js';
import { mapTranscriptViewToReadChatPayload } from '../transcript-read-chat-adapter.js';
import type { ReplicatedTranscriptViewV2 } from '../../seqscribe/transcript-keyed-codec.js';
import { backgroundWorkBaselineMs, evaluateTurnEndBackgroundWork } from './background-work-guard.js';
import type { TurnPolicy } from './policy.js';
import type { HoldReason, TurnAttempt } from './types.js';

function str(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

// ─── read_chat envelope helpers (moved verbatim) ────

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



function localInstanceStatus(
    components: Pick<DaemonComponents, 'instanceManager'>,
    key: string,
    transport: string | undefined,
): string | undefined {
    if (transport !== 'pty') return undefined;
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
        if (replica.view) return replica.view.status.toLowerCase();
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
    nativeMarker?: import('@adhdev/mesh-shared').NativeTurnMarkerRef;
    nativeFailure?: import('@adhdev/mesh-shared').ProviderFailure;
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
    /** Presence sample time when a cached member push supplied the read. */
    observedAtMs?: number;
    /** undefined = not read (not needed); null = a read was attempted and failed. */
    transcript?: TranscriptObservation | null;
    /** Sanitized command names of live worker-started descendant processes under the session PTY. */
    liveBackgroundProcesses?: readonly string[];
    /**
     * False when the process table could not be read this tick (no usable snapshot: first read
     * pending, failed, or stale). Absent = inspection not attempted. The guard never reads an
     * unknown inspection as "the processes exited".
     */
    backgroundProcessesKnown?: boolean;
    /** CPU activity of those processes between two snapshots (absent/'unknown' = not measurable — never idle). */
    backgroundCpuActivity?: CpuActivity;
    /** When the newer snapshot of that pair was read: the instant the CPU activity was observed. */
    backgroundCpuAtMs?: number;
    /** Newest sign the session's output is advancing: raw PTY output or the newest transcript bubble (epoch ms). */
    outputAtMs?: number;
}

// ─── the pure mapping: read → evidence ────────────────────────────────────

interface ProbeEvidenceContext {
    probeStartedAtMs?: number;
    nowMs: number;
    observedBy: string;
    policy: TurnPolicy;
    /** Handoff pointer for the final summary text (transcript_final only). */
    summary?: SummaryRef;
    /** Set by the scheduler's background-work monitor while awaiting post-nudge worker results. */
    holdTurnEnd?: boolean;
    /** The monitor's hold for this attempt generation expired: the weak-completion path decides again. */
    backgroundWorkReleased?: boolean;
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
 *   unknown presence                → liveness{unknown}       (R32u; a fresh observation on every read)
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
    const liveness = (result: LivenessResult): TurnEvidence => ({ ...base, eventId: eventId(`liveness_${result}`), kind: 'liveness', result, at: read.observedAtMs ?? ctx.nowMs, ...(ctx.probeStartedAtMs !== undefined ? { probeStartedAtMs: ctx.probeStartedAtMs } : {}) });

    if (read.presence === 'absent') return [liveness('dead')];
    // Every read records its observation time, including repeated unknown results.
    if (read.presence === 'unknown') return [liveness('unknown')];
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
        if (t.nativeMarker?.outcome === 'failed') return [{ ...base, eventId: eventId('native_failure'),
            kind: 'turn_end', strength: 'genuine', nativeOutcome: 'failed', nativeMarker: t.nativeMarker, providerFailure: t.nativeFailure ?? 'provider_error',
            live: { modal: t.activeModal, adapterPending: false, trailingTool: false } }];
        const finalThisTurn = t.finalAssistantAt !== undefined && t.finalAssistantAt >= boundary;
        const bgDecision = evaluateTurnEndBackgroundWork({
            attempt,
            finalSummary: finalThisTurn ? t.finalSummary : undefined,
            liveBackgroundProcesses: read.liveBackgroundProcesses,
            ...(ctx.backgroundWorkReleased ? { released: true } : {}),
        });
        if (ctx.holdTurnEnd || !bgDecision.complete) {
            if (attempt.state === 'finalizing') {
                const resumeAt = Math.max(ctx.nowMs, (attempt.weakSince ?? 0) + 1);
                return [
                    { ...base, at: resumeAt, eventId: eventId('bg_work_running'), kind: 'turn_started', retro: true },
                    liveness('alive'),
                ];
            }
            return [liveness('alive')];
        }
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
            }, liveness('alive')];
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
            }, liveness('alive')];
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
interface HeldRemoteSessions {
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
/** Empty lists can precede session restore at boot; require the launch grace too. */
export const EMPTY_HELD_ABSENCE_GRACE_MS = 2 * 60_000;

interface ComponentsProbeReaderOptions {
    analyzer: TranscriptAnalyzer;
    /**
     * Held remote session presence/status — the ONLY source for a remote
     * session's presence (members push; the coordinator never reads a member's
     * session list). Transcript content still comes from the replica / read_chat.
     */
    readHeldSessions?: (attempt: TurnAttempt, daemonId: string) => HeldRemoteSessions | null;
    /**
     * Nothing live is held for the attempt's node (the member is not pushing yet,
     * its push lapsed, or a handshake is pending): ask the member to PUSH (a
     * `mesh_node_state_nudge`, rate-limited by the refresher). Never a read —
     * this probe tick answers `unknown`; the next one reads what was pushed.
     */
    requestHeldPush?: (attempt: TurnAttempt, daemonId: string, workspace?: string) => void;
    /**
     * Process-table source (default: the shared one). Reads are asynchronous,
     * single-flight and TTL-cached; an unavailable/slow read means "unknown".
     */
    processSource?: ProcessTableSource;
    /** Test override of the whole inspection. May be async; null = unknown. */
    inspectProcessTree?: (
        rootPid: number | undefined,
        opts: { startedAfterMs: number },
    ) => Promise<(SessionProcessTreeInspection & { snapshotAtMs?: number }) | null> | (SessionProcessTreeInspection & { snapshotAtMs?: number }) | null;
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

function replicaPayload(snapshot: ReplicatedTranscriptViewV2): Record<string, unknown> {
    // `turnTerminalMarkers` stays ABSENT (the wire carries none): a replica read
    // takes the message-shape admission rules — weaker, never a fabricated veto.
    return mapTranscriptViewToReadChatPayload(snapshot, {
        omittedBefore: snapshot.coverage.omittedBefore,
        stale: false,
    }) as unknown as Record<string, unknown>;
}

/** The production reader: registry + in-process read_chat locally; coordinator-held status + replica/P2P read remotely. */
export function createComponentsProbeReader(components: ProbeComponents, options: ComponentsProbeReaderOptions): TurnProbeReader {
    const inspectTree = options.inspectProcessTree
        ?? ((pid: number | undefined, opts: { startedAfterMs: number }) => readSessionBackgroundProcesses(pid, {
            ...(options.processSource ? { source: options.processSource } : {}),
            startedAfterMs: opts.startedAfterMs,
        }));
    const analyze = (payload: Record<string, unknown> | null, attempt: TurnAttempt): TranscriptObservation | null => {
        if (!payload || (payload as { success?: boolean }).success === false) return null;
        return options.analyzer(payload, {
            turnStartedAtMs: turnStartBoundary(attempt),
            ...(attempt.providerType ? { providerType: attempt.providerType } : {}),
        });
    };

    /**
     * Live worker-started descendants of the session PTY, or undefined (none
     * seen OR unknown — never blocks, never completes). The read is async and
     * bounded: it joins the daemon's single in-flight process-table read.
     */
    async function readLocalBackgroundProcesses(attempt: TurnAttempt, instanceKey: string, fallbackInstance: unknown): Promise<Pick<TurnProbeRead, 'liveBackgroundProcesses' | 'backgroundCpuActivity' | 'backgroundCpuAtMs' | 'backgroundProcessesKnown'>> {
        if (attempt.scope === 'plain') return {};
        try {
            const inst = fallbackInstance ?? components.instanceManager.getInstance(instanceKey);
            const pid = extractSessionPtyPid(inst);
            if (!pid) return {};
            const tree = await inspectTree(pid, { startedAfterMs: backgroundWorkBaselineMs(attempt) });
            if (!tree) return { backgroundProcessesKnown: false };
            if (tree.liveProcessNames.length === 0) return { backgroundProcessesKnown: true };
            return {
                backgroundProcessesKnown: true,
                liveBackgroundProcesses: tree.liveProcessNames,
                backgroundCpuActivity: tree.cpuActivity,
                ...(typeof tree.snapshotAtMs === 'number' ? { backgroundCpuAtMs: tree.snapshotAtMs } : {}),
            };
        } catch {
            return {};
        }
    }

    /** Raw PTY output clock of a local session (bumped on every output chunk), when readable. */
    function readLocalPtyOutputAt(instanceKey: string, fallbackInstance: unknown): number | undefined {
        try {
            const inst = (fallbackInstance ?? components.instanceManager.getInstance(instanceKey)) as { adapter?: { getStatus?: (o?: { allowParse: boolean }) => { lastOutputAt?: unknown } } } | undefined;
            const at = inst?.adapter?.getStatus?.({ allowParse: false })?.lastOutputAt;
            return typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : undefined;
        } catch {
            return undefined;
        }
    }

    function outputAtFor(ptyAt: number | undefined, transcript: TranscriptObservation | null | undefined): number | undefined {
        const candidates = [ptyAt, transcript?.newestActivityAt].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        return candidates.length > 0 ? Math.max(...candidates) : undefined;
    }

    async function readLocal(attempt: TurnAttempt, holds: readonly HoldReason[]): Promise<TurnProbeRead> {
        const target = components.sessionRegistry.get(attempt.sessionId);
        const instance = target ? null : components.instanceManager.getInstance(attempt.sessionId);
        if (!target && !instance) return { presence: 'absent' };
        const instanceKey = target?.instanceKey || attempt.sessionId;
        const status = localInstanceStatus(components, instanceKey, target?.transport ?? 'pty');
        // A background-terminal footer can keep the PTY generating after the native
        // turn ended. Inspect descendants before the busy-status shortcut so the
        // transcript can establish that turn end and start the shared monitor.
        const background = await readLocalBackgroundProcesses(attempt, instanceKey, instance);
        const hasLiveBackgroundProcesses = (background.liveBackgroundProcesses?.length ?? 0) > 0;
        if (!hasLiveBackgroundProcesses && !wantsTranscript(attempt, holds, status)) {
            return { presence: 'present', ...(status ? { status } : {}) };
        }
        const ptyOutputAt = attempt.scope === 'plain' ? undefined : readLocalPtyOutputAt(instanceKey, instance);
        try {
            const result = await components.commandHandler.handle('read_chat', readArgsFor(attempt));
            const transcript = analyze(unwrapReadChatPayload(result), attempt);
            const outputAtMs = outputAtFor(ptyOutputAt, transcript);
            return {
                presence: 'present',
                ...(status ? { status } : {}),
                ...background,
                ...(outputAtMs !== undefined ? { outputAtMs } : {}),
                transcript,
            };
        } catch {
            const outputAtMs = outputAtFor(ptyOutputAt, null);
            return {
                presence: 'present',
                ...(status ? { status } : {}),
                ...background,
                ...(outputAtMs !== undefined ? { outputAtMs } : {}),
                transcript: null,
            };
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
        // Presence / status from the coordinator-HELD runtime (member-pushed, still
        // pushing) — the only source. "Absent" is trusted only when the observation
        // postdates this attempt's dispatch (a session just launched may not have been
        // pushed yet), the list was not truncated, and an empty list has cleared the
        // startup grace (a boot push may precede session restore); otherwise this tick is `unknown`.
        // Nothing live held → ask the member to push, answer `unknown`.
        const held = options.readHeldSessions?.(attempt, daemonId) ?? null;
        if (!held) {
            try { options.requestHeldPush?.(attempt, daemonId, workspace); } catch { /* best-effort */ }
            return { presence: 'unknown' };
        }
        const row = held.sessions.find((s) => str(s.id) === attempt.sessionId || str(s.sessionId) === attempt.sessionId || str(s.instanceId) === attempt.sessionId);
        if (!row) {
            const margin = held.sessions.length > 0 ? HELD_ABSENCE_MARGIN_MS : EMPTY_HELD_ABSENCE_GRACE_MS;
            return !held.truncated
                && held.observedAt > turnStartBoundary(attempt) + margin
                ? { presence: 'absent' }
                : { presence: 'unknown' };
        }
        const status = str(row.status).toLowerCase() || undefined;
        if (!wantsTranscript(attempt, holds, status)) return { presence: 'present', observedAtMs: held.observedAt, ...(status ? { status } : {}) };
        const replica = readTranscriptForDaemonConsumer({
            consumerId: 'daemon_terminal_evidence',
            ownerDaemonId: daemonId,
            rawSessionId: attempt.sessionId,
            maxAgeMs: TRANSCRIPT_TERMINAL_EVIDENCE_MAX_AGE_MS,
            store: components.transcriptReplicaStore,
        });
        if (replica.view) {
            return { presence: 'present', observedAtMs: held.observedAt, ...(status ? { status } : {}), transcript: analyze(replicaPayload(replica.view), attempt) };
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
