/**
 * background-task-detector — kimi native-source run_in_background authority.
 *
 * (rc.27 delegated-background-work premature completion) A kimi mesh worker
 * launches a background exec cell (`tool.call` with run_in_background:true),
 * ends its model turn with progress prose, and the mesh projected
 * agent:generating_completed / task_completed while the cell was STILL
 * RUNNING — and again when the cell exited (notification / TaskStop) but the
 * provider had not yet consumed the result into a final assistant response.
 *
 * The durable authority is kimi's append-only wire.jsonl (verified against
 * live transcripts):
 *   - launch:  context.append_loop_event / tool.call (args.run_in_background
 *              === true, toolCallId) — its tool.result returns IMMEDIATELY
 *              with `task_id: bash-…` + `status: running`, so call→result
 *              pairing alone cannot detect a running cell;
 *   - resolve: a `<notification … type="task.completed|failed|timed_out|lost"
 *              source_id="bash-…">` in a turn.steer / context.append_message,
 *              or a TaskStop/TaskOutput tool.result with `task_id:` + a
 *              terminal `status:` (killed/completed/failed/…);
 *   - consume: a FINAL-ANSWER-CLASS assistant content.part text AFTER the
 *              resolution — with the step protocol present (step.end loop
 *              events), only text whose step closed with finishReason !==
 *              'tool_use' counts; progress prose mid-turn does not (a new
 *              turn.prompt supersedes the turn instead).
 *
 * Ownership is scoped to the current turn (launches after the last
 * turn.prompt): detached/foreign/earlier-turn background work never blocks.
 *
 * These tests cover the required classes: in-flight hold, exit-alone hold,
 * final-assistant release, restart/rebind durability, cancellation, stale
 * identity, unrelated process, and the no-background control — plus the
 * claude-cli pairing control and the explicit-UNKNOWN provider control.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    detectFromRecords,
    detectKimiFromRecords,
    detectBackgroundTaskActive,
} from '../../../src/providers/spec/background-task-detector.js';

// ── wire.jsonl record builders (shape verified against live kimi sessions) ──

function prompt(text = 'run the deploy and report') {
    return { type: 'turn.prompt', input: [{ type: 'text', text }], origin: { kind: 'user' }, time: 0 };
}

function assistantText(text: string, turnId = '1') {
    return {
        type: 'context.append_loop_event',
        event: { type: 'content.part', turnId, part: { type: 'text', text } },
        time: 0,
    };
}

function thinkPart(turnId = '1') {
    return {
        type: 'context.append_loop_event',
        event: { type: 'content.part', turnId, part: { type: 'think', think: 'reasoning…' } },
        time: 0,
    };
}

function bgCall(callId: string, turnId = '1', name = 'Bash') {
    return {
        type: 'context.append_loop_event',
        event: {
            type: 'tool.call', uuid: `u-${callId}`, turnId, step: 1, stepUuid: 's1',
            toolCallId: callId, name,
            args: { command: 'npm run deploy', run_in_background: true },
        },
        time: 0,
    };
}

function fgCall(callId: string, turnId = '1') {
    return {
        type: 'context.append_loop_event',
        event: {
            type: 'tool.call', uuid: `u-${callId}`, turnId, step: 1, stepUuid: 's1',
            toolCallId: callId, name: 'Bash', args: { command: 'ls -la' },
        },
        time: 0,
    };
}

function fgResult(callId: string, output = 'ok') {
    return {
        type: 'context.append_loop_event',
        event: { type: 'tool.result', parentUuid: `u-${callId}`, toolCallId: callId, result: { output } },
        time: 0,
    };
}

/** The launch result returns immediately with status: running. */
function launchResult(callId: string, taskId: string) {
    return {
        type: 'context.append_loop_event',
        event: {
            type: 'tool.result', parentUuid: `u-${callId}`, toolCallId: callId,
            result: { output: `task_id: ${taskId}\npid: 87098\ndescription: deploy\nstatus: running\nautomatic_notification: true` },
        },
        time: 0,
    };
}

