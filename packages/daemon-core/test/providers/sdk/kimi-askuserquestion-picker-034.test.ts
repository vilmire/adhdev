import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildParseApprovalFromTui } from '../../../src/providers/sdk/v1/builders/cli/parse-approval.js'
import type { CliApprovalInput } from '../../../src/providers/sdk/v1/types/cli/index.js'

// kimi 0.34 AskUserQuestion picker — misroute guard (live PTY captures,
// 2026-08-11, kimi 0.34.0).
//
// The picker is detected from the session's wire.jsonl (kimi-pending-question.ts),
// never from the screen. The screen-side danger is the OPPOSITE misroute: if
// the manifest modal parser matched the picker's numbered option rows as an
// approval modal, the session would surface waiting_approval and the
// coordinator would try mesh_approve on a QUESTION (the rc.19 misroute class).
// These tests pin that the shipped kimi manifest's modal parser returns null
// for both the question page and the review screen.

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function loadKimiModalSpec(): Record<string, unknown> {
    let current = path.resolve(__dirname, '..', '..')
    for (let i = 0; i < 8; i += 1) {
        const candidate = path.join(current, 'adhdev-providers', 'cli', 'kimi', 'provider.v1.json')
        if (fs.existsSync(candidate)) {
            const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8'))
            return manifest.tui.modal
        }
        current = path.dirname(current)
    }
    throw new Error('kimi provider.v1.json not found')
}

function input(screenText: string): CliApprovalInput {
    return {
        buffer: screenText,
        screenText,
        rawBuffer: screenText,
        tail: screenText.split('\n').slice(-12).join('\n'),
    } as unknown as CliApprovalInput
}

// Single-select question page — verbatim layout from the live capture.
const PICKER_SINGLE = [
    ' question',
    '  Colors   (○) Animal   Submit ',
    ' ? Pick any colors?',
    '  → [1] Red',
    '    [2] Green',
    '    [3] Blue',
    '    [4] Other',
    '  ↑↓ select  1-4 / ↵ choose  ←/→/tab switch  esc cancel',
].join('\n')

// Multi-select question page: checkbox rows WITHOUT numbers, "↵ toggle" footer.
const PICKER_MULTI = [
    ' question',
    '  Colors   (○) Animal   Submit ',
    ' ? Pick any colors?',
    '  → [✓] Red',
    '    [ ] Green',
    '    [✓] Blue',
    '    [ ] Other',
    '  ↑↓ select  space / ↵ toggle  ←/→/tab switch  esc cancel',
].join('\n')

// Review screen after all questions are answered.
const PICKER_REVIEW = [
    ' question',
    '  (✓) Colors   (✓) Animal   Submit ',
    '  Review your answer before submit',
    '  Q  Pick any colors?',
    '   →  Red, Blue',
    '  Q  Pick an animal?',
    '   →  Otter',
    '  Ready to submit your answers?',
    '  → [1] Submit',
    '    [2] Cancel',
    '  ↑↓ select  1/2 choose  ↵ confirm  ←/→/tab switch  esc cancel',
].join('\n')

describe('kimi 0.34 AskUserQuestion picker — never parses as an approval modal', () => {
    const parse = buildParseApprovalFromTui(loadKimiModalSpec() as never)

    it('single-select question page → null', () => {
        expect(parse(input(PICKER_SINGLE))).toBeNull()
    })

    it('multi-select question page → null', () => {
        expect(parse(input(PICKER_MULTI))).toBeNull()
    })

    it('review screen (Submit/Cancel rows) → null', () => {
        // The review screen's "→ [1] Submit / [2] Cancel" rows are the closest
        // the picker comes to an approval modal's numbered buttons — pin that
        // the bracketed numbering is NOT matched as modal buttons.
        expect(parse(input(PICKER_REVIEW))).toBeNull()
    })
})
