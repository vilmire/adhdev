import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeNativeHistoryList } from '../../../src/providers/spec/native-history-executor.js';
import { loadBetterSqlite3 } from '../../../src/system/load-better-sqlite3.js';

const base = {
    kind: 'sqlite' as const, session_query: 'SELECT id FROM session', message_query: 'SELECT 1', message_map: { role: '$.role', content: '$.content' },
};
function makeDb(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-list-'));
    const file = path.join(dir, 'store.db');
    const db = new (loadBetterSqlite3())(file);
    db.exec('CREATE TABLE session (id text, directory text, title text, time_created integer, time_updated integer)');
    db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run('s1', '/opt/ws-a', 'Older', 1000, 2000);
    db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run('s2', '/opt/ws-b', 'Newer', 3000, 4000);
    db.close();
    return file;
}
describe('sqlite native-history listing', () => {
    it('lists sessions through list_query, newest first', () => {
        const file = makeDb();
        const r = executeNativeHistoryList({ source: { ...base, path: file,
            list_query: 'SELECT id, title, directory AS workspace, time_created AS first_at, time_updated AS last_at FROM session' } } as any, {});
        expect(r?.sessions.map(s => s.historySessionId)).toEqual(['s2', 's1']);
        expect(r?.sessions[0]).toMatchObject({ sessionTitle: 'Newer', workspace: '/opt/ws-b', lastMessageAt: 4000 });
    });
    it('keeps the previous behaviour (no listing) without list_query', () => {
        expect(executeNativeHistoryList({ source: { ...base, path: makeDb() } } as any, {})).toBeNull();
    });
});
