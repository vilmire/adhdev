import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// The reminder reads missions/queue/ledger through MeshRuntimeStore, whose ledger
// side-writes a per-mesh JSONL under getConfigDir(); redirect it to a temp dir so the
// test never touches the real ~/.adhdev.
const testConfigDir = join(tmpdir(), `adhdev-idle-reminder-test-${randomUUID().slice(0, 8)}`, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
}));

import {
    maybeInjectIdleActiveMissionReminder,
    shouldFireIdleReminder,
    buildIdleReminderMessage,
    missionSetHash,
    localNonCoordinatorSessionBusy,
    IDLE_REMINDER_DEBOUNCE_MS,
    LOCAL_SESSION_STALE_MS,
} from '../../src/mesh/mesh-idle-reminder.js';
import { upsertMeshMission } from '../../src/mesh/mesh-missions.js';
import { enqueueTask } from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { __clearMeshLedgerForTests, appendLedgerEntry, readLedgerEntriesByKind } from '../../src/mesh/mesh-ledger.js';
import type { MeshMissionRecord } from '../../src/mesh/mesh-missions.js';

// Minimal coordinator stub: the reminder only ever calls onEvent('send_message', …).
function makeCoordinator() {
    const calls: Array<{ event: string; payload: any }> = [];
    return {
        calls,
        instance: {
            onEvent: (event: string, payload: any) => { calls.push({ event, payload }); },
        } as any,
    };
}

function mission(id: string, title: string): MeshMissionRecord {
    return {
        id, meshId: 'x', title, goal: '', status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    } as MeshMissionRecord;
}

// Minimal local-session state stub — only the fields localNonCoordinatorSessionBusy /
// the instanceManager.collectAllStates() read path actually consult.
function localState(overrides: Record<string, any> = {}) {
    return {
        instanceId: 'local-1',
        status: 'idle',
        settings: {},
        lastUpdated: 1_000,
        category: 'cli',
        ...overrides,
    } as any;
}

// instanceManager stub exposing only collectAllStates(), the sole method the reminder calls.
function makeInstanceManager(states: any[]) {
    return { collectAllStates: () => states } as any;
}

