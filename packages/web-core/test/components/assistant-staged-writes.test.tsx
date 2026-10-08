// @vitest-environment jsdom
/**
 * Assistant "held for your approval" surface (design 2026-10-07 §4.10.2,
 * research 2026-10-08 Q8): list render, review-turn grouping with batch
 * resolve by `reviewTurnId`, single approve / reject calls, per-item failure
 * display for a partial batch, and nothing rendered while nothing is held.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AssistantStagedWrites from '../../src/components/dashboard/AssistantStagedWrites'
import {
    groupStagedItems,
    parseResolveOutcomes,
    parseStagedList,
} from '../../src/components/dashboard/assistant-staged'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REVIEW = 'review:1759900000000'

function listAnswer() {
    return {
        success: true,
        memory: [
            { kind: 'memory', id: 'mem-1', createdAt: '2026-10-08T01:00:00.000Z', origin: 'relay', op: { action: 'add', target: 'memory', content: 'Prefers small PRs' } },
            { kind: 'memory', id: 'mem-2', createdAt: '2026-10-08T02:00:00.000Z', origin: 'review_tainted', reviewTurnId: REVIEW, op: { action: 'replace', target: 'memory', match: 'old line', content: 'new line' } },
        ],
        skills: [
            { kind: 'skill', id: 'skl-1', createdAt: '2026-10-08T02:00:01.000Z', origin: 'review_tainted', reason: 'origin', reviewTurnId: REVIEW, op: { action: 'patch', name: 'deploy-preview', old: 'step a', new: 'step b' }, ctx: null },
        ],
        notes: [
            { kind: 'note', id: 'note-1', createdAt: '2026-10-08T02:00:02.000Z', origin: 'review', meshId: 'm1', project: 'adhdev', reviewTurnId: REVIEW, op: { action: 'record', text: 'Run check:file-sizes before merge', category: 'gotcha' } },
        ],
    }
}

describe('assistant-staged model', () => {
    it('parses all three stores (and the cloud wrapper) into display items, oldest first', () => {
        const items = parseStagedList({ success: true, result: listAnswer() })!
        expect(items.map(i => i.id)).toEqual(['mem-1', 'mem-2', 'skl-1', 'note-1'])
        expect(items[0]).toMatchObject({ kind: 'memory', action: 'add', text: 'Prefers small PRs', origin: 'relay' })
        expect(items[1]).toMatchObject({ diff: { before: 'old line', after: 'new line' }, reviewTurnId: REVIEW })
        expect(items[2]).toMatchObject({ kind: 'skill', target: 'deploy-preview', diff: { before: 'step a', after: 'step b' } })
        expect(items[3]).toMatchObject({ kind: 'note', target: 'adhdev', detail: 'gotcha', text: 'Run check:file-sizes before merge' })
        expect(parseStagedList({ success: true, memory: [{ id: 'mem-u', createdAt: 'x', origin: 'relay', op: { action: 'add', target: 'user', content: 'x' } }] })![0].kind).toBe('user')
    })

    it('returns null for a refusal / unknown verb so the surface hides', () => {
        expect(parseStagedList({ success: false, code: 'unknown_command' })).toBeNull()
        expect(parseStagedList(null)).toBeNull()
        expect(parseStagedList({ success: true })).toBeNull()
    })

    it('groups one review turn into one card and leaves other writes alone', () => {
        const groups = groupStagedItems(parseStagedList(listAnswer())!)
        expect(groups).toHaveLength(2)
        expect(groups[0].reviewTurnId).toBeUndefined()
        expect(groups[1]).toMatchObject({ reviewTurnId: REVIEW, reviewAt: 1759900000000 })
        expect(groups[1].items.map(i => i.id)).toEqual(['mem-2', 'skl-1', 'note-1'])
    })

    it('reads a partial batch per item and a single refusal for its id', () => {
        const batch = parseResolveOutcomes({
            success: false, code: 'staged_batch_partial', result: 'staged_batch_partial', reviewTurnId: REVIEW, resolved: 2, failed: 1,
            results: [
                { id: 'mem-2', success: false, code: 'memory_budget_exceeded', result: 'memory_budget_exceeded' },
                { id: 'skl-1', success: true, result: 'applied' },
                { id: 'note-1', success: true, result: 'applied' },
            ],
        }, ['mem-2', 'skl-1', 'note-1'])
        expect(batch).toEqual({ 'mem-2': { ok: false, code: 'memory_budget_exceeded' }, 'skl-1': { ok: true }, 'note-1': { ok: true } })
        expect(parseResolveOutcomes({ success: true, result: { success: false, code: 'skill_exists', result: 'skill_exists' } }, ['skl-9']))
            .toEqual({ 'skl-9': { ok: false, code: 'skill_exists' } })
        expect(parseResolveOutcomes({ success: true, result: 'discarded' }, ['mem-1'])).toEqual({ 'mem-1': { ok: true } })
    })
})

type Payload = Record<string, unknown> | undefined
type Send = (daemonId: string, type: string, payload?: Payload) => Promise<unknown>

describe('AssistantStagedWrites', () => {
    let container: HTMLDivElement
    let root: Root

    beforeEach(() => {
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
    })

    afterEach(() => {
        act(() => root.unmount())
        container.remove()
    })

    async function mount(send: Send, status = 'idle') {
        await act(async () => {
            root.render(<AssistantStagedWrites daemonId="daemon-1" status={status} sendCommand={send} />)
        })
    }

    async function click(el: Element | null) {
        expect(el).toBeTruthy()
        await act(async () => {
            (el as HTMLElement).click()
        })
    }

    it('renders nothing while nothing is held', async () => {
        const send = vi.fn(async () => ({ success: true, memory: [], skills: [], notes: [] }))
        await mount(send)
        expect(send).toHaveBeenCalledWith('daemon-1', 'assistant_staged_resolve', { action: 'list' })
        expect(container.innerHTML).toBe('')
    })

    it('renders nothing when the daemon has no list verb', async () => {
        await mount(vi.fn(async () => { throw new Error('Unknown command') }))
        expect(container.innerHTML).toBe('')
    })

    it('shows a pending badge that opens the grouped list', async () => {
        const send = vi.fn(async () => listAnswer())
        await mount(send)
        const badge = container.querySelector('.assistant-staged-badge')
        expect(badge?.textContent).toContain('4 pending')
        expect(container.querySelector('[role="dialog"]')).toBeNull()
        await click(badge)
        const dialog = container.querySelector('[role="dialog"]')!
        expect(dialog.textContent).toContain('Held for your approval')
        expect(dialog.querySelectorAll('[data-staged-item]')).toHaveLength(4)
        // One card for the review turn, with batch buttons; the relay write alone.
        const review = dialog.querySelector(`[data-staged-group="${REVIEW}"]`)!
        expect(review.querySelectorAll('[data-staged-item]')).toHaveLength(3)
        expect(review.querySelector('[data-staged-action="apply-all"]')).toBeTruthy()
        expect(dialog.querySelector('[data-staged-item="mem-1"]')!.textContent).toContain('Prefers small PRs')
        expect(dialog.querySelector('[data-staged-item="mem-1"]')!.textContent).toContain('From a relay')
        expect(dialog.querySelector('[data-staged-item="mem-2"]')!.textContent).toContain('- old line')
        expect(dialog.querySelector('[data-staged-item="mem-2"]')!.textContent).toContain('+ new line')
        expect(dialog.querySelector('[data-staged-item="skl-1"]')!.textContent).toContain('deploy-preview')
        expect(dialog.querySelector('[data-staged-item="note-1"]')!.textContent).toContain('adhdev')
    })

    it('approves and rejects one write by id, then refreshes', async () => {
        let answer: unknown = listAnswer()
        const send = vi.fn(async (_d: string, _t: string, payload?: Payload) => {
            if (payload?.action === 'list') return answer
            return { success: true, result: payload?.decision === 'apply' ? 'applied' : 'discarded' }
        })
        await mount(send)
        await click(container.querySelector('.assistant-staged-badge'))
        answer = { ...listAnswer(), memory: listAnswer().memory.slice(1) }
        await click(container.querySelector('[data-staged-item="mem-1"] [data-staged-action="apply"]'))
        expect(send).toHaveBeenCalledWith('daemon-1', 'assistant_staged_resolve', { id: 'mem-1', decision: 'apply' })
        expect(container.querySelector('[data-staged-item="mem-1"]')).toBeNull()
        await click(container.querySelector('[data-staged-item="note-1"] [data-staged-action="discard"]'))
        expect(send).toHaveBeenCalledWith('daemon-1', 'assistant_staged_resolve', { id: 'note-1', decision: 'discard' })
    })

    it('resolves a review turn together and shows the write that failed its re-check', async () => {
        let answer: unknown = listAnswer()
        const send = vi.fn(async (_d: string, _t: string, payload?: Payload) => {
            if (payload?.action === 'list') return answer
            answer = { success: true, memory: [listAnswer().memory[0], listAnswer().memory[1]], skills: [], notes: [] }
            return {
                success: false, code: 'staged_batch_partial', result: 'staged_batch_partial', reviewTurnId: REVIEW, resolved: 2, failed: 1,
                results: [
                    { id: 'mem-2', success: false, code: 'memory_budget_exceeded', result: 'memory_budget_exceeded' },
                    { id: 'skl-1', success: true, result: 'applied' },
                    { id: 'note-1', success: true, result: 'applied' },
                ],
            }
        })
        await mount(send)
        await click(container.querySelector('.assistant-staged-badge'))
        await click(container.querySelector('[data-staged-action="apply-all"]'))
        expect(send).toHaveBeenCalledWith('daemon-1', 'assistant_staged_resolve', { reviewTurnId: REVIEW, decision: 'apply' })
        const failed = container.querySelector('[data-staged-item="mem-2"] [data-staged-error]')
        expect(failed?.getAttribute('data-staged-error')).toBe('memory_budget_exceeded')
        expect(failed?.textContent).toContain('memory_budget_exceeded')
        expect(container.querySelector('[data-staged-item="skl-1"]')).toBeNull()
        expect(container.querySelector('.assistant-staged-badge')?.textContent).toContain('2 pending')
    })

    it('refreshes when the assistant turn commits (busy → idle), not on every render', async () => {
        const send = vi.fn(async () => listAnswer())
        await mount(send, 'generating')
        expect(send).toHaveBeenCalledTimes(1)
        await mount(send, 'generating')
        expect(send).toHaveBeenCalledTimes(1)
        await mount(send, 'idle')
        expect(send).toHaveBeenCalledTimes(2)
    })
})
