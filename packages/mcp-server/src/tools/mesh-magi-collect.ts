// MAGI replica collection: poll the group's replica tasks until each reaches a final
// verdict (parseable answer, stale assignment, terminal failure, or the deadline),
// with one schema-retry per replica and approval-wedge recovery. Split out of
// mesh-tools-magi.ts.

import {
    type MeshContext,
    readString,
    isWeakCompletionEvidence,
    type MagiReplicaGitRef,
    type MagiTaskKind,
    type MagiSynthesizedResponse,
    type MagiAgentResponse,
    type MagiResponseSource,
    MAGI_RAW_ANSWER_CAP,
    meshNodeIdMatches,
    readSessionRecordId,
    isIdleSessionRecord,
    commandForNode,
    resolveSemanticReplicaTransport,
    unwrapCommandPayload,
    annotateQueueStaleness,
    readQueueFromDaemon,
} from './mesh-tools-internal.js';
import { ledgerQuery, recordLocal } from '../ipc/turn-commands.js';
import { nodeHeadCommit } from './mesh-magi-fanout.js';
import { MAGI_TERMINAL_STATUSES, sessionSharedWithAnotherReplica, classifyStaleReplicas } from './mesh-magi-lifecycle.js';
import {
    DEFAULT_TASK_KIND,
    collectMagiCandidateTexts,
    type MagiKindParseResult,
    magiReadIndicatesApprovalWedge,
    parseFirstMagiCandidateForKind,
} from './mesh-tools-magi-core.js';
import { readNodeRuntime } from './mesh-held-node-state.js';
import { magiOutputContractFor } from './mesh-tools-magi-core.js';
import { ensureMeshNodeRoutes } from './mesh-node-routes.js';
import { readTranscriptReplicaForSemanticConsumer, type SemanticTranscriptReadRequest } from './mesh-transcript-semantic-read.js';

/**
 * Fix A re-wait gate: a `completed` replica is NOT yet trustworthy for collection when its
 * terminal completion evidence is WEAK (the same insufficient/reviewRecommended/missing-
 * final-assistant signal the daemon shares across the live + ledger paths) OR a short-
 * generating suppressed completion (the early mid-turn bubble that the premature-collect bug
 * mistakes for the final answer). We look up the latest terminal ledger entry for the task —
 * the queue task row does not carry evidenceLevel/completionDiagnostic, but the ledger does
 * (see mesh-event-forwarding terminal payload). Best-effort: a missing/unreadable ledger
 * returns false so we never block collection on telemetry we cannot read.
 */
async function replicaCompletionIsWeak(ctx: MeshContext, taskId: string): Promise<boolean> {
    try {
        // C-W9a: the daemon answers `task_completed` from the turn ledger's committed
        // attempts (a weak commit carries evidenceLevel 'weak') plus any local
        // completion record — the terminal truth since C, which the retired event
        // ledger no longer saw.
        const { entries } = await ledgerQuery(ctx.transport, { meshId: ctx.mesh.id, kind: ['task_completed'], tail: 200 });
        for (let i = entries.length - 1; i >= 0; i -= 1) {
            const entry = entries[i] as any;
            const payload = entry?.payload && typeof entry.payload === 'object' ? entry.payload as Record<string, unknown> : undefined;
            const entryTaskId = readString(payload?.taskId) || readString(entry?.taskId);
            if (!entryTaskId || entryTaskId !== taskId) continue;
            if (isWeakCompletionEvidence(payload)) return true;
            const diag = payload?.completionDiagnostic;
            if (diag && typeof diag === 'object' && !Array.isArray(diag)
                && readString((diag as Record<string, unknown>).reason) === 'short_generating_suppressed') {
                return true;
            }
            return false;
        }
    } catch { /* ledger unreadable — do not block collection */ }
    return false;
}

// ─── Collection (best-effort, bounded) ──────────

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Replica poll interval (also the floor of a caller-supplied wait timeout). */
export const MAGI_POLL_INTERVAL_MS = 5_000;

