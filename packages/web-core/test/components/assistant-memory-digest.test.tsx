// @vitest-environment jsdom
/**
 * Assistant "remembered recently" card (docs/design/2026-11-01-assistant-memory.md
 * §3.2): digest parsing, the count pill, per-write undo, one undo for an
 * archive move, failure display, and nothing rendered when there is nothing to
 * show or the daemon has no digest verb.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AssistantMemoryDigest from '../../src/components/dashboard/AssistantMemoryDigest'
import {
    groupDigestRows,
    mergePayload,
    parseMemoryDigest,
    parseMemoryUndoOutcome,
    standingMemoryChanges,
} from '../../src/components/dashboard/assistant-memory-digest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TS = '2026-11-01T09:00:00.000Z'
function digestAnswer(entries?: unknown[]) {
    return {
        success: true,
        result: 'ok',
        entries: entries ?? [
            { id: 'j3', ts: TS, tier: 'core', target: 'user', action: 'add', text: 'prefers small PRs', before: null, origin: 'decision_promotion', state: 'applied', undoable: true, promoted: true },
            { id: 'j2', ts: TS, tier: 'archive', target: 'memory', scope: 'archive', action: 'add', text: 'old legacy procedure', before: null, origin: 'human', batchId: 'b1', state: 'applied', undoable: true, promoted: false },
            { id: 'j1', ts: TS, tier: 'core', target: 'memory', action: 'remove', text: 'old legacy procedure', before: 'old legacy procedure', origin: 'human', batchId: 'b1', state: 'applied', undoable: true, promoted: false },
            { id: 'j0', ts: TS, tier: 'core', target: 'memory', action: 'add', text: 'staged by relay', before: null, origin: 'relay', state: 'staged', undoable: false, promoted: false },
        ],
        counts: entries && entries.length === 0
            ? { added: 0, replaced: 0, removed: 0, promoted: 0, staged: 0, reverted: 0 }
            : { added: 1, replaced: 0, removed: 1, promoted: 1, staged: 1, reverted: 0 },
        truncated: false,
    }
}

describe('assistant-memory-digest model', () => {
    it('parses entries and counts, also through the cloud wrapper, and drops unknown shapes', () => {
        const d = parseMemoryDigest({ success: true, result: digestAnswer() })!
        expect(d.entries.map(e => e.id)).toEqual(['j3', 'j2', 'j1', 'j0'])
        expect(d.entries[0]).toMatchObject({ promoted: true, origin: 'decision_promotion', undoable: true })
        expect(standingMemoryChanges(d)).toBe(3)
        expect(parseMemoryDigest(digestAnswer([{ id: '', state: 'applied', action: 'add' }, { id: 'x', state: 'weird', action: 'add' }, null]))!.entries).toEqual([])
        expect(parseMemoryDigest({ success: false })).toBeNull()
        expect(parseMemoryDigest('nope')).toBeNull()
    })

    it('collapses entries sharing a batch id into one row', () => {
        const rows = groupDigestRows(parseMemoryDigest(digestAnswer())!.entries)
        expect(rows.map(r => [r.batchId ?? null, r.entries.length])).toEqual([[null, 1], ['b1', 2], [null, 1]])
    })

    it('reads undo outcomes, including the wrapped and refused shapes', () => {
        expect(parseMemoryUndoOutcome({ success: true, result: 'applied' })).toEqual({ ok: true })
        expect(parseMemoryUndoOutcome({ success: true, result: { success: true, result: 'applied' } })).toEqual({ ok: true })
        expect(parseMemoryUndoOutcome({ success: false, code: 'memory_undo_conflict', result: 'memory_undo_conflict' })).toEqual({ ok: false, code: 'memory_undo_conflict' })
        expect(parseMemoryUndoOutcome(null)).toEqual({ ok: false, code: 'no_answer' })
    })
})

describe('suggestions (§3.9: the daemon only suggests; the owner decides)', () => {
    const withSuggestions = (entries?: unknown[]) => ({
        ...digestAnswer(entries),
        suggestions: [
            { kind: 'similar', target: 'memory', tier: 'core', items: ['run the full suite before merging to main', 'run the full suite before merging into main'], score: 0.86 },
            { kind: 'duplicate', target: 'user', tier: 'archive', scope: 'project', projectRef: 'm1', items: ['likes tabs', 'Likes tabs.'] },
            { kind: 'unused', target: 'memory', tier: 'archive', scope: 'archive', items: ['old note'], id: 'x1' },
            { kind: 'bogus', items: ['x'] },
            { kind: 'similar', items: [] },
        ],
    })

    it('parses suggestions and drops malformed ones', () => {
        const d = parseMemoryDigest(withSuggestions())!
        expect(d.suggestions.map(x => x.kind)).toEqual(['similar', 'duplicate', 'unused'])
        expect(d.suggestions[1]).toMatchObject({ scope: 'project', projectRef: 'm1', target: 'user' })
    })

    it('builds the merge payload (keep first, drop second) and none for an unused entry', () => {
        const [sim, dup, unused] = parseMemoryDigest(withSuggestions())!.suggestions
        expect(mergePayload(sim!)).toEqual({ target: 'memory', action: 'merge', file: 'memory', keep: sim!.items[0], drop: sim!.items[1] })
        expect(mergePayload(dup!)).toEqual({ target: 'memory', action: 'merge', file: 'user', keep: 'likes tabs', drop: 'Likes tabs.', scope: 'project', projectRef: 'm1' })
        expect(mergePayload(unused!)).toBeNull()
    })
})

describe('AssistantMemoryDigest', () => {
    let container: HTMLDivElement
    let root: Root
    type Send = (daemonId: string, type: string, payload?: any) => Promise<any>

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
        await act(async () => { root.render(<AssistantMemoryDigest daemonId="daemon-1" status={status} sendCommand={send} />) })
    }
    async function click(el: Element | null) {
        expect(el).toBeTruthy()
        await act(async () => { (el as HTMLElement).click() })
    }

    it('renders nothing when nothing stands, or the daemon has no digest verb', async () => {
        const send = vi.fn(async () => digestAnswer([]))
        await mount(send)
        expect(send).toHaveBeenCalledWith('daemon-1', 'assistant_memory_digest', {})
        expect(container.innerHTML).toBe('')
        await mount(vi.fn(async () => { throw new Error('Unknown command') }))
        expect(container.innerHTML).toBe('')
    })

    it('shows a count-only pill; the text appears only inside the opened panel', async () => {
        await mount(vi.fn(async () => digestAnswer()))
        const badge = container.querySelector('.assistant-memory-digest-badge')!
        expect(badge.textContent).toBe('Remembered 3')
        expect(container.textContent).not.toContain('prefers small PRs')
        await click(badge)
        const dialog = container.querySelector('[role="dialog"]')!
        expect(dialog.textContent).toContain('prefers small PRs')
        expect(dialog.querySelector('[data-memory-digest-item="j3"] [data-memory-digest-promoted]')).toBeTruthy()
        expect(dialog.querySelector('[data-memory-digest-item="j0"]')!.textContent).toContain('waiting for approval')
        expect(dialog.querySelector('[data-memory-digest-item="j0"] [data-memory-digest-action="undo"]')).toBeNull()
        // the archive move is one row
        expect(dialog.querySelectorAll('[data-memory-digest-item]')).toHaveLength(3)
    })

    it('undoes one write by id and one move by batch id, then refreshes', async () => {
        let answer: unknown = digestAnswer()
        const send = vi.fn(async (_d: string, type: string, payload?: any) => {
            if (type === 'assistant_memory_digest') return answer
            answer = digestAnswer(digestAnswer().entries.slice(1))
            return { success: true, result: 'applied' }
        })
        await mount(send)
        await click(container.querySelector('.assistant-memory-digest-badge'))
        await click(container.querySelector('[data-memory-digest-item="j3"] [data-memory-digest-action="undo"]'))
        expect(send).toHaveBeenCalledWith('daemon-1', 'assistant_memory_undo', { id: 'j3' })
        expect(container.querySelector('[data-memory-digest-item="j3"]')).toBeNull()
        await click(container.querySelector('[data-memory-digest-item="j2"] [data-memory-digest-action="undo"]'))
        expect(send).toHaveBeenCalledWith('daemon-1', 'assistant_memory_undo', { batchId: 'b1' })
    })

    it('shows the daemon refusal under the row and keeps it', async () => {
        const send = vi.fn(async (_d: string, type: string) => {
            if (type === 'assistant_memory_digest') return digestAnswer()
            return { success: false, code: 'memory_undo_conflict', result: 'memory_undo_conflict' }
        })
        await mount(send)
        await click(container.querySelector('.assistant-memory-digest-badge'))
        await click(container.querySelector('[data-memory-digest-item="j3"] [data-memory-digest-action="undo"]'))
        const err = container.querySelector('[data-memory-digest-item="j3"] [data-memory-digest-error]')
        expect(err?.getAttribute('data-memory-digest-error')).toBe('memory_undo_conflict')
    })

    it('lists suggestions in the panel even when nothing new was remembered, and merges one on request', async () => {
        const send = vi.fn(async (_d: string, type: string) => {
            if (type === 'assistant_memory_digest') {
                return { ...digestAnswer([]), suggestions: [{ kind: 'similar', target: 'memory', tier: 'core', items: ['alpha beta gamma', 'alpha beta gamma delta'], score: 0.8 }] }
            }
            return { success: true, result: 'applied' }
        })
        await mount(send)
        await click(container.querySelector('.assistant-memory-digest-badge'))
        const row = container.querySelector('[data-memory-digest-suggestion="similar"]')!
        expect(row.textContent).toContain('Very similar notes')
        await click(row.querySelector('[data-memory-digest-action="merge"]'))
        expect(send).toHaveBeenCalledWith('daemon-1', 'assistant_store_admin', { target: 'memory', action: 'merge', file: 'memory', keep: 'alpha beta gamma', drop: 'alpha beta gamma delta' })
    })

    it('refreshes when the assistant turn commits (busy to idle) without polling', async () => {
        const send = vi.fn(async () => digestAnswer())
        await mount(send, 'generating')
        const first = send.mock.calls.length
        await mount(send, 'idle')
        expect(send.mock.calls.length).toBe(first + 1)
    })
})
