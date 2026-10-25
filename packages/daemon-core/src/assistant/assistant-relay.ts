import { RelayDeliveryPolicy, unavailableReportNotice } from './relay-delivery-policy.js';
import { RelayGapTracker, receiptKey, gapGroup, buildReadableReplyGap } from './relay-gap-tracker.js';
import { reportBodyId, type ReportContinuation } from './report-continuation.js';
import { createHash } from 'node:crypto';
import { LOG } from '../logging/logger.js';
import { formatReplyClock, type AttemptReportSnapshot, type AuditedCoordinatorReply } from './assistant-native-window.js';
/**
 * Assistant relay (design 2026-10-07-assistant-layer.md §4.3 "수신", §4.8;
 * appendix B). Pure core with injected ports; boot wiring is a later unit.
 *
 * Trigger: a coordinator's PLAIN attempt `turn{phase:'committed'}` on the bus
 * (appendix B: the ledger already decided completion, FALSE-IDLE included —
 * this module never judges "done"). The mesh comes from the session's
 * `meshCoordinatorFor` (port), not the attempt row (B item 3: NULL there).
 * Only when the project has an open thread and the assistant registry exists.
 *
 * Batching: 15 s quiet after a commit; a coordinator that starts another turn
 * meanwhile is waited for until its next commit, up to 120 s from the first.
 * Dedupe: one row per attemptId (`relay:<meshId>:<attemptId>`), so a stale
 * plain attempt that absorbs a later turn after a restart commits once.
 *
 * Delivery into the assistant (§4.3 busyInputMode): daemon inputs are always
 * `queue` and are held HERE while the assistant is busy, absent or restarting,
 * then delivered on its next ready edge as one combined input. Holding them
 * here (rather than parking them in the driver FIFO) keeps the input log —
 * the memory-write origin source (§4.10.2 check 5) — in true delivery order.
 * Human input goes through `submitHuman`, which maps `busyInputMode` onto the
 * existing SendPolicy and never falls back to another mode.
 */

import { SESSION_STATUS_CLASS, type SendPolicy, type SubmitOutcome, type TurnOutcome } from '@adhdev/mesh-shared';
import type { EventOf } from '../sessions/lifecycle-events.js';
import type { Unsubscribe } from '../sessions/lifecycle-bus.js';
import type { AssistantInputLog } from './assistant-input-log.js';
import type { AssistantInputSource } from './store-guards.js';
import { ATTEMPT_BODY_MAX_CHARS, ATTEMPT_BODY_MAX_ROWS, ATTEMPT_BODY_TOTAL_BYTES,
    RELAY_COVERAGE_TTL_MS, RELAY_COVERAGE_MAX_REPLIES, MISSED_REPORT_WINDOW_MS, type RenderedAttemptCoverage, type AssistantRelayStore } from './assistant-relay-store.js';
import { busyInputModeToSendPolicy, type BusyInputMode } from './assistant-registry.js';
import { countTerminalSubmits, TERMINAL_SUBMITS_PER_WRITE_CAP } from './assistant-human-input.js';
import {
    RELAY_BACKLOG_FOLD_AFTER_MS, RELAY_BODY_MAX_CHARS, RELAY_DELIVERY_MAX_CHARS, RELAY_IDLE_CLOSE_GRACE_MS, RELAY_MAX_WAIT_MS, RELAY_NATIVE_RETRY_MS, RELAY_NATIVE_WAIT_MS, RELAY_CAPTURE_PROBE_MS, RELAY_MAX_AUTO_PAGES, RELAY_PROGRESS_AFTER_MS, RELAY_QUIET_MS,
    RELAY_STALL_AFTER_MS, buildApprovalSignal, extractAttentionDetail, buildCoordinatorEndedSignal, buildFoldedBacklogLine, buildProgressSignal,
    buildMissedReportsLine, buildRelayEnvelope, buildRestartNote, buildStallSignal, buildUnreachableRelay, codePoints, relayMessageId,
    shouldAddRestartNote,
    type RestartContext,
} from './assistant-relay-format.js';

export const ASSISTANT_RELAY_BUS_KINDS = ['turn', 'modal', 'prompt', 'terminated', 'registered', 'status'] as const;
export type AssistantRelayBusEvent = EventOf<typeof ASSISTANT_RELAY_BUS_KINDS[number]>;

/** A human input parked in the driver FIFO is attributed when the next turn starts; give up after this. */
export const PENDING_HUMAN_MAX_AGE_MS = 5 * 60_000;
const COVERAGE_TTL_MS = RELAY_COVERAGE_TTL_MS;
const COVERAGE_MAX_ENTRIES = RELAY_COVERAGE_MAX_REPLIES;
const replyHash = (text: string) => createHash('sha256').update(text.replace(/\r\n?/g, '\n').trim()).digest('hex');
const coverageKey = (sessionId: string, attemptId: string | null, at: number, text: string) =>
    JSON.stringify([sessionId, attemptId, at, replyHash(text)]);

export interface MeshWorkCounts { activeMissions: number; pending: number; assigned: number }

/**
 * A remote-hosted project's state as its host's poll answered (content-free;
 * assistant/assistant-remote-relay.ts). Its turns arrive through
 * `onRemoteCommitted`, the host's ledger having committed them.
 */
export interface RemoteProjectSnapshot {
    /** A plain attempt is open on the host's coordinator (it is working). */
    open: boolean;
    /** The coordinator is parked on an approval or a choice. */
    modal: boolean;
    work: MeshWorkCounts | null;
    /** The host's content-free `[Mesh]` line. */
    statusLine: string | null;
}

export interface RelayClock {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

const realClock: RelayClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
        const t = setTimeout(fn, ms);
        (t as { unref?: () => void }).unref?.();
        return t;
    },
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface AssistantRelayPorts {
    /** e.g. `bus.on(ASSISTANT_RELAY_BUS_KINDS, h, { name: 'assistant.relay' })`. */
    subscribe(handler: (event: AssistantRelayBusEvent) => void): Unsubscribe;
    /** `meshCoordinatorFor` of a live session, or null. */
    coordinatorMeshOf(sessionId: string): string | null;
    /** Project slug; null when the mesh no longer exists. */
    projectSlug(meshId: string): string | null;
    /** Session-only diagnostic projection. Never evidence for an exact attempt capture. */
    readCoordinatorTail(sessionId: string): Promise<string | null>;
    /**
     * Existing evidence only; exact attempt/session/mesh, never the newest tail
     * and never `readCoordinatorTail`. A string is a legacy exact body
     * (`final_native`). A snapshot without `completeness: 'final_native'`
     * (old remote hosts) is unverified.
     */
    rehydrateAttemptReport?(meshId: string, sessionId: string, attemptId: string): Promise<AttemptReportSnapshot | string | null>;
    /** Native finals since `sinceMs` for the missing-relay detector. */
    auditCoordinatorReplies?(sinceMs: number): Promise<readonly AuditedCoordinatorReply[] & { complete?: boolean }>;
    /** Recheck the exact project_read cursor before waking the assistant. */
    canReadCoordinatorReply?(reply: AuditedCoordinatorReply): Promise<boolean>;
    readCoordinatorReference?(meshId: string, sessionId: string): Promise<ReportContinuation | null>;
    /** Local metric bump for one uncovered native final. */
    onRelayGap?(klass: 'no_attempt' | 'inside_attempt' | 'restart_closed', at: number): void;
    /** Content-free `[Mesh]` line (`buildMeshStatusLineForNotification`). */
    meshStatusLine?(meshId: string): string | null;
    meshWork(meshId: string): MeshWorkCounts | null;
    /** Registry: does an assistant entry exist at all (trigger condition 3)? */
    hasAssistant(): boolean;
    /** Registry: the bound assistant session, or null. */
    assistantSessionId(): string | null;
    /** Live: the assistant will take input now (ready status, no modal). */
    isAssistantReady(sessionId: string): boolean;
    /**
     * Driver FIFO membership (`SessionInputService.isParked`). Lets a parked
     * human input be logged exactly when the drain writes it. Absent → the
     * oldest parked human input is logged on each assistant turn start.
     */
    isParked?(sessionId: string, messageId: string): Promise<boolean>;
    /** The existing submit funnel (`send_chat` / SessionInputService), `origin` set by the adapter. */
    submit(sessionId: string, input: { text: string; messageId: string; policy: SendPolicy }): Promise<SubmitOutcome>;
    inputLog: AssistantInputLog;
    store: AssistantRelayStore;
    /** Delivery hook (registry `markFirstRelay`, metrics). */
    onRelayDelivered?(meshIds: readonly string[], at: number): void;
    /** An idle review input (§4.10.7) reached the assistant (review history, `review_turns`). */
    onReviewDelivered?(sessionId: string, messageId: string, at: number): void;
    /** Native submit confirmation only; MCP pulls need their own receipt acknowledgement. */
    onInputsSubmitted?(sessionId: string, messageIds: readonly string[], at: number): void;
    clock?: RelayClock;
}

