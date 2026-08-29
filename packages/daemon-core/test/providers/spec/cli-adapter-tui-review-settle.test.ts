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
describe('assertFocusedClaudeTuiReview settle-poll — freeform (Other) answers', () => {
    // One more stale frame than CLAUDE_TUI_PAGE_SETTLE_TIMEOUT_MS(600)/
    // CLAUDE_TUI_PAGE_POLL_INTERVAL_MS(120) tolerates, modelling the slower
    // repaint after a typed-and-confirmed freeform answer.
    const SLOW_FREEFORM_FRAMES = [
        QUESTION_SCREEN, QUESTION_SCREEN, QUESTION_SCREEN, QUESTION_SCREEN,
        QUESTION_SCREEN, QUESTION_SCREEN, QUESTION_SCREEN, QUESTION_SCREEN,
        REVIEW_SCREEN,
    ]

    it('RED: the plain (non-freeform) budget fails closed on a slow freeform-shaped repaint', async () => {
        const { adapter } = makeAdapter(SLOW_FREEFORM_FRAMES)
        await expect(adapter.assertFocusedClaudeTuiReview(prompt, false))
            .rejects.toThrow(/review page is not focused/)
    })

    it('GREEN: usedFreeform=true widens the budget enough to observe the late review frame', async () => {
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
