/**
 * background-task-detector — antigravity-cli async run_command authority.
 *
 * (Early-turn-completion defect, 2026-08-28: an antigravity mesh worker ended
 * its turn with progress prose while an async `run_command` cell was still
 * running, and the completion path projected agent:generating_completed —
 * three times in one day. TRACKED_AGENT_TYPES covered only claude-cli/kimi, so
 * antigravity reported support:'unknown' and the background_task_active hold
 * was silently inert; the antigravity_hold_pty_active hold is PTY-spinner
 * -based and has already released by the time the "still in progress" prose
 * lands in the transcript.)
 *
 * The durable authority is antigravity's per-session SQLite store
 * (conversations/<uuid>.db), verified by surveying 40 live stores:
 *   - launch:  a tool row whose `task_details` blob carries the task identity
 *              `<conversation-uuid>/task-<launchStepIdx>` AND whose payload
 *              names the `run_command` tool — present exactly when a
 *              run_command went async (a sync command that finished inside
 *              WaitMsBeforeAsync has EMPTY task_details). The launch is NOT
 *              identified by step_type: async run_command appears under both
 *              step_type 21 (40 rows) and step_type 132 (12 rows), so keying
 *              on one step_type misses most launches;
 *   - NOT a launch: a `schedule` timer row (step_type 132, 16 rows) also
 *              carries a task id in task_details but NEVER emits a terminal
 *              signal — measured resolution was run_command 51/52 (98%) vs
 *              schedule 0/16 (0%). Admitting timers would pin the hold to its
 *              cap on every session that used one, so the tool name excludes
 *              them;
 *   - resolve: a step_type 101 task message (`Task id "<id>" finished with
 *              result:` / `… was canceled with result:` — every observed 101
 *              task message is terminal), or a manage_task status-check result
 *              (`Task: <id>` + `Status: DONE`; RUNNING is NOT terminal).
 *
 * Ownership is scoped to the current turn (launches after the last step_type
 * 14 user row): a detached background command from an earlier turn never
 * blocks. The consuming hold is time-bounded (BACKGROUND_TASK_HOLD_MAX_MS),
 * so an intentional long-lived background (dev server) delays but never pins
 * completion.
 *
 * Covered classes: record-level pairing (unresolved hold / RUNNING still
 * holds / DONE status release / notification release / earlier-turn scope /
 * sync-command control), the DB-level end-to-end read (red when the
 * antigravity registration is reverted → support:'unknown'), and the
 * completion-preflight hold chain fed by the real fixture (hold engages,
 * cap expiry releases — the false-positive guard).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    detectAntigravityFromRecords,
    detectBackgroundTaskActive,
} from '../../../src/providers/spec/background-task-detector.js';
import { decideCompletionPreflight } from '../../../src/providers/completion/completion-engine.js';
import type {
    CompletionArmState,
    CompletionPolicy,
    CompletionSignalReader,
} from '../../../src/providers/completion/completion-engine.js';
import type { AgyTaskLifecycleStep } from '../../../src/providers/native-history/antigravity-cli-transcript.js';

// Isolated fake HOME.
//
// The mock factory creates the directory itself rather than closing over a
// module-scope variable: vi.mock is hoisted above every statement in this
// file, and the module graph under test calls os.homedir() at IMPORT time
// (native-history/hermes-cli-transcript.ts module scope), before any hook or
// initializer here has run. A `let` would throw TDZ; a `var` would be
// `undefined`. Stashing the path on globalThis lets the tests read the same
// value the mock already committed to.
//
// (TMPDIR comes from env, not os.tmpdir(): calling the module being mocked
// from inside its own factory would be circular.)
vi.mock('os', async () => {
    const actual = await vi.importActual<typeof import('os')>('os');
    const g = globalThis as { __agyTmpHome?: string };
    if (!g.__agyTmpHome) {
        const nodeFs = await vi.importActual<typeof import('fs')>('fs');
        const nodePath = await vi.importActual<typeof import('path')>('path');
        g.__agyTmpHome = nodeFs.mkdtempSync(
            nodePath.join(process.env.TMPDIR || '/tmp', 'agy-bg-detector-'),
        );
    }
    return {
        ...actual,
        homedir: () => g.__agyTmpHome as string,
    };
});

/** The mocked homedir — the fake HOME every fixture is written under. */
function fakeHome(): string {
    return (globalThis as { __agyTmpHome?: string }).__agyTmpHome as string;
}

