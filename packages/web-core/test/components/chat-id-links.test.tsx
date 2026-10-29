// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { splitTextByChatIds, type ChatIdResolver, type ChatIdTarget } from '../../src/components/ChatMessageList/chat-id-links'
import { ChatIdLinkContext, type ChatIdLinkApi } from '../../src/components/ChatMessageList/chat-id-link-context'
import { ChatMarkdownBody, RowBodyView } from '../../src/components/ChatMessageList/chat-row-content'
import { ChatIdLinkProvider, chatIdTargetHref } from '../../src/components/ChatMessageList/ChatIdLinkProvider'
import { TransportProvider } from '../../src/context/TransportContext'
import { NeedsYouStateProvider, type NeedsYouState } from '../../src/context/NeedsYouContext'
import { EMPTY_NEEDS_YOU_SNAPSHOT } from '../../src/components/needs-you/needs-you-model'
import { primeCoordinatorMeshStatus } from '../../src/utils/coordinator-mesh-status-store'
import { buildMeshDeepLink, parseMeshDeepLink } from '../../src/utils/mesh-deep-link'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = '11111111-2222-4333-8444-555555555555'
const UNKNOWN = '99999999-2222-4333-8444-555555555555'
const MISSION = 'aaaaaaaa-2222-4333-8444-555555555555'
const TASK = 'bbbbbbbb-2222-4333-8444-555555555555'
const ART = 'art_d979ee4b20049b8c'
const DEC = 'mi_0123456789ab'

const known: Record<string, ChatIdTarget> = {
    [SESSION]: { kind: 'session', id: SESSION },
    [ART]: { kind: 'artifact', id: ART },
    [DEC]: { kind: 'decision', id: DEC, meshId: 'mesh1' },
    [MISSION]: { kind: 'mission', id: MISSION, meshId: 'mesh1' },
    [TASK]: { kind: 'task', id: TASK, meshId: 'mesh1' },
}
const resolve: ChatIdResolver = id => known[id] ?? null

let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks() })
const render = (n: React.ReactNode) => act(async () => { root.render(n) })

function withApi(api: Partial<ChatIdLinkApi>, node: React.ReactNode) {
    const full: ChatIdLinkApi = { resolve, hrefOf: chatIdTargetHref, open: vi.fn(), ...api }
    return <ChatIdLinkContext.Provider value={full}>{node}</ChatIdLinkContext.Provider>
}
const md = (content: string) => <ChatMarkdownBody content={content} renderAsPreformatted={false} renderAsMarkdown />

describe('splitTextByChatIds', () => {
    it('links known ids only and keeps the surrounding text', () => {
        const pieces = splitTextByChatIds(`see ${SESSION} and ${UNKNOWN}.`, resolve)!
        expect(pieces.filter(p => typeof p !== 'string')).toHaveLength(1)
        expect(pieces.map(p => (typeof p === 'string' ? p : p.id)).join('')).toBe(`see ${SESSION} and ${UNKNOWN}.`)
    })
    it('returns null when nothing is known and ignores ids glued to other tokens', () => {
        expect(splitTextByChatIds(`only ${UNKNOWN}`, resolve)).toBeNull()
        expect(splitTextByChatIds(`x-${SESSION}`, resolve)).toBeNull()
        expect(splitTextByChatIds(`${SESSION}-2`, resolve)).toBeNull()
    })
})

describe('markdown rendering', () => {
    it('links known ids, never unknown UUIDs', async () => {
        await render(withApi({}, md(`session ${SESSION} unknown ${UNKNOWN} mission ${MISSION} task ${TASK} decision ${DEC}`)))
        const kinds = [...container.querySelectorAll('[data-chat-id-link]')].map(e => e.getAttribute('data-chat-id-link'))
        expect(kinds.sort()).toEqual(['decision', 'mission', 'session', 'task'])
        expect(container.textContent).toContain(UNKNOWN)
        expect(container.querySelectorAll('a')).toHaveLength(4)
    })
    it('does not link inside fenced code but links an inline code span that is exactly an id', async () => {
        await render(withApi({}, md(`\`\`\`\n${SESSION}\n\`\`\`\n\nuse \`${ART}\` and \`run ${SESSION}\``)))
        expect(container.querySelector('pre [data-chat-id-link]')).toBeNull()
        const art = container.querySelector('[data-chat-id-link="artifact"]')!
        expect(art.querySelector('code')?.textContent).toBe(ART)
        expect(container.querySelectorAll('[data-chat-id-link="session"]')).toHaveLength(0)
    })
    it('leaves text untouched without a provider and keeps normal links working', async () => {
        await render(md(`${SESSION} [site](https://example.com)`))
        expect(container.querySelector('[data-chat-id-link]')).toBeNull()
        expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
        expect(container.textContent).toContain(SESSION)
    })
    it('links plain (non-markdown) bubbles too', async () => {
        await render(withApi({}, <RowBodyView body={{ type: 'plain', text: `ref ${SESSION}` } as any} className="b" />))
        expect(container.querySelector('a[data-chat-id-link="session"]')).not.toBeNull()
    })
})

