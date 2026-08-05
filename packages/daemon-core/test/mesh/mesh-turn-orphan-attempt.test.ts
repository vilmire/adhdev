import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Per-file isolated config dir → per-file mesh-runtime.db (same convention as
// mesh-turn-ledger.test.ts).
const testTmpDir = join(tmpdir(), `adhdev-turn-orphan-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
}));

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import {
    openTurnAttempt,
    recordTurnAck,
    recordTurnStage,
    proposeTurnCompletion,
    reclaimOrphanedTurnAttempts,
    resolveAttemptForTask,
    SUPERSEDED_BY_ATTEMPT_REASON,
} from '../../src/mesh/mesh-turn-ledger.js';
import { presentationFromAttemptRow, resolveSessionTurnPresentation } from '../../src/mesh/mesh-turn-presentation.js';

// ORPHAN-LEGACY-ATTEMPT — a finished session pinned to `generating` forever.
//
// Root cause (RCA 702f7d7b, confirmed against the live ledger DB): a mid-turn
// ACK/stage write minted a SECOND attempt row `legacy-<taskId>-0` at seq 0 while
// the real dispatch already held seq >= 1. The seq-0 row is instantly
// non-current, so every later ACK and every completion resolves to the newer
// attempt and the stale-attempt guard refuses to mutate the orphan — it stays
// `generating` forever. The session read then PREFERRED that nonterminal row
// over the real completed attempt, pinning the presented status to `generating`.
//
// Three layers, each pinned below:
//   ① minting blocked at the source (ACK/stage paths can no longer mint)
//   ② existing orphans reclaimed (superseded rows closed)
//   ③ read guard (a non-current nonterminal row is never selected)

const MESH = 'mesh_orphan_test';

function store(): MeshRuntimeStore {
    return MeshRuntimeStore.getInstance();
}

/** The live-repro shape: a real attempt at seq 1 plus a stranded seq-0 orphan. */
function seedOrphanPlusRealAttempt(taskId: string, sessionId: string): void {
    const nowIso = new Date().toISOString();
    // The stranded seq-0 row, exactly as the old minting path left it.
    store().insertTurnAttempt({
        attemptId: `legacy-${taskId}-0`,
        meshId: MESH,
        taskId,
        attemptSeq: 0,
        sessionId,
        stage: 'generating',
        acceptedAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
    });
    // The real attempt that actually ran and completed.
    const { attempt } = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 1, sessionId });
    recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', attemptId: attempt.attemptId, sessionId });
    recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', attemptId: attempt.attemptId, sessionId });
    proposeTurnCompletion({
        meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId,
        outcome: 'completed', source: 'provider_event',
    });
}

describe('orphaned turn attempts pinning a session to generating', () => {
    beforeEach(() => {
        __resetStore();
    });

    // NOTE: the temp dir is removed once, after the whole file. Removing it per
    // test would delete the sqlite file out from under the store singleton's open
    // handle, and every later test in the run would then read a broken/empty DB.
    afterAll(() => {
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    });

    function __resetStore(): void {
        try {
            const db = (store() as any).db;
            db.prepare('DELETE FROM mesh_turn_attempts').run();
            db.prepare('DELETE FROM mesh_turn_events').run();
        } catch { /* fresh db */ }
    }

    // ── Contract 1 — fix ①: no second row lands under an existing attempt ───
    describe('fix ① minting block', () => {
        it('never mints an ACK row beneath an existing higher-seq attempt', () => {
            // THE orphan shape: the real dispatch already holds seq 1, and a
            // reconcile ACK arrives carrying the stale nonce 0 (the exact call
            // shape of mesh-reconcile-loop.ts:1486 / :1925 — a legacy hint with no
            // sessionId inside it). A mint here would create the unreachable
            // seq-0 row; the resolve must land on the REAL attempt instead.
            const taskId = randomUUID();
            const sessionId = `sess_evidence_${randomUUID().slice(0, 8)}`;
            const { attempt } = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 1, sessionId });
            proposeTurnCompletion({
                meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId,
                outcome: 'completed', source: 'provider_event',
            });

            recordTurnAck({
                meshId: MESH, taskId, kind: 'consumed', sessionId,
                legacy: { dispatchNonce: 0, nodeId: 'node_a', providerType: 'claude-cli' },
                evidence: { source: 'native_source_activity' },
            });

            expect(store().getTurnAttempt(`legacy-${taskId}-0`)).toBeNull();
            expect(store().listActiveTurnAttempts(MESH)).toHaveLength(0);
        });

        it('never mints a generating stage row beneath a higher-seq attempt', () => {
            // recordTurnStage is the writer that stamped `generating` onto the
            // freshly minted orphan — the state that pinned the session.
            const taskId = randomUUID();
            const sessionId = `sess_evidence_${randomUUID().slice(0, 8)}`;
            const { attempt } = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 1, sessionId });
            proposeTurnCompletion({
                meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId,
                outcome: 'completed', source: 'provider_event',
            });

            recordTurnStage({
                meshId: MESH, taskId, stage: 'generating', sessionId,
                legacy: { dispatchNonce: 0, nodeId: 'node_a' },
            });

            expect(store().getTurnAttempt(`legacy-${taskId}-0`)).toBeNull();
            // Nothing nonterminal was left behind to pin the session.
            expect(store().listSupersededNonterminalTurnAttempts(MESH)).toHaveLength(0);
        });

        it('STILL mints for a genuinely attempt-less task (RC.20 redrive protection)', () => {
            // The mint is legitimate when it IS the current attempt: this is what
            // gives an attempt-less claimed task a durable consumed link, making it
            // injection-ineligible so the deadline cannot re-inject a live worker.
            // Over-blocking here would silently remove that protection.
            const taskId = randomUUID();
            const result = recordTurnAck({
                meshId: MESH, taskId, kind: 'consumed', sessionId: `sess_rc20_${randomUUID().slice(0, 8)}`,
                legacy: { dispatchNonce: 0, nodeId: 'node_a', providerType: 'kimi-cli' },
            });

            expect(result).not.toBeNull();
            expect(store().getTurnAttempt(`legacy-${taskId}-0`)?.stage).toBe('consumed');
        });

        it('still lets the TERMINAL writer backfill a pre-Stage-5 task', () => {
            // The legacy path exists for exactly this case: an old task whose
            // completion would otherwise have no row to resolve.
            const taskId = randomUUID();
            const decision = proposeTurnCompletion({
                meshId: MESH, taskId, sessionId: `sess_legacy_${randomUUID().slice(0, 8)}`,
                outcome: 'completed', source: 'provider_event',
                legacy: { dispatchNonce: 0, nodeId: 'node_a' },
            });

            expect(decision.committed).toBe(true);
            const row = store().getTurnAttempt(`legacy-${taskId}-0`);
            expect(row?.terminalOutcome).toBe('completed');
            // Backfilled rows never linger nonterminal.
            expect(store().listActiveTurnAttempts(MESH)).toHaveLength(0);
        });

        it('keeps the session binding when a caller passes a legacy hint (merge, not ??)', () => {
            // The old `args.legacy ?? {sessionId}` discarded the session binding
            // whenever any legacy hint was present. The merge keeps it, and an
            // explicit legacy.sessionId still wins.
            const ackSession = `sess_from_ack_${randomUUID().slice(0, 8)}`;
            const taskId = randomUUID();
            proposeTurnCompletion({
                meshId: MESH, taskId, sessionId: ackSession,
                outcome: 'completed', source: 'provider_event',
                legacy: { dispatchNonce: 0, nodeId: 'node_a' },
            });
            expect(store().getTurnAttempt(`legacy-${taskId}-0`)?.sessionId).toBe(ackSession);

            const taskId2 = randomUUID();
            proposeTurnCompletion({
                meshId: MESH, taskId: taskId2, sessionId: ackSession,
                outcome: 'completed', source: 'provider_event',
                legacy: { dispatchNonce: 0, sessionId: 'sess_explicit' },
            });
            expect(store().getTurnAttempt(`legacy-${taskId2}-0`)?.sessionId).toBe('sess_explicit');
        });

        it('resolveAttemptForTask mints only when no higher-seq attempt exists', () => {
            // Attempt-less task → mint is the current attempt, allowed.
            const freeTask = randomUUID();
            expect(resolveAttemptForTask(MESH, freeTask, { legacy: { sessionId: 's', dispatchNonce: 0 } })?.attemptId)
                .toBe(`legacy-${freeTask}-0`);

            // Task already carrying a higher-seq attempt → resolves to that REAL
            // attempt and mints nothing. The seq-0 orphan is never created, which
            // is the property that matters; the caller's own stale-attempt guard
            // then decides whether the resolved row may be mutated.
            const takenTask = randomUUID();
            const { attempt } = openTurnAttempt({ meshId: MESH, taskId: takenTask, dispatchNonce: 3, sessionId: 's' });
            proposeTurnCompletion({
                meshId: MESH, taskId: takenTask, attemptId: attempt.attemptId, sessionId: 's',
                outcome: 'completed', source: 'provider_event',
            });
            expect(resolveAttemptForTask(MESH, takenTask, { legacy: { sessionId: 's', dispatchNonce: 0 } })?.attemptId)
                .toBe(attempt.attemptId);
            expect(store().getTurnAttempt(`legacy-${takenTask}-0`)).toBeNull();
        });
    });

    // ── Contract 2 — fix ③: the read never selects an unreachable row ────────
    describe('fix ③ read guard', () => {
        it('returns the completed seq-1 attempt, not the stranded seq-0 orphan', () => {
            // Live repro shape (session c2644d0d: 2 attempts).
            const taskId = randomUUID();
            const sessionId = `sess_c2644d0d_${randomUUID().slice(0, 8)}`;
            seedOrphanPlusRealAttempt(taskId, sessionId);

            const row = store().getLatestTurnAttemptForSession(sessionId);
            expect(row?.attemptSeq).toBe(1);
            expect(row?.stage).toBe('completed');
            expect(row?.attemptId).not.toBe(`legacy-${taskId}-0`);
        });

        it('presents the session as idle rather than generating', () => {
            // The end-to-end symptom: status/turnStage said generating while the
            // real turn had finished.
            const taskId = randomUUID();
            const sessionId = `sess_presentation_${randomUUID().slice(0, 8)}`;
            seedOrphanPlusRealAttempt(taskId, sessionId);

            // Drive the presentation off the row the guard selects. (Calling
            // resolveSessionTurnPresentation directly would read the
            // MeshRuntimeStore singleton, which a sibling test file's own config
            // mock can repoint mid-run — that is store crosstalk, not this
            // behaviour.)
            const row = store().getLatestTurnAttemptForSession(sessionId)!;
            const presentation = presentationFromAttemptRow(row);
            expect(presentation.authority).toBe('turn_reducer');
            expect(presentation.stage).toBe('completed');
            expect(presentation.status).toBe('idle');
        });

        it('holds with several attempts on one session (the 6-attempt repro)', () => {
            // Live repro shape (session 5a0cabe5: 6 attempts across tasks) — 3
            // tasks, each contributing a stranded seq-0 orphan + a completed seq-1.
            const sessionId = `sess_5a0cabe5_${randomUUID().slice(0, 8)}`;
            for (let i = 0; i < 3; i += 1) seedOrphanPlusRealAttempt(randomUUID(), sessionId);
            expect((store() as any).db
                .prepare('SELECT COUNT(*) c FROM mesh_turn_attempts WHERE session_id = ?')
                .get(sessionId).c).toBe(6);

            const row = store().getLatestTurnAttemptForSession(sessionId);
            expect(row?.terminalOutcome).toBe('completed');
            expect(row?.attemptId.startsWith('legacy-')).toBe(false);
        });

        // ── Contract 4 — the most dangerous regression ──────────────────────
        it('REGRESSION: a genuinely generating turn is still presented as generating', () => {
            const taskId = randomUUID();
            const sessionId = `sess_really_busy_${randomUUID().slice(0, 8)}`;
            const { attempt } = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 1, sessionId });
            recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', attemptId: attempt.attemptId, sessionId });
            recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', attemptId: attempt.attemptId, sessionId });
            recordTurnStage({ meshId: MESH, taskId, stage: 'generating', attemptId: attempt.attemptId, sessionId });

            const row = store().getLatestTurnAttemptForSession(sessionId);
            expect(row?.stage).toBe('generating');
            // A provider sampling idle mid-turn must NOT win — that inversion is
            // the whole reason the reducer is authoritative.
            expect(presentationFromAttemptRow(row!).status).toBe('generating');
        });

        it('REGRESSION: the CURRENT nonterminal attempt still outranks an older completed one', () => {
            // Availability semantics: a session whose newest attempt is live must
            // read live, even though an earlier attempt of the same task completed.
            const taskId = randomUUID();
            const sessionId = `sess_live_after_completed_${randomUUID().slice(0, 8)}`;
            const first = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 1, sessionId }).attempt;
            proposeTurnCompletion({
                meshId: MESH, taskId, attemptId: first.attemptId, sessionId,
                outcome: 'completed', source: 'provider_event',
            });
            const second = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 2, sessionId }).attempt;
            recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', attemptId: second.attemptId, sessionId });
            recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', attemptId: second.attemptId, sessionId });

            const row = store().getLatestTurnAttemptForSession(sessionId);
            expect(row?.attemptSeq).toBe(2);
            expect(row?.terminalOutcome).toBeNull();
            expect(presentationFromAttemptRow(row!).status).toBe('generating');
        });
    });

    // ── Contract 3 — fix ②: existing orphans get closed ──────────────────────
    describe('fix ② orphan reclaim', () => {
        it('closes a superseded nonterminal attempt as cancelled/superseded_by_attempt', () => {
            const taskId = randomUUID();
            seedOrphanPlusRealAttempt(taskId, `sess_reclaim_${randomUUID().slice(0, 8)}`);
            expect(store().getTurnAttempt(`legacy-${taskId}-0`)?.terminalOutcome).toBeNull();

            const result = reclaimOrphanedTurnAttempts(MESH);

            expect(result.closed).toBe(1);
            const closed = store().getTurnAttempt(`legacy-${taskId}-0`);
            expect(closed?.terminalOutcome).toBe('cancelled');
            expect(closed?.terminalReason).toBe(SUPERSEDED_BY_ATTEMPT_REASON);
            expect(closed?.terminalAt).toBeTruthy();
        });

        it('never touches the CURRENT attempt, terminal or not', () => {
            const taskId = randomUUID();
            const sessionId = `sess_current_safe_${randomUUID().slice(0, 8)}`;
            const { attempt } = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 1, sessionId });
            recordTurnAck({ meshId: MESH, taskId, kind: 'delivered', attemptId: attempt.attemptId, sessionId });
            // `generating` is only reachable from consumed (transition whitelist).
            recordTurnAck({ meshId: MESH, taskId, kind: 'consumed', attemptId: attempt.attemptId, sessionId });
            recordTurnStage({ meshId: MESH, taskId, stage: 'generating', attemptId: attempt.attemptId, sessionId });

            const result = reclaimOrphanedTurnAttempts(MESH);

            expect(result.closed).toBe(0);
            // A live, current turn must survive the sweep untouched.
            expect(store().getTurnAttempt(attempt.attemptId)?.terminalOutcome).toBeNull();
            expect(store().getTurnAttempt(attempt.attemptId)?.stage).toBe('generating');
        });

        it('is idempotent — a second sweep closes nothing', () => {
            seedOrphanPlusRealAttempt(randomUUID(), `sess_idem_${randomUUID().slice(0, 8)}`);
            expect(reclaimOrphanedTurnAttempts(MESH).closed).toBe(1);
            expect(reclaimOrphanedTurnAttempts(MESH).closed).toBe(0);
        });

        it('establishes the contract: no unreachable attempt is left open', () => {
            // Several orphans across tasks, mirroring the 15 rows found on disk.
            for (let i = 0; i < 4; i += 1) seedOrphanPlusRealAttempt(randomUUID(), `sess_${i}`);
            expect(store().listSupersededNonterminalTurnAttempts(MESH)).toHaveLength(4);

            reclaimOrphanedTurnAttempts(MESH);

            expect(store().listSupersededNonterminalTurnAttempts(MESH)).toHaveLength(0);
        });

        it('keys on seq supersession, not the legacy- id prefix', () => {
            // A stranded row with an ordinary UUID id must be reclaimed too —
            // the id form is a symptom of one minting path, not the condition.
            const taskId = randomUUID();
            const nowIso = new Date().toISOString();
            store().insertTurnAttempt({
                attemptId: 'plain-uuid-orphan', meshId: MESH, taskId, attemptSeq: 0,
                sessionId: `sess_plain_${randomUUID().slice(0, 8)}`, stage: 'generating',
                acceptedAt: nowIso, createdAt: nowIso, updatedAt: nowIso,
            });
            const { attempt } = openTurnAttempt({ meshId: MESH, taskId, dispatchNonce: 1, sessionId: `sess_plain_${randomUUID().slice(0, 8)}` });
            proposeTurnCompletion({
                meshId: MESH, taskId, attemptId: attempt.attemptId, sessionId: `sess_plain_${randomUUID().slice(0, 8)}`,
                outcome: 'completed', source: 'provider_event',
            });

            expect(reclaimOrphanedTurnAttempts(MESH).closed).toBe(1);
            expect(store().getTurnAttempt('plain-uuid-orphan')?.terminalOutcome).toBe('cancelled');
        });
    });
});
