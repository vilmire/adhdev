import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSession as readGrokSession } from '../../src/providers/native-history/grok-cli-transcript.js';
import { readSession as readClaudeSession } from '../../src/providers/native-history/claude-cli-transcript.js';

/**
 * Idempotency of reader-synthesized fields (design 2026-09-28 §3.1, §8.1-2).
 *
 * The keyed transcript lane writes a bubble whenever any wire field changes.
 * A field a reader re-derives from the CLOCK or from the file's current
 * mtime/length therefore turns every re-read into a rewrite of every bubble —
 * the whole-transcript-per-change shape the keyed storage exists to end. These
 * pin the fixed readers: re-reading an unchanged file yields identical times,
 * and appending a record leaves every earlier record's time alone.
 */

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
}

const user = (text: string) => ({ type: 'user', content: [{ type: 'text', text: `<user_query>\n${text}\n</user_query>` }] });
const assistant = (text: string) => ({ type: 'assistant', content: text });

describe('grok-cli: synthesized receivedAt is frozen per record', () => {
    it('appending a record (new mtime, more records) does not move any earlier record time', () => {
        const dir = path.join(tmp('grok-stable-'), 'sess-grok-1');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'chat_history.jsonl');
        fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ created_at: '2026-09-28T00:00:00.000Z' }));
        fs.writeFileSync(file, [user('q1'), assistant('a1'), user('q2')].map((r) => JSON.stringify(r)).join('\n') + '\n');
        const t0 = new Date('2026-09-28T00:10:00.000Z');
        fs.utimesSync(file, t0, t0);

        const first = readGrokSession(file, 'sess-grok-1')!.messages.map((m) => m.receivedAt);
        expect(readGrokSession(file, 'sess-grok-1')!.messages.map((m) => m.receivedAt)).toEqual(first);

        fs.appendFileSync(file, JSON.stringify(assistant('a2')) + '\n');
        const t1 = new Date('2026-09-28T00:20:00.000Z');
        fs.utimesSync(file, t1, t1);
        const second = readGrokSession(file, 'sess-grok-1')!.messages.map((m) => m.receivedAt);
        expect(second.slice(0, 3)).toEqual(first);
        expect(second[3]).toBeGreaterThan(first[2]!);
    });
});

describe('claude-cli: leading records without a timestamp do not take the clock', () => {
    it('re-reading an unchanged file yields identical receivedAt values', async () => {
        const dir = tmp('claude-stable-');
        const file = path.join(dir, 'sess-claude-1.jsonl');
        const lines = [
            { type: 'user', sessionId: 'sess-claude-1', cwd: '/w', message: { role: 'user', content: 'untimed first' } },
            { type: 'assistant', sessionId: 'sess-claude-1', timestamp: '2026-09-28T01:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'timed' }] } },
        ];
        fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
        const first = readClaudeSession(file)!.messages.map((m) => m.receivedAt);
        await new Promise((r) => setTimeout(r, 15));
        const second = readClaudeSession(file)!.messages.map((m) => m.receivedAt);
        expect(second).toEqual(first);
        expect(first[0]).toBe(Date.parse('2026-09-28T01:00:00.000Z'));
    });
});
