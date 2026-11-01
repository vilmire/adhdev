// @vitest-environment jsdom
/**
 * Procedure skills in the dashboard (design 2026-11-01-procedure-skills.md §9):
 * the skills panel keeps "attached" (handed to a coordinator) apart from
 * "viewed" and never claims "applied"; the save-proposal card is one tap
 * (Save), edit-then-save, or "no, don't ask again".
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantSkillsPanel } from '../../src/components/settings/AssistantSkillsPanel'
import AssistantStagedWrites from '../../src/components/dashboard/AssistantStagedWrites'
import { ASSISTANT_SKILLS_LIST_COMMAND, parseSkillsList } from '../../src/components/dashboard/assistant-skills'
import { parseStagedList } from '../../src/components/dashboard/assistant-staged'
import { initI18n } from '../../src/i18n/config'

initI18n()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Send = (daemonId: string, type: string, payload?: Record<string, unknown>) => Promise<unknown>

const skillsAnswer = () => ({
    success: true,
    skills: [
        { name: 'seldom', description: 'Rarely used', status: 'stale', pinned: false, origin: 'agent', attachCount: 0, viewCount: 4, lastViewedAt: '2026-10-01T00:00:00.000Z', lastAttachedAt: null },
        { name: 'deploy-verify-checklist', description: 'Deploy then verify', status: 'active', pinned: true, origin: 'starter', attachCount: 7, viewCount: 2, lastViewedAt: '2026-10-02T00:00:00.000Z', lastAttachedAt: '2026-10-20T00:00:00.000Z' },
    ],
    metrics: { days: 14, sends: 20, attaches: 7, reuseRate: 0.35, proposalAcceptRate: null, hintHitRate: null },
})

describe('parseSkillsList', () => {
    it('orders by attach count, keeps attach and view apart, takes the later of attach / view as last use', () => {
        const list = parseSkillsList({ success: true, result: skillsAnswer() })!
        expect(list.skills.map(s => s.name)).toEqual(['deploy-verify-checklist', 'seldom'])
        expect(list.skills[0]).toMatchObject({ attachCount: 7, viewCount: 2, lastUsedAt: '2026-10-20T00:00:00.000Z', origin: 'starter', pinned: true })
        expect(list.skills[1]).toMatchObject({ attachCount: 0, viewCount: 4, lastUsedAt: '2026-10-01T00:00:00.000Z' })
        expect(list.summary).toMatchObject({ sends: 20, attaches: 7, reuseRate: 0.35 })
    })
    it('is null for a refusal or a daemon without the verb', () => {
        expect(parseSkillsList({ success: false, code: 'unknown_command' })).toBeNull()
        expect(parseSkillsList(null)).toBeNull()
    })
})

describe('AssistantSkillsPanel', () => {
    let container: HTMLDivElement
    let root: Root
    beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
    afterEach(() => { act(() => root.unmount()); container.remove() })

    it('shows attached and viewed as separate numbers, never says "applied", and pins through the owner admin verb', async () => {
        const send = vi.fn<Send>(async (_d, type) => (type === ASSISTANT_SKILLS_LIST_COMMAND ? skillsAnswer() : { success: true, result: 'applied' }))
        await act(async () => { root.render(<AssistantSkillsPanel daemonId="d1" sendCommand={send} />) })
        expect(send).toHaveBeenCalledWith('d1', ASSISTANT_SKILLS_LIST_COMMAND, {})
        const row = container.querySelector('[data-assistant-skill="deploy-verify-checklist"]')!
        expect(row.querySelector('[data-skill-attach-count]')!.textContent).toContain('7')
        expect(row.querySelector('[data-skill-view-count]')!.textContent).toContain('2')
        expect(row.querySelector('[data-skill-origin="starter"]')).toBeTruthy()
        expect(container.textContent!.toLowerCase()).not.toContain('applied')
        expect(container.querySelector('[data-assistant-skill="seldom"]')!.getAttribute('data-skill-status')).toBe('stale')
        await act(async () => { (row.querySelector('[data-skill-action="unpin"]') as HTMLElement).click() })
        expect(send).toHaveBeenCalledWith('d1', 'assistant_store_admin', { target: 'skill', action: 'unpin', name: 'deploy-verify-checklist' })
    })

    it('renders nothing for a daemon that cannot list skills', async () => {
        const send = vi.fn<Send>(async () => ({ success: false, code: 'unknown_command' }))
        await act(async () => { root.render(<AssistantSkillsPanel daemonId="d1" sendCommand={send} />) })
        expect(container.innerHTML).toBe('')
    })
})

const proposalAnswer = () => ({
    success: true, memory: [], notes: [],
    skills: [{
        kind: 'skill', id: 'skl-9', createdAt: '2026-10-30T00:00:00.000Z', origin: 'review', reason: 'proposed_procedure', proposalId: 'pc-1',
        op: { action: 'create', name: 'preview-flow', description: 'Deploy preview, verify, changelog', body: '1. deploy\n2. verify', proposalId: 'pc-1' },
    }],
    skillProposals: [{ stagedId: 'skl-9', candidateId: 'pc-1', signalCount: 4, distinctDays: 3, spanDays: 6, excerpt: 'Deploy the preview build then verify' }],
})

describe('proposed procedure card', () => {
    it('parses the proposal evidence onto its skill card', () => {
        const [item] = parseStagedList(proposalAnswer())!
        expect(item).toMatchObject({ kind: 'skill', reason: 'proposed_procedure', proposal: { signalCount: 4, spanDays: 6 }, skillDraft: { name: 'preview-flow', body: '1. deploy\n2. verify' } })
    })

    describe('in the pane', () => {
        let container: HTMLDivElement
        let root: Root
        beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
        afterEach(() => { act(() => root.unmount()); container.remove() })
        const open = async (send: Send) => {
            await act(async () => { root.render(<AssistantStagedWrites daemonId="d1" status="idle" sendCommand={send} />) })
            await act(async () => { (container.querySelector('.assistant-staged-badge') as HTMLElement).click() })
        }

        it('Save is one tap on the existing resolve verb; "No" discards', async () => {
            const send = vi.fn<Send>(async (_d, _t, p) => (p?.action === 'list' ? proposalAnswer() : { success: true, result: 'applied' }))
            await open(send)
            const card = container.querySelector('[data-staged-proposal]')!
            expect(card.textContent).toContain('preview-flow')
            expect(card.querySelector('[data-proposal-evidence]')!.textContent).toContain('4')
            await act(async () => { (card.querySelector('[data-staged-action="apply"]') as HTMLElement).click() })
            expect(send).toHaveBeenCalledWith('d1', 'assistant_staged_resolve', { id: 'skl-9', decision: 'apply' })
            await act(async () => { (container.querySelector('[data-staged-proposal] [data-staged-action="discard"]') as HTMLElement | null)?.click() })
            expect(send).toHaveBeenCalledWith('d1', 'assistant_staged_resolve', { id: 'skl-9', decision: 'discard' })
        })

        it('Edit then save sends the edited text as an owner skill create that retires the proposal', async () => {
            const send = vi.fn<Send>(async (_d, _t, p) => (p?.action === 'list' ? proposalAnswer() : { success: true, result: 'applied' }))
            await open(send)
            await act(async () => { (container.querySelector('[data-staged-action="edit"]') as HTMLElement).click() })
            const body = container.querySelector('[data-proposal-input="body"]') as HTMLTextAreaElement
            await act(async () => {
                const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
                set.call(body, '1. deploy\n2. verify\n3. announce')
                body.dispatchEvent(new Event('input', { bubbles: true }))
            })
            await act(async () => { (container.querySelector('[data-staged-action="save-edited"]') as HTMLElement).click() })
            expect(send).toHaveBeenCalledWith('d1', 'assistant_store_admin', {
                target: 'skill', action: 'create', stagedId: 'skl-9', name: 'preview-flow',
                description: 'Deploy preview, verify, changelog', body: '1. deploy\n2. verify\n3. announce',
            })
        })
    })
})