/**
 * Pull a compact git ref off a live mesh node (its GitCompactSummary, populated by the
 * daemon git monitor) for deltaA git-skew. Returns undefined when the node carries no
 * git summary — refs are best-effort, never fabricated.
 */
function extractNodeGitRef(node: any): MagiReplicaGitRef | undefined {
    const git = node?.git;
    if (!git || typeof git !== 'object') return undefined;
    const ref: MagiReplicaGitRef = {};
    if (typeof git.branch === 'string' || git.branch === null) ref.branch = git.branch;
    const headCommit = nodeHeadCommit(node);
    if (headCommit) ref.headCommit = headCommit;
    if (typeof git.ahead === 'number' && Number.isFinite(git.ahead)) ref.ahead = git.ahead;
    if (typeof git.behind === 'number' && Number.isFinite(git.behind)) ref.behind = git.behind;
    if (typeof git.dirty === 'boolean') ref.dirty = git.dirty;
    return Object.keys(ref).length > 0 ? ref : undefined;
}

const emptyResponse = (): MagiAgentResponse => ({ claims: [], top_findings: [], open_questions: [] });

/**
 * FIX C-rawanswer: capture the replica's raw end-user answer (newest readable
 * candidate text from its transcript), capped to MAGI_RAW_ANSWER_CAP so a long
 * answer can't bloat the synthesis payload / ledger. Nothing is set when no
 * readable text was produced. Gated downstream: stripped from the persisted
 * magi_synthesis ledger entry and the default mesh_magi_collect response; surfaced
 * only in mesh_magi_collect verbose.
 */
function captureRawAnswer(source: MagiResponseSource, payload: unknown): void {
    try {
        const candidates = collectMagiCandidateTexts(payload);
        const raw = candidates.find(c => c.trim().length > 0);
        if (!raw) return;
        if (raw.length > MAGI_RAW_ANSWER_CAP) {
            source.rawAnswer = raw.slice(0, MAGI_RAW_ANSWER_CAP);
            source.rawAnswerTruncated = true;
        } else {
            source.rawAnswer = raw;
        }
    } catch { /* raw-answer capture is best-effort */ }
}

/**
 * Read a replica session's chat: the transcript replica first (§8 unit 8 —
 * fresh only, at the coverage the consumer admits), then a live read_chat.
 */
async function readReplicaChat(
    ctx: MeshContext,
    node: any,
    task: any,
    opts: Pick<SemanticTranscriptReadRequest, 'consumerId' | 'acceptCoverage'> & { readChat: Record<string, unknown> },
): Promise<any> {
    await ensureMeshNodeRoutes(ctx);
    const replicaTransport = resolveSemanticReplicaTransport(ctx, node);
    if (replicaTransport) {
        const replica = await readTranscriptReplicaForSemanticConsumer(replicaTransport, {
            consumerId: opts.consumerId,
            ownerDaemonId: node.daemonId,
            rawSessionId: task.assignedSessionId,
            acceptCoverage: opts.acceptCoverage,
            requireFresh: true,
        });
        if (replica.payload) return replica.payload;
    }
    const result = await commandForNode(ctx, node, 'read_chat', {
        sessionId: task.assignedSessionId,
        targetSessionId: task.assignedSessionId,
        workspace: node.workspace,
        ...opts.readChat,
    });
    return unwrapCommandPayload(result);
}

/** Per-replica verdict state for one collection run. */
class MagiReplicaCollector {
    /**
     * Per-replica FINAL verdict, locked once reached: a parseable answer, a stale dead
     * assignment, a non-readable terminal, or (at deadline) an unparseable confirmation.
     */
    readonly finalized = new Map<string, MagiSynthesizedResponse>();
    /**
     * A parseable-but-WEAK answer kept as the deadline fallback so a re-wait never
     * loses a valid answer it already saw.
     */
    private readonly provisional = new Map<string, MagiSynthesizedResponse>();
    /**
     * E: each replica gets at most ONE delta re-request when its terminal answer fails
     * the kind schema; a second schema failure drops to unparseable instead of looping.
     */
    readonly retried = new Set<string>();

    constructor(private readonly ctx: MeshContext, private readonly kind: MagiTaskKind) {}

