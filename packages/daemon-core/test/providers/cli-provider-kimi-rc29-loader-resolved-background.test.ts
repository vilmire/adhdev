/**
 * rc.29 loader-resolved end-to-end regression — kimi background-cell hold.
 *
 * The rc.27/rc.28 detector + flush-hold tests bypassed the ProviderLoader and
 * passed the manifest nativeHistory shape straight to the detector, so they
 * kept passing while the loader's legacy resolve path REWROTE
 * resolved.nativeHistory to {format, watchPath, scripts, mode} and dropped
 * the declarative `source` — production kimi therefore always reported
 * background detection inactive at the ProviderCliAdapter boundary and the
 * completion hold never engaged.
 *
 * This test drives the LITERAL rc.29 live sequence through the loader-resolved
 * provider:
 *
 *   turn.prompt
 *   → tool.call (run_in_background:true)
 *   → tool.result (task_id: bash-woj83z7c, status: running — returns immediately)
 *   → todo/progress assistant text
 *
 * …and proves:
 *   1. the loader-resolved nativeHistory keeps source.kind=jsonl;
 *   2. the detector reports backgroundTaskActive:true (id bash-woj83z7c);
 *   3. flushCompletedDebounceIfFinalized HOLDS with blockReason
 *      background_task_active (no agent:generating_completed while running);
 *   4. appending the terminal <notification task.completed> still holds
 *      (result not yet consumed);
 *   5. appending a final-answer-class assistant text releases EXACTLY ONE
 *      completion (a later flush does not re-emit).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderLoader } from '../../src/providers/provider-loader.js';
import { detectBackgroundTaskActive } from '../../src/providers/spec/background-task-detector.js';
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js';

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

function bgCall(callId: string, turnId = '1') {
    return {
        type: 'context.append_loop_event',
        event: {
            type: 'tool.call', uuid: `u-${callId}`, turnId, step: 1, stepUuid: 's1',
            toolCallId: callId, name: 'Bash',
            args: { command: 'npm run deploy', run_in_background: true },
        },
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

// ── loader harness (mirrors provider-loader.test.ts) ─────────────────────────

class TestProviderLoader extends ProviderLoader {
    constructor(
        userDir: string,
        private readonly testConfig: { providerSettings?: Record<string, Record<string, unknown>> },
    ) {
        super({ userDir, disableUpstream: true });
    }

    protected override readConfig(): any | null {
        return this.testConfig;
    }

    protected override writeConfig(config: any): void {
        Object.assign(this.testConfig, config);
    }
}

function writeV1Provider(root: string, category: string, type: string, data: Record<string, unknown>) {
    const dir = path.join(root, category, type);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'provider.v1.json'), JSON.stringify(data, null, 2), 'utf-8');
}

// ── flush harness (mirrors cli-provider-kimi-background-completion-hold.test.ts) ──

function makeFlushHarness(liveParsed: () => any) {
    const events: any[] = [];
    const rescheduleCalls: number[] = [];
    const instance = Object.create(CliProviderInstance.prototype) as any;

    instance.type = 'kimi';
    instance.instanceId = 'sess-kimi-rc29';
    instance.provider = { name: 'Kimi', settings: {}, nativeHistory: { mode: 'native-source' } };
    instance.workingDir = '/repo/worktree';
    instance.providerSessionId = 'session_d3f014e8-7c09-4b97-b3dd-a7acbb46db10';
    instance.settings = { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-1' };
    instance.lastStatus = 'generating';
    instance.generatingStartedAt = 1000;
    instance.lastApprovalEventFingerprint = '';
    instance.autoApproveBusy = false;
    instance.completedDebounceTimer = null;
    instance.completedDebouncePending = {
        chatTitle: 'task',
        duration: 5,
        timestamp: 111,
        firstObservedAt: Date.now(), // waitedMs ≈ 0 — well under the 30s force-emit cap
        previousStatus: 'generating',
    };

    instance.adapter = {
        chatMessagesOwnedExternally: true, // native-source provider
        getStatus: () => ({ status: 'idle' }),
        getPartialResponse: () => '',
        getScriptParsedStatus: liveParsed,
        getScreenText: () => '',
        isWaitingForResponse: false,
    };

    instance.shouldAutoApprove = () => false;
    // Force a clean-emit path when NOT holding on background: no finalization block.
    instance.getCompletedFinalizationBlock = () => null;
    instance.completionFinalSummary = () => 'Deploy finished: all checks green.';
    instance.scheduleCompletedDebounceFlush = (delayMs: number) => { rescheduleCalls.push(delayMs); };

    instance.context = { emitProviderEvent: (e: any) => events.push(e) };
    instance.events = [];

    return { instance, events, rescheduleCalls };
}

// ── the rc.29 regression ─────────────────────────────────────────────────────

describe('kimi rc.29 — loader-resolved nativeHistory survives to the background detector + completion hold', () => {
    let tmpRoot = '';
    let userDir = '';
    let storeDir = '';
    let wirePath = '';

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-kimi-rc29-'));
        userDir = path.join(tmpRoot, 'providers');
        storeDir = path.join(tmpRoot, 'kimi-sessions');
        fs.mkdirSync(storeDir, { recursive: true });
        wirePath = path.join(storeDir, 'wire.jsonl');
    });

    afterEach(() => {
        if (tmpRoot && fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
        tmpRoot = '';
    });

    it('literal rc.29 live sequence: hold while running, exactly one completion after consume', () => {
        // Literal rc.29 live sequence: prompt → background tool.call → immediate
        // launch result (task_id bash-woj83z7c, status running) → progress prose.
        const records: unknown[] = [
            prompt(),
            bgCall('tool_1'),
            launchResult('tool_1', 'bash-woj83z7c'),
            assistantText('Deploy started in the background; tracking bash-woj83z7c and will report when it finishes.'),
        ];
        fs.writeFileSync(wirePath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

        // The shipped kimi manifest shape, with the transcript store pointed at
        // the tmp fixture (everything else mirrors provider.v1.json).
        writeV1Provider(userDir, 'cli', 'kimi', {
            type: 'kimi',
            name: 'Kimi',
            displayName: 'Kimi',
            category: 'cli',
            spawn: { command: 'kimi' },
            transcriptAuthority: 'provider',
            nativeHistory: {
                mode: 'native-source',
                contractVersion: '2.0',
                source: {
                    kind: 'jsonl',
                    path: storeDir,
                    file_pattern: 'wire.jsonl',
                    records: [
                        {
                            where: '$.type == "turn.prompt"',
                            message_map: { role: 'user', content: '$.input', timestamp_ms: '$.time' },
                        },
                    ],
                },
            },
        });

        const loader = new TestProviderLoader(userDir, { providerSettings: {} });
        loader.loadAll();
        const resolved = loader.resolve('kimi');
        const nh = (resolved as any)?.nativeHistory;

        // (1) The production-shape gap: the loader must not drop the
        // declarative source. Pre-fix this is undefined and every subsequent
        // stage silently reports "no background work".
        expect(nh?.source?.kind).toBe('jsonl');

        // (2) The detector, fed the LOADER-RESOLVED config exactly as
        // ProviderCliAdapter.detectBackgroundTask does, sees the running cell.
        const detect = () => detectBackgroundTaskActive(nh, { agentType: 'kimi', workspace: '/repo/worktree' });
        const running = detect();
        expect(running.active).toBe(true);
        expect(running.ids).toEqual(['bash-woj83z7c']);
        expect(running.support).toBe('tracked');

        // (3) The completion flush holds on background_task_active.
        const { instance, events, rescheduleCalls } = makeFlushHarness(() => {
            const bg = detect();
            return {
                status: 'idle',
                messages: [],
                backgroundTaskSupport: bg.support ?? 'tracked',
                ...(bg.active ? { backgroundTaskActive: true, backgroundTaskCount: bg.count } : {}),
            };
        });

        (instance as any).flushCompletedDebounceIfFinalized();
        expect(events).toHaveLength(0);
        expect(rescheduleCalls.length).toBeGreaterThan(0);
        expect((instance as any).completedDebouncePending.loggedBlockReason).toBe('background_task_active');

        // (4) Terminal notification alone (cell exited, result NOT yet consumed
        // into a final assistant response) must still hold.
        records.push(notificationSteer('bash-woj83z7c', 'task.completed'));
        fs.writeFileSync(wirePath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
        const pendingConsume = detect();
        expect(pendingConsume.active).toBe(true);
        expect(pendingConsume.pendingConsumption).toBe(true);

        (instance as any).flushCompletedDebounceIfFinalized();
        expect(events).toHaveLength(0);

        // (5) Final-answer-class assistant text consumes the result → detector
        // releases → the flush emits agent:generating_completed EXACTLY ONCE.
        records.push(assistantText('Deploy finished: all 42 checks green, url live.'));
        fs.writeFileSync(wirePath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
        expect(detect().active).toBe(false);

        (instance as any).flushCompletedDebounceIfFinalized();
        expect(events).toHaveLength(1);
        expect(events[0].event).toBe('agent:generating_completed');
        expect((instance as any).completedDebouncePending).toBeNull();

        // A later flush (reconcile tick, duplicate idle sample) must NOT re-emit.
        (instance as any).flushCompletedDebounceIfFinalized();
        expect(events).toHaveLength(1);
    });
});