describe('mesh idle-active-mission reminder', () => {
    let meshId = `idle-reminder-${randomUUID().slice(0, 8)}`;

    beforeEach(() => {
        meshId = `idle-reminder-${randomUUID().slice(0, 8)}`;
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        try {
            const store = MeshRuntimeStore.getInstance();
            store.clearMissionsForMesh(meshId);
            store.clearIdleReminderState(meshId);
        } catch { /* fresh store */ }
        __clearMeshLedgerForTests(meshId);
        MeshRuntimeStore.resetForTests();
    });

    describe('shouldFireIdleReminder (pure)', () => {
        it('fires when there is no prior marker', () => {
            expect(shouldFireIdleReminder(null, 'a,b', 1000)).toBe(true);
        });
        it('suppresses within the debounce window for the same mission set', () => {
            const last = { emittedAt: 1000, missionSetHash: 'a,b' };
            expect(shouldFireIdleReminder(last, 'a,b', 1000 + IDLE_REMINDER_DEBOUNCE_MS - 1)).toBe(false);
        });
        it('re-fires once the debounce window has elapsed', () => {
            const last = { emittedAt: 1000, missionSetHash: 'a,b' };
            expect(shouldFireIdleReminder(last, 'a,b', 1000 + IDLE_REMINDER_DEBOUNCE_MS + 1)).toBe(true);
        });
        it('re-fires immediately when the mission set changed', () => {
            const last = { emittedAt: 1000, missionSetHash: 'a,b' };
            expect(shouldFireIdleReminder(last, 'a,c', 1001)).toBe(true);
        });

        // MISSION-SET-GROWTH-BYPASS: only GROWTH (a new id entering the set) bypasses the
        // debounce window. A same-or-SHRUNK set stays debounced — closing a mission (or a
        // content-only edit, which never touches the id-only hash anyway) must not restart
        // the spam clock.
        it('does NOT re-fire when the mission set only shrank (a mission was closed)', () => {
            const last = { emittedAt: 1000, missionSetHash: 'a,b' };
            expect(shouldFireIdleReminder(last, 'a', 1001)).toBe(false);
        });
        it('does NOT re-fire when the mission set is unchanged', () => {
            const last = { emittedAt: 1000, missionSetHash: 'a,b' };
            expect(shouldFireIdleReminder(last, 'a,b', 1001)).toBe(false);
        });
        it('re-fires when the set both drops one id and gains a different one (net growth of a new id)', () => {
            const last = { emittedAt: 1000, missionSetHash: 'a,b' };
            expect(shouldFireIdleReminder(last, 'a,c', 1001)).toBe(true);
        });
    });

    describe('missionSetHash / message', () => {
        it('is order-independent', () => {
            expect(missionSetHash([mission('b', 'B'), mission('a', 'A')]))
                .toBe(missionSetHash([mission('a', 'A'), mission('b', 'B')]));
        });
        it('lists each mission as title (id) and never embeds the full goal', () => {
            const msg = buildIdleReminderMessage([mission('m1', 'Ship X'), mission('m2', 'Fix Y')]);
            expect(msg).toContain('[System] Coordinator idle with 2 active mission(s):');
            expect(msg).toContain('Ship X (m1)');
            expect(msg).toContain('Fix Y (m2)');
        });
        it('folds the overflow past the cap into "and M more"', () => {
            const many = Array.from({ length: 13 }, (_, i) => mission(`m${i}`, `T${i}`));
            const msg = buildIdleReminderMessage(many);
            expect(msg).toContain('…and 3 more');
        });
    });

    it('injects a reminder once when idle with active missions', () => {
        upsertMeshMission(meshId, { title: 'Deploy pipeline', goal: 'ship rc' });
        const coord = makeCoordinator();

        const fired = maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000);
        expect(fired).toBe(true);
        expect(coord.calls).toHaveLength(1);
        expect(coord.calls[0].event).toBe('send_message');
        expect(coord.calls[0].payload.input.text).toContain('Deploy pipeline');
    });

    it('no-op when there are no active missions', () => {
        const coord = makeCoordinator();
        const fired = maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000);
        expect(fired).toBe(false);
        expect(coord.calls).toHaveLength(0);
    });

    it('no-op when a completed/abandoned mission is the only mission', () => {
        const m = upsertMeshMission(meshId, { title: 'Done work', goal: 'x' });
        upsertMeshMission(meshId, { id: m.id, title: 'Done work', status: 'completed' });
        const coord = makeCoordinator();

        const fired = maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000);
        expect(fired).toBe(false);
        expect(coord.calls).toHaveLength(0);
    });

    it('no-op when the mesh is NOT idle (a queue task is in flight)', () => {
        upsertMeshMission(meshId, { title: 'Active work', goal: 'x' });
        enqueueTask(meshId, 'do the thing', { difficulty: 'medium' }); // pending queue task → totalActiveCount > 0
        const coord = makeCoordinator();

        const fired = maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000);
        expect(fired).toBe(false);
        expect(coord.calls).toHaveLength(0);
    });

    // A running `mesh_refine_node` job is recorded in the ledger as a `task_dispatched`
    // refine entry with no matching terminal. buildMeshActiveWork does not model refine jobs,
    // so without the explicit async-refine gate this mesh reads as "no work in flight" and the
    // reminder would push the coordinator to close a mission whose verification is still running.
    function appendRefineDispatch(id: string) {
        appendLedgerEntry(meshId, {
            kind: 'task_dispatched',
            nodeId: 'node-a',
            payload: {
                source: 'refine_mesh_node_async_job',
                refineJob: { jobId: id, status: 'accepted', meshId, nodeId: 'node-a' },
                async: true,
            },
        } as any);
    }
    function appendRefineTerminal(id: string) {
        appendLedgerEntry(meshId, {
            kind: 'task_completed',
            nodeId: 'node-a',
            payload: {
                source: 'refine_mesh_node_async_job',
                refineJob: { jobId: id, status: 'completed', meshId, nodeId: 'node-a' },
                async: true,
                success: true,
            },
        } as any);
    }

    it('no-op when an async refine job is in flight (accepted/running)', () => {
        upsertMeshMission(meshId, { title: 'Refining branch', goal: 'x' });
        appendRefineDispatch('job-inflight');
        const coord = makeCoordinator();

        const fired = maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000);
        expect(fired).toBe(false);
        expect(coord.calls).toHaveLength(0);
    });

    it('fires once the async refine job terminates and nothing else is in flight', () => {
        upsertMeshMission(meshId, { title: 'Refining branch', goal: 'x' });
        appendRefineDispatch('job-done');
        const coord = makeCoordinator();

        // Still running → suppressed.
        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000)).toBe(false);
        // Terminal entry lands → the job is no longer active → reminder now fires.
        appendRefineTerminal('job-done');
        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 2_000)).toBe(true);
        expect(coord.calls).toHaveLength(1);
    });

    // ── IDLE-REFINE-TAIL-BLINDSPOT ────────────────────────────────────────────────
    //
    // The async-refine gate used to derive its in-flight jobs from the SAME
    // `readLedgerEntries(meshId, { tail: 200 })` window the active-work summary reads.
    // `tail` slices the last N entries of EVERY kind, so ledger churn from unrelated
    // events evicts a still-running refine job's `task_dispatched` row from the window —
    // and a refine pass runs typecheck/test/build for minutes, ample time for that churn.
    //
    // With the dispatch row gone, buildMeshAsyncRefineJobs reports zero active jobs, the
    // mesh reads "no work in flight", and the reminder tells the coordinator to close a
    // mission whose merge is still running. Observed twice on 2026-08-16, both times with
    // a Refinery job in `accepted`.
    //
    // The fix reads the refine slice with an explicit `kind` filter and NO tail. This test
    // pins that: the dispatch is buried under far more than 200 unrelated entries and the
    // reminder must STILL stay silent.
    it('★stays silent when an in-flight refine dispatch is buried beyond the 200-entry tail window', () => {
        upsertMeshMission(meshId, { title: 'Refining under churn', goal: 'x' });
        appendRefineDispatch('job-buried');

        // Bury it under unrelated ledger traffic — more than the 200-entry tail window, of
        // a kind the refine derivation ignores, exactly like a busy mesh produces.
        for (let i = 0; i < 260; i++) {
            appendLedgerEntry(meshId, {
                kind: 'session_launched',
                nodeId: 'node-b',
                payload: { source: 'unrelated_traffic', seq: i },
            } as any);
        }

        const coord = makeCoordinator();
        // The refine job is STILL in flight (no terminal row was ever appended), so the
        // reminder must not fire. Before the fix the tail window held only the 260 filler
        // rows, the gate saw no refine job, and this fired.
        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000)).toBe(false);
        expect(coord.calls).toHaveLength(0);
    });

    // The inverse must still hold: burying entries must not permanently mute the reminder.
    // Once the refine job genuinely terminates, the reminder fires again — so the fix
    // suppresses only real in-flight work, it does not blanket-silence a busy mesh.
    it('fires once a buried refine dispatch reaches a terminal row', () => {
        upsertMeshMission(meshId, { title: 'Refining under churn', goal: 'x' });
        appendRefineDispatch('job-buried-then-done');
        for (let i = 0; i < 260; i++) {
            appendLedgerEntry(meshId, {
                kind: 'session_launched',
                nodeId: 'node-b',
                payload: { source: 'unrelated_traffic', seq: i },
            } as any);
        }
        const coord = makeCoordinator();
        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000)).toBe(false);

        appendRefineTerminal('job-buried-then-done');
        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 2_000)).toBe(true);
        expect(coord.calls).toHaveLength(1);
    });

    // ── LEDGER-KIND-TAIL-BLINDSPOT (fully-idle gate, :232-ish) ─────────────────────
    //
    // The fully-idle gate reads ledger entries via buildMeshActiveWork — the SAME
    // consumer mesh-completion-synthesis.ts / mesh-worktree-retention.ts feed — and used
    // to read `readLedgerEntries(meshId, { tail: 200 })` directly, the naive shape the
    // refine gate below was fixed away from. buildMeshActiveWork only ever reads
    // task_dispatched/task_completed/task_failed/task_stalled/task_approval_needed/
    // task_question_pending, so a kind-filtered read (readLedgerEntriesByKind, the fix)
    // can never miss evidence a bare tail would have to be lucky to still contain. This
    // test pins that directly against the function the gate delegates to: a task's
    // task_completed row, buried under 260 unrelated entries, must still be found by a
    // kind-filtered read of exactly buildMeshActiveWork's kind set.
    it('★buildMeshActiveWork kind set survives crowding beyond the 200-entry tail window', () => {
        const task = enqueueTask(meshId, 'do the thing', { difficulty: 'medium' });
        appendLedgerEntry(meshId, {
            kind: 'task_completed',
            nodeId: 'node-a',
            payload: { taskId: task.id, success: true },
        } as any);

        for (let i = 0; i < 260; i++) {
            appendLedgerEntry(meshId, {
                kind: 'session_launched',
                nodeId: 'node-b',
                payload: { source: 'unrelated_traffic', seq: i },
            } as any);
        }

        const entries = readLedgerEntriesByKind(meshId, [
            'task_dispatched', 'task_completed', 'task_failed', 'task_stalled',
            'task_approval_needed', 'task_question_pending',
        ]);
        // The terminal row for `task.id` must still be present even though 260 unrelated
        // entries were appended after it — a bare tail:200 window would have evicted it.
        expect(entries.some(e => e.kind === 'task_completed' && e.payload?.taskId === task.id)).toBe(true);
    });

    it('debounces a second reminder for the same mission set inside the window', () => {
        upsertMeshMission(meshId, { title: 'Lingering', goal: 'x' });
        const coord = makeCoordinator();

        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000)).toBe(true);
        // Same set, still inside the window → suppressed.
        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000 + 5_000)).toBe(false);
        expect(coord.calls).toHaveLength(1);
    });

    it('re-fires when the active mission set changes', () => {
        const a = upsertMeshMission(meshId, { title: 'Mission A', goal: 'x' });
        const coord = makeCoordinator();

        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000)).toBe(true);
        // Add a second active mission → the set hash changes → re-fire even inside the window.
        upsertMeshMission(meshId, { title: 'Mission B', goal: 'y' });
        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 2_000)).toBe(true);
        expect(coord.calls).toHaveLength(2);
        void a;
    });

    it('re-fires after the debounce window elapses for an unchanged set', () => {
        upsertMeshMission(meshId, { title: 'Persistent', goal: 'x' });
        const coord = makeCoordinator();

        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000)).toBe(true);
        const later = 1_000 + IDLE_REMINDER_DEBOUNCE_MS + 1;
        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, later)).toBe(true);
        expect(coord.calls).toHaveLength(2);
    });

    // ── MISSION-SET-GROWTH-BYPASS: 2026-08-17 repeat-fire root cause ────────────────
    //
    // The coordinator re-upserting the SAME mission (same mission_id, edited goal text)
    // is routine bookkeeping, not new work. missionSetHash never included goal text, so
    // this was never the literal trigger — but ANY hash difference used to bypass the
    // debounce, and upsertMeshMission's ledger write / status normalization made the
    // mission's updatedAt (and, in the observed incidents, mission set membership via
    // close+reopen bookkeeping) churn on every coordinator upsert. The net effect: routine
    // mission maintenance kept re-arming the reminder. This test pins the direct case —
    // re-upserting the same id with only goal text changed — never bypasses the window.
    it('★does NOT re-fire when only an existing mission\'s goal text is edited (same mission_id)', () => {
        const m = upsertMeshMission(meshId, { title: 'Ship pipeline', goal: 'original goal text' });
        const coord = makeCoordinator();

        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000)).toBe(true);

        // Routine coordinator bookkeeping: re-upsert the SAME mission_id with new goal text.
        // The active-mission id SET is unchanged (still just [m.id]) even though the
        // mission record's content and updatedAt changed underneath it.
        upsertMeshMission(meshId, { id: m.id, title: 'Ship pipeline', goal: 'revised goal text after progress' });

        // Still well inside the 5-minute window, and no NEW mission id entered the set →
        // must stay silent. Before the fix, any hash change (which this scenario did NOT
        // even need to produce, since the id set is unchanged) would have been the trigger
        // path for the broader class of routine-upsert re-fires.
        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000 + 5_000)).toBe(false);
        expect(coord.calls).toHaveLength(1);
    });

    // The inverse must still hold: a GENUINELY new mission still nudges immediately, even
    // inside the debounce window — the original bypass intent ("new work needs attention
    // now") must survive the fix.
    it('still fires immediately when a genuinely NEW mission is added inside the debounce window', () => {
        upsertMeshMission(meshId, { title: 'Existing mission', goal: 'x' });
        const coord = makeCoordinator();

        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000)).toBe(true);

        // A brand-new mission id enters the active set → growth → immediate re-fire, even
        // though we are only 5s into the 5-minute window.
        upsertMeshMission(meshId, { title: 'Newly discovered work', goal: 'y' });
        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000 + 5_000)).toBe(true);
        expect(coord.calls).toHaveLength(2);
    });

    // Closing a mission (a legitimate coordinator action) shrinks the set and must not
    // re-arm the reminder for the remaining mission(s) either.
    it('does NOT re-fire when a mission is closed and the surviving set is a subset of the last-fired set', () => {
        const a = upsertMeshMission(meshId, { title: 'Mission A', goal: 'x' });
        const b = upsertMeshMission(meshId, { title: 'Mission B', goal: 'y' });
        const coord = makeCoordinator();

        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000)).toBe(true);
        expect(coord.calls).toHaveLength(1);

        // Close mission B — the active set shrinks from {A, B} to {A}.
        upsertMeshMission(meshId, { id: b.id, title: 'Mission B', status: 'completed' });
        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000 + 5_000)).toBe(false);
        expect(coord.calls).toHaveLength(1);
        void a;
    });

    it('no-op when policy.idleActiveMissionReminder === false', () => {
        upsertMeshMission(meshId, { title: 'Suppressed', goal: 'x' });
        const coord = makeCoordinator();

        const fired = maybeInjectIdleActiveMissionReminder(
            meshId,
            coord.instance,
            { idleActiveMissionReminder: false } as any,
            1_000,
        );
        expect(fired).toBe(false);
        expect(coord.calls).toHaveLength(0);
    });

    // ── localNonCoordinatorSessionBusy (pure) ───────────────────────────────────────
    describe('localNonCoordinatorSessionBusy (pure)', () => {
        it('is false with no local sessions', () => {
            expect(localNonCoordinatorSessionBusy([], 'mesh-x', 1_000)).toBe(false);
            expect(localNonCoordinatorSessionBusy(undefined, 'mesh-x', 1_000)).toBe(false);
        });

        it('is true when a non-coordinator local session is generating', () => {
            const states = [localState({ instanceId: 'direct-1', status: 'generating', lastUpdated: 1_000 })];
            expect(localNonCoordinatorSessionBusy(states, 'mesh-x', 1_000)).toBe(true);
        });

        it('is true when a non-coordinator local session is parked on an approval/choice modal', () => {
            const waitingApproval = [localState({ status: 'waiting_approval', lastUpdated: 1_000 })];
            expect(localNonCoordinatorSessionBusy(waitingApproval, 'mesh-x', 1_000)).toBe(true);
            const waitingChoice = [localState({ status: 'waiting_choice', lastUpdated: 1_000 })];
            expect(localNonCoordinatorSessionBusy(waitingChoice, 'mesh-x', 1_000)).toBe(true);
        });

        it('excludes a session that is the mesh\'s own coordinator, even if generating', () => {
            const states = [localState({
                instanceId: 'coord-1',
                status: 'generating',
                settings: { meshCoordinatorFor: 'mesh-x' },
                lastUpdated: 1_000,
            })];
            expect(localNonCoordinatorSessionBusy(states, 'mesh-x', 1_000)).toBe(false);
        });

        it('does not exclude a coordinator session for a DIFFERENT mesh', () => {
            const states = [localState({
                instanceId: 'coord-other-mesh',
                status: 'generating',
                settings: { meshCoordinatorFor: 'mesh-other' },
                lastUpdated: 1_000,
            })];
            expect(localNonCoordinatorSessionBusy(states, 'mesh-x', 1_000)).toBe(true);
        });

        it('ignores a stale entry (past LOCAL_SESSION_STALE_MS) rather than treating it as busy', () => {
            const now = 1_000_000;
            const states = [localState({ status: 'generating', lastUpdated: now - LOCAL_SESSION_STALE_MS - 1 })];
            expect(localNonCoordinatorSessionBusy(states, 'mesh-x', now)).toBe(false);
        });

        it('still treats a fresh entry within the staleness window as busy', () => {
            const now = 1_000_000;
            const states = [localState({ status: 'generating', lastUpdated: now - LOCAL_SESSION_STALE_MS + 1 })];
            expect(localNonCoordinatorSessionBusy(states, 'mesh-x', now)).toBe(true);
        });
    });

    // ── DIRECT-SESSION-IDLE-BLINDSPOT ────────────────────────────────────────────────
    //
    // A directly-launched (not via mesh_enqueue_task/mesh_send_task) session has no
    // mesh_queue or mesh_direct_dispatches row, so buildMeshActiveWork's totalActiveCount
    // stays 0 while it is generating. Repro: the mesh has an active mission, no queue/
    // direct work, no refine job — the pre-fix gates all read "idle" — yet a local
    // instanceManager session is genuinely generating. Before the fix (no instanceManager
    // param / no local-session check) this fires; after the fix it must stay silent.
    it('★DIRECT-SESSION-IDLE-BLINDSPOT: stays silent when a directly-launched local session is generating', () => {
        upsertMeshMission(meshId, { title: 'Direct session in flight', goal: 'x' });
        const coord = makeCoordinator();
        const instanceManager = makeInstanceManager([
            localState({ instanceId: 'direct-session-1', status: 'generating', lastUpdated: 1_000 }),
        ]);

        const fired = maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000, instanceManager);
        expect(fired).toBe(false);
        expect(coord.calls).toHaveLength(0);
    });

    it('fires once the direct session returns to idle and nothing else is in flight', () => {
        upsertMeshMission(meshId, { title: 'Direct session finishing', goal: 'x' });
        const coord = makeCoordinator();
        const busyManager = makeInstanceManager([
            localState({ instanceId: 'direct-session-2', status: 'generating', lastUpdated: 1_000 }),
        ]);
        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000, busyManager)).toBe(false);

        const idleManager = makeInstanceManager([
            localState({ instanceId: 'direct-session-2', status: 'idle', lastUpdated: 2_000 }),
        ]);
        expect(maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 2_000, idleManager)).toBe(true);
        expect(coord.calls).toHaveLength(1);
    });

    // ── self-coordinator exclusion regression guard ──────────────────────────────────
    //
    // Without exclusion, reading local session state would see the CALLING coordinator's
    // own instance (which the reconcile/forwarding call sites only reach at an idle edge)
    // as "busy" and permanently suppress the reminder. This pins that the coordinator's
    // own session for THIS mesh — even if its snapshot momentarily reads 'generating' —
    // must never by itself block the reminder.
    it('★self-coordinator exclusion: fires when only the coordinator\'s OWN session is generating', () => {
        upsertMeshMission(meshId, { title: 'Coordinator self session', goal: 'x' });
        const coord = makeCoordinator();
        const instanceManager = makeInstanceManager([
            localState({
                instanceId: 'this-coordinator-session',
                status: 'generating',
                settings: { meshCoordinatorFor: meshId },
                lastUpdated: 1_000,
            }),
        ]);

        const fired = maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000, instanceManager);
        expect(fired).toBe(true);
        expect(coord.calls).toHaveLength(1);
    });

    it('is unaffected when no instanceManager is passed (backward-compatible call sites)', () => {
        upsertMeshMission(meshId, { title: 'No instanceManager arg', goal: 'x' });
        const coord = makeCoordinator();
        const fired = maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000);
        expect(fired).toBe(true);
        expect(coord.calls).toHaveLength(1);
    });

    it('is best-effort: a throwing instanceManager does not block the reminder', () => {
        upsertMeshMission(meshId, { title: 'Broken instanceManager', goal: 'x' });
        const coord = makeCoordinator();
        const throwingManager = { collectAllStates: () => { throw new Error('boom'); } } as any;
        const fired = maybeInjectIdleActiveMissionReminder(meshId, coord.instance, undefined, 1_000, throwingManager);
        expect(fired).toBe(true);
        expect(coord.calls).toHaveLength(1);
    });
});
