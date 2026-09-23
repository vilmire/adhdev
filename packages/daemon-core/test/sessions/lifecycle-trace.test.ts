import { describe, expect, it } from 'vitest'
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js'
import { BUS_EVENT_KINDS, type BusEvent } from '../../src/sessions/lifecycle-events.js'
import { formatLifecycleTraceLine, subscribeLifecycleTrace } from '../../src/sessions/lifecycle-trace.js'

const SENTINEL = 'SECRET-USER-TEXT-9f2c'

function sample(kind: BusEvent['kind']): BusEvent {
    const base = { sessionId: 'sess_0123456789abcdef', at: 1 }
    switch (kind) {
        case 'registered': return { kind, ...base, origin: 'launch', session: { sessionId: base.sessionId, providerType: 'claude-code', transport: 'pty' } as any }
        case 'status': return { kind, ...base, providerType: 'claude-code', prev: 'idle', next: 'generating', cause: 'fsm_state' }
        case 'modal': return { kind, ...base, modal: { message: SENTINEL, buttons: [{ label: SENTINEL }, { label: 'No' }] } as any }
        case 'prompt': return { kind, ...base, prompt: { promptId: 'p1', questions: [{ question: SENTINEL }] } as any, transport: 'pty' }
        case 'signal': return { kind, ...base, runtimeSettings: {}, signal: { kind: 'quota', detail: SENTINEL } as any }
        case 'binding': return { kind, ...base, providerSessionId: 'prov_abcdefghijkl' }
        case 'launch_updated': return { kind, ...base, cause: 'launch', launch: { model: { source: 'user', requested: SENTINEL, history: [] }, thinkingLevel: { source: 'unspecified', history: [] } } as any }
        case 'terminated': return { kind, ...base, cause: 'pty_exit', providerType: 'claude-code', runtimeSettings: {} }
        case 'turn': return { kind, ...base, phase: 'committed', attemptId: 'attempt_0123456789', generation: 1, outcome: 'completed', strength: 'genuine' }
        case 'provider_event': return { kind, ...base, event: { event: 'agent:ready', summary: SENTINEL } as any }
        case 'daemon_facts': return { kind, at: 1, cause: 'provider_detection' }
        case 'mesh_state': return { kind, at: 1, meshId: 'mesh_0123456789' }
        case 'command_executed': return { kind, at: 1, command: 'send_chat', source: 'ipc', sessionId: base.sessionId, success: true, invalidates: new Set(['session.modal']), fastFlush: false, postChat: true, interactionId: 'i1' }
    }
}

describe('lifecycle trace subscriber', () => {
    it('renders every bus event kind as one content-free line', () => {
        for (const kind of BUS_EVENT_KINDS) {
            const line = formatLifecycleTraceLine(sample(kind))
            expect(line.startsWith(`[bus] ${kind}`)).toBe(true)
            expect(line).not.toContain('\n')
            expect(line).not.toContain(SENTINEL)
        }
    })

    it('subscribes to the bus and unsubscribes cleanly', () => {
        const lines: string[] = []
        const bus = createSessionLifecycleBus({ log: () => {} })
        const off = subscribeLifecycleTrace(bus, (l) => lines.push(l))
        bus.emit(sample('registered'))
        bus.emit(sample('terminated'))
        expect(lines).toHaveLength(2)
        expect(lines[0]).toContain('origin=launch')
        expect(lines[1]).toContain('cause=pty_exit')
        off()
        bus.emit(sample('status'))
        expect(lines).toHaveLength(2)
    })

    it('does not format when the level gate is closed', () => {
        const lines: string[] = []
        const bus = createSessionLifecycleBus({ log: () => {} })
        let enabled = false
        subscribeLifecycleTrace(bus, (l) => lines.push(l), () => enabled)
        bus.emit(sample('status'))
        expect(lines).toHaveLength(0)
        enabled = true
        bus.emit(sample('status'))
        expect(lines).toHaveLength(1)
    })
})
