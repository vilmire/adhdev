/**
 * DELIVERED-BUT-UNCONFIRMED (live defect, 2026-09-06 — sixth recurrence)
 *
 * Owner report, rc.87, mobile: a coordinator AskUserQuestion was answered from
 * the dashboard modal. The modal showed
 *
 *     "The input was delivered but verification failed —
 *      check the terminal screen or close this and try again."
 *
 * ...while the coordinator had in fact RECEIVED that answer and already
 * dispatched work from it. So `delivered` was true and only `verification` was
 * a false negative — and the copy invited a retry that would double-submit.
 *
 * Root cause is structural, not a tuning miss. By the time
 * assertFocusedClaudeTuiReview runs, setInteractivePromptResponse's key loop has
 * ALREADY written every answer keystroke to the PTY; only the final review Enter
 * is outstanding. A timeout there can therefore never mean "the answer did not
 * arrive". The previous code collapsed two very different outcomes into one hard
 * failure:
 *
 *   WRONG SCREEN — a foreign question / another widget owns focus. Refusing to
 *     press Enter is correct, and a retry is safe. Still fails closed.
 *   UNCONFIRMED  — our OWN bound question is still the focused page; the picker
 *     just has not advanced yet. Input delivered, screen ours, confirmation
 *     merely unavailable.
 *
 * The five prior fixes (f1720f8e, 6db3527e, 50bfe16d, d476f356, 60bd7614) each
 * widened a timeout, and the race resurfaced on the next slower link. No finite
 * budget bounds an arbitrarily slow remote repaint, so this asserts the OUTCOME
 * is correct at whatever budget is in force.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    CLAUDE_TUI_REVIEW_PAGE_NOT_FOCUSED_PREFIX,
    CLAUDE_TUI_REVIEW_UNCONFIRMED_PREFIX,
} from '@adhdev/mesh-shared'
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

/** A picker we do NOT own — the wrong-screen guard must still reject this. */
const FOREIGN_QUESTION_SCREEN = QUESTION_SCREEN
    .replace('☐ Approach', '☐ Deployment')
    .replace('Which approach?', 'Which environment?')
    .replace('Option A', 'Production')
    .replace('Option B', 'Staging')

const prompt = {
    promptId: 'toolu_unconfirmed',
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

function makeAdapter(frames: string[]): { adapter: any; writes: string[] } {
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

/**
 * Point the adapter at a JSONL transcript containing the AskUserQuestion
 * tool_use, and optionally its tool_result — Claude's authoritative record of
 * whether the answer actually landed.
 */
function withNativeHistory(adapter: any, opts: { resolved: boolean }): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-unconfirmed-'))
    const historyPath = path.join(dir, '11111111-1111-4111-8111-111111111111.jsonl')
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
    return dir
}

describe('review gate: delivered-but-unconfirmed vs wrong-screen', () => {
    // ── ② FALSE-NEGATIVE REPRODUCTION ────────────────────────────────────────
    // The review page never settles because the repaint is slow — the exact
    // 2026-09-06 shape. Our own question stays focused the whole time.

    it('REPRO: does NOT report a hard failure when our own bound question is still focused', async () => {
        const { adapter } = makeAdapter([QUESTION_SCREEN])

        // This is the assertion that goes RED without the fix: the old code threw
        // the not-focused class here, which the web mapped to "verification
        // failed ... try again".
        await expect(adapter.assertFocusedClaudeTuiReview(prompt, false))
            .rejects.toThrow(new RegExp(CLAUDE_TUI_REVIEW_UNCONFIRMED_PREFIX))
    })

    it('REPRO: the unconfirmed class is distinct from the not-focused class', async () => {
        const { adapter } = makeAdapter([QUESTION_SCREEN])
        await expect(adapter.assertFocusedClaudeTuiReview(prompt, false))
            .rejects.not.toThrow(new RegExp(CLAUDE_TUI_REVIEW_PAGE_NOT_FOCUSED_PREFIX))
    })

    it('REPRO: the unconfirmed error says the answer was delivered, never that it failed', async () => {
        const { adapter } = makeAdapter([QUESTION_SCREEN])
        const error = await adapter.assertFocusedClaudeTuiReview(prompt, false).catch((e: Error) => e)
        expect(error.message).toMatch(/delivered/i)
        expect(error.message).not.toMatch(/\bfailed\b/i)
    })

    // ── DELIVERY CONFIRMED BY THE NATIVE ORACLE ──────────────────────────────

    it('accepts as success when the native tool_result proves the answer landed', async () => {
        const { adapter, writes } = makeAdapter([QUESTION_SCREEN])
        withNativeHistory(adapter, { resolved: true })

        await adapter.setInteractivePromptResponse({
            promptId: prompt.promptId,
            answers: { q1: { selectedLabels: ['Option A'] } },
        })

        // Prompt released, and NO stray review Enter after the answer digit —
        // focus no longer belongs to our question.
        expect(adapter.activeInteractivePrompt).toBeNull()
        expect(adapter.interactivePromptTransport).toBeNull()
        expect(writes).toEqual(['1'])
    })

    it('stays unconfirmed when the native transcript has no tool_result yet', async () => {
        const { adapter } = makeAdapter([QUESTION_SCREEN])
        withNativeHistory(adapter, { resolved: false })

        await expect(adapter.assertFocusedClaudeTuiReview(prompt, false))
            .rejects.toThrow(new RegExp(CLAUDE_TUI_REVIEW_UNCONFIRMED_PREFIX))
        // Unconfirmed is NOT resolved: the prompt stays held so the question is
        // not silently lost if the answer really did not take.
        expect(adapter.activeInteractivePrompt).toBe(prompt)
    })

    // ── ③ REAL FAILURES MUST STILL BE REPORTED ───────────────────────────────
    // Suppressing a false negative must not swallow a true one.

    it('REAL FAILURE: a foreign focused question still fails closed as not-focused', async () => {
        const { adapter } = makeAdapter([FOREIGN_QUESTION_SCREEN])
        await expect(adapter.assertFocusedClaudeTuiReview(prompt, false))
            .rejects.toThrow(new RegExp(CLAUDE_TUI_REVIEW_PAGE_NOT_FOCUSED_PREFIX))
        expect(adapter.activeInteractivePrompt).toBe(prompt)
    })

    it('REAL FAILURE: a foreign picker is rejected even when a bound tool_result exists', async () => {
        // The oracle must not be able to launder a wrong-screen rejection: the
        // tool_result could belong to an earlier identical question.
        const { adapter } = makeAdapter([FOREIGN_QUESTION_SCREEN])
        withNativeHistory(adapter, { resolved: true })

        await expect(adapter.assertFocusedClaudeTuiReview(prompt, false))
            .rejects.toThrow(new RegExp(CLAUDE_TUI_REVIEW_PAGE_NOT_FOCUSED_PREFIX))
        expect(adapter.activeInteractivePrompt).toBe(prompt)
    })

    it('REAL FAILURE: a non-picker screen we do not own still fails closed', async () => {
        const { adapter } = makeAdapter(['Some unrelated full-screen widget\n\nnothing to select here'])
        await expect(adapter.assertFocusedClaudeTuiReview(prompt, false))
            .rejects.toThrow(new RegExp(CLAUDE_TUI_REVIEW_PAGE_NOT_FOCUSED_PREFIX))
    })
})
