/**
 * PREVIEW (side-by-side) LAYOUT SUBMIT (live defect, 2026-09-10 incident +
 * 2026-09-06 cluster: 9 repeats in session 9ebb41af).
 *
 * An AskUserQuestion whose options carry `preview` fields renders claude's
 * side-by-side preview panel layout. Measured live against claude-cli v2.1.220
 * (2026-09-11, isolated stub-API session):
 *
 *   - WITHOUT previews, a digit key commits the option and auto-advances
 *     (the 40/40-verified remote-answer path).
 *   - WITH previews, a digit key only MOVES THE CURSOR onto the option. It
 *     never commits — 8s after the digit the picker is unchanged, matching the
 *     incident (state=picker 16s after injection). One explicit Enter commits
 *     the highlighted option and advances: to the next question, or — on a
 *     single-question prompt — to immediate submission with NO review page.
 *
 * The fix is two-pronged:
 *   1. keystroke builder: options with `preview` metadata (native JSONL
 *      capture keeps it) get `digit, Enter` instead of the bare digit;
 *   2. adapter screen fallback: a TUI-scrape-captured prompt has no preview
 *      metadata (the scrape strips the panel), so after the digit the adapter
 *      sends the commit Enter iff the live frame still shows OUR bound
 *      question AND the side-by-side panel signature.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLAUDE_TUI_REVIEW_UNCONFIRMED_PREFIX } from '@adhdev/mesh-shared'
import {
    buildClaudeInteractiveTuiAnswerSteps,
    claudeTuiPreviewPanelVisible,
    readFocusedClaudeTuiQuestion,
} from '../../../src/providers/types/interactive-prompt.js'
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js'

type Dispatch = { kind: string; data?: string }

const PREVIEW_QUESTION = 'Which fix approach should we take for the preview-layout submit defect?'

// Live ghostty-vt capture (claude-cli v2.1.220, 80x32, 2026-09-11), trimmed to
// the picker viewport. Single-question preview layout: no "✔ Submit" nav, no
// "Type something." row, unnumbered "Chat about this", box-drawn panel beside
// the options. The rounded welcome banner (│ verticals, ╭╮╰╯ corners) is kept
// ON PURPOSE: it sits inside the focused picker region (single footer) and
// must not trip the square-corner panel signature.
const PREVIEW_LAYOUT_SCREEN = [
    '╭─── Claude Code v2.1.220 ────────────────────╮',
    '│                Welcome back!                │',
    '╰─────────────────────────────────────────────╯',
    '',
    '❯ askq preview please',
    '',
    '────────────────────────────────────────────────────────────────────────────────',
    ' ☐ Approach',
    '',
    PREVIEW_QUESTION,
    '',
    '❯ 1. Detect preview layout,       ┌────────────────────────────────────────────┐',
    '    add Enter (Recommended)       │ export function                            │',
    '  2. Always send digit then       │ detectPreviewLayout(screenText) {          │',
    '    Enter                         │   // side-by-side option list + preview    │',
    '  3. Poll then conditional        │ panel                                      │',
    '    Enter                         │   return divider.test(screenText);         │',
    '                                  ├─── ✂ ─── 2 lines hidden ───────────────────┤',
    '                                  └────────────────────────────────────────────┘',
    '',
    '                                  Notes: press n to add notes',
    '',
    '────────────────────────────────────────────────────────────────────────────────',
    '  Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel',
].join('\n')

// Control group from the same live session: identical question WITHOUT
// previews — classic layout, digit auto-advances.
const PLAIN_LAYOUT_SCREEN = [
    '╭─── Claude Code v2.1.220 ────────────────────╮',
    '│                Welcome back!                │',
    '╰─────────────────────────────────────────────╯',
    '',
    '❯ askq plain please',
    '────────────────────────────────────────────────────────────────────────────────',
    ' ☐ Approach',
    '',
    PREVIEW_QUESTION,
    '',
    '❯ 1. Detect preview layout, add Enter (Recommended)',
    '     Detect the side-by-side preview layout and append an explicit Enter after',
    '     the digit key.',
    '  2. Always send digit then Enter',
    '     Unconditionally append Enter after the digit for single-select answers.',
    '  3. Poll then conditional Enter',
    '     After the digit, poll the settle budget; if the bound question is still',
    '     focused, send one Enter.',
    '  4. Type something.',
    '────────────────────────────────────────────────────────────────────────────────',
    '  5. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n')

const PREVIEW_OPTIONS = [
    { label: 'Detect preview layout, add Enter (Recommended)', preview: 'export function detectPreviewLayout() {}' },
    { label: 'Always send digit then Enter', preview: 'steps.push("\\r")' },
    { label: 'Poll then conditional Enter', preview: 'await poll()' },
]

function makePrompt(options: Array<{ label: string; preview?: string }>) {
    return {
        promptId: 'toolu_preview_layout',
        origin: 'cli' as const,
        providerType: 'claude-cli',
        createdAt: 1,
        questions: [{
            questionId: 'q1',
            question: PREVIEW_QUESTION,
            header: 'Approach',
            multiSelect: false,
            options,
        }],
    }
}

function makeAdapter(prompt: ReturnType<typeof makePrompt>, frames: string[]): { adapter: any; writes: string[] } {
    let n = 0
    const writes: string[] = []
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
            snapshot: () => frames[Math.min(n++, frames.length - 1)],
            dispatch: (event: Dispatch) => {
                if (event.kind === 'pty_write' && event.data !== undefined) writes.push(event.data)
            },
            hasSeenReady: () => true,
        },
    })
    return { adapter, writes }
}

/** Native JSONL with the AskUserQuestion tool_use and (optionally) its result. */
function withNativeHistory(adapter: any, prompt: ReturnType<typeof makePrompt>, opts: { resolved: boolean }): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-preview-layout-'))
    const historyPath = path.join(dir, '22222222-2222-4222-8222-222222222222.jsonl')
    let jsonl = `${JSON.stringify({
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
    })}\n`
    if (opts.resolved) {
        jsonl += `${JSON.stringify({
            type: 'user',
            message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: prompt.promptId, content: 'submitted' }],
            },
        })}\n`
    }
    fs.writeFileSync(historyPath, jsonl)
    adapter.workingDir = dir
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
}

