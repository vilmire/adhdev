/**
 * Regression (mission b295ce35 U4): mesh/mission artifact listings with an
 * explicit `limit` must keep the NEWEST `limit` records. The previous
 * `ORDER BY created_at ASC LIMIT ?` returned the oldest window, so a coordinator
 * or assistant asking for the latest 20 artifacts never saw recent work once a
 * mesh had more than 20.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../src/artifacts/index.js';

describe('ArtifactStore mesh/mission listing window', () => {
    let tempRoot: string;
    let db: Database.Database;
    let store: ArtifactStore;
    const base = 200_000_000_000;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-artifact-window-'));
        db = new Database(':memory:');
        store = new ArtifactStore(db);
        for (let i = 0; i < 5; i += 1) {
            fs.writeFileSync(path.join(tempRoot, `a${i}.md`), `# artifact ${i}\n`);
            store.register({
                sessionId: `sess-${i % 2}`,
                workspaceRoot: tempRoot,
                path: `a${i}.md`,
                meshId: 'mesh-w',
                missionId: 'mission-w',
                producerRole: 'worker',
                now: base + i * 1000,
            });
        }
    });

    afterEach(() => {
        db.close();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    const titles = (records: { relPath: string }[]) => records.map((r) => r.relPath);

    it('listByMesh keeps the newest records within the limit, in creation order', () => {
        expect(titles(store.listByMesh('mesh-w', { limit: 2 }))).toEqual(['a3.md', 'a4.md']);
        expect(titles(store.listByMesh('mesh-w'))).toEqual(['a0.md', 'a1.md', 'a2.md', 'a3.md', 'a4.md']);
        expect(titles(store.listByMesh('mesh-w', { sessionId: 'sess-0', limit: 2 }))).toEqual(['a2.md', 'a4.md']);
    });

    it('listByMission keeps the newest records within the limit, with and without an artifactId allowlist', () => {
        expect(titles(store.listByMission('mission-w', { limit: 2 }))).toEqual(['a3.md', 'a4.md']);
        const all = store.listByMission('mission-w');
        const allowlist = [all[0].artifactId, all[1].artifactId, all[2].artifactId];
        expect(titles(store.listByMission('mission-w', { artifactIds: allowlist, limit: 2 }))).toEqual(['a1.md', 'a2.md']);
    });
});
