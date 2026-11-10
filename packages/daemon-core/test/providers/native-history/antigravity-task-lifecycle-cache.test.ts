import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetTaskLifecycleCacheForTests, __taskLifecycleReadStatsForTests, readTaskLifecycleSteps } from '../../../src/providers/native-history/antigravity-conversation-db.js';
import { loadBetterSqlite3 } from '../../../src/system/load-better-sqlite3.js';

const UUID = '11111111-2222-3333-4444-555555555555';
const launch = (n: number) => ({ payload: 'run_command', details: `${UUID}/task-${n}` });
let dir: string, file: string, db: any;

const insert = (idx: number, type: number, status: number, row: { payload?: string; details?: string } = {}) =>
    db.prepare('INSERT INTO steps (idx, step_type, status, step_payload, task_details) VALUES (?, ?, ?, ?, ?)')
        .run(idx, type, status, Buffer.from(row.payload ?? ''), row.details ? Buffer.from(row.details) : null);
const kinds = () => (readTaskLifecycleSteps(file) ?? []).map(s => `${s.idx}:${s.kind}${s.terminal ? ':terminal' : ''}`);

beforeEach(() => {
    __resetTaskLifecycleCacheForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-lifecycle-'));
    file = path.join(dir, `${UUID}.db`);
    const Database = loadBetterSqlite3();
    db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, task_details BLOB)');
    insert(0, 14, 3);
    insert(1, 21, 3, launch(1));
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('antigravity task lifecycle read cost', () => {
    it('does not touch the store while the file is unchanged', () => {
        expect(kinds()).toEqual(['0:user', '1:launch']);
        const before = __taskLifecycleReadStatsForTests();
        for (let i = 0; i < 5; i++) expect(kinds()).toEqual(['0:user', '1:launch']);
        expect(__taskLifecycleReadStatsForTests()).toEqual(before);
    });
    it('reads only the steps after the last settled one', () => {
        kinds();
        const before = __taskLifecycleReadStatsForTests();
        insert(2, 132, 3, { payload: `Task: ${UUID}/task-1\nStatus: DONE` });
        expect(kinds()).toEqual(['0:user', '1:launch', '2:status:terminal']);
        expect(__taskLifecycleReadStatsForTests().rows - before.rows).toBe(1);
    });
    it('sees a step that was still running grow in place', () => {
        insert(2, 132, 2, { payload: `Task: ${UUID}/task-1\nStatus: RUNNING` });
        insert(3, 14, 3);
        expect(kinds()).toEqual(['0:user', '1:launch', '2:status', '3:user']);
        db.prepare('UPDATE steps SET status = 3, step_payload = ? WHERE idx = 2').run(Buffer.from(`Task: ${UUID}/task-1\nStatus: DONE`));
        expect(kinds()).toEqual(['0:user', '1:launch', '2:status:terminal', '3:user']);
    });
    it('starts over when the store is replaced', () => {
        kinds();
        db.close();
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
        const Database = loadBetterSqlite3();
        db = new Database(file);
        db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, task_details BLOB)');
        insert(0, 14, 3);
        expect(kinds()).toEqual(['0:user']);
    });
    it('starts over when the store is rewritten in place (same inode, not smaller)', () => {
        // The address of the file proves nothing: Linux reuses a freed inode number
        // for the next file created, and an in-place rewrite keeps it everywhere.
        kinds();
        db.close();
        const before = fs.statSync(file);
        const replacement = path.join(dir, 'replacement.db');
        const Database = loadBetterSqlite3();
        const next = new Database(replacement);
        next.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, task_details BLOB)');
        const put = next.prepare('INSERT INTO steps (idx, step_type, status, step_payload, task_details) VALUES (?, ?, ?, ?, ?)');
        put.run(0, 14, 3, Buffer.from(''), null);
        put.run(5, 14, 3, Buffer.alloc(before.size, 0x78), null); // padding: the new store is not smaller
        next.close();
        for (const suffix of ['-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
        fs.writeFileSync(file, fs.readFileSync(replacement));
        const after = fs.statSync(file);
        expect(after.ino).toBe(before.ino);
        expect(after.size).toBeGreaterThanOrEqual(before.size);
        db = new Database(file);
        expect(kinds()).toEqual(['0:user', '5:user']);
    });
    it('keeps re-reading a store with no status column, and fails open on a missing file', () => {
        db.exec('ALTER TABLE steps RENAME COLUMN status TO state');
        expect(kinds()).toEqual(['0:user', '1:launch']);
        db.prepare('INSERT INTO steps (idx, step_type, state, step_payload, task_details) VALUES (2, 14, 3, ?, NULL)').run(Buffer.from(''));
        expect(kinds()).toEqual(['0:user', '1:launch', '2:user']);
        expect(readTaskLifecycleSteps(path.join(dir, 'missing.db'))).toBeNull();
    });
});
