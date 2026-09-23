// ---------------------------------------------------------------------------
// turn-ledger/deliver — coordinator notices: produce, ingest, deliver (C2)
// ---------------------------------------------------------------------------
// Wiring-unification C-W3. Replaces the whole coordinator-notification path:
// `injectMeshSystemMessage`'s queue half, the pending-events queue
// (`mesh-events-pending.ts`, SQLite + JSONL), its drains (idle fast path,
// event-driven flush, the reconcile tick's PHASE 2 inject), the P2P pull
// (`get_pending_mesh_events` → `handleMeshForwardEvent` re-injection) and the
// Stage 5a terminal redrive. What is left is one path:
//
//   local   observe → reduce+txn → append turn.notify → turn.deliver → submit      (5 hops)
//   remote  W observe → W append turn.evidence → replication → C turn.ingest →
//           observe (reduce+txn) → C append turn.notify → turn.deliver → submit     (7 hops)
//
// Four pieces live here; the cursor mechanics are `seqscribe/mesh-turn-consumer.ts`
// (which may not import this file — the boot stage wires the handlers in):
//
//   1. `createCoordinatorNotifier` — the producer API for NON-turn notices
//      (refine terminals, worktree bootstrap, dispatch-blocked, graph gates …):
//      `ledger.notifyMeshEvent` with the text kept LOCAL (`payload_json.local`)
//      and, for a notice addressed to another daemon, the text appended to the
//      content-class `mesh.<id>.handoff` topic and linked by `ref`.
//   2. `createTurnIngestHandler` — `turn.ingest`: foreign `turn.evidence` owned
//      here → `observe`; `turn.committed` → release a locally held attempt ref;
//      a foreign `turn.notify` addressed here → re-issued as an own notice.
//   3. `createTurnDeliverHandler` — `turn.deliver`: own `turn.notify` addressed
//      here → suppression → render → route → `SessionInputPort.submit`, with
//      deferral as an AWAIT on a bus edge bounded by `at + deliveryCeilingMs`.
//   4. `readCoordinatorNotices` — the MCP-only coordinator surface
//      (`get_pending_mesh_events`): undelivered notices rendered + claimed into
//      the same `delivered:<writer>:<seq>` rows the cursor honours.
//
// EXACTLY-ONCE: a notice is delivered at most once per `(writer, seq)`: the
// cursor checks the `delivered:` row before submitting and writes it after the
// submit resolves; `messageId = notify:<writer>:<seq>` makes the input port
// dedupe a resubmit inside the process. Residual (C2): one duplicate when the
// process dies between submit and the claim insert.
//
// CONTENT BOUNDARY: nothing here writes text to `mesh.<id>.events`. Text is
// rendered at deliver time from local `turn_events` rows or the handoff topic.
// ---------------------------------------------------------------------------

import { createHash } from 'crypto';
import {
    daemonIdsEquivalent,
    isNotifyKind,
    isSummaryRef,
    isTurnEvidence,
    type NotifyKind,
    type OutboundMessage,
    type SubmitOutcome,
    type SummaryRef,
    type TurnEvidence,
} from '@adhdev/mesh-shared';
import { DEFAULT_TURN_POLICY, type TurnPolicy } from './policy.js';
import type { TurnLedger } from './ledger.js';
import type { TurnEventRow } from './store.js';
import type { TurnAttempt } from './types.js';
import { renderTurnNotify, type FormatStopReason, type TurnNotifyRefs, type TurnNotifyScalars } from './format.js';
import { routeNotice, type CoordinatorSessionView } from './routing.js';
import { evaluateNotifySuppression } from './suppression.js';
import { buildMeshSystemMessage } from '../mesh-events-utils.js';
import { shouldForceInjectMeshEvent } from '../mesh-event-classify.js';

// ─── shared shapes ─────────────────────────────────────────────────────────

/** A topic entry as the cursor hands it over (structural twin of `MeshTopicCursorEntry`). */
export interface DeliverCursorEntry {
    meshId: string;
    writer: string;
    seq: number;
    kind: string;
    payload: unknown;
    ref?: SummaryRef;
    own: boolean;
}

export interface DeliverLog {
    info(message: string): void;
    warn(message: string): void;
}

const NOOP_LOG: DeliverLog = { info: () => {}, warn: () => {} };

/** Minimal session-input surface (`SessionInputPort`, sessions/session-input-service.ts). */
export interface NoticeInputPort {
    submit(msg: OutboundMessage): Promise<SubmitOutcome>;
}

export interface TurnDeliverCounters {
    delivered: number;
    queued: number;
    duplicates: number;
    deferred: number;
    escalated: number;
    suppressed: number;
    noCoordinator: number;
    ackedElsewhere: number;
    refused: number;
    submitFailures: number;
    ingested: number;
    relayed: number;
    released: number;
    mcpRead: number;
    backlogDelivered: number;
}