describe('keystroke builder: preview options require the commit Enter', () => {
    it('appends Enter after the digit when any option carries a preview', () => {
        const prompt = makePrompt(PREVIEW_OPTIONS)
        expect(buildClaudeInteractiveTuiAnswerSteps(prompt, {
            promptId: prompt.promptId,
            answers: { q1: { selectedLabels: ['Always send digit then Enter'] } },
        })).toEqual(['2', '\r', '\r']) // digit, preview commit Enter, review-page Enter
    })

    it('REGRESSION: keeps the bare digit for options without previews', () => {
        const prompt = makePrompt(PREVIEW_OPTIONS.map(({ label }) => ({ label })))
        expect(buildClaudeInteractiveTuiAnswerSteps(prompt, {
            promptId: prompt.promptId,
            answers: { q1: { selectedLabels: ['Always send digit then Enter'] } },
        })).toEqual(['2', '\r']) // digit, review-page Enter — unchanged protocol
    })

    it('mixed multi-question prompt: Enter only on the preview question', () => {
        const prompt = {
            ...makePrompt(PREVIEW_OPTIONS),
            questions: [
                { ...makePrompt(PREVIEW_OPTIONS).questions[0], questionId: 'q1' },
                {
                    questionId: 'q2',
                    question: 'Which test tier should cover it?',
                    header: 'Tests',
                    multiSelect: false,
                    options: [{ label: 'Unit only' }, { label: 'Unit plus adapter' }],
                },
            ],
        }
        expect(buildClaudeInteractiveTuiAnswerSteps(prompt, {
            promptId: prompt.promptId,
            answers: {
                q1: { selectedLabels: ['Always send digit then Enter'] },
                q2: { selectedLabels: ['Unit only'] },
            },
        })).toEqual(['2', '\r', '1', '\r']) // q1 digit+commit Enter, q2 bare digit, review Enter
    })
})

