import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// S7 turn-ledger wiring (wiring-unification C integration): the ONE ledger
// wireTurnLedger builds is what the MCP turn IPC reads, every provider
// instance holds the evidence port over it, and mesh_index_query reads the
// same mesh_topic_index the cursors write — all unbound again on dispose.

const testTmpDir = path.join(tmpdir(), `adhdev-turn-wiring-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));
vi.mock('../../src/config/mesh-config.js', () => ({
    getMesh: vi.fn(),
    getMeshByRepo: vi.fn(),
    listMeshes: vi.fn(() => [] as any[]),
}));

import { wireTurnLedger } from '../../src/boot/stages/mesh-runtime.js';
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js';
import { getActiveTurnLedgerForIpc, turnLedgerIpcHandlers } from '../../src/commands/low-family/turn-ledger-ipc.js';
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';
import { meshNoticeRuntime } from '../../src/mesh/turn-ledger/deliver.js';
import type { TurnEvidencePort } from '../../src/providers/turn-evidence-port.js';

afterEach(() => {
    vi.restoreAllMocks();
    __resetMeshRuntimeStoreForTests();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function fakeComponents(settingsBySession: Record<string, Record<string, unknown>>) {
    const portCalls: Array<TurnEvidencePort | null> = [];
    const instanceManager = {
        setTurnEvidencePort: (port: TurnEvidencePort | null) => { portCalls.push(port); },
        listInstanceIds: () => Object.keys(settingsBySession),
        getInstance: (id: string) => (settingsBySession[id] ? { getState: () => ({ settings: settingsBySession[id] }) } : undefined),
    };
    const components = {
        bus: createSessionLifecycleBus(),
        instanceManager,
        // D2 (C-W8): notices submit through the daemon's one SessionInputService.
        cliManager: { input: { submit: async () => ({ kind: 'delivered' }) } },
        seqscribe: null,
        statusInstanceId: 'daemon_wiring',
    } as any;
    return { components, portCalls };
}

const baseEvidence = { at: 1_000, source: 'fsm_edge', observedBy: 'daemon_wiring' } as const;

describe('wireTurnLedger — S7 wiring', () => {
    it('binds the turn IPC to the ONE ledger + the notice runtime, and unbinds both on dispose', () => {
        const { components } = fakeComponents({});
        const wiring = wireTurnLedger(components, { runMigration: false });
        try {
            expect(getActiveTurnLedgerForIpc()).toBe(wiring.ledger);
            expect(meshNoticeRuntime.current()).toBe(wiring.notices);
        } finally {
            wiring.dispose();
        }
        expect(getActiveTurnLedgerForIpc()).toBeNull();
        expect(meshNoticeRuntime.current()).toBeNull();
    });

    it('hands every instance the evidence port: a plain session takes every kind, a mesh-bound one only session_error; detached on dispose', () => {
        const { components, portCalls } = fakeComponents({ plain: {}, worker: { meshNodeFor: 'm1', meshActiveTaskId: 't1' } });
        const wiring = wireTurnLedger(components, { runMigration: false });
        try {
            expect(portCalls).toHaveLength(1);
            const port = portCalls[0]!;
            expect(port).not.toBeNull();

            // Plain session: the port opens a plain attempt (the forwarder never sees it).
            port.observe({ ...baseEvidence, eventId: 'ev-plain-start', sessionId: 'plain', kind: 'turn_started', retro: false } as any);
            expect(wiring.ledger.openAttemptForSession('plain')).toMatchObject({ scope: 'plain' });
            expect(wiring.ledger.store.hasEvent('ev-plain-start')).toBe(true);

            // Mesh-bound session: turn kinds stay with the forwarder (it carries the
            // summary/handoff the port's evidence does not yet) — nothing reaches the ledger.
            port.observe({ ...baseEvidence, eventId: 'ev-worker-start', sessionId: 'worker', kind: 'turn_started', retro: false } as any);
            expect(wiring.ledger.store.hasEvent('ev-worker-start')).toBe(false);
            expect(wiring.ledger.openAttemptForSession('worker')).toBeNull();
            // … but session_error, which the forwarder never builds, is observed.
            port.observe({ ...baseEvidence, eventId: 'ev-worker-err', sessionId: 'worker', kind: 'session_error', reason: 'auth_failed' } as any);
            expect(wiring.ledger.store.hasEvent('ev-worker-err')).toBe(true);
        } finally {
            wiring.dispose();
        }
        expect(portCalls[portCalls.length - 1]).toBeNull();
    });

    it('mesh_index_query reads the bound mesh_topic_index, re-projected onto the mesh_record allow-list', async () => {
        const { components } = fakeComponents({});
        const wiring = wireTurnLedger(components, { runMigration: false });
        try {
            const meshId = 'mesh_idx';
            expect(wiring.index.ingest({
                meshId, writer: 'w-peer', seq: 1, kind: 'adhdev.mesh.ledger',
                payload: {
                    id: 'rec-1', timestamp: new Date(5_000).toISOString(), ledgerKind: 'task_dispatched', taskId: 't1', nodeId: 'n1',
                    payload: { taskId: 't1', status: 'assigned', finalSummary: 'AGENT TEXT MUST NOT CROSS' },
                },
            })).toBe(true);
            const result: any = await turnLedgerIpcHandlers.mesh_index_query!({} as any, { v: 1, meshId, writer: 'fleet' });
            expect(result.success).toBe(true);
            expect(result.rows).toHaveLength(1);
            expect(result.rows[0]).toMatchObject({ writer: 'w-peer', seq: 1, meshId, eventId: 'rec-1', kind: 'task_dispatched', taskId: 't1' });
            expect(result.rows[0].payload).toEqual({ taskId: 't1', status: 'assigned' });
            expect(JSON.stringify(result)).not.toContain('AGENT TEXT');
            // Own scope with no seqscribe writer (standalone without a node) answers empty, not the fleet.
            const own: any = await turnLedgerIpcHandlers.mesh_index_query!({} as any, { v: 1, meshId, writer: 'own' });
            expect(own).toMatchObject({ success: true, rows: [] });
        } finally {
            wiring.dispose();
        }
        const unbound: any = await turnLedgerIpcHandlers.mesh_index_query!({} as any, { v: 1, meshId: 'mesh_idx' });
        expect(unbound).toMatchObject({ success: false, code: 'turn_ledger_unavailable', rows: [] });
    });

    it('mesh_record answers the real append coordinate: seq 0 = not appended (no seqscribe node in this process)', async () => {
        const { components } = fakeComponents({});
        const wiring = wireTurnLedger(components, { runMigration: false });
        try {
            const result: any = await turnLedgerIpcHandlers.mesh_record!({} as any, { v: 1, meshId: 'mesh_rec', ledgerKind: 'task_dispatched', payload: { taskId: 't1' } });
            expect(result.success).toBe(true);
            expect(typeof result.eventId).toBe('string');
            expect(result.seq).toBe(0);
        } finally {
            wiring.dispose();
        }
    });
});
