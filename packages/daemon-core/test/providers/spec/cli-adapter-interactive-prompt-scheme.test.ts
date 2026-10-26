/**
 * CliSpecV4.interactive_prompts — named interactive-prompt protocol on the
 * spec path (third engine feature gating the legacy-to-spec migration,
 * the 2026-08-17 legacy CLI spec migration).
 *
 * Before this, SpecCliAdapter's prompt capture/answer paths were hardcoded
 * `cliType === 'claude-cli'`, so a kimi spec migration would silently lose
 * the AskUserQuestion picker and idle-selector coverage the legacy adapter
 * provides (kimi-pending-question.ts). Now the spec SELECTS a protocol by
 * name ('claude_tui' | 'kimi_wire'); claude keeps a legacy default until its
 * published spec declares the field.
 */
import { describe, expect, it } from 'vitest'
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js'
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js'
import { buildKimiInteractiveTuiAnswerSteps } from '../../../src/providers/types/interactive-prompt.js'

type Dispatch = { kind: string; data?: string }

function idleSelectorScreen(): string {
    return [
        '  prior assistant output line',
        ' ──────────────────────────────────────────────',
        '  This session has been idle for 32m and is ~392k tokens.',
        '  ↑↓ navigate · Enter select · Esc cancel',
        '',
        '  Cache expired — the next message re-sends the entire history at full price.',
        '  ❯ Compact and continue    one-time compact cost',
        '    Start a new session     zero context cost',
        '    Continue as-is          full history kept',
        ' ──────────────────────────────────────────────',
    ].join('\n')
}

function makeAdapter(opts: {
    cliType: string
    scheme?: 'claude_tui' | 'kimi_wire'
    screen?: string
    state?: 'idle' | 'generating'
}): { adapter: any; dispatches: Dispatch[]; statusCalls: { n: number } } {
    const dispatches: Dispatch[] = []
    const statusCalls = { n: 0 }
    const adapter = Object.create(SpecCliAdapter.prototype)
    Object.assign(adapter, {
        cliType: opts.cliType,
        cliName: opts.cliType,
        spawned: true,
        exited: false,
        spawnedAtMs: Date.now() - 1_000,
        spawnedEnv: {},
        workingDir: '/work/repo',
        providerSessionId: null,
        activeInteractivePrompt: null,
        interactivePromptTransport: null,
        latestState: { id: opts.state ?? 'idle', label: 'x', title: null, status: opts.state ?? 'idle' },
        latestModal: null,
        statusCallback: () => { statusCalls.n += 1 },
        spec: {
            id: opts.cliType,
            name: opts.cliType,
            ...(opts.scheme ? { interactive_prompts: { scheme: opts.scheme } } : {}),
            // No native_history: the wire detector is skipped and only the
            // screen-based idle-selector path runs — the unit-testable slice.
        },
        driver: {
            snapshot: () => opts.screen ?? '',
            dispatch: (event: Dispatch) => dispatches.push(event),
            hasSeenReady: () => true,
        },
        maybeRefreshNativeHistory: () => { /* not under test */ },
    })
    return { adapter, dispatches, statusCalls }
}

const ptyWrites = (d: Dispatch[]) => d.filter(e => e.kind === 'pty_write').map(e => e.data)

const pickerPrompt = {
    promptId: 'toolcall-123',
    origin: 'cli',
    providerType: 'kimi',
    createdAt: Date.now(),
    questions: [{
        questionId: 'q1',
        question: 'Which approach?',
        header: 'Approach',
        multiSelect: false,
        options: [{ label: 'Option A' }, { label: 'Option B' }],
    }],
}

