/**
 * Direct-dispatch completion reconciliation from transcript evidence —
 * design §4 roster id 6 (`mcp_mesh_status_reconciliation`), §8 unit 8.
 *
 * Wiring-unification Phase C, workstream C-W6
 * (docs/design/2026-09-23-wiring-unification.md §5 C2 "MCP server" paragraph).
 *
 * MIGRATED OFF THE IN-PROCESS TERMINAL WRITE (2026-09-23): this file used to
 * call `reconcileDirectDispatchCompletionFromTranscript` — a function that
 * wrote a terminal ledger entry directly from inside the MCP process. C2
 * names this exact file as the clearest boundary violation to close first:
 * "the MCP process reads the transcript, applies the veto, then writes a
 * terminal directly." It now calls `turnObserve()` over IPC instead (this
 * package's `ipc/turn-commands.ts`, C-W6 pre-work) with a `transcript_final`
 * evidence record — the daemon that owns the turn ledger decides whether that
 * evidence commits a terminal, exactly like every other evidence producer.
 * mcp-server no longer writes to `mesh-runtime.db`/the turn ledger itself for
 * this consumer.
 *
 * `reconcileDirectDispatchCompletionFromTranscript` and
 * `isDirectDispatchLedgerEntry` are also gone from `@adhdev/daemon-core`
 * entirely as of this session — deleted by the concurrent C-W4 workstream
 * (`mesh-dispatch-ledger-reads.ts`'s header: "deleted in wiring-unification
 * C4 (C-W4)"). `buildDirectDispatchReconciliationCandidates` below therefore
 * no longer reads ledger entries by kind to build candidates (the ledger-entry
 * half of `isDirectDispatchLedgerEntry`'s filter) — it derives candidates
 * from the live `directDispatches` rows only, which is what every call site
 * already reads independently. REQUESTED EDIT to whoever owns the C3/C-W2
 * `turn_attempts` read path: once `turnQuery`/`meshIndexQuery` can list open
 * direct-scope attempts, restore the ledger-derived half of this candidate
 * list from there instead of dropping it.
 *
 * ── What this consumer decides, and why its admission gate is strict ────────
 * It synthesizes a task COMPLETION from the transcript: an irreversible write
 * (now performed by the daemon's turn-ledger reducer via `turnObserve`, not
 * by this process). The replica hop below therefore refuses tail-only
 * coverage (the trailing-activity veto needs the bubbles that FOLLOW the
 * final assistant message) and requires a snapshot inside the freshness
 * budget (design §5.5). On any decline it falls through to the pre-existing
 * live `read_chat`, and BOTH sources feed the identical downstream parsers —
 * see `mesh-transcript-semantic-read.ts`'s header.
 */

// NOTE (REQUESTED EDIT — see file header): `extractFinalAssistantSummaryEvidence`
// is not yet in @adhdev/daemon-core's named export list (only its sibling
// `hasTrailingToolActivityAfterFinalAssistant` is). This import is written
// against where it belongs once that gap is closed; until then it fails to
// resolve at build/typecheck, exactly like the pre-existing (unrelated)
// daemon-core breakage this session found in mesh-tools-{session,status}.ts
// (both mesh-events-pending.js and mesh-terminal-redrive.js are missing
// their own importers' targets right now — see report).
import { extractFinalAssistantSummaryEvidence, hasTrailingToolActivityAfterFinalAssistant } from '@adhdev/daemon-core';
import { turnObserve, TurnIpcCommandError } from '../ipc/turn-commands.js';
import type { TurnEvidence } from '@adhdev/mesh-shared';
import { readString } from './mesh-tool-shared.js';
import { readTranscriptReplicaForSemanticConsumer } from './mesh-transcript-semantic-read.js';
import type { MeshContext } from './mesh-tools-internal.js';
import {
    commandForNode,
    findNodeSession,
    findOptionalNodeWithRefresh,
    isIdleSessionRecord,
    resolveMeshSessionProviderMetadata,
    resolveSemanticReplicaTransport,
    resolveSessionProviderType,
    unwrapCommandPayload,
} from './mesh-tools-internal.js';