// ── Record builders (normalized readTaskLifecycleSteps output) ──────────────

const CONV = 'aaaaaaaa-1111-4000-8000-000000000001';
const TASK_7 = `${CONV}/task-7`;
const TASK_9 = `${CONV}/task-9`;

function user(idx: number): AgyTaskLifecycleStep {
    return { idx, kind: 'user' };
}

function launch(idx: number, taskId = TASK_7): AgyTaskLifecycleStep {
    return { idx, kind: 'launch', taskId };
}

function status(idx: number, taskId: string, terminal: boolean): AgyTaskLifecycleStep {
    return { idx, kind: 'status', taskId, terminal };
}

function notification(idx: number, taskId = TASK_7): AgyTaskLifecycleStep {
    return { idx, kind: 'notification', taskId, terminal: true };
}

// ── Minimal protobuf encoders (mirror the real antigravity step_payload) ────

function encodeVarint(value: number): Buffer {
    const bytes: number[] = [];
    let v = value;
    do {
        let b = v & 0x7f;
        v = Math.floor(v / 128);
        if (v > 0) b |= 0x80;
        bytes.push(b);
    } while (v > 0);
    return Buffer.from(bytes);
}

function strField(field: number, text: string): Buffer {
    const payload = Buffer.from(text, 'utf-8');
    return Buffer.concat([encodeVarint(field * 8 + 2), encodeVarint(payload.length), payload]);
}

/** Real store step_types. Async run_command launches appear under BOTH of the
 *  tool step types, which is exactly why the detector keys on the tool name. */
const ST_USER = 14;
const ST_TOOL_21 = 21;
const ST_TOOL_132 = 132;
const ST_TASK_MESSAGE = 101;

/** Tool row payload: call id + tool name + args JSON (mirrors the live
 *  layout — the tool name precedes the `{"…}` args blob). */
function encodeLaunchPayload(callId: string, command: string): Buffer {
    return Buffer.concat([
        strField(1, callId),
        strField(2, 'run_command'),
        strField(3, JSON.stringify({
            CommandLine: command,
            Cwd: '/workspace/repo',
            WaitMsBeforeAsync: 5000,
            toolAction: `Running ${command}`,
            toolSummary: command,
        })),
    ]);
}

/** task_details blob of an ASYNC launch: task id + log URI + command. */
function encodeTaskDetails(taskId: string, command: string): Buffer {
    return Buffer.concat([
        strField(1, taskId),
        strField(2, `file:///home/user/.gemini/antigravity-cli/brain/${CONV}/.system_generated/tasks/${taskId.split('/')[1]}.log`),
        strField(3, command),
    ]);
}

/** `schedule` (timer) row payload — the false-positive class. Carries a task
 *  id in task_details exactly like a launch, but is a wait-timer, not a
 *  command, and never receives a terminal delivery. */
function encodeSchedulePayload(callId: string, seconds: number): Buffer {
    return Buffer.concat([
        strField(1, callId),
        strField(2, 'schedule'),
        strField(3, JSON.stringify({
            DurationSeconds: String(seconds),
            Prompt: 'Check task status.',
            toolAction: 'Waiting for task',
            toolSummary: 'Wait for task',
        })),
    ]);
}

/** manage_task status-check payload: args + result text. Note the result text
 *  embeds the literal `run_command`, so a loose tool-name test would misread
 *  this as a launch — the detector anchors on the pre-args header instead. */
function encodeStatusPayload(callId: string, taskId: string, taskStatus: string): Buffer {
    return Buffer.concat([
        strField(1, callId),
        strField(2, 'manage_task'),
        strField(3, JSON.stringify({ Action: 'status', TaskId: taskId, toolAction: 'Checking task status', toolSummary: 'Check' })),
        strField(4, `Task: ${taskId}\nStatus: ${taskStatus}\nTool: run_command\nLog: /home/user/.gemini/antigravity-cli/brain/${CONV}/.system_generated/tasks/${taskId.split('/')[1]}.log\nLog output:\n…`),
    ]);
}

