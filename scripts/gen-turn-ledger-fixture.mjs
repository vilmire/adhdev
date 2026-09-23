#!/usr/bin/env node
// gen-turn-ledger-fixture — deterministic SYNTHETIC pre-migration (user_version 0)
// mesh-runtime.db for turn-ledger/migrate-v1 (wiring-unification C3/C8).
//
// Why synthetic and not a redacted copy of a live DB (C8 harness spec §1c):
// every row here is auditable in git, no redaction pass has to be trusted, and
// the shape is built to hit every migration branch with EXACT, known counts:
//
//   attempts   2,293 legacy rows = 2,065 single-row tasks + 68 fold groups
//              (113 reassigned/superseded folds, 181 rows) + 3 genuine retries
//              after a terminal (6 rows) + 41 August orphans (delivered, no queue
//              row, idle past the hard ceiling)  → 2,180 turn_attempts
//              (the preview-DB numbers of design §5 C3)
//   plus 2 recent open attempts WITH queue rows (one waiting_approval → suspended,
//              one generating) that must stay open with a hard_ceiling hold;
//              total legacy attempts 2,295 → 2,182.
//   events     4 per legacy attempt (accepted, delivered, consumed, proposal_* /
//              rejected_* for the last), deterministic ids
//   held       9 applied + 4 dropped (resolved) + 1 held on an open attempt (active)
//   inflight   1 on an open attempt (→ liveness hold) + 1 on a terminal one (dropped)
//   delivery   1,063 rows, 43 without an attempt (dropped, counted)
//   direct     45 rows, all joinable
//   fingerprints 14 (dropped)
//   pending    840 rows: 770 drained (60 terminal events with a taskId → acks),
//              70 undrained = 41 refine:completed + 23 refine:failed + 6
//              worktree_bootstrap_complete → 70 turn.notify{mesh_event} pending
//   notified   444 attempts get notified_at (acked/completed deliveries ∪ drained acks)
//   ledger     19,380 rows: 100 operating notes + 32 tombstones (16 by id, 16 by
//              text fingerprint) + 19,248 other kinds (dropped — topic-only)
//
// Two meshes ('mesh-alpha' holds almost everything, 'mesh-beta' a small slice)
// so the per-mesh transaction / crash-resume path is exercised.
//
// Usage: node oss/scripts/gen-turn-ledger-fixture.mjs <out.db>
// Library: import { buildLegacyTurnLedgerFixture, FIXTURE_COUNTS } from this file.

