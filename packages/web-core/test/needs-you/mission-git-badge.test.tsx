// @vitest-environment jsdom
/**
 * Mission git badge on the Overview mission line (design 2026-11-01-mission-git-refs §6): four labelled
 * states, a popover with per-ref status / base SHA / evaluation time / re-check, the "landed is not done"
 * note, the unknown reason, and silence when the daemon is old or has nothing to say.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NeedsYouStateProvider, type NeedsYouState } from '../../src/context/NeedsYouContext'
import { TransportProvider } from '../../src/context/TransportContext'
import { EMPTY_NEEDS_YOU_SNAPSHOT, buildNeedsYouEntries, needsYouCount } from '../../src/components/needs-you/needs-you-model'
import MissionStructureLine from '../../src/components/MeshGraph/MissionStructureLine'
import { parseMissionGit } from '../../src/components/MeshGraph/MissionGitBadge'
import { getMeshGraphTheme } from '../../src/components/MeshGraph/meshGraphTheme'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state: NeedsYouState = (() => {
    const snapshot = {
        ...EMPTY_NEEDS_YOU_SNAPSHOT,
        missions: [{ daemonId: 'd1', meshId: 'm1', missionId: 'ms1', summary: 'Work', openItems: { remaining: 0, live_check: 0, decision: 0, evidence: 0 } }],
    }
    const entries = buildNeedsYouEntries(snapshot, [])
    return { snapshot, approvals: [], entries, count: needsYouCount(entries), loaded: true, outcomes: {}, busyIds: new Set(), refresh: async () => {}, answer: async () => ({ ok: true as const }) } as NeedsYouState
})()

const answer = (gitState: Record<string, unknown>) => ({ result: { success: true, gitState } })
const landed = answer({
    state: 'landed', baseRef: 'origin/main', baseSha: 'abcdef0123456789', evaluatedAt: '2026-11-01T00:00:00.000Z', stale: false,
    refs: [{ refKey: 'commit::0123456789abcdef', status: 'contained_patch_equivalent', method: 'cherry', evaluatedAt: '2026-11-01T00:00:00.000Z' }],
})

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

async function mount(sendCommand: (d: string, c: string, a?: Record<string, unknown>) => Promise<unknown>, status = 'active') {
    // A fresh tree per call: the hook refetches on mount, not on re-render.
    act(() => root.unmount())
    root = createRoot(host)
    await act(async () => {
        root.render(
            <MemoryRouter><TransportProvider value={{ sendCommand: sendCommand as any }}><NeedsYouStateProvider value={state}>
                <MissionStructureLine meshTheme={getMeshGraphTheme('dark' as any)} mission={{ id: 'ms1', meshId: 'm1', status }} />
            </NeedsYouStateProvider></TransportProvider></MemoryRouter>,
        )
    })
}
const badge = () => document.body.querySelector('[data-testid="mission-git-badge"]') as HTMLButtonElement | null

describe('mission git badge', () => {
    it('asks the hosting daemon and shows a labelled landed badge; the popover lists refs, base, and says landed is not done', async () => {
        const send = vi.fn(async () => landed)
        await mount(send)
        expect(send).toHaveBeenCalledWith('d1', 'mesh_mission_git_eval', expect.objectContaining({ meshId: 'm1', missionId: 'ms1' }))
        expect(badge()?.textContent).toBe('Landed')
        expect(badge()?.getAttribute('data-git-state')).toBe('landed');
        expect(document.body.querySelector('[data-testid="mission-git-panel"]')).toBeNull()
        await act(async () => { badge()!.click() })
        const panel = document.body.querySelector('[data-testid="mission-git-panel"]')!
        expect(panel.textContent).toContain('Compared with origin/main @ abcdef0123')
        expect(panel.textContent).toContain('Landed under another commit')
        expect(panel.textContent).toContain('does not mean the work is accepted or done')
    })

    it('shows partly landed / not landed / unknown with their own labels and explains unknown reasons', async () => {
        const cases: Array<[Record<string, unknown>, string]> = [
            [{ state: 'partial', partialUnknown: true, refs: [{ refKey: 'commit::aaaaaaaaaaaa', status: 'unknown', unknownReason: 'node_offline' }] }, 'Partly landed ?'],
            [{ state: 'not_landed', refs: [{ refKey: 'branch::feat', status: 'not_contained', note: 'modified_since_landing_possible' }] }, 'Not landed'],
            [{ state: 'unknown', refs: [{ refKey: 'commit::bbbbbbbbbbbb', status: 'unknown', unknownReason: 'shallow' }] }, 'Git unknown'],
        ]
        for (const [gitState, label] of cases) {
            await mount(async () => answer(gitState))
            expect(badge()?.textContent).toBe(label)
            await act(async () => { badge()!.click() })
            const text = document.body.querySelector('[data-testid="mission-git-panel"]')!.textContent!
            if (gitState.state === 'unknown') expect(text).toContain('does not mean "not landed"')
            if (gitState.state === 'partial') expect(text).toContain('Machine offline')
            if (gitState.state === 'not_landed') expect(text).toContain('may have changed these lines')
        }
    })

    it('re-check forces a refresh on the daemon; closed missions only read the cache', async () => {
        const send = vi.fn(async () => landed)
        await mount(send)
        await act(async () => { badge()!.click() })
        await act(async () => { (document.body.querySelector('[data-testid="mission-git-refresh"]') as HTMLButtonElement).click() })
        expect(send).toHaveBeenLastCalledWith('d1', 'mesh_mission_git_eval', expect.objectContaining({ refresh: true }))

        const closed = vi.fn(async () => landed)
        await mount(closed, 'completed')
        expect(closed).toHaveBeenCalledWith('d1', 'mesh_mission_git_eval', expect.objectContaining({ cachedOnly: true }))
    })

    it('stays silent for an old daemon, no refs, or never-evaluated (empty) answers', async () => {
        await mount(async () => { throw new Error('unknown command') })
        expect(badge()).toBeNull()
        await mount(async () => answer({ state: 'no_refs', refs: [] }))
        expect(badge()).toBeNull()
        await mount(async () => answer({ state: 'unknown', refs: [] }))
        expect(badge()).toBeNull()
    })

    it('parseMissionGit allow-lists the answer and drops unusable rows', () => {
        expect(parseMissionGit({ success: false })).toBeNull()
        expect(parseMissionGit(answer({ state: 'bogus', refs: [] }))).toBeNull()
        const v = parseMissionGit(answer({ state: 'partial', secret: 'x', refs: [{ refKey: 'commit::a', status: 'unknown', transcript: 'no' }, { refKey: 5, status: 'unknown' }, { refKey: 'commit::b', status: 'weird' }] }))!
        expect(v.refs).toEqual([{ refKey: 'commit::a', status: 'unknown' }])
        expect(JSON.stringify(v)).not.toContain('secret')
    })
})
