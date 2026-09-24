import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetWorkerSessionBindsForTest,
  hasLiveWorkerSessionBind,
  mintWorkerSessionBind,
  revokeWorkerSessionBindsForSession,
} from '../../src/mesh/worker-mcp-isolation.js'

// The report gate's source fact (turn-ledger R9r, live rc.40 2026-09-24): a live
// worker session bind = the worker can call report_completion, so the turn-evidence
// port stamps `reportExpected` on that session's turn_end (boot/stages/mesh-runtime.ts).
describe('hasLiveWorkerSessionBind', () => {
  afterEach(() => __resetWorkerSessionBindsForTest())

  it('is true only while a bind names the session', () => {
    expect(hasLiveWorkerSessionBind('sess-1')).toBe(false)
    mintWorkerSessionBind({ meshId: 'mesh-1', sessionId: 'sess-1' })
    expect(hasLiveWorkerSessionBind('sess-1')).toBe(true)
    expect(hasLiveWorkerSessionBind('sess-2')).toBe(false)
    expect(hasLiveWorkerSessionBind('')).toBe(false)
    revokeWorkerSessionBindsForSession('sess-1')
    expect(hasLiveWorkerSessionBind('sess-1')).toBe(false)
  })
})