describe('SpecCliAdapter interactive_prompts scheme resolution', () => {
    it('kimi_wire: getStatus() captures the on-screen idle selector as an interactive prompt', () => {
        const { adapter, statusCalls } = makeAdapter({
            cliType: 'kimi', scheme: 'kimi_wire', screen: idleSelectorScreen(), state: 'idle',
        })
        const status = adapter.getStatus()
        expect(adapter.activeInteractivePrompt).not.toBeNull()
        expect(adapter.activeInteractivePrompt.promptId).toMatch(/^kimi-tui-selector/)
        expect(adapter.activeInteractivePrompt.questions[0].options.length).toBeGreaterThanOrEqual(2)
        expect(status.activeInteractivePrompt).toBe(adapter.activeInteractivePrompt)
        expect(statusCalls.n).toBe(1)
    })

    it('kimi_wire: never captures the selector while generating (quoted snapshot protection)', () => {
        const { adapter } = makeAdapter({
            cliType: 'kimi', scheme: 'kimi_wire', screen: idleSelectorScreen(), state: 'generating',
        })
        adapter.getStatus()
        expect(adapter.activeInteractivePrompt).toBeNull()
    })

    it('no scheme declared and not claude-cli: no capture at all', () => {
        const { adapter } = makeAdapter({ cliType: 'kimi', screen: idleSelectorScreen(), state: 'idle' })
        adapter.getStatus()
        expect(adapter.activeInteractivePrompt).toBeNull()
    })

    it('kimi_wire: answers the AskUserQuestion picker with the measured digit protocol', async () => {
        const { adapter, dispatches } = makeAdapter({ cliType: 'kimi', scheme: 'kimi_wire' })
        adapter.activeInteractivePrompt = { ...pickerPrompt }
        const response = {
            promptId: 'toolcall-123',
            answers: { q1: { selectedLabels: ['Option B'] } },
        }
        await adapter.setInteractivePromptResponse(response)
        const expected = buildKimiInteractiveTuiAnswerSteps(pickerPrompt as any, response as any)
        expect(expected.length).toBeGreaterThan(0)
        expect(ptyWrites(dispatches)).toEqual(expected)
        expect(adapter.activeInteractivePrompt).toBeNull()
    })

    it('kimi_wire: rejects a stale promptId outright (fail-closed)', async () => {
        const { adapter, dispatches } = makeAdapter({ cliType: 'kimi', scheme: 'kimi_wire' })
        adapter.activeInteractivePrompt = { ...pickerPrompt }
        await expect(adapter.setInteractivePromptResponse({
            promptId: 'other-id',
            answers: { q1: { selectedLabels: ['Option A'] } },
        })).rejects.toThrow(/does not match/)
        expect(ptyWrites(dispatches)).toEqual([])
    })

    it('claude-cli without the field keeps the claude_tui legacy default (answer path writes)', async () => {
        const questionScreen = [
            '←  ☐ Approach  ✔ Submit  →',
            '',
            'Which approach?',
            '',
            '❯ 1. Option A',
            '  2. Option B',
            '──────────────────────────────────────────────',
            'Enter to select · ↑/↓ to navigate · Esc to cancel',
        ].join('\n')
        const reviewScreen = [
            '←  ☒ Approach  ✔ Submit  →',
            '',
            'Ready to submit your answers?',
            '',
            '❯ Submit answers',
            '  Cancel',
            'Enter to select · ↑/↓ to navigate · Esc to cancel',
        ].join('\n')
        let screen = questionScreen
        const { adapter, dispatches } = makeAdapter({ cliType: 'claude-cli', screen })
        adapter.driver = {
            snapshot: () => screen,
            dispatch: (event: Dispatch) => {
                dispatches.push(event)
                if (event.kind === 'pty_write' && /^\d$/.test(event.data ?? '')) screen = reviewScreen
            },
        }
        adapter.activeInteractivePrompt = { ...pickerPrompt }
        adapter.interactivePromptTransport = 'tui'
        await adapter.setInteractivePromptResponse({
            promptId: 'toolcall-123',
            answers: { q1: { selectedLabels: ['Option A'] } },
        })
        expect(ptyWrites(dispatches).length).toBeGreaterThan(0)
    })
})

