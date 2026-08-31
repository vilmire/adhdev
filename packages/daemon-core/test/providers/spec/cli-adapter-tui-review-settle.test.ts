/**
 * REVIEW-PAGE REPAINT RACE (live defect, 2026-08-28)
 *
 * The last answer keystroke is what navigates the claude TUI picker onto its
 * review/submit page. assertFocusedClaudeTuiReview used to gate on a SINGLE
 * snapshot taken a fixed 180ms after that keypress, so a slow repaint left the
 * previous question page on screen and the assertion failed closed:
 * "Claude TUI review page is not focused for the active interactive prompt".
 *
 * The gate now polls on the same bounded budget the capture path uses
 * (CLAUDE_TUI_PAGE_SETTLE_TIMEOUT_MS / CLAUDE_TUI_PAGE_POLL_INTERVAL_MS), so a
 * late-arriving review frame is accepted — while a screen that never becomes
 * the review page still fails closed.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js'

type Dispatch = { kind: string; data?: string }

const QUESTION_SCREEN = [
    '←  ☐ Approach  ✔ Submit  →',
    '',
    'Which approach?',
    '',
    '❯ 1. Option A',
    '  2. Option B',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n')

const REVIEW_SCREEN = [
    '←  ☒ Approach  ✔ Submit  →',
    '',
    'Review your answers',
    '',
    '❯ 1. Submit',
    '',
    'Enter to select · Esc to cancel',
].join('\n')

const BUSY_SCREEN = [
    '✻ Working…',
    '',
    'esc to interrupt',
].join('\n')

const FOREIGN_QUESTION_SCREEN = QUESTION_SCREEN
    .replace('☐ Approach', '☐ Deployment')
    .replace('Which approach?', 'Which environment?')
    .replace('Option A', 'Production')
    .replace('Option B', 'Staging')

const prompt = {
    promptId: 'toolu_review',
    origin: 'cli' as const,
    providerType: 'claude-cli',
    createdAt: 1,
    questions: [{
        questionId: 'q1',
        question: 'Which approach?',
        header: 'Approach',
        multiSelect: false,
        options: [{ label: 'Option A' }, { label: 'Option B' }],
    }],
}

/** Adapter whose snapshot() returns `frames` in order, repeating the last. */
function makeAdapter(frames: string[]): { adapter: any; snapshots: { n: number } } {
    const snapshots = { n: 0 }
    const dispatches: Dispatch[] = []
    const adapter = Object.create(SpecCliAdapter.prototype)
    Object.assign(adapter, {
        cliType: 'claude-cli',
        cliName: 'claude-cli',
        spawned: true,
        exited: false,
        activeInteractivePrompt: prompt,
        interactivePromptTransport: 'tui',
        latestState: { id: 'idle', label: 'x', title: null, status: 'idle' },
        latestModal: null,
        statusCallback: () => { /* noop */ },
        spec: { id: 'claude-cli', name: 'claude-cli' },
        driver: {
            snapshot: () => {
                const frame = frames[Math.min(snapshots.n, frames.length - 1)]
                snapshots.n += 1
                return frame
            },
            dispatch: (event: Dispatch) => dispatches.push(event),
            hasSeenReady: () => true,
        },
    })
    return { adapter, snapshots }
}

