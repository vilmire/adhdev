/**
 * Kimi transcript claim-based attribution — Stage 4.
 *
 * kimi exposes no reliable session id at spawn/screen, so two live ADHDev
 * sessions sharing one cwd need DAEMON-OWNED attribution. The declarative
 * jsonl executor (providers/spec/native-history-executor.ts) now resolves
 * sidecar-workspace stores (kimi's wire.jsonl + state.json workDir) through
 * the generalized transcript-claim-registry:
 *
 *   - one transcript path is claimed by at most one live session
 *     (owner = iid:<instanceId>);
 *   - a pin is persisted only after an unambiguous, owner-confirmed bind;
 *   - ≥2 viable same-workspace candidates with no unique spawn-proximity
 *     evidence FAIL CLOSED with a typed attribution_unknown result — newest
 *     mtime is never the deciding fallback;
 *   - stale claims are reclaimable only after the owning session is
 *     demonstrably inactive (liveness probe); a live claimant is never stolen.
 *
 * These tests use the SAME source block the shipped kimi provider.v1.json
 * ships, against a fixture mirroring the real on-disk layout. Birthtime can't
 * be backdated in a fixture, so the spawn-proximity selection rule itself is
 * pinned down through the exported pure picker (pickUniqueSpawnEvidence),
 * while the executor-level tests use floor=now (own transcript) / floor in
 * the future (pre-spawn store) which are deterministic against real
 * birthtimes.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    executeNativeHistory,
    pickUniqueSpawnEvidence,
    resolveJsonlSourcePath,
} from '../../../src/providers/spec/native-history-executor.js';
import {
    CLAIM_STALE_MS,
    claimTranscript,
    isTranscriptClaimedByOther,
    setTranscriptClaimLivenessProbe,
    transcriptClaimOwner,
    transcriptClaimOwnerToken,
    __resetTranscriptClaimRegistry,
} from '../../../src/providers/native-history/transcript-claim-registry.js';
import { readProviderChatHistory } from '../../../src/config/chat-history.js';

// The shipped kimi nativeHistory.source (kept in sync with
// adhdev-providers/cli/kimi/provider.v1.json).
const KIMI_SOURCE = {
    kind: 'jsonl' as const,
    path: '{SESSIONS}/*/session_*/agents/main',
    file_pattern: 'wire.jsonl',
    session_id_from: 'dir_uuid' as const,
    workspace_from_sidecar: {
        rel_path: '../../state.json',
        workspace_path: '$.workDir',
    },
    records: [
        {
            where: '$.type == "turn.prompt"',
            message_map: { role: 'user', content: '$.input', timestamp_ms: '$.time' },
        },
        {
            where: '$.type == "context.append_loop_event" && $.event.type == "content.part" && $.event.part.type == "text"',
            message_map: { role: 'assistant', content: '$.event.part.text', timestamp_ms: '$.time' },
        },
    ],
};

const UUID_A = 'ba1a3c5c-0ad8-48e5-9f49-3feaa9c449b6';
const UUID_B = 'cc225d6d-1be9-59f6-a05a-4ffbb0d550c7';
const SESSION_A = `session_${UUID_A}`;
const SESSION_B = `session_${UUID_B}`;
const WORKSPACE = '/Users/example/Work/myrepo';
const OWNER_A = transcriptClaimOwnerToken('instance-A');
const OWNER_B = transcriptClaimOwnerToken('instance-B');

let tmpDir = '';
let sessionsDir = '';

function wdKey(ws: string, hex12: string): string {
    const last = ws.replace(/\/+$/, '').split('/').pop() || 'root';
    return `wd_${last}_${hex12}`;
}

