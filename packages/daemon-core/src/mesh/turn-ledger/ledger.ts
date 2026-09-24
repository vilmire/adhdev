// ---------------------------------------------------------------------------
// turn-ledger/ledger — `ledger.observe(evidence)`: THE turn write path (C2)
// ---------------------------------------------------------------------------
// Wiring-unification Phase C2 (C-W2). Every producer that used to decide
// "done" on its own submits evidence here instead:
//
//   observe → dedupe by eventId → resolve attempt → reduce (pure) →
//   ONE mesh-runtime.db transaction:
//       attempt row + hold set + evidence row + derived turn_events rows
//       (committed / notify / reclaim / cancel_dispatch / redeliver) +
//       mesh_queue requeue / runner steps 2–8 (graph advance)
//   → post-commit: executors (bus, cancel + worker-bind revoke, attempt-ref
//       release, redeliver, probe, graph drain), re-evaluation of held
//       evidence, and the PUBLISH of every `pending` row as a MeshTopicEntry.
//
// The two SQLite files (mesh-runtime.db, seqscribe.db) cannot share a txn, so
// the crash window "committed but not appended" is closed by `flushPublish()`
// at boot and on the scheduler tick (`republishPending`): consumers dedupe by
// the entry's `eventId`, which is stable across republish.
//
// Ownership: a daemon reduces only attempts it OWNS (the coordinator's daemon).
// Evidence for an attempt owned elsewhere is FORWARDED (verdict `forwarded`,
// published as `turn.evidence`) and reduced by the owner's `turn.ingest`
// consumer (C-W3) through this same `observe`.
// ---------------------------------------------------------------------------

import { randomUUID } from 'crypto';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import type { Database as DatabaseHandle } from 'better-sqlite3';
import {
    MESH_TOPIC_PROTOCOL_VERSION,
    isTurnEvidence,
    type MeshTopicEntry,
    type NotifyKind,
    type SummaryRef,
    type TurnEvidence,
    type TurnEvidenceOf,
} from '@adhdev/mesh-shared';
import { DEFAULT_TURN_POLICY, type TurnPolicy } from './policy.js';
import { expireHolds, reduce, type ReduceResult } from './reducer.js';
import { TurnStore, type TurnEventRow } from './store.js';
import {
    applyHostEffects,
    buildForwardedEvidenceEntry,
    effectEventRows,
    isPublishableAttempt,
    recordNotes,
    runPostCommitEffects,
    type TurnCompletionEnvelope,
    type TurnLedgerPorts,
    type TurnTxnHost,
    type TxnHostResult,
} from './effects.js';
import { isTerminalTurnState, type TurnAttempt, type TurnEffect } from './types.js';

/** Appends one entry; resolves with the appended coordinates. */
export interface TurnPublisherPort {
    publish(meshId: string, entry: MeshTopicEntry, opts?: { ref?: SummaryRef }): Promise<{ writer: string; seq: number }>;
}

