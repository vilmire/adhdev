/**
 * SUBMIT-UNCONFIRMED-RECLAIM at the SessionInputService boundary.
 *
 * Only a MESH DISPATCH (an OutboundMessage carrying meshAttemptRef) registers a
 * verdict observer — registering is what opts the write into the driver's
 * verdict + held-composer machinery (review 9719d681 R3-1). A human's chat
 * never registers one, so it keeps main's behaviour. On a verdict
 * (`unconfirmed` proven, or `unproven` after the grace) the service tells the
 * instance, which reports dispatch_failed for its current dispatch (→ R24
 * reclaim under a new nonce). The settled outcome is KEPT: the body is still in
 * the composer (never cleared or re-written), so the id is never written again.
 */
import { describe, expect, it } from 'vitest'
import type { OutboundMessage } from '@adhdev/mesh-shared'
import { createSessionInputService, type SessionInputTarget } from '../../src/sessions/session-input-service.js'

function fakeTarget() {
    const writes: string[] = []
    const reported: string[] = []
    const observers = new Map<string, Array<(verdict: 'unconfirmed', info: { firstWrittenAt: number }) => void>>()
    const target: SessionInputTarget = {
        label: 'fake-cli',
        getStatus: () => ({ status: 'idle' }),
        async sendMessage(text) { writes.push(text); return { status: 'delivered' } },
        observeSubmitUnconfirmed(id, cb) { observers.set(id, [...(observers.get(id) ?? []), cb]) },
        reportSubmitUnconfirmed: (id, firstWrittenAt) => { reported.push(`${id}@${firstWrittenAt}`); return true },
        // The instance's installed dispatch: task t1, nonce 0, this attempt.
        canReportSubmitVerdict: (id, ref) => id === 'task:t1:n0' && ref === 'mesh_queue:m1:t1:1',
    }
    const proveUnsent = (id: string, firstWrittenAt = 1_000) => { const list = observers.get(id) ?? []; observers.delete(id); for (const cb of list) cb('unconfirmed', { firstWrittenAt }) }
    return { target, writes, reported, proveUnsent, observers }
}

function mesh(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
    return {
        messageId: 'task:t1:n0',
        sessionId: 's1',
        input: { parts: [{ type: 'text', text: 'TASK BODY' }], textFallback: 'TASK BODY' },
        origin: 'mesh',
        policy: { mode: 'queue' },
        createdAt: 1,
        meshAttemptRef: 'mesh_queue:m1:t1:1',
        ...overrides,
    }
}

describe('SessionInputService — submit unconfirmed', () => {
    it('reports a proven-unsent write to the instance exactly once', async () => {
        const f = fakeTarget()
        const svc = createSessionInputService({ resolveSession: (id) => (id === 's1' ? f.target : null) })
        expect(await svc.submit(mesh())).toMatchObject({ kind: 'delivered' })
        expect(f.reported).toEqual([])
        f.proveUnsent('task:t1:n0')
        expect(f.reported).toEqual(['task:t1:n0@1000'])
        f.proveUnsent('task:t1:n0')
        expect(f.reported).toEqual(['task:t1:n0@1000'])
    })

    it('review R5-2: passes the driver\'s first-write anchor through unchanged (never a re-stamped scalar)', async () => {
        const f = fakeTarget()
        const svc = createSessionInputService({ resolveSession: () => f.target })
        await svc.submit(mesh())
        f.proveUnsent('task:t1:n0', 123_456)
        expect(f.reported).toEqual(['task:t1:n0@123456'])
    })

    it('R4-2 (reviewer R4_OPTIN): a send carrying an attemptId that is not the installed dispatch never registers an observer', async () => {
        const f = fakeTarget()
        const svc = createSessionInputService({ resolveSession: () => f.target })
        await svc.submit(mesh({ messageId: 'legacy:abc', origin: 'dashboard', meshAttemptRef: 'not-a-ledger-attempt' }))
        expect(f.observers.size).toBe(0)
        await svc.submit(mesh({ messageId: 'task:t1:n0', meshAttemptRef: 'not-a-ledger-attempt' }))
        expect(f.observers.size).toBe(0)
        const noCapability = fakeTarget()
        delete noCapability.target.canReportSubmitVerdict
        await createSessionInputService({ resolveSession: () => noCapability.target }).submit(mesh())
        expect(noCapability.observers.size).toBe(0)
    })

    it('R3-1: a human chat (no meshAttemptRef) never registers a verdict observer — it keeps main\'s give-up, never the hold', async () => {
        const f = fakeTarget()
        const svc = createSessionInputService({ resolveSession: () => f.target })
        expect(await svc.submit(mesh({ messageId: 'msg_human_1', origin: 'dashboard', meshAttemptRef: undefined }))).toMatchObject({ kind: 'delivered' })
        expect(f.observers.size).toBe(0)
        expect(f.reported).toEqual([])
    })

    it('R1: keeps the settled outcome — the same id is never written again (only the reclaim\'s new nonce is)', async () => {
        const f = fakeTarget()
        const svc = createSessionInputService({ resolveSession: () => f.target })
        await svc.submit(mesh())
        f.proveUnsent('task:t1:n0')
        expect(await svc.submit(mesh())).toEqual({ kind: 'duplicate', of: 'task:t1:n0' })
        expect(f.writes).toEqual(['TASK BODY'])
    })

    it('a report the instance throws on is contained (logged), never breaks the submit path', async () => {
        const f = fakeTarget()
        f.target.reportSubmitUnconfirmed = () => { throw new Error('boom') }
        const logs: string[] = []
        const svc = createSessionInputService({ resolveSession: () => f.target, log: (_l, m) => logs.push(m) })
        await svc.submit(mesh())
        expect(() => f.proveUnsent('task:t1:n0')).not.toThrow()
        expect(logs.some((m) => m.includes('submit-unconfirmed report failed'))).toBe(true)
    })
})