    private findNode(nodeId: string | undefined) {
        return nodeId ? this.ctx.mesh.nodes.find(n => meshNodeIdMatches(n as any, nodeId)) : undefined;
    }

    private finalize(taskId: string, source: MagiResponseSource, error: string): true {
        source.error = error;
        this.finalized.set(taskId, { source, response: emptyResponse() });
        return true;
    }

    private buildSource(task: any): MagiResponseSource {
        const sourceNodeId = task.assignedNodeId || task.targetNodeId || undefined;
        // deltaA: capture the replica node's git ref so synthesis can flag cross-replica
        // git skew. Best-effort, from the live node's compact git summary.
        const gitRef = extractNodeGitRef(this.findNode(sourceNodeId));
        return {
            taskId: task.id,
            nodeId: sourceNodeId,
            provider: task.assignedProviderType || undefined,
            ok: false,
            ...(gitRef ? { git: gitRef } : {}),
        };
    }

    /**
     * E: send ONE delta re-request to a replica whose terminal answer failed the kind
     * schema, asking for a single JSON matching exactly that kind's contract.
     * Best-effort — a send failure leaves the replica to be finalized as unparseable at
     * the deadline. The replica stays `completed`; the new turn flips it back to
     * generating, so the poll loop re-reads it naturally. Returns true when the delta
     * was dispatched.
     */
    private async sendKindRetry(task: any, failReason: MagiKindParseResult['failReason']): Promise<boolean | 'busy'> {
        const { ctx, kind } = this;
        const node = this.findNode(task.assignedNodeId);
        if (!node || !task.assignedSessionId) return false;
        // Settled check (same axis as the rc.37 busy-session injection): the replica's
        // session may have moved on (another task claimed it, or it is still finishing a
        // turn). Only a live IDLE session may take the delta re-request; anything else is
        // 'busy' — the caller re-waits and retries on a later pass instead of queueing a
        // retry prompt behind someone else's turn. An unreadable status fails closed.
        // The session's state is the coordinator's answer (its own status or the
        // member's pushed runtime) — never a read of the member.
        const runtime = await readNodeRuntime(ctx, node);
        if (!runtime.known) return 'busy';
        const live = runtime.probe.sessions.find(session => readSessionRecordId(session) === task.assignedSessionId);
        if (!live) return false;
        if (!isIdleSessionRecord(live)) return 'busy';
        const why = failReason === 'empty_evidence'
            ? 'your previous answer had an empty evidence array'
            : failReason === 'missing_required_fields'
                ? 'your previous answer was missing required fields'
                : 'your previous answer did not parse as the required JSON';
        const message = `Your previous MAGI answer could not be accepted (${why}). Respond NOW with ONLY a single JSON object (no prose, no code fence) matching EXACTLY this schema, with non-empty evidence:\n\n${magiOutputContractFor(kind)}`;
        try {
            const coordinatorDaemonId = ctx.localDaemonId;
            await commandForNode(ctx, node, 'agent_command', {
                targetSessionId: task.assignedSessionId,
                providerType: task.assignedProviderType,
                cliType: task.assignedProviderType,
                agentType: task.assignedProviderType,
                action: 'send_chat',
                message,
                // DISPATCH-SOURCE-TRACE: call-site tag echoed in the worker daemon log.
                dispatchSource: 'mesh-tools-magi:sendKindRetry',
                meshContext: {
                    meshId: ctx.mesh.id,
                    nodeId: task.assignedNodeId,
                    taskId: task.id,
                    ...(coordinatorDaemonId ? { coordinatorDaemonId } : {}),
                    ...(ctx.coordinatorSessionId ? { coordinatorSessionId: ctx.coordinatorSessionId } : {}),
                },
            });
            try {
                await recordLocal(ctx.transport, { meshId: ctx.mesh.id,
                    kind: 'magi_replica_retry' as any,
                    payload: { taskId: task.id, kind, failReason },
                });
            } catch { /* ledger write is best-effort */ }
            return true;
        } catch { return false; }
    }

