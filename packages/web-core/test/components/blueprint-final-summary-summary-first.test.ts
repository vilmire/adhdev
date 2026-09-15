/**
 * ★ THE FINAL SUMMARY LEADS WITH A SUMMARY, NOT THE WHOLE REPORT.
 *
 * `babbc4ad` made the task detail summary-first, but only for the task's own
 * `message`. The FINAL SUMMARY — the worker's report — kept rendering whole, so
 * a completed task's panel still opened with a wall of text in a scrollbox
 * above the fields the panel exists to answer. Measured on the rc.30 preview:
 * queue task `85adc645` dumped its entire JSON report.
 *
 * Why this is not just `splitTaskMessage` again: that function cuts on PROSE
 * boundaries (paragraph, line, sentence), and a worker report is normally JSON,
 * which has none of them in the places that matter.
 *   - Pretty-printed there is no blank line at all, so the cut lands on
 *     whichever `",\n` happened to fall inside the budget — a lead of `{` plus
 *     two arbitrary half-fields.
 *   - Minified there is no break of any kind, so the cut is mid-token.
 * Either way the "summary" is noise, which is why JSON gets a structural
 * summary (lead with the report's own summary-ish field) instead of a slice.
 *
 * Red-when-reverted: rendering `finalSummary` raw again — i.e. dropping
 * `splitFinalSummary` from either panel — fails the wiring block below, and
 * making it a plain `splitTaskMessage` alias fails every JSON case here.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { splitFinalSummary, TASK_MESSAGE_LEAD_CHARS } from '../../src/components/MeshGraph/blueprintViewModel'

describe('splitFinalSummary — JSON reports', () => {
    const report = {
        status: 'completed',
        summary: 'Routed the mission thread around cards and raised its contrast.',
        changedFiles: ['MeshTaskDagView.tsx', 'blueprintViewModel.ts'],
        testEvidence: 'x'.repeat(500),
    }

    it('leads with the report\'s own summary field, not a slice of its braces', () => {
        const parts = splitFinalSummary(JSON.stringify(report, null, 2))
        expect(parts).not.toBeNull()
        expect(parts!.lead).toBe(report.summary)
        // The defining property: the lead is NOT the start of the raw JSON.
        expect(parts!.lead.startsWith('{')).toBe(false)
    })

    it('folds the whole report away rather than showing it up front', () => {
        const raw = JSON.stringify(report, null, 2)
        const parts = splitFinalSummary(raw)!
        expect(parts.rest).not.toBe('')
        // Nothing is lost — every field is still reachable behind the fold.
        for (const key of Object.keys(report)) expect(parts.rest).toContain(key)
        expect(parts.rest).toContain(report.testEvidence)
    })

    it('handles a MINIFIED report, which has no line break to cut on at all', () => {
        const parts = splitFinalSummary(JSON.stringify(report))!
        expect(parts.lead).toBe(report.summary)
        // Re-serialised for reading, so the folded body is not one long line.
        expect(parts.rest).toContain('\n')
    })

    it('prefers the most informative field when several are present', () => {
        // `status` alone is true but says little; a real summary outranks it.
        const parts = splitFinalSummary(JSON.stringify({ status: 'completed', result: 'Landed on the feature branch.' }))!
        expect(parts.lead).toBe('Landed on the feature branch.')
    })

    it('falls back to status when that is the only thing it recognises', () => {
        const parts = splitFinalSummary(JSON.stringify({ status: 'failed', errors: ['boom'] }))!
        expect(parts.lead).toBe('failed')
    })

    it('names the report\'s shape when no field is recognised, rather than inventing a summary', () => {
        const parts = splitFinalSummary(JSON.stringify({ alpha: 1, beta: 2 }))!
        // A field whose meaning is unknown must not be presented as the summary.
        expect(parts.lead).toBe('{ alpha, beta }')
        expect(parts.rest).toContain('alpha')
    })

    it('clamps a pathologically long summary field', () => {
        const parts = splitFinalSummary(JSON.stringify({ summary: 'y'.repeat(2000) }))!
        expect(parts.lead.length).toBeLessThanOrEqual(TASK_MESSAGE_LEAD_CHARS + 1)
        expect(parts.lead.endsWith('…')).toBe(true)
    })
})

describe('splitFinalSummary — prose and edges', () => {
    it('treats non-JSON as prose, matching the instruction block exactly', () => {
        const prose = `Fixed the routing.\n\n${'z'.repeat(600)}`
        const parts = splitFinalSummary(prose)!
        expect(parts.lead).toBe('Fixed the routing.')
        expect(parts.rest).toContain('z')
    })

    it('shows a short report whole, with nothing folded', () => {
        const parts = splitFinalSummary('Done.')!
        expect(parts.lead).toBe('Done.')
        expect(parts.rest).toBe('')
    })

    it('returns null for nothing at all, so the panel keeps its own empty states', () => {
        // The loading / unavailable branches must still be reachable.
        for (const empty of [null, undefined, '', '   ']) {
            expect(splitFinalSummary(empty)).toBeNull()
        }
    })

    it('does not treat a JSON array or a bare scalar as a report', () => {
        // Only an object carries named fields to lead with; anything else is
        // prose as far as this function is concerned.
        expect(splitFinalSummary('[1, 2, 3]')!.lead).toBe('[1, 2, 3]')
        expect(splitFinalSummary('"just a string"')!.lead).toBe('"just a string"')
    })

    it('survives text that merely starts like JSON but does not parse', () => {
        const broken = `{ this is not json, it just starts with a brace. ${'w'.repeat(400)}`
        const parts = splitFinalSummary(broken)!
        expect(parts.lead.length).toBeGreaterThan(0)
        expect(parts.lead.length).toBeLessThanOrEqual(TASK_MESSAGE_LEAD_CHARS)
    })
})

/* Both panels that render a final summary must actually use it — the helper
 * being green in isolation says nothing about what the owner sees. */
describe('both final-summary panels are summary-first', () => {
    const CARDS = path.join(import.meta.dirname, '../../src/components/MeshGraph/MeshOverviewCards.tsx')
    const VIEW = path.join(import.meta.dirname, '../../src/components/MeshGraph/MeshTaskDagView.tsx')

    for (const [label, file] of [['overview modal', CARDS], ['canvas side panel', VIEW]] as const) {
        it(`${label} folds the report behind a disclosure`, () => {
            const text = fs.readFileSync(file, 'utf8')
            expect(text).toContain('splitFinalSummary')
            // The raw dump this replaced: the summary rendered as the sole
            // child of a div, with no lead/rest split.
            expect(text).not.toMatch(/>\{output\.finalSummary\}</)
            expect(text).not.toMatch(/>\{selectedOutput\.finalSummary\}</)
            // Lead visible, remainder behind <details> — the same idiom the
            // instruction block uses.
            expect(text).toMatch(/finalSummaryParts\.lead|FinalSummaryParts\.lead/)
            expect(text).toMatch(/<details>/)
        })
    }
})