describe('claudeTuiPreviewPanelVisible', () => {
    it('detects the live-captured side-by-side preview layout', () => {
        expect(claudeTuiPreviewPanelVisible(PREVIEW_LAYOUT_SCREEN)).toBe(true)
    })

    it('rejects the plain (control-group) layout — banner box glyphs included', () => {
        expect(claudeTuiPreviewPanelVisible(PLAIN_LAYOUT_SCREEN)).toBe(false)
    })

    it('rejects a screen with no picker at all', () => {
        expect(claudeTuiPreviewPanelVisible('nothing here')).toBe(false)
    })

    it('the preview layout still parses as a focused question (scrape capture path)', () => {
        const focused = readFocusedClaudeTuiQuestion(PREVIEW_LAYOUT_SCREEN)
        expect(focused?.question).toBe(PREVIEW_QUESTION)
    })
})

describe('adapter: preview layout answers submit', () => {
    it('metadata path: native-captured preview prompt writes digit then commit Enter', async () => {
        const prompt = makePrompt(PREVIEW_OPTIONS)
        const { adapter, writes } = makeAdapter(prompt, [PREVIEW_LAYOUT_SCREEN])
        withNativeHistory(adapter, prompt, { resolved: true })

        await adapter.setInteractivePromptResponse({
            promptId: prompt.promptId,
            answers: { q1: { selectedLabels: ['Always send digit then Enter'] } },
        })

        expect(writes).toEqual(['2', '\r'])
        expect(adapter.activeInteractivePrompt).toBeNull()
    })

    it('screen-fallback path: scrape-captured prompt (no preview metadata) still gets the commit Enter', async () => {
        const prompt = makePrompt(PREVIEW_OPTIONS.map(({ label }) => ({ label })))
        const { adapter, writes } = makeAdapter(prompt, [PREVIEW_LAYOUT_SCREEN])
        withNativeHistory(adapter, prompt, { resolved: true })

        await adapter.setInteractivePromptResponse({
            promptId: prompt.promptId,
            answers: { q1: { selectedLabels: ['Always send digit then Enter'] } },
        })

        expect(writes).toEqual(['2', '\r'])
        expect(adapter.activeInteractivePrompt).toBeNull()
    })

    it('REGRESSION: plain layout never receives the preview commit Enter', async () => {
        const prompt = makePrompt(PREVIEW_OPTIONS.map(({ label }) => ({ label })))
        const { adapter, writes } = makeAdapter(prompt, [PLAIN_LAYOUT_SCREEN])
        withNativeHistory(adapter, prompt, { resolved: true })

        await adapter.setInteractivePromptResponse({
            promptId: prompt.promptId,
            answers: { q1: { selectedLabels: ['Always send digit then Enter'] } },
        })

        // Bare digit only — the digit itself commits in this layout, and the
        // native tool_result resolves the prompt before any review Enter.
        expect(writes).toEqual(['2'])
        expect(adapter.activeInteractivePrompt).toBeNull()
    })
})

describe('unconfirmed error copy', () => {
    it('no longer claims the answer was delivered/submitted', async () => {
        const prompt = makePrompt(PREVIEW_OPTIONS.map(({ label }) => ({ label })))
        // Plain layout that never advances and no tool_result: keys written,
        // outcome unknown.
        const { adapter } = makeAdapter(prompt, [PLAIN_LAYOUT_SCREEN])
        withNativeHistory(adapter, prompt, { resolved: false })

        const error: Error = await adapter.setInteractivePromptResponse({
            promptId: prompt.promptId,
            answers: { q1: { selectedLabels: ['Always send digit then Enter'] } },
        }).then(() => { throw new Error('expected rejection') }, (e: Error) => e)

        expect(error.message).toContain(CLAUDE_TUI_REVIEW_UNCONFIRMED_PREFIX)
        expect(error.message).toMatch(/may not have been submitted/i)
        expect(error.message).not.toMatch(/keys reached the terminal but the review page did not settle/i)
    })
})