    /**
     * Recover a replica wedged on an approval modal. A MAGI replica is dispatched
     * readonly:true, so any command-approval prompt it raises (typically the git/read it
     * runs to gather file:line evidence) is safe to approve — and MUST be, because
     * dispatch-time auto-approve is not guaranteed (IDE providers with no resolveAction
     * script no-op it; remote pre-existing sessions never get the autoApprove backfill).
     * Left unresolved, the replica burns the whole collect deadline and is lost as
     * `replica_waiting_approval`. Only approves when the session is actually in an
     * approval state. Idempotent — resolve_action reports already_resolved/stale_prompt
     * within its cooldown, so re-calling on later poll ticks is a no-op. Fully
     * best-effort. Emits one ledger breadcrumb per approval attempt.
     */
    private async nudgeWedgedReplica(task: any): Promise<void> {
        const { ctx } = this;
        const node = this.findNode(task.assignedNodeId);
        if (!node || !task.assignedSessionId) return;
        try {
            // Replica hop (design §4 roster id 7) `magi_approval_probe`. Only `status` +
            // `activeModal` are read, and magiReadIndicatesApprovalWedge decides.
            // ★ Freshness is mandatory: a stale snapshot describes a modal that may already
            // be gone, and this consumer's next act is an approve CLICK. Any coverage is
            // accepted (even `tail`) because the two fields are session-level. resolve_action
            // below stays a live RPC — the replica decides only WHETHER to act.
            const payload = await readReplicaChat(ctx, node, task, {
                consumerId: 'magi_approval_probe',
                acceptCoverage: ['full', 'tail', 'current-turn'],
                readChat: { tailLimit: 1 },
            });
            if (!magiReadIndicatesApprovalWedge(payload)) return;
            const status = String(payload?.status ?? '');
            await commandForNode(ctx, node, 'resolve_action', {
                sessionId: task.assignedSessionId,
                targetSessionId: task.assignedSessionId,
                workspace: (node as any).workspace,
                providerType: task.assignedProviderType,
                agentType: task.assignedProviderType,
                cliType: task.assignedProviderType,
                action: 'approve',
            });
            try {
                await recordLocal(ctx.transport, { meshId: ctx.mesh.id,
                    kind: 'magi_replica_auto_approved' as any,
                    payload: { taskId: task.id, nodeId: task.assignedNodeId, status },
                });
            } catch { /* ledger write is best-effort */ }
        } catch { /* nudge is best-effort — fall through to the normal re-wait */ }
    }

    /**
     * A replica that is not a readable completion yet (failed/cancelled/running, or no
     * session bound).
     */
    private async resolveUnreadableReplica(task: any, source: MagiResponseSource, stale: { ids: Set<string>; reasons: Record<string, string> }, force: boolean): Promise<boolean> {
        const taskId = task.id;
        if (stale.ids.has(taskId)) {
            source.stale = true;
            return this.finalize(taskId, source, `stale: ${stale.reasons[taskId]}`);
        }
        if (MAGI_TERMINAL_STATUSES.has(String(task.status))) {
            return this.finalize(taskId, source, task.status === 'completed' ? 'no_session_to_read' : `replica_${task.status || 'incomplete'}`);
        }
        // Still running and not stale. A replica can WEDGE here forever on an approval
        // modal (see nudgeWedgedReplica) — so before re-waiting, detect a bound-session
        // approval wedge and drive resolve_action(approve) on it. Skipped under `force`
        // (the deadline pass just finalizes); once per replica per poll tick.
        if (task.assignedNodeId && task.assignedSessionId && !force) {
            await this.nudgeWedgedReplica(task);
        }
        if (force) return this.finalize(taskId, source, `replica_${task.status || 'incomplete'}`);
        return false;
    }

