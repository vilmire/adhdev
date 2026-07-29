/**
 * rc.28 LIVE REGRESSION — ProviderCliAdapter background-task passthrough.
 *
 * Root cause: live kimi routes through the LEGACY ProviderCliAdapter — its
 * provider dir ships provider.v1.json and NO spec.json, so createCliAdapter
 * never takes the SpecCliAdapter path. rc.28 added the
 * detectBackgroundTaskActive passthrough only to SpecCliAdapter, so a live
 * kimi session's getScriptParsedStatus() carried no backgroundTaskActive and
 * the clean-completion gate emitted agent:generating_completed ~28.5s before
 * the background cell (bash-xczir9ao) terminated. Live replay at the exact
 * completion instant detected {active:true,count:1,ids:['bash-xczir9ao'],
 * support:'tracked'} — detector/file/glob/shape/turn-scope were all correct;
 * only the adapter wiring was missing.
 *
 * These tests pin, against the SHIPPED kimi provider.v1.json (the SSOT the
 * daemon loads at runtime) and LITERAL live wire.jsonl row shapes captured
 * from the bash-xczir9ao session:
 *   1. createCliAdapter routes the shipped kimi manifest to ProviderCliAdapter;
 *   2. getScriptParsedStatus surfaces backgroundTaskSupport + active/count/ids
 *      from provider.nativeHistory on EVERY call — including the
 *      parsedStatusCache fast path (the bg verdict is overlaid, never cached);
 *   3. the completion gate (flushCompletedDebounceIfFinalized) driven by the
 *      REAL adapter: an unresolved launch blocks with background_task_active;
 *      the terminal notification ALONE remains held (pendingConsumption);
 *      a genuine final report after the terminal yields exactly one
 *      agent:generating_completed.
 *
 * Skipped — not failed — when the sibling adhdev-providers checkout is absent
 * (mirrors kimi-k3-provider-spec.test.ts), so daemon-core CI never depends on
 * the providers repo layout.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCliAdapter } from '../../src/providers/spec/route.js'
import { ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const KIMI_PROVIDER_DIR = path.resolve(HERE, '../../../../../adhdev-providers/cli/kimi')
const KIMI_MANIFEST_PATH = path.join(KIMI_PROVIDER_DIR, 'provider.v1.json')
const manifestAvailable = fs.existsSync(KIMI_MANIFEST_PATH)
const maybe = manifestAvailable ? describe : describe.skip

// Identity of the live session this regression was captured from.
const UUID = 'b3209cce-afba-44ef-ba80-4ac9dff70cb8'
const SESSION_ID = `session_${UUID}`
const TASK_ID = 'bash-xczir9ao'
const LAUNCH_CALL_ID = 'tool_pV7pDSWL0a5wDLmwkqsvfqD3'

// ── Literal live wire.jsonl rows (bash-xczir9ao session, kimi K3) ────────────

const PROMPT_ROW = {
    type: 'turn.prompt',
    input: [{ type: 'text', text: 'RC.28 background terminal canary (45s): launch the canary command with run_in_background, hold for its terminal notification, then produce one final report.' }],
    origin: { kind: 'user' },
    time: 1785357360000,
}

const LAUNCH_CALL_ROW = {
    type: 'context.append_loop_event',
    event: {
        type: 'tool.call', uuid: LAUNCH_CALL_ID, turnId: '1', step: 2,
        stepUuid: 'f47e09b8-7caf-4dfe-b3f8-dca86774aed9', toolCallId: LAUNCH_CALL_ID, name: 'Bash',
        args: {
            command: 'start=$(date +%s); echo "KIMI-RC28-BACKGROUND-START $(date -u +%Y-%m-%dT%H:%M:%SZ)"; sleep 45; echo "KIMI-RC28-BACKGROUND-TERMINAL-988853"; exit 0',
            run_in_background: true,
        },
        description: 'RC.28 background terminal canary (45s)',
    },
    time: 1785357373421,
}

// The LAUNCH result returns immediately with `status: running` — verbatim.
const LAUNCH_RESULT_ROW = {
    type: 'context.append_loop_event',
    event: {
        type: 'tool.result', parentUuid: LAUNCH_CALL_ID, toolCallId: LAUNCH_CALL_ID,
        result: {
            output: 'task_id: bash-xczir9ao\npid: 29411\ndescription: RC.28 background terminal canary (45s)\nstatus: running\nautomatic_notification: true\nnext_step: The completion arrives automatically in a later turn — do NOT wait, poll, or call TaskOutput on it; continue with your current work.\nnext_step: Use TaskStop only if the task must be cancelled.\nhuman_shell_hint: Tell the human to run /tasks to open the interactive background-task panel.',
        },
    },
    time: 1785357373422,
}

function stepEndRow(turnId: string, step: number, stepUuid: string, finishReason: string, time: number) {
    return {
        type: 'context.append_loop_event',
        event: {
            type: 'step.end', uuid: stepUuid, turnId, step,
            usage: { inputOther: 469, output: 143, inputCacheRead: 41216, inputCacheCreation: 0 },
            finishReason,
        },
        time,
    }
}

function textRow(text: string, turnId: string, step: number, stepUuid: string, time: number) {
    return {
        type: 'context.append_loop_event',
        event: {
            type: 'content.part', uuid: `part-${stepUuid}`, turnId, step, stepUuid,
            part: { type: 'text', text },
        },
        time,
    }
}

// Turn 1 ends with holding prose (end_turn) while the cell is still running.
const LAUNCH_ROWS = [
    PROMPT_ROW,
    LAUNCH_CALL_ROW,
    LAUNCH_RESULT_ROW,
    stepEndRow('1', 2, 'f47e09b8-7caf-4dfe-b3f8-dca86774aed9', 'tool_use', 1785357373422),
    textRow('Background task `bash-xczir9ao` (pid 29411) is running with a 45s timer. Holding for its automatic terminal notification before producing the final report.', '1', 3, 'ea8c58f3-94fa-4820-a338-85f4d0f6fe58', 1785357380788),
    stepEndRow('1', 3, 'ea8c58f3-94fa-4820-a338-85f4d0f6fe58', 'end_turn', 1785357380788),
]

// The terminal notification — verbatim envelope from the live turn.steer.
const NOTIFICATION_TEXT = '<notification id="task:bash-xczir9ao:completed" category="task" type="task.completed" source_kind="background_task" source_id="bash-xczir9ao">\nTitle: Background process completed\nSeverity: info\nRC.28 background terminal canary (45s) completed.\n<output-file path="/Users/vilmire/.kimi-code/sessions/wd_adhdev_78117b8afba9/session_b3209cce-afba-44ef-ba80-4ac9dff70cb8/agents/main/tasks/bash-xczir9ao/output.log" bytes="154">\nRead the output file to retrieve the result: /Users/vilmire/.kimi-code/sessions/wd_adhdev_78117b8afba9/session_b3209cce-afba-44ef-ba80-4ac9dff70cb8/agents/main/tasks/bash-xczir9ao/output.log\n</output-file>\n</notification>'

const NOTIFICATION_ROWS = [
    {
        type: 'turn.steer',
        input: [{ type: 'text', text: NOTIFICATION_TEXT }],
        origin: { kind: 'background_task', taskId: TASK_ID, status: 'completed', notificationId: 'task:bash-xczir9ao:completed' },
        time: 1785357418584,
    },
    {
        type: 'context.append_message',
        message: { role: 'user', content: [{ type: 'text', text: NOTIFICATION_TEXT }], toolCalls: [] },
        origin: { kind: 'background_task', taskId: TASK_ID, status: 'completed', notificationId: 'task:bash-xczir9ao:completed' },
        time: 1785357418584,
    },
]

// The provider acknowledges with PROGRESS PROSE — the literal live text — in a
// step that CONTINUES with the output-file Read (finishReason 'tool_use').
// This row is the secondary live gap: any-text consumption released the hold
// here, ~19s before the genuine final report.
const CONSUMPTION_PROSE_ROWS = [
    textRow('Terminal notification received. Consuming the task output now.', '2', 1, 'eabb1baa-1ad0-46db-b6dc-fa04c7692313', 1785357426626),
    {
        type: 'context.append_loop_event',
        event: {
            type: 'tool.call', uuid: 'tool_AZX8e6qBSDvo99JqlpYE41V3', turnId: '2', step: 1,
            stepUuid: 'eabb1baa-1ad0-46db-b6dc-fa04c7692313', toolCallId: 'tool_AZX8e6qBSDvo99JqlpYE41V3', name: 'Read',
            args: { path: '/Users/vilmire/.kimi-code/sessions/wd_adhdev_78117b8afba9/session_b3209cce-afba-44ef-ba80-4ac9dff70cb8/agents/main/tasks/bash-xczir9ao/output.log' },
        },
        time: 1785357426633,
    },
    {
        type: 'context.append_loop_event',
        event: {
            type: 'tool.result', parentUuid: 'tool_AZX8e6qBSDvo99JqlpYE41V3', toolCallId: 'tool_AZX8e6qBSDvo99JqlpYE41V3',
            result: { output: '1\tKIMI-RC28-BACKGROUND-START 2026-07-29T20:36:13Z\n2\tKIMI-RC28-BACKGROUND-TERMINAL-988853' },
        },
        time: 1785357426640,
    },
    stepEndRow('2', 1, 'eabb1baa-1ad0-46db-b6dc-fa04c7692313', 'tool_use', 1785357426640),
]

// The genuine final report, in a step that closes 'end_turn'.
const FINAL_REPORT_ROWS = [
    textRow('RC.28 background-completion canary — final report: bash-xczir9ao (pid 29411) exited 0 after 45s; final token KIMI-RC28-BACKGROUND-TERMINAL-988853 consumed from the output log. No intermediate final answer was emitted while the task ran.', '2', 2, '053c7a74-f821-4e96-aa4e-c4902df014dd', 1785357451453),
    stepEndRow('2', 2, '053c7a74-f821-4e96-aa4e-c4902df014dd', 'end_turn', 1785357451453),
]

// ── harness ──────────────────────────────────────────────────────────────────

let tmpDir = ''
let sessionsDir = ''
let workspace = ''
let wirePath = ''

function loadShippedManifest(): any {
    return JSON.parse(fs.readFileSync(KIMI_MANIFEST_PATH, 'utf8'))
}

/** The shipped manifest as the provider loader would hand it to createCliAdapter,
 *  with only the sessions root redirected to the hermetic tmp dir. */