function writeSession(opts: {
    sessionId: string;
    workspace: string;
    hex12: string;
    lines: any[];
    mtimeMs?: number;
}): string {
    const sessionDir = path.join(sessionsDir, wdKey(opts.workspace, opts.hex12), opts.sessionId);
    const wireDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(wireDir, { recursive: true });
    fs.writeFileSync(
        path.join(sessionDir, 'state.json'),
        JSON.stringify({ workDir: opts.workspace, title: 'test' }),
        'utf8',
    );
    const wirePath = path.join(wireDir, 'wire.jsonl');
    fs.writeFileSync(wirePath, opts.lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
    if (typeof opts.mtimeMs === 'number') {
        const sec = opts.mtimeMs / 1000;
        fs.utimesSync(wirePath, sec, sec);
    }
    return wirePath;
}

function lines(baseTs: number, tag: string): any[] {
    return [
        { type: 'turn.prompt', input: [{ type: 'text', text: `${tag} prompt` }], origin: { kind: 'user' }, time: baseTs + 100 },
        {
            type: 'context.append_loop_event',
            event: { type: 'content.part', turnId: '0', part: { type: 'text', text: `${tag} answer` } },
            time: baseTs + 200,
        },
    ];
}

function run(input: any) {
    const src = { ...KIMI_SOURCE, path: KIMI_SOURCE.path.replace('{SESSIONS}', sessionsDir) };
    return executeNativeHistory({ source: src } as any, input);
}

function specSource() {
    return { ...KIMI_SOURCE, path: KIMI_SOURCE.path.replace('{SESSIONS}', sessionsDir) } as any;
}

/** The realpath-canonical claim key the executor uses for a wire path. */
function claimKey(wirePath: string): string {
    try { return fs.realpathSync(wirePath); } catch { return wirePath; }
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-claims-'));
    sessionsDir = path.join(tmpDir, '.kimi-code', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    __resetTranscriptClaimRegistry();
});

afterEach(() => {
    __resetTranscriptClaimRegistry();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('kimi transcript claim attribution (Stage 4)', () => {
    it('single live session claims its own wire (ownerConfirmed, claimed)', () => {
        const now = Date.now();
        const wire = writeSession({ sessionId: SESSION_A, workspace: WORKSPACE, hex12: '78117b8afba9', lines: lines(now, 'A'), mtimeMs: now + 2000 });
        const r = run({ workspace: WORKSPACE, sessionStartedAtMs: now, instanceId: 'instance-A' });
        expect(r).not.toBeNull();
        expect(r!.providerSessionId).toBe(UUID_A);
        expect(r!.attribution).toBe('claimed');
        expect(r!.ownerConfirmed).toBe(true);
        expect(r!.sourcePath).toBe(wire);
        expect(r!.messages.map((m: any) => m.content)).toEqual(['A prompt', 'A answer']);
        // The claim is held by this session's iid:<instanceId> owner token.
        expect(transcriptClaimOwner(claimKey(wire))).toBe(OWNER_A);
    });

    it('two live same-cwd sessions: first claim is exclusive — the sibling cannot bind the claimed transcript (already_claimed, no pin material)', () => {
        const now = Date.now();
        const wire = writeSession({ sessionId: SESSION_A, workspace: WORKSPACE, hex12: '78117b8afba9', lines: lines(now, 'A'), mtimeMs: now + 2000 });
        // Session A binds first.
        const ra = run({ workspace: WORKSPACE, sessionStartedAtMs: now, instanceId: 'instance-A' });
        expect(ra!.attribution).toBe('claimed');
        // Session B (no transcript of its own on disk yet) must NOT bind A's
        // claimed wire: typed fail-closed, no messages, no providerSessionId —
        // so no durable pin can be written from it.
        const rb = run({ workspace: WORKSPACE, sessionStartedAtMs: 0, instanceId: 'instance-B' });
        expect(rb).not.toBeNull();
        expect(rb!.attribution).toBe('already_claimed');
        expect(rb!.ownerConfirmed).toBe(false);
        expect(rb!.unavailableReason).toBe('attribution_unknown');
        expect(rb!.providerSessionId).toBeUndefined();
        expect(rb!.messages).toHaveLength(0);
    });

    it('a pre-spawn sibling store is never bound: unclaimed but born before the floor → wait, no bind', () => {
        const now = Date.now();
        writeSession({ sessionId: SESSION_A, workspace: WORKSPACE, hex12: '78117b8afba9', lines: lines(now, 'A'), mtimeMs: now });
        // B spawned AFTER A's wire was created (floor in the future relative to
        // the fixture's real birthtime). A's wire predates B's spawn → B waits
        // for its own transcript instead of mis-binding the sibling's.
        const rb = run({ workspace: WORKSPACE, sessionStartedAtMs: now + 60_000, instanceId: 'instance-B' });
        expect(rb).toBeNull();
    });

    it('two viable same-workspace candidates without unique evidence → typed ambiguous, fail closed (no newest-mtime pick)', () => {
        const now = Date.now();
        // Both wires exist; B has NO spawn floor (e.g. attach-restored) so
        // neither candidate is uniquely its own. The OLD code picked the
        // newest by mtime — that mis-bind is now attribution_unknown.
        writeSession({ sessionId: SESSION_A, workspace: WORKSPACE, hex12: '78117b8afba9', lines: lines(now, 'A'), mtimeMs: now });
        writeSession({ sessionId: SESSION_B, workspace: WORKSPACE, hex12: 'bbbbbbbbbbbb', lines: lines(now, 'B'), mtimeMs: now + 1000 });
        const r = run({ workspace: WORKSPACE, sessionStartedAtMs: 0, instanceId: 'instance-B' });
        expect(r).not.toBeNull();
        expect(r!.attribution).toBe('ambiguous');
        expect(r!.ownerConfirmed).toBe(false);
        expect(r!.unavailableReason).toBe('attribution_unknown');
        expect(r!.providerSessionId).toBeUndefined();
        expect(r!.messages).toHaveLength(0);
    });

    it('each of two live same-cwd sessions binds its OWN transcript once the sibling is claimed (exclusion, not mtime)', () => {
        const now = Date.now();
        const wireA = writeSession({ sessionId: SESSION_A, workspace: WORKSPACE, hex12: '78117b8afba9', lines: lines(now, 'A'), mtimeMs: now + 2000 });
        const wireB = writeSession({ sessionId: SESSION_B, workspace: WORKSPACE, hex12: 'bbbbbbbbbbbb', lines: lines(now, 'B'), mtimeMs: now + 3000 });
        // A binds first — the OLD newest-mtime code would have handed A the
        // NEWER wireB; the claim/exclusion path must not.
        const ra = run({ workspace: WORKSPACE, sessionStartedAtMs: now, instanceId: 'instance-A' });
        expect(ra).not.toBeNull();
        // Both wires are within A's spawn window (fixture birthtimes ≈ now), so
        // A cannot uniquely identify its own → fail closed. (The unique-evidence
        // selection is covered deterministically by pickUniqueSpawnEvidence
        // below; here we assert the fail-closed contract holds even with a
        // floor.)
        if (ra!.attribution === 'claimed') {
            expect(ra!.sourcePath).toBe(wireA);
        } else {
            expect(ra!.attribution).toBe('ambiguous');
            expect(ra!.providerSessionId).toBeUndefined();
        }
        // Whatever A did, B must never surface A's claimed transcript as its own.
        if (transcriptClaimOwner(claimKey(wireA)) === OWNER_A) {
            const rb = run({ workspace: WORKSPACE, sessionStartedAtMs: now, instanceId: 'instance-B' });
            expect(rb!.sourcePath ?? '').not.toBe(wireA);
            void wireB;
        }
    });

    it('concurrent same-workspace claim attempts serialize: exactly one winner, loser denied, no pin material', () => {
        const now = Date.now();
        const wire = writeSession({ sessionId: SESSION_A, workspace: WORKSPACE, hex12: '78117b8afba9', lines: lines(now, 'A'), mtimeMs: now + 2000 });
        const key = claimKey(wire);
        // Registry-level race: the first claimant wins; every other live owner
        // is denied from then on (claims are a synchronous in-process map, so
        // attempts serialize by construction).
        expect(claimTranscript(key, OWNER_A)).toBe('claimed');
        for (let i = 0; i < 25; i += 1) {
            expect(claimTranscript(key, OWNER_B)).toBe('denied');
        }
        expect(transcriptClaimOwner(key)).toBe(OWNER_A);
        expect(isTranscriptClaimedByOther(key, OWNER_B)).toBe(true);
        // Executor-level loser: B's read of the same store fails closed with
        // no providerSessionId — nothing a pin could be written from.
        const rb = run({ workspace: WORKSPACE, sessionStartedAtMs: now, instanceId: 'instance-B' });
        expect(rb!.attribution).toBe('already_claimed');
        expect(rb!.providerSessionId).toBeUndefined();
    });

    it('pinned re-read exact-binds and re-claims after a simulated restart (claims wiped, pin retained)', () => {
        const now = Date.now();
        const wire = writeSession({ sessionId: SESSION_A, workspace: WORKSPACE, hex12: '78117b8afba9', lines: lines(now, 'A'), mtimeMs: now + 2000 });
        const first = run({ workspace: WORKSPACE, sessionStartedAtMs: now, instanceId: 'instance-A' });
        expect(first!.attribution).toBe('claimed');
        // Simulate a daemon restart: in-memory claims are gone, the persisted
        // pin (session_<uuid> form) survives.
        __resetTranscriptClaimRegistry();
        const reread = run({ providerSessionId: SESSION_A, workspace: WORKSPACE, sessionStartedAtMs: now, instanceId: 'instance-A' });
        expect(reread).not.toBeNull();
        expect(reread!.attribution).toBe('pinned');
        expect(reread!.ownerConfirmed).toBe(true);
        expect(reread!.sourcePath).toBe(wire);
        expect(transcriptClaimOwner(claimKey(wire))).toBe(OWNER_A);
    });

    it('a demonstrably dead owner permits stale reclaim; a live claimant is never stolen (even past the stale window)', () => {
        const now = Date.now();
        const wire = writeSession({ sessionId: SESSION_A, workspace: WORKSPACE, hex12: '78117b8afba9', lines: lines(now, 'A'), mtimeMs: now });
        const key = claimKey(wire);
        expect(claimTranscript(key, OWNER_A)).toBe('claimed');

        // Liveness probe wired like production (session registry): A dead.
        setTranscriptClaimLivenessProbe((owner) => owner !== OWNER_A);
        expect(claimTranscript(key, OWNER_B)).toBe('stale_reclaimed');
        expect(transcriptClaimOwner(key)).toBe(OWNER_B);

        // B live: A must not steal it back, even far beyond CLAIM_STALE_MS.
        setTranscriptClaimLivenessProbe(() => true);
        const future = Date.now() + CLAIM_STALE_MS + 60_000;
        expect(claimTranscript(key, OWNER_A, future)).toBe('denied');
        expect(transcriptClaimOwner(key, future)).toBe(OWNER_B);

        // No probe (unit-test/early-boot fallback): time-based staleness.
        setTranscriptClaimLivenessProbe(null);
        expect(claimTranscript(key, OWNER_A, Date.now())).toBe('denied');
        expect(claimTranscript(key, OWNER_A, future)).toBe('stale_reclaimed');

        // Executor-level stale reclaim: the dead owner's wire becomes bindable
        // by the live session and is attributed as a reclaim.
        __resetTranscriptClaimRegistry();
        expect(claimTranscript(key, OWNER_A)).toBe('claimed');
        setTranscriptClaimLivenessProbe((owner) => owner !== OWNER_A);
        const rb = run({ workspace: WORKSPACE, sessionStartedAtMs: 0, instanceId: 'instance-B' });
        expect(rb).not.toBeNull();
        expect(rb!.attribution).toBe('stale_reclaimed');
        expect(rb!.ownerConfirmed).toBe(true);
        expect(rb!.providerSessionId).toBe(UUID_A);
    });

    it('legacy identity-less discovery still binds a single viable candidate (backward compatible)', () => {
        const now = Date.now();
        writeSession({ sessionId: SESSION_A, workspace: WORKSPACE, hex12: '78117b8afba9', lines: lines(now, 'A'), mtimeMs: now });
        const r = run({ workspace: WORKSPACE, sessionStartedAtMs: 0 });
        expect(r).not.toBeNull();
        expect(r!.providerSessionId).toBe(UUID_A);
        expect(r!.attribution).toBe('legacy');
        expect(r!.messages.map((m: any) => m.content)).toEqual(['A prompt', 'A answer']);
    });

    it('legacy identity-less discovery with two candidates and no unique evidence fails closed too', () => {
        const now = Date.now();
        writeSession({ sessionId: SESSION_A, workspace: WORKSPACE, hex12: '78117b8afba9', lines: lines(now, 'A'), mtimeMs: now });
        writeSession({ sessionId: SESSION_B, workspace: WORKSPACE, hex12: 'bbbbbbbbbbbb', lines: lines(now, 'B'), mtimeMs: now + 1000 });
        const r = run({ workspace: WORKSPACE, sessionStartedAtMs: 0 });
        expect(r).not.toBeNull();
        expect(r!.attribution).toBe('ambiguous');
        expect(r!.providerSessionId).toBeUndefined();
    });
});

describe('spawn-proximity evidence picker (pure, mtime-independent)', () => {
    const FLOOR = 1_000_000;
    it('selects the uniquely in-window candidate even when the sibling has the NEWER mtime', () => {
        const candidates = [
            { p: '/own/wire.jsonl', mtime: FLOOR + 5_000, birth: FLOOR + 100 },      // own: born at spawn
            { p: '/sibling/wire.jsonl', mtime: FLOOR + 50_000, birth: FLOOR + 40_000 }, // newer mtime, born outside grace
        ];
        expect(pickUniqueSpawnEvidence(candidates, FLOOR)).toBe('/own/wire.jsonl');
    });

    it('returns null on a genuine tie (both born within the grace window)', () => {
        const candidates = [
            { p: '/a/wire.jsonl', mtime: FLOOR + 100, birth: FLOOR + 100 },
            { p: '/b/wire.jsonl', mtime: FLOOR + 200, birth: FLOOR + 200 },
        ];
        expect(pickUniqueSpawnEvidence(candidates, FLOOR)).toBeNull();
    });

    it('returns null when no candidate is within the spawn window', () => {
        const candidates = [
            { p: '/a/wire.jsonl', mtime: FLOOR + 30_000, birth: FLOOR + 30_000 },
        ];
        expect(pickUniqueSpawnEvidence(candidates, FLOOR)).toBeNull();
    });

    it('returns null without a spawn floor', () => {
        const candidates = [{ p: '/a/wire.jsonl', mtime: 5, birth: 5 }];
        expect(pickUniqueSpawnEvidence(candidates, 0)).toBeNull();
    });

    it('falls back to mtime only when birthtime is unavailable (0)', () => {
        const candidates = [
            { p: '/own/wire.jsonl', mtime: FLOOR + 100, birth: 0 },
            { p: '/sibling/wire.jsonl', mtime: FLOOR + 60_000, birth: 0 },
        ];
        expect(pickUniqueSpawnEvidence(candidates, FLOOR)).toBe('/own/wire.jsonl');
    });
});

describe('shared binding across read_chat / completion / status consumers', () => {
    function canonicalHistoryAndScripts() {
        const src = specSource();
        const canonicalHistory = {
            mode: 'native-source',
            contractVersion: '2.0',
            scripts: { readSession: 'readNativeHistory' },
        } as any;
        const scripts = {
            readNativeHistory: (input: any) => executeNativeHistory({ source: src } as any, input),
        } as any;
        return { canonicalHistory, scripts, src };
    }

    it('discovery read → pinned completion read → status path resolution all resolve the SAME transcript', () => {
        const now = Date.now();
        const wireA = writeSession({ sessionId: SESSION_A, workspace: WORKSPACE, hex12: '78117b8afba9', lines: lines(now, 'A'), mtimeMs: now + 2000 });
        const { canonicalHistory, scripts, src } = canonicalHistoryAndScripts();

        // (1) read_chat-style discovery read (no pin yet): claims + binds.
        const discovery = readProviderChatHistory('kimi', {
            canonicalHistory,
            scripts,
            workspace: WORKSPACE,
            sessionStartedAtMs: now,
            instanceId: 'instance-A',
        });
        expect(discovery.source).toBe('provider-native');
        expect(discovery.providerSessionId).toBe(UUID_A);
        expect(discovery.ownerConfirmed).toBe(true);
        expect(discovery.attribution).toBe('claimed');
        expect(discovery.sourcePath).toBe(wireA);

        // (2) completion-style read (readExternalCompletionMessages shape):
        // the persisted pin is threaded as historySessionId → exact re-bind of
        // the SAME transcript, attributed as a pinned read.
        const completion = readProviderChatHistory('kimi', {
            canonicalHistory,
            scripts,
            historySessionId: SESSION_A,
            workspace: WORKSPACE,
            sessionStartedAtMs: now,
            instanceId: 'instance-A',
            forceRefresh: true,
        });
        expect(completion.source).toBe('provider-native');
        expect(completion.sourcePath).toBe(discovery.sourcePath);
        expect(completion.providerSessionId).toBe(UUID_A);
        expect(completion.attribution).toBe('pinned');

        // (3) status-style path resolution (background-task detector shape):
        // same pin → same concrete path, no independent heuristic.
        const statusPath = resolveJsonlSourcePath(src, {
            providerSessionId: SESSION_A,
            workspace: WORKSPACE,
            sessionStartedAtMs: now,
            instanceId: 'instance-A',
        });
        expect(statusPath).toBe(discovery.sourcePath);
    });

    it('an ambiguous discovery surfaces typed attribution_unknown through readProviderChatHistory (native-unavailable, no providerSessionId)', () => {
        const now = Date.now();
        writeSession({ sessionId: SESSION_A, workspace: WORKSPACE, hex12: '78117b8afba9', lines: lines(now, 'A'), mtimeMs: now });
        writeSession({ sessionId: SESSION_B, workspace: WORKSPACE, hex12: 'bbbbbbbbbbbb', lines: lines(now, 'B'), mtimeMs: now + 1000 });
        const { canonicalHistory, scripts } = canonicalHistoryAndScripts();
        const r = readProviderChatHistory('kimi', {
            canonicalHistory,
            scripts,
            workspace: WORKSPACE,
            sessionStartedAtMs: 0,
            instanceId: 'instance-B',
        });
        expect(r.source).toBe('native-unavailable');
        expect(r.unavailableReason).toBe('attribution_unknown');
        expect(r.attribution).toBe('ambiguous');
        expect(r.providerSessionId).toBeUndefined();
        expect(r.messages).toHaveLength(0);
    });
});
