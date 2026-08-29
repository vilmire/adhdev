/**
 * WORKER-MCP LOW family — decision D (`peer_context_pull`), the daemon side.
 *
 * Design SoT: docs/design/2026-08-28-worker-mcp.md §6 (decision D).
 *
 * ─── Two sources, and why neither is a new store ──────────────────────────
 *
 * `peer_context_pull` is a curated, read-only lookup of what sibling tasks in
 * this mesh are doing or have left behind. Design §6 names the reused APIs
 * explicitly ("신규 저장소 0") and this handler follows that:
 *
 *  - `readProjectedEntriesByKind` (mesh/mesh-read-model-consumers.ts) — the
 *    mesh's own lifecycle facts: which task went to which status, on which
 *    node, when. This is the roster's own routing point (read-model when
 *    ready, ledger fallback otherwise — design §6's "read model이 미준비면 원장
 *    폴백이 성립한다"), so this handler behaves the same on a daemon whose
 *    seqscribe replica is not wired at all as on one where it is. Both paths
 *    are METADATA CLASS (mesh-event-projection.ts's allow-list, or the
 *    fallback's own scalar-only payload filter) — no free text travels
 *    through here, so nothing here can leak a transcript even by accident.
 *    ★Deliberately NOT `queryMeshReadModel` directly — that module's own
 *    header restricts direct callers to its enumerated roster file.
 *  - `getStoredHandoffNote` (mesh/worker-handoff-notes.ts) — the C-authored
 *    prose (intent, conflict guidance, follow-ups) for a sibling task, when
 *    THIS daemon holds it. A sibling whose report landed on a different
 *    daemon shows only its read-model facts, degrading gracefully rather than
 *    failing — matching the note store's own documented behavior for C.
 *
 * ─── Scope enforcement ─────────────────────────────────────────────────────
 *
 * The caller never supplies a mesh id or node id — the token/bind resolves
 * `identity.meshId`, and the query is scoped to that mesh only (§6: "토큰이
 * 지정하는 범위 밖은 반환하지 않는다"). The caller's OWN task is always excluded —
 * a worker does not need `peer_context_pull` to learn about itself.
 */
import type { LowFamilyContext, LowFamilyHandler } from './types.js';
import type { MeshLedgerKind } from '../../mesh/mesh-ledger.js';

/** Read-model event kinds that carry sibling lifecycle signal worth surfacing. */
const PEER_EVENT_KINDS: MeshLedgerKind[] = [
    'task_dispatched',
    'task_completed',
    'task_failed',
    'task_stalled',
    'session_launched',
    'session_stopped',
];

/** Bounded like the handoff-note enclosure (design §5's budget discipline) — a
 *  worker asking "what are my siblings doing" gets the most recent slice, with
 *  an announced omission count rather than a silently truncated list. */
export const PEER_CONTEXT_MAX_PEERS = 10;
/** How far back the read-model query looks for lifecycle events at all. */
const PEER_CONTEXT_EVENT_TAIL = 300;

export const workerPeerContextHandlers: Record<string, LowFamilyHandler> = {
    worker_peer_context_pull: async (_ctx: LowFamilyContext, args: any) => {
        try {
            const { resolveWorkerIdentity } = await import('../../mesh/worker-report.js');
            const identity = resolveWorkerIdentity({ token: args?.token, bind: args?.bind });
            if (!identity) {
                return {
                    success: false,
                    error: 'unauthenticated',
                    hint: 'No live task is bound to this worker session.',
                };
            }

            const scope = args?.scope === 'same_mission' ? 'same_mission' : 'mesh';
            const topicFilter = typeof args?.topic === 'string' && args.topic.trim()
                ? args.topic.trim().toLowerCase()
                : undefined;

            const { readProjectedEntriesByKind } = await import('../../mesh/mesh-read-model-consumers.js');
            const { getStoredHandoffNote } = await import('../../mesh/worker-handoff-notes.js');
            const { MeshRuntimeStore } = await import('../../mesh/mesh-runtime-store.js');

            let ownMissionId: string | undefined;
            if (scope === 'same_mission') {
                try {
                    ownMissionId = MeshRuntimeStore.getInstance()
                        .findQueueEntryById(identity.meshId, identity.taskId)?.missionId;
                } catch { /* fall through — an unresolvable own-mission degrades to no filter match */ }
            }

            const events = readProjectedEntriesByKind(identity.meshId, PEER_EVENT_KINDS, PEER_CONTEXT_EVENT_TAIL);

            // Latest event per sibling task, own task excluded. Iterating in the
            // read model's ascending order and overwriting means the LAST write
            // per taskId wins — i.e. the most recent status.
            const latestByTask = new Map<string, (typeof events)[number]>();
            for (const event of events) {
                if (!event.taskId || event.taskId === identity.taskId) continue;
                latestByTask.set(event.taskId, event);
            }

            type Peer = {
                taskId: string;
                nodeId?: string;
                status: string;
                lastUpdatedAt: string;
                handoffNote?: {
                    intent: string;
                    conflictGuidance?: string;
                    touchedFiles: string[];
                    followUps?: string[];
                };
            };

            let candidates: Peer[] = [];
            for (const [taskId, event] of latestByTask) {
                if (scope === 'same_mission') {
                    if (!ownMissionId) continue;
                    let taskMissionId: string | undefined;
                    try {
                        taskMissionId = MeshRuntimeStore.getInstance().findQueueEntryById(identity.meshId, taskId)?.missionId;
                    } catch { /* unresolvable — excluded from a mission-scoped pull */ }
                    if (taskMissionId !== ownMissionId) continue;
                }

                const note = getStoredHandoffNote(identity.meshId, taskId);
                const peer: Peer = {
                    taskId,
                    ...(event.nodeId ? { nodeId: event.nodeId } : {}),
                    status: (event.payload?.status as string | undefined)
                        ?? (event.payload?.outcome as string | undefined)
                        ?? event.kind,
                    lastUpdatedAt: event.timestamp,
                    ...(note ? {
                        handoffNote: {
                            intent: note.notes.intent,
                            ...(note.notes.conflictGuidance ? { conflictGuidance: note.notes.conflictGuidance } : {}),
                            touchedFiles: note.notes.touchedFiles,
                            ...(note.notes.followUps?.length ? { followUps: note.notes.followUps } : {}),
                        },
                    } : {}),
                };

                if (topicFilter) {
                    const haystack = [
                        peer.handoffNote?.intent,
                        peer.handoffNote?.conflictGuidance,
                        ...(peer.handoffNote?.touchedFiles || []),
                    ].filter(Boolean).join(' ').toLowerCase();
                    if (!haystack.includes(topicFilter)) continue;
                }

                candidates.push(peer);
            }

            // Newest first, then bound with an announced omission — never a
            // silent truncation (gate checklist ②'s principle, same as §5).
            candidates.sort((a, b) => (a.lastUpdatedAt < b.lastUpdatedAt ? 1 : a.lastUpdatedAt > b.lastUpdatedAt ? -1 : 0));
            const omitted = Math.max(0, candidates.length - PEER_CONTEXT_MAX_PEERS);
            const peers = candidates.slice(0, PEER_CONTEXT_MAX_PEERS);

            return {
                success: true,
                meshId: identity.meshId,
                scope,
                peers,
                ...(omitted > 0 ? { omitted } : {}),
            };
        } catch (e: any) {
            return { success: false, error: e?.message || String(e) };
        }
    },
};
