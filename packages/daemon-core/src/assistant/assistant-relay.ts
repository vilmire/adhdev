import { reportBodyId } from './report-continuation.js';
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
import type { AssistantRelayStore } from './assistant-relay-store.js';
import { busyInputModeToSendPolicy, type BusyInputMode } from './assistant-registry.js';
import { countTerminalSubmits, TERMINAL_SUBMITS_PER_WRITE_CAP } from './assistant-human-input.js';
import {
    RELAY_BACKLOG_FOLD_AFTER_MS, RELAY_DELIVERY_MAX_CHARS, RELAY_IDLE_CLOSE_GRACE_MS, RELAY_MAX_WAIT_MS, RELAY_PROGRESS_AFTER_MS, RELAY_QUIET_MS,
    RELAY_STALL_AFTER_MS, buildApprovalSignal, buildCoordinatorEndedSignal, buildFoldedBacklogLine, buildProgressSignal,
    buildMissedReportsLine, buildRelayEnvelope, buildRestartNote, buildStallSignal, buildUnreachableRelay, codePoints, relayMessageId,
    shouldAddRestartNote,
    type RestartContext,
} from './assistant-relay-format.js';

export const ASSISTANT_RELAY_BUS_KINDS = ['turn', 'modal', 'prompt', 'terminated', 'registered', 'status'] as const;
export type AssistantRelayBusEvent = EventOf<typeof ASSISTANT_RELAY_BUS_KINDS[number]>;

/** A human input parked in the driver FIFO is attributed when the next turn starts; give up after this. */
export const PENDING_HUMAN_MAX_AGE_MS = 5 * 60_000;

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
    /** Existing evidence only; exact attempt/session/mesh, never the newest tail. */
    rehydrateAttemptReport?(meshId: string, sessionId: string, attemptId: string): Promise<string | null>;
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

type Part = { text: string; source: AssistantInputSource; messageId: string; meshId?: string };

/** One entry of `assistant_pending_relays` → `assistantEvents` (MCP-only assistant). */
export interface AssistantPulledEvent {
    source: AssistantInputSource;
    messageId: string;
    text: string;
    meshId?: string;
}