export function createTurnDeliverCounters(): TurnDeliverCounters {
    return {
        delivered: 0, queued: 0, duplicates: 0, deferred: 0, escalated: 0, suppressed: 0, noCoordinator: 0,
        ackedElsewhere: 0, refused: 0, submitFailures: 0, ingested: 0, relayed: 0, released: 0, mcpRead: 0, backlogDelivered: 0,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isSelf(selfIds: readonly string[], daemonId: string | undefined): boolean {
    if (!daemonId) return false;
    return selfIds.some((id) => daemonIdsEquivalent(id, daemonId));
}

function claimKey(writer: string, seq: number): string {
    return `delivered:${writer}:${seq}`;
}

// ─── 1. producer API: non-turn coordinator notices ─────────────────────────

/**
 * A non-turn coordinator notice (the shape the retired `queuePendingMeshCoordinatorEvent`
 * accepted, minus the queue bookkeeping). `coordinatorMessage` / `metadataEvent`
 * are LOCAL content: they stay in `turn_events.payload_json.local` (or travel
 * on `mesh.<id>.handoff` for another daemon) and never reach the events topic.
 */
export interface CoordinatorNotice {
    meshId: string;
    /** Event name (`refine:completed`, `worktree_bootstrap_complete`, `coordinator_catchup` …). */
    event: string;
    nodeLabel?: string;
    nodeId?: string;
    workspace?: string;
    /** Pre-rendered text; when absent the text is rendered at deliver time from `metadataEvent`. */
    coordinatorMessage?: string;
    metadataEvent?: Record<string, unknown>;
    /** Coordinator daemon to deliver on; absent = this daemon. */
    targetCoordinatorDaemonId?: string;
    /** A specific coordinator session (strict route); absent = any coordinator of the mesh. */
    targetCoordinatorSessionId?: string;
    /** Stable id (dedupe across re-emits). Default: content hash within a 5-minute bucket. */
    eventId?: string;
    queuedAt?: number;
    /** BOOTSTRAP-MSG: a queued task already targets the bootstrapped node. */
    worktreeHasQueuedTask?: boolean;
}

export interface CoordinatorNotifierDeps {
    ledger: Pick<TurnLedger, 'notifyMeshEvent' | 'selfDaemonId'>;
    selfDaemonIds: () => readonly string[];
    /** Append content to `mesh.<id>.handoff`; absent/rejecting → the remote renders a pointer line. */
    appendHandoff?: (meshId: string, kind: string, payload: Record<string, unknown>) => Promise<SummaryRef>;
    now?: () => number;
    log?: DeliverLog;
}

export interface CoordinatorNotifier {
    /** Record one notice. `queued` = a new row (false = an identical notice inside the dedupe window). */
    notify(notice: CoordinatorNotice): { eventId: string; queued: boolean };
}

/** Same-notice dedupe window (the legacy pending-event fingerprint TTL). */
export const NOTICE_DEDUPE_BUCKET_MS = 5 * 60 * 1000;

function jsonSafe(value: unknown): unknown {
    try {
        return JSON.parse(JSON.stringify(value ?? null));
    } catch {
        return null;
    }
}

/** Deterministic notice id: content hash inside a 5-minute bucket (the fingerprint the pending queue deduped on). */
export function defaultNoticeEventId(notice: CoordinatorNotice, nowMs: number): string {
    const meta = notice.metadataEvent ?? {};
    const basis = JSON.stringify([
        notice.meshId, notice.event, str(meta.taskId) ?? '', notice.nodeId ?? '', notice.targetCoordinatorSessionId ?? '',
        notice.coordinatorMessage ?? '', str(meta.jobId) ?? '', str(meta.gateId) ?? '', str(meta.promptId) ?? '',
    ]);
    const hash = createHash('sha256').update(basis).digest('hex').slice(0, 24);
    return `notice:${hash}:${Math.floor(nowMs / NOTICE_DEDUPE_BUCKET_MS)}`;
}

export function createCoordinatorNotifier(deps: CoordinatorNotifierDeps): CoordinatorNotifier {
    const now = deps.now ?? (() => Date.now());
    const log = deps.log ?? NOOP_LOG;
    return {
        notify(notice) {
            const at = notice.queuedAt ?? now();
            const eventId = notice.eventId ?? defaultNoticeEventId(notice, at);
            const local = {
                ...(notice.nodeLabel ? { nodeLabel: notice.nodeLabel } : {}),
                ...(notice.nodeId ? { nodeId: notice.nodeId } : {}),
                ...(notice.workspace ? { workspace: notice.workspace } : {}),
                ...(notice.coordinatorMessage ? { coordinatorMessage: notice.coordinatorMessage } : {}),
                ...(notice.metadataEvent ? { metadataEvent: jsonSafe(notice.metadataEvent) } : {}),
                ...(notice.worktreeHasQueuedTask ? { worktreeHasQueuedTask: true } : {}),
                queuedAt: at,
            };
            const taskId = str(notice.metadataEvent?.taskId);
            const target = notice.targetCoordinatorDaemonId && !isSelf(deps.selfDaemonIds(), notice.targetCoordinatorDaemonId)
                ? notice.targetCoordinatorDaemonId
                : null;
            const base = {
                meshId: notice.meshId,
                event: notice.event,
                payload: local,
                eventId,
                at,
                ...(notice.targetCoordinatorSessionId ? { targetSessionId: notice.targetCoordinatorSessionId } : {}),
                ...(taskId ? { taskId } : {}),
            };
            if (!target) {
                const { inserted } = deps.ledger.notifyMeshEvent({ ...base, targetDaemonId: deps.ledger.selfDaemonId });
                return { eventId, queued: inserted };
            }
            // Another daemon hosts the coordinator: the text rides the handoff
            // topic, the notice carries only the ref (C10-1). The row is written
            // once the ref is known; a handoff failure degrades to a pointer line
            // on the receiving side, never to a lost notice.
            const handoffPayload = { event: notice.event, ...local };
            const append = deps.appendHandoff
                ? deps.appendHandoff(notice.meshId, 'mesh.notice', handoffPayload as Record<string, unknown>)
                : Promise.reject(new Error('no handoff writer'));
            void append.then(
                (ref) => { deps.ledger.notifyMeshEvent({ ...base, targetDaemonId: target, ref }); },
                (error: unknown) => {
                    log.warn(`notice ${notice.event} for daemon ${target} (mesh ${notice.meshId}) has no handoff text: ${error instanceof Error ? error.message : String(error)} — the coordinator gets a pointer line`);
                    deps.ledger.notifyMeshEvent({ ...base, targetDaemonId: target });
                },
            );
            return { eventId, queued: true };
        },
    };
}

// ─── 2. turn.ingest ───────────────────────────────────────────────────────

export interface TurnIngestDeps {
    ledger: Pick<TurnLedger, 'observe' | 'notifyMeshEvent' | 'selfDaemonId'>;
    selfDaemonIds: () => readonly string[];
    /** A committed attempt: the local instance holding its ref drops it (C-W5 executor). */
    releaseAttemptRef?: (e: { attemptId: string; generation: number }) => void;
    counters?: TurnDeliverCounters;
    log?: DeliverLog;
}

/** `turn.ingest` never defers: every branch is a synchronous, idempotent ledger call. */
export function createTurnIngestHandler(deps: TurnIngestDeps): (entry: DeliverCursorEntry) => void {
    const counters = deps.counters ?? createTurnDeliverCounters();
    const log = deps.log ?? NOOP_LOG;
    return (entry) => {
        if (entry.own || !isRecord(entry.payload)) return;
        const p = entry.payload;
        switch (entry.kind) {
            case 'turn.evidence': {
                if (!isSelf(deps.selfDaemonIds(), str(p.ownerDaemonId))) return;
                const evidence = p.evidence;
                if (!isTurnEvidence(evidence)) {
                    log.warn(`turn.ingest: evidence entry ${entry.writer}:${entry.seq} (mesh ${entry.meshId}) carries no valid evidence — skipped`);
                    return;
                }
                const result = deps.ledger.observe(evidence as TurnEvidence, { src: { writer: entry.writer, seq: entry.seq } });
                if (result.verdict !== 'duplicate') counters.ingested++;
                return;
            }
            case 'turn.committed': {
                const attemptId = str(p.attemptId);
                if (!attemptId || typeof p.generation !== 'number') return;
                deps.releaseAttemptRef?.({ attemptId, generation: p.generation });
                counters.released++;
                return;
            }
            case 'turn.notify': {
                if (!isSelf(deps.selfDaemonIds(), str(p.targetDaemonId))) return;
                const eventId = str(p.eventId);
                if (!eventId || !isNotifyKind(p.notify)) return;
                const { inserted } = deps.ledger.notifyMeshEvent({
                    meshId: entry.meshId,
                    event: 'relayed',
                    eventId: `${eventId}#relay`,
                    at: typeof p.at === 'number' ? p.at : undefined,
                    notify: p.notify as NotifyKind,
                    targetDaemonId: deps.ledger.selfDaemonId,
                    ...(str(p.targetSessionId) ? { targetSessionId: str(p.targetSessionId) } : {}),
                    ...(str(p.taskId) ? { taskId: str(p.taskId) } : {}),
                    ...(str(p.attemptId) ? { attemptId: str(p.attemptId) } : {}),
                    ...(entry.ref && isSummaryRef(entry.ref) ? { ref: entry.ref } : {}),
                    payload: { relayedFrom: entry.writer, relayedSeq: entry.seq },
                });
                if (inserted) counters.relayed++;
                return;
            }
            default:
                return;
        }
    };
}

// ─── 3. rendering ─────────────────────────────────────────────────────────

/** Resolve a handoff ref to its payload object (null = not replicated yet / unreadable). */
export type HandoffResolver = (ref: SummaryRef) => Record<string, unknown> | null;

export interface RenderContext {
    ledger: Pick<TurnLedger, 'getAttempt' | 'store'>;
    resolveHandoff?: HandoffResolver;
    statusLine?: (meshId: string) => string | null;
}

export interface RenderedNotice {
    text: string;
    notify: NotifyKind;
    event: string | null;
    /** Refs that did not resolve (the caller may wait ≤ quietWindowMs). */
    missing: number;
}

const LOCAL_TOPIC = 'local';
function localRef(slot: string): SummaryRef {
    return { topic: LOCAL_TOPIC, writer: slot, seq: 0 };
}

function textOf(payload: Record<string, unknown> | null): string | null {
    if (!payload) return null;
    return str(payload.text) ?? str(payload.summary) ?? str(payload.coordinatorMessage) ?? null;
}

const STATUS_LINE_KINDS: ReadonlySet<NotifyKind> = new Set<NotifyKind>(['completed', 'failed', 'cancelled', 'stopped', 'approval', 'choice', 'late_completion']);

function stopReasonOf(attempt: TurnAttempt | null): FormatStopReason {
    switch (attempt?.terminal?.reason) {
        case 'provider_auth_failed': return 'auth_failed';
        case 'provider_billing_failed': return 'billing_failed';
        default: return 'plain';
    }
}

function nodeLabelFor(attempt: TurnAttempt | null, notice: Record<string, unknown> | null): string {
    const explicit = str(notice?.nodeLabel);
    if (explicit) return explicit;
    if (attempt?.nodeId) return `Node '${attempt.nodeId}'`;
    return attempt?.providerType ? `Worker (${attempt.providerType})` : 'Worker';
}

function evidenceRowFor(ctx: RenderContext, notifyRow: TurnEventRow | null): TurnEventRow | null {
    if (!notifyRow) return null;
    const at = notifyRow.eventId.lastIndexOf('#notify:');
    if (at <= 0) return null;
    return ctx.ledger.store.getEvent(notifyRow.eventId.slice(0, at));
}

/**
 * Render one notice. `row` is the local `turn_events` row that published it
 * (null only when it was pruned — the attempt-level fallback still renders).
 */
export function renderNotice(ctx: RenderContext, meshId: string, entry: Record<string, unknown>, row: TurnEventRow | null): RenderedNotice {
    const notify = (isNotifyKind(entry.notify) ? entry.notify : 'mesh_event') as NotifyKind;
    const rowPayload = row?.payload ?? {};
    const local = isRecord(rowPayload.local) ? rowPayload.local as Record<string, unknown> : {};
    const localPayload = isRecord(local.payload) ? local.payload as Record<string, unknown> : null;
    const ref = isSummaryRef(rowPayload.ref) ? rowPayload.ref as SummaryRef : undefined;
    const handoff = ref && ctx.resolveHandoff ? ctx.resolveHandoff(ref) : null;
    const missing = ref && !handoff ? 1 : 0;
    const event = str(rowPayload.event) ?? null;

    if (notify === 'mesh_event') {
        const source = localPayload && !str(localPayload.relayedFrom) ? localPayload : handoff;
        const eventName = str(source?.event) ?? (event && event !== 'relayed' ? event : null);
        const nodeLabel = str(source?.nodeLabel) ?? 'Mesh';
        let text = str(source?.coordinatorMessage) ?? null;
        if (!text && source && eventName) {
            text = buildMeshSystemMessage({
                event: eventName,
                nodeLabel,
                metadataEvent: isRecord(source.metadataEvent) ? source.metadataEvent as Record<string, unknown> : {},
                worktreeHasQueuedTask: source.worktreeHasQueuedTask === true,
            }) || null;
        }
        if (!text) {
            text = missing
                ? `[System] A mesh notice${str(entry.taskId) ? ` for task ${str(entry.taskId)}` : ''} is not yet available on this daemon — call mesh_task_report once it replicates; do not poll repeatedly.`
                : `[System] ${nodeLabel} reported a mesh event${str(entry.taskId) ? ` for task ${str(entry.taskId)}` : ''}. Use mesh_status or mesh_read_chat once if you need details.`;
        }
        if (eventName && shouldForceInjectMeshEvent(eventName)) {
            const line = ctx.statusLine?.(meshId);
            if (line) text = `${text}\n\n${line}`;
        }
        return { text, notify, event: eventName, missing };
    }

    // Turn notices: scalars from the attempt, text from the local evidence
    // envelope (same daemon) or the handoff ref (relayed from a worker daemon).
    const attemptId = str(entry.attemptId);
    const attempt = attemptId ? ctx.ledger.getAttempt(attemptId) : null;
    const evidenceRow = evidenceRowFor(ctx, row);
    const envelope = evidenceRow && isRecord(evidenceRow.payload.local) && isRecord((evidenceRow.payload.local as Record<string, unknown>).envelope)
        ? (evidenceRow.payload.local as Record<string, unknown>).envelope as Record<string, unknown>
        : null;
    const notice = (isRecord(envelope?.notice) ? envelope!.notice as Record<string, unknown> : null)
        ?? (isRecord(handoff?.notice) ? handoff!.notice as Record<string, unknown> : null);
    const localTexts = new Map<string, string>();
    const localSummary = str(envelope?.finalSummary) ?? textOf(handoff);
    if (localSummary) localTexts.set('summary', localSummary);
    const modalMessage = str(notice?.modalMessage);
    if (modalMessage) localTexts.set('modal', modalMessage);
    const note = str(notice?.note);
    if (note) localTexts.set('note', note);

    const reason = attempt?.terminal?.reason;
    // Forced-timeout / hollow-exhausted failures render through the completion
    // template's dedicated branches (today's wording), not the plain stop text.
    const renderKind: NotifyKind = notify === 'failed' && (reason === 'finalization_timeout_no_response' || reason === 'hollow_max_retries')
        ? 'completed'
        : notify;
    const scalars: TurnNotifyScalars = {
        nodeLabel: nodeLabelFor(attempt, notice),
        ...(attempt?.taskId ? { taskId: attempt.taskId } : str(entry.taskId) ? { taskId: str(entry.taskId)! } : {}),
        ...(attempt ? { attemptId: attempt.attemptId, generation: attempt.generation, sessionId: attempt.sessionId } : {}),
        ...(attempt?.nodeId ? { nodeId: attempt.nodeId } : {}),
        ...(attempt?.providerType ? { providerType: attempt.providerType } : {}),
        ...(str(notice?.providerSessionId) ? { providerSessionId: str(notice?.providerSessionId)! } : {}),
        strength: notify === 'candidate' || attempt?.terminal?.strength === 'weak' ? 'weak' : 'genuine',
        stopReason: stopReasonOf(attempt),
        ...(notice?.reviewRecommended === true ? { reviewRecommended: true } : {}),
        ...(reason === 'finalization_timeout_no_response' ? { forcedTimeoutNoResponse: true } : {}),
        ...(reason === 'hollow_max_retries' && attempt
            ? { hollow: { requeueCount: attempt.hollowCount, maxRetries: attempt.maxTaskRetries, maxRetriesExhausted: true } }
            : {}),
        ...(notify === 'cancelled' && reason ? { cancelReason: reason } : {}),
        ...(notify === 'late_completion' && typeof row?.generation === 'number' ? { priorGeneration: row.generation } : {}),
        ...(str(notice?.promptId) ? { promptId: str(notice?.promptId)! } : {}),
        ...(Array.isArray(notice?.questions) ? { questions: notice!.questions as TurnNotifyScalars['questions'] } : {}),
        ...(notify === 'progress' && attempt?.taskId ? { progressTaskId: attempt.taskId } : {}),
        ...(isRecord(notice?.completionMetadata) ? { completionMetadata: notice!.completionMetadata as TurnNotifyScalars['completionMetadata'] } : {}),
        ...(typeof notice?.stalledMs === 'number' ? { stalledMs: notice.stalledMs, meshWorkerStall: true } : {}),
        ...(str(notice?.observedStatus) ? { observedStatus: str(notice?.observedStatus)! } : {}),
    };
    const refs: TurnNotifyRefs = {};
    if (localTexts.has('summary')) refs.summary = localRef('summary');
    else if (ref) refs.summary = ref;
    if (notify === 'choice' && !localTexts.has('summary') && localTexts.has('modal')) refs.summary = localRef('modal');
    if (notify === 'progress') refs.note = localTexts.has('note') ? localRef('note') : localTexts.has('summary') ? localRef('summary') : ref;
    const statusLine = STATUS_LINE_KINDS.has(notify) ? ctx.statusLine?.(meshId) ?? null : null;
    const rendered = renderTurnNotify({
        notify: renderKind,
        scalars,
        refs,
        resolveRef: (r) => (r.topic === LOCAL_TOPIC ? localTexts.get(r.writer) ?? null : textOf(ctx.resolveHandoff?.(r) ?? null)),
        statusLine,
    });
    return { text: rendered.text, notify, event, missing: missing + rendered.contentRefsMissing.length };
}

// ─── 4. turn.deliver ──────────────────────────────────────────────────────

/** Wakes deferred deliveries on bus edges; bounded by a deadline and a re-check cap. */
export interface DeliverEdgeWaiter {
    /** Resolve on the next edge for `meshId` (or any mesh), at `untilMs`, or after the re-check cap; reject on abort. */
    wait(meshId: string, untilMs: number, signal: AbortSignal): Promise<'edge' | 'timeout'>;
    /** Wake waiters (a coordinator status/modal/registered edge, an MCP ack). No meshId = all. */
    wake(meshId?: string): void;
}

export interface DeliverTimers {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: DeliverTimers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * In-process edge waiter. `recheckMs` bounds a single wait so a readiness
 * change that emits no bus edge (e.g. an auto-approve mask lifting) is still
 * noticed within one scheduler tick — a bounded re-check, not a stored hold.
 */
export function createDeliverEdgeWaiter(opts: { now: () => number; timers?: DeliverTimers; recheckMs?: number }): DeliverEdgeWaiter {
    const timers = opts.timers ?? REAL_TIMERS;
    const recheckMs = opts.recheckMs ?? DEFAULT_TURN_POLICY.tickMs;
    const waiters = new Set<{ meshId: string; fire: (v: 'edge' | 'timeout') => void }>();
    return {
        wait(meshId, untilMs, signal) {
            return new Promise((resolve, reject) => {
                if (signal.aborted) { reject(signal.reason ?? new Error('aborted')); return; }
                const delay = Math.max(0, Math.min(untilMs - opts.now(), recheckMs));
                let done = false;
                const waiter = {
                    meshId,
                    fire: (v: 'edge' | 'timeout') => {
                        if (done) return;
                        done = true;
                        waiters.delete(waiter);
                        timers.clearTimeout(handle);
                        signal.removeEventListener('abort', onAbort);
                        resolve(v);
                    },
                };
                const onAbort = () => {
                    if (done) return;
                    done = true;
                    waiters.delete(waiter);
                    timers.clearTimeout(handle);
                    reject(signal.reason ?? new Error('aborted'));
                };
                const handle = timers.setTimeout(() => waiter.fire(opts.now() >= untilMs ? 'timeout' : 'edge'), delay);
                signal.addEventListener('abort', onAbort, { once: true });
                waiters.add(waiter);
            });
        },
        wake(meshId) {
            for (const waiter of [...waiters]) {
                if (!meshId || waiter.meshId === meshId) waiter.fire('edge');
            }
        },
    };
}

export interface TurnDeliverDeps extends RenderContext {
    ledger: Pick<TurnLedger, 'getAttempt' | 'store' | 'claimDelivery' | 'selfDaemonId'>;
    selfDaemonIds: () => readonly string[];
    port: NoticeInputPort;
    /** This daemon's live coordinator sessions of a mesh (CLI instances with `meshCoordinatorFor`). */
    coordinators: (meshId: string) => CoordinatorSessionView[];
    waiter: DeliverEdgeWaiter;
    /** Events handled by a dedicated consumer (e.g. `coordinator_catchup`), never submitted as text. */
    isControlEvent?: (event: string) => boolean;
    policy?: TurnPolicy;
    now?: () => number;
    counters?: TurnDeliverCounters;
    log?: DeliverLog;
}

/** Outcome of one delivery attempt, for logs and tests. */
export type DeliverResult =
    | { outcome: 'skipped'; why: 'not_notify' | 'foreign' | 'not_addressed' | 'already_delivered' | 'control' }
    | { outcome: 'suppressed'; why: string }
    | { outcome: 'no_coordinator' }
    | { outcome: 'acked_elsewhere' }
    | { outcome: 'empty' }
    | { outcome: 'refused'; reason: string }
    /** Backlog pass only: the notice is not deliverable to an idle coordinator right now. */
    | { outcome: 'not_now' }
    | { outcome: 'delivered' | 'queued' | 'duplicate'; sessionId: string; escalated: boolean; waitedMs: number };

const RETRYABLE_REFUSALS = new Set(['no_target', 'session_exited', 'send_in_flight', 'not_ready', 'internal_error', 'bootstrap_pending']);
const MAX_SUBMIT_ROUNDS = 3;

function sleepUntil(waiter: DeliverEdgeWaiter, meshId: string, untilMs: number, signal: AbortSignal, now: () => number): Promise<void> {
    const step = async (): Promise<void> => {
        while (now() < untilMs) {
            // A missing-ref wait is a pure clock wait: edges only re-check early.
            await waiter.wait(meshId, untilMs, signal);
        }
    };
    return step();
}

export interface TurnDeliverHandlerOptions {
    /**
     * `backlog`: never wait — deliver only to an IDLE coordinator right now, else
     * return `not_now`. Used for notices the cursor already passed while no
     * coordinator session existed here (see `deliverNoticeBacklog`), so a
     * backlog pass can never bypass the cursor's deferral of a busy coordinator.
     */
    mode?: 'cursor' | 'backlog';
}

export function createTurnDeliverHandler(deps: TurnDeliverDeps, handlerOpts: TurnDeliverHandlerOptions = {}): (entry: DeliverCursorEntry, signal: AbortSignal) => Promise<DeliverResult> {
    const backlog = handlerOpts.mode === 'backlog';
    const policy = deps.policy ?? DEFAULT_TURN_POLICY;
    const now = deps.now ?? (() => Date.now());
    const counters = deps.counters ?? createTurnDeliverCounters();
    const log = deps.log ?? NOOP_LOG;

    return async (entry, signal) => {
        if (entry.kind !== 'turn.notify' || !isRecord(entry.payload)) return { outcome: 'skipped', why: 'not_notify' };
        if (!entry.own) return { outcome: 'skipped', why: 'foreign' };
        const p = entry.payload;
        if (!isSelf(deps.selfDaemonIds(), str(p.targetDaemonId))) return { outcome: 'skipped', why: 'not_addressed' };
        const key = claimKey(entry.writer, entry.seq);
        const store = deps.ledger.store;
        if (store.hasEvent(key)) return { outcome: 'skipped', why: 'already_delivered' };
        const row = (str(p.eventId) ? store.getEvent(str(p.eventId)!) : null) ?? store.findPublishedEvent(entry.writer, entry.seq);
        const eventName = str(row?.payload.event);
        if (eventName && deps.isControlEvent?.(eventName)) return { outcome: 'skipped', why: 'control' };
        const notify = (isNotifyKind(p.notify) ? p.notify : 'mesh_event') as NotifyKind;
        const at = typeof p.at === 'number' ? p.at : row?.atMs ?? now();
        const sessionForClaim = str(p.targetSessionId) ?? '';

        const attemptId = str(p.attemptId);
        const attempt = attemptId ? deps.ledger.getAttempt(attemptId) : null;
        const suppression = evaluateNotifySuppression({ notify, attempt, generation: row?.generation ?? null });
        if (suppression) {
            deps.ledger.claimDelivery({ writer: entry.writer, seq: entry.seq, meshId: entry.meshId, sessionId: sessionForClaim, outcome: `suppressed:${suppression}` });
            counters.suppressed++;
            log.info(`deliver mesh=${entry.meshId} entry=${entry.writer}:${entry.seq} notify=${notify} outcome=suppressed:${suppression}`);
            return { outcome: 'suppressed', why: suppression };
        }

        let rendered = renderNotice(deps, entry.meshId, p, row);
        if (rendered.missing > 0 && now() < at + policy.quietWindowMs) {
            if (backlog) return { outcome: 'not_now' };
            // A ref'd text that has not replicated yet waits ≤ quietWindowMs (C2), then ships the pointer.
            await sleepUntil(deps.waiter, entry.meshId, at + policy.quietWindowMs, signal, now);
            rendered = renderNotice(deps, entry.meshId, p, row);
        }
        if (!rendered.text.trim()) {
            // approval_resolved renders silently for a local coordinator (today's `return ''`).
            deps.ledger.claimDelivery({ writer: entry.writer, seq: entry.seq, meshId: entry.meshId, sessionId: sessionForClaim, outcome: 'empty' });
            return { outcome: 'empty' };
        }

        const deadline = at + policy.deliveryCeilingMs;
        const startedAt = now();
        let deferredOnce = false;
        let rounds = 0;
        const refusedSessions = new Set<string>();
        for (;;) {
            if (store.hasEvent(key)) {
                counters.ackedElsewhere++;
                log.info(`deliver mesh=${entry.meshId} entry=${entry.writer}:${entry.seq} notify=${notify} outcome=acked_elsewhere waitedMs=${now() - startedAt}`);
                return { outcome: 'acked_elsewhere' };
            }
            const coordinators = deps.coordinators(entry.meshId).filter((c) => !refusedSessions.has(c.sessionId));
            const route = routeNotice({ targetSessionId: str(p.targetSessionId) ?? null, coordinators, pastCeiling: !backlog && now() >= deadline });
            if (backlog && route.kind !== 'deliver') return { outcome: 'not_now' };
            if (route.kind === 'none') {
                // No injectable coordinator here: the MCP-only coordinator reads +
                // acks it (readCoordinatorNotices), or a CLI coordinator that
                // registers later takes it from the backlog. The cursor passes.
                counters.noCoordinator++;
                return { outcome: 'no_coordinator' };
            }
            if (route.kind === 'wait') {
                if (!deferredOnce) { deferredOnce = true; counters.deferred++; }
                await deps.waiter.wait(entry.meshId, deadline, signal);
                continue;
            }
            const messageId = `notify:${entry.writer}:${entry.seq}`;
            let outcome: SubmitOutcome;
            try {
                outcome = await deps.port.submit({
                    messageId,
                    sessionId: route.sessionId,
                    origin: 'mesh',
                    policy: { mode: 'queue' },
                    input: { parts: [{ type: 'text', text: rendered.text }], textFallback: rendered.text },
                    createdAt: now(),
                });
            } catch (error) {
                counters.submitFailures++;
                // A throw backs the cursor off (100 ms·2ⁿ ≤ 30 s) and redelivers the entry.
                throw error;
            }
            if (outcome.kind === 'refused') {
                rounds++;
                if (RETRYABLE_REFUSALS.has(outcome.reason) && rounds < MAX_SUBMIT_ROUNDS) {
                    refusedSessions.add(route.sessionId);
                    continue;
                }
                if (RETRYABLE_REFUSALS.has(outcome.reason)) {
                    counters.submitFailures++;
                    throw new Error(`notice ${messageId} refused (${outcome.reason}) by every coordinator of mesh ${entry.meshId}`);
                }
                deps.ledger.claimDelivery({ writer: entry.writer, seq: entry.seq, meshId: entry.meshId, sessionId: route.sessionId, outcome: `refused:${outcome.reason}` });
                counters.refused++;
                log.warn(`deliver mesh=${entry.meshId} entry=${entry.writer}:${entry.seq} notify=${notify} outcome=refused:${outcome.reason} session=${route.sessionId}`);
                return { outcome: 'refused', reason: outcome.reason };
            }
            const claimed = deps.ledger.claimDelivery({ writer: entry.writer, seq: entry.seq, meshId: entry.meshId, sessionId: route.sessionId, outcome: outcome.kind });
            if (!claimed) counters.duplicates++; // an MCP read claimed it between submit and here (C2 residual)
            if (outcome.kind === 'delivered') counters.delivered++;
            else if (outcome.kind === 'queued') counters.queued++;
            else counters.duplicates++;
            if (route.escalated) counters.escalated++;
            const waitedMs = now() - startedAt;
            log.info(`deliver mesh=${entry.meshId} entry=${entry.writer}:${entry.seq} notify=${notify}${rendered.event ? ` event=${rendered.event}` : ''} outcome=${outcome.kind}${route.escalated ? ' escalated=true' : ''} session=${route.sessionId} waitedMs=${waitedMs}`);
            return { outcome: outcome.kind, sessionId: route.sessionId, escalated: route.escalated, waitedMs };
        }
    };
}

// ─── 5. MCP-only coordinator read + ack; backlog; control notices ─────────

/** Wire shape of one notice on `get_pending_mesh_events` (field names kept for the MCP client). */
export interface PendingCoordinatorNoticeWire {
    eventId: string;
    writer: string;
    seq: number;
    meshId: string;
    event: string;
    notify: NotifyKind;
    nodeLabel: string;
    coordinatorMessage: string;
    queuedAt: number;
    taskId?: string;
    nodeId?: string;
    workspace?: string;
    targetCoordinatorSessionId?: string;
    metadataEvent?: Record<string, unknown>;
}

export interface ReadNoticesDeps extends RenderContext {
    ledger: Pick<TurnLedger, 'getAttempt' | 'store' | 'claimDelivery' | 'selfDaemonId'>;
    selfDaemonIds: () => readonly string[];
    isControlEvent?: (event: string) => boolean;
    now?: () => number;
    counters?: TurnDeliverCounters;
    waiter?: DeliverEdgeWaiter;
}

/** One notice this daemon typed into a coordinator session (composer-residue sweep input). */
export interface DeliveredNoticeView {
    /** The `delivered:<writer>:<seq>` claim row id (the recovery handle). */
    claimEventId: string;
    meshId: string;
    event: string;
    taskId: string | null;
    deliveredAt: number;
    /**
     * The rendered body WITHOUT the trailing mesh status line (the line is
     * re-rendered live, so it would not match what was typed; the body before
     * it is a stable prefix of the typed text).
     */
    text: string;
}

/** Claim outcomes that put the notice's text into a session composer. */
const TYPED_DELIVERY_OUTCOMES: ReadonlySet<string> = new Set(['delivered', 'queued']);

/**
 * Notices recently typed into a local coordinator session, re-rendered from the
 * ledger (own-writer notices only — a foreign notice's row lives on its writer).
 */
export function listRecentDeliveredNotices(ctx: RenderContext, sinceMs: number, limit = 200): DeliveredNoticeView[] {
    const out: DeliveredNoticeView[] = [];
    for (const claim of ctx.ledger.store.listRecentDeliveryClaims(sinceMs, limit)) {
        if (!TYPED_DELIVERY_OUTCOMES.has(str(claim.payload.outcome) ?? '')) continue;
        const coords = claim.eventId.slice('delivered:'.length);
        const cut = coords.lastIndexOf(':');
        const seq = cut > 0 ? Number(coords.slice(cut + 1)) : NaN;
        if (!Number.isSafeInteger(seq)) continue;
        const row = ctx.ledger.store.findPublishedEvent(coords.slice(0, cut), seq);
        const entry = row && isRecord(row.payload.entry) ? row.payload.entry as Record<string, unknown> : null;
        const meshId = row?.meshId ?? claim.meshId;
        if (!row || !entry || !meshId) continue;
        const rendered = renderNotice({ ledger: ctx.ledger, ...(ctx.resolveHandoff ? { resolveHandoff: ctx.resolveHandoff } : {}) }, meshId, entry, row);
        if (!rendered.text.trim()) continue;
        out.push({
            claimEventId: claim.eventId,
            meshId,
            event: rendered.event ?? rendered.notify,
            taskId: str(entry.taskId) ?? null,
            deliveredAt: claim.recordedAt,
            text: rendered.text,
        });
    }
    return out;
}

/** How far back an undelivered notice is still surfaced (older ones are history, not news). */
export const NOTICE_BACKLOG_WINDOW_MS = 24 * 60 * 60 * 1000;

function pendingNoticeRows(deps: ReadNoticesDeps, meshId: string, limit: number): TurnEventRow[] {
    const now = deps.now ?? (() => Date.now());
    const selfIds = deps.selfDaemonIds();
    return deps.ledger.store.listUndeliveredNotifies(meshId, { sinceMs: now() - NOTICE_BACKLOG_WINDOW_MS, limit })
        .filter((row) => {
            const entry = isRecord(row.payload.entry) ? row.payload.entry as Record<string, unknown> : null;
            if (!entry || !isSelf(selfIds, str(entry.targetDaemonId))) return false;
            const event = str(row.payload.event);
            return !(event && deps.isControlEvent?.(event));
        });
}

/**
 * The MCP-only coordinator inbox (`get_pending_mesh_events`): undelivered own
 * notices addressed to this daemon, rendered, and — with `ack` (default) —
 * claimed into the same `delivered:` rows, so the deliver cursor passes them
 * without submitting. Suppressed notices are claimed and not returned.
 */
export function readCoordinatorNotices(deps: ReadNoticesDeps, meshId: string, opts: { ack?: boolean; limit?: number; surfacedSessionId?: string } = {}): PendingCoordinatorNoticeWire[] {
    const ack = opts.ack !== false;
    const counters = deps.counters ?? createTurnDeliverCounters();
    const out: PendingCoordinatorNoticeWire[] = [];
    for (const row of pendingNoticeRows(deps, meshId, opts.limit ?? 200)) {
        const writer = row.srcWriter;
        const seq = row.publishedSeq;
        if (!writer || seq === null) continue;
        const entry = row.payload.entry as Record<string, unknown>;
        const notify = (isNotifyKind(entry.notify) ? entry.notify : 'mesh_event') as NotifyKind;
        const attemptId = str(entry.attemptId);
        const suppression = evaluateNotifySuppression({ notify, attempt: attemptId ? deps.ledger.getAttempt(attemptId) : null, generation: row.generation });
        if (suppression) {
            if (ack) deps.ledger.claimDelivery({ writer, seq, meshId, sessionId: str(entry.targetSessionId) ?? '', outcome: `suppressed:${suppression}` });
            continue;
        }
        const rendered = renderNotice(deps, meshId, entry, row);
        if (ack) {
            deps.ledger.claimDelivery({ writer, seq, meshId, sessionId: opts.surfacedSessionId ?? str(entry.targetSessionId) ?? '', outcome: 'mcp_read' });
        }
        if (!rendered.text.trim()) continue;
        const local = isRecord(row.payload.local) && isRecord((row.payload.local as Record<string, unknown>).payload)
            ? (row.payload.local as Record<string, unknown>).payload as Record<string, unknown>
            : {};
        out.push({
            eventId: row.eventId,
            writer,
            seq,
            meshId,
            event: rendered.event ?? notify,
            notify,
            nodeLabel: str(local.nodeLabel) ?? '',
            coordinatorMessage: rendered.text,
            queuedAt: row.atMs,
            ...(str(entry.taskId) ? { taskId: str(entry.taskId)! } : {}),
            ...(str(local.nodeId) ? { nodeId: str(local.nodeId)! } : {}),
            ...(str(local.workspace) ? { workspace: str(local.workspace)! } : {}),
            ...(str(entry.targetSessionId) ? { targetCoordinatorSessionId: str(entry.targetSessionId)! } : {}),
            ...(isRecord(local.metadataEvent) ? { metadataEvent: local.metadataEvent as Record<string, unknown> } : {}),
        });
        counters.mcpRead++;
    }
    if (ack && out.length > 0) deps.waiter?.wake(meshId);
    return out;
}

/**
 * Deliver notices the cursor passed while no coordinator session existed here,
 * once one registers (the `registered` bus edge). Same claim rows, same port,
 * so it can never double-deliver what the cursor or an MCP read already took.
 */
export async function deliverNoticeBacklog(deps: TurnDeliverDeps, meshId: string, signal: AbortSignal): Promise<number> {
    const handler = createTurnDeliverHandler(deps, { mode: 'backlog' });
    let delivered = 0;
    for (const row of pendingNoticeRows(deps, meshId, 100)) {
        if (!row.srcWriter || row.publishedSeq === null) continue;
        const result = await handler({ meshId, writer: row.srcWriter, seq: row.publishedSeq, kind: 'turn.notify', payload: row.payload.entry, own: true }, signal);
        if (result.outcome === 'delivered' || result.outcome === 'queued') delivered++;
        // Per-mesh order: stop at the first notice that cannot go to an idle
        // coordinator now (the cursor or the next edge takes it from there).
        if (result.outcome === 'not_now' || result.outcome === 'no_coordinator') break;
    }
    const counters = deps.counters;
    if (counters) counters.backlogDelivered += delivered;
    return delivered;
}

/** A control notice (an action for a local subsystem, never coordinator text). */
export interface ControlNotice {
    writer: string;
    seq: number;
    event: string;
    nodeId?: string;
    workspace?: string;
    metadataEvent: Record<string, unknown>;
    queuedAt: number;
}

/**
 * Undelivered control notices of one event name (e.g. the auto-fast-forward's
 * `coordinator_catchup` markers). `take(notice)` claims one after its action
 * succeeded; an unclaimed notice stays for the next pass (the legacy re-queue).
 */
export function listControlNotices(
    deps: Pick<ReadNoticesDeps, 'ledger' | 'selfDaemonIds' | 'now' | 'resolveHandoff'>,
    meshId: string,
    event: string,
): { notices: ControlNotice[]; take(notice: ControlNotice): boolean } {
    const now = deps.now ?? (() => Date.now());
    const selfIds = deps.selfDaemonIds();
    const notices: ControlNotice[] = [];
    for (const row of deps.ledger.store.listUndeliveredNotifies(meshId, { sinceMs: now() - NOTICE_BACKLOG_WINDOW_MS, limit: 200 })) {
        if (!row.srcWriter || row.publishedSeq === null) continue;
        const entry = isRecord(row.payload.entry) ? row.payload.entry as Record<string, unknown> : null;
        if (!entry || !isSelf(selfIds, str(entry.targetDaemonId))) continue;
        const local = isRecord(row.payload.local) && isRecord((row.payload.local as Record<string, unknown>).payload)
            ? (row.payload.local as Record<string, unknown>).payload as Record<string, unknown>
            : null;
        const ref = isSummaryRef(row.payload.ref) ? row.payload.ref as SummaryRef : undefined;
        const source = local && !str(local.relayedFrom) ? local : (ref ? deps.resolveHandoff?.(ref) ?? null : null);
        const name = str(row.payload.event) === 'relayed' ? str(source?.event) : str(row.payload.event);
        if (name !== event || !source) continue;
        notices.push({
            writer: row.srcWriter,
            seq: row.publishedSeq,
            event: name,
            ...(str(source.nodeId) ? { nodeId: str(source.nodeId)! } : {}),
            ...(str(source.workspace) ? { workspace: str(source.workspace)! } : {}),
            metadataEvent: isRecord(source.metadataEvent) ? source.metadataEvent as Record<string, unknown> : {},
            queuedAt: row.atMs,
        });
    }
    return {
        notices,
        take: (notice) => deps.ledger.claimDelivery({ writer: notice.writer, seq: notice.seq, meshId, sessionId: '', outcome: `control:${event}` }),
    };
}

/**
 * Retract undelivered notices that a later fact made obsolete (e.g. a
 * `mesh:dispatch_blocked` whose blocker cleared): claimed as `retracted`, so
 * neither the cursor nor an MCP read surfaces them. Returns the count.
 */
export function retractCoordinatorNotices(
    deps: Pick<ReadNoticesDeps, 'ledger' | 'selfDaemonIds' | 'now'>,
    meshId: string,
    match: (event: string, metadataEvent: Record<string, unknown>) => boolean,
): number {
    const now = deps.now ?? (() => Date.now());
    let retracted = 0;
    for (const row of deps.ledger.store.listUndeliveredNotifies(meshId, { sinceMs: now() - NOTICE_BACKLOG_WINDOW_MS, limit: 500 })) {
        if (!row.srcWriter || row.publishedSeq === null) continue;
        const local = isRecord(row.payload.local) && isRecord((row.payload.local as Record<string, unknown>).payload)
            ? (row.payload.local as Record<string, unknown>).payload as Record<string, unknown>
            : null;
        const event = str(row.payload.event);
        if (!event || !local) continue;
        if (!match(event, isRecord(local.metadataEvent) ? local.metadataEvent as Record<string, unknown> : {})) continue;
        if (deps.ledger.claimDelivery({ writer: row.srcWriter, seq: row.publishedSeq, meshId, sessionId: '', outcome: 'retracted' })) retracted++;
    }
    return retracted;
}

// ─── 6. the process-wide notice runtime (bound at S7) ─────────────────────

/**
 * What producers and command handlers reach without a `DaemonComponents` in
 * scope (the refine jobs, dispatch-failure / skip / parking notices, the
 * `get_pending_mesh_events` handler whose context predates S7). Bound once by
 * `boot/stages/mesh-runtime.ts` and cleared by its disposer — the same single
 * slot discipline as `seqscribeSlot`. The ledger itself travels by value on
 * `components.turnLedger`.
 */
export interface MeshNoticeRuntime {
    notify(notice: CoordinatorNotice): { eventId: string; queued: boolean };
    readNotices(meshId: string, opts?: { ack?: boolean; limit?: number; surfacedSessionId?: string }): PendingCoordinatorNoticeWire[];
    controlNotices(meshId: string, event: string): ReturnType<typeof listControlNotices>;
    retract(meshId: string, match: (event: string, metadataEvent: Record<string, unknown>) => boolean): number;
    /** An own undelivered notice for this mesh exists (idle-mission reminder gate). */
    hasUndelivered(meshId: string): boolean;
    /** This daemon hosts an injectable CLI coordinator for the mesh. */
    hasLiveCliCoordinator(meshId: string): boolean;
    /** Notices typed into a local coordinator session since `sinceMs` (composer-residue sweep). */
    recentDeliveredNotices?(sinceMs: number): DeliveredNoticeView[];
    /** Release one delivery claim so the backlog redelivers the notice (composer-residue recovery). */
    releaseDelivery?(claimEventId: string): boolean;
    /** True when `daemonId` is one of this daemon's id forms. */
    isSelfDaemon(daemonId: string): boolean;
    /** Another writer's `mesh.<id>.events` entries have not replicated here yet (Beacon `staleness().behind`). */
    replicationPending(meshId: string): boolean;
    /**
     * The ledger's evidence entry point, for the in-process relay path
     * (`handleMeshForwardEvent` from a command handler whose context predates S7).
     */
    evidence?: Pick<TurnLedger, 'observe' | 'selfDaemonId'>;
    /** Append to `mesh.<id>.handoff` (null when no seqscribe node / authority). */
    appendHandoff?: (meshId: string, kind: string, payload: Record<string, unknown>) => Promise<SummaryRef>;
    counters(): TurnDeliverCounters;
}

let boundNoticeRuntime: MeshNoticeRuntime | null = null;
let warnedUnbound = false;

export function bindMeshNoticeRuntime(runtime: MeshNoticeRuntime | null): void {
    boundNoticeRuntime = runtime;
    if (runtime) warnedUnbound = false;
}

export const meshNoticeRuntime = {
    current(): MeshNoticeRuntime | null {
        return boundNoticeRuntime;
    },
};

/**
 * The producer API for a non-turn coordinator notice (replaces
 * `queuePendingMeshCoordinatorEvent`). Returns true when a new notice row was
 * written; false when an identical one exists (dedupe window) or no runtime is
 * bound (before S7 / after shutdown — logged once).
 */
export function notifyMeshCoordinator(notice: CoordinatorNotice): boolean {
    const runtime = boundNoticeRuntime;
    if (!runtime) {
        if (!warnedUnbound) {
            warnedUnbound = true;
            // eslint-disable-next-line no-console
            console.warn(`[MeshNotice] notice ${notice.event} for mesh ${notice.meshId} dropped: no turn-ledger notice runtime is bound (daemon not booted, or shutting down)`);
        }
        return false;
    }
    const queued = runtime.notify(notice).queued;
    // A terminal supersedes its provisional notice for the same job (the
    // coordinator only needs the outcome): retract the still-undelivered one.
    const superseded = NOTICE_SUPERSEDES[notice.event];
    const jobId = str(notice.metadataEvent?.jobId);
    if (superseded && jobId) {
        try {
            runtime.retract(notice.meshId, (event, meta) => superseded.includes(event) && str(meta.jobId) === jobId);
        } catch { /* best-effort: a delivered provisional notice is harmless */ }
    }
    return queued;
}

/** Terminal notice → the provisional notices (same `jobId`) it makes obsolete. */
const NOTICE_SUPERSEDES: Readonly<Record<string, readonly string[]>> = {
    'refine:completed': ['refine:accepted'],
    'refine:failed': ['refine:accepted'],
};

/** Retract undelivered `mesh:dispatch_blocked` notices for one task (its blocker cleared). */
export function retractDispatchBlockedNotices(meshId: string | undefined, taskId: string | undefined): number {
    if (!meshId || !taskId) return 0;
    const runtime = boundNoticeRuntime;
    if (!runtime) return 0;
    return runtime.retract(meshId, (event, meta) => event === 'mesh:dispatch_blocked' && str(meta.taskId) === taskId);
}