/** A rejected/failed launch (e.g. approval denied): no task_id, no running status. */
function rejectedLaunchResult(callId: string) {
    return {
        type: 'context.append_loop_event',
        event: {
            type: 'tool.result', parentUuid: `u-${callId}`, toolCallId: callId,
            result: { output: 'Tool "Bash" was not run because the user rejected the approval request.', isError: true },
        },
        time: 0,
    };
}

function notificationSteer(taskId: string, type = 'task.completed') {
    return {
        type: 'turn.steer',
        input: [{
            type: 'text',
            text: `<notification id="task:${taskId}:${type.split('.')[1]}" category="task" type="${type}" source_kind="background_task" source_id="${taskId}">\nTitle: Background task finished\n</notification>`,
        }],
        origin: { kind: 'system' },
        time: 0,
    };
}

function notificationAppendMessage(taskId: string, type = 'task.failed') {
    return {
        type: 'context.append_message',
        message: {
            role: 'user',
            content: [{
                type: 'text',
                text: `<notification id="task:${taskId}:${type.split('.')[1]}" category="task" type="${type}" source_kind="background_task" source_id="${taskId}">\nTitle: Background task failed\n</notification>`,
            }],
        },
        time: 0,
    };
}

/** TaskStop / TaskOutput result carrying a terminal status. */
function taskAdminResult(callId: string, taskId: string, status: string) {
    return {
        type: 'context.append_loop_event',
        event: {
            type: 'tool.result', parentUuid: `u-${callId}`, toolCallId: callId,
            result: { output: `task_id: ${taskId}\nstatus: ${status}\nreason: restart to pick up config` },
        },
        time: 0,
    };
}

// ── detectKimiFromRecords (pure lifecycle logic) ─────────────────────────────

