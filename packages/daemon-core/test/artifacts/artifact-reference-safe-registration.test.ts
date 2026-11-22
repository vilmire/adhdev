/**
 * Reference-safe artifact registration: soft counts, non-destructive retention,
 * SQL keyset paging past the hot window, idempotent retries, budget errors.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    ARTIFACT_METADATA_BUDGET_BYTES,
    ARTIFACT_PAYLOAD_BUDGET_BYTES,
    ArtifactGuardError,
    ArtifactStore,
    MAX_ARTIFACTS_PER_MESH,
    MAX_ARTIFACTS_PER_MISSION,
    MAX_ARTIFACTS_PER_SESSION,
    assertArtifactAdmissionAllows,
    estimateArtifactMetadataBytes,
    readArtifactAdmissionTotals,
} from '../../src/artifacts/index.js';
import { MemoryArtifactDb } from './memory-artifact-db.js';

describe('artifact reference-safe registration', () => {
    let tempRoot: string;
    let workspaceDir: string;
    let store: ArtifactStore;
    let db: MemoryArtifactDb;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-art-safe-'));
        workspaceDir = path.join(tempRoot, 'ws');
        fs.mkdirSync(workspaceDir, { recursive: true });
        db = new MemoryArtifactDb();
        store = new ArtifactStore(db);
    });

    afterEach(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it('admits beyond session50 / mission200 / mesh500 soft windows and keeps old IDs readable', () => {
        expect(MAX_ARTIFACTS_PER_SESSION).toBe(50);
        expect(MAX_ARTIFACTS_PER_MISSION).toBe(200);
        expect(MAX_ARTIFACTS_PER_MESH).toBe(500);
        const first: string[] = [];
        for (let i = 0; i < 51; i++) {
            const rel = `s_${i}.txt`;
            fs.writeFileSync(path.join(workspaceDir, rel), `s${i}`);
            const res = store.register({
                sessionId: 'sess-soft',
                workspaceRoot: workspaceDir,
                path: rel,
                missionId: 'mission-soft',
                meshId: 'mesh-soft',
                now: 1_000 + i,
            });
            if (i < 2) first.push(res.record.artifactId);
        }
        expect(store.countBySession('sess-soft')).toBe(51);
        expect(store.get(first[0]!)?.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(store.listBySession('sess-soft')).toHaveLength(50);

        for (let i = 0; i < 201; i++) {
            const rel = `m_${i}.txt`;
            fs.writeFileSync(path.join(workspaceDir, rel), `m${i}`);
            store.register({
                sessionId: `sess-m-${Math.floor(i / 40)}`,
                workspaceRoot: workspaceDir,
                path: rel,
                missionId: 'mission-200',
                meshId: 'mesh-soft',
                now: 10_000 + i,
            });
        }
        expect(store.listByMission('mission-200')).toHaveLength(200);
        const oldMission = db
            .prepare<{ artifact_id: string }>(
                `SELECT artifact_id FROM session_artifacts WHERE mission_id = ? ORDER BY created_at ASC LIMIT 1`,
            )
            .get('mission-200');
        expect(store.get(oldMission!.artifact_id)?.missionId).toBe('mission-200');
    });

    it('idempotent same-source retry keeps one ID; pipeline revision conflict preserves prior row', () => {
        fs.writeFileSync(path.join(workspaceDir, 'report.json'), '{"a":1}');
        const first = store.register({
            sessionId: 'stage:parent-1',
            workspaceRoot: workspaceDir,
            path: 'report.json',
            producerRole: 'pipeline',
            meshId: 'mesh-idemp',
            title: 'report.json',
            now: 100,
        });
        const again = store.register({
            sessionId: 'stage:parent-1',
            workspaceRoot: workspaceDir,
            path: 'report.json',
            producerRole: 'pipeline',
            meshId: 'mesh-idemp',
            title: 'report.json',
            now: 200,
        });
        expect(again.record.artifactId).toBe(first.record.artifactId);
        expect(again.record.updatedAt).toBe(first.record.updatedAt);

        fs.writeFileSync(path.join(workspaceDir, 'report.json'), '{"a":2}');
        expect(() =>
            store.register({
                sessionId: 'stage:parent-1',
                workspaceRoot: workspaceDir,
                path: 'report.json',
                producerRole: 'pipeline',
                meshId: 'mesh-idemp',
            }),
        ).toThrow(ArtifactGuardError);
        try {
            store.register({
                sessionId: 'stage:parent-1',
                workspaceRoot: workspaceDir,
                path: 'report.json',
                producerRole: 'pipeline',
                meshId: 'mesh-idemp',
            });
        } catch (err) {
            expect((err as ArtifactGuardError).code).toBe('artifact_revision_conflict');
            expect((err as ArtifactGuardError).details?.preserved).toBe(true);
            expect((err as ArtifactGuardError).retryable).toBe(false);
        }
        expect(store.get(first.record.artifactId)?.sha256).toBe(first.record.sha256);
    });

    it('owner SQL keyset reaches past the soft 500 window and rejects stale cursors', () => {
        const meshId = 'mesh-page';
        const ids: string[] = [];
        for (let i = 0; i < 505; i++) {
            const rel = `n_${i}.md`;
            fs.writeFileSync(path.join(workspaceDir, rel), `# ${i}`);
            const res = store.register({
                sessionId: `sess-${Math.floor(i / 40)}`,
                workspaceRoot: workspaceDir,
                path: rel,
                meshId,
                now: 1_000_000 + i,
            });
            ids.push(res.record.artifactId);
        }
        expect(store.listByMesh(meshId)).toHaveLength(MAX_ARTIFACTS_PER_MESH);
        expect(store.get(ids[0]!)?.artifactId).toBe(ids[0]);

        const page1 = store.listByMeshKeyset(meshId, { limit: 3 });
        expect(page1.records).toHaveLength(3);
        expect(page1.hasMore).toBe(true);
        expect(page1.nextCursor).toBeTruthy();
        // Page is oldest-first of the newest window; next page continues toward older rows.
        const page2 = store.listByMeshKeyset(meshId, {
            limit: 3,
            cursor: { createdAt: page1.records[0]!.createdAt, artifactId: page1.records[0]!.artifactId },
        });
        expect(page2.records).toHaveLength(3);
        expect(page2.records.map((r) => r.artifactId)).not.toContain(page1.records[0]!.artifactId);
        expect(page2.records.map((r) => r.artifactId)).not.toEqual(page1.records.map((r) => r.artifactId));
        // Direct ID read of a row older than the soft 500 hot window.
        expect(store.get(ids[0]!)?.artifactId).toBe(ids[0]);

        expect(() =>
            store.listByMeshKeyset(meshId, {
                cursor: { createdAt: 1, artifactId: 'art_deadbeefdeadbeef' },
                limit: 2,
            }),
        ).toThrow(/stale_cursor/);
    });

    it('same-bytes origin_daemon alias forms are equivalent; different machines conflict', () => {
        fs.writeFileSync(path.join(workspaceDir, 'alias.md'), '# alias');
        const first = store.register({
            sessionId: 'sess-alias',
            workspaceRoot: workspaceDir,
            path: 'alias.md',
            title: 'alias.md',
            originDaemonId: 'daemon_mach_abcdef0123456789abcdef0123456789',
            now: 1_000,
        });
        const aliasOk = store.register({
            sessionId: 'sess-alias',
            workspaceRoot: workspaceDir,
            path: 'alias.md',
            title: 'alias.md',
            originDaemonId: 'mach_abcdef0123456789abcdef0123456789',
            now: 2_000,
        });
        expect(aliasOk.record.artifactId).toBe(first.record.artifactId);
        expect(aliasOk.isUpdate).toBe(true);
        expect(() =>
            store.register({
                sessionId: 'sess-alias',
                workspaceRoot: workspaceDir,
                path: 'alias.md',
                title: 'alias.md',
                originDaemonId: 'daemon_mach_99999999999999999999999999999999',
                now: 3_000,
            }),
        ).toThrow(/attribution origin_daemon_id conflict/);
    });

    it('same-bytes re-register fills null mesh/mission/task attribution for list/grant paths', () => {
        fs.writeFileSync(path.join(workspaceDir, 'evidence.md'), '# evidence');
        const first = store.register({
            sessionId: 'sess-attr',
            workspaceRoot: workspaceDir,
            path: 'evidence.md',
            title: 'evidence.md',
            now: 1_000,
        });
        expect(first.record.meshId).toBeUndefined();
        const again = store.register({
            sessionId: 'sess-attr',
            workspaceRoot: workspaceDir,
            path: 'evidence.md',
            title: 'evidence.md',
            meshId: 'mesh-attr',
            missionId: 'mission-attr',
            taskId: 'task-attr',
            now: 2_000,
        });
        expect(again.record.artifactId).toBe(first.record.artifactId);
        expect(again.record.meshId).toBe('mesh-attr');
        expect(again.record.missionId).toBe('mission-attr');
        expect(again.record.taskId).toBe('task-attr');
        expect(store.listByMesh('mesh-attr').map((r) => r.artifactId)).toContain(first.record.artifactId);
        expect(() =>
            store.register({
                sessionId: 'sess-attr',
                workspaceRoot: workspaceDir,
                path: 'evidence.md',
                title: 'evidence.md',
                meshId: 'mesh-other',
                now: 3_000,
            }),
        ).toThrow(/attribution mesh_id conflict/);
    });

    it('forwarded same-bytes fills null attribution without rewriting content identity', () => {
        const body = Buffer.from('forwarded-bytes');
        const sha = createHash('sha256').update(body).digest('hex');
        const first = store.upsertForwarded({
            artifactId: 'art_0123456789abcdef',
            sessionId: 'peer-sess',
            relPath: 'out.txt',
            workspaceRoot: workspaceDir,
            kind: 'text',
            mime: 'text/plain',
            title: 'out.txt',
            sizeBytes: body.length,
            sha256: sha,
            originDaemonId: 'daemon_a',
            createdAt: 1_000,
            updatedAt: 1_000,
        });
        const again = store.upsertForwarded({
            artifactId: 'art_0123456789abcdef',
            sessionId: 'peer-sess',
            relPath: 'out.txt',
            workspaceRoot: workspaceDir,
            kind: 'text',
            mime: 'text/plain',
            title: 'out.txt',
            sizeBytes: body.length,
            sha256: sha,
            originDaemonId: 'daemon_a',
            meshId: 'mesh-fwd',
            missionId: 'mission-fwd',
            taskId: 'task-fwd',
            createdAt: 1_000,
            updatedAt: 2_000,
        });
        expect(again.record.artifactId).toBe(first.record.artifactId);
        expect(again.record.meshId).toBe('mesh-fwd');
        expect(store.listByMesh('mesh-fwd').map((r) => r.artifactId)).toContain(first.record.artifactId);
    });

    it('admission SQL bills Unicode metadata as UTF-8 bytes (not SQLite character LENGTH)', () => {
        // Source-shape: production SQL must CAST to BLOB for byte length.
        const admissionSrc = fs.readFileSync(
            path.join(__dirname, '../../src/artifacts/artifact-admission.ts'),
            'utf8',
        );
        expect(admissionSrc).toMatch(/LENGTH\(CAST\(COALESCE\([^)]+\) AS BLOB\)\)/);
        expect(admissionSrc).not.toMatch(/LENGTH\(COALESCE\(title,/);

        // Title is capped at 200 code points; put Hangul in workspaceRoot (forwarded) to exceed the 4KiB floor.
        const hangulRoot = `/remote/${'한'.repeat(2000)}`;
        expect(hangulRoot.length).toBeLessThan(Buffer.byteLength(hangulRoot, 'utf8'));
        const reg = store.upsertForwarded({
            artifactId: 'art_fedcba9876543210',
            sessionId: 'sess-unicode',
            relPath: 'u.txt',
            workspaceRoot: hangulRoot,
            kind: 'text',
            mime: 'text/plain',
            title: 'u.txt',
            sizeBytes: 1,
            sha256: 'b'.repeat(64),
            originDaemonId: 'daemon_u',
            createdAt: 5_000,
            updatedAt: 5_000,
        });
        const fromRow = estimateArtifactMetadataBytes({
            artifactId: reg.record.artifactId,
            sessionId: reg.record.sessionId,
            title: reg.record.title,
            relPath: reg.record.relPath,
            kind: reg.record.kind,
            mime: reg.record.mime,
            sha256: reg.record.sha256,
            previewText: reg.record.previewText,
            workspaceRoot: reg.record.workspaceRoot,
            originDaemonId: reg.record.originDaemonId,
            producerRole: reg.record.producerRole,
            taskId: reg.record.taskId,
            meshId: reg.record.meshId,
            missionId: reg.record.missionId,
        });
        expect(fromRow).toBeGreaterThan(4096);
        expect(Buffer.byteLength(reg.record.workspaceRoot, 'utf8')).toBeGreaterThan(reg.record.workspaceRoot.length);
        expect(readArtifactAdmissionTotals(db).metadataBytes).toBe(fromRow);
    });

    it('refuses deleteBySession and runtime age prune; budgets are hard with preserved=true', () => {
        fs.writeFileSync(path.join(workspaceDir, 'keep.md'), '# keep');
        const rec = store.register({
            sessionId: 'sess-keep',
            workspaceRoot: workspaceDir,
            path: 'keep.md',
            now: Date.now() - 40 * 24 * 60 * 60 * 1000,
        });
        expect(store.pruneExpired(Date.now())).toBe(0);
        expect(store.get(rec.record.artifactId)).not.toBeNull();
        expect(() => store.deleteBySession('sess-keep')).toThrow(/artifact_preserved_refuse_delete/);
        expect(store.get(rec.record.artifactId)).not.toBeNull();

        expect(ARTIFACT_METADATA_BUDGET_BYTES).toBe(64 * 1024 * 1024);
        expect(ARTIFACT_PAYLOAD_BUDGET_BYTES).toBe(1024 * 1024 * 1024);
        expect(() =>
            assertArtifactAdmissionAllows(
                { rowCount: 1, metadataBytes: ARTIFACT_METADATA_BUDGET_BYTES, payloadBytes: 0 },
                { metadataBytes: estimateArtifactMetadataBytes({ artifactId: 'art_0123456789abcdef', sessionId: 's', relPath: 'x.md', kind: 'markdown', mime: 'text/markdown', title: 'x', sha256: 'a'.repeat(64) }), payloadBytes: 1 },
            ),
        ).toThrow(/artifact_storage_budget_exceeded/);
    });

});

describe('mesh runtime retention source shape', () => {
    it('turn-rows retention no longer issues DELETE FROM session_artifacts', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/mesh/mesh-runtime-store-turn-rows.ts'),
            'utf8',
        );
        expect(src).not.toMatch(/DELETE FROM session_artifacts/);
        expect(src).toMatch(/Reference-safe preservation/);
        expect(src).toMatch(/MESH_SESSION_ARTIFACTS_RETENTION_MS = 30 \* 24 \* 60 \* 60 \* 1000/);
    });
});