describe('validateFsmSpec -- interactive_prompts', () => {
    const base = {
        $schema: 'adhdev:cli/spec@4',
        id: 'test.ip',
        name: 'ip test',
        binary: '/bin/true',
        send_message: { submit_key: '\r' },
        sections: {},
        states: [{ id: 'idle', label: 'Idle', initial: true, status: 'idle' }],
        transitions: [],
    }
    it('accepts supported scheme names and rejects unknown ones', () => {
        expect(validateFsmSpec({ ...base, interactive_prompts: { scheme: 'kimi_wire' } })).toEqual([])
        expect(validateFsmSpec({ ...base, interactive_prompts: { scheme: 'claude_tui' } })).toEqual([])
        expect(validateFsmSpec({ ...base, interactive_prompts: { scheme: 'antigravity_tui' } })).toEqual([])
        expect(validateFsmSpec({ ...base, interactive_prompts: { scheme: 'nope' } }))
            .toContain('interactive_prompts.scheme must be "claude_tui", "kimi_wire", or "antigravity_tui"')
        expect(validateFsmSpec({ ...base, interactive_prompts: [] }))
            .toContain('interactive_prompts must be an object')
    })
})

// Exercise the real status consumer, not an otherwise-unused cache helper.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sourceRevisionAsync } from '../../../src/providers/spec/native-history-paths.js';
import { afterEach, vi } from 'vitest';
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, readdirSync: vi.fn(actual.readdirSync), statSync: vi.fn(actual.statSync),
        realpathSync: vi.fn(actual.realpathSync), readFileSync: vi.fn(actual.readFileSync), openSync: vi.fn(actual.openSync), readSync: vi.fn(actual.readSync) };
});
const statusRoots: string[] = [];
const statusAdapters: any[] = [];
afterEach(() => {
    for (const a of statusAdapters.splice(0)) { a.kimiQuestionReader?.dispose(); a.kimiBackgroundReader?.dispose(); }
    vi.restoreAllMocks();
    for (const root of statusRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function statusWireFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-status-'));
    statusRoots.push(root);
    const uuid = 'a0000000-0000-4000-8000-000000000001';
    const session = path.join(root, 'sessions', 'bucket', `session_${uuid}`);
    const dir = path.join(session, 'agents', 'main');
    fs.mkdirSync(dir, { recursive: true });
    const wire = path.join(dir, 'wire.jsonl');
    const sidecar = path.join(session, 'state.json');
    fs.writeFileSync(sidecar, JSON.stringify({ workDir: root }));
    const call = { type: 'context.append_loop_event', event: { type: 'tool.call', name: 'AskUserQuestion', toolCallId: 'status-question', args: { questions: [{ question: 'Choose?', options: [{ label: 'A' }, { label: 'B' }] }] } } };
    fs.writeFileSync(wire, JSON.stringify(call) + '\n');
    const source = { kind: 'jsonl', path: `${root}/sessions/*/session_*/agents/main`, file_pattern: 'wire.jsonl', session_id_from: 'dir_uuid', workspace_from_sidecar: { rel_path: '../../state.json', workspace_path: '$.workDir' } };
    const specPath = path.join(root, 'spec.json');
    const spec = { id: 'kimi', name: 'Kimi', native_history: { source }, interactive_prompts: { scheme: 'kimi_wire' } };
    fs.writeFileSync(specPath, JSON.stringify(spec));
    const { adapter } = makeAdapter({ cliType: 'kimi', scheme: 'kimi_wire', state: 'generating' });
    Object.assign(adapter, { spec: JSON.parse(JSON.stringify(spec)), specPath, workingDir: root, spawnedAtMs: 0, owningSessionId: `status-${root}`, spawnedEnv: {} });
    statusAdapters.push(adapter);
    return { adapter, root, wire, specPath, spec, sidecar };
}

describe('Kimi real getStatus asynchronous source cache', () => {
    it('does zero synchronous discovery on cold and unchanged status; coalesces discovery and tail reads', async () => {
        const { adapter } = statusWireFixture();
        const readdir = vi.spyOn(fs.promises, 'readdir');
        const open = vi.spyOn(fs.promises, 'open');
        const syncReads = [vi.mocked(fs.readdirSync), vi.mocked(fs.statSync), vi.mocked(fs.realpathSync), vi.mocked(fs.readFileSync)];
        syncReads.forEach(spy => spy.mockClear());
        for (let i = 0; i < 100; i++) adapter.getStatus();
        expect(syncReads.every(spy => spy.mock.calls.length === 0)).toBe(true);
        await adapter.kimiQuestionReader.whenSettled();
        expect({ state: adapter.kimiQuestionReader.snapshot.state, dirty: adapter.kimiQuestionReader.dirty,
            pending: !!adapter.kimiQuestionReader.pending, configPending: !!adapter.kimiQuestionReader.configPending,
            attribution: adapter.kimiQuestionReader.snapshot.resolution?.outcome,
            prompt: adapter.activeInteractivePrompt?.promptId }).toMatchObject({ state: 'ready', prompt: 'status-question' });
        syncReads.forEach(spy => spy.mockClear());
        const walks = readdir.mock.calls.length;
        const reads = open.mock.calls.length;
        expect(walks).toBeGreaterThan(0);
        const generation = adapter.kimiQuestionReader.generation;
        const base = Date.now();
        let poll = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => base + poll * 5_000);
        for (poll = 0; poll < 1_000; poll++) adapter.getStatus();
        expect(adapter.kimiQuestionReader.generation).toBe(generation);
        const mismatches = [];
        for (const [p, revision] of adapter.kimiQuestionReader.revisions) {
            const actual = await sourceRevisionAsync(p);
            if (actual !== revision) mismatches.push([p, revision, actual]);
        }
        expect(mismatches).toEqual([]);
        await adapter.kimiQuestionReader.whenSettled(true);
        expect(readdir).toHaveBeenCalledTimes(walks);
        expect(open).toHaveBeenCalledTimes(reads);
        expect(syncReads.every(spy => spy.mock.calls.length === 0)).toBe(true);
        expect(adapter.kimiQuestionReader.read(adapter.spec.native_history, adapter.nativeHistoryInput({ withOwner: true })).resolution.outcome)
            .toMatchObject({ attribution: 'claimed', ownerConfirmed: true });
    });

    it('captures a late question and clears its result without another global scan', async () => {
        const { adapter, wire } = statusWireFixture();
        adapter.getStatus();
        await adapter.kimiQuestionReader.whenSettled();
        const readdir = vi.spyOn(fs.promises, 'readdir');
        fs.appendFileSync(wire, JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'status-question' } }) + '\n');
        await adapter.kimiQuestionReader.whenSettled(true);
        expect(adapter.activeInteractivePrompt).toBeNull();
        fs.appendFileSync(wire, JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.call', name: 'AskUserQuestion', toolCallId: 'late-question', args: { questions: [{ question: 'Again?', options: [{ label: 'Yes' }] }] } } }) + '\n');
        await adapter.kimiQuestionReader.whenSettled(true);
        expect(adapter.activeInteractivePrompt?.promptId).toBe('late-question');
        expect(readdir).not.toHaveBeenCalled();
    });

    it('really reloads the spec header and clears a prompt when the source config changes', async () => {
        const { adapter, specPath, spec } = statusWireFixture();
        adapter.getStatus();
        await adapter.kimiQuestionReader.whenSettled();
        expect(adapter.activeInteractivePrompt).not.toBeNull();
        fs.writeFileSync(specPath, JSON.stringify({ ...spec, native_history: { source: { ...spec.native_history.source, path: `${path.dirname(specPath)}/missing/*/agents/main` } } }));
        adapter.refreshProviderDefinition({ _resolvedSpecPath: specPath });
        await adapter.kimiQuestionReader.whenSettled(true);
        expect(adapter.spec.native_history.source.path).toContain('/missing/');
        expect(adapter.activeInteractivePrompt).toBeNull();
    });

    it('keeps a settled source when an unrelated newer sibling appears and disposes on detach', async () => {
        const { adapter, root } = statusWireFixture();
        adapter.getStatus();
        await adapter.kimiQuestionReader.whenSettled();
        const readdir = vi.spyOn(fs.promises, 'readdir');
        fs.mkdirSync(path.join(root, 'sessions', 'other', 'session_b0000000-0000-4000-8000-000000000002', 'agents', 'main'), { recursive: true });
        await adapter.kimiQuestionReader.whenSettled(true);
        expect(adapter.activeInteractivePrompt?.promptId).toBe('status-question');
        expect(readdir).not.toHaveBeenCalled();
        adapter.driver.detach = vi.fn();
        adapter.detach();
        expect(adapter.kimiQuestionReader.read(adapter.spec.native_history, adapter.nativeHistoryInput({ withOwner: true })).state).toBe('unavailable');
    });
});