export interface TurnLedgerLog {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

export interface TurnLedgerDeps {
    /** The mesh-runtime.db handle — the txn covers turn tables AND mesh_queue/graph rows. */
    db: DatabaseHandle;
    store?: TurnStore;
    /** This daemon's id: attempts it owns are reduced here, others forwarded. */
    selfDaemonId: string;
    policy?: TurnPolicy;
    now?: () => number;
    host?: TurnTxnHost | null;
    publisher?: TurnPublisherPort | null;
    ports?: TurnLedgerPorts;
    log?: TurnLedgerLog;
    /** Publish after every committed observe (default true). Tests turn it off to drive flushes by hand. */
    autoFlush?: boolean;
}

export interface ObserveOptions {
    /** Worker side: the attempt's owner, when it is not this daemon (from the instance's attemptRef/dispatch). */
    owner?: { daemonId: string; meshId: string };
    /** `turn.ingest`: the topic coordinates of the entry that carried this evidence. */
    src?: { writer: string; seq: number };
    /** Local-only completion envelope (worker_result etc.) for the graph's output version. */
    envelope?: TurnCompletionEnvelope;
}

export type ObserveVerdict = 'applied' | 'recorded' | 'rejected' | 'forwarded' | 'duplicate';

export interface ObserveResult {
    verdict: ObserveVerdict;
    rule?: string;
    rejection?: string;
    attempt: TurnAttempt | null;
    effects: TurnEffect[];
}

export interface PublishReport {
    published: number;
    failed: number;
    /** Rows left pending (publisher missing, or a mesh blocked by a failure). */
    pending: number;
}

export interface TurnLedgerCounters {
    observed: number;
    applied: number;
    recorded: number;
    rejected: number;
    forwarded: number;
    duplicates: number;
    published: number;
    publishFailed: number;
    postCommitFailed: number;
    missingPorts: number;
}

export interface MeshEventNotice {
    meshId: string;
    /** Non-turn event name (e.g. `refine:completed`); local-only, rendered at deliver time. */
    event: string;
    /** Local-only body (may hold text) — never published. */
    payload?: unknown;
    targetDaemonId: string;
    targetSessionId?: string;
    taskId?: string;
    /** Stable id (republish/dedupe key); a fresh UUID when omitted. */
    eventId?: string;
    at?: number;
    /**
     * Notify kind of the published entry (default `mesh_event`). The turn-ingest
     * consumer (C-W3) re-issues a foreign `turn.notify` addressed to this daemon
     * under its original kind, so the deliver cursor renders it as that shape.
     */
    notify?: NotifyKind;
    /** Text pointer on `mesh.<id>.handoff`, published as the entry's append `ref` (never inline). */
    ref?: SummaryRef;
    /** Attempt the notice is about (re-issued turn notices keep it for suppression/rendering). */
    attemptId?: string;
}

export interface TurnLedger {
    readonly store: TurnStore;
    readonly selfDaemonId: string;
    observe(evidence: TurnEvidence, opts?: ObserveOptions): ObserveResult;
    /** Attempt-less coordinator notice (`turn.notify{notify:'mesh_event'}`); replaces the legacy pending-events outbox insert. */
    notifyMeshEvent(notice: MeshEventNotice): { eventId: string; inserted: boolean };
    /** `turn.deliver` exactly-once claim: inserts `delivered:<writer>:<seq>`; false = already delivered. */
    claimDelivery(input: { writer: string; seq: number; meshId?: string | null; sessionId: string; outcome?: string }): boolean;
    isTerminal(attemptId: string): boolean | null;
    getAttempt(attemptId: string): TurnAttempt | null;
    openAttemptForSession(sessionId: string): TurnAttempt | null;
    /** `ExpireHoldsContext.sessionIdFor` — store-side join. */
    sessionIdFor(attemptId: string): string;
    /** Due holds as `hold_expired` evidence (the scheduler observes each). */
    expiredHoldEvidence(nowMs?: number): TurnEvidenceOf<'hold_expired'>[];
    /** Convenience for the scheduler tick: observe every due hold. */
    sweepExpiredHolds(nowMs?: number): ObserveResult[];
    nextHoldDeadline(): number | null;
    /** Publish every `pending` row (single-flight). Boot + scheduler tick call it (`republishPending`). */
    flushPublish(): Promise<PublishReport>;
    republishPending(): Promise<PublishReport>;
    pendingPublishCount(olderThanMs?: number): number;
    counters(): TurnLedgerCounters;
}

const REPORT_GATE_RULES: ReadonlySet<string> = new Set(['R9r', 'R12r', 'R13r', 'R17g', 'R9t', 'R13t']);

const DEFAULT_LOG: TurnLedgerLog = { info: () => {}, warn: () => {}, error: () => {} };
const PUBLISH_BATCH = 256;

function holdAttemptId(holdId: string): string {
    const at = holdId.lastIndexOf(':');
    return at > 0 ? holdId.slice(0, at) : holdId;
}

/** Re-evaluation of held evidence (H7 / R16): the live-pending veto is cleared. */
function forceLiveFalse(evidence: TurnEvidence, eventId: string): TurnEvidence | null {
    const idle = { modal: false, adapterPending: false, trailingTool: false };
    if (evidence.kind === 'transcript_final') return { ...evidence, eventId, live: idle };
    if (evidence.kind === 'turn_end') return { ...evidence, eventId, live: idle };
    return null;
}

export function createTurnLedger(deps: TurnLedgerDeps): TurnLedger {
    const store = deps.store ?? new TurnStore(deps.db);
    const policy = deps.policy ?? DEFAULT_TURN_POLICY;
    const now = deps.now ?? (() => Date.now());
    const log = deps.log ?? DEFAULT_LOG;
    const ports = deps.ports ?? {};
    const autoFlush = deps.autoFlush !== false;
    const counters: TurnLedgerCounters = {
        observed: 0, applied: 0, recorded: 0, rejected: 0, forwarded: 0, duplicates: 0,
        published: 0, publishFailed: 0, postCommitFailed: 0, missingPorts: 0,
    };

    const txn = <T>(fn: () => T): T => deps.db.transaction(fn).immediate();

    function resolveAttempt(evidence: TurnEvidence): TurnAttempt | null {
        if (evidence.attemptRef) return store.getAttempt(evidence.attemptRef.attemptId);
        if (evidence.kind === 'dispatch_accepted') return store.getAttempt(`${evidence.scope}:${evidence.eventId}`);
        if (evidence.kind === 'hold_expired') return store.getAttempt(holdAttemptId(evidence.holdId));
        if (evidence.taskId) return store.findLatestAttemptForTask(null, evidence.taskId);
        return store.findOpenAttemptForSession(evidence.sessionId);
    }

    function evidenceRow(evidence: TurnEvidence, result: { verdict: ObserveVerdict; rule?: string; rejection?: string; fromState: string | null; toState: string | null; attempt: TurnAttempt | null; notes: string[] }, nowMs: number, opts: ObserveOptions, publish?: { meshId: string; entry: MeshTopicEntry }) {
        const attempt = result.attempt;
        const meshId = publish?.meshId ?? attempt?.meshId ?? opts.owner?.meshId ?? null;
        return {
            eventId: evidence.eventId,
            meshId,
            attemptId: attempt?.attemptId ?? evidence.attemptRef?.attemptId ?? null,
            generation: attempt?.generation ?? evidence.attemptRef?.generation ?? null,
            sessionId: evidence.sessionId,
            kind: evidence.kind,
            source: evidence.source,
            verdict: result.verdict === 'duplicate' ? 'recorded' as const : result.verdict,
            rule: result.rule ?? null,
            rejection: result.rejection ?? null,
            dedupeKey: evidence.eventId,
            fromState: result.fromState,
            toState: result.toState,
            payload: {
                ...(meshId ? { meshId } : {}),
                evidence,
                ...(result.notes.length > 0 ? { notes: result.notes } : {}),
                ...(opts.envelope ? { local: { envelope: opts.envelope } } : {}),
                ...(publish ? { entry: publish.entry } : {}),
            },
            observedBy: evidence.observedBy,
            srcWriter: opts.src?.writer ?? null,
            srcSeq: opts.src?.seq ?? null,
            publishState: publish ? 'pending' as const : 'none' as const,
            atMs: evidence.at,
            recordedAt: nowMs,
        };
    }

    interface Step { evidence: TurnEvidence; result: ReduceResult; host: TxnHostResult }

    /**
     * R9t/R13t commit a report R17g recorded earlier: the graph's output version
     * takes the REPORT's local envelope (the primary evidence), not the idle
     * edge's / scheduler's that happened to trigger the commit.
     */
    function recordedReportEnvelope(attempt: TurnAttempt | null, evidence: TurnEvidence): TurnCompletionEnvelope | undefined {
        const report = attempt?.data.report;
        if (!attempt?.terminal || evidence.kind === 'worker_report' || !report || report.generation !== attempt.generation) return undefined;
        if (attempt.terminal.reason !== 'worker_reported') return undefined;
        const local = store.getEvent(report.eventId)?.payload.local;
        const envelope = local && typeof local === 'object' ? (local as { envelope?: unknown }).envelope : undefined;
        return envelope && typeof envelope === 'object' ? envelope as TurnCompletionEnvelope : undefined;
    }

    /** The report gate (R9r/R12r/R13r, R17g/R9t/R13t) is rare and load-bearing for diagnosis: always INFO. */
    function logReportGate(rule: string | undefined, attempt: TurnAttempt | null): void {
        if (!attempt || !rule || !REPORT_GATE_RULES.has(rule)) return;
        const who = `attempt ${attempt.attemptId} g${attempt.generation} (task ${attempt.taskId ?? '?'}, session ${attempt.sessionId})`;
        if (rule === 'R17g') log.info(`turn-ledger: worker report recorded while ${who} is still generating — awaiting the idle edge (await_end hold ${Math.round(policy.awaitEndMs / 1000)}s)`);
        else if (rule === 'R9t') log.info(`turn-ledger: idle edge after the worker report — ${who} committed from the report`);
        else if (rule === 'R13t') log.info(`turn-ledger: no idle edge within ${Math.round(policy.awaitEndMs / 1000)}s of the worker report — ${who} committed from the report`);
        else if (rule === 'R9r') log.info(`turn-ledger: idle end of ${who} awaits the worker report (await_report hold ${Math.round(policy.awaitReportMs / 1000)}s)`);
        else if (rule === 'R12r') log.info(`turn-ledger: false idle: worker resumed — ${who} back to generating (falseIdleCount=${attempt.data.falseIdleCount ?? 0})`);
        else log.info(`turn-ledger: no worker report within ${Math.round(policy.awaitReportMs / 1000)}s — ${who} committed weak`);
    }

    /**
     * One reduce + persist step inside the caller's txn. Returns every step it
     * applied (a superseded plain attempt is a nested step) for the post-commit half.
     */
    function applyStep(evidence: TurnEvidence, attempt: TurnAttempt | null, opts: ObserveOptions, nowMs: number, nested = false): Step[] {
        const steps: Step[] = [];
        const holds = attempt ? store.activeHolds(attempt.attemptId) : [];
        let result = reduce({ attempt, holds, evidence, policy, nowMs });
        const opened = !attempt && result.attempt && result.verdict === 'applied';
        // The daemon that reduces an attempt into existence owns it (the reducer
        // stamps observedBy, which for ingested evidence is the remote observer).
        if (opened && result.attempt) result = { ...result, attempt: { ...result.attempt, ownerDaemonId: deps.selfDaemonId } };
        // A superseded plain turn is closed, not stopped: its session is the one
        // receiving the new dispatch.
        if (nested) result = { ...result, effects: result.effects.filter((e) => e.kind !== 'cancel_dispatch') };

        // ≤1 open attempt per session (ux_turn_attempts_open_session). A plain
        // attempt yields to a dispatch (superseded); an open mesh attempt refuses it.
        // Checked whenever an open attempt LANDS on a session: when it is opened,
        // and when an applied step moves it onto another session (`delivered`
        // to the session that took the prompt, `session_rebound`) — without the
        // second case a delivery onto a session with an open plain turn tripped
        // the unique index instead of superseding the plain turn.
        const moved = !!attempt && !!result.attempt && result.verdict === 'applied'
            && !result.attempt.terminal && result.attempt.sessionId !== attempt.sessionId;
        if ((opened || moved) && result.attempt && !nested) {
            const conflicting = store.findOpenAttemptForSession(result.attempt.sessionId);
            if (conflicting && conflicting.attemptId !== result.attempt.attemptId) {
                if (conflicting.scope === 'plain') {
                    const supersede: TurnEvidence = {
                        eventId: `${evidence.eventId}#supersede:${conflicting.attemptId}`,
                        at: evidence.at, source: 'dispatch', sessionId: conflicting.sessionId, observedBy: evidence.observedBy,
                        attemptRef: { attemptId: conflicting.attemptId, generation: conflicting.generation },
                        kind: 'cancel', reason: 'superseded',
                    };
                    steps.push(...applyStep(supersede, conflicting, {}, nowMs, true));
                } else {
                    log.warn(`turn-ledger: refused ${evidence.kind} ${evidence.eventId} — session ${conflicting.sessionId} already holds open attempt ${conflicting.attemptId}`);
                    result = { attempt: null, holds: [], effects: [{ kind: 'record', note: 'open_attempt_conflict' }], verdict: 'rejected', rejection: 'illegal_transition' };
                }
            }
        }

        const next = result.attempt;
        if (result.verdict === 'applied' && next) {
            store.upsertAttempt(next, nowMs);
            store.syncHolds(next.attemptId, result.holds, nowMs);
        }
        const inserted = store.insertEvent(evidenceRow(evidence, {
            verdict: result.verdict,
            ...(result.rule ? { rule: result.rule } : {}),
            ...(result.rejection ? { rejection: result.rejection } : {}),
            fromState: attempt?.state ?? null,
            toState: next?.state ?? null,
            attempt: next ?? attempt,
            notes: recordNotes(result.effects),
        }, nowMs, opts));
        if (!inserted) {
            // The PK check above ran outside this txn; a concurrent observe of the
            // same eventId got here first. Abort: the other call owns the effects.
            throw new DuplicateEvidence(evidence.eventId);
        }
        const subject = next ?? attempt;
        if (result.verdict === 'rejected' || !subject) {
            steps.push({ evidence, result, host: { terminalTasks: [] } });
            return steps;
        }

        // Derived rows for applied AND recorded verdicts (R27's late_completion
        // notice and R28a's cancel ride a recorded verdict).
        for (const row of effectEventRows({ evidence, attempt: subject, effects: result.effects, nowMs, observedBy: evidence.observedBy })) {
            if (!store.insertEvent(row)) {
                // UNIQUE(attempt, generation, kind, dedupe): a second `committed` row
                // for one generation is the exactly-one-commit invariant breaking.
                if (row.kind === 'committed') throw new Error(`turn-ledger invariant: second commit for ${subject.attemptId} g${row.generation}`);
            }
        }
        const envelope = recordedReportEnvelope(next, evidence) ?? opts.envelope;
        const host = result.verdict === 'applied' && next
            ? applyHostEffects(deps.host ?? null, result.effects, { attempt: next, evidence, nowMs, ...(envelope ? { envelope } : {}) })
            : { terminalTasks: [] };
        steps.push({ evidence, result, host });
        return steps;
    }

    function forward(evidence: TurnEvidence, owner: { daemonId: string; meshId: string }, nowMs: number, opts: ObserveOptions): ObserveResult {
        const ref = evidence.attemptRef;
        if (!ref) {
            txn(() => store.insertEvent(evidenceRow(evidence, { verdict: 'rejected', rejection: 'no_attempt', fromState: null, toState: null, attempt: null, notes: ['forward_without_attempt_ref'] }, nowMs, opts)));
            counters.rejected++;
            return { verdict: 'rejected', rejection: 'no_attempt', attempt: null, effects: [] };
        }
        const entry = buildForwardedEvidenceEntry(evidence, { attemptId: ref.attemptId, generation: ref.generation, ownerDaemonId: owner.daemonId });
        txn(() => store.insertEvent(evidenceRow(evidence, { verdict: 'forwarded', fromState: null, toState: null, attempt: null, notes: [] }, nowMs, opts, { meshId: owner.meshId, entry })));
        counters.forwarded++;
        if (autoFlush) void flushPublish();
        return { verdict: 'forwarded', attempt: null, effects: [] };
    }

    function observe(evidence: TurnEvidence, opts: ObserveOptions = {}): ObserveResult {
        counters.observed++;
        if (!isTurnEvidence(evidence)) {
            counters.rejected++;
            log.error(`turn-ledger: refused malformed evidence (${String((evidence as { kind?: unknown })?.kind)}) — fails the mesh-shared content guard`);
            return { verdict: 'rejected', rejection: 'invalid_evidence', attempt: null, effects: [] };
        }
        if (store.hasEvent(evidence.eventId)) {
            counters.duplicates++;
            return { verdict: 'duplicate', attempt: null, effects: [] };
        }
        const nowMs = now();
        const attempt = resolveAttempt(evidence);
        // Reduce only what this daemon owns; forward the rest to the owner.
        const ownerDaemonId = attempt ? attempt.ownerDaemonId : opts.owner?.daemonId;
        const ownerMeshId = attempt?.meshId ?? opts.owner?.meshId;
        if (ownerDaemonId && !daemonIdsEquivalent(ownerDaemonId, deps.selfDaemonId) && ownerMeshId) {
            return forward(evidence, { daemonId: ownerDaemonId, meshId: ownerMeshId }, nowMs, opts);
        }

        let steps: Step[];
        try {
            steps = txn(() => applyStep(evidence, attempt, opts, nowMs));
        } catch (error) {
            if (error instanceof DuplicateEvidence) {
                counters.duplicates++;
                return { verdict: 'duplicate', attempt: null, effects: [] };
            }
            throw error;
        }
        const { result } = steps[steps.length - 1]!;
        if (result.verdict === 'applied') counters.applied++;
        else if (result.verdict === 'recorded') counters.recorded++;
        else counters.rejected++;

        // ── post-commit (nested supersede steps first, in apply order) ──
        let publish = false;
        for (const step of steps) {
            if (step.result.verdict === 'rejected') continue;
            logReportGate(step.result.rule, step.result.attempt);
            const post = runPostCommitEffects(ports, step.result.effects, {
                attempt: step.result.attempt,
                nowMs,
                terminalTasks: step.host.terminalTasks,
                onError: (kind, error) => {
                    counters.postCommitFailed++;
                    log.error(`turn-ledger: post-commit ${kind} failed for ${step.evidence.eventId}: ${error instanceof Error ? error.message : String(error)}`);
                },
                onSkip: (kind, detail) => {
                    log.info(`turn-ledger: post-commit ${kind} skipped for ${step.evidence.eventId}: ${detail}`);
                },
            });
            counters.missingPorts += post.missingPort;
            if (isPublishableAttempt(step.result.attempt)) publish = true;
            for (const effect of step.result.effects) {
                if (effect.kind !== 'reevaluate' || !effect.evidenceId) continue;
                const held = store.getEvent(effect.evidenceId)?.payload.evidence;
                const again = isTurnEvidence(held) ? forceLiveFalse(held, `${effect.evidenceId}#reeval:${step.evidence.eventId}`) : null;
                if (again) observe(again, opts);
            }
        }
        if (autoFlush && publish) void flushPublish();
        return {
            verdict: result.verdict,
            ...(result.rule ? { rule: result.rule } : {}),
            ...(result.rejection ? { rejection: result.rejection } : {}),
            attempt: result.attempt,
            effects: result.effects,
        };
    }

    function notifyMeshEvent(notice: MeshEventNotice): { eventId: string; inserted: boolean } {
        const eventId = notice.eventId ?? `mesh_event:${randomUUID()}`;
        const at = notice.at ?? now();
        const notifyKind: NotifyKind = notice.notify ?? 'mesh_event';
        const entry: MeshTopicEntry = {
            v: MESH_TOPIC_PROTOCOL_VERSION,
            eventId,
            at,
            k: 'turn.notify',
            ...(notice.attemptId ? { attemptId: notice.attemptId } : {}),
            notify: notifyKind,
            targetDaemonId: notice.targetDaemonId,
            ...(notice.targetSessionId ? { targetSessionId: notice.targetSessionId } : {}),
            ...(notice.taskId ? { taskId: notice.taskId } : {}),
        };
        const inserted = txn(() => store.insertEvent({
            eventId,
            meshId: notice.meshId,
            attemptId: notice.attemptId ?? null,
            generation: null,
            sessionId: notice.targetSessionId ?? '',
            kind: 'notify',
            source: 'mesh_event',
            verdict: 'applied',
            dedupeKey: eventId,
            payload: {
                meshId: notice.meshId,
                notify: notifyKind,
                event: notice.event,
                entry,
                ...(notice.ref ? { ref: notice.ref } : {}),
                ...(notice.payload !== undefined ? { local: { payload: notice.payload } } : {}),
            },
            publishState: 'pending',
            atMs: at,
            recordedAt: now(),
        }));
        if (inserted && autoFlush) void flushPublish();
        return { eventId, inserted };
    }

    function claimDelivery(input: { writer: string; seq: number; meshId?: string | null; sessionId: string; outcome?: string }): boolean {
        const nowMs = now();
        return txn(() => store.insertEvent({
            eventId: `delivered:${input.writer}:${input.seq}`,
            meshId: input.meshId ?? null,
            attemptId: null,
            generation: null,
            sessionId: input.sessionId,
            kind: 'delivered',
            source: 'input_service',
            verdict: 'recorded',
            dedupeKey: `${input.writer}:${input.seq}`,
            payload: { ...(input.meshId ? { meshId: input.meshId } : {}), ...(input.outcome ? { outcome: input.outcome } : {}) },
            srcWriter: input.writer,
            srcSeq: input.seq,
            publishState: 'none',
            atMs: nowMs,
            recordedAt: nowMs,
        }));
    }

    // ── publish (C7-1) ───────────────────────────────────────────────────

    let flushing: Promise<PublishReport> | null = null;
    let flushAgain = false;

    function publishable(row: TurnEventRow): { meshId: string; entry: MeshTopicEntry; ref?: SummaryRef } | null {
        const entry = row.payload.entry as MeshTopicEntry | undefined;
        const meshId = row.meshId ?? (typeof row.payload.meshId === 'string' ? row.payload.meshId : null);
        if (!entry || !meshId) return null;
        const ref = row.payload.ref as SummaryRef | undefined;
        return { meshId, entry, ...(ref ? { ref } : {}) };
    }

    async function drain(): Promise<PublishReport> {
        const report: PublishReport = { published: 0, failed: 0, pending: 0 };
        const publisher = deps.publisher;
        if (!publisher) {
            report.pending = store.countPendingPublish();
            return report;
        }
        // Per-mesh head-of-line: one failed append blocks only its own mesh for
        // this pass, so a sealed/broken topic cannot reorder or starve others.
        const blocked = new Set<string>();
        for (;;) {
            flushAgain = false;
            const rows = store.pendingPublish(PUBLISH_BATCH);
            let progressed = 0;
            for (const row of rows) {
                const target = publishable(row);
                if (!target) {
                    log.error(`turn-ledger: pending row ${row.eventId} has no publishable entry — left pending`);
                    continue;
                }
                if (blocked.has(target.meshId)) continue;
                try {
                    const id = await publisher.publish(target.meshId, target.entry, target.ref ? { ref: target.ref } : undefined);
                    store.markPublished(row.eventId, id.writer, id.seq);
                    report.published++;
                    counters.published++;
                    progressed++;
                } catch (error) {
                    blocked.add(target.meshId);
                    report.failed++;
                    counters.publishFailed++;
                    log.error(`turn-ledger: publish failed mesh=${target.meshId} eventId=${row.eventId}: ${error instanceof Error ? error.message : String(error)} — stays pending`);
                }
            }
            if (!flushAgain && (rows.length < PUBLISH_BATCH || progressed === 0)) break;
        }
        report.pending = store.countPendingPublish();
        return report;
    }

    function flushPublish(): Promise<PublishReport> {
        if (flushing) {
            flushAgain = true;
            return flushing;
        }
        // A flush requested after drain() left its loop but before `flushing`
        // cleared (two observes in one tick) must not be lost: re-drain while
        // one was requested. (C-W3: without this a commit observed in the same
        // tick as its predecessor stayed `pending` until the next tick's republish.)
        flushing = (async () => {
            let report: PublishReport;
            do {
                flushAgain = false;
                report = await drain();
            } while (flushAgain);
            return report;
        })().finally(() => { flushing = null; });
        return flushing;
    }

    return {
        store,
        selfDaemonId: deps.selfDaemonId,
        observe,
        notifyMeshEvent,
        claimDelivery,
        isTerminal: (attemptId) => store.isTerminal(attemptId),
        getAttempt: (attemptId) => store.getAttempt(attemptId),
        openAttemptForSession: (sessionId) => store.findOpenAttemptForSession(sessionId),
        sessionIdFor: (attemptId) => store.sessionIdForAttempt(attemptId),
        expiredHoldEvidence: (nowMs = now()) => expireHolds(store.dueHolds(nowMs), nowMs, {
            observedBy: deps.selfDaemonId,
            sessionIdFor: (attemptId) => store.sessionIdForAttempt(attemptId),
        }),
        sweepExpiredHolds(nowMs = now()) {
            return expireHolds(store.dueHolds(nowMs), nowMs, {
                observedBy: deps.selfDaemonId,
                sessionIdFor: (attemptId) => store.sessionIdForAttempt(attemptId),
            }).map((evidence) => observe(evidence));
        },
        nextHoldDeadline: () => store.nextHoldDeadline(),
        flushPublish,
        republishPending: flushPublish,
        pendingPublishCount: (olderThanMs) => store.countPendingPublish(olderThanMs),
        counters: () => ({ ...counters }),
    };
}

class DuplicateEvidence extends Error {
    constructor(eventId: string) {
        super(`duplicate evidence ${eventId}`);
    }
}

/** True when an attempt is terminal (the replacement for hasTerminalAuthorityFor{Task,Session}). */
export function isAttemptTerminal(attempt: TurnAttempt | null): boolean {
    return !!attempt && isTerminalTurnState(attempt.state);
}
