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
import {
    RELAY_BACKLOG_FOLD_AFTER_MS, RELAY_DELIVERY_MAX_CHARS, RELAY_MAX_WAIT_MS, RELAY_PROGRESS_AFTER_MS, RELAY_QUIET_MS,
    RELAY_STALL_AFTER_MS, buildApprovalSignal, buildCoordinatorEndedSignal, buildFoldedBacklogLine, buildProgressSignal,
    buildRelayEnvelope, buildRestartNote, buildStallSignal, codePoints, relayMessageId, shouldAddRestartNote,
    type RestartContext,
} from './assistant-relay-format.js';

export const ASSISTANT_RELAY_BUS_KINDS = ['turn', 'modal', 'prompt', 'terminated', 'registered', 'status'] as const;
export type AssistantRelayBusEvent = EventOf<typeof ASSISTANT_RELAY_BUS_KINDS[number]>;

/** A human input parked in the driver FIFO is attributed when the next turn starts; give up after this. */
export const PENDING_HUMAN_MAX_AGE_MS = 5 * 60_000;

export interface MeshWorkCounts { activeMissions: number; pending: number; assigned: number }

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
    /** The coordinator's latest assistant-role bubble, via the read_chat projection, at send time. */
    readCoordinatorTail(sessionId: string): Promise<string | null>;
    /** Content-free `[Mesh]` line (`buildMeshStatusLineForNotification`). */
    meshStatusLine?(meshId: string): string | null;
    meshWork(meshId: string): MeshWorkCounts | null;
    /** Registry: does an assistant entry exist at all (trigger condition 3)? */
    hasAssistant(): boolean;
    /** Registry: the bound assistant session, or null. */
    assistantSessionId(): string | null;
    /** Live: the assistant will take input now (ready status, no modal). */
    isAssistantReady(sessionId: string): boolean;
    /** The existing submit funnel (`send_chat` / SessionInputService), `origin` set by the adapter. */
    submit(sessionId: string, input: { text: string; messageId: string; policy: SendPolicy }): Promise<SubmitOutcome>;
    inputLog: AssistantInputLog;
    store: AssistantRelayStore;
    /** Delivery hook (registry `markFirstRelay`, metrics). */
    onRelayDelivered?(meshIds: readonly string[], at: number): void;
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

type Item =
    | { kind: 'relay'; meshId: string; coordinatorSessionId: string; attemptIds: string[]; outcome: TurnOutcome; committedAt: number; idle: boolean }
    | { kind: 'line'; source: AssistantInputSource; text: string; messageId: string; meshId?: string };

export class AssistantRelay {
    private readonly clock: RelayClock;
    private readonly batches = new Map<string, Batch>();
    private readonly working = new Map<string, number>(); // meshId → coordinator working since
    private readonly sessionMesh = new Map<string, string>(); // coordinator sessionId → meshId (remembered)
    private readonly progressSent = new Set<string>();
    private readonly stallSent = new Set<string>();
    private readonly lastRelayAt = new Map<string, number>();
    private readonly modalOpen = new Set<string>();
    private queue: Item[] = [];
    private pendingHuman: number[] = []; // enqueue times of human inputs parked in the driver FIFO
    private unsubscribe: Unsubscribe | null = null;
    private flushing: Promise<void> | null = null;
    private dirty = false;
    private seq = 0;

    constructor(private readonly ports: AssistantRelayPorts) {
        this.clock = ports.clock ?? realClock;
    }

    /** Subscribe and load undelivered rows from the store as backlog. */
    start(): void {
        if (this.unsubscribe) return;
        const rows = this.ports.store.listUndelivered();
        const byMesh = new Map<string, Item & { kind: 'relay' }>();
        for (const r of rows) {
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
    }

    /** `project_send` accepted: open/refresh the project's thread. */
    openThread(meshId: string): void {
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

    /** First-run / review inputs (always queue, held until the assistant is ready). */
    enqueueInput(input: { source: AssistantInputSource; text: string; messageId: string }): void {
        this.queue.push({ kind: 'line', ...input });
        this.kick();
    }

    /**
     * Human input into the assistant under `busyInputMode` (§4.3 table).
     * Refusals are returned as is — never retried under another mode.
     */
    async submitHuman(text: string, opts: { messageId: string; busyInputMode?: BusyInputMode }): Promise<SubmitOutcome> {
        const sid = this.ports.assistantSessionId();
        if (!sid) return { kind: 'refused', reason: 'no_target' };
        const outcome = await this.ports.submit(sid, { text, messageId: opts.messageId, policy: busyInputModeToSendPolicy(opts.busyInputMode) });
        if (outcome.kind === 'delivered' || (outcome.kind === 'queued' && outcome.route === 'agent_queue')) {
            this.ports.inputLog.append(sid, 'human', { at: this.clock.now(), messageId: opts.messageId });
        } else if (outcome.kind === 'queued') {
            this.pendingHuman.push(this.clock.now());
        }
        return outcome;
    }

    /** Periodic (≈1 min): progress / stall signals, vanished projects, retention, retries. */
    tick(now: number = this.clock.now()): void {
        this.pendingHuman = this.pendingHuman.filter((t) => now - t < PENDING_HUMAN_MAX_AGE_MS);
        for (const t of this.ports.store.openThreads()) {
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
                    this.pushLine('progress', buildProgressSignal(slug, this.ports.meshWork(t.meshId)?.assigned ?? null), t.meshId);
                }
                continue;
            }
            if (this.batches.has(t.meshId) || this.stallSent.has(t.meshId)) continue;
            const quietSince = Math.max(t.lastSendAt, this.lastRelayAt.get(t.meshId) ?? 0);
            if (now - quietSince < RELAY_STALL_AFTER_MS) continue;
            const w = this.ports.meshWork(t.meshId);
            if (w && (w.activeMissions > 0 || w.pending > 0) && w.assigned === 0) {
                this.stallSent.add(t.meshId);
                this.pushLine('stall', buildStallSignal(slug, w), t.meshId);
            }
        }
        this.ports.store.prune(now);
        this.kick();
    }

