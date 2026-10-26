import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonCliManager } from '../../src/commands/cli-manager.js';
import { getConfigDir } from '../../src/config/config.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { stopStaleMeshWorker } from '../../src/mesh/mesh-event-forwarding.js';
import type { CancelDispatchRequest } from '../../src/mesh/turn-ledger/effects.js';

// setup-env gives each file a disposable config dir, including the real stop journal.
afterEach(() => MeshRuntimeStore.resetForTests());
const self = 'daemon_fixture-local';
const namespace = 'adhdev-preview';
const owner = { namespace, endpoint: 'unix:/fixture-session-host.sock', managedBy: 'adhdev-cloud', clientId: self };

function persist(sessionId: string, ns = namespace, kind = 'tombstones', record: Record<string, unknown> = { sessionId, lifecycle: 'stopped' }) {
    const dir = join(getConfigDir(), 'session-host', ns, kind);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify(kind === 'runtimes' ? { record, snapshot: {} } : record));
}

function fixture() {
    const sessionId = randomUUID();
    const request: CancelDispatchRequest = { sessionId, meshId: 'fixture-mesh', taskId: randomUUID(),
        attemptId: randomUUID(), generation: 0, dispatchNonce: 0, messageId: null,
        nodeId: 'removed-node', providerType: 'codex-cli', ownerDaemonId: self,
        stopRequestId: randomUUID(), revokeBind: true };
    const inventory = vi.fn(async (): Promise<any[]> => []);
    const host: any = { adapters: new Map(), deps: {
        getInstanceManager: () => ({ getInstance: () => undefined }),
        getHostedBindingOwner: () => owner,
        listHostedCliRuntimes: inventory,
    } };
    // Exercise the actual strict-stop envelope check and handler, not a canned receipt.
    host.stopCli = vi.fn((args: any) => DaemonCliManager.prototype.stopCli.call(host, args));
    const remote = vi.fn(async (_daemon: string, command: string) => command === 'agent_command'
        ? { success: true, meshWriterStopProtocol: 1, stopRequestId: request.stopRequestId }
        : { success: false, code: 'writer_checkpoint_pending', reason: 'remote_fixture_pending' });
    const components: any = { cliManager: host, statusInstanceId: self, dispatchMeshCommand: remote,
        router: { getCachedInlineMesh: () => ({ id: request.meshId, nodes: [] }) } };
    const stop = (extra = {}) => stopStaleMeshWorker(components, { meshId: request.meshId!, sessionId,
        nodeId: request.nodeId!, providerType: request.providerType!, writerStop: request, ...extra });
    return { sessionId, request, inventory, host, remote, components, stop };
}
const unresolved = { success: false, code: 'writer_checkpoint_pending', reason: 'worker_host_unresolved' };

