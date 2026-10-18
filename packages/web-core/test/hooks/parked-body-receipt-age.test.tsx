// @vitest-environment jsdom
/**
 * A body the daemon is genuinely HOLDING (queued) must not be declared stale /
 * delivery-uncertain by the short unconfirmed-write poll cap: that would hide its
 * Send now / Cancel controls and stop receipt polling while it is still parked.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { receiptAwareTransport, resetOutgoingReceiptFixture } from '../helpers/outgoing-receipt-transport'
import { useDashboardConversationCommands } from '../../src/hooks/useDashboardConversationCommands'
import { OUTGOING_RECEIPT_POLL_MAX_AGE_MS } from '../../src/utils/pendingQueuedMessages'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
beforeEach(resetOutgoingReceiptFixture)

describe('parked body vs the receipt poll max age', () => {
    it('keeps a daemon-parked PTY body live (not stale/uncertain) and still polling past the unconfirmed-write cap', async () => {
        vi.useFakeTimers()
        try {
            let receiptPolls = 0
            const send = vi.fn().mockResolvedValue({ success: true, sent: false, queued: true, submitted: false })
            const base = receiptAwareTransport(send)
            const transport = vi.fn(async (target: string, type: string, payload: any) => {
                if (type === 'outgoing_receipts') receiptPolls += 1
                return base(target, type, payload)
            })
            const root = createRoot(document.createElement('div'))
            let latest: any = null
            const activeConv = { tabKey: 'tab-parked-age', routeId: 'd:s', daemonId: 'd', sessionId: 's', transport: 'pty', status: 'generating' }
            function Harness() {
                latest = useDashboardConversationCommands({ sendDaemonCommand: transport, activeConv, setActionLogs: () => {}, isStandalone: false } as any)
                return null
            }
            act(() => { root.render(createElement(Harness)) })
            await act(async () => { await latest.handleSendChat('parked body') })
            expect(latest.pendingLocalMessages[0].queued).toBe(true)

            await act(async () => { await vi.advanceTimersByTimeAsync(OUTGOING_RECEIPT_POLL_MAX_AGE_MS + 15_000) })
            const entry = latest.pendingLocalMessages[0]
            expect(entry.queued).toBe(true)
            expect(entry.stale).toBeFalsy()
            expect(entry.deliveryUncertain).toBeFalsy()

            const pollsAtCap = receiptPolls
            await act(async () => { await vi.advanceTimersByTimeAsync(40_000) })
            expect(receiptPolls).toBeGreaterThan(pollsAtCap)
            act(() => { root.unmount() })
        } finally {
            vi.useRealTimers()
        }
    })

    it('Retry on a failed send keeps the image attachment bytes in the resubmitted input', async () => {
        const payloads: any[] = []
        let calls = 0
        const send = vi.fn(async (_t: string, type: string, payload: any) => {
            if (type === 'send_chat') {
                payloads.push(payload)
                calls += 1
                if (calls === 1) throw new Error('boom')
                return { success: true, sent: true, submitted: false }
            }
            return { success: true }
        })
        const root = createRoot(document.createElement('div'))
        let latest: any = null
        const activeConv = { tabKey: 'tab-retry-img', routeId: 'd:s', daemonId: 'd', sessionId: 's', transport: 'pty', status: 'idle' }
        function Harness() {
            latest = useDashboardConversationCommands({ sendDaemonCommand: receiptAwareTransport(send), activeConv, setActionLogs: () => {}, isStandalone: false } as any)
            return null
        }
        act(() => { root.render(createElement(Harness)) })
        const att = { mimeType: 'image/png', data: 'QUJD', name: 'a.png', previewUrl: 'data:image/png;base64,QUJD' }
        await act(async () => { await latest.handleSendChat('with image', [att]) })
        expect(latest.pendingLocalMessages[0].sendFailed).toBe(true)
        await act(async () => { await latest.handleRetryPendingMessage(latest.pendingLocalMessages[0].id) })
        const imagePart = payloads[1]?.input?.parts?.find((p: any) => p.type === 'image')
        expect(imagePart).toMatchObject({ mimeType: 'image/png', data: 'QUJD' })
        act(() => { root.unmount() })
    })
})
