/**
 * cursor-cli transcript binding (live 2026-10 fleet member): cursor exposes no
 * session id up front, so the daemon binds a transcript by prompt text. The same
 * long task prompt was re-driven to several sessions and an idle session lost
 * its transcript (5-minute recency window) / had it stale-reclaimed by a
 * sibling. Pin + spawn-proximity + no-takeover-on-prompt-alone rules.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeNativeHistory } from '../../../src/providers/spec/native-history-executor.js';
import { claimKeyForPath } from '../../../src/providers/spec/native-history-paths.js';
import { __resetSentPromptRegistry, recordSentPrompt } from '../../../src/providers/native-history/sent-prompt-registry.js';
import {
    __resetTranscriptClaimRegistry, claimTranscript, transcriptClaimOwner, transcriptClaimOwnerToken, CLAIM_STALE_MS,
} from '../../../src/providers/native-history/transcript-claim-registry.js';

const WORKSPACE = '/Users/example/Work/project';
const PROMPT = 'Implement the structured mission inbox end to end and report back when the tests pass.';

// Shipped cursor-cli source incl. the 24h recency window (provider.v1.json).
const SOURCE = {
    kind: 'jsonl' as const,
    path: '',
    file_pattern: '*.jsonl',
    recent_window_ms: 86_400_000,
    session_id_from: 'filename_uuid' as const,
    workspace_from_input: true,
    message_map: {
        role: '$.role', content: '$.message.content',
        content_strip: ['timestamp'], content_unwrap: ['user_query'], tools: {},
    },
};

let tmp = '';
let projects = '';
const slug = WORKSPACE.replace(/^\/+/, '').replace(/[^A-Za-z0-9_-]/g, '-');

function writeTranscript(id: string, firstPrompt: string, mtimeAgoMs = 0, extraUser?: string): string {
    const dir = path.join(projects, slug, 'agent-transcripts', id);
    fs.mkdirSync(dir, { recursive: true });
    const rec = (role: string, text: string) => JSON.stringify({ role, message: { content: [{ type: 'text', text: role === 'user' ? `<user_query>\n${text}\n</user_query>` : text }] } });
    const lines = [rec('user', firstPrompt), rec('assistant', 'done')];
    if (extraUser) lines.push(rec('user', extraUser), rec('assistant', 'done again'));
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    if (mtimeAgoMs) { const t = (Date.now() - mtimeAgoMs) / 1000; fs.utimesSync(file, t, t); }
    return file;
}
const birth = (p: string) => fs.statSync(p).birthtimeMs;
const run = (instanceId: string, floor: number) => executeNativeHistory(
    { source: { ...SOURCE, path: `${projects}/*/agent-transcripts/*` } } as any,
    { workspace: WORKSPACE, sessionStartedAtMs: floor, instanceId, agentType: 'cursor-cli' } as any);

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bind-'));
    projects = path.join(tmp, 'projects');
    fs.mkdirSync(projects, { recursive: true });
    __resetSentPromptRegistry();
    __resetTranscriptClaimRegistry();
});
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe('cursor transcript binding', () => {
    it('two sessions with identical prompts each bind their OWN transcript', () => {
        recordSentPrompt('sess-a', PROMPT); recordSentPrompt('sess-b', PROMPT);
        const fa = writeTranscript('11111111-1111-4111-8111-111111111111', PROMPT);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); // distinct birth times
        const fb = writeTranscript('22222222-2222-4222-8222-222222222222', PROMPT);
        const floorA = birth(fa) - 1000;
        const floorB = birth(fb) - 1000;
        const a = run('sess-a', floorA);
        const b = run('sess-b', floorB);
        expect(a?.sourcePath).toBe(fa);
        expect(b?.sourcePath).toBe(fb);
        expect(run('sess-a', floorA)?.sourcePath).toBe(fa); // stable on re-read
    });

    it('a finished session idle 6 minutes still binds (24h window, was 5 min)', () => {
        recordSentPrompt('sess-a', PROMPT);
        const fa = writeTranscript('11111111-1111-4111-8111-111111111111', PROMPT, 6 * 60_000);
        const r = run('sess-a', Date.now() - 20 * 60_000);
        expect(r?.sourcePath).toBe(fa);
    });

    it('a bound session keeps its transcript pinned after the claim ages past 10 min', () => {
        recordSentPrompt('sess-a', PROMPT);
        const fa = writeTranscript('11111111-1111-4111-8111-111111111111', PROMPT);
        expect(run('sess-a', Date.now() - 60_000)?.sourcePath).toBe(fa);
        // 30 minutes idle: file untouched, claim far past CLAIM_STALE_MS.
        const t = (Date.now() - 30 * 3_600_000) / 1000; // 30 h idle: outside even the 24 h window
        fs.utimesSync(fa, t, t);
        // A same-prompt sibling that spawned later finds nothing it may take.
        recordSentPrompt('sess-b', PROMPT);
        expect(run('sess-b', Date.now() - 5 * 60_000)?.sourcePath ?? null).toBeNull();
        expect(run('sess-a', Date.now() - 60 * 60_000)?.sourcePath).toBe(claimKeyForPath(fa)); // pinned, window-independent
        expect(transcriptClaimOwner(claimKeyForPath(fa))).toBe(transcriptClaimOwnerToken('sess-a'));
    });

    it('takeover of a stale claim IS allowed when the first user record is this session\'s first prompt', () => {
        recordSentPrompt('sess-x', PROMPT);
        const fa = writeTranscript('11111111-1111-4111-8111-111111111111', PROMPT, 0);
        claimTranscript(claimKeyForPath(fa), transcriptClaimOwnerToken('sess-old'), Date.now() - CLAIM_STALE_MS - 60_000);
        // floor sits after the file's birth + grace, so spawn proximity cannot vouch for it.
        const floor = birth(fa) + 30_000;
        const t = (Date.now() + 60_000) / 1000; fs.utimesSync(fa, t, t); // mtime after floor
        expect(run('sess-x', floor)?.sourcePath).toBe(fa);
    });

    it('stale claim + first prompt mismatch + not spawn-born → refused (no sibling theft)', () => {
        recordSentPrompt('sess-x', 'An unrelated opening request that the sibling never saw at all.');
        recordSentPrompt('sess-x', PROMPT);
        const fa = writeTranscript('11111111-1111-4111-8111-111111111111', 'Opening request of the other session entirely, different text.', 0, PROMPT);
        claimTranscript(claimKeyForPath(fa), transcriptClaimOwnerToken('sess-old'), Date.now() - CLAIM_STALE_MS - 60_000);
        const floor = birth(fa) + 30_000;
        const t = (Date.now() + 60_000) / 1000; fs.utimesSync(fa, t, t);
        expect(run('sess-x', floor)?.sourcePath ?? null).toBeNull();
    });
});