describe('Kimi initial tail/config reconciliation race', () => {
    it('finishes an unchanged bound tail after a redundant config event interrupts its first read', async () => {
        const { adapter, specPath } = statusWireFixture();
        let releaseTail!: () => void;
        let enteredTail!: () => void;
        const tailBarrier = new Promise<void>(resolve => { releaseTail = resolve; });
        const tailEntered = new Promise<void>(resolve => { enteredTail = resolve; });
        const originalOpen = fs.promises.open;
        vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args: any[]) => {
            const fd = await (originalOpen as any)(...args);
            const read = fd.read.bind(fd);
            fd.read = async (...readArgs: any[]) => { enteredTail(); await tailBarrier; return read(...readArgs); };
            return fd;
        });
        adapter.getStatus();
        await tailEntered;
        let releaseConfig!: () => void;
        let enteredConfig!: () => void;
        const configBarrier = new Promise<void>(resolve => { releaseConfig = resolve; });
        const configEntered = new Promise<void>(resolve => { enteredConfig = resolve; });
        const originalRead = fs.promises.readFile;
        vi.spyOn(fs.promises, 'readFile').mockImplementationOnce(async (...args: any[]) => {
            enteredConfig(); await configBarrier; return (originalRead as any)(...args);
        });
        const reload = adapter.kimiQuestionReader.reloadConfig(specPath, false);
        await configEntered;
        releaseTail();
        await adapter.kimiQuestionReader.pending;
        releaseConfig();
        await reload;
        await adapter.kimiQuestionReader.whenSettled();
        expect(adapter.activeInteractivePrompt?.promptId).toBe('status-question');
    });

    it('recovers after malformed configuration and a changed spec path supplied before reader creation', async () => {
        const { adapter, specPath, spec, root } = statusWireFixture();
        const replacement = path.join(root, 'replacement-spec.json');
        fs.writeFileSync(replacement, JSON.stringify(spec));
        adapter.refreshProviderDefinition({ _resolvedSpecPath: replacement });
        adapter.getStatus();
        await adapter.kimiQuestionReader.whenSettled();
        expect(adapter.specPath).toBe(replacement);
        expect(adapter.activeInteractivePrompt).not.toBeNull();
        fs.writeFileSync(replacement, '{"native_history":');
        await adapter.kimiQuestionReader.reloadConfig();
        await adapter.kimiQuestionReader.whenSettled();
        expect(adapter.activeInteractivePrompt).toBeNull();
        fs.writeFileSync(replacement, JSON.stringify(spec));
        await adapter.kimiQuestionReader.whenSettled(true);
        expect(adapter.activeInteractivePrompt?.promptId).toBe('status-question');
        expect(specPath).not.toBe(replacement);
    });
});

