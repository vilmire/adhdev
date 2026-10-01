/**
 * PREVIEW-PANEL-LABEL-BLEED (live defect, 2026-10-01, claude-cli v2.1.220).
 *
 * An AskUserQuestion picker WITH previews renders the option list on the left
 * and a box-drawn preview panel on the right on the SAME terminal rows. The
 * spec's line-anchored button pattern captured to end-of-line, so the panel
 * column bled into every parsed label ("Keep them (Recommended)      ┌──…┐"),
 * breaking resolve_action label matching and the dashboard prompt options.
 * Lines below are verbatim from the live screens.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractButtonsFromRule, stripSidePanelColumn } from '../../../src/providers/spec/evaluator.js'
import { parseClaudeInteractiveTuiQuestion } from '../../../src/providers/types/interactive-prompt.js'

const BOX = '┌────────────────────────────────────────────┐'

const KEEP_DROP_SCREEN = [
    'Should the renamed test files be kept?',
    '',
    `❯ 1. Keep them (Recommended)      ${BOX}`,
    '  2. Drop them                    │ src/store.test.ts  (renamed from           │',
    '                                  └────────────────────────────────────────────┘',
    '',
    'Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel',
].join('\n')

const WRITE_SCREEN = [
    'Write the refine config?',
    '',
    `❯ 1. Write as suggested           ${BOX}`,
    '  2. Write it, but don\'t          │   "version": 1,                            │',
    '  3. Skip refinery; I\'ll          │     "required": true,                      │',
    '                                  └────────────────────────────────────────────┘',
    '',
    'Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel',
].join('\n')

function loadClaudeButtonRule(stateId: string): any {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const specPath = path.resolve(here, '../../../../../../adhdev-providers/cli/claude-cli/specs/4.0.json')
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'))
    return spec.states.find((s: any) => s.id === stateId).extract.buttons
}

describe('stripSidePanelColumn', () => {
    it('cuts at a 2+ space gutter followed by any box-drawing glyph', () => {
        expect(stripSidePanelColumn(`Keep them (Recommended)      ${BOX}`)).toBe('Keep them (Recommended)')
        expect(stripSidePanelColumn('Drop them                    │ src/store.test.ts  (renamed from           │'))
            .toBe('Drop them')
        expect(stripSidePanelColumn('Write it, but don\'t          │   "version": 1,                            │'))
            .toBe('Write it, but don\'t')
        expect(stripSidePanelColumn('Foo   ╭── rounded')).toBe('Foo')
    })

    it('leaves ordinary labels untouched (no gutter, or no box glyph)', () => {
        expect(stripSidePanelColumn('Yes, and don\'t ask again')).toBe('Yes, and don\'t ask again')
        expect(stripSidePanelColumn('Keep  spacing here')).toBe('Keep  spacing here')
        expect(stripSidePanelColumn('a│b')).toBe('a│b')
    })
})

describe('claude-cli spec buttons: preview panel column is stripped from labels', () => {
    for (const stateId of ['picker', 'approval']) {
        it(`${stateId}: Keep/Drop screen`, () => {
            const buttons = extractButtonsFromRule(loadClaudeButtonRule(stateId), KEEP_DROP_SCREEN)
            expect(buttons.map(b => b.label)).toEqual(['Keep them (Recommended)', 'Drop them'])
            expect(buttons.map(b => b.index)).toEqual([1, 2])
            expect(buttons[0].current).toBe(true)
        })

        it(`${stateId}: Write screen`, () => {
            const buttons = extractButtonsFromRule(loadClaudeButtonRule(stateId), WRITE_SCREEN)
            expect(buttons.map(b => b.label)).toEqual([
                'Write as suggested',
                'Write it, but don\'t',
                'Skip refinery; I\'ll',
            ])
            expect(buttons.map(b => b.key)).toEqual(['1\r', '2\r', '3\r'])
        })
    }

    it('continuation-lines rules strip the panel from wrapped rows and skip panel-only rows', () => {
        const rule = {
            section: 'modal',
            pattern: '^\\s*(?:[❯›>]\\s*)?(\\d+)\\.\\s*(.+?)\\s*$',
            continuation_lines: true,
        } as any
        const screen = [
            `❯ 1. Detect preview layout,       ${BOX}`,
            '    add Enter (Recommended)       │ export function                            │',
            '  2. Always send digit then       │ detectPreviewLayout(screenText) {          │',
            '    Enter                         │   // side-by-side option list + preview    │',
            '                                  └────────────────────────────────────────────┘',
        ].join('\n')
        const buttons = extractButtonsFromRule(rule, screen)
        expect(buttons.map(b => b.label)).toEqual([
            'Detect preview layout, add Enter (Recommended)',
            'Always send digit then Enter',
        ])
    })
})

describe('claude TUI scrape: preview panel top-border row is stripped from the option label', () => {
    it('Keep/Drop screen options are clean', () => {
        const q = parseClaudeInteractiveTuiQuestion({ screenText: KEEP_DROP_SCREEN }, 0)
        expect(q?.options.map(o => o.label)).toEqual(['Keep them (Recommended)', 'Drop them'])
    })

    it('Write screen options are clean', () => {
        const q = parseClaudeInteractiveTuiQuestion({ screenText: WRITE_SCREEN }, 0)
        expect(q?.options.map(o => o.label)).toEqual([
            'Write as suggested',
            'Write it, but don\'t',
            'Skip refinery; I\'ll',
        ])
    })
})
