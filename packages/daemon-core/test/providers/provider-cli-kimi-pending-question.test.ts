/**
 * ProviderCliAdapter — kimi AskUserQuestion (waiting_choice) wiring.
 *
 * Live kimi routes through the LEGACY ProviderCliAdapter (provider dir ships
 * provider.v1.json, NO spec.json — the rc.28 routing lesson), so the kimi
 * interactive-prompt support lives HERE, not in SpecCliAdapter:
 *
 *   1. getScriptParsedStatus() refreshes the pending-question hold from the
 *      session's own wire.jsonl on EVERY call (kimi-pending-question.ts);
 *   2. getStatus() surfaces it as activeInteractivePrompt — the signal
 *      CliProviderInstance mirrors into the waiting_choice overlay and the
 *      status-transition layer edge-emits agent:waiting_choice from;
 *   3. setInteractivePromptResponse (mesh_answer_question) drives the measured
 *      kimi 0.34 picker keystrokes and rejects a stale promptId outright.
 *
 * Harness + shipped-manifest gating mirror
 * provider-cli-background-task-passthrough.test.ts (skipped when the sibling
 * adhdev-providers checkout is absent, so daemon-core CI never depends on the
 * providers repo layout). Wire row shapes are the literal live ones.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCliAdapter } from '../../src/providers/spec/route.js'
import { ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const KIMI_PROVIDER_DIR = path.resolve(HERE, '../../../../../adhdev-providers/cli/kimi')
const KIMI_MANIFEST_PATH = path.join(KIMI_PROVIDER_DIR, 'provider.v1.json')
const manifestAvailable = fs.existsSync(KIMI_MANIFEST_PATH)
const maybe = manifestAvailable ? describe : describe.skip

const UUID = 'cc5d676d-d155-4b99-b732-7bbaecff818c'
const SESSION_ID = `session_${UUID}`
const CALL_ID = 'tool_cRbA9sk8questionpending1'

const ASK_CALL_ROW = {
    type: 'context.append_loop_event',
    event: {
        type: 'tool.call', uuid: `u-${CALL_ID}`, turnId: '1', step: 12,
        toolCallId: CALL_ID, name: 'AskUserQuestion',
        args: {
            questions: [{
                header: 'Colors',
                question: 'Pick any colors?',
                options: [
                    { label: 'Red', description: 'warm' },
                    { label: 'Green', description: 'calm' },
                    { label: 'Blue', description: 'cold' },
                ],
            }],
        },
    },
    time: 1785357370000,
}

const ANSWER_RESULT_ROW = {
    type: 'context.append_loop_event',
    event: {
        type: 'tool.result', parentUuid: `u-${CALL_ID}`, toolCallId: CALL_ID,
        result: { output: 'answers recorded' },
    },
    time: 1785357375000,
}

// ── harness ──────────────────────────────────────────────────────────────────

let tmpDir = ''
let sessionsDir = ''
let workspace = ''
let wirePath = ''

function loadShippedManifest(): any {
    return JSON.parse(fs.readFileSync(KIMI_MANIFEST_PATH, 'utf8'))
}

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
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ workDir: workspace }), 'utf8')
    wirePath = path.join(wireDir, 'wire.jsonl')
    fs.writeFileSync(wirePath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

function appendWire(rows: unknown[]): void {
    fs.appendFileSync(wirePath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

function makeAdapter(provider: any): ProviderCliAdapter {
    const adapter = createCliAdapter(provider, workspace, [], {}) as unknown as ProviderCliAdapter
    // Minimal parseSession stub — the pending-question refresh is orthogonal
    // to PTY parsing (same stub style as the bg-passthrough harness).
    adapter.setCliScripts({
        parseSession: () => ({ messages: [], status: 'idle', providerSessionId: SESSION_ID }),
    } as any)
    return adapter
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-question-'))
    sessionsDir = path.join(tmpDir, 'sessions')
    workspace = path.join(tmpDir, 'work', 'adhdev')
    fs.mkdirSync(workspace, { recursive: true })
})

afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ── detection → status surface ───────────────────────────────────────────────

maybe('ProviderCliAdapter — kimi pending AskUserQuestion hold', () => {
    it('surfaces activeInteractivePrompt on getStatus() while the question is unanswered', () => {
        writeWire([ASK_CALL_ROW])
        const adapter = makeAdapter(makeProvider(loadShippedManifest()))
        adapter.getScriptParsedStatus() // poll-cadence refresh
        const status: any = adapter.getStatus()
        expect(status.activeInteractivePrompt).not.toBeNull()
        expect(status.activeInteractivePrompt.promptId).toBe(CALL_ID)
        expect(status.activeInteractivePrompt.providerType).toBe('kimi')
        expect(status.activeInteractivePrompt.questions[0].options.map((o: any) => o.label))
            .toEqual(['Red', 'Green', 'Blue'])
    })

    it('clears the hold once the tool.result lands (answered in-terminal or injected)', () => {
        writeWire([ASK_CALL_ROW])
        const adapter = makeAdapter(makeProvider(loadShippedManifest()))
        adapter.getScriptParsedStatus()
        expect((adapter.getStatus() as any).activeInteractivePrompt?.promptId).toBe(CALL_ID)
        appendWire([ANSWER_RESULT_ROW])
        adapter.getScriptParsedStatus()
        expect((adapter.getStatus() as any).activeInteractivePrompt).toBeNull()
    })

    it('does NOT surface a prompt for a pending non-question tool.call (approval-modal twin)', () => {
        writeWire([{
            type: 'context.append_loop_event',
            event: {
                type: 'tool.call', uuid: 'u-bash', turnId: '1', step: 2,
                toolCallId: 'tool_bashpending', name: 'Bash',
                args: { command: 'touch /tmp/kimi-modal-probe.txt' },
            },
            time: 1785357370000,
        }])
        const adapter = makeAdapter(makeProvider(loadShippedManifest()))
        adapter.getScriptParsedStatus()
        expect((adapter.getStatus() as any).activeInteractivePrompt).toBeNull()
    })

    it('is a no-op for non-kimi providers (claude path untouched)', () => {
        writeWire([ASK_CALL_ROW])
        const provider = { ...makeProvider(loadShippedManifest()), type: 'claude-cli' }
        const adapter = makeAdapter(provider)
        adapter.getScriptParsedStatus()
        expect((adapter.getStatus() as any).activeInteractivePrompt).toBeNull()
    })
})

// ── answer path ──────────────────────────────────────────────────────────────

maybe('ProviderCliAdapter.setInteractivePromptResponse — kimi keystrokes', () => {
    it('rejects a stale promptId outright (fail-closed, no writes)', async () => {
        writeWire([ASK_CALL_ROW])
        const adapter = makeAdapter(makeProvider(loadShippedManifest()))
        adapter.getScriptParsedStatus()
        const writes: string[] = []
        ;(adapter as any).writeToPty = async (d: string) => { writes.push(d) }
        await expect(adapter.setInteractivePromptResponse({
            promptId: 'tool_STALE',
            answers: { q1: { selectedLabels: ['Red'] } },
        })).rejects.toThrow(/does not match active prompt/)
        expect(writes).toEqual([])
        // The held prompt survives a rejected answer (the picker stays parked).
        expect((adapter.getStatus() as any).activeInteractivePrompt?.promptId).toBe(CALL_ID)
    })

    it('drives digit + review-Enter for a single-select answer and clears the hold', async () => {
        writeWire([ASK_CALL_ROW])
        const adapter = makeAdapter(makeProvider(loadShippedManifest()))
        adapter.getScriptParsedStatus()
        const writes: string[] = []
        ;(adapter as any).writeToPty = async (d: string) => { writes.push(d) }
        await adapter.setInteractivePromptResponse({
            promptId: CALL_ID,
            answers: { q1: { selectedLabels: ['Green'] } },
        })
        expect(writes).toEqual(['2', '\r'])
        // The hold now follows the WIRE, not the local clear: getStatus()
        // refreshes the pending-question detection on every routine poll, so
        // until kimi appends the tool.result the same pending call re-detects.
        // Simulate kimi recording the answer, then the hold clears.
        writeWire([ASK_CALL_ROW, ANSWER_RESULT_ROW])
        expect((adapter.getStatus() as any).activeInteractivePrompt).toBeNull()
    }, 15000)
})