describe('click targets', () => {
    it('plain click calls open(target); a ctrl-click is left to the browser', async () => {
        const open = vi.fn()
        await render(withApi({ open }, md(`go ${SESSION}`)))
        const a = container.querySelector('a')!
        expect(a.getAttribute('href')).toBe(`/dashboard?activeTab=${SESSION}`)
        expect(a.getAttribute('title')).toBe(`Open session ${SESSION}`)
        document.addEventListener('click', e => e.preventDefault(), { once: true }) // jsdom cannot navigate
        await act(async () => { a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })) })
        expect(open).not.toHaveBeenCalled()
        await act(async () => { a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
        expect(open).toHaveBeenCalledWith(known[SESSION])
    })
    it('artifact: click opens, ctrl-click / middle / pop-out button open a new window', async () => {
        const open = vi.fn()
        await render(withApi({ open }, md(`see ${ART}`)))
        const [main, pop] = [...container.querySelectorAll('button')]
        await act(async () => { main.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
        expect(open).toHaveBeenLastCalledWith(known[ART], { newWindow: false })
        await act(async () => { main.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })) })
        expect(open).toHaveBeenLastCalledWith(known[ART], { newWindow: true })
        await act(async () => { main.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 })) })
        expect(open).toHaveBeenLastCalledWith(known[ART], { newWindow: true })
        await act(async () => { pop.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
        expect(open).toHaveBeenCalledTimes(4)
        expect(pop.getAttribute('aria-label')).toBe(`Open ${ART} in a new window`)
    })
    it('maps each kind to its route', () => {
        expect(chatIdTargetHref(known[DEC]!)).toBe('/needs-you?mesh=mesh1&decision=mi_0123456789ab')
        expect(chatIdTargetHref(known[MISSION]!)).toBe(`/mesh?mesh=mesh1&tab=overview&mission=${MISSION}`)
        expect(chatIdTargetHref(known[TASK]!)).toBe(`/mesh?mesh=mesh1&tab=tasks&task=${TASK}`)
        expect(chatIdTargetHref(known[ART]!)).toBeNull()
        expect(parseMeshDeepLink(buildMeshDeepLink({ meshId: 'm', tab: 'tasks', taskId: 't' }).slice(5))).toEqual({ meshId: 'm', tab: 'tasks', taskId: 't' })
    })
})

describe('ChatIdLinkProvider (real sources)', () => {
    const needsYou = {
        snapshot: {
            ...EMPTY_NEEDS_YOU_SNAPSHOT,
            decisions: [{ daemonId: 'd', meshId: 'meshX', missionId: 'm', missionTitle: 't', itemId: DEC, question: 'q', options: [], allowFreeText: false, urgency: 'normal', onDue: 'remind', source: 'coordinator', createdAt: '' }],
        },
    } as unknown as NeedsYouState

    function Where() { const l = useLocation(); return <i data-testid="where">{l.pathname}{l.search}</i> }

    it('resolves decisions / mesh missions / tasks / artifacts, rejects the rest, navigates on click', async () => {
        primeCoordinatorMeshStatus('meshY', { meshId: 'meshY', meshName: 'Y', nodes: [], missions: [{ id: MISSION }], queue: { tasks: [{ id: TASK }] } } as any, 'daemonY')
        const sendCommand = vi.fn(async () => ({ success: true, attachments: [], hasMore: false }))
        await render(
            <MemoryRouter initialEntries={['/dashboard']}>
                <TransportProvider value={{ sendCommand }}>
                    <NeedsYouStateProvider value={needsYou}>
                        <ChatIdLinkProvider daemonId="daemonY" sessionId="s1">
                            {md(`${DEC} ${MISSION} ${TASK} ${UNKNOWN} ${ART}`)}
                        </ChatIdLinkProvider>
                    </NeedsYouStateProvider>
                </TransportProvider>
                <Where />
            </MemoryRouter>,
        )
        const kinds = [...container.querySelectorAll('[data-chat-id-link]')].map(e => e.getAttribute('data-chat-id-link')).sort()
        expect(kinds).toEqual(['artifact', 'decision', 'mission', 'task'])
        const taskLink = container.querySelector('a[data-chat-id-link="task"]')!
        await act(async () => { taskLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
        expect(container.querySelector('[data-testid="where"]')?.textContent).toBe(`/mesh?mesh=meshY&tab=tasks&task=${TASK}`)
    })

    it('artifact click that finds nothing says so instead of opening a viewer', async () => {
        const sendCommand = vi.fn(async () => ({ success: true, attachments: [], hasMore: false }))
        await render(
            <MemoryRouter>
                <TransportProvider value={{ sendCommand }}>
                    <ChatIdLinkProvider daemonId="daemonZ" sessionId="s1">{md(`x ${ART}`)}</ChatIdLinkProvider>
                </TransportProvider>
            </MemoryRouter>,
        )
        await act(async () => { container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
        expect(sendCommand.mock.calls.some(c => (c as any[])[1] === 'artifact_list')).toBe(true)
        expect(document.querySelector('[data-testid="artifact-fullscreen-viewer"]')).toBeNull()
        expect(container.querySelector('[role="alert"]')?.textContent).toContain('was not found')
    })

    it('artifact click fetches and opens the fullscreen viewer', async () => {
        const attachment = { artifactId: ART, originSessionId: 'sessW', sha256: 'abc', kind: 'markdown', mime: 'text/markdown', filename: 'n.md', title: 'N', sizeBytes: 5 }
        const sendCommand = vi.fn(async (_d: string, type: string) => type === 'artifact_list'
            ? { success: true, attachments: [attachment], hasMore: false }
            : { success: true, artifactId: ART, sessionId: 'sessW', kind: 'markdown', mime: 'text/markdown', encoding: 'utf8', content: '# hi', sizeBytes: 4, sha256: 'abc', filename: 'n.md', title: 'N' })
        await render(
            <MemoryRouter>
                <TransportProvider value={{ sendCommand }}>
                    <ChatIdLinkProvider daemonId="daemonQ" sessionId="s2">{md(`x ${ART}`)}</ChatIdLinkProvider>
                </TransportProvider>
            </MemoryRouter>,
        )
        await act(async () => { container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
        expect(document.querySelector('[data-testid="artifact-fullscreen-viewer"]')).not.toBeNull()
    })
})