    /**
     * Read a `completed` replica's transcript and parse a MAGI answer for THIS kind.
     *
     * Replica hop (design §4 roster id 8) `magi_result_collect`. ★ ONLY current-turn
     * coverage is admitted — the FIX#1 guard restated: a whole-session tail's newest
     * kind-valid JSON can belong to an EARLIER turn and be mis-attributed as this
     * replica's answer, so a `tail`-covered replica snapshot declines to the live read
     * (which asks for coverage:'current-turn'). Freshness is required because this read
     * locks a terminal verdict.
     */
    private async parseCompletedReplica(task: any, source: MagiResponseSource): Promise<MagiKindParseResult> {
        const node = this.findNode(task.assignedNodeId);
        if (!node) throw new Error('assigned node not in mesh');
        const payload = await readReplicaChat(this.ctx, node, task, {
            consumerId: 'magi_result_collect',
            acceptCoverage: ['current-turn'],
            readChat: { tailLimit: 6, coverage: 'current-turn' },
        });
        // Capture the raw answer onto `source` now, so it rides along whether this
        // replica finalizes as a parseable answer or a weak/provisional one.
        captureRawAnswer(source, payload);
        // Fix-A-v2 summary-fallback (kind-aware): parse candidates from BOTH the raw payload
        // (newest bubble body first, premature-collect guard) AND the compacted payload
        // (surfaces the lifted `summary`), validating each against the selected kind's schema.
        return parseFirstMagiCandidateForKind(payload, this.kind, { sessionId: task.assignedSessionId });
    }

    /**
     * Attempt to FINALIZE one replica from its current state. Returns true once a final
     * verdict is locked. `force` (deadline reached / tasks gone) converts any remaining
     * re-wait (weak/unparseable/still-running) into a terminal verdict.
     */
    async tryResolveReplica(task: any, stale: { ids: Set<string>; reasons: Record<string, string> }, force: boolean, liveTasks: any[]): Promise<boolean> {
        const taskId = task.id;
        const source = this.buildSource(task);

        if (task.status !== 'completed' || !task.assignedNodeId || !task.assignedSessionId) {
            return this.resolveUnreadableReplica(task, source, stale, force);
        }

        // FIX#1: cross-wire guard. This completed replica's session is also bound to another
        // replica of THIS group → the newest turn cannot be safely attributed to either. Re-wait
        // so a later poll can find them on distinct sessions; at the deadline finalize as a
        // cross-wire error (not another replica's answer).
        if (sessionSharedWithAnotherReplica(task, liveTasks)) {
            return force ? this.finalize(taskId, source, 'cross_wired_shared_session') : false;
        }

        // Fix A: a completed-but-weak completion (early/mid-turn suppressed) or a
        // not-yet-parseable transcript is NOT terminal — re-poll until the deadline rather
        // than collecting a premature mid-turn bubble.
        let kindResult: MagiKindParseResult;
        try {
            kindResult = await this.parseCompletedReplica(task, source);
        } catch (e: any) {
            // A transient read failure re-waits (the node/peer may be momentarily busy);
            // finalize the failure only once the deadline is hit.
            return force ? this.finalize(taskId, source, `read_failed: ${e?.message || String(e)}`) : false;
        }

        if (kindResult.ok && kindResult.response) {
            const weak = await replicaCompletionIsWeak(this.ctx, taskId);
            if (weak && !force) {
                // Parseable but the completion evidence is weak — keep it as the deadline
                // fallback and re-wait for a stronger/fuller final answer.
                this.provisional.set(taskId, { source: { ...source, ok: true }, response: kindResult.response });
                return false;
            }
            this.finalized.set(taskId, { source: { ...source, ok: true }, response: kindResult.response });
            return true;
        }

        // Parsed something but it FAILS the kind schema (missing fields / empty evidence) →
        // E: fire exactly one delta re-request, then re-wait for the corrected answer. A
        // second failure (already retried) drops to unparseable below.
        const isSchemaFailure = kindResult.failReason === 'missing_required_fields'
            || kindResult.failReason === 'empty_evidence';
        if (isSchemaFailure && !this.retried.has(taskId) && !force) {
            this.retried.add(taskId);
            const sent = await this.sendKindRetry(task, kindResult.failReason);
            if (sent === 'busy') {
                // Session not settled yet — keep the one retry for a later pass and re-wait.
                this.retried.delete(taskId);
                return false;
            }
            if (sent) return false; // re-wait for the corrected turn
            // Could not dispatch the retry → fall through to the unparseable handling.
        }

        // Not parseable / still schema-invalid → the premature-collect guard: re-wait until
        // the deadline, then finalize (preferring any provisional answer).
        if (!force) return false;
        const prov = this.provisional.get(taskId);
        if (prov) {
            this.finalized.set(taskId, prov);
            return true;
        }
        // MAGI-DEADLINE-MISLABEL: "no valid JSON was EVER seen across every poll up to the
        // deadline" is indistinguishable, from here, from "the replica simply hadn't
        // finished answering yet" (a live fan-out measured a replica answering with a fully
        // evidenced JSON 13 minutes after being labeled unparseable). So it is reported as
        // `replica_deadline_exceeded`. `schema_invalid:*` DID observe real content that
        // fails the kind schema after one retry — a genuine content defect.
        return this.finalize(taskId, source, isSchemaFailure ? `schema_invalid: ${kindResult.failReason}` : 'replica_deadline_exceeded');
    }
}

