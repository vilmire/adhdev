import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

// Dashboard read commands for the Blueprint tab: mesh_task_output projects the
// latest persisted completion envelope to the fields the task-detail panel
// needs, and fails soft on missing args.

const testTmpDir = path.join(tmpdir(), `adhdev-task-view-cmds-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');
vi.hoisted(() => {
    const os = require('node:os') as typeof import('node:os');
    const p = require('node:path') as typeof import('node:path');
    process.env.ADHDEV_CONFIG_DIR = p.join(os.tmpdir(), `adhdev-task-view-cmds-env-${process.pid}`, '.adhdev');
});

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
    getMachineId: () => ({ machineId: 'test-machine' } as any).machineId,
    getMachineNickname: () => ({ machineId: 'test-machine' } as any).machineNickname ?? null,
}));
vi.mock('../../src/config/mesh-config.js', () => ({
    getMesh: vi.fn(() => ({ nodes: [] })),
}));

import { meshTaskViewCommandHandlers } from '../../src/commands/med-family/mesh-task-view-commands.js';
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

const ctx: any = { deps: {} };

function meshId(tag: string): string {
    return `mesh_tvcmd_${tag}_${randomUUID().slice(0, 8)}`;
}

afterEach(() => {
    __resetMeshRuntimeStoreForTests();
    vi.clearAllMocks();
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('mesh_task_output', () => {
    it('fails soft on missing args', async () => {
        const res: any = await meshTaskViewCommandHandlers.mesh_task_output(ctx, {});
        expect(res.success).toBe(false);
    });

    it('returns output:null when the task has no persisted output', async () => {
        const mesh = meshId('output-none');
        const res: any = await meshTaskViewCommandHandlers.mesh_task_output(ctx, { meshId: mesh, taskId: randomUUID() });
        expect(res.success).toBe(true);
        expect(res.output).toBeNull();
    });

    it('projects finalSummary and providerType out of the latest persisted envelope', async () => {
        const mesh = meshId('output-hit');
        const taskId = randomUUID();
        const store = MeshRuntimeStore.getInstance();
        const now = new Date().toISOString();
        const envelope = {
            final_summary: 'Landed the fix and verified with the repro script.',
            worker_result: 'ok',
            source: { provider_type: 'claude-cli', session_id: 'sess_1' },
        };
        store.insertTaskOutput({
            taskId, version: 1, meshId: mesh, attempt: 1, status: 'completed',
            envelopeJson: JSON.stringify(envelope), digest: 'digest1', createdAt: now,
        });
        const res: any = await meshTaskViewCommandHandlers.mesh_task_output(ctx, { meshId: mesh, taskId });
        expect(res.success).toBe(true);
        expect(res.output.finalSummary).toBe(envelope.final_summary);
        expect(res.output.providerType).toBe('claude-cli');
        expect(res.output.version).toBe(1);
    });

    it('returns the latest version when a task has multiple output rows', async () => {
        const mesh = meshId('output-latest');
        const taskId = randomUUID();
        const store = MeshRuntimeStore.getInstance();
        const now = new Date().toISOString();
        store.insertTaskOutput({
            taskId, version: 1, meshId: mesh, attempt: 1, status: 'completed',
            envelopeJson: JSON.stringify({ final_summary: 'first attempt', source: {} }),
            digest: 'd1', createdAt: now,
        });
        store.insertTaskOutput({
            taskId, version: 2, meshId: mesh, attempt: 2, status: 'completed',
            envelopeJson: JSON.stringify({ final_summary: 'second attempt', source: { provider_type: 'codex-cli' } }),
            digest: 'd2', createdAt: now,
        });
        const res: any = await meshTaskViewCommandHandlers.mesh_task_output(ctx, { meshId: mesh, taskId });
        expect(res.success).toBe(true);
        expect(res.output.version).toBe(2);
        expect(res.output.finalSummary).toBe('second attempt');
        expect(res.output.providerType).toBe('codex-cli');
    });
});
