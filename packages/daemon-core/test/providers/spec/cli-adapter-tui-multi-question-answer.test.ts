/**
 * MULTI-QUESTION PAGE REPAINT RACE (live defect, 2026-09-02)
 *
 * mesh_answer_question could not answer an AskUserQuestion carrying 2+
 * questions in ANY form (positional answers, questionId-keyed answers, strict
 * or friendly shape). Every attempt failed with:
 *
 *   Claude TUI focused question does not match the active interactive prompt
 *   (expected "<question 2>"; focused question is "<question 1>")
 *
 * Root cause: assertFocusedClaudeTuiQuestion gated on a SINGLE snapshot. The
 * keystroke that answers question N is also what navigates the picker onto
 * question N+1, and the fixed 180ms inter-key delay races that repaint. On a
 * slow frame the next loop iteration still saw the PREVIOUS page and failed
 * closed — and since the picker never moved, every retry reproduced it
 * identically: a permanent deadlock.
 *
 * The gate now polls on the same bounded budget assertFocusedClaudeTuiReview
 * already uses for the same class of race, while a screen that never becomes
 * the expected page still fails closed.
 *
 * SHARED-PATH CONSTRAINT: setInteractivePromptResponse is the answer path for
 * all 8 providers, so the single-question cases below are regression guards —
 * they must keep passing unchanged.
 */
import { describe, expect, it } from 'vitest'
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js'

type Dispatch = { kind: string; data?: string }

function questionScreen(nav: string, question: string, options: string[]): string {
    return [
        nav,
        '',
        question,
        '',
        ...options.map((option, i) => `${i === 0 ? '❯' : ' '} ${i + 1}. ${option}`),
        '',
        'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n')
}

const Q1_TEXT = 'Which manifest field shape?'
const Q2_TEXT = 'How far should this task go?'

const Q1_SCREEN = questionScreen('←  ☐ Manifest  ☐ Scope  ✔ Submit  →', Q1_TEXT, ['Inline', 'Referenced'])
const Q2_SCREEN = questionScreen('←  ☒ Manifest  ☐ Scope  ✔ Submit  →', Q2_TEXT, ['Minimal', 'Full'])
const REVIEW_SCREEN = [
    '←  ☒ Manifest  ☒ Scope  ✔ Submit  →',
    '',
    'Review your answers',
    '',
    '❯ 1. Submit',
    '',
    'Enter to select · Esc to cancel',
].join('\n')

const MULTI_PROMPT = {
    promptId: 'toolu_multi',
    origin: 'cli' as const,
    providerType: 'claude-cli',
    createdAt: 1,
    questions: [
        {
            questionId: 'q1',
            question: Q1_TEXT,
            header: 'Manifest',
            multiSelect: false,
            options: [{ label: 'Inline' }, { label: 'Referenced' }],
        },
        {
            questionId: 'q2',
            question: Q2_TEXT,
            header: 'Scope',
            multiSelect: false,
            options: [{ label: 'Minimal' }, { label: 'Full' }],
        },
    ],
}

const SINGLE_PROMPT = {
    promptId: 'toolu_single',
    origin: 'cli' as const,
    providerType: 'claude-cli',
    createdAt: 1,
    questions: [MULTI_PROMPT.questions[0]],
}

/**
 * A claude TUI simulator.
 *
 * `repaintLagFrames` is the defect knob: how many snapshots still return the
 * OLD page after the keystroke that advances it. 0 = instant repaint (the
 * lucky-timing case that always worked); 2 = the slow frame that deadlocked.
 */
function makeAdapter(options: {
    prompt: typeof MULTI_PROMPT | typeof SINGLE_PROMPT
    pages: string[]
    repaintLagFrames?: number
    multiSelectPages?: Set<number>
}) {
    const { prompt, pages, repaintLagFrames = 0, multiSelectPages = new Set<number>() } = options
    const dispatches: Dispatch[] = []
    let page = 0
    let lag = 0
    const lastPage = pages.length - 1

    const adapter: any = Object.create(SpecCliAdapter.prototype)
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
        spec: { id: 'claude-cli', name: 'claude-cli', interactive_prompt: { scheme: 'claude_tui' } },
        driver: {
            snapshot: () => {
                if (lag > 0) {
                    lag -= 1
                    if (lag === 0 && page < lastPage) page += 1
                }
                return pages[Math.min(page, lastPage)]
            },
            dispatch: (event: Dispatch) => {
                dispatches.push(event)
                if (event.kind !== 'pty_write' || page >= lastPage) return
                const data = event.data || ''
                // A digit commits+advances a single-select page; on a
                // multi-select page only Tab advances (digits just toggle).
                const advances = data === '\t' || (/^[0-9]$/.test(data) && !multiSelectPages.has(page))
                if (!advances) return
                if (repaintLagFrames > 0) lag = repaintLagFrames
                else page += 1
            },
            hasSeenReady: () => true,
        },
    })
    return { adapter, dispatches, currentPage: () => page }
}

