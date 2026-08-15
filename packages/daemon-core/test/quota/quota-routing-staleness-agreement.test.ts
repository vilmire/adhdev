/**
 * DRIFT GUARD: the idle-gate staleness exception must keep snapshots inside the
 * window the ROUTING gate will still act on.
 *
 * `QUOTA_ROUTABLE_MAX_AGE_MS` (quota/refresh.ts) decides when an idle machine
 * re-fetches a provider; `DEFAULT_QUOTA_ROUTING_POLICY.staleAfterMs`
 * (repo-mesh-types.ts) decides when the quota gate stops trusting a snapshot.
 * If the refresh horizon ever exceeds the routing horizon, snapshots go
 * ungateable again between ticks and the quota gate silently fails open — the
 * exact 2026-08-15 defect (see quota-idle-staleness-refresh.test.ts).
 *
 * The constant is deliberately duplicated rather than imported: quota/ must not
 * depend on the mesh types (it is consumed by daemons that never build a mesh).
 * This test is what makes that duplication safe.
 */
import { describe, expect, it } from 'vitest'
import { QUOTA_ROUTABLE_MAX_AGE_MS } from '../../src/quota/refresh.js'
import { DEFAULT_QUOTA_ROUTING_POLICY } from '../../src/repo-mesh-types.js'

describe('quota refresh horizon vs routing staleness horizon', () => {
    it('refreshes at or before the routing gate stops trusting the snapshot', () => {
        expect(QUOTA_ROUTABLE_MAX_AGE_MS).toBeLessThanOrEqual(DEFAULT_QUOTA_ROUTING_POLICY.staleAfterMs)
    })

    it('is exactly the routing horizon today (tighten deliberately, never loosen)', () => {
        expect(QUOTA_ROUTABLE_MAX_AGE_MS).toBe(DEFAULT_QUOTA_ROUTING_POLICY.staleAfterMs)
    })
})
