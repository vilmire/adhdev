/**
 * Default assistant project ports over a fake instance manager: coordinator
 * views carry the `managedByAssistant` stamp, approvals count the mesh's
 * parked sessions (coordinator and worker), and relay hooks start as no-ops.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
    createDefaultProjectPorts,
    preloadAssistantProjectReaders,
    setAssistantRelayHooks,
} from '../../src/assistant/assistant-project-ports.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';

const inst = (instanceId: string, status: string, settings: Record<string, unknown>) => ({
    getState: () => ({ instanceId, status, settings }),
    getDrainStatus: () => (status === 'idle' ? 'idle' : 'generating'),
    isModalParked: () => status === 'waiting_approval',
    onEvent: () => undefined,
});

const instances = [
    inst('coord-managed', 'generating', { meshCoordinatorFor: 'mesh_a', managedByAssistant: true }),
    inst('coord-human', 'idle', { meshCoordinatorFor: 'mesh_a' }),
    inst('worker-1', 'waiting_approval', { meshNodeFor: 'mesh_a' }),
    inst('other', 'waiting_approval', { meshCoordinatorFor: 'mesh_b' }),
];

const ctx = {
    components: () => ({ instanceManager: { getByCategory: () => instances } }) as any,
    execute: async () => ({ success: true }),
    selfDaemonId: 'daemon_mach_self',
};

beforeAll(async () => {
    await preloadAssistantProjectReaders();
    setAssistantServicesForTests(createAssistantServices({ configDir: '/nonexistent-adhdev-test', listMeshes: () => [], isMeshHostedHere: () => true }));
});
afterEach(() => setAssistantRelayHooks(null));
afterAll(() => setAssistantServicesForTests(null));

describe('createDefaultProjectPorts', () => {
    it('lists the mesh coordinators with their managedByAssistant stamp', () => {
        const ports = createDefaultProjectPorts(ctx);
        expect(ports.coordinators('mesh_a')).toEqual([
            { sessionId: 'coord-managed', idle: false, modalParked: false, managedByAssistant: true },
            { sessionId: 'coord-human', idle: true, modalParked: false, managedByAssistant: false },
        ]);
        expect(ports.coordinators('mesh_c')).toEqual([]);
    });

    it('counts parked approvals of the mesh only', () => {
        expect(createDefaultProjectPorts(ctx).pendingApprovals('mesh_a')).toBe(1);
    });

    it('relay hooks are empty until boot installs them', () => {
        expect(createDefaultProjectPorts(ctx).relay).toEqual({});
        const openThread = () => undefined;
        setAssistantRelayHooks({ openThread });
        expect(createDefaultProjectPorts(ctx).relay.openThread).toBe(openThread);
    });
});