describe('detectKimiFromRecords — background cell lifecycle', () => {
    it('HOLDS while a launched background cell is still running (launch result says status: running)', () => {
        const r = detectKimiFromRecords([
            prompt(),
            bgCall('tool_1'),
            launchResult('tool_1', 'bash-aaa1'),
            assistantText('Deploy started; I will report once it finishes.'),
        ]);
        expect(r.active).toBe(true);
        expect(r.count).toBe(1);
        expect(r.ids).toEqual(['bash-aaa1']);
        expect(r.support).toBe('tracked');
    });

    it('HOLDS when the background call exists but its launch result has not landed yet', () => {
        const r = detectKimiFromRecords([prompt(), bgCall('tool_1')]);
        expect(r.active).toBe(true);
        expect(r.ids).toEqual(['call:tool_1']);
    });

    it('still HOLDS on tool exit alone (terminal notification arrived, result not consumed into a final assistant response)', () => {
        const r = detectKimiFromRecords([
            prompt(),
            bgCall('tool_1'),
            launchResult('tool_1', 'bash-aaa1'),
            assistantText('Deploy started; waiting for completion.'),
            notificationSteer('bash-aaa1', 'task.completed'),
        ]);
        expect(r.active).toBe(true);
        expect(r.count).toBe(0);
        expect(r.pendingConsumption).toBe(true);
    });

    it('RELEASES once the provider consumes the resolution into a final assistant text', () => {
        const r = detectKimiFromRecords([
            prompt(),
            bgCall('tool_1'),
            launchResult('tool_1', 'bash-aaa1'),
            assistantText('Deploy started; waiting for completion.'),
            notificationSteer('bash-aaa1', 'task.completed'),
            assistantText('Deploy finished: 42 checks green, url live.'),
        ]);
        expect(r.active).toBe(false);
        expect(r.pendingConsumption).toBeUndefined();
    });

    it('a think part is NOT consumption — only assistant text releases the hold', () => {
        const r = detectKimiFromRecords([
            prompt(),
            bgCall('tool_1'),
            launchResult('tool_1', 'bash-aaa1'),
            notificationSteer('bash-aaa1', 'task.completed'),
            thinkPart(),
        ]);
        expect(r.active).toBe(true);
        expect(r.pendingConsumption).toBe(true);
    });

    it('a new turn.prompt supersedes the unconsumed resolution (new turn owns its own completion)', () => {
        const r = detectKimiFromRecords([
            prompt('first task'),
            bgCall('tool_1'),
            launchResult('tool_1', 'bash-aaa1'),
            notificationSteer('bash-aaa1', 'task.completed'),
            prompt('second task'),
            assistantText('Second task done.'),
        ]);
        expect(r.active).toBe(false);
    });

    it('cancellation: TaskStop result (status: killed) resolves the cell; consumed stop releases', () => {
        const r = detectKimiFromRecords([
            prompt(),
            bgCall('tool_1'),
            launchResult('tool_1', 'bash-aaa1'),
            fgCall('tool_stop'),
            taskAdminResult('tool_stop', 'bash-aaa1', 'killed'),
            assistantText('Stopped the run-2 cell as requested.'),
        ]);
        expect(r.active).toBe(false);
    });

    it('cancellation without a consuming assistant response is still held', () => {
        const r = detectKimiFromRecords([
            prompt(),
            bgCall('tool_1'),
            launchResult('tool_1', 'bash-aaa1'),
            fgCall('tool_stop'),
            taskAdminResult('tool_stop', 'bash-aaa1', 'killed'),
        ]);
        expect(r.active).toBe(true);
        expect(r.pendingConsumption).toBe(true);
    });

    it('stale/foreign identity: notifications and admin results for unknown task ids have no effect', () => {
        const r = detectKimiFromRecords([
            prompt(),
            fgCall('tool_1'),
            fgResult('tool_1'),
            notificationSteer('bash-foreign', 'task.completed'),
            taskAdminResult('tool_2', 'bash-other', 'killed'),
            assistantText('Done.'),
        ]);
        expect(r.active).toBe(false);
    });

    it('unrelated earlier-turn process: a still-running cell launched BEFORE the current prompt is out of scope', () => {
        const r = detectKimiFromRecords([
            prompt('earlier task'),
            bgCall('tool_old'),
            launchResult('tool_old', 'bash-old1'),
            assistantText('Earlier task answered (cell left running).'),
            prompt('current task'),
            assistantText('Current task done.'),
        ]);
        expect(r.active).toBe(false);
    });

    it('unrelated tools: foreground bash and non-background calls never trip the hold', () => {
        const r = detectKimiFromRecords([
            prompt(),
            fgCall('tool_1'),
            fgResult('tool_1'),
            assistantText('Listed the directory.'),
        ]);
        expect(r.active).toBe(false);
    });

    it('a rejected background launch (no task_id, no running status) is not tracked', () => {
        const r = detectKimiFromRecords([
            prompt(),
            bgCall('tool_1'),
            rejectedLaunchResult('tool_1'),
            assistantText('Understood, not running it.'),
        ]);
        expect(r.active).toBe(false);
    });

    it('multiple cells: holds until ALL resolve, then until the last resolution is consumed', () => {
        const base = [
            prompt(),
            bgCall('tool_1'),
            launchResult('tool_1', 'bash-aaa1'),
            bgCall('tool_2'),
            launchResult('tool_2', 'bash-bbb2'),
        ];
        // both running
        expect(detectKimiFromRecords(base).ids.sort()).toEqual(['bash-aaa1', 'bash-bbb2']);
        // one resolved → still running count 1
        const one = detectKimiFromRecords([...base, notificationSteer('bash-aaa1')]);
        expect(one.active).toBe(true);
        expect(one.ids).toEqual(['bash-bbb2']);
        // both resolved, not consumed → pendingConsumption
        const both = detectKimiFromRecords([...base, notificationSteer('bash-aaa1'), notificationAppendMessage('bash-bbb2', 'task.failed')]);
        expect(both.active).toBe(true);
        expect(both.pendingConsumption).toBe(true);
        // consumed → released
        expect(detectKimiFromRecords([...base, notificationSteer('bash-aaa1'), notificationAppendMessage('bash-bbb2', 'task.failed'), assistantText('One passed, one failed; summarizing.')]).active).toBe(false);
    });

    it('no-background control: a plain prompt/answer session is inactive', () => {
        expect(detectKimiFromRecords([prompt(), thinkPart(), assistantText('4.')]).active).toBe(false);
        expect(detectKimiFromRecords([]).active).toBe(false);
        expect(detectKimiFromRecords([null, 42, 'x', { type: 'metadata' }]).active).toBe(false);
    });
});

