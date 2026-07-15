/**
 * SQLite native-history for opencode (workspace-scoped read + floor binding).
 *
 * Live smoke (rc.530) showed opencode booting fine but every read returning
 * user-only bubbles (providerSessionId=null, assistant dropped). Root cause was
 * a workspace-scoping gap, NOT the backend: opencode's TUI never surfaces its
 * session id, so the read is a workspace-latest lookup; the downstream
 * hasSafeNativeHistoryMapping guard fails closed unless each message declares a
 * workspace, and the old newest-wins session_query had no session-start floor so
 * it could bind a prior/other-workspace session.
 *
 * Fix (spec + executor):
 *   - session_query floors on the session's spawn time: `time_updated >= (? - 2)
 *     * 1000` (opencode times are ms; the executor binds `?` in seconds).
 *   - message_query SELECTs `session.directory AS workspace`; message_map maps
 *     `workspace: '$.workspace'`; the executor stamps it onto each message.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeNativeHistory } from '../../../src/providers/spec/native-history-executor.js';
import { loadBetterSqlite3 } from '../../../src/system/load-better-sqlite3.js';

let tmpDir = '';
let dbPath = '';

const WORKSPACE = '/tmp/opencode-ws-A';
const OTHER_WORKSPACE = '/tmp/opencode-ws-B';

// Mirror the opencode provider.v1.json sqlite source block verbatim.
function opencodeCfg(dbFile: string) {
    return {
        source: {
            kind: 'sqlite' as const,
            path: dbFile,
            session_query:
                "SELECT id FROM session WHERE (@workspace = '' OR directory = @workspace) AND time_updated >= (@floor - 2) * 1000 ORDER BY time_updated DESC LIMIT 1",
            message_query:
                "SELECT json_extract(m.data, '$.role') AS role, group_concat(CASE WHEN json_extract(p.data, '$.type') = 'text' THEN json_extract(p.data, '$.text') ELSE NULL END, '') AS content, (SELECT directory FROM session WHERE id = m.session_id) AS workspace, m.time_created AS timestamp_ms FROM message m JOIN part p ON p.message_id = m.id WHERE m.session_id = ? AND json_extract(p.data, '$.type') IN ('text', 'reasoning') GROUP BY m.id HAVING content IS NOT NULL AND content != '' ORDER BY m.time_created",
            message_map: {
                role: '$.role',
                content: '$.content',
                workspace: '$.workspace',
                timestamp_ms: '$.timestamp_ms',
            },
        },
    };
}

// Times are in MS (matches opencode's real schema).
const OLD_MS = 1_784_000_000_000; // an older session
const NEW_MS = 1_784_090_000_000; // this session

function insertSession(db: any, id: string, directory: string, createdMs: number, updatedMs: number): void {
    db.prepare(
        'INSERT INTO session (id, directory, time_created, time_updated) VALUES (?, ?, ?, ?)',
    ).run(id, directory, createdMs, updatedMs);
}

function insertTextMessage(db: any, sessionId: string, role: string, text: string, createdMs: number): void {
    const msgId = `msg_${sessionId}_${createdMs}_${role}`;
    db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run(
        msgId,
        sessionId,
        createdMs,
        JSON.stringify({ role }),
    );
    db.prepare('INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)').run(
        `${msgId}_p`,
        msgId,
        sessionId,
        JSON.stringify({ type: 'text', text }),
    );
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-sqlite-'));
    dbPath = path.join(tmpDir, 'opencode.db');
    const Database = loadBetterSqlite3();
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL);
    `);

    // Prior session in ANOTHER workspace, updated even more recently than NEW —
    // proves the floor (not just newest-wins) is what binds the right session.
    insertSession(db, 'ses_OLD_other_ws', OTHER_WORKSPACE, OLD_MS, NEW_MS + 5_000);
    insertTextMessage(db, 'ses_OLD_other_ws', 'user', 'OTHER-ws-ask', OLD_MS + 1);
    insertTextMessage(db, 'ses_OLD_other_ws', 'assistant', 'OTHER-ws-reply', OLD_MS + 2);

    // This session: created at NEW_MS in WORKSPACE.
    insertSession(db, 'ses_THIS', WORKSPACE, NEW_MS, NEW_MS + 3_000);
    insertTextMessage(db, 'ses_THIS', 'user', 'THIS-ask', NEW_MS + 1);
    insertTextMessage(db, 'ses_THIS', 'assistant', 'THIS-reply OPENCODE OK', NEW_MS + 2);

    db.close();
});

afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('native-history-executor sqlite (opencode)', () => {
    it('binds this session via the spawn floor and stamps workspace on every message', () => {
        const result = executeNativeHistory(opencodeCfg(dbPath) as any, {
            agentType: 'opencode',
            workspace: WORKSPACE,
            // Executor floors on Math.floor(sessionStartedAtMs / 1000) seconds.
            sessionStartedAtMs: NEW_MS,
        });
        expect(result).not.toBeNull();
        expect(result!.providerSessionId).toBe('ses_THIS');
        const contents = result!.messages.map((m) => m.content);
        expect(contents).toContain('THIS-ask');
        expect(contents.some((c) => c.includes('OPENCODE OK'))).toBe(true);
        // The prior other-workspace session must not bleed in.
        expect(contents.some((c) => c.includes('OTHER-ws'))).toBe(false);
        // Every message carries the workspace so the safe-mapping guard accepts
        // a workspace-scoped read (the whole point of the fix).
        expect(result!.messages.every((m) => m.workspace === WORKSPACE)).toBe(true);
        expect(result!.workspace).toBe(WORKSPACE);
    });

    it('excludes sessions older than the spawn floor (no cross-session bleed)', () => {
        // Floor set AFTER this session's time_updated → nothing qualifies.
        const result = executeNativeHistory(opencodeCfg(dbPath) as any, {
            agentType: 'opencode',
            workspace: WORKSPACE,
            sessionStartedAtMs: NEW_MS + 60_000,
        });
        expect(result).toBeNull();
    });

    it('scopes to the workspace even with no floor, and binds the newest session in it (debug read)', () => {
        // sessionStartedAtMs undefined → floor binds 0 (disabled), but the
        // workspace filter still applies, so the newest session IN WORKSPACE
        // wins — not ses_OLD_other_ws which lives in the other workspace and has
        // the globally-newest time_updated.
        const result = executeNativeHistory(opencodeCfg(dbPath) as any, {
            agentType: 'opencode',
            workspace: WORKSPACE,
        });
        expect(result).not.toBeNull();
        expect(result!.providerSessionId).toBe('ses_THIS');
    });

    it('binds the globally-newest session when neither floor nor workspace is supplied', () => {
        // No workspace and no floor → both filters disabled → pure newest-wins,
        // preserving the pre-fix bare debug-read behavior.
        const result = executeNativeHistory(opencodeCfg(dbPath) as any, {
            agentType: 'opencode',
        });
        expect(result).not.toBeNull();
        expect(result!.providerSessionId).toBe('ses_OLD_other_ws');
    });
});