describe('claude TUI multi-question answer', () => {
    it('answers both questions when the page repaint lags the keystroke (the deadlock)', async () => {
        const { adapter, dispatches } = makeAdapter({
            prompt: MULTI_PROMPT,
            pages: [Q1_SCREEN, Q2_SCREEN, REVIEW_SCREEN],
            repaintLagFrames: 2,
        })

        await expect(adapter.setInteractivePromptResponse({
            promptId: 'toolu_multi',
            answers: {
                q1: { selectedLabels: ['Inline'] },
                q2: { selectedLabels: ['Full'] },
            },
        })).resolves.toBeUndefined()

        // Option 1 on q1, option 2 on q2, then Enter to submit the review page.
        const keys = dispatches.filter(d => d.kind === 'pty_write').map(d => d.data)
        expect(keys).toEqual(['1', '2', '\r'])
        expect(adapter.activeInteractivePrompt).toBeNull()
    })

    it('answers both questions when the repaint is instant', async () => {
        const { adapter, dispatches } = makeAdapter({
            prompt: MULTI_PROMPT,
            pages: [Q1_SCREEN, Q2_SCREEN, REVIEW_SCREEN],
        })

        await adapter.setInteractivePromptResponse({
            promptId: 'toolu_multi',
            answers: {
                q1: { selectedLabels: ['Referenced'] },
                q2: { selectedLabels: ['Minimal'] },
            },
        })

        expect(dispatches.filter(d => d.kind === 'pty_write').map(d => d.data)).toEqual(['2', '1', '\r'])
        expect(adapter.activeInteractivePrompt).toBeNull()
    })

    it('answers a multi-select first question (digits toggle, Tab advances) across a lagging repaint', async () => {
        const multiSelectPrompt = {
            ...MULTI_PROMPT,
            questions: [
                { ...MULTI_PROMPT.questions[0], multiSelect: true },
                MULTI_PROMPT.questions[1],
            ],
        }
        const { adapter, dispatches } = makeAdapter({
            prompt: multiSelectPrompt,
            pages: [Q1_SCREEN, Q2_SCREEN, REVIEW_SCREEN],
            repaintLagFrames: 2,
            multiSelectPages: new Set([0]),
        })

        await adapter.setInteractivePromptResponse({
            promptId: 'toolu_multi',
            answers: {
                q1: { selectedLabels: ['Inline', 'Referenced'] },
                q2: { selectedLabels: ['Full'] },
            },
        })

        // Two toggles + Tab to commit q1, then q2's digit, then submit.
        expect(dispatches.filter(d => d.kind === 'pty_write').map(d => d.data)).toEqual(['1', '2', '\t', '2', '\r'])
        expect(adapter.activeInteractivePrompt).toBeNull()
    })

    it('still fails closed when a foreign picker takes over between questions', async () => {
        const foreign = questionScreen(
            '←  ☐ Deployment  ✔ Submit  →',
            'Which environment?',
            ['Production', 'Staging'],
        )
        // q1 answers, but the screen then shows an unrelated picker forever —
        // never the expected q2 page. The settle poll must not launder this.
        const { adapter } = makeAdapter({
            prompt: MULTI_PROMPT,
            pages: [Q1_SCREEN, foreign, foreign],
        })

        await expect(adapter.setInteractivePromptResponse({
            promptId: 'toolu_multi',
            answers: {
                q1: { selectedLabels: ['Inline'] },
                q2: { selectedLabels: ['Full'] },
            },
        })).rejects.toThrow(/does not match the active interactive prompt/)
        // Fail-closed: the held prompt survives so the answer can be reissued.
        expect(adapter.activeInteractivePrompt).toBe(MULTI_PROMPT)
    })

    // ---- SHARED-PATH REGRESSION GUARDS (single question, all providers) ----

    it('REGRESSION: single-question prompt still answers with one digit + submit', async () => {
        const { adapter, dispatches } = makeAdapter({
            prompt: SINGLE_PROMPT,
            pages: [Q1_SCREEN, REVIEW_SCREEN],
        })

        await adapter.setInteractivePromptResponse({
            promptId: 'toolu_single',
            answers: { q1: { selectedLabels: ['Referenced'] } },
        })

        expect(dispatches.filter(d => d.kind === 'pty_write').map(d => d.data)).toEqual(['2', '\r'])
        expect(adapter.activeInteractivePrompt).toBeNull()
    })

    it('REGRESSION: single-question prompt still fails closed on a foreign picker', async () => {
        const foreign = questionScreen('←  ☐ Deployment  ✔ Submit  →', 'Which environment?', ['Production'])
        const { adapter } = makeAdapter({ prompt: SINGLE_PROMPT, pages: [foreign] })

        await expect(adapter.setInteractivePromptResponse({
            promptId: 'toolu_single',
            answers: { q1: { selectedLabels: ['Inline'] } },
        })).rejects.toThrow(/does not match the active interactive prompt/)
        expect(adapter.activeInteractivePrompt).toBe(SINGLE_PROMPT)
    })

    it('REGRESSION: direct-submit completion still stops the key loop (no leaked keys)', async () => {
        // The picker vanishes after the first keystroke and the provider goes
        // busy — the direct-submit path. No further keys may be written.
        const BUSY = ['✻ Working…', '', 'esc to interrupt'].join('\n')
        const { adapter, dispatches } = makeAdapter({
            prompt: MULTI_PROMPT,
            pages: [Q1_SCREEN, BUSY, BUSY],
        })
        const originalDispatch = adapter.driver.dispatch
        adapter.driver.dispatch = (event: Dispatch) => {
            originalDispatch(event)
            // Once the answer key lands, the provider reports generating.
            adapter.latestState = { id: 'busy', label: 'Generating', title: null, status: 'generating' }
        }

        await adapter.setInteractivePromptResponse({
            promptId: 'toolu_multi',
            answers: {
                q1: { selectedLabels: ['Inline'] },
                q2: { selectedLabels: ['Full'] },
            },
        })

        // Only q1's digit — no q2 key and no submit Enter leaked into the busy screen.
        expect(dispatches.filter(d => d.kind === 'pty_write').map(d => d.data)).toEqual(['1'])
        expect(adapter.activeInteractivePrompt).toBeNull()
    })
})