// ── dispatch + provider-class controls ───────────────────────────────────────

describe('detectFromRecords — provider dispatch controls', () => {
    it('kimi class dispatches to the kimi lifecycle detector', () => {
        const r = detectFromRecords([prompt(), bgCall('tool_1'), launchResult('tool_1', 'bash-aaa1')], 'kimi');
        expect(r.active).toBe(true);
        expect(r.ids).toEqual(['bash-aaa1']);
    });

    it('PTY-event provider control (claude-cli): tool_use/tool_result pairing is unchanged', () => {
        const claudeRecords = [
            { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
            {
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{ type: 'tool_use', id: 'bash_1', name: 'Bash', input: { command: 'npm test', run_in_background: true } }],
                },
            },
        ];
        const running = detectFromRecords(claudeRecords, 'claude-cli');
        expect(running.active).toBe(true);
        expect(running.ids).toEqual(['bash_1']);
        const resolved = detectFromRecords([
            ...claudeRecords,
            { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bash_1', content: 'ok' }] } },
        ], 'claude-cli');
        expect(resolved.active).toBe(false);
    });
});

// ── detectBackgroundTaskActive (on-disk read path, kimi session layout) ──────

const UUID = 'd3f014e8-7c09-4b97-b3dd-a7acbb46db10';
const SESSION_ID = `session_${UUID}`;
const WORKSPACE = '/Users/example/Work/myrepo';

// Mirrors the shipped kimi nativeHistory.source (adhdev-providers/cli/kimi/provider.v1.json).
function kimiCfg(sessionsDir: string) {
    return {
        source: {
            kind: 'jsonl' as const,
            path: `${sessionsDir}/*/session_*/agents/main`,
            file_pattern: 'wire.jsonl',
            session_id_from: 'dir_uuid' as const,
            workspace_from_sidecar: { rel_path: '../../state.json', workspace_path: '$.workDir' },
        },
    };
}

let tmpDir = '';
let sessionsDir = '';

function writeKimiSession(lines: unknown[]): string {
    const sessionDir = path.join(sessionsDir, 'wd_myrepo_78117b8afba9', SESSION_ID);
    const wireDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(wireDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ workDir: WORKSPACE, title: 'test' }), 'utf8');
    const wirePath = path.join(wireDir, 'wire.jsonl');
    fs.writeFileSync(wirePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
    return wirePath;
}