import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const LEGACY_DDL = `
CREATE TABLE IF NOT EXISTS mesh_queue (id TEXT PRIMARY KEY, mesh_id TEXT NOT NULL, status TEXT NOT NULL, target_node_id TEXT, target_session_id TEXT,
  assigned_node_id TEXT, assigned_session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mesh_completion_fingerprints (fingerprint TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, mesh_id TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS mesh_direct_dispatches (task_id TEXT PRIMARY KEY, mesh_id TEXT NOT NULL, node_id TEXT, session_id TEXT, provider_type TEXT,
  message TEXT NOT NULL, input TEXT, task_mode TEXT, via TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'dispatched',
  dispatched_to_idle_session INTEGER NOT NULL DEFAULT 0, dispatched_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mesh_session_delivery (id TEXT PRIMARY KEY, mesh_id TEXT NOT NULL, node_id TEXT, session_id TEXT, provider_type TEXT, task_id TEXT,
  kind TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL, input TEXT, status TEXT NOT NULL DEFAULT 'queued', deliver_after TEXT,
  expires_at TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, source_coordinator_session_id TEXT, source_coordinator_daemon_id TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mesh_event_ledger (id TEXT PRIMARY KEY, mesh_id TEXT NOT NULL, timestamp TEXT NOT NULL, kind TEXT NOT NULL, node_id TEXT,
  session_id TEXT, provider_type TEXT, task_id TEXT, payload TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS mesh_pending_events (id TEXT PRIMARY KEY, mesh_id TEXT NOT NULL, coordinator_daemon_id TEXT, event TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}', fingerprint TEXT, queued_at INTEGER NOT NULL, drained INTEGER NOT NULL DEFAULT 0, drained_at INTEGER,
  protocol_version TEXT, event_id TEXT, scope TEXT, dispatched_by TEXT, intended_for TEXT, drained_by TEXT);
CREATE TABLE IF NOT EXISTS mesh_inflight_hold (task_id TEXT PRIMARY KEY, mesh_id TEXT, hold_reason TEXT, held_at INTEGER, first_idle_since_ack INTEGER,
  read_failure_count INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS mesh_turn_attempts (attempt_id TEXT PRIMARY KEY, mesh_id TEXT NOT NULL, task_id TEXT NOT NULL, attempt_seq INTEGER NOT NULL,
  node_id TEXT, session_id TEXT, provider_type TEXT, coordinator_daemon_id TEXT, coordinator_session_id TEXT, dispatch_nonce INTEGER,
  stage TEXT NOT NULL DEFAULT 'accepted', redrive_count INTEGER NOT NULL DEFAULT 0, lease_deadline_ms INTEGER, accepted_at TEXT, delivered_at TEXT,
  consumed_at TEXT, terminal_outcome TEXT, terminal_reason TEXT, terminal_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (mesh_id, task_id, attempt_seq));
CREATE TABLE IF NOT EXISTS mesh_turn_events (event_id TEXT PRIMARY KEY, mesh_id TEXT NOT NULL, attempt_id TEXT NOT NULL, task_id TEXT NOT NULL,
  kind TEXT NOT NULL, dedupe_key TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL DEFAULT '{}', occurred_at_ms INTEGER, recorded_at TEXT NOT NULL,
  UNIQUE (attempt_id, kind, dedupe_key));
CREATE TABLE IF NOT EXISTS mesh_turn_held_suspensions (hold_id TEXT PRIMARY KEY, mesh_id TEXT NOT NULL, attempt_id TEXT NOT NULL, task_id TEXT NOT NULL,
  stage TEXT NOT NULL, session_id TEXT, dispatch_nonce INTEGER, occurred_at_ms INTEGER, recorded_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'held',
  resolution TEXT, resolved_at TEXT);
`;

/** The counts the fixture is built to produce (migrate-v1.test.ts asserts them). */
export const FIXTURE_COUNTS = Object.freeze({
    legacyAttempts: 2295,
    attempts: 2182,
    folds: 113,
    retries: 3,
    orphans: 41,
    openAttempts: 2,
    events: 2295 * 4,
    heldSuspensions: 14,
    holdsActive: 1,
    inflightHolds: 2,
    inflightHoldsDropped: 1,
    deliveries: 1063,
    deliveriesDropped: 43,
    directDispatches: 45,
    fingerprints: 14,
    pendingEvents: 840,
    pendingUndrained: 70,
    pendingDrainedAcks: 60,
    // notified_at comes from acked/completed deliveries (2/5 of 1,020 = 408 tasks)
    // plus drained terminal pending events on tasks whose delivery was not acked
    // (60 acks over tasks 100..159, 36 of them not already notified) = 444.
    notifiedAttempts: 444,
    ledgerRows: 19380,
    operatingNotes: 100,
    operatingNoteTombstones: 32,
    freeTextReasons: 12,
});

const FOLD_REASONS = [
    'reassigned:delivered_not_consumed_redrive',
    'reassigned:dispatch_failed',
    'superseded_by_attempt',
    'reassigned:reclaim_after_unknown_grace',
    'superseded_by_queue_terminal',
    'reassigned:delivered_no_turn_deadline',
];
const SINGLE_REASONS = ['provider_event', 'task_status_terminal:completed', 'task_completed', 'operator_cancel', 'task_stalled', 'worker_reported:completed'];

