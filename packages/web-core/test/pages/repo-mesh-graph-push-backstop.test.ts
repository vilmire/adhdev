/**
 * P-II item 4 — RepoMesh.tsx cloud mesh-graph poll (45s → 30s floor) is demoted to
 * a WARN-only 5-minute backstop gated on features.meshStatePushRefresh, driven by
 * useMeshStateRevisionRefresh's onRevisionObserved liveness signal instead of an
 * always-on interval. Standalone (no push) keeps its original fast poll + backoff.
 *
 * RepoMesh.tsx is page-scale (heavy context deps) — pinned at the source level,
 * same convention as repo-mesh-queue-load-not-gated.test.tsx /
 * repo-mesh-create-hang-regression.test.ts. Behavioral coverage of the underlying
 * observed/advance split lives in
 * test/hooks/mesh-state-revision-refresh-observed.test.tsx.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8')

describe('RepoMesh.tsx — cloud mesh-graph poll demoted to a WARN-only backstop', () => {
    const source = read('../../src/pages/RepoMesh.tsx')

    it('declares a 5-minute backstop-stale threshold, not the old 45s/30s poll cadence', () => {
        expect(source).toContain('GRAPH_PUSH_BACKSTOP_STALE_MS = 5 * 60 * 1000')
    })

    it('the backstop branch is gated on features.meshStatePushRefresh (cloud only)', () => {
        const idx = source.indexOf('if (features.meshStatePushRefresh) {')
        expect(idx).toBeGreaterThan(-1)
    })

    it('the backstop only refreshes when staleMs is evidence of a missed push, never unconditionally', () => {
        const start = source.indexOf('if (features.meshStatePushRefresh) {')
        const end = source.indexOf('let timer: ReturnType<typeof setInterval> | null = null', start)
        expect(start).toBeGreaterThan(-1)
        expect(end).toBeGreaterThan(start)
        const backstopBlock = source.slice(start, end)

        // Must gate the refresh on a staleness comparison...
        expect(backstopBlock).toMatch(/if\s*\(\s*staleMs\s*<\s*GRAPH_PUSH_BACKSTOP_STALE_MS\s*\)\s*return/)
        // ...and log a WARN naming the mesh id before refreshing, never a silent
        // auto-heal (safety-net policy: UserSession.ts precedent cited in the
        // audit — an event-replaced timer survives only as a WARN-only reconcile).
        expect(backstopBlock).toContain('console.warn(')
        expect(backstopBlock).toMatch(/console\.warn\(\s*\n?\s*`\[repo-mesh\][^`]*\$\{meshIdForWarn\}/)
        expect(backstopBlock).toContain('refreshGraphInBackground.current()')
    })

    it('the backstop timer period is GRAPH_PUSH_BACKSTOP_STALE_MS, not the old 45s fallback constant', () => {
        const start = source.indexOf('if (features.meshStatePushRefresh) {')
        const end = source.indexOf('let timer: ReturnType<typeof setInterval> | null = null', start)
        const backstopBlock = source.slice(start, end)
        expect(backstopBlock).toContain('}, GRAPH_PUSH_BACKSTOP_STALE_MS)')
        expect(backstopBlock).not.toContain('GRAPH_PUSH_FALLBACK_INTERVAL_MS')
    })

    it('liveness (lastPushObservedAtRef) is fed from onRevisionObserved, not onRevisionAdvance alone', () => {
        const hookCallStart = source.indexOf('useMeshStateRevisionRefresh({')
        const hookCallEnd = source.indexOf('})', hookCallStart)
        const hookCall = source.slice(hookCallStart, hookCallEnd)
        expect(hookCall).toContain('onRevisionObserved: () => {')
        expect(hookCall).toContain('lastPushObservedAtRef.current = Date.now()')
    })

    it('standalone (no push) keeps the always-refresh poll unchanged in the else branch', () => {
        const elseIdx = source.indexOf('let timer: ReturnType<typeof setInterval> | null = null')
        expect(elseIdx).toBeGreaterThan(-1)
        const tail = source.slice(elseIdx, elseIdx + 800)
        expect(tail).toContain('refreshGraphInBackground.current()')
        expect(tail).toContain('setInterval(tick, pollIntervalMs)')
    })
})
