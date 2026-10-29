import { describe, expect, it } from 'vitest';
import { projectSessionView } from '../../src/assistant/project-session-view.js';
import { followerStatusView } from '../../src/assistant/project-views.js';

const NOW = Date.UTC(2026, 9, 30);
const SELF = 'daemon_mach_host_a';
const M4 = 'daemon_mach_m4';
const opts = { meshId: 'project', selfDaemonId: SELF, now: NOW, localStates: [] };
function fixture() {
    const session = { id: 'worker', providerType: 'kimi', status: 'generating', lastMessageAt: NOW - 100,
        settings: { meshNodeFor: 'project', meshNodeId: 'm4' }, turn: { attemptId: 'attempt' } };
    return { meshId: 'project', membership: { mesh: { nodes: [{ id: 'host', daemonId: SELF }, { id: 'm4', daemonId: M4 }] } },
        routes: { host: { route: 'local' }, m4: { route: 'remote', ownerDaemonId: M4 } },
        status: { nodes: [{ nodeId: 'host', daemonId: SELF }, { nodeId: 'm4', daemonId: M4,
            heldRuntime: { daemonId: M4, source: 'member_push', freshness: 'fresh', observedAt: NOW - 50, sessions: [session] },
            activeSessionDetails: [{ sessionId: 'worker', providerType: 'kimi', chatStatus: 'generating', attemptId: 'attempt', lastActivityAt: new Date(NOW - 100).toISOString() }],
            nodeFacts: { quota: { kimi: { provider: 'kimi', status: 'error', updatedAt: NOW - 200, error: 'SECRET', metadata: { failureKind: 'rate-limited', accountEmail: 'SECRET', raw: 'SECRET' } } } },
        }] },
        activeWork: { success: true, activeWork: { activeWork: [{ taskId: 'task', nodeId: 'm4', sessionId: 'worker', providerType: 'kimi', attemptId: 'attempt', status: 'running' }] } },
    };
}