interface Batch {
    coordinatorSessionId: string;
    attemptIds: string[];
    outcome: TurnOutcome;
    firstCommitAt: number;
    lastCommitAt: number;
    quietTimer: unknown;
    maxTimer: unknown;
}

interface RenderedReportPage {
    attemptId: string; reportId: string; offset: number; totalPoints: number;
    coverage?: RenderedAttemptCoverage;
    autoStopped?: boolean;
}
/** `gap`: replies of a queued notice this part announces. `surfaced`: attempts the assistant is told about by notice/cursor instead of a body. */
type Part = { text: string; source: AssistantInputSource; messageId: string; meshId?: string; reports?: RenderedReportPage[];
    gap?: { item: Item & { kind: 'line' }; replies: AuditedCoordinatorReply[] }; surfaced?: string[] };

/** One entry of `assistant_pending_relays` → `assistantEvents` (MCP-only assistant). */
export interface AssistantPulledEvent {
    source: AssistantInputSource;
    messageId: string;
    text: string;
    meshId?: string;
}

type Item =
    | { kind: 'relay'; meshId: string; coordinatorSessionId: string; attemptIds: string[]; outcome: TurnOutcome; committedAt: number; idle: boolean }
    | { kind: 'line'; source: AssistantInputSource; text: string; messageId: string; meshId?: string; forSessionId?: string; gapReplies?: AuditedCoordinatorReply[] };

/**
 * A followed project with no request and no report for this long stops being
 * followed (2026-10-18: threads opened on 10-07 and 10-10 were still open a week
 * later, feeding stall notices). The next project_send follows it again.
 */
export const RELAY_THREAD_STALE_CLOSE_MS = 7 * 24 * 60 * 60_000;

export class AssistantRelay {
    private readonly clock: RelayClock;
    private readonly batches = new Map<string, Batch>();
    /** Mesh -> when its last relay found no work left; the thread closes after the grace. */
    private readonly idleSince = new Map<string, number>();
    private readonly working = new Map<string, number>(); // meshId → coordinator working since
    private readonly sessionMesh = new Map<string, string>(); // coordinator sessionId → meshId (remembered)
    private readonly progressSent = new Set<string>();
    private readonly stallSent = new Set<string>();
    private readonly lastRelayAt = new Map<string, number>();
    /** Durable read and notification acknowledgements, scoped to the recipient. */
    private readonly gaps: RelayGapTracker;
    private readonly deliveryPolicy: RelayDeliveryPolicy;
    /** sessionId -> whether the episode's signal already carried the question (structured prompt or approval modal). */
    private readonly modalOpen = new Map<string, { level: 'bare' | 'detailed'; sources: Set<'modal' | 'prompt'> }>();
    /** Remote-hosted projects: the host's last poll answer (work counts, status line). */
    private readonly remote = new Map<string, RemoteProjectSnapshot>();
    /** Exact attempt reports returned by the authorized evidence reader. The
     * memory cache clears on delivery; the reader retains bounded durable captures. */
    private readonly attemptBodies = new Map<string, string | null>();
    private readonly attemptMeta = new Map<string, AttemptReportSnapshot>();
    private readonly attemptBodyAt = new Map<string, number>();
    /** Only complete native parts inside the rendered cap; never retain bodies. */
    private readonly renderedCoverage = new Map<string, number>();
    private readonly flaggedReplies = new Map<string, number>();
    private readonly pendingTimers = new Map<unknown, () => void>();
    private lifecycle = 0;
    private lastAuditAt = 0;
    private auditing = false;
    /** In-flight local captures (attemptId → settle promise); `renderRelay` awaits these instead of racing them. */
    private readonly attemptBodyCapture = new Map<string, Promise<void>>();
    private queue: Item[] = [];
    /** Human inputs parked in the driver FIFO, oldest first (logged when drained). */
    private pendingHuman: Array<{ at: number; messageId: string }> = [];
    private resolvingHuman: Promise<void> | null = null;
    /** Bracketed paste left open by the last terminal write into this assistant session. */
    private terminalPaste: { sessionId: string; open: boolean } = { sessionId: '', open: false };
    private terminalSeq = 0;
    private unsubscribe: Unsubscribe | null = null;
    private flushing: Promise<void> | null = null;
    private dirty = false;
    private seq = 0;

    private readonly restoredAttempts = new Map<string, { meshId: string; sessionId: string; committedAt: number }>();

    constructor(private readonly ports: AssistantRelayPorts) {
        this.clock = ports.clock ?? realClock;
        this.gaps = new RelayGapTracker(ports.store, () => this.clock.now());
        this.deliveryPolicy = new RelayDeliveryPolicy(ports.store, () => this.clock.now());
    }

    /** Subscribe and load undelivered rows from the store as backlog. */
    start(): void {
        if (this.unsubscribe) return;
        const rows = this.ports.store.listUndelivered();
        const byMesh = new Map<string, Item & { kind: 'relay' }>();
        for (const r of rows) {
            this.restoredAttempts.set(r.attemptId, { meshId: r.meshId, sessionId: r.coordinatorSessionId, committedAt: r.committedAt });
            const item = byMesh.get(r.meshId);
            if (item) {
                item.attemptIds.push(r.attemptId);
                item.outcome = r.outcome as TurnOutcome;
                item.committedAt = r.committedAt;
            } else {
                byMesh.set(r.meshId, { kind: 'relay', meshId: r.meshId, coordinatorSessionId: r.coordinatorSessionId, attemptIds: [r.attemptId], outcome: r.outcome as TurnOutcome, committedAt: r.committedAt, idle: false });
            }
        }
        this.queue.push(...byMesh.values());
        this.loadDeliveredCoverage(this.clock.now());
        this.lifecycle += 1;
        this.lastAuditAt = this.clock.now() - COVERAGE_TTL_MS;
        this.unsubscribe = this.ports.subscribe((e) => this.onEvent(e));
    }

    stop(): void {
        this.lifecycle += 1;
        this.unsubscribe?.();
        this.unsubscribe = null;
        for (const b of this.batches.values()) this.clearBatchTimers(b);
        this.batches.clear();
        this.attemptBodyCapture.clear();
        this.attemptBodies.clear();
        this.attemptMeta.clear();
        this.attemptBodyAt.clear();
        for (const [timer, resolve] of this.pendingTimers) { this.clock.clearTimeout(timer); resolve(); }
        this.pendingTimers.clear();
        this.renderedCoverage.clear();
        this.flaggedReplies.clear();
        this.auditing = false;
    }

    /** `project_send` accepted: open/refresh the project's thread. */
    openThread(meshId: string): void {
        this.idleSince.delete(meshId);
        this.ports.store.openThread(meshId, this.clock.now());
        this.stallSent.delete(meshId);
    }

    /**
     * The owner stopped following the project from the dashboard: close its
     * thread now (no more progress / stall notices; the remote poller stops on
     * its next pass). A relay already batched still goes out unless
     * `opts.suppressPending` is true (known revocation / remote unfollow).
     */
    closeThread(meshId: string, opts?: { suppressPending?: boolean }): boolean {
        const wasOpen = this.ports.store.isThreadOpen(meshId);
        if (wasOpen) {
            this.ports.store.closeThread(meshId, this.clock.now());
        }
        this.idleSince.delete(meshId);
        this.stallSent.delete(meshId);
        this.progressSent.delete(meshId);
        this.working.delete(meshId);
        if (opts?.suppressPending) {
            const batch = this.batches.get(meshId);
            const batchAttemptIds = batch ? [...batch.attemptIds] : [];
            this.dropBatch(meshId);
            const queuedAttemptIds = this.queue
                .filter((i): i is Item & { kind: 'relay' } => i.kind === 'relay' && i.meshId === meshId)
                .flatMap((i) => i.attemptIds);
            const allSuppressedIds = [...new Set([...batchAttemptIds, ...queuedAttemptIds])];
            if (allSuppressedIds.length > 0) {
                this.ports.store.markDelivered(allSuppressedIds, this.clock.now(), []);
            }
            this.queue = this.queue.filter((i) => i.meshId !== meshId);
        }
        return wasOpen;
    }

    /**
     * Fresh-launch path only (`launch_assistant` spawned a NEW process): pass
     * `AssistantRegistry.bindSession().previous`. When the previous session
     * died mid-turn within 6 h, the restart note goes to the FRONT of the
     * queue — after the frozen snapshot (it is the first input), before any
     * backlog relay (§4.3). A restore re-bind (process alive) never calls
     * this. Returns whether a note was queued.
     */
    armRestartNote(ctx: RestartContext, sessionId: string): boolean {
        if (!shouldAddRestartNote(ctx, this.clock.now())) return false;
        this.queue = this.queue.filter((i) => !(i.kind === 'line' && i.source === 'restart_note'));
        this.queue.unshift({
            kind: 'line',
            source: 'restart_note',
            text: buildRestartNote({
                endedAt: ctx.previous!.at,
                openThreads: this.ports.store.openThreads().map((t) => this.ports.projectSlug(t.meshId) ?? t.meshId),
                pendingRelays: this.queue.filter((i) => i.kind === 'relay').reduce((n, i) => n + (i.kind === 'relay' ? i.attemptIds.length : 0), 0),
            }),
            messageId: `restart:${sessionId}`,
        });
        this.kick();
        return true;
    }