import { buildProviderState } from '../../../src/providers/cli-provider-state-projection.js';
import { decideCompletionPreflight } from '../../../src/providers/completion/completion-engine.js';
import { transcriptClaimOwner, __resetTranscriptClaimRegistry } from '../../../src/providers/native-history/transcript-claim-registry.js';

function projectionHost(adapter: any) {
    return { adapter, type: 'kimi', instanceId: 'full-state', provider: { name: 'Kimi' }, workingDir: adapter.workingDir,
        settings: {}, runtimeMessages: [], lastPersistedHistoryMessages: [], parsedIngestTimestamps: { stamp: (m: unknown[]) => m },
        stabilizeFlappingApprovalStatus: (s: unknown) => s, maybeAutoApproveStatus: () => false, autoApproveMaskStalled: () => false,
        maybeAppendRuntimeRecoveryMessage: () => {}, shouldSuppressFreshLaunchStartupReplay: () => false,
        promoteProviderSessionId: () => {}, shouldHydrateExistingProviderHistory: () => false,
        shouldSuppressStaleParsedBusyStatus: () => false, applyProviderResponse: () => {}, historyWriter: { appendNewMessages: () => {} },
    } as any;
}
function backgroundRows() {
    return [
        { type: 'turn.prompt', input: [{ type: 'text', text: 'test' }] },
        { type: 'context.append_loop_event', event: { type: 'tool.call', toolCallId: 'bg', name: 'Bash', args: { run_in_background: true } } },
        { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'bg', result: { output: 'task_id: bash-test\nstatus: running' } } },
    ];
}
function completion(bg: any) {
    return decideCompletionPreflight({ firstObservedAt: 0, previousStatus: 'generating' } as any,
        { now: () => 1000, visibleStatus: () => 'idle', busyEpoch: () => 0, lastOutputAt: () => undefined,
            backgroundTask: () => ({ active: bg.backgroundTaskActive === true, count: bg.backgroundTaskCount }) } as any,
        { backgroundTaskHoldMaxMs: 300000, finalizationRetryMs: 1000 } as any);
}
function syncEvidenceSpies() {
    const spies = [vi.mocked(fs.readdirSync), vi.mocked(fs.statSync), vi.mocked(fs.realpathSync), vi.mocked(fs.readFileSync),
        vi.mocked(fs.openSync), vi.mocked(fs.readSync)];
    spies.forEach(spy => spy.mockClear());
    return spies;
}