/** step_type 101 task message payload (terminal delivery). */
function encodeTaskMessagePayload(taskId: string, phrasing: string): Buffer {
    return strField(1, `[Message] timestamp=2026-08-28T18:32:02Z sender=${taskId} priority=MESSAGE_PRIORITY_HIGH content=Task id "${taskId}" ${phrasing}:\nThe command exited with code 0.\nOutput:\ndone`);
}

interface FixtureStep {
    idx: number;
    step_type: number;
    payload?: Buffer;
    task_details?: Buffer;
}

async function writeConversationDb(sessionId: string, steps: FixtureStep[]): Promise<string> {
    const dir = path.join(fakeHome(), '.gemini', 'antigravity-cli', 'conversations');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sessionId}.db`);
    const { loadBetterSqlite3 } = await import('../../../src/system/load-better-sqlite3.js');
    const Database = loadBetterSqlite3();
    const db = new Database(filePath);
    db.exec(
        'CREATE TABLE `steps` (`idx` integer, `step_type` integer NOT NULL DEFAULT 0, ' +
        '`status` integer NOT NULL DEFAULT 0, `task_details` blob, `step_payload` blob, ' +
        'PRIMARY KEY (`idx`));',
    );
    const insert = db.prepare(
        'INSERT INTO steps (idx, step_type, status, task_details, step_payload) VALUES (?, ?, ?, ?, ?)',
    );
    for (const step of steps) {
        insert.run(step.idx, step.step_type, 3, step.task_details ?? null, step.payload ?? null);
    }
    db.close();
    return filePath;
}

async function appendSteps(dbPath: string, steps: FixtureStep[]): Promise<void> {
    const { loadBetterSqlite3 } = await import('../../../src/system/load-better-sqlite3.js');
    const Database = loadBetterSqlite3();
    const db = new Database(dbPath);
    const insert = db.prepare(
        'INSERT INTO steps (idx, step_type, status, task_details, step_payload) VALUES (?, ?, ?, ?, ?)',
    );
    for (const step of steps) {
        insert.run(step.idx, step.step_type, 3, step.task_details ?? null, step.payload ?? null);
    }
    db.close();
}

function detectForConversation(sessionId: string) {
    return detectBackgroundTaskActive(undefined, {
        agentType: 'antigravity-cli',
        providerSessionId: sessionId,
        sessionStartedAtMs: Date.now() - 60_000,
        workspace: '/workspace/repo',
        instanceId: 'sess-antigravity-bg-test',
    });
}

// ── Completion-preflight harness (the consuming hold) ────────────────────────

const POLICY: CompletionPolicy = {
    finalizationRetryMs: 1_000,
    finalizationMaxWaitMs: 30_000,
    backgroundTaskHoldMaxMs: 300_000,
    canonCMinElapsedFloorMs: 20_000,
    transcriptGrowthQuietMs: 60_000,
    holdClassHardCapMs: 300_000,
    ptyParsedFinalAssistantQuietDwellMs: 1_200,
    terminalBlockHardCapMs: 600_000,
};

function preflightWith(bg: { active: boolean; count?: number }, opts: { now: number; holdSince?: number }) {
    const arm: CompletionArmState = {
        firstObservedAt: opts.now - 5_000,
        previousStatus: 'generating',
        ...(typeof opts.holdSince === 'number' ? { backgroundTaskHoldSince: opts.holdSince } : {}),
    };
    const reader = {
        now: () => opts.now,
        visibleStatus: () => 'idle',
        busyEpoch: () => 0,
        lastOutputAt: () => undefined,
        backgroundTask: () => bg,
    } as unknown as CompletionSignalReader;
    return decideCompletionPreflight(arm, reader, POLICY);
}

// ── Tests ────────────────────────────────────────────────────────────────────

// Each test gets a clean fake HOME, but the variable is never emptied — the
// mocked homedir() must stay valid for the whole module lifetime (see above).
// Each test gets a clean fake HOME. The directory itself is recreated rather
// than repointed — the mocked homedir() must keep returning the same path for
// the whole module lifetime (see the mock factory above).
beforeEach(() => {
    fs.rmSync(fakeHome(), { recursive: true, force: true });
    fs.mkdirSync(fakeHome(), { recursive: true });
});

afterEach(() => {
    try { fs.rmSync(fakeHome(), { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('detectAntigravityFromRecords — launch/resolve pairing', () => {
    it('HOLDS while an async run_command launch has no terminal observation', () => {
        const d = detectAntigravityFromRecords([user(1), launch(7)]);
        expect(d.support).toBe('tracked');
        expect(d.active).toBe(true);
        expect(d.count).toBe(1);
        expect(d.ids).toEqual([TASK_7]);
    });

    it('still HOLDS when a manage_task status check reports RUNNING (not terminal)', () => {
        const d = detectAntigravityFromRecords([user(1), launch(7), status(9, TASK_7, false)]);
        expect(d.active).toBe(true);
        expect(d.ids).toEqual([TASK_7]);
    });

    it('RELEASES once a manage_task status check reports a terminal status', () => {
        const d = detectAntigravityFromRecords([user(1), launch(7), status(9, TASK_7, true)]);
        expect(d.active).toBe(false);
        expect(d.support).toBe('tracked');
    });

    it('RELEASES once the step_type 101 task message delivers the result', () => {
        const d = detectAntigravityFromRecords([user(1), launch(7), notification(11)]);
        expect(d.active).toBe(false);
    });

    it('scopes ownership to the current turn: a launch BEFORE the last user step never blocks', () => {
        // Detached background from an earlier turn (e.g. a dev server the user
        // asked for two tasks ago) must not pin this turn's completion.
        const d = detectAntigravityFromRecords([user(1), launch(7), user(20)]);
        expect(d.active).toBe(false);
    });

    it('only tracks the unresolved cell when several are in flight', () => {
        const d = detectAntigravityFromRecords([
            user(1),
            launch(7, TASK_7),
            launch(9, TASK_9),
            notification(11, TASK_7),
        ]);
        expect(d.active).toBe(true);
        expect(d.ids).toEqual([TASK_9]);
    });

    it('a turn with no async launches is clean (sync-command control)', () => {
        const d = detectAntigravityFromRecords([user(1), user(5)]);
        expect(d.active).toBe(false);
        expect(d.support).toBe('tracked');
    });
});

describe('detectBackgroundTaskActive — antigravity-cli .db end to end', () => {
    it('reads a live fixture store and HOLDS on the unresolved async cell (red without the antigravity registration)', async () => {
        await writeConversationDb(CONV, [
            { idx: 1, step_type: ST_USER, payload: strField(19, 'run the vendor sync and report') },
            { idx: 7, step_type: ST_TOOL_21, payload: encodeLaunchPayload('call_100', 'npm run bundle:vendor:all'), task_details: encodeTaskDetails(TASK_7, 'npm run bundle:vendor:all') },
            { idx: 9, step_type: ST_TOOL_132, payload: encodeStatusPayload('call_101', TASK_7, 'RUNNING') },
        ]);

        const d = detectForConversation(CONV);
        // Reverting the fix (antigravity-cli dropped from TRACKED_AGENT_TYPES /
        // the cli-adapter branch) collapses this to support:'unknown',
        // active:false — the defect path — and this assertion goes red.
        expect(d.support).toBe('tracked');
        expect(d.active).toBe(true);
        expect(d.ids).toEqual([TASK_7]);
    });

    it('detects a launch under step_type 132 too (the tool name, not the step_type, is the rule)', async () => {
        // Live stores put async run_command under BOTH 21 and 132. Keying on a
        // single step_type would miss this store's only background cell.
        await writeConversationDb(CONV, [
            { idx: 1, step_type: ST_USER, payload: strField(19, 'run the suite') },
            { idx: 7, step_type: ST_TOOL_132, payload: encodeLaunchPayload('call_100', 'npm test'), task_details: encodeTaskDetails(TASK_7, 'npm test') },
        ]);
        const d = detectForConversation(CONV);
        expect(d.active).toBe(true);
        expect(d.ids).toEqual([TASK_7]);
    });

    it('PASSES once the terminal task message lands in the store', async () => {
        const dbPath = await writeConversationDb(CONV, [
            { idx: 1, step_type: ST_USER, payload: strField(19, 'run the vendor sync and report') },
            { idx: 7, step_type: ST_TOOL_21, payload: encodeLaunchPayload('call_100', 'npm run bundle:vendor:all'), task_details: encodeTaskDetails(TASK_7, 'npm run bundle:vendor:all') },
        ]);
        expect(detectForConversation(CONV).active).toBe(true);

        await appendSteps(dbPath, [
            { idx: 12, step_type: ST_TASK_MESSAGE, payload: encodeTaskMessagePayload(TASK_7, 'finished with result') },
        ]);
        const d = detectForConversation(CONV);
        expect(d.support).toBe('tracked');
        expect(d.active).toBe(false);
    });

    it('PASSES on a canceled delivery too (an explicit kill is terminal)', async () => {
        await writeConversationDb(CONV, [
            { idx: 1, step_type: ST_USER, payload: strField(19, 'run it') },
            { idx: 7, step_type: ST_TOOL_21, payload: encodeLaunchPayload('call_100', 'npm install'), task_details: encodeTaskDetails(TASK_7, 'npm install') },
            { idx: 10, step_type: ST_TASK_MESSAGE, payload: encodeTaskMessagePayload(TASK_7, 'was canceled with result') },
        ]);
        expect(detectForConversation(CONV).active).toBe(false);
    });

    it('PASSES once a manage_task status check observes DONE', async () => {
        await writeConversationDb(CONV, [
            { idx: 1, step_type: ST_USER, payload: strField(19, 'run it') },
            { idx: 7, step_type: ST_TOOL_21, payload: encodeLaunchPayload('call_100', 'npm test'), task_details: encodeTaskDetails(TASK_7, 'npm test') },
            { idx: 9, step_type: ST_TOOL_132, payload: encodeStatusPayload('call_101', TASK_7, 'DONE') },
        ]);
        expect(detectForConversation(CONV).active).toBe(false);
    });

    it('ignores a sync run_command (empty task_details — the false-positive control)', async () => {
        await writeConversationDb(CONV, [
            { idx: 1, step_type: ST_USER, payload: strField(19, 'check git status') },
            // Same run_command shape as the launch, but the command finished
            // inside WaitMsBeforeAsync → no task_details → no launch.
            { idx: 3, step_type: ST_TOOL_21, payload: encodeLaunchPayload('call_200', 'git status') },
        ]);
        const d = detectForConversation(CONV);
        expect(d.support).toBe('tracked');
        expect(d.active).toBe(false);
    });

    it('ignores a `schedule` timer that carries a task id (the permanent-hold false positive)', async () => {
        // A timer row is shaped like a launch — step_type 132 WITH a task id in
        // task_details — but it is a wait, not a command, and never receives a
        // terminal delivery (0/16 resolved across the surveyed stores). Reading
        // it as a launch would hold completion until BACKGROUND_TASK_HOLD_MAX_MS
        // on every session that waited on a task.
        await writeConversationDb(CONV, [
            { idx: 1, step_type: ST_USER, payload: strField(19, 'wait for the deploy') },
            { idx: 8, step_type: ST_TOOL_132, payload: encodeSchedulePayload('call_300', 30), task_details: encodeTaskDetails(`${CONV}/task-8`, 'Timer: 30s, Prompt: Check task status.') },
        ]);
        const d = detectForConversation(CONV);
        expect(d.support).toBe('tracked');
        expect(d.active).toBe(false);
    });

    it('holds on the run_command launch while ignoring an interleaved timer', async () => {
        await writeConversationDb(CONV, [
            { idx: 1, step_type: ST_USER, payload: strField(19, 'deploy and wait') },
            { idx: 7, step_type: ST_TOOL_21, payload: encodeLaunchPayload('call_100', 'npm run deploy'), task_details: encodeTaskDetails(TASK_7, 'npm run deploy') },
            { idx: 8, step_type: ST_TOOL_132, payload: encodeSchedulePayload('call_300', 30), task_details: encodeTaskDetails(`${CONV}/task-8`, 'Timer: 30s, Prompt: Check task status.') },
        ]);
        const d = detectForConversation(CONV);
        expect(d.active).toBe(true);
        // Only the command cell — the timer must not inflate the count.
        expect(d.ids).toEqual([TASK_7]);
        expect(d.count).toBe(1);
    });

    it('does not read a manage_task status row as a launch even though its text names run_command', async () => {
        // Defence in depth: the status result text embeds `run_command`, so a
        // bare substring test would invent a launch for a task that already
        // resolved. The detector anchors the tool name before the args JSON.
        await writeConversationDb(CONV, [
            { idx: 1, step_type: ST_USER, payload: strField(19, 'check it') },
            { idx: 9, step_type: ST_TOOL_132, payload: encodeStatusPayload('call_101', TASK_9, 'DONE'), task_details: encodeTaskDetails(TASK_9, 'npm test') },
        ]);
        const d = detectForConversation(CONV);
        expect(d.active).toBe(false);
    });

    it('fails open (tracked, inactive) when the store is unreadable', () => {
        const d = detectForConversation('bbbbbbbb-2222-4000-8000-000000000002');
        expect(d.support).toBe('tracked');
        expect(d.active).toBe(false);
    });

    it('reports support:unknown for an unregistered provider (explicit-UNKNOWN control)', () => {
        const d = detectBackgroundTaskActive(undefined, { agentType: 'codex-cli' });
        expect(d.support).toBe('unknown');
        expect(d.active).toBe(false);
    });
});

describe('completion preflight — background_task_active hold fed by the antigravity fixture', () => {
    it('HOLDS completion while the fixture store has an unresolved async cell', async () => {
        await writeConversationDb(CONV, [
            { idx: 1, step_type: ST_USER, payload: strField(19, 'run the build') },
            { idx: 7, step_type: ST_TOOL_21, payload: encodeLaunchPayload('call_100', 'npm run build'), task_details: encodeTaskDetails(TASK_7, 'npm run build') },
        ]);
        const bg = detectForConversation(CONV);
        const decision = preflightWith(bg, { now: 100_000 });
        expect(decision.kind).toBe('hold');
        expect(decision.kind === 'hold' && decision.reason).toBe('background_task_active');
    });

    it('RELEASES to normal finalization once BACKGROUND_TASK_HOLD_MAX_MS is exceeded (intentional long-lived background never pins)', async () => {
        await writeConversationDb(CONV, [
            { idx: 1, step_type: ST_USER, payload: strField(19, 'start the dev server') },
            { idx: 7, step_type: ST_TOOL_21, payload: encodeLaunchPayload('call_100', 'npm run dev'), task_details: encodeTaskDetails(TASK_7, 'npm run dev') },
        ]);
        const bg = detectForConversation(CONV);
        expect(bg.active).toBe(true);
        const now = 1_000_000;
        const decision = preflightWith(bg, { now, holdSince: now - POLICY.backgroundTaskHoldMaxMs - 1 });
        expect(decision.kind).toBe('proceed');
    });

    it('PROCEEDS immediately once the cell resolved in the store', async () => {
        await writeConversationDb(CONV, [
            { idx: 1, step_type: ST_USER, payload: strField(19, 'run the build') },
            { idx: 7, step_type: ST_TOOL_21, payload: encodeLaunchPayload('call_100', 'npm run build'), task_details: encodeTaskDetails(TASK_7, 'npm run build') },
            { idx: 12, step_type: ST_TASK_MESSAGE, payload: encodeTaskMessagePayload(TASK_7, 'finished with result') },
        ]);
        const bg = detectForConversation(CONV);
        expect(bg.active).toBe(false);
        const decision = preflightWith(bg, { now: 100_000 });
        expect(decision.kind).toBe('proceed');
    });
});