function makeProvider(manifest: any): any {
    return {
        ...manifest,
        spawn: { env: {}, ...manifest.spawn },
        _resolvedProviderDir: KIMI_PROVIDER_DIR,
        nativeHistory: {
            ...manifest.nativeHistory,
            source: { ...manifest.nativeHistory.source, path: `${sessionsDir}/*/session_*/agents/main` },
        },
    }
}

function writeWire(rows: unknown[]): void {
    const sessionDir = path.join(sessionsDir, 'wd_adhdev_78117b8afba9', SESSION_ID)
    const wireDir = path.join(sessionDir, 'agents', 'main')
    fs.mkdirSync(wireDir, { recursive: true })
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ workDir: workspace, title: 'rc.28 canary' }), 'utf8')
    wirePath = path.join(wireDir, 'wire.jsonl')
    fs.writeFileSync(wirePath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

function appendWire(rows: unknown[]): void {
    fs.appendFileSync(wirePath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

function makeAdapter(provider: any): ProviderCliAdapter {
    const adapter = createCliAdapter(provider, workspace, [], {}) as unknown as ProviderCliAdapter
    // Minimal parseSession stub: the shipped kimi scripts are resolved by the
    // provider loader at runtime; the bg passthrough under test is orthogonal
    // to PTY parsing. The pinned providerSessionId mirrors the production
    // script's session-id extraction (applyParsedSessionMetadata).
    adapter.setCliScripts({
        parseSession: () => ({ messages: [], status: 'idle', providerSessionId: SESSION_ID }),
    } as any)
    return adapter
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-passthrough-'))
    sessionsDir = path.join(tmpDir, 'sessions')
    workspace = path.join(tmpDir, 'work', 'adhdev')
    fs.mkdirSync(workspace, { recursive: true })
})

afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ── 1. production routing ────────────────────────────────────────────────────

maybe('createCliAdapter — shipped kimi provider.v1.json routing (rc.28 root cause)', () => {
    it('routes through the LEGACY ProviderCliAdapter (provider dir has provider.v1.json, no spec.json)', () => {
        // This is the exact condition that bypassed the rc.28 SpecCliAdapter fix.
        expect(fs.existsSync(path.join(KIMI_PROVIDER_DIR, 'spec.json'))).toBe(false)
        const manifest = loadShippedManifest()
        // Pin the shipped nativeHistory contract the passthrough depends on.
        expect(manifest.nativeHistory?.source?.kind).toBe('jsonl')
        expect(manifest.nativeHistory?.source?.file_pattern).toBe('wire.jsonl')
        expect(manifest.nativeHistory?.source?.session_id_from).toBe('dir_uuid')
        const adapter = createCliAdapter(makeProvider(manifest), workspace, [], {})
        expect(adapter).toBeInstanceOf(ProviderCliAdapter)
    })
})

// ── 2. adapter passthrough ───────────────────────────────────────────────────

maybe('ProviderCliAdapter.getScriptParsedStatus — background-task passthrough', () => {
    it('surfaces support/active/count/ids from provider.nativeHistory while the cell is running', () => {
        writeWire(LAUNCH_ROWS)
        const adapter = makeAdapter(makeProvider(loadShippedManifest()))
        const parsed: any = adapter.getScriptParsedStatus()
        expect(parsed.backgroundTaskSupport).toBe('tracked')
        expect(parsed.backgroundTaskActive).toBe(true)
        expect(parsed.backgroundTaskCount).toBe(1)
        expect(parsed.backgroundTaskIds).toEqual([TASK_ID])
    })

    it('stays fresh on the parsedStatusCache fast path (bg verdict is overlaid, never cached)', () => {
        writeWire(LAUNCH_ROWS)
        const provider = makeProvider(loadShippedManifest())
        // Engage the parsedStatusCache path: providerOwnsTranscript() bypasses
        // the cache, so drop transcriptAuthority for this variant.
        delete provider.transcriptAuthority
        const adapter = makeAdapter(provider)

        const first: any = adapter.getScriptParsedStatus()
        expect(first.backgroundTaskActive).toBe(true)
        // Second call with unchanged buffers is a cache HIT — the bg verdict
        // must still be recomputed live (pre-fix the fast path returned no bg
        // fields at all).
        const second: any = adapter.getScriptParsedStatus()
        expect(second.backgroundTaskActive).toBe(true)
        expect(second.backgroundTaskIds).toEqual([TASK_ID])

        // The cell terminates and the provider consumes it. Buffers unchanged
        // (still a cache hit), but the bg overlay must clear.
        appendWire([...NOTIFICATION_ROWS, ...CONSUMPTION_PROSE_ROWS, ...FINAL_REPORT_ROWS])
        const third: any = adapter.getScriptParsedStatus()
        expect(third.backgroundTaskSupport).toBe('tracked')
        expect(third.backgroundTaskActive).toBeUndefined()
        expect(third.backgroundTaskCount).toBeUndefined()
        expect(third.backgroundTaskIds).toBeUndefined()
    })
})

// ── 3. completion gate driven by the real adapter ────────────────────────────

type FlushHarness = { instance: any; events: any[]; rescheduleCalls: number[] }

function makeGateHarness(adapter: any): FlushHarness {
    const events: any[] = []
    const rescheduleCalls: number[] = []
    const instance = Object.create(CliProviderInstance.prototype) as any

    instance.type = 'kimi'
    instance.instanceId = 'sess-bg-kimi'
    instance.provider = { name: 'Kimi Code', settings: {}, nativeHistory: {} }
    instance.workingDir = workspace
    instance.providerSessionId = SESSION_ID
    instance.settings = { meshNodeFor: 'mesh-1', meshActiveTaskId: 'task-1' }
    instance.lastStatus = 'generating'
    instance.generatingStartedAt = 1000
    instance.lastApprovalEventFingerprint = ''
    instance.autoApproveBusy = false
    instance.completedDebounceTimer = null
    instance.completedDebouncePending = {
        chatTitle: 'task',
        duration: 5,
        timestamp: 111,
        firstObservedAt: Date.now(), // waitedMs ≈ 0 — well under the 30s force-emit cap
        previousStatus: 'generating',
    }

    // Drive the REAL adapter's getScriptParsedStatus through the gate; isolate
    // the gate from PTY state (this session never spawns).
    adapter.getStatus = () => ({ status: 'idle' })
    adapter.getPartialResponse = () => ''
    adapter.getScreenText = () => ''
    instance.adapter = adapter

    instance.shouldAutoApprove = () => false
    instance.getCompletedFinalizationBlock = () => null
    instance.completionFinalSummary = () => 'done'
    instance.scheduleCompletedDebounceFlush = (delayMs: number) => { rescheduleCalls.push(delayMs) }
    instance.context = { emitProviderEvent: (e: any) => events.push(e) }
    instance.events = []

    return { instance, events, rescheduleCalls }
}

maybe('completion gate (flushCompletedDebounceIfFinalized) — real adapter, literal live rows', () => {
    it('unresolved launch blocks with background_task_active; terminal alone holds; final report completes exactly once', () => {
        writeWire(LAUNCH_ROWS)
        const adapter = makeAdapter(makeProvider(loadShippedManifest()))
        const { instance, events, rescheduleCalls } = makeGateHarness(adapter)

        // Phase 1 — cell still running: HOLD with background_task_active.
        ;(instance as any).flushCompletedDebounceIfFinalized()
        expect(events).toHaveLength(0)
        expect(rescheduleCalls.length).toBeGreaterThan(0)
        expect(instance.completedDebouncePending).not.toBeNull()
        expect(instance.completedDebouncePending.loggedBlockReason).toBe('background_task_active')
        expect(typeof instance.completedDebouncePending.backgroundTaskHoldSince).toBe('number')

        // Phase 2 — terminal notification lands; the provider acknowledges with
        // progress prose (tool_use step) but has NOT produced the final report:
        // still held (pendingConsumption), no completion.
        appendWire([...NOTIFICATION_ROWS, ...CONSUMPTION_PROSE_ROWS])
        ;(instance as any).flushCompletedDebounceIfFinalized()
        expect(events).toHaveLength(0)
        expect(instance.completedDebouncePending).not.toBeNull()

        // Phase 3 — genuine final report (end_turn step): exactly one completion.
        appendWire(FINAL_REPORT_ROWS)
        ;(instance as any).flushCompletedDebounceIfFinalized()
        expect(events).toHaveLength(1)
        expect(events[0].event).toBe('agent:generating_completed')
        expect(instance.completedDebouncePending).toBeNull()

        // No double-emit on a later flush.
        ;(instance as any).flushCompletedDebounceIfFinalized()
        expect(events).toHaveLength(1)
    })
})
