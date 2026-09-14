/**
 * (A#3) The daemon's typed refusal reason survives the trip into UI state.
 *
 * ★ The render side (tool-expand-bubble-render.test.tsx) pins that a reason
 * BRANCHES the copy. This pins the other half: that a reason actually arrives.
 * The original defect was exactly this gap — `ToolExpandState.error` was
 * declared and documented, the daemon returned `{success:false, reason}` on
 * every refusal path, and `handleExpandToolBlock` still wrote a bare
 * `{status:'error'}`. Both halves have to hold or the feature is decorative.
 *
 * ★ Why an allow-list and not a cast: `reason` crosses a process boundary from
 * a daemon whose version we do not control, and it selects user-visible copy.
 * Narrowing here means the worst an unexpected value can do is fall back to the
 * generic branch.
 */
import { describe, expect, it } from 'vitest'
import { toExpandFailureReason } from '../../../src/components/dashboard/ChatPane'

describe('(A#3) toExpandFailureReason', () => {
    it('★ accepts all five reasons the daemon taxonomy defines', () => {
        // Mirrors `ToolBlockExpandFailure` in daemon-core
        // providers/spec/tool-block-expand.ts. If that union grows, this list
        // and the web-side type must grow with it — an unmirrored addition
        // silently degrades to the generic branch rather than breaking.
        for (const reason of [
            'unsupported_source',
            'source_unavailable',
            'source_changed',
            'block_not_found',
            'not_a_tool_block',
        ]) {
            expect(toExpandFailureReason(reason)).toBe(reason)
        }
    })

    it('rejects anything outside the taxonomy', () => {
        expect(toExpandFailureReason(undefined)).toBeUndefined()
        expect(toExpandFailureReason(null)).toBeUndefined()
        expect(toExpandFailureReason('')).toBeUndefined()
        expect(toExpandFailureReason('source_CHANGED')).toBeUndefined()
        expect(toExpandFailureReason('newer_daemon_reason')).toBeUndefined()
    })

    it('★ rejects non-string payloads rather than passing them through to copy', () => {
        // A malformed/hostile reply must not land an object or number where the
        // renderer expects a closed enum.
        expect(toExpandFailureReason(42)).toBeUndefined()
        expect(toExpandFailureReason({ reason: 'source_changed' })).toBeUndefined()
        expect(toExpandFailureReason(['source_changed'])).toBeUndefined()
    })
})
