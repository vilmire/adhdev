/**
 * Evidence handoff via artifacts: same-mission auto-inherit at enqueue / direct
 * dispatch / claim time, the worker-visible manifest, the metric, and the
 * mission-scoped artifact_list for a coordinator without a session.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { DaemonCommandRouter, type CommandRouterDeps } from '../../src/commands/router.js';
import { setArtifactCommandRuntimeForDeps } from '../../src/commands/med-family/artifact-runtime.js';
import { SessionRegistry } from '../../src/sessions/registry.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { enqueueTask, recordDirectDispatchTask } from '../../src/mesh/mesh-work-queue.js';
import {
    INPUT_ARTIFACTS_HEADING,
    MAX_INHERITED_INPUT_ARTIFACTS,
    buildInputArtifactManifestAppendix,
    getInputArtifactDispatchStats,
    refreshInheritedInputArtifacts,
    resolveInheritedArtifactIds,
} from '../../src/mesh/mesh-input-artifacts.js';
import { resolveDispatchMessage } from '../../src/mesh/worker-handoff-dispatch.js';
import { validateWorkerCompletionReport } from '../../src/mesh/worker-report-validation.js';

const MESH = 'mesh-A';
const MISSION = 'mission-1';
const base = Date.now() - 3_600_000;
const opts = { taskMode: 'code_change', difficulty: 'medium' } as any;

describe('mission artifact auto-inherit', () => {
    let tempRoot: string;
    let prevConfigDir: string | undefined;
    let artifacts: ArtifactStore;
    let seq = 0;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-input-artifacts-'));
        prevConfigDir = process.env.ADHDEV_CONFIG_DIR;
        process.env.ADHDEV_CONFIG_DIR = path.join(tempRoot, 'config');
        fs.mkdirSync(process.env.ADHDEV_CONFIG_DIR, { recursive: true });
        MeshRuntimeStore.resetForTests();
        artifacts = new ArtifactStore(MeshRuntimeStore.getInstance().db);
        seq = 0;
    });
    afterEach(() => {
        MeshRuntimeStore.resetForTests();
        if (prevConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
        else process.env.ADHDEV_CONFIG_DIR = prevConfigDir;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    /** A finished task of `mission` and (optionally) an artifact it produced. */
    function finishedTask(mission: string | undefined, status: 'completed' | 'failed' | 'blocked' | 'cancelled' | 'assigned', meshId = MESH) {
        const task = enqueueTask(meshId, `work ${seq}`, { ...opts, ...(mission ? { missionId: mission } : {}), inheritArtifacts: false });
        const store = MeshRuntimeStore.getInstance();
        store.updateQueueEntry({ ...store.findQueueEntryById(meshId, task.id)!, status } as any);
        return task;
    }
    function art(p: { id?: string; taskId?: string | null; role?: string; mesh?: string; mission?: string | null; title?: string; preview?: string; kind?: string }) {
        seq += 1;
        const id = p.id ?? `art_${String(seq).padStart(16, '0')}`;
        artifacts.upsertForwarded({
            artifactId: id,
            sessionId: `sess-${seq}`,
            meshId: p.mesh ?? MESH,
            ...(p.mission === null ? {} : { missionId: p.mission ?? MISSION }),
            ...(p.taskId === null ? {} : { taskId: p.taskId ?? `task-${seq}` }),
            producerRole: (p.role ?? 'worker') as any,
            originDaemonId: 'daemon-x',
            workspaceRoot: '/ws',
            relPath: `out/${id}.md`,
            kind: (p.kind ?? 'markdown') as any,
            mime: 'text/markdown',
            title: p.title ?? `Finding ${seq}`,
            sizeBytes: 10,
            sha256: 'a'.repeat(64),
            previewText: p.preview ?? `preview ${seq}`,
            createdAt: base + seq * 1000,
            updatedAt: base + seq * 1000,
        } as any);
        return id;
    }

    it('inherits terminal same-mission artifacts newest-first; skips other mission/mesh, running, cancelled and unattributed worker files', () => {
        const done = finishedTask(MISSION, 'completed');
        const failed = finishedTask(MISSION, 'failed');
        const running = finishedTask(MISSION, 'assigned');
        const cancelled = finishedTask(MISSION, 'cancelled');
        const otherMissionTask = finishedTask('mission-2', 'completed');
        const otherMeshTask = finishedTask(MISSION, 'completed', 'mesh-B');

        const a1 = art({ taskId: done.id });
        const a2 = art({ taskId: failed.id });
        art({ taskId: running.id });
        art({ taskId: cancelled.id });
        art({ taskId: otherMissionTask.id, mission: 'mission-2' });
        art({ taskId: otherMeshTask.id, mesh: 'mesh-B' });
        art({ taskId: 'task-unknown' });
        art({ taskId: null, role: 'worker' });
        const coord = art({ taskId: null, role: 'coordinator' });

        const next = enqueueTask(MESH, 'follow-up', { ...opts, missionId: MISSION });
        expect(next.inputArtifactIds).toEqual([coord, a2, a1]);
        expect(resolveInheritedArtifactIds(MESH, MISSION)).toEqual([coord, a2, a1]);
    });

    it('keeps explicit ids first, dedupes against them, and never inherits for a missionless task', () => {
        const done = finishedTask(MISSION, 'completed');
        const a1 = art({ taskId: done.id });
        const a2 = art({ taskId: done.id });

        const task = enqueueTask(MESH, 'follow-up', { ...opts, missionId: MISSION, inputArtifactIds: [a1, 'art_external'] });
        expect(task.inputArtifactIds).toEqual([a1, 'art_external', a2]);

        const missionless = enqueueTask(MESH, 'no mission', opts);
        expect(missionless.inputArtifactIds).toBeUndefined();
    });

    it(`bounds the auto-added ids to ${MAX_INHERITED_INPUT_ARTIFACTS} (newest) without truncating explicit ids`, () => {
        const done = finishedTask(MISSION, 'completed');
        const ids = Array.from({ length: 15 }, () => art({ taskId: done.id }));
        const explicit = ['art_x1', 'art_x2'];
        const task = enqueueTask(MESH, 'follow-up', { ...opts, missionId: MISSION, inputArtifactIds: explicit });
        expect(task.inputArtifactIds).toEqual([...explicit, ...ids.slice(-MAX_INHERITED_INPUT_ARTIFACTS).reverse()]);
        expect(task.inputArtifactIds).toHaveLength(2 + MAX_INHERITED_INPUT_ARTIFACTS);
    });

    it('honours the opt-out (camel and snake) and persists it', () => {
        const done = finishedTask(MISSION, 'completed');
        art({ taskId: done.id });
        const off = enqueueTask(MESH, 'isolated', { ...opts, missionId: MISSION, inheritArtifacts: false });
        expect(off.inputArtifactIds).toBeUndefined();
        expect(off.inheritArtifacts).toBe(false);
        const snake = enqueueTask(MESH, 'isolated 2', { ...opts, missionId: MISSION, inherit_artifacts: false, inputArtifactIds: ['art_keep'] });
        expect(snake.inputArtifactIds).toEqual(['art_keep']);
        const on = enqueueTask(MESH, 'default', { ...opts, missionId: MISSION });
        expect(on.inheritArtifacts).toBeUndefined();
        expect(on.inputArtifactIds).toHaveLength(1);
    });

    it('direct dispatch records inherited ids too (and honours the opt-out)', () => {
        const done = finishedTask(MISSION, 'completed');
        const a1 = art({ taskId: done.id });
        const entry = recordDirectDispatchTask(MESH, 'direct follow-up', { ...opts, id: 'direct-1', missionId: MISSION, assignedNodeId: 'n1', assignedSessionId: 's1' } as any)!;
        expect(entry.inputArtifactIds).toEqual([a1]);
        const off = recordDirectDispatchTask(MESH, 'direct isolated', { ...opts, id: 'direct-2', missionId: MISSION, inheritArtifacts: false, assignedNodeId: 'n1', assignedSessionId: 's2' } as any)!;
        expect(off.inputArtifactIds).toBeUndefined();
    });

    it('claim-time refresh picks up artifacts produced AFTER enqueue and persists them', () => {
        const early = enqueueTask(MESH, 'enqueued before predecessors finished', { ...opts, missionId: MISSION });
        expect(early.inputArtifactIds).toBeUndefined();
        const done = finishedTask(MISSION, 'completed');
        const a1 = art({ taskId: done.id });
        const refreshed = refreshInheritedInputArtifacts(MESH, early);
        expect(refreshed.inputArtifactIds).toEqual([a1]);
        expect(MeshRuntimeStore.getInstance().findQueueEntryById(MESH, early.id)!.inputArtifactIds).toEqual([a1]);
        // Opted-out rows are untouched.
        const off = enqueueTask(MESH, 'off', { ...opts, missionId: MISSION, inheritArtifacts: false });
        expect(refreshInheritedInputArtifacts(MESH, off).inputArtifactIds).toBeUndefined();
    });

    it('renders a compact manifest in the dispatched worker message', () => {
        const done = finishedTask(MISSION, 'completed');
        const a1 = art({ taskId: done.id, title: 'Root cause of the stall', preview: 'The queue claim tick held the lock\nacross a spawn.', kind: 'markdown' });
        const task = enqueueTask(MESH, 'fix the stall', { ...opts, missionId: MISSION });
        const body = resolveDispatchMessage(task, MESH, null);
        expect(body).toContain(INPUT_ARTIFACTS_HEADING);
        expect(body).toContain(a1);
        expect(body).toContain('Root cause of the stall');
        expect(body).toContain('producer_task="' + done.id + '"');
        expect(body).toContain('kind="markdown"');
        expect(body).toContain('The queue claim tick held the lock across a spawn.');
        expect(body).toContain('artifact_read');
        expect(body).toMatch(/do not redo investigation/);
        expect(body).toContain('trust="untrusted"');
        // authored text first, footer last
        expect(body.indexOf('fix the stall')).toBeLessThan(body.indexOf(INPUT_ARTIFACTS_HEADING));
        // no artifacts → no manifest
        const plain = resolveDispatchMessage(enqueueTask(MESH, 'unrelated', opts), MESH, null);
        expect(plain).not.toContain(INPUT_ARTIFACTS_HEADING);
        // opted-out task with no explicit ids → no manifest even though the mission has artifacts
        const off = enqueueTask(MESH, 'isolated', { ...opts, missionId: MISSION, inheritArtifacts: false });
        expect(resolveDispatchMessage(off, MESH, null)).not.toContain(INPUT_ARTIFACTS_HEADING);
    });

    it('manifest never lists a record bound to another mesh, and stays within its byte budget', () => {
        const done = finishedTask(MISSION, 'completed');
        const foreign = art({ taskId: done.id, mesh: 'mesh-B', title: 'FOREIGN-TITLE' });
        const ids = Array.from({ length: 12 }, () => art({ taskId: done.id, title: 'T'.repeat(200), preview: 'p'.repeat(600) }));
        const manifest = buildInputArtifactManifestAppendix(MESH, { id: 'x', inputArtifactIds: [foreign, ...ids] })!;
        expect(manifest).not.toContain('FOREIGN-TITLE');
        expect(Buffer.byteLength(manifest, 'utf8')).toBeLessThanOrEqual(6 * 1024 + 600);
        expect(manifest).toContain(ids[0]);
    });

    it('metric: share of dispatched tasks with at least one input artifact', () => {
        const done = finishedTask(MISSION, 'completed');
        art({ taskId: done.id });
        const withInputs = enqueueTask(MESH, 'a', { ...opts, missionId: MISSION });
        const without = enqueueTask(MESH, 'b', opts);
        const store = MeshRuntimeStore.getInstance();
        for (const t of [withInputs, without]) store.updateQueueEntry({ ...store.findQueueEntryById(MESH, t.id)!, status: 'assigned' } as any);
        enqueueTask(MESH, 'still pending', { ...opts, missionId: MISSION }); // pending: not counted
        // `done` was created with the opt-out and no explicit ids → dispatched without inputs.
        expect(getInputArtifactDispatchStats(MESH)).toEqual({ dispatched: 3, withInputArtifacts: 1, share: 0.333 });
        expect(getInputArtifactDispatchStats('mesh-empty')).toEqual({ dispatched: 0, withInputArtifacts: 0, share: 0 });
    });

    it('report_completion accepts optional artifactIds and rejects malformed ones', () => {
        const ok = validateWorkerCompletionReport({ outcome: 'completed', summary: 's', touchedFiles: [], artifactIds: ['art_1', 'art_1', 'art_2'] });
        expect(ok.errors).toEqual([]);
        expect(ok.report?.artifactIds).toEqual(['art_1', 'art_2']);
        const bad = validateWorkerCompletionReport({ outcome: 'completed', summary: 's', touchedFiles: [], artifactIds: 'art_1' });
        expect(bad.errors.map(e => e.field)).toContain('artifactIds');
    });
});

