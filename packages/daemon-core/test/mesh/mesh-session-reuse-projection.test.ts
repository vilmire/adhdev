import { afterEach, describe, expect, it, vi } from 'vitest';
import { reuseIdleTaskSession } from '../../src/mesh/mesh-session-reuse.js';

const fences = vi.hoisted(() => ({ stopping: vi.fn(() => false), assigned: vi.fn(() => false), remotes: [] as any[] }));
vi.mock('../../src/mesh/mesh-session-stop-fence.js', () => ({ sessionIsStopping: fences.stopping }));
vi.mock('../../src/mesh/mesh-scheduling-fitness.js', () => ({ sessionHasActiveAssignment: fences.assigned }));
vi.mock('../../src/mesh/mesh-runtime-store.js', () => ({ MeshRuntimeStore: { getInstance: () => ({ db: {}, getRemoteIdleSessions: () => fences.remotes }) } }));

const mesh = 'reuse-mesh';
const nodes = [{ id: 'worker' }];
function candidate(id: string, options: Record<string, any> = {}) {
    const inst: any = { instanceId: id, lastStatus: 'idle', settings: { meshNodeFor: mesh, meshNodeId: 'worker', ...options.settings },
        state: { status: 'idle', ...options.state }, hot: 'idle', ...options };
    inst.getHotChatSessionState = vi.fn(() => ({ id, status: inst.hot }));
    inst.getState = vi.fn(() => ({ instanceId: id, type: 'kimi', ...inst.state, settings: inst.settings }));
    return inst;
}
function run(instances: any[], task: any = {}, claim = vi.fn(() => true)) {
    const components: any = { instanceManager: { getByCategory: () => instances } };
    return { result: reuseIdleTaskSession(components, mesh, task, nodes, claim), claim };
}
afterEach(() => { vi.restoreAllMocks(); fences.stopping.mockReset().mockReturnValue(false); fences.assigned.mockReset().mockReturnValue(false); fences.remotes = []; });

describe('actual reuse candidate projection', () => {
    it('projects no foreign or positively running candidates and immediately reuses a genuine idle transition', () => {
        const foreign = candidate('foreign', { settings: { meshNodeFor: 'foreign', meshNodeId: 'worker' } });
        const running = candidate('running', { lastStatus: 'generating', hot: 'generating', state: { status: 'generating' } });
        for (let i = 0; i < 4; i++) expect(run([foreign, running]).result).toBe('none');
        expect(foreign.getState).not.toHaveBeenCalled(); expect(running.getState).not.toHaveBeenCalled();
        running.hot = 'idle'; running.lastStatus = 'idle'; running.state.status = 'idle';
        const { result, claim } = run([foreign, running]);
        expect(result).toBe('claimed'); expect(running.getState).toHaveBeenCalledTimes(1);
        expect(claim).toHaveBeenCalledWith(expect.anything(), mesh, 'worker', 'running', 'kimi', undefined, undefined, 'auto_launch_reuse');
    });
    it('periodically projects stale hot busy and respects FSM idle or missing/failed hot evidence', () => {
        const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        const inst = candidate('stale', { lastStatus: 'generating', hot: 'generating' });
        expect(run([inst]).result).toBe('none'); expect(inst.getState).not.toHaveBeenCalled();
        clock.mockReturnValue(now + 20_000);
        expect(run([inst]).result).toBe('claimed'); expect(inst.getState).toHaveBeenCalledTimes(1);
        const fsmIdle = candidate('fsm-idle', { hot: 'generating' });
        expect(run([fsmIdle]).result).toBe('claimed');
        const failed = candidate('failed', { lastStatus: 'generating' }); failed.getHotChatSessionState.mockImplementation(() => { throw new Error('unknown'); });
        expect(run([failed]).result).toBe('claimed');
        const absent = candidate('absent', { lastStatus: 'generating' }); delete absent.getHotChatSessionState;
        expect(run([absent]).result).toBe('claimed');
    });
    it('keeps fairness after refusal and projects each eligible candidate once', () => {
        const first = candidate('first'); const second = candidate('second');
        const claim = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
        expect(run([first, second], {}, claim).result).toBe('claimed');
        expect(first.getState).toHaveBeenCalledTimes(1); expect(second.getState).toHaveBeenCalledTimes(1);
        expect(claim.mock.calls.map(c => c[3])).toEqual(['first', 'second']);
    });
    it.each([
        { role: 'coordinator' }, { role: 'assistant' }, { meshCoordinatorFor: mesh },
        { spawnedForTaskId: null }, { launchedBy: 'assistant' }, { launchRecord: { roleLaunch: { role: 'assistant' } } },
    ])('excludes protected live settings before projection: %j', settings => {
        const inst = candidate('protected', { settings: { meshNodeFor: mesh, meshNodeId: 'worker', ...settings } });
        expect(run([inst]).result).toBe('none'); expect(inst.getState).not.toHaveBeenCalled();
    });
    it('retains full-state modal/provenance, assigned/stopping, membership, and target exclusions', () => {
        for (const state of [{ activeChat: { status: 'waiting_choice' } }, { launchRecord: { spawnedForTaskId: null } }, { pendingApproval: true }]) {
            expect(run([candidate('unsafe', { state: { status: 'idle', ...state } })]).result).toBe('none');
        }
        const inst = candidate('worker');
        fences.assigned.mockReturnValue(true); expect(run([inst]).result).toBe('none');
        fences.assigned.mockReturnValue(false); fences.stopping.mockReturnValue(true); expect(run([inst]).result).toBe('none');
        fences.stopping.mockReturnValue(false);
        expect(run([inst], { targetSessionId: 'other' }).result).toBe('none');
        expect(run([inst], { targetNodeId: 'other' }).result).toBe('none');
        expect(run([candidate('nonmember', { settings: { meshNodeFor: mesh, meshNodeId: 'other' } })]).result).toBe('none');
        fences.remotes = [{ nodeId: 'worker', sessionId: 'remote', providerType: 'kimi', metadata: { role: 'assistant' } }];
        expect(run([]).result).toBe('none');
        fences.remotes[0].metadata = {}; expect(run([]).result).toBe('claimed');
    });
});