describe('strict writer stop routing by persisted worker host', () => {
    it('routes an exact local tombstone after node removal through the unchanged strict handler', async () => {
        const f = fixture(); persist(f.sessionId);
        const result = await f.stop();
        expect(result).toMatchObject({ ...f.request, success: true, quiescent: true,
            evidence: { kind: 'host_session_absent', sessionId: f.sessionId }, incarnation: expect.any(String) });
        expect(f.host.stopCli).toHaveBeenCalledWith(expect.objectContaining({ targetSessionId: f.sessionId,
            cliType: 'codex-cli', mode: 'hard', meshWriterStop: f.request }));
        expect(f.inventory).toHaveBeenCalledOnce();
        expect(f.remote).not.toHaveBeenCalled();
    });

    it('keeps an owner-self remote worker on the capability-probed remote stop path', async () => {
        const f = fixture();
        f.components.router.getCachedInlineMesh = () => ({ id: f.request.meshId, nodes: [{ id: f.request.nodeId, daemonId: 'daemon_fixture-remote' }] });
        expect(await f.stop()).toMatchObject({ reason: 'remote_fixture_pending' });
        expect(f.remote.mock.calls.map(call => call.slice(0, 2))).toEqual([
            ['daemon_fixture-remote', 'agent_command'], ['daemon_fixture-remote', 'stop_cli'],
        ]);
        expect(f.remote.mock.calls[1]).toEqual(expect.arrayContaining([expect.objectContaining({ meshWriterStop: f.request })]));
        expect(f.host.stopCli).not.toHaveBeenCalled(); expect(f.inventory).not.toHaveBeenCalled();
    });

    it('leaves owner-self unresolved without positive host evidence', async () => {
        const f = fixture(); expect(await f.stop()).toEqual(unresolved);
        expect(f.host.stopCli).not.toHaveBeenCalled(); expect(f.inventory).not.toHaveBeenCalled();
    });

    it.each(['foreign namespace', 'multiple namespaces', 'managedBy conflict', 'other UUID', 'UUID prefix', 'record UUID mismatch', 'missing owner', 'unavailable owner', 'unreadable evidence'])(
        'keeps %s pending without consulting local inventory', async scenario => {
            const f = fixture();
            if (scenario === 'foreign namespace') persist(f.sessionId, 'other-host');
            if (scenario === 'multiple namespaces') { persist(f.sessionId); persist(f.sessionId, 'other-host'); }
            if (scenario === 'managedBy conflict') persist(f.sessionId, namespace, 'tombstones', { sessionId: f.sessionId, meta: { managedBy: 'other' } });
            if (scenario === 'other UUID') persist(randomUUID());
            if (scenario === 'UUID prefix') persist(f.sessionId.slice(0, -1));
            if (scenario === 'record UUID mismatch') persist(f.sessionId, namespace, 'tombstones', { sessionId: randomUUID() });
            if (scenario === 'missing owner') { persist(f.sessionId); delete f.host.deps.getHostedBindingOwner; }
            if (scenario === 'unavailable owner') { persist(f.sessionId); f.host.deps.getHostedBindingOwner = () => { throw new Error('unavailable'); }; }
            if (scenario === 'unreadable evidence') { persist(f.sessionId); writeFileSync(join(getConfigDir(), 'session-host', namespace, 'tombstones', `${f.sessionId}.json`), '{'); }
            expect(await f.stop()).toEqual(unresolved);
            expect(f.host.stopCli).not.toHaveBeenCalled(); expect(f.inventory).not.toHaveBeenCalled();
            expect(f.remote).not.toHaveBeenCalled();
        });

    it.each(['argument', 'mesh node'])('refuses local evidence contradicted by a remote daemon from the %s', async source => {
        const f = fixture(); persist(f.sessionId);
        if (source === 'mesh node') f.components.router.getCachedInlineMesh = () => ({ id: f.request.meshId, nodes: [{ id: f.request.nodeId, daemonId: 'daemon_fixture-remote' }] });
        expect(await f.stop(source === 'argument' ? { daemonId: 'daemon_fixture-remote' } : {})).toEqual({
            success: false, code: 'writer_checkpoint_pending', reason: 'worker_host_conflict' });
        expect(f.host.stopCli).not.toHaveBeenCalled(); expect(f.inventory).not.toHaveBeenCalled();
        expect(f.remote).not.toHaveBeenCalled();
    });

    it.each(['live', 'reappeared', 'unreachable', 'unavailable', 'protected'])(
        'preserves strict handler uncertainty for a %s local writer', async mode => {
            const f = fixture();
            persist(f.sessionId, namespace, mode === 'live' ? 'runtimes' : 'tombstones',
                { sessionId: f.sessionId, lifecycle: mode === 'live' ? 'running' : 'stopped' });
            const reasons = { live: 'unknown, cannot prove dead: host still reports session',
                reappeared: 'writer_reappeared', unreachable: 'unknown, cannot prove dead: host unreachable',
                unavailable: 'unknown, cannot prove dead: host inventory unavailable', protected: 'protected_role' };
            if (mode === 'live') f.inventory.mockResolvedValue([{ runtimeId: f.sessionId }]);
            if (mode === 'reappeared') f.inventory.mockImplementation(async () => { f.host.adapters.set(f.sessionId, {}); return []; });
            if (mode === 'unreachable') f.inventory.mockRejectedValue(new Error('offline'));
            if (mode === 'unavailable') delete f.host.deps.listHostedCliRuntimes;
            if (mode === 'protected') f.host.deps.getInstanceManager = () => ({ getInstance: () => ({ getState: () => ({ settings: { assistant: true } }) }) });
            expect(await f.stop()).toEqual({ success: false, code: 'writer_checkpoint_pending', reason: reasons[mode as keyof typeof reasons] });
            expect(f.host.stopCli).toHaveBeenCalledOnce(); expect(f.remote).not.toHaveBeenCalled();
            if (mode === 'protected') expect(f.inventory).not.toHaveBeenCalled();
        });
});
