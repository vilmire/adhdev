/**
 * HELD-PROMPT LEAK ON MID-KEYSTROKE COMPLETION (live defect, 2026-08-31, rc.54)
 *
 * Symptom: after answering an AskUserQuestion from the dashboard, the answer
 * lands and the TUI picker goes away, but the WEB modal stays up — and survives
 * a reload, because the daemon still holds `activeInteractivePrompt`.
 *
 * Cause: `assertFocusedClaudeTuiQuestion` is called per keystroke inside the
 * answer loop. Any question needing 2+ keysteps (multi-select emits one digit
 * per label then Tab; freeform emits an option digit then one key per typed
 * character) re-checks the screen mid-answer. Claude Code >=2.1.220 can
 * complete the tool call on the FIRST choice keystroke, which removes the
 * picker — `readFocusedClaudeTuiQuestion` returns null (no "Enter to select"
 * footer) and the old code threw unconditionally, aborting
 * `setInteractivePromptResponse` before its `activeInteractivePrompt = null`.
 *
 * rc.54's completion signals (direct_submit_tool_result / direct_submit_busy)
 * did not help: they live in `snapshotSettledClaudeTuiReview`, which the throw
 * preempts.
 *
 * Note the error message read "focused question does not match" with NO
 * `focused question is …` clause — the fingerprint of `focused === null`
 * (screen had no picker at all), not of a genuinely mismatched picker.
 *
 * The fix resolves `focused === null` against the same two completion signals
 * and breaks the keystroke loop. `focused !== null && !matches` — a foreign
 * picker holding focus — must still fail closed, which the last describe
 * block pins.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js'

type Dispatch = { kind: string; data?: string }

/**
 * Multi-select picker: `buildClaudeInteractiveTuiAnswerSteps` emits one digit
 * per selected label plus a trailing Tab, and the caller strips the last step,
 * so answering two labels yields TWO keysteps — the minimum that re-runs the
 * focus guard mid-answer. A single-select answer is one keystep and could
 * never reproduce this.
 */
