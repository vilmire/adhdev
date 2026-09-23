import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// C-W9b / C-W9a: the daemon-side responders of the mcp-server's store IPC
// (mesh-store-ipc.ts) — run through the SAME registered map the IPC transport
// dispatches (turnLedgerIpcHandlers), against a real temp mesh-runtime.db.

const testTmpDir = path.join(tmpdir(), `adhdev-ipc-contract-${randomUUID().slice(0, 8)}`);
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
    getMesh: vi.fn(() => undefined),
    getMeshByRepo: vi.fn(),
    listMeshes: vi.fn(() => [] as any[]),
    getDifficultyBrains: vi.fn(() => undefined),
}));

import { turnLedgerIpcHandlers, turnLedgerIpcSpecs } from '../../src/commands/low-family/turn-ledger-ipc.js';
import { meshStoreIpcHandlers } from '../../src/commands/low-family/mesh-store-ipc.js';
import { __resetMeshRuntimeStoreForTests, getQueue } from '../../src/mesh/mesh-work-queue.js';
import { readLocalRecords } from '../../src/mesh/mesh-local-records.js';
import { seedLocalRecord } from '../helpers/local-records.js';
import { seedMeshAttempt } from '../helpers/turn-attempt-seed.js';

const v = 1;
let meshId: string;

async function call(command: string, args: Record<string, unknown>): Promise<any> {
    const handler = (turnLedgerIpcHandlers as Record<string, (ctx: unknown, a: unknown) => Promise<unknown>>)[command];
    expect(handler, command).toBeTypeOf('function');
    return handler({ deps: { statusInstanceId: 'daemon-test' } }, args);
}

beforeEach(() => {
    meshId = `mesh_store_ipc_${randomUUID().slice(0, 8)}`;
});

afterEach(() => {
    __resetMeshRuntimeStoreForTests();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});


import {
    decodeMissionListQueryResponse, decodeMissionQueryResponse, decodeQueueQueryResponse, decodeActiveWorkQueryResponse,
    decodeLedgerQueryResponse, decodeRecoveryContextQueryResponse,
} from '@adhdev/mesh-shared';

// Every query responder's output, run through the mcp client's OWN decoder
// (mesh-shared `decode*Response`) exactly as `mcp-server/src/ipc/turn-commands.ts`
// does after stripping the envelope. Live regression 2026-09-25 (preview):
// `mesh_mission_list` failed `response failed decode` on every mesh with a
// mission because the responder spread the daemon's summary (legacy flat
// counters, timestamps) that the strict wire decoder rejects — the unit tests
// only ever listed an EMPTY mesh. This file seeds data first.
function unwrap(raw: any): unknown {
    const { success, error, code, interactionId, ...rest } = raw;
    expect(success, error).toBe(true);
    return rest;
}

describe('responder → client decoder contract (seeded data)', () => {
    async function seed(): Promise<{ missionId: string; taskId: string }> {
        const m = await call('mission_upsert', { v, meshId, title: 'Contract mission', goal: 'x'.repeat(400), status: 'active' });
        expect(m.success, m.error).toBe(true);
        const missionId = m.mission?.id ?? m.id;
        const q = await call('queue_enqueue', { v, meshId, message: 'seeded work', options: { difficulty: 'easy', taskMode: 'general', missionId }, decision: { decision: { decision: 'single', single_reason: 'x' }, decisionMissing: true } });
        expect(q.success, q.error).toBe(true);
        await call('record_local', { v, meshId, kind: 'magi_synthesis', payload: { consensusGroupId: 'g1', synthesis: { notes: ['t'] } } });
        return { missionId, taskId: q.entry.id };
    }

    it('mission_list_query (slim, verbose, withStats) decodes with ≥1 mission', async () => {
        await seed();
        for (const extra of [{}, { verbose: true }, { withStats: true }, { verbose: true, withStats: true }]) {
            const raw = unwrap(await call('mission_list_query', { v, meshId, ...extra }));
            expect(decodeMissionListQueryResponse(raw), JSON.stringify({ extra, raw }).slice(0, 800)).not.toBeNull();
            expect((raw as any).missions.length).toBeGreaterThan(0);
        }
    });

    it('mission_query, queue_query, active_work_query, ledger_query, recovery_context_query decode (mesh_index_query/turn_query need the boot-bound ledger — covered by their own tests)', async () => {
        const { missionId } = await seed();
        const cases: Array<[string, Record<string, unknown>, (v: unknown) => unknown]> = [
            ['mission_query', { v, meshId, id: missionId }, decodeMissionQueryResponse],
            ['queue_query', { v, meshId }, decodeQueueQueryResponse],
            ['queue_query', { v, meshId, view: true }, decodeQueueQueryResponse],
            ['active_work_query', { v, meshId, nodes: [], includeInputs: true, includeSummary: true }, decodeActiveWorkQueryResponse],
            ['ledger_query', { v, meshId, includeSummary: true }, decodeLedgerQueryResponse],
            ['recovery_context_query', { v, meshId, nodeId: 'node_contract' }, decodeRecoveryContextQueryResponse],
        ];
        for (const [name, args, decode] of cases) {
            const res = await call(name, args);
            if (!res.success) throw new Error(`${name} rejected request: ${res.error}`);
            const raw = unwrap(res);
            expect(decode(raw), `${name}: ${JSON.stringify(raw).slice(0, 600)}`).not.toBeNull();
        }
    });
});