/** Build the v0 fixture into an open better-sqlite3 handle. `nowMs` anchors "recent" vs "August". */
export function buildLegacyTurnLedgerFixture(db, { nowMs = Date.parse('2026-09-23T12:00:00.000Z') } = {}) {
    db.exec(LEGACY_DDL);
    const iso = (ms) => new Date(ms).toISOString();
    const AUG = Date.parse('2026-08-11T00:00:00.000Z');
    const RECENT = nowMs - 60_000;
    const insAttempt = db.prepare(`INSERT INTO mesh_turn_attempts (attempt_id, mesh_id, task_id, attempt_seq, node_id, session_id, provider_type,
        coordinator_daemon_id, coordinator_session_id, dispatch_nonce, stage, redrive_count, accepted_at, delivered_at, consumed_at, terminal_outcome,
        terminal_reason, terminal_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'node-1', ?, 'claude-cli', 'daemon-coord', 'coord-sess', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insEvent = db.prepare(`INSERT INTO mesh_turn_events (event_id, mesh_id, attempt_id, task_id, kind, dedupe_key, payload, occurred_at_ms, recorded_at)
        VALUES (?, ?, ?, ?, ?, '', '{}', ?, ?)`);
    const insQueue = db.prepare(`INSERT INTO mesh_queue (id, mesh_id, status, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)`);
    let sessionN = 0;
    let t = AUG - 30 * 86_400_000;
    const attemptsByTask = [];
    const openAttempts = [];

    const writeAttempt = (meshId, taskId, seq, stage, outcome, reason, atMs) => {
        const attemptId = `att-${taskId}-${seq}`;
        const session = `sess-${(sessionN++).toString(36)}`;
        const terminal = outcome !== null;
        insAttempt.run(attemptId, meshId, taskId, seq, session, seq, stage, iso(atMs), iso(atMs + 10), terminal || stage !== 'delivered' ? iso(atMs + 100) : null,
            outcome, reason, terminal ? iso(atMs + 5_000) : null, iso(atMs), iso(atMs + 5_000));
        const kinds = ['accepted', 'delivered', 'consumed', terminal ? (outcome === 'failed' && seq % 7 === 0 ? 'rejected_session_mismatch' : `proposal_${outcome}`) : 'generating'];
        kinds.forEach((kind, i) => insEvent.run(`${attemptId}:e${i}`, meshId, attemptId, taskId, kind, atMs + i, iso(atMs + i)));
        return { attemptId, session };
    };
    const task = (meshId, n, withQueue, queueStatus = 'completed') => {
        const taskId = `${meshId}-t${n}`;
        if (withQueue) insQueue.run(taskId, meshId, queueStatus, iso(t), iso(t), JSON.stringify({ id: taskId, meshId, status: queueStatus, message: 'task body text' }));
        return taskId;
    };
    const meshFor = (n) => (n % 25 === 0 ? 'mesh-beta' : 'mesh-alpha');
    let taskN = 0;
    let freeText = 0;

    // 2,065 single-row terminal tasks (12 carry a free-text operator reason).
    for (let i = 0; i < 2065; i++) {
        const meshId = meshFor(taskN);
        const taskId = task(meshId, taskN++, i % 70 !== 0);
        const outcome = i % 11 === 0 ? 'cancelled' : i % 29 === 0 ? 'failed' : 'completed';
        let reason = SINGLE_REASONS[i % SINGLE_REASONS.length];
        if (i % 172 === 5 && freeText < 12) { reason = `운영자 메모 ${i}: 중복 정리 — free text that must not survive into a closed column`; freeText++; }
        writeAttempt(meshId, taskId, 1, outcome, outcome, reason, t += 60_000);
        attemptsByTask.push(taskId);
    }
    // 68 fold groups carrying 113 folds: 45×1 + 11×2 + 10×4 + 2×3.
    const foldPlan = [...Array(45).fill(1), ...Array(11).fill(2), ...Array(10).fill(4), ...Array(2).fill(3)];
    foldPlan.forEach((folds, g) => {
        const meshId = meshFor(taskN);
        const taskId = task(meshId, taskN++, true);
        for (let k = 0; k <= folds; k++) {
            const last = k === folds;
            writeAttempt(meshId, taskId, k + 1, last ? 'completed' : 'cancelled', last ? 'completed' : 'cancelled',
                last ? 'provider_event' : FOLD_REASONS[(g + k) % FOLD_REASONS.length], t += 60_000);
        }
        attemptsByTask.push(taskId);
    });
    // 3 genuine retries after a terminal: completed(provider_event) then a new attempt.
    for (let i = 0; i < 3; i++) {
        const meshId = meshFor(taskN);
        const taskId = task(meshId, taskN++, true);
        writeAttempt(meshId, taskId, 1, 'completed', 'completed', 'provider_event', t += 60_000);
        writeAttempt(meshId, taskId, 2, 'completed', 'completed', 'provider_event', t += 60_000);
        attemptsByTask.push(taskId);
    }
    // 41 August orphans: delivered, never terminal, no queue row.
    for (let i = 0; i < 41; i++) {
        const meshId = meshFor(taskN);
        const taskId = task(meshId, taskN++, false);
        writeAttempt(meshId, taskId, 1, 'delivered', null, null, AUG + i * 3_600_000);
        attemptsByTask.push(taskId);
    }
    // 2 recent open attempts WITH queue rows: suspended (waiting_approval) + generating.
    for (const stage of ['waiting_approval', 'generating']) {
        const meshId = 'mesh-alpha';
        const taskId = task(meshId, taskN++, true, 'assigned');
        const { attemptId } = writeAttempt(meshId, taskId, 1, stage, null, null, RECENT);
        openAttempts.push({ meshId, taskId, attemptId });
    }

    // held suspensions: 9 applied + 4 dropped on terminal attempts, 1 held on the open suspended one.
    const insHeld = db.prepare(`INSERT INTO mesh_turn_held_suspensions (hold_id, mesh_id, attempt_id, task_id, stage, session_id, recorded_at, status, resolution, resolved_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`);
    for (let i = 0; i < 13; i++) {
        const taskId = attemptsByTask[i * 3];
        const meshId = taskId.startsWith('mesh-beta') ? 'mesh-beta' : 'mesh-alpha';
        const status = i < 9 ? 'applied' : 'dropped';
        insHeld.run(`hold-${i}`, meshId, `att-${taskId}-1`, taskId, i % 2 ? 'waiting_choice' : 'waiting_approval', iso(t), status, status === 'applied' ? 'applied' : 'attempt_terminal', iso(t));
    }
    insHeld.run('hold-open', openAttempts[0].meshId, openAttempts[0].attemptId, openAttempts[0].taskId, 'waiting_choice', iso(RECENT), 'held', null, null);

    // inflight holds: open generating attempt (kept → liveness) + one terminal (dropped).
    const insInflight = db.prepare(`INSERT INTO mesh_inflight_hold (task_id, mesh_id, hold_reason, held_at, updated_at) VALUES (?, ?, 'acked', ?, ?)`);
    insInflight.run(openAttempts[1].taskId, 'mesh-alpha', RECENT, RECENT);
    insInflight.run(attemptsByTask[1], 'mesh-alpha', RECENT, RECENT);

    // deliveries: 1,020 onto attempts, 43 onto tasks that never had one.
    const insDelivery = db.prepare(`INSERT INTO mesh_session_delivery (id, mesh_id, session_id, task_id, kind, message, input, status, created_at, updated_at)
        VALUES (?, ?, 'sess', ?, 'task', 'delivery body text', ?, ?, ?, ?)`);
    const statuses = ['completed', 'delivered', 'acked', 'failed', 'delivering'];
    for (let i = 0; i < 1063; i++) {
        const orphan = i >= 1020;
        const taskId = orphan ? `mesh-alpha-ghost-${i}` : attemptsByTask[i];
        const meshId = !orphan && taskId.startsWith('mesh-beta') ? 'mesh-beta' : 'mesh-alpha';
        insDelivery.run(`del-${i}`, meshId, taskId, i % 9 === 0 ? JSON.stringify({ kind: 'image', ref: `img-${i}` }) : null, statuses[i % statuses.length], iso(t + i), iso(t + i + 5));
    }
    // direct dispatches: 45, all joinable.
    const insDirect = db.prepare(`INSERT INTO mesh_direct_dispatches (task_id, mesh_id, node_id, session_id, message, via, status, dispatched_to_idle_session, dispatched_at, updated_at)
        VALUES (?, ?, 'node-1', 'sess', 'direct body text', ?, ?, ?, ?, ?)`);
    for (let i = 0; i < 45; i++) {
        const taskId = attemptsByTask[2000 + i];
        const meshId = taskId.startsWith('mesh-beta') ? 'mesh-beta' : 'mesh-alpha';
        insDirect.run(taskId, meshId, i % 2 ? 'p2p' : 'local', i < 35 ? 'completed' : i < 43 ? 'stale' : 'failed', i % 3 === 0 ? 1 : 0, iso(t), iso(t));
    }
    // fingerprints
    const insFp = db.prepare(`INSERT INTO mesh_completion_fingerprints (fingerprint, expires_at, mesh_id) VALUES (?, ?, 'mesh-alpha')`);
    for (let i = 0; i < 14; i++) insFp.run(`mesh-alpha::fp-${i}`, nowMs + i);

    // pending events: 770 drained (60 terminal with taskId → acks) + 70 undrained.
    const insPending = db.prepare(`INSERT INTO mesh_pending_events (id, mesh_id, coordinator_daemon_id, event, payload, queued_at, drained, drained_at, intended_for)
        VALUES (?, ?, 'daemon-coord', ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < 770; i++) {
        const terminal = i < 60;
        const taskId = attemptsByTask[100 + i];
        const meshId = terminal && taskId.startsWith('mesh-beta') ? 'mesh-beta' : 'mesh-alpha';
        insPending.run(`pe-d-${i}`, meshId, terminal ? 'agent:generating_completed' : 'refine:accepted',
            JSON.stringify(terminal ? { taskId, finalSummary: 'drained summary text' } : { jobId: `job-${i}` }), t + i, 1, t + i + 100, null);
    }
    const undrained = [...Array(41).fill('refine:completed'), ...Array(23).fill('refine:failed'), ...Array(6).fill('worktree_bootstrap_complete')];
    undrained.forEach((event, i) => {
        insPending.run(`pe-u-${i}`, i % 10 === 0 ? 'mesh-beta' : 'mesh-alpha', event, JSON.stringify({ jobId: `job-u-${i}`, summary: 'UNDRAINED-TEXT stays local' }), t + 1_000 + i, 0, null, i % 2 ? 'coord-sess' : null);
    });

    // event ledger: 100 notes + 32 tombstones + 19,248 other rows.
    const insLedger = db.prepare(`INSERT INTO mesh_event_ledger (id, mesh_id, timestamp, kind, node_id, session_id, task_id, payload) VALUES (?, ?, ?, ?, 'node-1', ?, ?, ?)`);
    for (let i = 0; i < 100; i++) {
        insLedger.run(`note-${i}`, 'mesh-alpha', iso(t + i), 'coordinator_operating_note', 'coord-sess', null,
            JSON.stringify({ text: `operating lesson ${i}`, category: i % 2 ? 'ops' : 'tooling' }));
    }
    for (let i = 0; i < 32; i++) {
        const byId = i < 16;
        insLedger.run(`tomb-${i}`, 'mesh-alpha', iso(t + 200 + i), 'coordinator_operating_note_tombstone', 'coord-sess', null,
            JSON.stringify(byId ? { targetNoteId: `note-${i}` } : { targetFingerprint: `operating lesson ${i}` }));
    }
    const kinds = ['task_dispatched', 'task_completed', 'direct_fast_forward', 'session_launched', 'task_reclaimed', 'mission_status_changed'];
    for (let i = 0; i < 19_248; i++) {
        insLedger.run(`led-${i}`, i % 25 === 0 ? 'mesh-beta' : 'mesh-alpha', iso(t + 1_000 + i), kinds[i % kinds.length], null, attemptsByTask[i % attemptsByTask.length],
            JSON.stringify({ outcome: 'noop', finalSummary: 'ledger free text' }));
    }
    return { attemptsByTask: attemptsByTask.length, openAttempts, freeTextReasons: freeText };
}

async function main() {
    const out = process.argv[2];
    if (!out) {
        console.error('usage: node oss/scripts/gen-turn-ledger-fixture.mjs <out.db>');
        process.exit(2);
    }
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3');
    const db = new Database(out);
    db.transaction(() => buildLegacyTurnLedgerFixture(db))();
    db.close();
    console.log(`wrote synthetic v0 mesh-runtime fixture → ${out} (${JSON.stringify(FIXTURE_COUNTS)})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    await main();
}
