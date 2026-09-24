/**
 * Relay answer validation (commands/mesh-relay-result.ts): every forwarder
 * reads a `dispatchMeshCommand(...)` answer through ONE helper — unwrap at most
 * four `{ result }` / `{ payload }` levels to an object with a boolean
 * `success`, else the typed `relay_result_malformed` failure + one WARN line.
 * No forwarder passes a malformed answer through (`forwarded ?? …`) any more.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findMeshRelayAnswer, unwrapMeshRelayResult } from '../../src/commands/mesh-relay-result.js';
import { DaemonCommandRouter } from '../../src/commands/router.js';
import { meshNodeLogsHandlers } from '../../src/commands/low-family/mesh-node-logs.js';
import { meshRestartHandlers } from '../../src/commands/med-family/mesh-restart.js';
import { LOG } from '../../src/logging/logger.js';

afterEach(() => { vi.restoreAllMocks(); });

const COORD = 'daemon_mach_coord0002';
const WORKER = 'daemon_mach_worker0002';
const MESH = 'mesh_relay_1';

const MALFORMED: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'ok'],
    ['a number', 42],
    ['an array', [{ success: true }]],
    ['an object without success', { ok: true, data: 1 }],
    ['a non-boolean success', { success: 'true' }],
    ['nesting deeper than four levels', { result: { result: { result: { result: { result: { success: true } } } } } }],
];

describe('unwrapMeshRelayResult', () => {
    it('returns the handler answer unwrapped from up to four result/payload levels', () => {
        expect(unwrapMeshRelayResult({ success: true, x: 1 }, { command: 'c' })).toEqual({ success: true, x: 1 });
        expect(unwrapMeshRelayResult({ result: { success: false, error: 'e' } }, { command: 'c' })).toEqual({ success: false, error: 'e' });
        expect(unwrapMeshRelayResult({ payload: { result: { payload: { result: { success: true, deep: 4 } } } } }, { command: 'c' }))
            .toEqual({ success: true, deep: 4 });
        // The outermost object with a boolean success wins.
        expect(findMeshRelayAnswer({ success: true, result: { success: false } })).toEqual({ success: true, result: { success: false } });
    });

    for (const [label, raw] of MALFORMED) {
        it(`${label} → relay_result_malformed + one warn line`, () => {
            const warn = vi.spyOn(LOG, 'warn');
            const out: any = unwrapMeshRelayResult(raw, { command: 'get_mesh_node_logs', peerDaemonId: WORKER });
            expect(out).toMatchObject({ success: false, error: 'relay_result_malformed', command: 'get_mesh_node_logs', peerDaemonId: WORKER });
            expect(typeof out.detail).toBe('string');
            expect(warn.mock.calls.filter(([tag]) => tag === 'MeshRelay')).toHaveLength(1);
        });
    }
});

// ─── Representative forwarders ──────────────────────────────────────────────

function meshWithRemoteNode() {
    return {
        id: MESH,
        nodes: [
            { id: 'node-coord', workspace: '/w/coord', daemonId: COORD },
            {
                id: 'node-remote', workspace: '/remote/wt', daemonId: WORKER, isLocalWorktree: true,
                cachedStatus: { activeSession: { id: 'sess_remote_1', providerType: 'claude-cli', status: 'idle' } },
            },
        ],
    };
}

describe('router forwardToOwningDaemon (session-scoped forward)', () => {
    function router(dispatch: (...a: any[]) => Promise<unknown>) {
        const r = new DaemonCommandRouter({
            commandHandler: { handleSpec: async () => ({ success: false, error: 'Live session not found' }) } as any,
            cliManager: {} as any,
            cdpManagers: new Map(),
            providerLoader: {} as any,
            instanceManager: { collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null, getByCategory: () => [] } as any,
            detectedIdes: { value: [] },
            sessionRegistry: { get: () => undefined } as any,
            statusInstanceId: COORD,
            dispatchMeshCommand: dispatch,
        } as any);
        r.getCachedInlineMesh(MESH, meshWithRemoteNode());
        return r;
    }

    for (const [label, raw] of [['null', null], ['a string', 'done'], ['an object without success', { forwarded: true }]] as const) {
        it(`${label} from the owning daemon → relay_result_malformed`, async () => {
            const result: any = await router(async () => raw).execute('resolve_action', { targetSessionId: 'sess_remote_1', button: 'Approve' });
            expect(result).toMatchObject({ success: false, error: 'relay_result_malformed', command: 'resolve_action', peerDaemonId: WORKER });
        });
    }

    it('a nested envelope is unwrapped to the handler answer', async () => {
        const result: any = await router(async () => ({ payload: { result: { success: true, resolved: true } } }))
            .execute('resolve_action', { targetSessionId: 'sess_remote_1', button: 'Approve' });
        expect(result).toEqual({ success: true, resolved: true });
    });
});

describe('get_mesh_node_logs remote forward', () => {
    function ctx(dispatch: (...a: any[]) => Promise<unknown>) {
        return {
            deps: { statusInstanceId: COORD, dispatchMeshCommand: dispatch },
            getMeshForCommand: async () => ({ mesh: meshWithRemoteNode(), inline: true, source: 'inline_cache' as const }),
        } as any;
    }

    it('malformed answer → typed failure; the forward carries the resolved roster as evidence', async () => {
        const dispatch = vi.fn(async () => undefined);
        const result: any = await meshNodeLogsHandlers.get_mesh_node_logs(ctx(dispatch), { meshId: MESH, nodeId: 'node-remote' });
        expect(result).toMatchObject({ success: false, error: 'relay_result_malformed', peerDaemonId: WORKER });
        const [, , forwardedArgs] = dispatch.mock.calls[0] as any[];
        expect(forwardedArgs._meshDirectDispatch).toBe(true);
        expect(forwardedArgs.inlineMesh?.id).toBe(MESH);
    });

    it('a caller-supplied inlineMesh is kept, and a wrapped answer is unwrapped', async () => {
        const callerMesh = { id: MESH, nodes: [{ id: 'x', daemonId: WORKER }] };
        const dispatch = vi.fn(async () => ({ result: { success: true, lines: ['a'] } }));
        const result: any = await meshNodeLogsHandlers.get_mesh_node_logs(ctx(dispatch), { meshId: MESH, nodeId: 'node-remote', inlineMesh: callerMesh });
        expect(result).toEqual({ success: true, lines: ['a'] });
        expect((dispatch.mock.calls[0] as any[])[2].inlineMesh).toBe(callerMesh);
    });
});

describe('restart_daemon_node remote forward', () => {
    it('a non-object answer → typed failure, never passed through', async () => {
        const dispatch = vi.fn(async () => 'restarting');
        const result: any = await meshRestartHandlers.restart_daemon_node({
            deps: { statusInstanceId: COORD, dispatchMeshCommand: dispatch },
            getMeshForCommand: async () => ({ mesh: meshWithRemoteNode(), inline: true, source: 'inline_cache' }),
        } as any, { meshId: MESH, nodeId: 'node-remote' });
        expect(result).toMatchObject({ success: false, error: 'relay_result_malformed', command: 'restart_daemon_node' });
        expect(dispatch).toHaveBeenCalledTimes(1);
    });
});