function detect() {
    return detectBackgroundTaskActive(kimiCfg(sessionsDir), {
        agentType: 'kimi',
        providerSessionId: SESSION_ID,
        workspace: WORKSPACE,
        sessionStartedAtMs: 0,
    });
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-bg-detect-'));
    sessionsDir = path.join(tmpDir, '.kimi-code', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('detectBackgroundTaskActive — kimi on-disk durability', () => {
    it('restart/rebind: the hold is recovered from durable transcript evidence on every fresh read', () => {
        const wirePath = writeKimiSession([
            prompt(),
            bgCall('tool_1'),
            launchResult('tool_1', 'bash-aaa1'),
            assistantText('Deploy started; waiting.'),
        ]);
        // First read (e.g. original daemon): held.
        expect(detect().active).toBe(true);
        // Fresh recompute (daemon restarted / session rebound — no in-memory
        // state is consulted; the transcript alone re-derives the hold).
        const reread = detect();
        expect(reread.active).toBe(true);
        expect(reread.ids).toEqual(['bash-aaa1']);

        // The cell exits: notification lands — exit alone is still held.
        fs.appendFileSync(wirePath, JSON.stringify(notificationSteer('bash-aaa1')) + '\n', 'utf8');
        const held = detect();
        expect(held.active).toBe(true);
        expect(held.pendingConsumption).toBe(true);

        // The provider consumes the result into the final answer: released.
        fs.appendFileSync(wirePath, JSON.stringify(assistantText('Deploy finished: all checks green.')) + '\n', 'utf8');
        expect(detect().active).toBe(false);
    });

    it('does NOT read a foreign session transcript (workspace mismatch → not selected)', () => {
        // A different session (other workspace) with a running background cell
        // must not block THIS session.
        const otherDir = path.join(sessionsDir, 'wd_other_000000000000', 'session_11111111-2222-3333-4444-555555555555');
        fs.mkdirSync(path.join(otherDir, 'agents', 'main'), { recursive: true });
        fs.writeFileSync(path.join(otherDir, 'state.json'), JSON.stringify({ workDir: '/elsewhere/other' }), 'utf8');
        fs.writeFileSync(
            path.join(otherDir, 'agents', 'main', 'wire.jsonl'),
            [prompt(), bgCall('tool_x'), launchResult('tool_x', 'bash-foreign')].map((l) => JSON.stringify(l)).join('\n') + '\n',
            'utf8',
        );
        writeKimiSession([prompt(), assistantText('Plain answer.')]);
        expect(detect().active).toBe(false);
    });

    it('explicit UNKNOWN: a provider without transcript authority is not gated (and not silently clean)', () => {
        writeKimiSession([prompt(), bgCall('tool_1'), launchResult('tool_1', 'bash-aaa1')]);
        const r = detectBackgroundTaskActive(kimiCfg(sessionsDir), {
            agentType: 'codex-cli',
            providerSessionId: SESSION_ID,
            workspace: WORKSPACE,
            sessionStartedAtMs: 0,
        });
        expect(r.active).toBe(false);
        expect(r.support).toBe('unknown');
    });

    it('kimi with no resolvable transcript is tracked-but-inactive (fail-open per read)', () => {
        const r = detectBackgroundTaskActive(kimiCfg(sessionsDir), {
            agentType: 'kimi',
            providerSessionId: SESSION_ID,
            workspace: WORKSPACE,
            sessionStartedAtMs: 0,
        });
        expect(r.active).toBe(false);
        expect(r.support).toBe('tracked');
    });
});

// ── step-protocol final-answer-class consumption (rc.28 live gap) ────────────
//
// Literal live rows from the bash-xczir9ao session (rc.28 canary, kimi K3):
// after the terminal notification the provider emitted progress prose —
// "Terminal notification received. Consuming the task output now." — inside a
// step that closed with finishReason 'tool_use' (it continued with the
// output-file Read), and only ~19s later produced the genuine final report in
// a step that closed 'end_turn'. The legacy ANY-assistant-text consumption
// rule released the hold at the prose; only FINAL-ANSWER-CLASS text may.

function steppedText(text: string, turnId: string, step: number, stepUuid: string) {
    return {
        type: 'context.append_loop_event',
        event: { type: 'content.part', uuid: `part-${stepUuid}`, turnId, step, stepUuid, part: { type: 'text', text } },
        time: 0,
    };
}

function stepEnd(turnId: string, step: number, stepUuid: string, finishReason: string) {
    return {
        type: 'context.append_loop_event',
        event: {
            type: 'step.end', uuid: stepUuid, turnId, step,
            usage: { inputOther: 469, output: 143, inputCacheRead: 41216, inputCacheCreation: 0 },
            finishReason,
        },
        time: 0,
    };
}

const PROGRESS_PROSE = 'Terminal notification received. Consuming the task output now.';
const HOLDING_PROSE = 'Background task `bash-xczir9ao` (pid 29411) is running with a 45s timer. Holding for its automatic terminal notification before producing the final report.';
const FINAL_REPORT = 'RC.28 background-completion canary — final report: bash-xczir9ao completed, final token KIMI-RC28-BACKGROUND-TERMINAL-988853.';

describe('detectKimiFromRecords — final-answer-class consumption (step protocol)', () => {
    // Literal live launch sequence: launch step (tool_use), then the holding
    // prose step (end_turn) — the turn ends while the cell is still running.
    const launchSeq = [
        prompt('RC.28 background terminal canary (45s)'),
        bgCall('tool_1', '1'),
        launchResult('tool_1', 'bash-xczir9ao'),
        stepEnd('1', 1, 's1', 'tool_use'),
        steppedText(HOLDING_PROSE, '1', 2, 's2'),
        stepEnd('1', 2, 's2', 'end_turn'),
    ];
    // Literal live consumption-attempt sequence: notification, then progress
    // prose whose step CONTINUES with the output-file Read (tool_use finish).
    const notificationAndProse = [
        notificationSteer('bash-xczir9ao', 'task.completed'),
        steppedText(PROGRESS_PROSE, '2', 1, 's3'),
        fgCall('tool_read', '2'),
        fgResult('tool_read', 'KIMI-RC28-BACKGROUND-START\nKIMI-RC28-BACKGROUND-TERMINAL-988853'),
        stepEnd('2', 1, 's3', 'tool_use'),
    ];

    it('HOLDS through post-notification progress prose in a tool_use step (the live rc.28 gap)', () => {
        const r = detectKimiFromRecords([...launchSeq, ...notificationAndProse]);
        expect(r.active).toBe(true);
        expect(r.count).toBe(0);
        expect(r.pendingConsumption).toBe(true);
    });

    it('RELEASES on the genuine final report after the terminal (end_turn step)', () => {
        const r = detectKimiFromRecords([
            ...launchSeq,
            ...notificationAndProse,
            steppedText(FINAL_REPORT, '2', 2, 's4'),
            stepEnd('2', 2, 's4', 'end_turn'),
        ]);
        expect(r.active).toBe(false);
        expect(r.pendingConsumption).toBeUndefined();
    });

    it('HOLDS while the final-answer step is still in flight (text written, step.end not landed)', () => {
        const r = detectKimiFromRecords([
            ...launchSeq,
            notificationSteer('bash-xczir9ao', 'task.completed'),
            steppedText(FINAL_REPORT, '2', 1, 's3'),
        ]);
        expect(r.active).toBe(true);
        expect(r.pendingConsumption).toBe(true);
    });

    it('wording is irrelevant: an end_turn text releases even when it is terse', () => {
        const r = detectKimiFromRecords([
            ...launchSeq,
            notificationSteer('bash-xczir9ao', 'task.completed'),
            steppedText('The background task finished; nothing more to do.', '2', 1, 's3'),
            stepEnd('2', 1, 's3', 'end_turn'),
        ]);
        expect(r.active).toBe(false);
    });

    it('a new turn.prompt supersedes the unconsumed resolution with the step protocol present', () => {
        const r = detectKimiFromRecords([
            ...launchSeq,
            ...notificationAndProse,
            prompt('next task'),
            steppedText('Next task done.', '3', 1, 's5'),
            stepEnd('3', 1, 's5', 'end_turn'),
        ]);
        expect(r.active).toBe(false);
    });

    it('legacy transcripts without the step protocol keep the any-assistant-text rule', () => {
        const r = detectKimiFromRecords([
            prompt(),
            bgCall('tool_1'),
            launchResult('tool_1', 'bash-aaa1'),
            notificationSteer('bash-aaa1', 'task.completed'),
            assistantText('Deploy finished: 42 checks green, url live.'),
        ]);
        expect(r.active).toBe(false);
    });
});
