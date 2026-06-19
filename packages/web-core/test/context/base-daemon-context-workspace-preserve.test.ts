import { describe, expect, it } from 'vitest'
import { reconcileIdes } from '../../src/context/BaseDaemonContext'
import type { DaemonData } from '../../src/types'

/**
 * Regression tests for the mesh session-tab title flap bug.
 *
 * A mesh node's terminal session tab title flapped between the real workspace
 * name (e.g. 'adhdev') and the 'Terminal (Mesh Node)' fallback as the session
 * toggled active <-> idle. Root cause: reconcileIdes merged an idle snapshot
 * whose `workspace` was '' / undefined over a previously-good value, clobbering
 * it. Since workspace is immutable for a session's lifetime, an empty incoming
 * workspace means "unknown", not "cleared" — so it must never overwrite a
 * non-empty existing value (fill-if-empty), through either merge path.
 */

function sessionEntry(overrides: Partial<DaemonData> = {}): DaemonData {
    return {
        id: 'node-1:cli:term-1',
        daemonId: 'node-1',
        type: 'cli',
        timestamp: 1000,
        workspace: '/repo/adhdev',
        ...overrides,
    } as DaemonData
}

describe('reconcileIdes — workspace preservation (mesh title flap)', () => {
    it('rich merge path: keeps existing workspace when incoming workspace is empty string', () => {
        // existing is richer (has activeChat) — incoming idle snapshot drops workspace.
        const prev: DaemonData[] = [
            sessionEntry({
                workspace: '/repo/adhdev',
                activeChat: { messages: [], status: 'idle' } as DaemonData['activeChat'],
            }),
        ]
        // Make incoming MORE rich so it takes the buildMergedRichEntry path.
        const incoming: DaemonData[] = [
            sessionEntry({
                workspace: '',
                timestamp: 2000,
                activeChat: { messages: [], status: 'active' } as DaemonData['activeChat'],
                activeInteractivePrompt: { kind: 'text' } as DaemonData['activeInteractivePrompt'],
            }),
        ]

        const result = reconcileIdes(incoming, prev)
        const entry = result.find((e) => e.id === 'node-1:cli:term-1')
        expect(entry?.workspace).toBe('/repo/adhdev')
    })

    it('rich merge path: keeps existing workspace when incoming workspace is undefined', () => {
        const prev: DaemonData[] = [
            sessionEntry({
                workspace: '/repo/adhdev',
                activeChat: { messages: [], status: 'idle' } as DaemonData['activeChat'],
            }),
        ]
        const incoming: DaemonData[] = [
            sessionEntry({
                workspace: undefined,
                timestamp: 2000,
                activeChat: { messages: [], status: 'active' } as DaemonData['activeChat'],
                activeInteractivePrompt: { kind: 'text' } as DaemonData['activeInteractivePrompt'],
            }),
        ]

        const result = reconcileIdes(incoming, prev)
        const entry = result.find((e) => e.id === 'node-1:cli:term-1')
        expect(entry?.workspace).toBe('/repo/adhdev')
    })

    it('weak merge path: empty incoming workspace does not clobber existing', () => {
        // existing is richer (workspace gives it richness 1) so incoming (no workspace)
        // is weaker -> mergeWeakEntry path.
        const prev: DaemonData[] = [
            sessionEntry({ workspace: '/repo/adhdev', timestamp: 1000 }),
        ]
        const incoming: DaemonData[] = [
            sessionEntry({ workspace: '', timestamp: 2000, status: 'idle' }),
        ]

        const result = reconcileIdes(incoming, prev)
        const entry = result.find((e) => e.id === 'node-1:cli:term-1')
        expect(entry?.workspace).toBe('/repo/adhdev')
    })

    it('survives an active -> idle -> active snapshot sequence without losing workspace', () => {
        const active = (ts: number): DaemonData[] => [
            sessionEntry({
                workspace: '/repo/adhdev',
                timestamp: ts,
                activeChat: { messages: [], status: 'active' } as DaemonData['activeChat'],
                activeInteractivePrompt: { kind: 'text' } as DaemonData['activeInteractivePrompt'],
            }),
        ]
        const idle = (ts: number): DaemonData[] => [
            sessionEntry({ workspace: '', timestamp: ts, status: 'idle' }),
        ]

        let state = reconcileIdes(active(1000), [])
        expect(state[0].workspace).toBe('/repo/adhdev')

        state = reconcileIdes(idle(2000), state)
        expect(state.find((e) => e.id === 'node-1:cli:term-1')?.workspace).toBe('/repo/adhdev')

        state = reconcileIdes(active(3000), state)
        expect(state.find((e) => e.id === 'node-1:cli:term-1')?.workspace).toBe('/repo/adhdev')
    })

    it('still accepts a truthy incoming workspace (fill-if-empty, not freeze)', () => {
        // If a session legitimately has no existing workspace yet, a truthy
        // incoming value must be adopted.
        const prev: DaemonData[] = [
            sessionEntry({ workspace: '', timestamp: 1000 }),
        ]
        const incoming: DaemonData[] = [
            sessionEntry({
                workspace: '/repo/adhdev',
                timestamp: 2000,
                activeChat: { messages: [], status: 'active' } as DaemonData['activeChat'],
            }),
        ]

        const result = reconcileIdes(incoming, prev)
        const entry = result.find((e) => e.id === 'node-1:cli:term-1')
        expect(entry?.workspace).toBe('/repo/adhdev')
    })
})
