/** Project task/session joins over the existing held view. Never reads a remote daemon. */
import { canonicalDaemonId, daemonIdsEquivalent, sessionIdsEquivalent } from '@adhdev/mesh-shared';
import type { SessionRow } from './project-views.js';

type RecordValue = Record<string, any>;
const rec = (v: unknown): RecordValue => v && typeof v === 'object' && !Array.isArray(v) ? v as RecordValue : {};
const list = (v: unknown): RecordValue[] => Array.isArray(v) ? v.map(rec) : [];
const text = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const choice = <T extends string>(v: unknown, values: readonly T[], fallback: T): T => values.includes(v as T) ? v as T : fallback;
export const sessionProvider = (v: unknown): string => /^[a-z][a-z0-9_-]{0,63}$/.test(text(v)) ? text(v) : 'unknown';
const statuses = ['idle', 'generating', 'working', 'running', 'waiting_approval', 'waiting_choice', 'awaiting_approval', 'starting', 'initializing', 'stopping', 'stopped', 'exited', 'terminated', 'completed', 'failed', 'error', 'disconnected', 'unknown'] as const;
export const sessionStatus = (v: unknown): string => choice(v, statuses, 'unknown');
const freshnesses = ['fresh', 'stale', 'unreachable', 'not_observed', 'unknown'] as const;
export interface ProjectSessionEvidence {
    taskId: string | null;
    attemptId: string | null;
    ownerDaemonId: string;
    source: 'local' | 'member_push' | 'coordinator_probe' | 'none';
    freshness: typeof freshnesses[number];
    observedAt: number | null;
    lastActivityAt: number | null;
    lastActivitySource: 'session_record' | 'last_message' | 'unknown';
    /** No reliable per-session rate/auth classifier exists on these summaries. */
    sessionError: 'unknown';
    observedStatus: string;
}
export interface ProjectSessionCoverage {
    nodeId: string;
    ownerDaemonId: string | null;
    source: ProjectSessionEvidence['source'];
    freshness: ProjectSessionEvidence['freshness'];
    observedAt: number | null;
    coverage: 'observed' | 'partial' | 'not_observed' | 'unknown';
    handshakePending: boolean;
}

/** Used at BOTH follower boundaries. Unknown/new prose never becomes an enum. */
export function sessionEvidence(raw: unknown): ProjectSessionEvidence | undefined {
    const r = rec(raw);
    if (!text(r.ownerDaemonId)) return undefined;
    return {
        taskId: text(r.taskId) || null, attemptId: text(r.attemptId) || null, ownerDaemonId: text(r.ownerDaemonId),
        source: choice(r.source, ['local', 'member_push', 'coordinator_probe', 'none'], 'none'),
        freshness: choice(r.freshness, freshnesses, 'unknown'), observedAt: num(r.observedAt),
        lastActivityAt: num(r.lastActivityAt),
        lastActivitySource: choice(r.lastActivitySource, ['session_record', 'last_message', 'unknown'], 'unknown'),
        sessionError: 'unknown', observedStatus: sessionStatus(r.observedStatus),
    };
}
export function sessionCoverage(raw: unknown): ProjectSessionCoverage[] {
    return list(raw).filter(r => text(r.nodeId)).map(r => ({
        nodeId: text(r.nodeId), ownerDaemonId: text(r.ownerDaemonId) || null,
        source: choice(r.source, ['local', 'member_push', 'coordinator_probe', 'none'], 'none'),
        freshness: choice(r.freshness, freshnesses, 'unknown'), observedAt: num(r.observedAt),
        coverage: choice(r.coverage, ['observed', 'partial', 'not_observed', 'unknown'], 'unknown'),
        handshakePending: r.handshakePending === true,
    }));
}
const quotaFailures = ['missing-credentials', 'expired-token', 'unauthorized', 'quota-exhausted', 'rate-limited', 'network', 'server', 'parse', 'cli-unavailable', 'unsupported', 'setup-required', 'no-data', 'unknown'] as const;
export interface ProjectNodeProviderQuota {
    nodeId: string;
    ownerDaemonId: string | null;
    provider: string;
    scope: 'node_provider';
    status: 'ok' | 'error' | 'unavailable' | 'unknown';
    failureKind: typeof quotaFailures[number];
    updatedAt: number | null;
}
export function nodeProviderQuota(raw: unknown): ProjectNodeProviderQuota[] {
    return list(raw).filter(r => text(r.nodeId)).map(r => ({
        nodeId: text(r.nodeId), ownerDaemonId: text(r.ownerDaemonId) || null,
        provider: sessionProvider(r.provider), scope: 'node_provider',
        status: choice(r.status, ['ok', 'error', 'unavailable', 'unknown'], 'unknown'),
        failureKind: choice(r.failureKind, quotaFailures, 'unknown'), updatedAt: num(r.updatedAt),
    }));
}
function activity(v: unknown): number | null {
    if (typeof v === 'number') return num(v);
    const t = typeof v === 'string' ? Date.parse(v) : NaN;
    return Number.isFinite(t) && t >= 0 ? t : null;
}