async function readReplicaTasks(ctx: MeshContext, ids: Set<string>) {
    const tasks = annotateQueueStaleness((await readQueueFromDaemon(ctx)).filter((t: any) => ids.has(t.id)), ctx.mesh);
    const { staleTaskIds, staleReasons } = classifyStaleReplicas(tasks, MAGI_TERMINAL_STATUSES);
    return { tasks: tasks as any[], stale: { ids: staleTaskIds, reasons: staleReasons } };
}

export async function collectMagiResponses(
    ctx: MeshContext,
    args: { replicaTaskIds: string[]; timeoutMs: number; taskKind?: MagiTaskKind },
): Promise<{ responses: MagiSynthesizedResponse[]; terminal: boolean; timedOut: boolean; staleCount: number; retriedCount: number }> {
    const ids = new Set(args.replicaTaskIds);
    const deadline = Date.now() + args.timeoutMs;
    const collector = new MagiReplicaCollector(ctx, args.taskKind ?? DEFAULT_TASK_KIND);
    const { finalized } = collector;

    // Poll until every replica reaches a final verdict, every still-outstanding replica is
    // detected STALE (dead assignment), or the deadline elapses.
    for (;;) {
        const { tasks, stale } = await readReplicaTasks(ctx, ids);
        const allPresent = tasks.length === ids.size;
        const pastDeadline = Date.now() >= deadline;

        for (const task of tasks) {
            if (finalized.has(task.id)) continue;
            await collector.tryResolveReplica(task, stale, pastDeadline, tasks);
        }

        if (allPresent && finalized.size >= ids.size) break;
        if (pastDeadline) break;
        // Every still-outstanding replica is stale → stop early (they were just finalized above).
        const outstanding = tasks.filter((t: any) => !finalized.has(t.id));
        if (allPresent && outstanding.length > 0 && outstanding.every((t: any) => stale.ids.has(t.id))) break;

        await sleep(Math.min(MAGI_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }

    // Final pass: force-finalize anything still outstanding now that the loop has ended.
    const { tasks: finalTasks, stale } = await readReplicaTasks(ctx, ids);
    const presentIds = new Set(finalTasks.map((t: any) => t.id));
    for (const task of finalTasks) {
        if (!finalized.has(task.id)) await collector.tryResolveReplica(task, stale, true, finalTasks);
    }
    // A replica whose queue row vanished entirely (never observed) is recorded as missing.
    for (const id of ids) {
        if (finalized.has(id)) continue;
        if (!presentIds.has(id)) {
            finalized.set(id, { source: { taskId: id, ok: false, error: 'replica_missing' }, response: emptyResponse() });
        }
    }

    // Preserve the caller's replica order.
    const responses = args.replicaTaskIds
        .map(id => finalized.get(id))
        .filter((r): r is MagiSynthesizedResponse => !!r);
    const terminal = presentIds.size === ids.size && finalTasks.every((t: any) => MAGI_TERMINAL_STATUSES.has(String(t.status)));
    const staleCount = responses.filter(r => r.source.stale === true).length;
    return { responses, terminal, timedOut: !terminal, staleCount, retriedCount: collector.retried.size };
}