export function buildDirectDispatchReconciliationCandidates(directDispatches: any[], _ledgerEntries: any[]): any[] {
    // `_ledgerEntries` kept in the signature — every call site passes it, and
    // dropping the parameter would ripple an edit into mesh-tools-status.ts /
    // mesh-tools-session.ts / mesh-tools-queue.ts (out of this file's swap).
    // See file header: the ledger-derived half of this candidate list is a
    // REQUESTED EDIT once turnQuery/meshIndexQuery can list open attempts.
    const candidates: any[] = [];
    const seenTaskIds = new Set<string>();
    for (const dispatch of directDispatches || []) {
        const taskId = readString(dispatch?.taskId);
        if (!taskId || seenTaskIds.has(taskId)) continue;
        seenTaskIds.add(taskId);
        candidates.push(dispatch);
    }
    return candidates;
}

export async function reconcileDirectDispatchesFromTranscriptEvidence(
    ctx: MeshContext,
    liveNodes: any[],
    directDispatches: any[],
    ledgerEntries: any[],
): Promise<{ attempted: number; reconciled: number; skipped: number }> {
    let attempted = 0;
    let reconciled = 0;
    let skipped = 0;
    const candidates = buildDirectDispatchReconciliationCandidates(directDispatches, ledgerEntries);
    for (const dispatch of candidates) {
        const taskId = readString(dispatch?.taskId);
        const nodeId = readString(dispatch?.nodeId);
        const sessionId = readString(dispatch?.sessionId);
        if (!taskId || !nodeId || !sessionId) {
            skipped += 1;
            continue;
        }
        const { session } = findNodeSession(liveNodes, nodeId, sessionId);
        // EARLYNOTIFY-GATEBYPASS (e): a single snapshot-idle sample is NOT sufficient to synthesize
        // a completion — a mid-turn poll routinely reads idle for an instant. This idle check only
        // makes the session ELIGIBLE for a transcript read; the actual turn-finality gate is
        // enforced downstream: extractFinalAssistantSummaryEvidence requires a genuine non-empty
        // latest-assistant turn end, and the daemon's turn-ledger reducer (reached via
        // turnObserve, not an in-process write) applies its own admission/grace rules before
        // it will commit a terminal. So a coordinator poll cannot force a mid-turn synth.
        if (!session || !isIdleSessionRecord(session)) {
            skipped += 1;
            continue;
        }
        const node = await findOptionalNodeWithRefresh(ctx, nodeId).catch(() => null);
        if (!node) {
            skipped += 1;
            continue;
        }
        const providerType = readString(dispatch?.providerType) || resolveSessionProviderType(session);
        const providerSessionId = readString(session?.providerSessionId)
            || readString(session?.activeChat?.providerSessionId)
            || readString(session?.settings?.providerSessionId)
            || (await resolveMeshSessionProviderMetadata(ctx, nodeId, sessionId))?.providerSessionId;
        attempted += 1;
        try {
            // ── §8 unit 8: replica hop (design §4 roster id 6) ──────────────
            // `mcp_mesh_status_reconciliation`. The replica returns the SAME
            // read_chat-shaped payload, so every guard below — the trailing-
            // activity veto, extractFinalAssistantSummaryEvidence, and the
            // daemon-side turn-ledger admission gate reached through
            // turnObserve — runs unchanged on either source. That is the
            // design's "기존 evidence parser를 그대로 적용" requirement, and
            // it is why this is a source swap rather than a second synthesis
            // path.
            //
            // Coverage: `tail` is refused. The veto needs the tool/activity
            // bubbles that FOLLOW the final assistant message; a tail window
            // that clipped them would silently turn a mid-turn narration into a
            // synthesized completion — the exact MID-TURN-CAUSAL-ADMISSION
            // regression the veto exists to prevent. Freshness is required
            // because synthesizing a completion writes a terminal (§5.5:
            // irreversible judgements never read a stale snapshot).
            const replicaTransport = resolveSemanticReplicaTransport(ctx, node);
            let payload: any = null;
            if (replicaTransport) {
                const replica = await readTranscriptReplicaForSemanticConsumer(replicaTransport, {
                    consumerId: 'mcp_mesh_status_reconciliation',
                    ownerDaemonId: node.daemonId!,
                    rawSessionId: sessionId,
                    acceptCoverage: ['full', 'current-turn'],
                    requireFresh: true,
                });
                if (replica.payload) payload = replica.payload;
            }
            if (!payload) {
                const readResult = await commandForNode(ctx, node, 'read_chat', {
                    sessionId,
                    targetSessionId: sessionId,
                    workspace: node.workspace,
                    ...(providerType ? { agentType: providerType, providerType } : {}),
                    ...(providerSessionId ? { providerSessionId } : {}),
                    tailLimit: 10,
                });
                payload = unwrapCommandPayload(readResult);
            }
            if (payload?.success === false) continue;
            // MID-TURN-CAUSAL-ADMISSION (rc.16): the latest final-LOOKING assistant bubble
            // followed by trailing tool/terminal activity is interim narration, not a turn
            // end — a single coordinator poll must never promote it to a completion. This is
            // the same veto the reconcile loop's PHASE 4 and the watchdog poll enforce; the
            // MCP process has no live adapter to probe (remote semantics), so the bounded
            // transcript evidence below remains the operative net (fail-open preserved).
            const messages = Array.isArray(payload?.messages) ? payload.messages : [];
            const trailingToolActivity = hasTrailingToolActivityAfterFinalAssistant(messages);
            if (trailingToolActivity) continue;
            // REQUESTED EDIT for whoever owns daemon-core/src/index.ts next (not this
            // workstream's file — see file header): `extractFinalAssistantSummaryEvidence`
            // (providers/chat-message-normalization.ts, the renamed
            // `readFinalAssistantTranscriptEvidence`) is not yet in the package's named
            // export list, only its sibling `hasTrailingToolActivityAfterFinalAssistant` is.
            // Until it is exported, this call fails to resolve — a REQUESTED EDIT, not a
            // silent behavior change: add `extractFinalAssistantSummaryEvidence` next to
            // `hasTrailingToolActivityAfterFinalAssistant` in index.ts's
            // chat-message-normalization.js re-export block.
            const evidence = extractFinalAssistantSummaryEvidence(messages);
            if (!evidence.finalSummary) continue;
            // The daemon's turn ledger is the sole authority for whether this evidence
            // commits a terminal (design §5 C2) — this process no longer writes the
            // legacy event ledger table or turn_attempts itself. `finalSummary` is
            // content and never crosses this call: only its non-empty-ness (a boolean
            // fact) and the
            // structural `messageAt` timestamp travel, matching turn-evidence.ts's
            // content-free field classes for `transcript_final`.
            // Stable per transcript turn end: a repeated mesh_status poll over the
            // SAME final message re-sends the SAME eventId, which the daemon's
            // ledger collapses on its primary key (verdict `duplicate`) instead
            // of recording one evidence row per poll.
            const messageAtMs = evidence.transcriptMessageAt ? Date.parse(evidence.transcriptMessageAt) : NaN;
            const turnEvidence: TurnEvidence = {
                eventId: `mcp-reconcile:${taskId}:${sessionId}:${Number.isFinite(messageAtMs) ? messageAtMs : 'nomsg'}`,
                at: Date.now(),
                source: 'mcp_probe',
                sessionId,
                taskId,
                observedBy: ctx.localDaemonId || 'unknown-daemon',
                kind: 'transcript_final',
                selfAttributing: false,
                nativeRead: false,
                live: {
                    modal: false,
                    adapterPending: false,
                    trailingTool: trailingToolActivity,
                },
                ...(Number.isFinite(messageAtMs) ? { messageAt: messageAtMs } : {}),
            };
            try {
                const observed = await turnObserve(ctx.transport, { evidence: turnEvidence });
                if (observed.verdict === 'applied' && observed.outcome === 'completed') reconciled += 1;
            } catch (err) {
                // daemon_required / turn_ledger_unavailable / decode failure — this
                // reconciliation pass is advisory (the pre-existing live read_chat /
                // watchdog paths remain the primary completion route), so a failed
                // turnObserve degrades to "skipped", not a thrown error out of this loop.
                if (err instanceof TurnIpcCommandError) {
                    skipped += 1;
                    continue;
                }
                throw err;
            }
        } catch {
            skipped += 1;
        }
    }
    return { attempted, reconciled, skipped };
}