describe('assertFocusedClaudeTuiReview settle-poll', () => {
    it('accepts a review page that only appears after a late repaint', async () => {
        // Two stale question frames, then the review page — the exact shape a
        // fixed single-snapshot delay used to reject.
        const { adapter, snapshots } = makeAdapter([QUESTION_SCREEN, QUESTION_SCREEN, REVIEW_SCREEN])
        await expect(adapter.assertFocusedClaudeTuiReview(prompt, false)).resolves.toBeUndefined()
        expect(snapshots.n).toBeGreaterThan(1) // proves it re-snapshotted rather than gating on frame 1
    })

    it('accepts an already-settled review page without extra polling', async () => {
        const { adapter, snapshots } = makeAdapter([REVIEW_SCREEN])
        await expect(adapter.assertFocusedClaudeTuiReview(prompt, false)).resolves.toBeUndefined()
        expect(snapshots.n).toBe(1)
    })

    it('still fails closed when the screen never becomes the review page', async () => {
        const { adapter } = makeAdapter([QUESTION_SCREEN])
        await expect(adapter.assertFocusedClaudeTuiReview(prompt, false))
            .rejects.toThrow(/review page is not focused/)
    })

    it('still fails closed when the review page carries foreign headers', async () => {
        const foreignReview = REVIEW_SCREEN.replace('☒ Approach', '☒ Something Else')
        const { adapter } = makeAdapter([foreignReview])
        await expect(adapter.assertFocusedClaudeTuiReview(prompt, false))
            .rejects.toThrow(/does not match the active interactive prompt headers/)
    })

    it('still fails closed when a foreign question is focused after the provider advances to busy', async () => {
        const { adapter } = makeAdapter([FOREIGN_QUESTION_SCREEN])
        adapter.latestState = { id: 'busy', label: 'Generating', title: null, status: 'generating' }

        await expect(adapter.assertFocusedClaudeTuiReview(prompt, false))
            .rejects.toThrow(/review page is not focused/)
        expect(adapter.activeInteractivePrompt).toBe(prompt)
    })

    it('clears the prompt when the question disappears and the provider advances to busy without a review page', async () => {
        let screen = QUESTION_SCREEN
        const writes: string[] = []
        const { adapter } = makeAdapter([QUESTION_SCREEN])
        adapter.driver = {
            snapshot: () => screen,
            dispatch: (event: Dispatch) => {
                if (event.kind !== 'pty_write' || event.data === undefined) return
                writes.push(event.data)
                if (event.data === '1') {
                    screen = BUSY_SCREEN
                    adapter.latestState = { id: 'busy', label: 'Generating', title: null, status: 'generating' }
                }
            },
            hasSeenReady: () => true,
        }

        await adapter.setInteractivePromptResponse({
            promptId: prompt.promptId,
            answers: { q1: { selectedLabels: ['Option A'] } },
        })

        // The answer digit is the only key: no non-existent review-page Enter.
        expect(writes).toEqual(['1'])
        expect(adapter.activeInteractivePrompt).toBeNull()
        expect(adapter.interactivePromptTransport).toBeNull()
    })

    it('clears the prompt when a bound native tool_result arrives without a review page', async () => {
        const historyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-direct-submit-history-'))
        const historyPath = path.join(historyDir, '11111111-1111-4111-8111-111111111111.jsonl')
        let screen = QUESTION_SCREEN
        const writes: string[] = []
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

            const { adapter } = makeAdapter([QUESTION_SCREEN])
            adapter.workingDir = historyDir
            adapter.spawnedAtMs = 0
            adapter.spec.native_history = {
                source: {
                    kind: 'jsonl',
                    path: historyPath,
                    session_id_from: 'filename_uuid',
                    message_filter: { where: "$.type == 'user' || $.type == 'assistant'" },
                    message_map: {
                        role: '$.message.role',
                        content: '$.message.content',
                        tools: {},
                    },
                },
            }
            adapter.driver = {
                snapshot: () => screen,
                dispatch: (event: Dispatch) => {
                    if (event.kind !== 'pty_write' || event.data === undefined) return
                    writes.push(event.data)
                    if (event.data !== '1') return
                    screen = BUSY_SCREEN
                    fs.appendFileSync(historyPath, `${JSON.stringify({
                        type: 'user',
                        message: {
                            role: 'user',
                            content: [{
                                type: 'tool_result',
                                tool_use_id: prompt.promptId,
                                content: 'submitted',
                            }],
                        },
                    })}\n`)
                    // Deliberately leave latestState idle: the bound native
                    // tool_result alone must complete this OR branch.
                },
                hasSeenReady: () => true,
            }

            await adapter.setInteractivePromptResponse({
                promptId: prompt.promptId,
                answers: { q1: { selectedLabels: ['Option A'] } },
            })

            expect(writes).toEqual(['1'])
            expect(adapter.activeInteractivePrompt).toBeNull()
            expect(adapter.interactivePromptTransport).toBeNull()
        } finally {
            fs.rmSync(historyDir, { recursive: true, force: true })
        }
    })
})

/**
 * RESIDUAL FOCUS-GUARD GAP (live defect, 2026-08-29, follow-up to rc.34/f1720f8e).
 *
 * rc.34 tuned the settle-poll budget (CLAUDE_TUI_PAGE_SETTLE_TIMEOUT_MS,
 * 600ms/5 samples) against a plain option-select transition. A multi-choice
 * AskUserQuestion answered via its "Type something." / Other freeform field
 * commits a typed string on its last keystroke instead — the TUI must lay
 * that text out into the review echo before the picker settles, which this
 * fixture models as several extra stale frames beyond what the plain budget
 * tolerates. The dashboard/mesh_answer_question answer for such a question
 * was rejected with "Claude TUI review page is not focused for the active
 * interactive prompt" even though the review page was only moments away —
 * confirmed live: the coordinator's multi-choice modal (3 options + Other)
 * answered via Other showed this exact error while the daemon log carried no
 * matching failure line (assertFocusedClaudeTuiReview did not log before this
 * fix), and the question was answered successfully on the very next attempt.
 */
describe('assertFocusedClaudeTuiReview settle-poll — freeform (Other) allowsFreeform budget', () => {
    // One more stale frame than CLAUDE_TUI_PAGE_SETTLE_TIMEOUT_MS(600)/
    // CLAUDE_TUI_PAGE_POLL_INTERVAL_MS(120) tolerates, modelling the slower
    // repaint after a typed-and-confirmed freeform answer.
    const SLOW_FREEFORM_FRAMES = [
        QUESTION_SCREEN, QUESTION_SCREEN, QUESTION_SCREEN, QUESTION_SCREEN,
        QUESTION_SCREEN, QUESTION_SCREEN, QUESTION_SCREEN, QUESTION_SCREEN,
        REVIEW_SCREEN,
    ]

    it('RED: the plain budget fails closed on a slow freeform-shaped repaint', async () => {
        const { adapter } = makeAdapter(SLOW_FREEFORM_FRAMES)
        await expect(adapter.assertFocusedClaudeTuiReview(prompt, false))
            .rejects.toThrow(/review page is not focused/)
    })

    it('GREEN: allowsFreeform=true widens the budget enough to observe the late review frame', async () => {
        const { adapter, snapshots } = makeAdapter(SLOW_FREEFORM_FRAMES)
        await expect(adapter.assertFocusedClaudeTuiReview(prompt, true)).resolves.toBeUndefined()
        expect(snapshots.n).toBeGreaterThan(6)
    })

    it('still fails closed under the widened budget when the screen never becomes the review page', async () => {
        const { adapter } = makeAdapter([QUESTION_SCREEN])
        await expect(adapter.assertFocusedClaudeTuiReview(prompt, true))
            .rejects.toThrow(/review page is not focused/)
    })
})