    /**
     * First-run / review inputs (always queue, held until the assistant is ready).
     * `forSessionId` pins the input to one assistant session: it is dropped,
     * never delivered, when a different session (or none) is bound by then.
     */
    enqueueInput(input: { source: AssistantInputSource; text: string; messageId: string; forSessionId?: string }): void {
        this.queue.push({ kind: 'line', ...input });
        this.kick();
    }

    /** Whether an input with this message id is still waiting in the queue. */
    isQueued(messageId: string): boolean {
        return this.queue.some((i) => i.kind === 'line' && i.messageId === messageId);
    }

    /**
     * Something is already on its way to the assistant: queued items, a human
     * input parked in the driver FIFO, or a delivery in flight. The idle review
     * waits for all of these (it must reach an idle assistant on its own).
     */
    hasPendingInput(): boolean {
        return this.queue.length > 0 || this.pendingHuman.length > 0 || this.flushing !== null || this.batches.size > 0;
    }

    /** Withdraw queued idle review inputs (a human spoke, or the session ended). */
    private dropQueuedReview(): void {
        this.queue = this.queue.filter((i) => !(i.kind === 'line' && i.source === 'review'));
    }

    /**
     * Human input into the assistant under `busyInputMode` (§4.3 table).
     * Refusals are returned as is — never retried under another mode.
     */
    async submitHuman(text: string, opts: { messageId: string; busyInputMode?: BusyInputMode }): Promise<SubmitOutcome> {
        const sid = this.ports.assistantSessionId();
        if (!sid) return { kind: 'refused', reason: 'no_target' };
        const outcome = await this.ports.submit(sid, { text, messageId: opts.messageId, policy: busyInputModeToSendPolicy(opts.busyInputMode) });
        this.recordHumanSubmit([sid], opts.messageId, outcome);
        return outcome;
    }

    /**
     * A human chat submit reached the session funnel (`submitHuman`, or the
     * dashboard `send_chat` via assistant-human-input.ts). Only the bound
     * assistant session is recorded, once per message, at delivery: written
     * now (`delivered`, or the agent's own queue) → logged now; parked in the
     * driver FIFO (`queued`) → logged when the drain writes it. A duplicate or
     * a refusal wrote nothing and is not logged.
     */
    recordHumanSubmit(sessionIds: readonly string[], messageId: string, outcome: SubmitOutcome): void {
        const sid = this.ports.assistantSessionId();
        if (!sid || !sessionIds.includes(sid)) return;
        if (outcome.kind !== 'delivered' && outcome.kind !== 'queued') return;
        // The idle review is for an idle assistant; a human speaking ends that.
        this.dropQueuedReview();
        if (outcome.kind === 'delivered' || outcome.route === 'agent_queue') {
            this.pendingHuman = this.pendingHuman.filter((p) => p.messageId !== messageId); // promoted out of the FIFO
            this.ports.inputLog.append(sid, 'human', { at: this.clock.now(), messageId });
        } else if (!this.pendingHuman.some((p) => p.messageId === messageId)) {
            this.pendingHuman.push({ at: this.clock.now(), messageId });
        }
    }

    /**
     * A human dashboard wrote raw terminal input into a session
     * (assistant-human-input.ts `reportSessionTerminalInput`). The write went
     * straight into the PTY, so it is logged now, in order: one `human` entry
     * per write that carries a submit key outside a bracketed paste, capped at
     * `TERMINAL_SUBMITS_PER_WRITE_CAP`, with a synthetic id
     * `term:<session>:<ms>:<n>`. Keystrokes without a submit key log nothing.
     * Only the bound assistant session is recorded.
     */
    recordHumanTerminalInput(sessionIds: readonly string[], data: string): void {
        const sid = this.ports.assistantSessionId();
        if (!sid || !sessionIds.includes(sid)) return;
        const prevOpen = this.terminalPaste.sessionId === sid && this.terminalPaste.open;
        const { submits, inPaste } = countTerminalSubmits(data, prevOpen);
        this.terminalPaste = { sessionId: sid, open: inPaste };
        if (submits === 0) return;
        this.dropQueuedReview();
        const at = this.clock.now();
        for (let k = 0; k < Math.min(submits, TERMINAL_SUBMITS_PER_WRITE_CAP); k++) {
            this.terminalSeq += 1;
            this.ports.inputLog.append(sid, 'human', { at, messageId: `term:${sid}:${at}:${this.terminalSeq}` });
        }
    }

    /** Periodic (≈1 min): progress / stall signals, vanished projects, retention, retries. */
    tick(now: number = this.clock.now()): void {
        this.pendingHuman = this.pendingHuman.filter((p) => now - p.at < PENDING_HUMAN_MAX_AGE_MS);
        for (const t of this.ports.store.openThreads()) {
            const idleAt = this.idleSince.get(t.meshId);
            if (idleAt !== undefined && now - idleAt >= RELAY_IDLE_CLOSE_GRACE_MS && !this.batches.has(t.meshId)) {
                this.idleSince.delete(t.meshId);
                this.ports.store.closeThread(t.meshId, now);
                continue;
            }
            const slug = this.ports.projectSlug(t.meshId);
            if (slug === null) {
                this.ports.store.closeThread(t.meshId, now);
                this.dropBatch(t.meshId);
                continue;
            }
            const since = this.working.get(t.meshId);
            if (since !== undefined) {
                if (now - since >= RELAY_PROGRESS_AFTER_MS && !this.progressSent.has(t.meshId)) {
                    this.progressSent.add(t.meshId);
                    this.pushLine('progress', buildProgressSignal(slug, this.workOf(t.meshId)?.assigned ?? null), t.meshId);
                }
                continue;
            }
            const quietFor = now - Math.max(t.lastSendAt, this.lastRelayAt.get(t.meshId) ?? 0);
            if (!this.batches.has(t.meshId) && quietFor >= RELAY_THREAD_STALE_CLOSE_MS) {
                this.closeThread(t.meshId);
                continue;
            }
            if (this.batches.has(t.meshId) || this.stallSent.has(t.meshId)) continue;
            const quietSince = Math.max(t.lastSendAt, this.lastRelayAt.get(t.meshId) ?? 0);
            if (now - quietSince < RELAY_STALL_AFTER_MS) continue;
            // One notice per quiet stretch, across restarts too: `lastRelayAt` and
            // `stallSent` are this process only, so without the stored mark every
            // daemon restart re-sent the notice for every quiet thread.
            if (t.stallNotifiedAt !== undefined && t.stallNotifiedAt >= quietSince) continue;
            const w = this.workOf(t.meshId);
            if (w && (w.activeMissions > 0 || w.pending > 0) && w.assigned === 0) {
                this.stallSent.add(t.meshId);
                this.ports.store.markStallNotified(t.meshId, now);
                this.pushLine('stall', buildStallSignal(slug, w), t.meshId);
            }
        }
        this.ports.store.prune(now);
        this.pruneCoverage(now);
        this.pruneBodyCache(now);
        this.auditReplies(now);
        for (const item of this.queue) if (item.kind === 'relay') for (const id of item.attemptIds) {
            if (!this.hasCapturedBody(id) && !this.attemptBodyCapture.has(id)) {
                const ref = this.restoredAttempts.get(id);
                this.captureAttemptBody(id, ref?.meshId ?? item.meshId, ref?.sessionId ?? item.coordinatorSessionId);
            }
        }
        this.kick();
    }

    /**
     * A turn started on the assistant: log, in FIFO order, the parked human
     * inputs the driver no longer holds (the drain wrote them). Still-parked
     * ones stay pending; relays keep waiting behind them.
     */
    private resolveDrainedHuman(sid: string): Promise<void> {
        const run = async (): Promise<void> => {
            const pending = [...this.pendingHuman];
            const drained: string[] = [];
            for (const p of pending) {
                let parked = true;
                try { parked = await this.ports.isParked!(sid, p.messageId); } catch { parked = true; }
                if (!parked) drained.push(p.messageId);
            }
            if (!drained.length || this.ports.assistantSessionId() !== sid) return;
            const at = this.clock.now();
            for (const p of pending) if (drained.includes(p.messageId)) this.ports.inputLog.append(sid, 'human', { at, messageId: p.messageId });
            this.pendingHuman = this.pendingHuman.filter((p) => !drained.includes(p.messageId));
            this.kick();
        };
        const prev = this.resolvingHuman ?? Promise.resolve();
        const next = prev.then(run, run).finally(() => { if (this.resolvingHuman === next) this.resolvingHuman = null; });
        this.resolvingHuman = next;
        return next;
    }

    /** Test/diagnostic view. */
    snapshot(): { queued: number; batches: string[]; pendingHuman: number } {
        return { queued: this.queue.length, batches: [...this.batches.keys()], pendingHuman: this.pendingHuman.length };
    }

    /** Resolves when the in-flight delivery (if any) settles. */
    async idle(): Promise<void> {
        while (this.flushing || this.resolvingHuman) {
            if (this.resolvingHuman) await this.resolvingHuman;
            if (this.flushing) await this.flushing;
        }
    }

