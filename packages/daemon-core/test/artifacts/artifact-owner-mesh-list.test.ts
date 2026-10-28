/**
 * Dashboard Artifacts tab: a trusted OWNER may `artifact_list { meshId }` without a
 * session (mesh-wide, mission/kind filters, keyset pagination); non-owner callers
 * keep the existing authorization flow.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { DaemonCommandRouter, type CommandRouterDeps } from '../../src/commands/router.js';
import { setArtifactCommandRuntimeForDeps } from '../../src/commands/med-family/artifact-runtime.js';
import { SessionRegistry } from '../../src/sessions/registry.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { ensureSessionArtifactsSchema } from '../../src/mesh/mesh-runtime-store-schema.js';

describe('owner mesh-wide artifact_list', () => {
    let tempRoot: string;
    let prevConfigDir: string | undefined;
    let store: ArtifactStore;
    let router: DaemonCommandRouter;
    const base = Date.now() - 3_600_000;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-owner-mesh-list-'));
        prevConfigDir = process.env.ADHDEV_CONFIG_DIR;
        process.env.ADHDEV_CONFIG_DIR = path.join(tempRoot, 'config');
        fs.mkdirSync(process.env.ADHDEV_CONFIG_DIR, { recursive: true });
        MeshRuntimeStore.resetForTests();
        const meshStore = MeshRuntimeStore.getInstance();
        store = new ArtifactStore(meshStore.db);
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

        const files: Array<[string, string, string, string, string]> = [
            // file, session, mesh, mission, content
            ['a0.md', 'sess-0', 'mesh-A', 'm1', '# a0'],
            ['a1.json', 'sess-1', 'mesh-A', 'm1', '{"a":1}'],
            ['a2.md', 'sess-0', 'mesh-A', 'm2', '# a2'],
            ['a3.md', 'sess-9', 'mesh-B', 'm9', '# other mesh'],
            ['a4.md', 'sess-1', 'mesh-A', '', '# unassigned'],
        ];
        files.forEach(([file, sessionId, meshId, missionId, content], i) => {
            fs.writeFileSync(path.join(tempRoot, file), content);
            store.register({
                sessionId,
                workspaceRoot: tempRoot,
                path: file,
                meshId,
                ...(missionId ? { missionId } : {}),
                taskId: `task-${i}`,
                producerRole: 'worker',
                now: base + i * 1000,
            });
        });
        // An artifact indexed from another daemon lands in the same table.
        store.upsertForwarded({
            artifactId: 'art_00000000000000f1',
            sessionId: 'sess-remote',
            meshId: 'mesh-A',
            missionId: 'm1',
            taskId: 'task-remote',
            producerRole: 'worker',
            originDaemonId: 'daemon-remote',
            workspaceRoot: '/remote/ws',
            relPath: 'out/report.md',
            kind: 'markdown',
            mime: 'text/markdown',
            title: 'Remote report',
            sizeBytes: 10,
            sha256: 'a'.repeat(64),
            previewText: 'remote preview',
            createdAt: base + 10_000,
            updatedAt: base + 10_000,
        });
    });

    afterEach(() => {
        MeshRuntimeStore.resetForTests();
        if (prevConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
        else process.env.ADHDEV_CONFIG_DIR = prevConfigDir;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    const ownerList = (args: Record<string, unknown>) =>
        router.execute('artifact_list', args, 'standalone', { ownerVerified: true });
    const paths = (res: any) => (res.artifacts as Array<{ relPath: string }>).map((a) => a.relPath);

    it('lists only that mesh, including forwarded records, without a session', async () => {
        const res = await ownerList({ meshId: 'mesh-A' });
        expect(res.success).toBe(true);
        expect(paths(res)).toEqual(['a0.md', 'a1.json', 'a2.md', 'a4.md', 'out/report.md']);
        expect(res.attachments).toHaveLength(5);
        expect((res.attachments as any[]).find((a) => a.originDaemonId === 'daemon-remote')?.taskId).toBe('task-remote');
        expect(res.hasMore).toBe(false);
        expect(res.content).toBeUndefined();
    });

    it('filters by mission and kind', async () => {
        expect(paths(await ownerList({ meshId: 'mesh-A', missionId: 'm1' }))).toEqual(['a0.md', 'a1.json', 'out/report.md']);
        expect(paths(await ownerList({ meshId: 'mesh-A', kind: 'json' }))).toEqual(['a1.json']);
        const bad = await ownerList({ meshId: 'mesh-A', kind: 'exe' });
        expect(bad.success).toBe(false);
    });

    it('paginates newest-first with a keyset cursor', async () => {
        const page1 = await ownerList({ meshId: 'mesh-A', limit: 2 });
        expect(paths(page1)).toEqual(['a4.md', 'out/report.md']);
        expect(page1.hasMore).toBe(true);
        const page2 = await ownerList({ meshId: 'mesh-A', limit: 2, cursor: page1.nextCursor });
        expect(paths(page2)).toEqual(['a1.json', 'a2.md']);
        const page3 = await ownerList({ meshId: 'mesh-A', limit: 2, cursor: page2.nextCursor });
        expect(paths(page3)).toEqual(['a0.md']);
        expect(page3.hasMore).toBe(false);
        expect(page3.nextCursor).toBeNull();
    });

    it('falls back to a (createdAt, artifactId) tuple when the cursor record was deleted', async () => {
        // Two same-millisecond siblings; the cursor points at the (soon deleted) newer one.
        const at = base + 20_000;
        const mk = (id: string) => store.upsertForwarded({
            artifactId: id, sessionId: 'sess-tie', meshId: 'mesh-A', taskId: 'task-tie', producerRole: 'worker',
            originDaemonId: 'daemon-remote', workspaceRoot: '/remote/ws', relPath: `tie/${id}.md`, kind: 'markdown',
            mime: 'text/markdown', title: id, sizeBytes: 1, sha256: 'b'.repeat(64), createdAt: at, updatedAt: at,
        });
        mk('art_0000000000000aa1');
        mk('art_0000000000000bb2');
        const cursor = `${at}:art_0000000000000bb2`;
        store.db.prepare('DELETE FROM session_artifacts WHERE artifact_id = ?').run('art_0000000000000bb2');
        const res = await ownerList({ meshId: 'mesh-A', limit: 50, cursor });
        const rel = paths(res);
        expect(rel).toContain('tie/art_0000000000000aa1.md');
        expect(rel).not.toContain('tie/art_0000000000000bb2.md');
        expect(rel).toContain('a0.md');
    });

    it('does not widen non-owner access', async () => {
        const res = await router.execute('artifact_list', { meshId: 'mesh-A' }, 'ipc');
        expect(res.success).toBe(false);
        expect(res.artifacts).toBeUndefined();
        const withSession = await router.execute('artifact_list', { meshId: 'mesh-A', sessionId: 'sess-unknown' }, 'standalone', { ownerVerified: true });
        expect(withSession.artifacts ?? []).not.toContain(undefined);
        expect((withSession as any).meshId).toBeUndefined();
    });

    it('mesh index exists and the schema ensure is idempotent', () => {
        const db = new Database(':memory:');
        ensureSessionArtifactsSchema(db as any);
        ensureSessionArtifactsSchema(db as any);
        const idx = db.prepare("PRAGMA index_info(idx_session_artifacts_mesh)").all() as Array<{ name: string }>;
        expect(idx.map((r) => r.name)).toEqual(['mesh_id', 'created_at']);
        db.close();
    });
});
