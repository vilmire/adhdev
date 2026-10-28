import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eventManager, type ToastConfig } from '../../src/managers/EventManager'
import { isApprovalAlreadyHandledOutcome } from '../../src/managers/event-manager-helpers'

// An approval action toast must not outlive its approval: the daemon can
// auto-approve within a second while the toast is offered for 15s, and a click
// on the leftover "No, exit" was refused by the PTY gate with zero feedback.
// `agent:approval_resolved` is not on the dashboard wire, so liveness comes
// from session state (setIdes); the event is honoured if it ever arrives.

const BUTTONS = ['No, exit', 'Yes, I trust this folder']
let seq = 0
let shown: ToastConfig[]
let dismissed: number[]
let stops: Array<() => void>
let resolveImpl: (routeId: string, action: string, payload: Record<string, any>) => any

function session(id: string, status: string, extra: Record<string, unknown> = {}) {
    return { id, sessionId: id, type: 'claude-cli', status, ...extra } as any
}

function approve(id: string, ts = 1000 + ++seq) {
    eventManager.handleRawEvent({
        event: 'agent:waiting_approval', timestamp: ts,
        targetSessionId: id, providerSessionId: id,
        modalMessage: `Trust folder ${ts}?`, modalButtons: BUTTONS,
    } as any, 'ws')
}

function liveToasts(): ToastConfig[] {
    return shown.filter(t => t.actions?.length && !dismissed.includes(t.id))
}

beforeEach(() => {
    shown = []; dismissed = []
    resolveImpl = () => Promise.resolve({ success: true })
    stops = [
        eventManager.onToast(t => shown.push(t)),
        eventManager.onToastDismiss(id => dismissed.push(id)),
    ]
    eventManager.setResolveAction((r, a, p) => resolveImpl(r, a, p))
})
afterEach(() => { stops.forEach(s => s()); vi.useRealTimers() })

describe('approval toast liveness', () => {
    it('closes the toast when approval_resolved arrives for the same session', () => {
        const id = `live-resolved-${++seq}`
        eventManager.setIdes([session(id, 'waiting_approval')])
        approve(id)
        expect(liveToasts()).toHaveLength(1)
        eventManager.handleRawEvent({ event: 'agent:approval_resolved', timestamp: 5, targetSessionId: id } as any, 'ws')
        expect(liveToasts()).toHaveLength(0)
    })

    it('closes the toast when the session status leaves waiting_approval', () => {
        const id = `live-status-${++seq}`
        eventManager.setIdes([session(id, 'waiting_approval')])
        approve(id)
        expect(liveToasts()).toHaveLength(1)
        eventManager.setIdes([session(id, 'starting')])
        expect(liveToasts()).toHaveLength(0)
    })

    it('closes the toast when the session never showed waiting and the grace elapses', () => {
        vi.useFakeTimers()
        const id = `live-grace-${++seq}`
        eventManager.setIdes([session(id, 'idle')])
        approve(id)
        // a metadata snapshot that predates the modal must not kill a fresh toast
        expect(liveToasts()).toHaveLength(1)
        vi.advanceTimersByTime(3000)
        expect(liveToasts()).toHaveLength(0)
    })

    it('closes the toast when activeModal clears', () => {
        const id = `live-modal-${++seq}`
        eventManager.setIdes([session(id, 'idle', { activeModal: { message: 'm', buttons: BUTTONS } })])
        approve(id)
        expect(liveToasts()).toHaveLength(1)
        eventManager.setIdes([session(id, 'idle', { activeModal: null })])
        expect(liveToasts()).toHaveLength(0)
    })

    it('keeps the toast when a resolved event is for a different session', () => {
        const id = `live-keep-${++seq}`
        eventManager.setIdes([session(id, 'waiting_approval'), session(`${id}-other`, 'waiting_approval')])
        approve(id)
        eventManager.handleRawEvent({ event: 'agent:approval_resolved', timestamp: 5, targetSessionId: `${id}-other` } as any, 'ws')
        expect(liveToasts()).toHaveLength(1)
        // and other-session state changes do not touch it either
        eventManager.setIdes([session(id, 'waiting_approval'), session(`${id}-other`, 'idle')])
        expect(liveToasts()).toHaveLength(1)
    })

    it('replaces, not stacks, a second waiting_approval for the same session', () => {
        const id = `live-replace-${++seq}`
        eventManager.setIdes([session(id, 'waiting_approval')])
        approve(id)
        approve(id)
        expect(liveToasts()).toHaveLength(1)
        expect(shown.filter(t => t.actions?.length)).toHaveLength(2)
    })

    it('closes the toast and shows an info toast when the click finds no modal', async () => {
        const id = `live-click-gone-${++seq}`
        eventManager.setIdes([session(id, 'waiting_approval')])
        approve(id)
        resolveImpl = () => Promise.resolve({ success: true, result: { success: false, error: 'Not in approval state' } })
        const toast = liveToasts()[0]
        toast.actions![0].onClick()
        await vi.waitFor(() => expect(liveToasts()).toHaveLength(0))
        const info = shown.filter(t => !t.actions?.length && t.type === 'info')
        expect(info).toHaveLength(1)
        expect(info[0].message.length).toBeGreaterThan(0)
        expect(info[0].message).not.toBe('event.approvalAlreadyHandled')
    })

    it('shows no info toast when the click succeeds', async () => {
        const id = `live-click-ok-${++seq}`
        eventManager.setIdes([session(id, 'waiting_approval')])
        approve(id)
        resolveImpl = () => Promise.resolve({ success: true, result: { success: true } })
        liveToasts()[0].actions![1].onClick()
        await new Promise(r => setTimeout(r, 20))
        expect(shown.filter(t => !t.actions?.length && t.type === 'info')).toHaveLength(0)
    })
})

describe('isApprovalAlreadyHandledOutcome', () => {
    it('recognises the daemon "modal gone" shapes, bare and P2P-wrapped', () => {
        expect(isApprovalAlreadyHandledOutcome({ success: false, error: 'Not in approval state' })).toBe(true)
        expect(isApprovalAlreadyHandledOutcome({ success: true, result: { success: false, error: 'Not in approval state' } })).toBe(true)
        expect(isApprovalAlreadyHandledOutcome({ success: true, alreadyResolved: true })).toBe(true)
        expect(isApprovalAlreadyHandledOutcome({ success: false, stalePrompt: true, code: 'approval_button_changed' })).toBe(true)
        expect(isApprovalAlreadyHandledOutcome('Command failed: Not in approval state')).toBe(true)
    })
    it('does not treat success or other failures as handled', () => {
        expect(isApprovalAlreadyHandledOutcome({ success: true })).toBe(false)
        expect(isApprovalAlreadyHandledOutcome({ success: false, approvalModalUnavailable: true, error: 'Session status IS waiting_approval' })).toBe(false)
        expect(isApprovalAlreadyHandledOutcome(undefined)).toBe(false)
    })
})
