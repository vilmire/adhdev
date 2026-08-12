import { describe, expect, it } from 'vitest'

import {
    BACKOFF_SLOW_INTERVAL_MS,
    BACKOFF_STABLE_TICKS_THRESHOLD,
    createGraphPollBackoffState,
    recordGraphSnapshot,
    resetGraphPollBackoff,
    resolvePollIntervalMs,
} from '../../src/pages/repo-mesh/graph-poll-backoff'

const FAST_MS = 7000

function nodeSnapshot(overrides: Partial<any> = {}) {
    return {
        meshId: 'mesh_1',
        meshName: 'ADHDev',
        repoIdentity: 'github.com/acme/adhdev',
        refreshedAt: '2026-01-01T00:00:00Z',
        nodes: [
            {
                nodeId: 'node_1',
                machineLabel: 'M1',
                workspace: '/repo',
                health: 'online',
                providers: [],
                activeSessions: [],
                git: { branch: 'main', headCommit: 'abc123', dirty: false, ahead: 0, behind: 0, hasConflicts: false },
                ...overrides,
            },
        ],
    } as any
}

describe('RepoMesh graph poll backoff', () => {
    it('stays at the fast interval until enough consecutive unchanged ticks accumulate', () => {
        const state = createGraphPollBackoffState()
        const snap = nodeSnapshot()

        // First observation seeds the fingerprint; nothing to compare yet.
        expect(recordGraphSnapshot(state, snap)).toBe(false)
        expect(resolvePollIntervalMs(state, FAST_MS)).toBe(FAST_MS)

        // Feed identical snapshots up to just below the threshold.
        for (let i = 0; i < BACKOFF_STABLE_TICKS_THRESHOLD - 1; i++) {
            recordGraphSnapshot(state, nodeSnapshot())
        }
        expect(resolvePollIntervalMs(state, FAST_MS)).toBe(FAST_MS)
    })

    it('backs off to the slow interval once the graph has been stable for the threshold', () => {
        const state = createGraphPollBackoffState()
        recordGraphSnapshot(state, nodeSnapshot())
        for (let i = 0; i < BACKOFF_STABLE_TICKS_THRESHOLD; i++) {
            recordGraphSnapshot(state, nodeSnapshot())
        }
        expect(resolvePollIntervalMs(state, FAST_MS)).toBe(BACKOFF_SLOW_INTERVAL_MS)
    })

    it('snaps back to fast the instant a meaningful change is observed after backing off', () => {
        const state = createGraphPollBackoffState()
        recordGraphSnapshot(state, nodeSnapshot())
        for (let i = 0; i < BACKOFF_STABLE_TICKS_THRESHOLD; i++) {
            recordGraphSnapshot(state, nodeSnapshot())
        }
        expect(resolvePollIntervalMs(state, FAST_MS)).toBe(BACKOFF_SLOW_INTERVAL_MS)

        // Branch changed — a genuinely different snapshot.
        const changed = recordGraphSnapshot(state, nodeSnapshot({ git: { branch: 'feature/x', headCommit: 'def456', dirty: false, ahead: 1, behind: 0, hasConflicts: false } }))
        expect(changed).toBe(false)
        expect(resolvePollIntervalMs(state, FAST_MS)).toBe(FAST_MS)
    })

    it('ignores refreshedAt-only changes so a timestamp bump alone never blocks backoff', () => {
        const state = createGraphPollBackoffState()
        recordGraphSnapshot(state, nodeSnapshot())
        for (let i = 0; i < BACKOFF_STABLE_TICKS_THRESHOLD; i++) {
            // Only refreshedAt differs each tick — no real state change.
            recordGraphSnapshot(state, { ...nodeSnapshot(), refreshedAt: `2026-01-01T00:0${i}:00Z` })
        }
        expect(resolvePollIntervalMs(state, FAST_MS)).toBe(BACKOFF_SLOW_INTERVAL_MS)
    })

    it('detects dirty/ahead-behind/session changes even when branch and health are unchanged', () => {
        const state = createGraphPollBackoffState()
        recordGraphSnapshot(state, nodeSnapshot())
        for (let i = 0; i < BACKOFF_STABLE_TICKS_THRESHOLD; i++) {
            recordGraphSnapshot(state, nodeSnapshot())
        }
        expect(resolvePollIntervalMs(state, FAST_MS)).toBe(BACKOFF_SLOW_INTERVAL_MS)

        const dirtied = recordGraphSnapshot(state, nodeSnapshot({ git: { branch: 'main', headCommit: 'abc123', dirty: true, ahead: 0, behind: 0, hasConflicts: false } }))
        expect(dirtied).toBe(false)
        expect(resolvePollIntervalMs(state, FAST_MS)).toBe(FAST_MS)
    })

    it('resetGraphPollBackoff forces the next resolve back to fast regardless of prior stability', () => {
        const state = createGraphPollBackoffState()
        recordGraphSnapshot(state, nodeSnapshot())
        for (let i = 0; i < BACKOFF_STABLE_TICKS_THRESHOLD; i++) {
            recordGraphSnapshot(state, nodeSnapshot())
        }
        expect(resolvePollIntervalMs(state, FAST_MS)).toBe(BACKOFF_SLOW_INTERVAL_MS)

        resetGraphPollBackoff(state)
        expect(resolvePollIntervalMs(state, FAST_MS)).toBe(FAST_MS)
    })

    it('never returns an interval slower than the caller-supplied fast rate when not backed off', () => {
        const state = createGraphPollBackoffState()
        expect(resolvePollIntervalMs(state, FAST_MS)).toBe(FAST_MS)
    })

    it('when the fast rate already exceeds the slow floor (cloud push-fallback), backoff never speeds it up', () => {
        const state = createGraphPollBackoffState()
        const cloudFastMs = 45000 // GRAPH_PUSH_FALLBACK_INTERVAL_MS, already above BACKOFF_SLOW_INTERVAL_MS
        recordGraphSnapshot(state, nodeSnapshot())
        for (let i = 0; i < BACKOFF_STABLE_TICKS_THRESHOLD; i++) {
            recordGraphSnapshot(state, nodeSnapshot())
        }
        expect(resolvePollIntervalMs(state, cloudFastMs)).toBe(cloudFastMs)
    })
})
