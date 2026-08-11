import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildParseApprovalFromTui } from '../../../src/providers/sdk/v1/builders/cli/parse-approval.js'
import type { CliApprovalInput } from '../../../src/providers/sdk/v1/types/cli/index.js'

// kimi 0.34 approval-modal regression (live PTY capture, 2026-08-11).
//
// kimi 0.34 renders tool-permission modals with tool-kind-specific titles —
//   ▶ Run this command?      (Bash)
//   ▶ Apply changes?         (Edit/Write)
//   ▶ Approve action?        (generic fallback)
//   ▶ Fetch URL? / ▶ Search? / ▶ File operation? / ▶ Invoke?
// — plus the ▶ block-header marker. The pre-1.0.7 manifest questionPattern
// only covered the older phrasings ("Run this command?", "Do you want to…"),
// so the newer titles never matched: parseApproval returned null, the daemon
// never surfaced awaiting_approval, and a manual-permission kimi session
// parked on the modal forever ("stuck on approval").
//
// These tests drive the REAL shipped manifest (adhdev-providers/cli/kimi/
// provider.v1.json) through buildParseApprovalFromTui against screens captured
// from kimi 0.34.0, so a future kimi title change fails here instead of in
// the field.

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

const COMMAND_MODAL = [
    ' ● Running a command',
    '   $ touch /tmp/kimi-modal-probe.txt',
    ' ──────────────────────────────────────────────────────────────────────────────',
    '   ▶ Run this command?',
    '   cwd: /Users/vilmire/Work/adhdev',
    '   $ touch /tmp/kimi-modal-probe.txt',
    '   ▶ 1. Approve once',
    '     2. Approve for this session',
    '     3. Reject',
    '     4. Reject with feedback',
    '   ↑/↓ select · 1/2/3/4 choose · ↵ confirm',
    ' ──────────────────────────────────────────────────────────────────────────────',
    ' K3 thinking: high  ~/Work/adhdev  main [±]',
].join('\n')

function modalWithTitle(title: string): string {
    return COMMAND_MODAL.replace('Run this command?', title)
}

describe('kimi 0.34 approval modal — shipped manifest spec', () => {
    const parse = buildParseApprovalFromTui(loadKimiModalSpec() as never)

    it('parses the captured Bash permission modal verbatim', () => {
        const modal = parse(input(COMMAND_MODAL))
        expect(modal).not.toBeNull()
        expect(modal!.message).toContain('Run this command?')
        expect(modal!.buttons).toEqual([
            'Approve once',
            'Approve for this session',
            'Reject',
            'Reject with feedback',
        ])
    })

    it.each([
        'Apply changes?',
        'Apply these edits?',
        'Approve action?',
        'Fetch URL?',
        'File operation?',
        'Ready to build with this plan?',
    ])('parses the 0.34 "%s" title', (title) => {
        const modal = parse(input(modalWithTitle(title)))
        expect(modal).not.toBeNull()
        expect(modal!.buttons.length).toBeGreaterThanOrEqual(2)
    })

    it('returns null for ordinary assistant prose with a numbered list', () => {
        const prose = [
            ' ● Here is the plan:',
            '   1. First step',
            '   2. Second step',
            ' Let me know what you think.',
        ].join('\n')
        expect(parse(input(prose))).toBeNull()
    })
})
