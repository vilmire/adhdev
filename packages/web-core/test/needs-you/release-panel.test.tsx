// @vitest-environment jsdom
/**
 * Releases card + mission release badge (design 2026-11-01-release-objects §7): the stepper, member missions with
 * git/live-check facts, explicit suggestions (never auto-added), the verified button staying a human click, the
 * CHANGELOG draft, the move menu on a mission badge, and silence on a daemon without the command.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ReleasesPanel from '../../src/components/MeshGraph/ReleasesPanel'
import ReleaseBadge from '../../src/components/MeshGraph/ReleaseBadge'
import { ReleasesProvider, useReleases } from '../../src/components/MeshGraph/useReleases'
import { draftToMarkdown, parseReleaseDetail, parseReleaseList } from '../../src/components/MeshGraph/releases-model'
import { getMeshGraphTheme } from '../../src/components/MeshGraph/meshGraphTheme'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const rel = (over: Record<string, unknown> = {}) => ({ id: 'rel_a', name: '1.0.82-rc.34', channel: 'preview', status: 'deployed', headCommit: 'abcdef0123456789', version: '1.0.82-rc.34', missionCount: 1, targets: { npm: { commit: 'abcdef0123456789', deployedAt: '2026-11-01T01:00:00.000Z' } }, ...over })
const LIST = { result: { success: true, releases: [rel(), rel({ id: 'rel_b', name: '1.0.82-rc.35', status: 'planned', missionCount: 0, headCommit: undefined, targets: undefined })], membership: { m1: { releaseId: 'rel_a', name: '1.0.82-rc.34' } } } }
const DETAIL = {
    result: {
        success: true, release: rel(),
        missions: [{ missionId: 'm1', title: 'Release badge', outcome: 'merged', releaseNote: 'Added a release badge.', openLiveChecks: 1, machines: ['mac'], gitState: 'landed' }],
        verified: { suggested: false, openLiveChecks: 1 },
        suggestedMissions: [{ missionId: 'm9', title: 'Landed but unassigned', reason: 'git_landed' }],
    },
}
const DRAFT = { result: { success: true, release: { ...rel(), changelog: { generatedAt: 'x', entries: [{ missionId: 'm1', section: 'Added', text: 'Added a release badge.', marker: '<!-- m:m1 -->', source: 'release_note' }], needsNote: [], excluded: [], warnings: [{ missionId: 'm1', gitState: 'unknown' }] } }, missions: DETAIL.result.missions, verified: DETAIL.result.verified, suggestedMissions: [] } }

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

function Harness({ send }: { send: (d: string, c: string, a?: Record<string, unknown>) => Promise<unknown> }) {
    const api = useReleases({ daemonId: 'd1', meshId: 'mesh1', send: send as any })
    return <ReleasesProvider value={api}><ReleasesPanel meshTheme={getMeshGraphTheme('dark' as any)} /><ReleaseBadge missionId="m1" /></ReleasesProvider>
}
async function mount(send: (d: string, c: string, a?: Record<string, unknown>) => Promise<unknown>) {
    await act(async () => { root.render(<Harness send={send} />) })
}
const q = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const all = (id: string) => [...document.body.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[]
const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click() }) }

function server(extra: Record<string, (args: any) => unknown> = {}) {
    return vi.fn(async (_d: string, command: string, args: any = {}) => {
        if (extra[command]) return extra[command](args)
        if (command === 'release_list') return args.releaseId ? DETAIL : LIST
        if (command === 'release_scope' || command === 'release_upsert') return { result: { success: true } }
        if (command === 'release_changelog_draft') return { result: { success: true } }
        return { result: { success: false } }
    })
}

describe('parsers', () => {
    it('drop unusable rows and bad enums; an old daemon answer yields null', () => {
        expect(parseReleaseList({ result: { success: false } })).toBeNull()
        expect(parseReleaseList({ result: { success: true, releases: [rel({ channel: 'beta' }), rel(), { nope: 1 }], membership: { m1: { releaseId: 'rel_a', name: 'n' }, bad: 3 } } })?.releases).toHaveLength(1)
        expect(parseReleaseDetail(DETAIL)?.suggestedMissions[0]).toEqual({ missionId: 'm9', title: 'Landed but unassigned' })
        expect(draftToMarkdown(parseReleaseDetail(DRAFT)!.draft!)).toBe('### Added\n- Added a release badge. <!-- m:m1 -->')
    })
})

describe('releases card', () => {
    it('lists releases, expands one into stepper / facts / members / suggestions, and shows the mission badge', async () => {
        const send = server()
        await mount(send)
        expect(send).toHaveBeenCalledWith('d1', 'release_list', { meshId: 'mesh1' })
        expect(all('release-row')).toHaveLength(2)
        expect(q('mission-release-badge')?.textContent).toBe('1.0.82-rc.34')
        await click(all('release-row')[0])
        expect(send).toHaveBeenCalledWith('d1', 'release_list', { meshId: 'mesh1', releaseId: 'rel_a', include: ['git', 'changelog'] })
        const steps = all('release-stepper')[0].querySelectorAll('[data-step]')
        expect([...steps].map(s => `${s.getAttribute('data-step')}:${s.getAttribute('data-done')}`)).toEqual(['planned:true', 'frozen:true', 'deployed:true', 'verified:false'])
        expect(q('release-detail')?.textContent).toContain('abcdef0123')
        expect(all('release-mission')[0].textContent).toContain('Landed')
        expect(all('release-mission')[0].textContent).toContain('mac')
        expect(q('release-verify-hint')?.textContent).toContain('1 live check')
        expect(all('release-suggestion')[0].textContent).toContain('Landed but unassigned')
    })

    it('a suggestion is added only by its own button; verified is only set by a click', async () => {
        const send = server()
        await mount(send)
        await click(all('release-row')[0])
        expect(send.mock.calls.some(c => c[1] === 'release_scope')).toBe(false)
        await click(q('release-suggestion-add'))
        expect(send).toHaveBeenCalledWith('d1', 'release_scope', { meshId: 'mesh1', releaseId: 'rel_a', add: ['m9'] })
        expect(send.mock.calls.some(c => c[1] === 'release_upsert')).toBe(false)
        await click(q('release-verify'))
        expect(send).toHaveBeenCalledWith('d1', 'release_upsert', { meshId: 'mesh1', releaseId: 'rel_a', status: 'verified' })
    })

    it('moves a mission from the badge and from the member row; removes with the remove button', async () => {
        const send = server()
        await mount(send)
        await click(q('mission-release-badge'))
        const sel = q('mission-release-move') as HTMLSelectElement
        await act(async () => { sel.value = 'rel_b'; sel.dispatchEvent(new Event('change', { bubbles: true })) })
        expect(send).toHaveBeenCalledWith('d1', 'release_scope', { meshId: 'mesh1', releaseId: 'rel_a', move: [{ missionId: 'm1', toReleaseId: 'rel_b' }] })
        await click(all('release-row')[0])
        await click(q('release-mission-remove'))
        expect(send).toHaveBeenCalledWith('d1', 'release_scope', { meshId: 'mesh1', releaseId: 'rel_a', remove: ['m1'] })
    })

    it('generates and shows the CHANGELOG draft with warnings, and creates a release', async () => {
        const send = server({ release_list: (a) => (a.releaseId ? (send.mock.calls.some(c => c[1] === 'release_changelog_draft') ? DRAFT : DETAIL) : LIST) })
        await mount(send)
        await click(all('release-row')[0])
        await click(q('release-draft-generate'))
        expect(send).toHaveBeenCalledWith('d1', 'release_changelog_draft', { meshId: 'mesh1', releaseId: 'rel_a' })
        expect(q('release-draft-text')?.textContent).toBe('### Added\n- Added a release badge. <!-- m:m1 -->')
        expect(q('release-draft-warnings')?.textContent).toContain('Release badge')
        const name = q('release-new-name') as HTMLInputElement
        await act(async () => {
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
            set.call(name, 'rc.36'); name.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await act(async () => { q('release-new')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
        expect(send).toHaveBeenCalledWith('d1', 'release_upsert', { meshId: 'mesh1', name: 'rc.36', channel: 'preview' })
    })

    it('renders nothing on a daemon without release support and surfaces a refusal', async () => {
        await mount(vi.fn(async () => { throw new Error('unknown command') }))
        expect(q('release-list')).toBeNull()
        expect(q('mission-release-badge')).toBeNull()
        act(() => root.unmount()); root = createRoot(host)
        const send = server({ release_scope: () => ({ result: { success: false, code: 'release_not_allowed', error: 'worker credentials cannot change release state' } }) })
        await mount(send)
        await click(all('release-row')[0])
        await click(q('release-mission-remove'))
        expect(q('release-error')?.textContent).toContain('worker credentials')
    })
})
