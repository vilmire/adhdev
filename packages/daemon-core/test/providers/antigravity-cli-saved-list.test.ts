/**
 * Antigravity CLI saved-session listing (conversation_summaries.db index +
 * history.jsonl fallback) through the list dispatcher that backs
 * `list_saved_sessions`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { createNativeHistoryListDispatcher } from '../../src/providers/native-history/dispatcher.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const GONE = 'dddddddd-0000-4000-8000-000000000004';
const CHILD = 'eeeeeeee-0000-4000-8000-000000000005';
const H = 'ffffffff-0000-4000-8000-000000000006';

let home: string;
let prevHome: string | undefined;
let root: string;

function seed(rows: Array<Record<string, unknown>>) {
  const db = new Database(path.join(root, 'conversation_summaries.db'));
  db.exec(`CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT '', preview text NOT NULL DEFAULT '', step_count integer NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL, workspace_uris text NOT NULL DEFAULT '[]', parent_conversation_id text NOT NULL DEFAULT '')`);
  const ins = db.prepare('INSERT INTO conversation_summaries (conversation_id,title,preview,step_count,last_modified_time,workspace_uris,parent_conversation_id) VALUES (?,?,?,?,?,?,?)');
  for (const r of rows) ins.run(r.id, r.title ?? '', r.preview ?? '', r.steps ?? 0, r.time, r.ws ?? '[]', r.parent ?? '');
  db.close();
}
const touch = (id: string, ext = 'db') => fs.writeFileSync(path.join(root, 'conversations', `${id}.${ext}`), '');
const list = (args: Record<string, unknown> = {}) =>
  (createNativeHistoryListDispatcher('antigravity-cli') as any)({ args }).sessions as any[];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-list-'));
  prevHome = process.env.HOME;
  process.env.HOME = home;
  root = path.join(home, '.gemini', 'antigravity-cli');
  fs.mkdirSync(path.join(root, 'conversations'), { recursive: true });
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('antigravity-cli saved-session listing', () => {
  it('returns [] for an empty store', () => {
    expect(list()).toEqual([]);
  });

  it('lists indexed conversations with id, title, workspace, count, ordered by last activity', () => {
    seed([
      { id: A, title: 'Fix login', preview: 'older preview', steps: 12, time: '2026-07-16 13:42:17.096746+00:00', ws: '["file:///Users/x/Work/my%20proj"]' },
      { id: B, preview: 'only a preview', steps: 3, time: '2026-08-01 10:00:00.000000+00:00', ws: '["file:///Users/x/Work/other"]' },
      { id: C, title: 'Zero time', steps: 1, time: '0001-01-01 00:00:00+00:00' },
      { id: GONE, title: 'deleted', time: '2026-09-01 00:00:00+00:00' },
      { id: CHILD, title: 'sub agent', time: '2026-09-02 00:00:00+00:00', parent: A },
    ]);
    touch(A); touch(B); touch(C, 'pb');
    const out = list();
    expect(out.map((s) => s.historySessionId)).toEqual([C, B, A]);
    const a = out.find((s) => s.historySessionId === A);
    expect(a).toMatchObject({ sessionId: A, sessionTitle: 'Fix login', messageCount: 12, workspace: '/Users/x/Work/my proj', agent: 'antigravity-cli', source: 'provider-native' });
    expect(a.lastMessageAt).toBe(Date.parse('2026-07-16T13:42:17.096Z'));
    // title falls back to preview
    expect(out.find((s) => s.historySessionId === B).sessionTitle).toBe('only a preview');
    // 0001-01-01 time falls back to file mtime (newest here), not 0
    expect(out.find((s) => s.historySessionId === C).lastMessageAt).toBeGreaterThan(0);
  });

  it('adds history.jsonl-only conversations as partial entries and honours limit', () => {
    seed([{ id: A, title: 'Indexed', steps: 2, time: '2026-07-16 13:42:17+00:00' }]);
    touch(A);
    fs.writeFileSync(path.join(root, 'history.jsonl'), [
      JSON.stringify({ display: 'hello world', timestamp: Date.parse('2026-10-01T00:00:00Z'), workspace: '/w/h', conversationId: H }),
      JSON.stringify({ display: 'no conv id', timestamp: 1, workspace: '/w' }),
    ].join('\n'));
    const out = list();
    expect(out.map((s) => s.historySessionId)).toEqual([H, A]);
    expect(out[0]).toMatchObject({ workspace: '/w/h', nativeHistoryCoverage: 'partial', sessionTitle: 'hello world' });
    expect(list({ limit: 1 })).toHaveLength(1);
  });

  it('survives a missing or corrupt summaries db (falls back to history.jsonl)', () => {
    fs.writeFileSync(path.join(root, 'conversation_summaries.db'), 'not sqlite');
    expect(list()).toEqual([]);
  });
});