    // ── bus ─────────────────────────────────────────────────────────────────

    private onEvent(e: AssistantRelayBusEvent): void {
        const assistant = this.ports.assistantSessionId();
        if (assistant && e.sessionId === assistant) {
            this.onAssistantEvent(e);
            return;
        }
        if (e.kind === 'registered' || e.kind === 'status') return;
        const meshId = this.meshOf(e);
        if (!meshId) return;
        if (e.kind === 'turn') this.onCoordinatorTurn(meshId, e);
        else if (e.kind === 'modal' || e.kind === 'prompt') this.onCoordinatorAttention(meshId, e.sessionId, e.kind, e.kind === 'modal' ? e.modal : e.prompt);
        else if (e.kind === 'terminated') this.onCoordinatorTerminated(meshId, e.sessionId, e.cause);
    }

    private meshOf(e: AssistantRelayBusEvent): string | null {
        let meshId = this.ports.coordinatorMeshOf(e.sessionId);
        if (!meshId && e.kind === 'terminated') {
            const stamped = e.runtimeSettings?.meshCoordinatorFor;
            meshId = typeof stamped === 'string' && stamped ? stamped : this.sessionMesh.get(e.sessionId) ?? null;
        }
        if (meshId) this.sessionMesh.set(e.sessionId, meshId);
        if (e.kind === 'terminated') this.sessionMesh.delete(e.sessionId);
        return meshId;
    }

    private onAssistantEvent(e: AssistantRelayBusEvent): void {
        const sid = e.sessionId;
        if (e.kind === 'registered') {
            // presence edge: flush the backlog below
        } else if (e.kind === 'turn') {
            if (e.phase === 'started' && this.pendingHuman.length) {
                if (this.ports.isParked) {
                    void this.resolveDrainedHuman(sid);
                } else {
                    const p = this.pendingHuman.shift()!; // one drained body starts one turn
                    this.ports.inputLog.append(sid, 'human', { at: this.clock.now(), messageId: p.messageId });
                }
            }
            if (e.phase !== 'committed') return;
            this.ports.inputLog.closeTurn(sid);
        } else if (e.kind === 'status') {
            if (SESSION_STATUS_CLASS[e.next] !== 'ready') return;
        } else if (e.kind === 'terminated') {
            this.pendingHuman = [];
            this.dropQueuedReview();
            return;
        } else {
            return;
        }
        this.kick();
    }

    private onCoordinatorTurn(meshId: string, e: EventOf<'turn'>): void {
        if (!e.attemptId.startsWith('plain:')) return;
        if (e.phase === 'started' || e.phase === 'resumed') {
            this.markWorking(meshId, e.at);
            return;
        }
        if (e.phase !== 'committed') return;
        this.commit(meshId, { attemptId: e.attemptId, sessionId: e.sessionId, at: e.at, outcome: e.outcome ?? 'completed' });
    }

    // ── remote-hosted projects (assistant-remote-relay.ts polls the host) ──

    /** The host's poll answer for a remote-hosted project (call after `onRemoteCommitted` for the same poll). */
    observeRemote(meshId: string, snap: RemoteProjectSnapshot): void {
        this.remote.set(meshId, snap);
        if (snap.open) this.markWorking(meshId, this.clock.now());
        else this.working.delete(meshId);
        this.onCoordinatorAttention(meshId, `remote:${meshId}`, 'modal', snap.modal ? true : null);
    }

    /**
     * A coordinator turn the HOST's ledger committed. Same batching, dedupe and
     * delivery as a local commit; the commit time is this daemon's receive time
     * (the host clock may be skewed), while the host poll body has no exact identity and is ignored.
     */
    onRemoteCommitted(meshId: string, c: { attemptId: string; coordinatorSessionId: string; outcome: TurnOutcome; body: string | null }): void {
        if (!c.attemptId.startsWith('plain:')) return;
        this.commit(meshId, { attemptId: c.attemptId, sessionId: c.coordinatorSessionId, at: this.clock.now(), outcome: c.outcome });
    }

    /** The host of an open remote thread stopped answering: one `unreachable` relay card (never a silent drop). */
    remoteUnreachable(meshId: string, hostLabel: string, reason: string): void {
        if (!this.ports.hasAssistant() || !this.ports.store.isThreadOpen(meshId)) return;
        const slug = this.ports.projectSlug(meshId);
        if (slug !== null) this.pushLine('relay', buildUnreachableRelay(slug, hostLabel, reason), meshId);
    }

    /**
     * A remote-hosted project's coordinator session was replaced or its commit
     * cursor fell behind the host's poll window: record a gap metric and queue
     * a content-free baseline notice for the assistant.
     */
    onRemoteGapOrBaseline(
        meshId: string,
        info: {
            reason: 'coordinator_replaced' | 'cursor_gap';
            previousSessionId?: string | null;
            currentSessionId?: string | null;
            previousCursor?: string | null;
            currentCursor?: string | null;
        },
    ): void {
        const now = this.clock.now();
        this.ports.onRelayGap?.('restart_closed', now);
        if (!this.ports.hasAssistant() || !this.ports.store.isThreadOpen(meshId)) return;
        const slug = this.ports.projectSlug(meshId) ?? meshId;
        const detail = info.reason === 'coordinator_replaced'
            ? `coordinator session replaced (${info.previousSessionId ?? 'none'} → ${info.currentSessionId ?? 'none'}); cursor baseline reset to ${info.currentCursor ?? 'latest'}`
            : `commit cursor gap (${info.previousCursor ?? 'none'} → ${info.currentCursor ?? 'latest'}); earlier unpolled turns skipped`;
        this.pushLine('relay', `[ADHDev relay baseline] ${slug} — ${detail}.`, meshId);
    }

    private workOf(meshId: string): MeshWorkCounts | null {
        const r = this.remote.get(meshId);
        return r ? r.work : this.ports.meshWork(meshId);
    }

    private markWorking(meshId: string, at: number): void {
        if (!this.working.has(meshId)) this.working.set(meshId, at);
        const b = this.batches.get(meshId);
        if (b && b.quietTimer !== null) {
            this.clock.clearTimeout(b.quietTimer); // chained turn: wait for its commit (bounded by maxTimer)
            b.quietTimer = null;
        }
    }

    private commit(meshId: string, e: { attemptId: string; sessionId: string; at: number; outcome: TurnOutcome }): void {
        this.working.delete(meshId);
        if (!this.ports.hasAssistant() || !this.ports.store.isThreadOpen(meshId)) return;
        const outcome = e.outcome;
        const fresh = this.ports.store.recordCommitted({
            attemptId: e.attemptId, meshId, coordinatorSessionId: e.sessionId, committedAt: e.at, kind: 'relay', outcome,
        });
        if (!fresh) return;
        this.restoredAttempts.set(e.attemptId, { meshId, sessionId: e.sessionId, committedAt: e.at });
        this.captureAttemptBody(e.attemptId, meshId, e.sessionId, true);
        let b = this.batches.get(meshId);
        if (!b) {
            b = { coordinatorSessionId: e.sessionId, attemptIds: [], outcome, firstCommitAt: e.at, lastCommitAt: e.at, quietTimer: null, maxTimer: null };
            b.maxTimer = this.clock.setTimeout(() => this.fire(meshId), RELAY_MAX_WAIT_MS);
            this.batches.set(meshId, b);
        }
        b.attemptIds.push(e.attemptId);
        b.outcome = outcome;
        b.lastCommitAt = e.at;
        b.coordinatorSessionId = e.sessionId;
        if (b.quietTimer !== null) this.clock.clearTimeout(b.quietTimer);
        b.quietTimer = this.clock.setTimeout(() => this.fire(meshId), RELAY_QUIET_MS);
    }

    /** Resolve only through the authorized exact-attempt reader. That reader
     * persists a native window, never a session tail and never an unverified
     * envelope. While the native text is absent, retry on the injected clock
     * for RELAY_NATIVE_WAIT_MS (inside the quiet window). Delivery/folding or
     * stop drops the cache token so a late read cannot repopulate it. */
    private captureAttemptBody(attemptId: string, meshId: string, coordinatorSessionId: string, retryWindow = false, restore = false): void {
        const started = this.clock.now();
        const firstProbe = this.deliveryPolicy.initial(attemptId);
        if (!this.deliveryPolicy.due(attemptId) || (this.deliveryPolicy.expired(this.restoredAttempts.get(attemptId)?.committedAt ?? started) && !(restore && firstProbe))) return;
        const initial = retryWindow && firstProbe;
        let p!: Promise<void>;
        const live = () => this.attemptBodyCapture.get(attemptId) === p;
        p = this.settleCapture(attemptId, meshId, coordinatorSessionId, started, live, initial);
        this.attemptBodyCapture.set(attemptId, p);
        void p.finally(() => {
            if (this.attemptBodyCapture.get(attemptId) === p) this.attemptBodyCapture.delete(attemptId);
        });
    }

