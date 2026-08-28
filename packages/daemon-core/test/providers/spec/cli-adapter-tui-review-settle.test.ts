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
        await expect(adapter.assertFocusedClaudeTuiReview(prompt)).resolves.toBeUndefined()
        expect(snapshots.n).toBeGreaterThan(1) // proves it re-snapshotted rather than gating on frame 1
    })

    it('accepts an already-settled review page without extra polling', async () => {
        const { adapter, snapshots } = makeAdapter([REVIEW_SCREEN])
        await expect(adapter.assertFocusedClaudeTuiReview(prompt)).resolves.toBeUndefined()
        expect(snapshots.n).toBe(1)
    })

    it('still fails closed when the screen never becomes the review page', async () => {
        const { adapter } = makeAdapter([QUESTION_SCREEN])
        await expect(adapter.assertFocusedClaudeTuiReview(prompt))
            .rejects.toThrow(/review page is not focused/)
    })

    it('still fails closed when the review page carries foreign headers', async () => {
        const foreignReview = REVIEW_SCREEN.replace('☒ Approach', '☒ Something Else')
        const { adapter } = makeAdapter([foreignReview])
        await expect(adapter.assertFocusedClaudeTuiReview(prompt))
            .rejects.toThrow(/does not match the active interactive prompt headers/)
    })
})