describe('project task-bound sessions over held mesh status', () => {
    it('shows synthetic host-a / worker-b with activity, owner and independent quota provenance', () => {
        const out = projectSessionView(fixture(), opts);
        expect(out.sessions).toHaveLength(1);
        expect(out.sessions[0]).toMatchObject({ sessionId: 'worker', provider: 'kimi', status: 'generating', meshId: 'project', nodeId: 'm4',
            evidence: { ownerDaemonId: M4, taskId: 'task', attemptId: 'attempt', source: 'member_push', freshness: 'fresh', observedAt: NOW - 50, lastActivityAt: NOW - 100, sessionError: 'unknown' } });
        expect(out.nodeProviderQuota).toEqual([{ nodeId: 'm4', ownerDaemonId: M4, provider: 'kimi', scope: 'node_provider', status: 'error', failureKind: 'rate-limited', updatedAt: NOW - 200 }]);
        expect(JSON.stringify(out)).not.toContain('SECRET');
    });

    it('supports same-host workers with positive task binding; excludes orphan and other project local sessions', () => {
        const view = fixture();
        view.activeWork.activeWork.activeWork = [{ taskId: 'local-task', nodeId: 'host', sessionId: 'local-worker', providerType: 'codex-cli', attemptId: 'local-attempt', status: 'running' }];
        const states = [
            { instanceId: 'local-worker', type: 'codex-cli', status: 'waiting_approval', turn: { attemptId: 'local-attempt' }, lastActivityAt: NOW - 4, settings: { meshNodeFor: 'project', meshNodeId: 'host' }, activeChat: { messages: ['SECRET'] } },
            { instanceId: 'orphan', type: 'kimi', status: 'idle', settings: {} },
            { instanceId: 'other-project', type: 'kimi', status: 'idle', settings: { meshNodeFor: 'other', meshNodeId: 'host' } },
        ];
        const out = projectSessionView(view, { ...opts, localStates: states });
        expect(out.sessions).toHaveLength(1);
        expect(out.sessions[0]).toMatchObject({ sessionId: 'local-worker', status: 'waiting_approval', evidence: { source: 'local', freshness: 'fresh', lastActivityAt: NOW - 4 } });
        expect(JSON.stringify(out)).not.toContain('SECRET');
    });

    it('does not aggregate daemon-wide or other-project sessions, even when ids collide', () => {
        const view = fixture();
        view.status.nodes[1]!.heldRuntime!.sessions.push({ id: 'orphan', providerType: 'kimi', status: 'idle', settings: { meshNodeFor: '', meshNodeId: '' }, lastMessageAt: NOW, turn: { attemptId: '' } });
        view.status.nodes[1]!.heldRuntime!.sessions[0]!.settings.meshNodeFor = 'other-project';
        const out = projectSessionView(view, opts);
        expect(out.sessions).toHaveLength(1);
        expect(out.sessions[0]).toMatchObject({ sessionId: 'worker', status: 'unknown', evidence: { freshness: 'not_observed', lastActivityAt: null } });
        expect(JSON.stringify(out)).not.toContain('orphan');
        expect(projectSessionView({ ...view, meshId: 'other-project' }, opts).sessions).toEqual([]);
    });

    it.each(['stale', 'offline', 'boot', 'unknown'] as const)('never infers idle from %s observation', reason => {
        const view = fixture();
        const remote = view.status.nodes[1]!;
        remote.heldRuntime!.sessions[0]!.status = 'idle';
        remote.activeSessionDetails![0]!.chatStatus = 'idle';
        if (reason === 'stale') remote.heldRuntime!.freshness = 'stale';
        if (reason === 'offline') (remote as any).connection = { state: 'disconnected', reason: 'SECRET' };
        if (reason === 'boot') (remote.heldRuntime as any).handshakePending = true;
        if (reason === 'unknown') delete (remote.heldRuntime as any).freshness;
        const out = projectSessionView(view, opts);
        expect(out.sessions[0]!.status).toBe('unknown');
        expect(out.sessions[0]!.evidence!.observedStatus).toBe('idle');
        expect(out.sessions[0]!.evidence!.freshness).toBe(reason === 'offline' ? 'unreachable' : reason === 'boot' ? 'stale' : reason);
        expect(JSON.stringify(out)).not.toContain('SECRET');
    });

    it('reports missing runtime, wrong owner, truncated coverage and missing local source honestly', () => {
        const view = fixture();
        view.status.nodes[1]!.heldRuntime!.daemonId = 'daemon_mach_replaced';
        let out = projectSessionView(view, { ...opts, localStates: undefined });
        expect(out.sessionCoverage[0]!.freshness).toBe('unknown');
        expect(out.sessions[0]).toMatchObject({ status: 'unknown', evidence: { source: 'none', freshness: 'not_observed' } });
        expect(out.nodeProviderQuota).toEqual([]);
        view.status.nodes[1]!.heldRuntime!.daemonId = M4;
        (view.status.nodes[1]!.heldRuntime as any).sessionsTruncated = true;
        out = projectSessionView(view, opts);
        expect(out.sessionCoverage[1]!.coverage).toBe('partial');
        delete (view.status.nodes[1] as any).heldRuntime;
        expect(projectSessionView(view, opts).sessions[0]!.status).toBe('unknown');
    });

    it('reports unknown or partial coverage when project task bindings are unavailable or bounded', () => {
        const view = fixture();
        (view.activeWork.activeWork as any).summary = { totalActiveCount: 300 };
        expect(projectSessionView(view, opts).sessionCoverage[1]!.coverage).toBe('partial');
        view.activeWork.success = false;
        const out = projectSessionView(view, opts);
        expect(out.sessions).toEqual([]);
        expect(out.sessionCoverage[1]).toMatchObject({ freshness: 'fresh', coverage: 'unknown' });
    });

    it('retains observed terminal status and rejects mismatched attempts', () => {
        const view = fixture();
        view.status.nodes[1]!.activeSessionDetails![0]!.chatStatus = 'stopped';
        expect(projectSessionView(view, opts).sessions[0]!.status).toBe('stopped');
        view.activeWork.activeWork.activeWork[0]!.attemptId = 'new-attempt';
        expect(projectSessionView(view, opts).sessions[0]).toMatchObject({ status: 'unknown', evidence: { freshness: 'unknown', lastActivityAt: null, observedStatus: 'unknown' } });
    });

    it('treats absent attempt evidence and contradictory node ownership as unknown', () => {
        const view = fixture();
        delete (view.status.nodes[1]!.activeSessionDetails![0] as any).attemptId;
        delete (view.status.nodes[1]!.heldRuntime!.sessions[0] as any).turn;
        expect(projectSessionView(view, opts).sessions[0]!.status).toBe('unknown');
        view.status.nodes[1]!.daemonId = 'daemon_mach_other';
        expect(projectSessionView(view, opts).sessions).toEqual([]);
        expect(projectSessionView(view, opts).nodeProviderQuota).toEqual([]);
    });

    it('keeps separate daemons with the same session id and deduplicates aliases conservatively', () => {
        const view = fixture();
        const second = structuredClone(view.status.nodes[1]!);
        second.nodeId = 'm5'; second.daemonId = 'daemon_mach_m5'; second.heldRuntime!.daemonId = 'daemon_mach_m5';
        second.heldRuntime!.sessions[0]!.settings.meshNodeId = 'm5';
        view.membership.mesh.nodes.push({ id: 'm5', daemonId: 'daemon_mach_m5' });
        (view.routes as any).m5 = { route: 'remote', ownerDaemonId: 'daemon_mach_m5' };
        view.status.nodes.push(second);
        view.activeWork.activeWork.activeWork.push({ ...view.activeWork.activeWork.activeWork[0]!, taskId: 'task-2', nodeId: 'm5' });
        expect(projectSessionView(view, opts).sessions).toHaveLength(2);
        view.activeWork.activeWork.activeWork.push({ ...view.activeWork.activeWork.activeWork[0]! });
        expect(projectSessionView(view, opts).sessions).toHaveLength(2);
    });

    it('sanitizes hostile diagnostics and survives both follower allowlists', () => {
        const view = fixture();
        const remote = view.status.nodes[1]!;
        remote.activeSessionDetails![0]!.chatStatus = 'SECRET terminal diagnostic';
        (remote.heldRuntime!.sessions[0] as any).errorMessage = 'SECRET';
        remote.nodeFacts!.quota.kimi.metadata.failureKind = 'SECRET';
        const body = projectSessionView(view, opts);
        const mesh = { id: 'project', name: 'Project', repoIdentity: 'github.com/org/repo' } as any;
        const first = followerStatusView(body, mesh);
        const second = followerStatusView(first, mesh);
        expect(second.sessions).toEqual(body.sessions);
        expect(second.sessionCoverage).toEqual(body.sessionCoverage);
        expect(second.nodeProviderQuota).toEqual(body.nodeProviderQuota);
        expect(JSON.stringify(second)).not.toContain('SECRET');
        expect(body.sessions[0]!.evidence!.sessionError).toBe('unknown');
    });
});
