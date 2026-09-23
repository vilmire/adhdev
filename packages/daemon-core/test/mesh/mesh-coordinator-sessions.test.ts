import { describe, expect, it } from 'vitest'
import { listLocalCoordinatorSessions } from '../../src/mesh/mesh-event-forwarding.js'

// The turn.deliver consumer's routing snapshot (C-W3): this daemon's CLI
// coordinator sessions of a mesh, idle decided on the RAW adapter turn-state
// (PTY-OVERTRUST-DRAIN / NOTIF-LOSS A1 — ported from the deleted
// mesh-idle-edge-autoflush-mask test: the auto-approve hold-idle mask paints a
// genuinely idle coordinator `generating`, and trusting it stranded completions).

function instance(opts: { meshCoordinatorFor?: string; status: string; drain?: string | null; modal?: boolean; id?: string }) {
    const sent: any[] = []
    return {
        sent,
        category: 'cli',
        getState: () => ({ instanceId: opts.id ?? 'coord-1', status: opts.status, settings: opts.meshCoordinatorFor ? { meshCoordinatorFor: opts.meshCoordinatorFor } : {} }),
        onEvent: (event: string, data: any) => { sent.push({ event, data }) },
        ...(opts.drain !== undefined ? { getDrainStatus: () => opts.drain } : {}),
        ...(opts.modal !== undefined ? { isModalParked: () => opts.modal } : {}),
    }
}

function components(instances: any[]) {
    return {
        instanceManager: {
            getByCategory: (c: string) => instances.filter((i) => i.category === c),
            getInstance: (id: string) => instances.find((i) => i.getState().instanceId === id),
        },
    } as any
}

describe('listLocalCoordinatorSessions — raw turn-state', () => {
    it('idle when the auto-approve mask paints a raw-idle coordinator as generating', () => {
        const c = components([instance({ meshCoordinatorFor: 'm1', status: 'generating', drain: 'idle', modal: false })])
        expect(listLocalCoordinatorSessions(c, 'm1')).toEqual([{ sessionId: 'coord-1', idle: true, modalParked: false }])
    })

    it('busy when raw is generating even though getState() reads idle', () => {
        const c = components([instance({ meshCoordinatorFor: 'm1', status: 'idle', drain: 'generating', modal: false })])
        expect(listLocalCoordinatorSessions(c, 'm1')[0]).toMatchObject({ idle: false })
    })

    it('modal-parked is its own flag (never a delivery target before the ceiling)', () => {
        const c = components([instance({ meshCoordinatorFor: 'm1', status: 'waiting_approval', drain: 'idle', modal: true })])
        expect(listLocalCoordinatorSessions(c, 'm1')[0]).toMatchObject({ modalParked: true })
    })

    it('falls back to the visible status without getDrainStatus()', () => {
        const c = components([instance({ meshCoordinatorFor: 'm1', status: 'idle' })])
        expect(listLocalCoordinatorSessions(c, 'm1')[0]).toMatchObject({ idle: true, modalParked: false })
    })

    it('only coordinators OF THIS MESH', () => {
        const c = components([
            instance({ meshCoordinatorFor: 'm1', status: 'idle', id: 'a' }),
            instance({ meshCoordinatorFor: 'm2', status: 'idle', id: 'b' }),
            instance({ status: 'idle', id: 'worker' }),
        ])
        expect(listLocalCoordinatorSessions(c, 'm1').map((s) => s.sessionId)).toEqual(['a'])
    })
})

// (D2 → C-W8) resolveCoordinatorInputTarget is gone: notices submit through the
// daemon's one SessionInputService (`cliManager.input`), pinned by
// test/sessions/session-input-service.test.ts.