export function projectSessionView(view: RecordValue, opts: {
    meshId: string; selfDaemonId: string; localStates?: readonly unknown[]; now?: number;
    members?: readonly unknown[]; coordinatorSessionIds?: readonly string[];
}): { sessions: SessionRow[]; sessionCoverage: ProjectSessionCoverage[]; nodeProviderQuota: ProjectNodeProviderQuota[] } {
    const now = opts.now ?? Date.now();
    const reportedMembers = list(rec(rec(view.membership).mesh).nodes);
    const members = reportedMembers.length ? reportedMembers : list(opts.members);
    const nodes = list(rec(view.status).nodes);
    const activeWork = rec(rec(view.activeWork).activeWork);
    const bindingsObserved = rec(view.activeWork).success === true && Array.isArray(activeWork.activeWork)
        && (!view.meshId || view.meshId === opts.meshId);
    const tasks = bindingsObserved ? list(activeWork.activeWork) : [];
    const bindingsPartial = (num(rec(activeWork.summary).totalActiveCount) ?? 0) > tasks.length;
    const sessions: SessionRow[] = [];
    const coverage: ProjectSessionCoverage[] = [];
    const quota: RecordValue[] = [];
    for (const member of members) {
        const nodeId = text(member.id) || text(member.nodeId);
        if (!nodeId) continue;
        const node = nodes.find(n => (text(n.nodeId) || text(n.id)) === nodeId) ?? {};
        const route = rec(rec(view.routes)[nodeId]);
        const owner = text(route.ownerDaemonId) || text(node.daemonId) || text(member.daemonId)
            || (route.route === 'local' ? opts.selfDaemonId : '');
        const ownershipConsistent = [node.daemonId, member.daemonId, route.ownerDaemonId]
            .map(text).filter(Boolean).every(id => daemonIdsEquivalent(id, owner));
        const local = ownershipConsistent && !!owner && daemonIdsEquivalent(owner, opts.selfDaemonId);
        const held = rec(node.heldRuntime);
        const ownerMatches = ownershipConsistent && !!owner && !!text(held.daemonId) && daemonIdsEquivalent(owner, text(held.daemonId));
        const source: ProjectSessionEvidence['source'] = local ? 'local'
            : ownerMatches ? choice(held.source, ['member_push', 'coordinator_probe', 'none'], 'none') : 'none';
        const observedAt = local && opts.localStates ? now : ownerMatches ? num(held.observedAt) : null;
        const offline = !local && (route.route === 'unreachable' || ['disconnected', 'closed', 'offline', 'unreachable'].includes(text(rec(node.connection).state)));
        const freshness: ProjectSessionEvidence['freshness'] = offline ? 'unreachable' : local
            ? opts.localStates ? 'fresh' : 'unknown'
            : !ownerMatches || source === 'none' || observedAt === null ? 'not_observed'
            : held.handshakePending === true ? 'stale' : choice(held.freshness, freshnesses, 'unknown');
        coverage.push({ nodeId, ownerDaemonId: owner || null, source, freshness, observedAt,
            coverage: source === 'none' ? 'not_observed' : !bindingsObserved ? 'unknown'
                : held.sessionsTruncated === true || bindingsPartial ? 'partial'
                : freshness === 'fresh' ? 'observed' : 'unknown', handshakePending: held.handshakePending === true });
        // Quota remains a node/provider fact. Never map collector errors to a session error.
        if (local || ownerMatches) for (const [key, value] of Object.entries(rec(rec(node.nodeFacts).quota))) {
            const q = rec(value);
            quota.push({
                nodeId, ownerDaemonId: owner, provider: q.provider ?? key, status: q.status,
                failureKind: rec(q.metadata).failureKind, updatedAt: q.updatedAt,
            });
        }
        for (const task of tasks.filter(t => text(t.nodeId) === nodeId && text(t.taskId) && text(t.sessionId))) {
            const sid = text(task.sessionId);
            if (!owner || !ownershipConsistent || (text(task.ownerDaemonId) && !daemonIdsEquivalent(owner, text(task.ownerDaemonId)))) continue;
            const localState = local ? (opts.localStates ?? []).map(rec).find(s => sessionIdsEquivalent(text(s.instanceId), sid)
                && text(rec(s.settings).meshNodeFor) === opts.meshId && daemonIdsEquivalent(text(rec(s.settings).meshNodeId), nodeId)
                && rec(s.settings).assistant !== true) : undefined;
            // held.sessions is daemon-wide: require explicit project AND node stamps.
            const remoteState = !local && ownerMatches ? list(held.sessions).find(s => sessionIdsEquivalent(text(s.id), sid)
                && text(rec(s.settings).meshNodeFor) === opts.meshId && daemonIdsEquivalent(text(rec(s.settings).meshNodeId), nodeId)) : undefined;
            const detail = list(node.activeSessionDetails).find(s => sessionIdsEquivalent(text(s.sessionId), sid));
            // The node details are already node-scoped by mesh_status; only use on matching daemon.
            const state = localState ? detail ?? localState : remoteState ? detail ?? remoteState : undefined;
            const attemptId = text(task.attemptId) || null;
            const stateAttempts = [state?.attemptId, rec(state?.turn).attemptId,
                rec(remoteState?.turn).attemptId, rec(localState?.turn).attemptId].map(text).filter(Boolean);
            const attemptMatches = !!attemptId && stateAttempts.length > 0 && stateAttempts.every(id => id === attemptId);
            const effectiveFreshness = !attemptMatches ? 'unknown' : freshness;
            const activityValue = local ? state?.lastActivityAt ?? state?.lastMessageAt
                : remoteState?.lastMessageAt ?? state?.lastActivityAt;
            const lastActivityAt = state && attemptMatches ? activity(activityValue) : null;
            const lastActivitySource: ProjectSessionEvidence['lastActivitySource'] = lastActivityAt === null ? 'unknown'
                : local ? state?.lastActivityAt !== undefined ? 'session_record' : 'last_message'
                : remoteState?.lastMessageAt !== undefined ? 'last_message' : 'session_record';
            const observedStatus = state && attemptMatches ? sessionStatus(rec(state.activeChat).status ?? state.chatStatus ?? state.status ?? state.state) : 'unknown';
            const evidence: ProjectSessionEvidence = { taskId: text(task.taskId), attemptId, ownerDaemonId: owner,
                source, freshness: state ? effectiveFreshness : freshness === 'fresh' ? 'not_observed' : freshness,
                observedAt, lastActivityAt, lastActivitySource, sessionError: 'unknown', observedStatus };
            const row: SessionRow = {
                sessionId: sid, provider: sessionProvider(state?.providerType ?? state?.type ?? task.providerType),
                status: state && attemptMatches && freshness === 'fresh'
                    ? observedStatus : 'unknown',
                meshId: opts.meshId, nodeId, ageMs: null, messageCount: localState && Array.isArray(rec(localState.activeChat).messages) ? rec(localState.activeChat).messages.length : 0,
                workspace: null, isCoordinator: false, assistant: false, spawnedForTaskId: text(task.taskId), launchedBy: null, evidence,
            };
            // A daemon session shared by node aliases is one session. Distinct machines may reuse ids.
            const prior = sessions.findIndex(s => canonicalDaemonId(s.evidence!.ownerDaemonId) === canonicalDaemonId(owner) && sessionIdsEquivalent(s.sessionId, sid));
            if (prior < 0) sessions.push(row);
            else if (JSON.stringify(sessions[prior]!.evidence) !== JSON.stringify(evidence)) {
                sessions[prior]!.status = 'unknown'; sessions[prior]!.evidence!.freshness = 'unknown';
            }
        }
    }
    // Coordinators have explicit project registration rather than a worker task.
    for (const raw of opts.localStates ?? []) {
        const state = rec(raw), settings = rec(state.settings);
        const sid = text(state.instanceId);
        if (settings.meshCoordinatorFor !== opts.meshId || settings.assistant === true
            || !opts.coordinatorSessionIds?.some(id => sessionIdsEquivalent(id, sid))) continue;
        const observedStatus = sessionStatus(state.status);
        sessions.push({
            sessionId: sid, provider: sessionProvider(state.type), status: observedStatus,
            meshId: opts.meshId, nodeId: text(settings.meshNodeId) || null,
            ageMs: null, messageCount: Array.isArray(rec(state.activeChat).messages) ? rec(state.activeChat).messages.length : 0,
            workspace: null, isCoordinator: true, assistant: false, spawnedForTaskId: null, launchedBy: null,
            evidence: { taskId: null, attemptId: null, ownerDaemonId: opts.selfDaemonId, source: 'local',
                freshness: 'fresh', observedAt: now, lastActivityAt: activity(state.lastActivityAt),
                lastActivitySource: activity(state.lastActivityAt) === null ? 'unknown' : 'session_record', sessionError: 'unknown', observedStatus },
        });
    }
    return { sessions: sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId)), sessionCoverage: coverage, nodeProviderQuota: nodeProviderQuota(quota) };
}