describe('mission artifact discovery for a coordinator without a session', () => {
    let tempRoot: string;
    let prevConfigDir: string | undefined;
    let router: DaemonCommandRouter;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-mission-list-'));
        prevConfigDir = process.env.ADHDEV_CONFIG_DIR;
        process.env.ADHDEV_CONFIG_DIR = path.join(tempRoot, 'config');
        fs.mkdirSync(process.env.ADHDEV_CONFIG_DIR, { recursive: true });
        MeshRuntimeStore.resetForTests();
        const meshStore = MeshRuntimeStore.getInstance();
        const store = new ArtifactStore(meshStore.db);
        const deps: CommandRouterDeps = {
            commandHandler: { handle: async () => ({ success: true }) } as any,
            cliManager: {} as any,
            cdpManagers: new Map(),
            providerLoader: {} as any,
            instanceManager: { getInstance: () => undefined } as any,
            detectedIdes: { value: [] },
            sessionRegistry: new SessionRegistry(),
        };
        setArtifactCommandRuntimeForDeps(deps, { artifactStore: store, meshRuntimeStore: meshStore });
        router = new DaemonCommandRouter(deps);
        const mk = (id: string, meshId: string, missionId: string, sessionId: string) => store.upsertForwarded({
            artifactId: id, sessionId, meshId, missionId, taskId: `t-${id}`, producerRole: 'worker', originDaemonId: 'd',
            workspaceRoot: '/ws', relPath: `o/${id}.md`, kind: 'markdown', mime: 'text/markdown', title: id, sizeBytes: 1,
            sha256: 'b'.repeat(64), previewText: null, createdAt: base, updatedAt: base,
        } as any);
        mk('art_00000000000000a1', 'mesh-A', 'm1', 'sess-1');
        mk('art_00000000000000a2', 'mesh-A', 'm2', 'sess-2');
        mk('art_00000000000000b1', 'mesh-B', 'm1', 'sess-3');
    });
    afterEach(() => {
        MeshRuntimeStore.resetForTests();
        if (prevConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
        else process.env.ADHDEV_CONFIG_DIR = prevConfigDir;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it('mesh_mission_artifact_list returns only that mesh+mission, metadata only', async () => {
        const res = await router.execute('mesh_mission_artifact_list', { meshId: 'mesh-A', missionId: 'm1' }, 'ipc');
        expect(res.success).toBe(true);
        expect((res.artifacts as any[]).map(a => a.artifactId)).toEqual(['art_00000000000000a1']);
        expect(res.content).toBeUndefined();
        const other = await router.execute('mesh_mission_artifact_list', { meshId: 'mesh-B', missionId: 'm1' }, 'ipc');
        expect((other.artifacts as any[]).map(a => a.artifactId)).toEqual(['art_00000000000000b1']);
        const none = await router.execute('mesh_mission_artifact_list', { meshId: 'mesh-A', missionId: 'nope' }, 'ipc');
        expect(none.artifacts).toEqual([]);
        const incomplete = await router.execute('mesh_mission_artifact_list', { meshId: 'mesh-A' }, 'ipc');
        expect(incomplete.success).toBe(false);
    });

    it('artifact_list stays as strict as before: session-less IPC is still rejected, mission or not', async () => {
        for (const args of [
            { meshId: 'mesh-A', missionId: 'm1' },
            { meshId: 'mesh-A' },
            { meshId: 'mesh-A', missionId: 'm1', requireMeshMembership: true },
            { meshId: 'mesh-A', missionId: 'm1', token: 'tok' },
        ]) {
            const res = await router.execute('artifact_list', args as any, 'ipc');
            expect(res.success, JSON.stringify(args)).toBe(false);
            expect(res.artifacts).toBeUndefined();
        }
    });
});
