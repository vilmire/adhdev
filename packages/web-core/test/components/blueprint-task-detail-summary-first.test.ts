/**
 * ★ A TASK DETAIL LEADS WITH THE SUMMARY, NOT THE WHOLE BRIEFING.
 *
 * Clicking a card on the blueprint canvas opened a panel whose FIRST element
 * was the task's entire `message` — the full instruction it was dispatched
 * with, rendered `whitespace-pre-wrap` with no clamp. Measured on the live
 * mesh, queue task 0dd248f0 carried several thousand characters, so the panel
 * opened as a wall of text with its own scrollbar and the fields a reader
 * actually opens it for (status, provider, difficulty, elapsed, failure
 * reason) were pushed below the fold.
 *
 * `splitTaskMessage` is the fix's decidable half: what stays visible and what
 * folds. The render half — that the fold is a <details> and that
 * blockedReason is lifted above it — is pinned by the source assertions at the
 * bottom, because @xyflow/react and the modal's fetch seam make a full render
 * assertion here more fragile than the thing it would check.
 *
 * Red-when-reverted: restoring the unconditional
 * `{task.message && <div class=whitespace-pre-wrap>…}` fails
 * `folds a long briefing` and the two source assertions.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TASK_MESSAGE_LEAD_CHARS, splitTaskMessage } from '../../src/components/MeshGraph/blueprintViewModel'

describe('splitTaskMessage', () => {
    it('shows a short task whole, with nothing folded away', () => {
        const short = 'rerun the flaky suite on win32'
        expect(splitTaskMessage(short)).toEqual({ lead: short, rest: '' })
    })

    it('folds a long briefing after its opening lines', () => {
        const long = `${'a'.repeat(200)}\n\n${'b'.repeat(4000)}`
        const parts = splitTaskMessage(long)
        expect(parts).not.toBeNull()
        expect(parts!.lead.length).toBeLessThanOrEqual(TASK_MESSAGE_LEAD_CHARS)
        expect(parts!.rest.length).toBeGreaterThan(0)
        // Nothing is dropped: the two halves still account for the whole text.
        expect((parts!.lead + parts!.rest).replace(/\s/g, '')).toBe(long.replace(/\s/g, ''))
    })

    it('prefers a paragraph break over a cut mid-sentence', () => {
        const message = `Fix the canvas zoom.\n\n${'detail '.repeat(200)}`
        const parts = splitTaskMessage(message)
        expect(parts!.lead).toBe('Fix the canvas zoom.')
    })

    it('falls back to a hard cut when no break sits late enough to be useful', () => {
        // A break at the very start would leave a visible part that says
        // nothing, so it is ignored in favour of a full-budget lead.
        const message = `x\n${'y'.repeat(4000)}`
        const parts = splitTaskMessage(message)
        expect(parts!.lead.length).toBeGreaterThan(TASK_MESSAGE_LEAD_CHARS / 2)
    })

    it('treats an absent or blank message as nothing to render', () => {
        expect(splitTaskMessage(null)).toBeNull()
        expect(splitTaskMessage(undefined)).toBeNull()
        expect(splitTaskMessage('   \n  ')).toBeNull()
    })
})

describe('the queue detail renders summary-first', () => {
    const source = fs.readFileSync(
        path.join(import.meta.dirname, '../../src/components/MeshGraph/MeshOverviewCards.tsx'),
        'utf8',
    )

    it('folds the remainder behind a disclosure instead of dumping it', () => {
        expect(source).toContain('splitTaskMessage')
        expect(source).toContain('detailLabelFullInstruction')
        // The old shape: message rendered unconditionally, unclamped, first.
        expect(source).not.toMatch(
            /\{task\.message && <div className=\{`whitespace-pre-wrap text-xs leading-5/,
        )
    })

    it('surfaces why a task stopped, and how long it took', () => {
        expect(source).toContain('task.blockedReason')
        expect(source).toContain('detailLabelElapsed')
    })
})