    /** Test/diagnostic view. */
    snapshot(): { queued: number; batches: string[]; pendingHuman: number } {
        return { queued: this.queue.length, batches: [...this.batches.keys()], pendingHuman: this.pendingHuman.length };
    }

    /** Resolves when the in-flight delivery (if any) settles. */
    async idle(): Promise<void> {
        while (this.flushing) await this.flushing;
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
                for (const at of this.pendingHuman) this.ports.inputLog.append(sid, 'human', { at });
                this.pendingHuman = [];
            }
            if (e.phase !== 'committed') return;
            this.ports.inputLog.closeTurn(sid);
        } else if (e.kind === 'status') {
            if (SESSION_STATUS_CLASS[e.next] !== 'ready') return;
        } else if (e.kind === 'terminated') {
            this.pendingHuman = [];
            return;
        } else {
            return;
        }
        this.kick();
    }

    private onCoordinatorTurn(meshId: string, e: EventOf<'turn'>): void {
        if (!e.attemptId.startsWith('plain:')) return;
        if (e.phase === 'started' || e.phase === 'resumed') {
            if (!this.working.has(meshId)) this.working.set(meshId, e.at);
            const b = this.batches.get(meshId);
            if (b && b.quietTimer !== null) {
                this.clock.clearTimeout(b.quietTimer); // chained turn: wait for its commit (bounded by maxTimer)
                b.quietTimer = null;
            }
            return;
        }
        if (e.phase !== 'committed') return;
        this.working.delete(meshId);
        if (!this.ports.hasAssistant() || !this.ports.store.isThreadOpen(meshId)) return;
        const outcome = e.outcome ?? 'completed';
        const fresh = this.ports.store.recordCommitted({
            attemptId: e.attemptId, meshId, coordinatorSessionId: e.sessionId, committedAt: e.at, kind: 'relay', outcome,
        });
        if (!fresh) return;
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
        const w = this.ports.meshWork(meshId);
        const idle = !!w && w.activeMissions === 0 && w.pending + w.assigned === 0;
        if (idle) this.ports.store.closeThread(meshId, this.clock.now());
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
        const now = this.clock.now();
        const taken: Item[] = [];
        const parts: Array<{ text: string; source: AssistantInputSource; messageId: string }> = [];
        const folded = new Map<string, number>();
        let size = 0;
        for (const item of this.queue) {
            if (item.kind === 'relay' && now - item.committedAt > RELAY_BACKLOG_FOLD_AFTER_MS) {
                folded.set(item.meshId, (folded.get(item.meshId) ?? 0) + item.attemptIds.length);
                taken.push(item);
                continue;
            }
            const part = item.kind === 'line'
                ? { text: item.text, source: item.source, messageId: item.messageId }
                : await this.renderRelay(item);
            const cost = codePoints(part.text) + 2;
            if (parts.length && size + cost > RELAY_DELIVERY_MAX_CHARS) break;
            parts.push(part);
            taken.push(item);
            size += cost;
        }
        for (const [meshId, count] of folded) {
            const text = buildFoldedBacklogLine(this.ports.projectSlug(meshId) ?? meshId, count);
            parts.push({ text, source: 'relay', messageId: `fold:${meshId}:${now}` });
        }
        if (!parts.length) {
            this.queue = this.queue.filter((i) => !taken.includes(i));
            return;
        }
        const messageId = parts.length === 1 ? parts[0]!.messageId : `${parts[0]!.messageId}+${parts.length - 1}`;
        const outcome = await this.ports.submit(sid, { text: parts.map((p) => p.text).join('\n\n'), messageId, policy: { mode: 'queue' } });
        if (outcome.kind === 'refused') return;
        this.queue = this.queue.filter((i) => !taken.includes(i));
        const at = this.clock.now();
        for (const p of parts) this.ports.inputLog.append(sid, p.source, { at, messageId: p.messageId });
        const relayItems = taken.filter((i): i is Item & { kind: 'relay' } => i.kind === 'relay');
        this.ports.store.markDelivered(relayItems.flatMap((i) => i.attemptIds), at);
        const meshes = [...new Set(relayItems.map((i) => i.meshId))];
        for (const m of meshes) {
            this.lastRelayAt.set(m, at);
            this.progressSent.delete(m);
            this.stallSent.delete(m);
        }
        if (meshes.length) this.ports.onRelayDelivered?.(meshes, at);
    }

    private async renderRelay(item: Item & { kind: 'relay' }): Promise<{ text: string; source: AssistantInputSource; messageId: string }> {
        let body: string | null = null;
        try {
            body = await this.ports.readCoordinatorTail(item.coordinatorSessionId);
        } catch {
            body = null;
        }
        const text = buildRelayEnvelope({
            slug: this.ports.projectSlug(item.meshId) ?? item.meshId,
            outcome: item.outcome,
            body,
            statusLine: this.ports.meshStatusLine?.(item.meshId) ?? null,
            earlierTurns: item.attemptIds.length - 1,
            idle: item.idle,
        });
        return { text, source: 'relay', messageId: relayMessageId(item.meshId, item.attemptIds[item.attemptIds.length - 1]!) };
    }
}