const QUESTION_SCREEN = [
    '←  ☐ Approach  ✔ Submit  →',
    '',
    'Which approach?',
    '',
    '❯ 1. ☐ Option A',
    '  2. ☐ Option B',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n')

/** No "Enter to select" footer — readFocusedClaudeTuiQuestion returns null. */
const BUSY_SCREEN = [
    '✻ Working…',
    '',
    'esc to interrupt',
].join('\n')

const FOREIGN_QUESTION_SCREEN = [
    '←  ☐ Deployment  ✔ Submit  →',
    '',
    'Which environment?',
    '',
    '❯ 1. ☐ Production',
    '  2. ☐ Staging',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n')

const prompt = {
    promptId: 'toolu_midkeystroke',
    origin: 'cli' as const,
    providerType: 'claude-cli',
    createdAt: 1,
    questions: [{
        questionId: 'q1',
        question: 'Which approach?',
        header: 'Approach',
        multiSelect: true,
        options: [{ label: 'Option A' }, { label: 'Option B' }],
    }],
}

/** Two selected labels ⇒ steps ['1','2','\t'] ⇒ ['1','2'] after the slice. */
const TWO_KEYSTEP_RESPONSE = {
    promptId: prompt.promptId,
    answers: { q1: { selectedLabels: ['Option A', 'Option B'] } },
}

function makeAdapter(): { adapter: any; writes: string[]; setScreen: (s: string) => void } {
    const writes: string[] = []
    let screen = QUESTION_SCREEN
    const adapter = Object.create(SpecCliAdapter.prototype)
    Object.assign(adapter, {
        cliType: 'claude-cli',
        cliName: 'claude-cli',
        spawned: true,
        exited: false,
        activeInteractivePrompt: prompt,
        interactivePromptTransport: 'tui',
        interactivePromptLostAt: null,
        latestState: { id: 'idle', label: 'x', title: null, status: 'idle' },
        latestModal: null,
        statusCallback: () => { /* noop */ },
        spec: { id: 'claude-cli', name: 'claude-cli' },
        driver: {
            snapshot: () => screen,
            dispatch: (event: Dispatch) => {
                if (event.kind === 'pty_write' && event.data !== undefined) writes.push(event.data)
            },
            hasSeenReady: () => true,
        },
    })
    return { adapter, writes, setScreen: (s: string) => { screen = s } }
}

describe('setInteractivePromptResponse — completion between keystrokes', () => {
    it('clears the held prompt when a busy advance removes the picker mid-answer', async () => {
        // THE DEFECT: first digit lands and completes the tool call; the second
        // digit's focus guard sees a screen with no picker at all.
        const { adapter, writes, setScreen } = makeAdapter()
        const baseDispatch = adapter.driver.dispatch
        adapter.driver.dispatch = (event: Dispatch) => {
            baseDispatch(event)
            if (event.data !== '1') return
            setScreen(BUSY_SCREEN)
            adapter.latestState = { id: 'busy', label: 'Generating', title: null, status: 'generating' }
        }

        await adapter.setInteractivePromptResponse(TWO_KEYSTEP_RESPONSE)

        expect(adapter.activeInteractivePrompt).toBeNull()
        expect(adapter.interactivePromptTransport).toBeNull()
        // Remaining keysteps must NOT be typed — '2' would land on whatever
        // widget owns focus now, which is the key-leak this guard exists for.
        expect(writes).toEqual(['1'])
    })

    it('clears the held prompt when a bound native tool_result arrives mid-answer', async () => {
        const historyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-midkeystroke-history-'))
        const historyPath = path.join(historyDir, '22222222-2222-4222-8222-222222222222.jsonl')
        try {
            fs.writeFileSync(historyPath, `${JSON.stringify({
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{
                        type: 'tool_use',
                        id: prompt.promptId,
                        name: 'AskUserQuestion',
                        input: { questions: prompt.questions },
                    }],
                },
            })}\n`)

            const { adapter, writes, setScreen } = makeAdapter()
            adapter.workingDir = historyDir
            adapter.spawnedAtMs = 0
            adapter.spec.native_history = {
                source: {
                    kind: 'jsonl',
                    path: historyPath,
                    session_id_from: 'filename_uuid',
                    message_filter: { where: "$.type == 'user' || $.type == 'assistant'" },
                    message_map: { role: '$.message.role', content: '$.message.content', tools: {} },
                },
            }
            const baseDispatch = adapter.driver.dispatch
            adapter.driver.dispatch = (event: Dispatch) => {
                baseDispatch(event)
                if (event.data !== '1') return
                setScreen(BUSY_SCREEN)
                fs.appendFileSync(historyPath, `${JSON.stringify({
                    type: 'user',
                    message: {
                        role: 'user',
                        content: [{ type: 'tool_result', tool_use_id: prompt.promptId, content: 'submitted' }],
                    },
                })}\n`)
                // latestState stays idle on purpose: the bound tool_result
                // alone must carry this branch.
            }

            await adapter.setInteractivePromptResponse(TWO_KEYSTEP_RESPONSE)

            expect(adapter.activeInteractivePrompt).toBeNull()
            expect(adapter.interactivePromptTransport).toBeNull()
            expect(writes).toEqual(['1'])
        } finally {
            fs.rmSync(historyDir, { recursive: true, force: true })
        }
    })

    it('still holds the prompt when the picker merely blanks mid-repaint with no completion signal', async () => {
        // No busy advance, no tool_result: an empty frame is not proof the
        // answer landed, so the guard must keep failing closed.
        const { adapter, setScreen } = makeAdapter()
        const baseDispatch = adapter.driver.dispatch
        adapter.driver.dispatch = (event: Dispatch) => {
            baseDispatch(event)
            if (event.data === '1') setScreen(BUSY_SCREEN)
        }

        await expect(adapter.setInteractivePromptResponse(TWO_KEYSTEP_RESPONSE))
            .rejects.toThrow(/focused question does not match/)
        expect(adapter.activeInteractivePrompt).toBe(prompt)
    })
})

describe('setInteractivePromptResponse — wrong-picker defense is preserved', () => {
    it('fails closed when a foreign picker takes focus mid-answer, even under a busy advance', async () => {
        // focused !== null && !matches — the original hazard. A completion
        // signal must NOT launder this: the remaining keys would drive someone
        // else's widget.
        const { adapter, writes, setScreen } = makeAdapter()
        const baseDispatch = adapter.driver.dispatch
        adapter.driver.dispatch = (event: Dispatch) => {
            baseDispatch(event)
            if (event.data !== '1') return
            setScreen(FOREIGN_QUESTION_SCREEN)
            adapter.latestState = { id: 'busy', label: 'Generating', title: null, status: 'generating' }
        }

        await expect(adapter.setInteractivePromptResponse(TWO_KEYSTEP_RESPONSE))
            .rejects.toThrow(/focused question is "Which environment\?"/)
        expect(adapter.activeInteractivePrompt).toBe(prompt)
        expect(writes).toEqual(['1'])
    })

    it('fails closed before the first keystroke when a foreign picker already owns focus', async () => {
        const { adapter, writes, setScreen } = makeAdapter()
        setScreen(FOREIGN_QUESTION_SCREEN)

        await expect(adapter.setInteractivePromptResponse(TWO_KEYSTEP_RESPONSE))
            .rejects.toThrow(/focused question does not match/)
        expect(adapter.activeInteractivePrompt).toBe(prompt)
        expect(writes).toEqual([])
    })
})