    private async settleCapture(attemptId: string, meshId: string, coordinatorSessionId: string, started: number, live: () => boolean, initial: boolean): Promise<void> {
        let last = this.normalizeReport(null);
        for (;;) {
            // Call the reader synchronously so a commit-time snapshot is taken
            // before later turns replace it. Then yield so `captureAttemptBody`
            // can publish this promise as the live token.
            let read: Promise<AttemptReportSnapshot | string | null>;
            try {
                read = this.ports.rehydrateAttemptReport
                    ? this.ports.rehydrateAttemptReport(meshId, coordinatorSessionId, attemptId)
                    : Promise.resolve(null);
            } catch {
                read = Promise.resolve(null);
            }
            await Promise.resolve();
            if (!live()) return;
            try {
                const raw = await this.bounded(read, Math.max(0, (initial ? RELAY_NATIVE_WAIT_MS : RELAY_CAPTURE_PROBE_MS) - (this.clock.now() - started)), null);
                const next = this.normalizeReport(raw);
                if (next.body || !last.body) last = next;
            } catch {
                last = this.normalizeReport(null);
            }
            if (!live()) return;
            if ((last.completeness === 'final_native' || last.completeness === 'final_adapter') && last.body?.trim()) {
                this.rememberCapture(attemptId, last);
                return;
            }
            const elapsed = this.clock.now() - started;
            if (!initial || elapsed >= RELAY_NATIVE_WAIT_MS) {
                this.rememberCapture(attemptId, last);
                return;
            }
            const wait = Math.min(RELAY_NATIVE_RETRY_MS, RELAY_NATIVE_WAIT_MS - elapsed);
            await this.bounded(new Promise<void>(() => {}), wait, undefined);
            if (!live()) return;
            if (this.clock.now() - started >= RELAY_NATIVE_WAIT_MS) { this.rememberCapture(attemptId, last); return; }
        }
    }

    /** A stopped relay resolves its waits too; late I/O cannot repopulate caches. */
    private async bounded<T>(read: Promise<T>, ms: number, fallback: T): Promise<T> {
        let timer: unknown;
        const timeout = new Promise<T>(resolve => {
            const finish = () => resolve(fallback);
            timer = this.clock.setTimeout(finish, ms);
            this.pendingTimers.set(timer, finish);
        });
        try { return await Promise.race([read, timeout]); }
        finally { this.clock.clearTimeout(timer); this.pendingTimers.delete(timer); }
    }

    private normalizeReport(raw: AttemptReportSnapshot | string | null | undefined): AttemptReportSnapshot {
        if (typeof raw === 'string') return raw.length <= ATTEMPT_BODY_MAX_CHARS
            ? { body: raw, completeness: 'final_native' } : { body: null, completeness: 'envelope_unverified' };
        if (!raw || typeof raw !== 'object') return { body: null, completeness: 'envelope_unverified' };
        if (typeof raw.body === 'string' && raw.body.length > ATTEMPT_BODY_MAX_CHARS) return { body: null, completeness: 'envelope_unverified' };
        const validParts = raw.parts === undefined || (Array.isArray(raw.parts) && raw.parts.length <= 600
            && raw.parts.every(p => p && Number.isFinite(p.at) && Number.isFinite(new Date(p.at).getTime())
                && Number.isSafeInteger(p.chars) && p.chars > 0));
        const completeness = (raw.completeness === 'final_native' || raw.completeness === 'final_adapter') && validParts
            ? raw.completeness : 'envelope_unverified';
        return {
            body: typeof raw.body === 'string' ? raw.body : null,
            completeness,
            ...(typeof raw.source === 'string' && raw.source.length <= 128 ? { source: raw.source } : {}),
            ...(raw.parts && validParts ? { parts: raw.parts.map(p => ({ at: p.at, chars: p.chars })) } : {}),
        };
    }

    private rememberReport(attemptId: string, report: AttemptReportSnapshot): void {
        this.attemptBodies.set(attemptId, report.body);
        this.attemptMeta.set(attemptId, report);
        this.attemptBodyAt.delete(attemptId);
        this.attemptBodyAt.set(attemptId, this.clock.now());
        this.pruneBodyCache(this.clock.now());
    }

    private rememberCapture(id: string, report: AttemptReportSnapshot): void {
        this.rememberReport(id, report);
        if (!this.hasCapturedBody(id)) {
            this.deliveryPolicy.failed(id);
            LOG.warn('Assistant', `native relay capture unavailable attempt=${id}; retry scheduled with backoff`);
        }
    }

    private pruneBodyCache(now: number): void {
        let bytes = 0;
        let count = 0;
        for (const [id, at] of [...this.attemptBodyAt].reverse()) {
            bytes += Buffer.byteLength(this.attemptBodies.get(id) ?? '', 'utf8');
            count += 1;
            if (now - at < COVERAGE_TTL_MS && count <= ATTEMPT_BODY_MAX_ROWS && bytes <= ATTEMPT_BODY_TOTAL_BYTES) continue;
            this.attemptBodies.delete(id); this.attemptMeta.delete(id); this.attemptBodyAt.delete(id);
        }
    }

    /** project_read acknowledges only the exact content actually returned. */
    recordProjectRead(result: Record<string, unknown>, recipient = this.ports.assistantSessionId()): void {
        this.gaps.recordRead(result, recipient);
    }

    /** Native finals not covered by delivery/read receipts, grouped per attempt. */
    private auditReplies(now: number): void {
        const port = this.ports.auditCoordinatorReplies;
        if (!port || this.auditing) return;
        const since = this.lastAuditAt;
        const lifecycle = this.lifecycle;
        this.auditing = true;
        void Promise.resolve()
            // Native scans have their own two-second I/O budget; leave room for
            // their timeout results to settle so one offline session cannot hide
            // healthy partial results at the outer deadline.
            .then(() => this.bounded(port(since), 3_000, null))
            .then((replies) => {
                if (this.lifecycle !== lifecycle || !replies) return;
                for (const reply of replies ?? []) this.noteUncoveredReply(reply, now);
                this.kick();
                if (replies.complete !== false) this.lastAuditAt = now;
            })
            .catch((e) => LOG.warn('Assistant', `relay gap audit failed: ${(e as Error)?.message ?? e}`))
            .finally(() => { if (this.lifecycle === lifecycle) this.auditing = false; });
    }

    private noteUncoveredReply(reply: AuditedCoordinatorReply, now: number): void {
        const text = reply.text?.trim() ?? '';
        const proof = reply.nativeTurnProof;
        const closedNativeTurn = !!proof && proof.sessionId === reply.sessionId && proof.messageId === reply.messageId
            && !!proof.nativeSessionId && !!proof.turnId && proof.startedAt > 0 && proof.startedAt <= reply.messageAt
            && proof.endedAt >= reply.messageAt && proof.contentHash === replyHash(text);
        if (!text || !reply.chars || (reply.attemptOpen && !closedNativeTurn) || !reply.messageId || !this.ports.hasAssistant()) return;
        // A closed attempt can still be waiting for quiet-window/busy delivery.
        if (reply.attemptId && (this.attemptBodyCapture.has(reply.attemptId)
            || [...this.batches.values()].some(b => b.attemptIds.includes(reply.attemptId!))
            || this.queue.some(i => i.kind === 'relay' && i.attemptIds.includes(reply.attemptId!)))) return;
        // A delayed native flush can fall after the FSM's debounce timestamp,
        // so the auditor has no containing span yet. Let the pending capture
        // settle before declaring an uncovered orphan from the same session.
        if (!reply.attemptId && (this.queue.some(i => i.kind === 'relay' && i.coordinatorSessionId === reply.sessionId)
            || [...this.batches.values()].some(b => b.coordinatorSessionId === reply.sessionId))) return;
        const key = coverageKey(reply.sessionId, reply.attemptId, reply.messageAt, text);
        // Audits have no caller identity in MCP-only mode. Recipient-scoped
        // receipts are checked when the actual recipient claims the notice.
        if (this.replyCovered(reply, text)) return;
        const klass = !reply.attemptId ? 'no_attempt' : reply.restartClosed ? 'restart_closed' : 'inside_attempt';
        if (!this.flaggedReplies.has(key)) {
            this.flaggedReplies.set(key, now);
            this.pruneCoverage(now);
            LOG.warn('Assistant', `relay gap class=${klass} session=${reply.sessionId} at=${reply.messageAt} chars=${reply.chars}`);
            this.ports.onRelayGap?.(klass, now);
        }
        const group = gapGroup(reply);
        const queued = this.queue.find(i => i.kind === 'line' && i.messageId === `gap:${group}`);
        if (queued?.kind === 'line') {
            if (!queued.gapReplies?.some(r => r.messageId === reply.messageId)) queued.gapReplies?.push(reply);
        } else this.queue.push({ kind: 'line', source: 'relay', text: '', messageId: `gap:${group}`, gapReplies: [reply] });
    }