describe('Kimi real full-state background producer', () => {
    it('holds cold evidence and projects full states without sync discovery/read, including growing history', async () => {
        const { adapter, wire } = statusWireFixture();
        fs.writeFileSync(wire, backgroundRows().map(r => JSON.stringify(r)).join('\n') + '\n');
        adapter.latestState.status = 'idle';
        const host = projectionHost(adapter);
        const cold = adapter.getScriptParsedStatus();
        expect(cold).toMatchObject({ backgroundTaskActive: true, backgroundTaskPending: true });
        expect(completion(cold)).toMatchObject({ kind: 'hold', reason: 'background_task_active' });
        await Promise.all([adapter.kimiBackgroundReader.whenSettled(), adapter.kimiQuestionReader.whenSettled()]);
        const scans = vi.spyOn(fs.promises, 'readdir');
        const sync = syncEvidenceSpies();
        for (let i = 0; i < 100; i++) buildProviderState(host);
        expect(adapter.getScriptParsedStatus()).toMatchObject({ backgroundTaskActive: true, backgroundTaskCount: 1 });
        expect(adapter.getScriptParsedStatus().backgroundTaskPending).toBeUndefined();
        expect(sync.every(spy => spy.mock.calls.length === 0)).toBe(true);
        for (let i = 0; i < 8; i++) {
            fs.appendFileSync(wire, JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'think', think: 'growing' } } }) + '\n');
            await Promise.all([adapter.kimiBackgroundReader.whenSettled(true), adapter.kimiQuestionReader.whenSettled(true)]);
            for (let n = 0; n < 25; n++) buildProviderState(host);
        }
        expect(scans).not.toHaveBeenCalled();
        expect(sync.every(spy => spy.mock.calls.length === 0)).toBe(true);
        // No background-task exemption based on coordinator role.
        adapter.runtimeSettings = { meshCoordinatorFor: 'mesh' };
        expect(completion(adapter.getScriptParsedStatus())).toMatchObject({ kind: 'hold' });
        fs.appendFileSync(wire, JSON.stringify({ type: 'turn.steer', input: [{ type: 'text', text: '<notification category="task" type="task.completed" source_id="bash-test">done</notification>' }] }) + '\n');
        await adapter.kimiBackgroundReader.whenSettled(true);
        expect(adapter.kimiBackgroundReader.snapshot.background).toMatchObject({ active: true, pendingConsumption: true });
        fs.appendFileSync(wire, JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: 'next turn' }] }) + '\n');
        await adapter.kimiBackgroundReader.whenSettled(true);
        const clear = adapter.getScriptParsedStatus();
        expect(clear.backgroundTaskActive).toBeUndefined();
        expect(completion(clear)).toMatchObject({ kind: 'proceed' });
    });

    it('does not borrow an owner binding or claim a source for an ambiguous non-owner read', async () => {
        const { adapter, root, wire } = statusWireFixture();
        const other = path.join(root, 'sessions', 'other', 'session_b0000000-0000-4000-8000-000000000002', 'agents', 'main');
        fs.mkdirSync(other, { recursive: true });
        fs.writeFileSync(path.join(other, '../../state.json'), JSON.stringify({ workDir: root }));
        fs.writeFileSync(path.join(other, 'wire.jsonl'), '{}\n');
        // Owner identity exists, but the background policy MUST omit it. With
        // no spawn evidence and two candidates, its original policy is unknown.
        adapter.spec.interactive_prompts = undefined;
        const bg = adapter.getScriptParsedStatus();
        expect(bg.backgroundTaskPending).toBe(true);
        await adapter.kimiBackgroundReader.whenSettled();
        expect(adapter.kimiBackgroundReader.snapshot.resolution?.outcome?.attribution).toBe('ambiguous');
        expect(adapter.getScriptParsedStatus()).toMatchObject({ backgroundTaskPending: true, backgroundTaskSupport: 'unknown', backgroundTaskActive: true });
        expect(transcriptClaimOwner(fs.realpathSync(wire))).toBeUndefined();
        expect(completion(adapter.getScriptParsedStatus())).toMatchObject({ kind: 'hold' });
        __resetTranscriptClaimRegistry();
    });

    it('keeps the bound background source when an unrelated sibling appears and invalidates on config change/detach', async () => {
        const { adapter, root, wire, specPath, spec } = statusWireFixture();
        adapter.spec.interactive_prompts = undefined;
        fs.writeFileSync(wire, backgroundRows().map(r => JSON.stringify(r)).join('\n') + '\n');
        adapter.getScriptParsedStatus();
        await adapter.kimiBackgroundReader.whenSettled();
        const scans = vi.spyOn(fs.promises, 'readdir');
        const sibling = path.join(root, 'sessions', 'other', 'session_b0000000-0000-4000-8000-000000000002', 'agents', 'main');
        fs.mkdirSync(sibling, { recursive: true });
        fs.writeFileSync(path.join(sibling, '../../state.json'), JSON.stringify({ workDir: root }));
        fs.writeFileSync(path.join(sibling, 'wire.jsonl'), '{}\n');
        await adapter.kimiBackgroundReader.whenSettled(true);
        expect(adapter.getScriptParsedStatus()).toMatchObject({ backgroundTaskCount: 1 });
        expect(scans).not.toHaveBeenCalled();
        fs.writeFileSync(specPath, JSON.stringify({ ...spec, interactive_prompts: undefined, native_history: { source: { ...spec.native_history.source, path: `${root}/missing/*` } } }));
        adapter.refreshProviderDefinition({ _resolvedSpecPath: specPath });
        expect(adapter.getScriptParsedStatus().backgroundTaskPending).toBe(true);
        await adapter.kimiBackgroundReader.whenSettled(true);
        expect(adapter.getScriptParsedStatus()).toMatchObject({ backgroundTaskSupport: 'unknown', backgroundTaskPending: true });
        adapter.driver.detach = vi.fn();
        adapter.detach();
        expect(adapter.getScriptParsedStatus().backgroundTaskPending).toBe(true);
    });
});
