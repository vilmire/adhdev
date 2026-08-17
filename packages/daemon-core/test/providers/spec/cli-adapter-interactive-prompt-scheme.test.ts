/**
 * CliSpecV4.interactive_prompts — named interactive-prompt protocol on the
 * spec path (third engine feature gating the legacy-to-spec migration,
 * docs/design/2026-08-17-legacy-cli-spec-migration.md).
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
        const { adapter, dispatches } = makeAdapter({ cliType: 'claude-cli' })
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
    it('accepts both scheme names and rejects unknown ones', () => {
        expect(validateFsmSpec({ ...base, interactive_prompts: { scheme: 'kimi_wire' } })).toEqual([])
        expect(validateFsmSpec({ ...base, interactive_prompts: { scheme: 'claude_tui' } })).toEqual([])
        expect(validateFsmSpec({ ...base, interactive_prompts: { scheme: 'nope' } }))
            .toContain('interactive_prompts.scheme must be "claude_tui" or "kimi_wire"')
        expect(validateFsmSpec({ ...base, interactive_prompts: [] }))
            .toContain('interactive_prompts must be an object')
    })
})
