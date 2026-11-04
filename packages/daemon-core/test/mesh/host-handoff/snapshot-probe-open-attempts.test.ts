import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { findProbeConflicts } from '../../../src/mesh/host-handoff/snapshot-probe.js';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;
const emptyProbe = { history: {}, artifacts: [], items: [], memory: [] };

function member() {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE turn_attempts (attempt_id TEXT PRIMARY KEY, mesh_id TEXT, session_id TEXT, terminal_outcome TEXT, updated_at INTEGER)');
    db.exec('CREATE TABLE session_artifacts (artifact_id TEXT, mesh_id TEXT, session_id TEXT, rel_path TEXT)');
    db.exec('CREATE TABLE mesh_mission_items (id TEXT, mesh_id TEXT, mission_id TEXT, dedupe_key TEXT)');
    db.exec('CREATE TABLE assistant_memory_entry (id TEXT, scope TEXT, project_ref TEXT)');
    return db;
}

describe('host move conflict probe: open attempts on the target', () => {
    it('refuses while a recent open attempt of this project may still be working', () => {
        const db = member();
        db.prepare('INSERT INTO turn_attempts VALUES (?,?,?,?,?)').run('a1', 'm', 's1', null, NOW - HOUR);
        expect(findProbeConflicts(db, 'm', emptyProbe, NOW)).toEqual([
            expect.objectContaining({ table: 'turn_attempts', key: ['a1'] }),
        ]);
    });

    it('ignores settled attempts, stale open records and other projects', () => {
        const db = member();
        const add = db.prepare('INSERT INTO turn_attempts VALUES (?,?,?,?,?)');
        add.run('settled', 'm', 's1', 'completed', NOW - HOUR);
        add.run('stale', 'm', 's2', null, NOW - 3 * HOUR);
        add.run('other', 'other-project', 's3', null, NOW - HOUR);
        expect(findProbeConflicts(db, 'm', emptyProbe, NOW)).toEqual([]);
    });
});