type Item =
    | { kind: 'relay'; meshId: string; coordinatorSessionId: string; attemptIds: string[]; outcome: TurnOutcome; committedAt: number; idle: boolean }
    | { kind: 'line'; source: AssistantInputSource; text: string; messageId: string; meshId?: string; forSessionId?: string };

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
    /** Historical gaps already surfaced to each assistant session in this process. */
    private readonly notifiedGaps = new Map<string, Map<string, number>>();
    private readonly modalOpen = new Set<string>();
    /** Remote-hosted projects: the host's last poll answer (work counts, status line). */
    private readonly remote = new Map<string, RemoteProjectSnapshot>();
    /** Exact attempt reports returned by the authorized evidence reader. The
     * memory cache clears on delivery; the reader retains bounded durable captures. */
    private readonly attemptBodies = new Map<string, string | null>();
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

    private readonly restoredAttempts = new Map<string, { meshId: string; sessionId: string }>();

    constructor(private readonly ports: AssistantRelayPorts) {
        this.clock = ports.clock ?? realClock;
    }

    /** Subscribe and load undelivered rows from the store as backlog. */
    start(): void {
        if (this.unsubscribe) return;
        const rows = this.ports.store.listUndelivered();
        const byMesh = new Map<string, Item & { kind: 'relay' }>();
        for (const r of rows) {
            this.restoredAttempts.set(r.attemptId, { meshId: r.meshId, sessionId: r.coordinatorSessionId });
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
        this.unsubscribe = this.ports.subscribe((e) => this.onEvent(e));
    }

    stop(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        for (const b of this.batches.values()) this.clearBatchTimers(b);
        this.batches.clear();
        this.attemptBodyCapture.clear();
        this.attemptBodies.clear();
    }

    /** `project_send` accepted: open/refresh the project's thread. */
    openThread(meshId: string): void {
        this.idleSince.delete(meshId);
        this.ports.store.openThread(meshId, this.clock.now());
        this.stallSent.delete(meshId);
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
            if (this.batches.has(t.meshId) || this.stallSent.has(t.meshId)) continue;
            const quietSince = Math.max(t.lastSendAt, this.lastRelayAt.get(t.meshId) ?? 0);
            if (now - quietSince < RELAY_STALL_AFTER_MS) continue;
            const w = this.workOf(t.meshId);
            if (w && (w.activeMissions > 0 || w.pending > 0) && w.assigned === 0) {
                this.stallSent.add(t.meshId);
                this.pushLine('stall', buildStallSignal(slug, w), t.meshId);
            }
        }
        this.ports.store.prune(now);
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
        else if (e.kind === 'modal' || e.kind === 'prompt') this.onCoordinatorAttention(meshId, e.sessionId, e.kind === 'modal' ? e.modal : e.prompt);
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
        this.onCoordinatorAttention(meshId, `remote:${meshId}`, snap.modal ? true : null);
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
        this.captureAttemptBody(e.attemptId, meshId, e.sessionId);
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
     * persists validated terminal/envelope/native evidence, never a session tail.
     * Delivery/folding or stop invalidates this cache token without cancelling
     * a safe durable capture still completing in the reader. */
    private captureAttemptBody(attemptId: string, meshId: string, coordinatorSessionId: string): void {
        const p = (this.ports.rehydrateAttemptReport?.(meshId, coordinatorSessionId, attemptId) ?? Promise.resolve(null))
            .then((body) => {
                if (this.attemptBodyCapture.get(attemptId) === p) this.attemptBodies.set(attemptId, body);
            })
            .catch(() => {
                if (this.attemptBodyCapture.get(attemptId) === p) this.attemptBodies.set(attemptId, null);
            })
            .finally(() => {
                if (this.attemptBodyCapture.get(attemptId) === p) this.attemptBodyCapture.delete(attemptId);
            });
        this.attemptBodyCapture.set(attemptId, p);
    }

    private onCoordinatorAttention(meshId: string, sessionId: string, value: unknown): void {
        if (value === null || value === undefined) {
            this.modalOpen.delete(sessionId);
            return;
        }
        if (this.modalOpen.has(sessionId) || !this.ports.hasAssistant() || !this.ports.store.isThreadOpen(meshId)) return;
        this.modalOpen.add(sessionId);
        const slug = this.ports.projectSlug(meshId);
        if (slug !== null) this.pushLine('relay', buildApprovalSignal(slug), meshId);
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
        const { taken, parts } = await this.takeParts(this.clock.now(), sid);
        if (!parts.length) {
            this.queue = this.queue.filter((i) => !taken.includes(i));
            return;
        }
        const messageId = parts.length === 1 ? parts[0]!.messageId : `${parts[0]!.messageId}+${parts.length - 1}`;
        // The gap notice rides along with the delivery (requirement: the
        // assistant must learn of a loss without asking). It covers gaps this
        // delivery is itself about to create — its own folded turns — plus any
        // still unacknowledged from before, so the last relay of a quiet
        // stretch still reports its fold.
        const missed = this.missedReportsIncluding(taken, parts);
        const gap = parts.some((p) => p.source === 'review') ? '' : this.newGapLine(sid, missed, taken, parts);
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
        const { taken, parts } = await this.takeParts(this.clock.now(), sessionId);
        const missed = this.missedReportsIncluding(taken, parts);
        const gap = parts.some((p) => p.source === 'review') ? '' : this.newGapLine(sessionId, missed, taken, parts);
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
            const part: Part = item.kind === 'line'
                ? { text: item.text, source: item.source, messageId: item.messageId, ...(item.meshId ? { meshId: item.meshId } : {}) }
                : await this.renderRelay(item);
            const cost = codePoints(part.text) + 2;
            if (parts.length && size + cost > RELAY_DELIVERY_MAX_CHARS) break;
            parts.push(part);
            taken.push(item);
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
        this.queue = this.queue.filter((i) => !taken.includes(i));
        const at = this.clock.now();
        if (sid) for (const p of parts) this.ports.inputLog.append(sid, p.source, { at, messageId: p.messageId });
        if (sid) for (const p of parts) if (p.source === 'review') this.ports.onReviewDelivered?.(sid, p.messageId, at);
        const relayItems = taken.filter((i): i is Item & { kind: 'relay' } => i.kind === 'relay');
        // Only captured bodies actually sent count as rendered. An aged-out
        // backlog or a missing-body placeholder settles without claiming its
        // report arrived. Items outside the delivery budget stay queued.
        const sentIds = new Set(parts.map((p) => p.messageId));
        const rendered = relayItems.flatMap((i) => {
            const last = i.attemptIds[i.attemptIds.length - 1]!;
            return sentIds.has(relayMessageId(i.meshId, last))
                ? i.attemptIds.filter((id) => this.hasCapturedBody(id)) : [];
        });
        this.ports.store.markDelivered(relayItems.flatMap((i) => i.attemptIds), at, rendered);
        for (const id of relayItems.flatMap((i) => i.attemptIds)) { this.attemptBodyCapture.delete(id); this.attemptBodies.delete(id); this.restoredAttempts.delete(id); }
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
     * Surfaced unprompted — on every relay envelope and in `project_status` —
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

    private newGapLine(sessionId: string | null, missed: readonly { slug: string; count: number }[], taken: readonly Item[], parts: readonly Part[]): string {
        const seen = this.notifiedGaps.get(sessionId ?? '');
        const sentIds = new Set(parts.map((p) => p.messageId));
        const newLosses = new Set<string>();
        for (const item of taken) {
            if (item.kind !== 'relay') continue;
            if (!sentIds.has(relayMessageId(item.meshId, item.attemptIds[item.attemptIds.length - 1]!))
                || item.attemptIds.some((id) => !this.hasCapturedBody(id))) {
                newLosses.add(this.ports.projectSlug(item.meshId) ?? item.meshId);
            }
        }
        // Retention can lower the historical total: a newly lost body still
        // needs a notice even when its count equals an older, pruned total.
        return buildMissedReportsLine(missed.filter((m) => newLosses.has(m.slug) || m.count > (seen?.get(m.slug) ?? 0)));
    }

    private rememberGaps(sessionId: string | null, missed: readonly { slug: string; count: number }[]): void {
        const key = sessionId ?? '';
        const seen = this.notifiedGaps.get(key) ?? new Map<string, number>();
        for (const m of missed) seen.set(m.slug, m.count);
        this.notifiedGaps.set(key, seen);
    }

    /** Stored gaps (not yet counted again) per mesh. */
    private unrenderedByMesh(): Map<string, number> {
        return new Map(this.ports.store.countUnrendered().byMesh.map((r) => [r.meshId, r.count]));
    }

    /** Stored gaps plus the ones this pending delivery is about to create. */
    private missedReportsIncluding(taken: readonly Item[], parts: readonly Part[]): Array<{ slug: string; count: number }> {
        const counts = this.unrenderedByMesh();
        const sentIds = new Set(parts.map((p) => p.messageId));
        for (const item of taken) {
            if (item.kind !== 'relay') continue;
            const last = item.attemptIds[item.attemptIds.length - 1]!;
            // Missing captures and aged-out items do not deliver their reports.
            const missed = sentIds.has(relayMessageId(item.meshId, last))
                ? item.attemptIds.filter((id) => !this.hasCapturedBody(id)).length : item.attemptIds.length;
            if (missed > 0) counts.set(item.meshId, (counts.get(item.meshId) ?? 0) + missed);
        }
        return this.slugCounts(counts);
    }

    private hasCapturedBody(attemptId: string): boolean {
        return !!this.attemptBodies.get(attemptId)?.trim();
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
     * body reused for earlier ones. A local attempt still mid-capture (the
     * async read fired in `commit()` has not settled) is awaited here rather
     * than raced; only a capture that actually failed renders the no-body
     * placeholder (via `compactRelayBody(null)` downstream).
     */
    private async bodiesFor(item: Item & { kind: 'relay' }): Promise<Array<string | null>> {
        const pending = item.attemptIds.map((id) => this.attemptBodyCapture.get(id)).filter((p): p is Promise<void> => !!p);
        if (pending.length) await Promise.all(pending);
        for (const id of item.attemptIds) {
            const ref = this.restoredAttempts.get(id);
            if (!ref || this.attemptBodies.has(id)) continue;
            // Authorization is checked by the runtime reader for every attempt. The authorized reader prefers the durable exact capture.
            let body: string | null = null;
            try { body = await this.ports.rehydrateAttemptReport?.(ref.meshId, ref.sessionId, id) ?? null; } catch { /* exact evidence unavailable */ }
            if (body) this.attemptBodies.set(id, body);
        }
        return item.attemptIds.map((id) => this.attemptBodies.get(id) ?? null);
    }

    private async renderRelay(item: Item & { kind: 'relay' }): Promise<Part> {
        const lastAttempt = item.attemptIds[item.attemptIds.length - 1]!;
        const remote = this.remote.get(item.meshId);
        const bodies = await this.bodiesFor(item);
        const unavailable = item.attemptIds.filter((id, index) => this.restoredAttempts.has(id) && !bodies[index]);
        const refs = item.attemptIds.slice(-12).map(attemptId => {
            const index = item.attemptIds.indexOf(attemptId); const body = bodies[index];
            return { attemptId, coordinatorSessionId: this.restoredAttempts.get(attemptId)?.sessionId ?? item.coordinatorSessionId,
                reportId: body ? reportBodyId(body) : null, totalChars: body?.length ?? null };
        });
        const references = `[ADHDev report references] ${JSON.stringify({ meshId: item.meshId, reports: refs, omittedReferences: Math.max(0, item.attemptIds.length - refs.length) })}\n`;
        const envelope = buildRelayEnvelope({
            slug: this.ports.projectSlug(item.meshId) ?? item.meshId,
            outcome: item.outcome,
            bodies,
            statusLine: remote ? remote.statusLine : this.ports.meshStatusLine?.(item.meshId) ?? null,
            idle: item.idle,
        });
        const headerEnd = envelope.indexOf('\n') + 1;
        const missing = unavailable.length ? `[ADHDev original report unavailable] Exact authorized attempt evidence could not rehydrate: ${unavailable.join(', ')}. A new report would be regeneration.\n` : '';
        const text = envelope.slice(0, headerEnd) + references + missing + envelope.slice(headerEnd);
        return { text, source: 'relay', messageId: relayMessageId(item.meshId, lastAttempt), meshId: item.meshId };
    }
}