    private replyCovered(reply: AuditedCoordinatorReply, text: string): boolean {
        if (this.renderedCoverage.has(coverageKey(reply.sessionId, reply.attemptId, reply.messageAt, text))) return true;
        const hash = replyHash(text);
        return [...this.renderedCoverage.keys()].some(key => {
            const [session, attempt, at, contentHash] = JSON.parse(key);
            if (session !== reply.sessionId || contentHash !== hash) return false;
            if (reply.nativeTurnProof) return at === reply.messageAt;
            return reply.attemptId ? attempt === reply.attemptId : at === reply.messageAt || (typeof at === 'number' && Math.abs(at - reply.messageAt) <= RELAY_QUIET_MS);
        });
    }

    private pruneCoverage(now: number): void {
        for (const map of [this.renderedCoverage, this.flaggedReplies]) {
            for (const [key, at] of map) if (now - at >= COVERAGE_TTL_MS) map.delete(key);
            while (map.size > COVERAGE_MAX_ENTRIES) map.delete(map.keys().next().value!);
        }
    }

    private loadDeliveredCoverage(now: number): void {
        this.renderedCoverage.clear();
        for (const c of this.ports.store.listDeliveredCoverage(now)) for (const r of c.replies) {
            this.renderedCoverage.set(JSON.stringify([c.coordinatorSessionId, c.attemptId, r.messageAt, r.contentHash]), c.renderedAt);
        }
        this.pruneCoverage(now);
    }

    private renderedParts(attemptId: string, sessionId: string, body: string, meta: AttemptReportSnapshot, renderedLimit = RELAY_BODY_MAX_CHARS): RenderedAttemptCoverage | null {
        const parts = meta.parts?.length ? meta.parts : meta.completeness === 'final_adapter'
            ? [{ at: this.restoredAttempts.get(attemptId)?.committedAt ?? this.clock.now(), chars: Array.from(body).length }] : undefined;
        if (!parts?.length) return null; // no native identity: do not infer it from substring containment
        const points = Array.from(body);
        let offset = 0;
        let renderedOffset = 0;
        const replies: RenderedAttemptCoverage['replies'] = [];
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i]!;
            if (!Number.isFinite(part.at) || !Number.isSafeInteger(part.chars) || part.chars <= 0) return null;
            if (parts.length > 1) {
                const label = Array.from(`${i ? '\n\n' : ''}[reply ${i + 1}/${parts.length} · ${formatReplyClock(part.at)}]\n`);
                if (points.slice(offset, offset + label.length).join('') !== label.join('')) return null;
                offset += label.length;
                renderedOffset += label.length;
            }
            const text = points.slice(offset, offset + part.chars).join('');
            offset += part.chars;
            renderedOffset += Array.from(text.replace(/\r\n?/g, '\n')).length;
            if (Array.from(text).length !== part.chars) return null;
            if (renderedOffset <= renderedLimit) replies.push({ messageAt: part.at, contentHash: replyHash(text) });
        }
        if (offset !== points.length) return null; // reject malformed/legacy part metadata
        return { attemptId, coordinatorSessionId: sessionId, replies };
    }

    private onCoordinatorAttention(meshId: string, sessionId: string, source: 'modal' | 'prompt', value: unknown): void {
        const ep = this.modalOpen.get(sessionId);
        if (value === null || value === undefined) {
            // The episode ends only when BOTH the modal and the prompt are cleared; one
            // clearing while the other is still open must not re-arm the notice.
            if (ep) {
                ep.sources.delete(source);
                if (!ep.sources.size) this.modalOpen.delete(sessionId);
            }
            return;
        }
        if (ep) ep.sources.add(source);
        if (!this.ports.hasAssistant() || !this.ports.store.isThreadOpen(meshId)) return;
        const detail = extractAttentionDetail(value);
        // One line per episode; a later event of the same episode (modal then
        // prompt) only adds a line when the first carried no question text.
        if (ep?.level === 'detailed' || (ep?.level === 'bare' && !detail)) return;
        this.modalOpen.set(sessionId, { level: detail ? 'detailed' : 'bare', sources: ep?.sources ?? new Set([source]) });
        const slug = this.ports.projectSlug(meshId);
        if (slug !== null) this.pushLine('relay', buildApprovalSignal(slug, detail), meshId);
    }

    private onCoordinatorTerminated(meshId: string, sessionId: string, cause: string): void {
        this.modalOpen.delete(sessionId);
        if (cause === 'daemon_shutdown') return;
        this.working.delete(meshId);
        if (this.batches.has(meshId)) this.fire(meshId);
        if (!this.ports.hasAssistant() || !this.ports.store.isThreadOpen(meshId)) return;
        const slug = this.ports.projectSlug(meshId);
        if (slug !== null) this.pushLine('relay', buildCoordinatorEndedSignal(slug, cause), meshId);
    }

    // ── batching ────────────────────────────────────────────────────────────

    private clearBatchTimers(b: Batch): void {
        if (b.quietTimer !== null) this.clock.clearTimeout(b.quietTimer);
        if (b.maxTimer !== null) this.clock.clearTimeout(b.maxTimer);
        b.quietTimer = null;
        b.maxTimer = null;
    }

    private dropBatch(meshId: string): void {
        const b = this.batches.get(meshId);
        if (b) this.clearBatchTimers(b);
        this.batches.delete(meshId);
    }

    /** Close the batch into a queued relay item. The thread closes here when no work is left. */
    private fire(meshId: string): void {
        const b = this.batches.get(meshId);
        if (!b) return;
        this.dropBatch(meshId);
        const w = this.workOf(meshId);
        const idle = !!w && w.activeMissions === 0 && w.pending + w.assigned === 0;
        if (idle) this.idleSince.set(meshId, this.clock.now());
        else this.idleSince.delete(meshId);
        this.queue.push({
            kind: 'relay', meshId, coordinatorSessionId: b.coordinatorSessionId, attemptIds: b.attemptIds,
            outcome: b.outcome, committedAt: b.lastCommitAt, idle,
        });
        this.kick();
    }

    // ── delivery ────────────────────────────────────────────────────────────

    private pushLine(source: AssistantInputSource, text: string, meshId?: string): void {
        this.queue.push({ kind: 'line', source, text, messageId: `signal:${source}:${meshId ?? '-'}:${this.clock.now()}:${++this.seq}`, ...(meshId ? { meshId } : {}) });
        this.kick();
    }

    private kick(): void {
        if (this.flushing) {
            this.dirty = true;
            return;
        }
        if (!this.queue.length) return;
        this.dirty = false;
        this.flushing = this.deliverOnce().catch(() => { /* items stay queued; next edge retries */ }).finally(() => {
            this.flushing = null;
            if (this.dirty) this.kick();
        });
    }

    /** One combined input per ready edge; the assistant is busy afterwards. */
    private async deliverOnce(): Promise<void> {
        const sid = this.ports.assistantSessionId();
        if (!sid || this.pendingHuman.length || !this.ports.isAssistantReady(sid)) return;
        const lifecycle = this.lifecycle;
        const { taken, parts } = await this.takeParts(this.clock.now(), sid);
        if (lifecycle !== this.lifecycle) return;
        if (!parts.length) {
            this.queue = this.queue.filter((i) => !taken.includes(i));
            return;
        }
        const messageId = parts.length === 1 ? parts[0]!.messageId : `${parts[0]!.messageId}+${parts.length - 1}`;
        // Historical counts accompany actionable gap pointers only. A clean
        // relay must not restart a project_read loop for an old, unreadable loss.
        const missed = this.missedReportsIncluding(taken, parts);
        // The counter rides only with an actionable reply notice, never with an unavailable-report notice.
        const gap = !parts.some(p => p.messageId.startsWith('gap:') && !p.surfaced) ? '' : this.newGapLine(sid, missed);
        const text = [...parts.map((p) => p.text), ...(gap ? [gap] : [])].join('\n\n');
        const outcome = await this.ports.submit(sid, { text, messageId, policy: { mode: 'queue' } });
        if (outcome.kind === 'refused') return;
        const submitted = outcome.kind === 'delivered' || (outcome.kind === 'duplicate' && !!this.ports.isParked && !await this.ports.isParked(sid, messageId));
        this.commitTaken(taken, parts, sid, submitted);
        if (gap) this.rememberGaps(sid, missed);
    }

    /**
     * MCP-only pull (§4.5): claim what is queued now (same rendering/budget as a
     * PTY delivery) and mark it delivered; `sessionId` gets the input-log entries.
     */
    async pullPending(sessionId: string | null): Promise<AssistantPulledEvent[]> {
        await this.idle();
        const lifecycle = this.lifecycle;
        const { taken, parts } = await this.takeParts(this.clock.now(), sessionId);
        if (lifecycle !== this.lifecycle) return [];
        const missed = this.missedReportsIncluding(taken, parts);
        // The counter rides only with an actionable reply notice, never with an unavailable-report notice.
        const gap = !parts.some(p => p.messageId.startsWith('gap:') && !p.surfaced) ? '' : this.newGapLine(sessionId, missed);
        if (gap && parts.length) parts.push({ text: gap, source: 'relay', messageId: `gap:${this.clock.now()}:${++this.seq}` });
        this.commitTaken(taken, parts, sessionId);
        if (gap && parts.length) this.rememberGaps(sessionId, missed);
        return parts.map((p) => ({ source: p.source, messageId: p.messageId, text: p.text, ...(p.meshId ? { meshId: p.meshId } : {}) }));
    }

    /** Render the head of the queue into parts within the delivery budget (no side effects). */
    private async takeParts(now: number, sid: string | null): Promise<{ taken: Item[]; parts: Part[] }> {
        const taken: Item[] = [];
        const parts: Part[] = [];
        const folded = new Map<string, number>();
        let size = 0;
        for (const item of this.queue) {
            if (item.kind === 'line' && item.forSessionId && item.forSessionId !== sid) {
                taken.push(item); // pinned to a session that is no longer bound: drop, never deliver
                continue;
            }
            if (item.kind === 'line' && item.source === 'review') {
                // The review input goes alone: it must open its own turn (the
                // §4.10.7 whitelist window and the review origin key off that).
                if (!parts.length) {
                    parts.push({ text: item.text, source: item.source, messageId: item.messageId });
                    taken.push(item);
                }
                break;
            }
            if (item.kind === 'relay' && now - item.committedAt > RELAY_BACKLOG_FOLD_AFTER_MS) {
                folded.set(item.meshId, (folded.get(item.meshId) ?? 0) + item.attemptIds.length);
                taken.push(item);
                continue;
            }
            if (item.kind === 'relay') {
                await this.bodiesFor(item);
                const pending = item.attemptIds.filter(id => !this.hasCapturedBody(id));
                const ready = item.attemptIds.filter(id => this.hasCapturedBody(id));
                const expired = pending.filter(id => this.deliveryPolicy.expired(this.restoredAttempts.get(id)?.committedAt ?? item.committedAt));
                const selected = ready.length ? ready : expired;
                if (!selected.length) continue;
                const held = item.attemptIds.filter(id => !selected.includes(id));
                if (held.length) this.queue.push({ ...item, attemptIds: held });
                item.attemptIds = selected;
            }
            let gap: Part['gap']; let suffix = false;
            if (item.kind === 'line' && item.gapReplies) {
                const plan = await this.deliveryPolicy.resolve(item.gapReplies, sid, this.gaps, reply => this.replyCovered(reply, reply.text),
                    reply => async () => this.bounded<boolean | undefined>(this.ports.canReadCoordinatorReply?.(reply) ?? Promise.resolve(false), 2_000, undefined));
                item.gapReplies = [...plan.readable, ...plan.pending];
                // Nothing actionable: stay queued silently (counted, never a standalone wake-up) until readable or aged out.
                if (!plan.readable.length) { if (!plan.pending.length) taken.push(item); continue; }
                const project = this.ports.projectSlug(plan.readable[0]!.meshId ?? this.ports.coordinatorMeshOf(plan.readable[0]!.sessionId) ?? '') ?? '';
                item.text = buildReadableReplyGap(plan.readable, project);
                gap = { item, replies: plan.readable }; suffix = plan.pending.length > 0 || plan.readable.some(r => this.deliveryPolicy.isHeld(r));
            }
            const part: Part = item.kind === 'line'
                ? { text: item.text, source: item.source, messageId: suffix ? `${item.messageId}:${receiptKey(gap!.replies.map(r => r.messageId)).slice(0, 16)}` : item.messageId,
                    ...(item.meshId ? { meshId: item.meshId } : {}), ...(gap ? { gap } : {}) }
                : item.attemptIds.some(id => !this.hasCapturedBody(id)) ? await this.renderUnavailable(item) : await this.renderRelay(item);
            const cost = codePoints(part.text) + 2;
            if (parts.length && size + cost > RELAY_DELIVERY_MAX_CHARS) break;
            parts.push(part);
            if (!gap || (item.kind === 'line' && !item.gapReplies?.some(r => !gap!.replies.includes(r)))) taken.push(item);
            size += cost;
        }
        for (const [meshId, count] of folded) {
            const text = buildFoldedBacklogLine(this.ports.projectSlug(meshId) ?? meshId, count);
            parts.push({ text, source: 'relay', messageId: `fold:${meshId}:${now}`, meshId });
        }
        return { taken, parts };
    }

    /** The taken items reached the assistant: dequeue, log, mark rows delivered, reset signals. */
    private commitTaken(taken: Item[], parts: Part[], sid: string | null, submitted = false): void {
        const at = this.clock.now();
        // An announced reply is notified exactly once; replies still unreadable stay queued and unmarked.
        const emptied = new Set<Item>();
        for (const { gap } of parts) if (gap) {
            this.gaps.markNotified(gap.replies[0]!, sid);
            for (const r of gap.replies) this.gaps.markReplyNotified(r, sid);
            gap.item.gapReplies = gap.item.gapReplies?.filter(r => !gap.replies.includes(r));
            if (!gap.item.gapReplies?.length) emptied.add(gap.item);
        }
        this.queue = this.queue.filter((i) => !taken.includes(i) && !emptied.has(i));
        if (sid) for (const p of parts) this.ports.inputLog.append(sid, p.source, { at, messageId: p.messageId });
        if (sid) for (const p of parts) if (p.source === 'review') this.ports.onReviewDelivered?.(sid, p.messageId, at);
        const relayItems = taken.filter((i): i is Item & { kind: 'relay' } => i.kind === 'relay');
        // Settle a report only after its last bounded page was sent. Earlier
        // pages stay pending with a durable cursor; folded backlog never claims
        // native coverage. Items outside the delivery budget stay queued.
        // Keep the rendered snapshot, not the mutable capture cache. Reading
        // another queued report can evict a body before this submit settles.
        const sentReports = new Map(parts.flatMap(p => (p.reports ?? []).map(r => [r.attemptId, r] as const)));
        const rendered = relayItems.flatMap(i => i.attemptIds.filter(id => {
            const report = sentReports.get(id);
            return report && !report.autoStopped && report.offset + RELAY_BODY_MAX_CHARS >= report.totalPoints;
        }));
        const coverage = rendered.flatMap(id => sentReports.get(id)?.coverage ?? []);
        const settled = relayItems.flatMap(i => i.attemptIds.filter(id => !sentReports.has(id) || sentReports.get(id)?.autoStopped || rendered.includes(id)));
        for (const item of relayItems) {
            const remaining = item.attemptIds.filter(id => sentReports.has(id) && !sentReports.get(id)?.autoStopped && !rendered.includes(id));
            for (const id of remaining) {
                const report = sentReports.get(id)!;
                this.ports.store.writeReceipt(receiptKey('relay-page', id, report.reportId), String(report.offset + RELAY_BODY_MAX_CHARS), at, 'page');
            }
            if (remaining.length) {
                this.queue.push({ ...item, attemptIds: remaining });
                this.dirty = true;
            }
        }
        for (const item of relayItems) for (const id of item.attemptIds) if (settled.includes(id) && !rendered.includes(id)) {
            this.gaps.markNotified({ sessionId: this.restoredAttempts.get(id)?.sessionId ?? item.coordinatorSessionId,
                attemptId: id, messageAt: item.committedAt, text: '', chars: 0 }, sid);
        }
        // A notice or continuation cursor is a surfaced report, not a missed one (countUnrendered).
        const surfaced = new Set([...parts.flatMap(p => p.surfaced ?? []), ...[...sentReports.values()].filter(r => r.autoStopped).map(r => r.attemptId)]);
        this.ports.store.markDelivered(settled, at, [...rendered, ...settled.filter(id => surfaced.has(id))], coverage);
        if (relayItems.length) this.loadDeliveredCoverage(at);
        for (const id of settled) {
            this.attemptBodyCapture.delete(id); this.attemptBodies.delete(id); this.attemptMeta.delete(id); this.attemptBodyAt.delete(id); this.restoredAttempts.delete(id);
        }
        const meshes = [...new Set(relayItems.map((i) => i.meshId))];
        for (const m of meshes) {
            this.lastRelayAt.set(m, at);
            this.progressSent.delete(m);
            this.stallSent.delete(m);
        }
        if (meshes.length) this.ports.onRelayDelivered?.(meshes, at);
        if (sid && submitted) this.ports.onInputsSubmitted?.(sid, parts.map(p => p.messageId), at);
    }

    /** Last relay delivery to the assistant for the mesh (this process), or null. */
    lastRelayAtFor(meshId: string): number | null {
        return this.lastRelayAt.get(meshId) ?? null;
    }

    /**
     * Coordinator turns that settled without their own body reaching the
     * assistant (batch-folded or aged out). Counts and project slugs only.
     * Surfaced with actionable gap pointers and in `project_status` —
     * because the 2026-10-10 losses were only ever found by the owner
     * suspecting them and asking.
     */
    missedReports(): Array<{ slug: string; count: number }> {
        return this.slugCounts(this.unrenderedByMesh());
    }

    /** Same count for one project (the `project_status` backstop). */
    missedReportsFor(meshId: string): number {
        return this.unrenderedByMesh().get(meshId) ?? 0;
    }

    private newGapLine(sessionId: string | null, missed: readonly { slug: string; count: number }[]): string {
        return buildMissedReportsLine(missed.filter(m => this.ports.store.readReceipt(receiptKey('counter', sessionId, m.slug), this.clock.now()) !== String(m.count)));
    }

    private rememberGaps(sessionId: string | null, missed: readonly { slug: string; count: number }[]): void {
        for (const m of missed) this.ports.store.writeReceipt(receiptKey('counter', sessionId, m.slug), String(m.count), this.clock.now(), 'counter');
    }

    /** Stored gaps (not yet counted again) per mesh. */
    private unrenderedByMesh(announced: readonly AuditedCoordinatorReply[] = []): Map<string, number> {
        const counts = new Map(this.ports.store.countUnrendered(this.clock.now() - MISSED_REPORT_WINDOW_MS).byMesh.map((r) => [r.meshId, r.count]));
        // Unreadable replies are only counted (here and in project_status), never a wake-up of their own.
        const held = this.queue.flatMap(i => i.kind === 'line' ? i.gapReplies ?? [] : []).filter(r => !announced.includes(r));
        for (const [meshId, n] of this.deliveryPolicy.unreadableByMesh(held, r => r.meshId ?? this.ports.coordinatorMeshOf(r.sessionId)))
            counts.set(meshId, (counts.get(meshId) ?? 0) + n);
        return counts;
    }

    /** Stored gaps plus the ones this pending delivery is about to create. */
    private missedReportsIncluding(taken: readonly Item[], parts: readonly Part[]): Array<{ slug: string; count: number }> {
        const counts = this.unrenderedByMesh(parts.flatMap(p => p.gap?.replies ?? []));
        const sentReports = new Set(parts.flatMap(p => [...(p.reports?.map(r => r.attemptId) ?? []), ...(p.surfaced ?? [])]));
        for (const item of taken) {
            if (item.kind !== 'relay') continue;
            // Missing captures and aged-out items do not deliver their reports.
            const missed = item.attemptIds.filter(id => !sentReports.has(id)).length;
            if (missed > 0) counts.set(item.meshId, (counts.get(item.meshId) ?? 0) + missed);
        }
        return this.slugCounts(counts);
    }

    private hasCapturedBody(attemptId: string): boolean {
        const completeness = this.attemptMeta.get(attemptId)?.completeness;
        return (completeness === 'final_native' || completeness === 'final_adapter') && !!this.attemptBodies.get(attemptId)?.trim();
    }

    private slugCounts(counts: ReadonlyMap<string, number>): Array<{ slug: string; count: number }> {
        return [...counts.entries()]
            .filter(([, n]) => n > 0)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([meshId, count]) => ({ slug: this.ports.projectSlug(meshId) ?? meshId, count }));
    }

    /**
     * Every attempt in the batch, in commit order, each resolved to the body
     * captured for IT at ITS OWN commit time — never the batch's last turn's
     * body reused for earlier ones. Await the initial capture, and use one
     * bounded probe per backoff step for restores/retries. Unavailable captures
     * get a content-free notice after the grace, never a partial body.
     */
    private async bodiesFor(item: Item & { kind: 'relay' }): Promise<Array<string | null>> {
        for (const id of item.attemptIds) {
            if (this.hasCapturedBody(id) || this.attemptBodyCapture.has(id)) continue;
            const ref = this.restoredAttempts.get(id);
            this.captureAttemptBody(id, ref?.meshId ?? item.meshId, ref?.sessionId ?? item.coordinatorSessionId, false, true);
        }
        await Promise.all(item.attemptIds.map(id => this.attemptBodyCapture.get(id)));
        return item.attemptIds.map(id => this.attemptBodies.get(id) ?? null);
    }

    private pageOffset(id: string, body: string): number {
        return Number(this.ports.store.readReceipt(receiptKey('relay-page', id, reportBodyId(body)), this.clock.now()) ?? 0);
    }

    private relayPartId(item: Item & { kind: 'relay' }, bodies: Array<string | null>): string {
        const base = relayMessageId(item.meshId, item.attemptIds.at(-1)!);
        const offsets = item.attemptIds.map((id, index) => this.pageOffset(id, bodies[index] ?? ''));
        const paged = offsets.some(n => n > 0) || bodies.some(body => codePoints(body ?? '') > RELAY_BODY_MAX_CHARS);
        return paged ? `${base}:page:${receiptKey(bodies.map((body, index) => [reportBodyId(body ?? ''), offsets[index]]))}` : base;
    }

    private async renderUnavailable(item: Item & { kind: 'relay' }): Promise<Part> {
        const attemptId = item.attemptIds.at(-1)!;
        const ref = this.restoredAttempts.get(attemptId);
        const session = ref?.sessionId ?? item.coordinatorSessionId;
        let cursor: ReportContinuation | null = null;
        try { cursor = await this.bounded(this.ports.readCoordinatorReference?.(item.meshId, session) ?? Promise.resolve(null), 2_000, null); } catch { /* absence is reported explicitly */ }
        return { source: 'relay', meshId: item.meshId,
            messageId: `gap:unavailable:${receiptKey(item.meshId, item.attemptIds)}`, surfaced: [...item.attemptIds],
            text: unavailableReportNotice(item.attemptIds.length, this.ports.projectSlug(item.meshId) ?? item.meshId, cursor, { attemptId, coordinatorSessionId: session }) };
    }

    private async renderRelay(item: Item & { kind: 'relay' }): Promise<Part> {
        const remote = this.remote.get(item.meshId);
        const bodies = await this.bodiesFor(item);
        const refs = item.attemptIds.slice(-12).map(attemptId => {
            const index = item.attemptIds.indexOf(attemptId); const body = bodies[index];
            const meta = this.attemptMeta.get(attemptId);
            const source = meta?.completeness ?? (body ? 'final_native' : null);
            const verified = source === 'final_native';
            return { attemptId, coordinatorSessionId: this.restoredAttempts.get(attemptId)?.sessionId ?? item.coordinatorSessionId,
                reportId: body ? reportBodyId(body) : null, totalChars: body?.length ?? null,
                complete: source === 'final_native' || source === 'final_adapter', verified, source,
                offset: body ? Array.from(body).slice(0, this.pageOffset(attemptId, body ?? '')).join('').length : 0,
                nextOffset: body && this.pageOffset(attemptId, body ?? '') + RELAY_BODY_MAX_CHARS < codePoints(body)
                    ? Array.from(body).slice(0, this.pageOffset(attemptId, body ?? '') + RELAY_BODY_MAX_CHARS).join('').length : null };
        });
        const references = `[ADHDev report references] ${JSON.stringify({ meshId: item.meshId, reports: refs, omittedReferences: Math.max(0, item.attemptIds.length - refs.length) })}\n`;
        const envelope = buildRelayEnvelope({
            slug: this.ports.projectSlug(item.meshId) ?? item.meshId,
            outcome: item.outcome,
            preservePageWhitespace: true,
            bodies: bodies.map((body, index) => body ? Array.from(body).slice(this.pageOffset(item.attemptIds[index]!, body), this.pageOffset(item.attemptIds[index]!, body) + RELAY_BODY_MAX_CHARS).join('') : body),
            statusLine: remote ? remote.statusLine : this.ports.meshStatusLine?.(item.meshId) ?? null,
            idle: item.idle,
        });
        const headerEnd = envelope.indexOf('\n') + 1;
        const reports = item.attemptIds.map((id, index): RenderedReportPage => {
            const body = bodies[index]!;
            const offset = this.pageOffset(id, body);
            const totalPoints = codePoints(body);
            const meta = this.attemptMeta.get(id) ?? { body, completeness: 'final_native' as const };
            const autoStopped = offset + RELAY_BODY_MAX_CHARS < totalPoints && offset / RELAY_BODY_MAX_CHARS + 1 >= RELAY_MAX_AUTO_PAGES;
            const coverage = offset + RELAY_BODY_MAX_CHARS >= totalPoints
                ? this.renderedParts(id, this.restoredAttempts.get(id)?.sessionId ?? item.coordinatorSessionId, body, meta, Infinity) : null;
            return { attemptId: id, reportId: reportBodyId(body), offset, totalPoints, autoStopped, ...(coverage ? { coverage } : {}) };
        });
        const continuations = reports.filter(r => r.autoStopped).map(r => {
            const body = bodies[item.attemptIds.indexOf(r.attemptId)]!;
            return `[ADHDev relay continuation] Automatic delivery stopped after ${RELAY_MAX_AUTO_PAGES} pages. Read the remaining text with project_read ${JSON.stringify({
                project: this.ports.projectSlug(item.meshId) ?? item.meshId, attemptId: r.attemptId, reportId: r.reportId,
                coordinatorSessionId: this.restoredAttempts.get(r.attemptId)?.sessionId ?? item.coordinatorSessionId,
                offset: Array.from(body).slice(0, r.offset + RELAY_BODY_MAX_CHARS).join('').length })}.`;
        }).join('\n');
        const text = envelope.slice(0, headerEnd) + references + (continuations ? continuations + '\n' : '') + envelope.slice(headerEnd);
        return { text, source: 'relay', messageId: this.relayPartId(item, bodies), meshId: item.meshId, reports };
    }
}
