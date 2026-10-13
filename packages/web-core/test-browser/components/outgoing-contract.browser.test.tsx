import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { page, commands as browserCommands } from 'vitest/browser'
import { MemoryRouter } from 'react-router-dom'
import '../../src/index.css'
import { initI18n } from '../../src/i18n/config'
import { useDashboardConversationCommands } from '../../src/hooks/useDashboardConversationCommands'
import DashboardMobileChatRoom from '../../src/components/dashboard/DashboardMobileChatRoom'
import { TransportProvider } from '../../src/context/TransportContext'
import { applyTranscriptViewToControllers } from '../../src/components/dashboard/session-chat-controller'
import { readPendingQueuedMessages } from '../../src/utils/pendingQueuedMessages'
vi.mock('../../src/components/dashboard/CliTerminalPane', () => ({ default: () => <div /> }))
const remote = (browserCommands as unknown as { outgoingContract: (request: any) => Promise<any> }).outgoingContract
const image = { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8T8AAAAASUVORK5CYII=', name: 'synthetic.png', previewUrl: '' }
it('settles only exact acknowledged image-inclusive writes through producer/adapter/codec and real mobile consumer, including reconnect', async () => {
    localStorage.clear(); localStorage.setItem('lang', 'en');initI18n()
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    for (const width of [375, 390]) for (const mode of ['queued', 'immediate', 'void', 'late_ack']) {
        await page.viewport(width, 844)
        const sessionId = `synthetic-session-${width}-${mode}`, tabKey = `synthetic-tab-${width}-${mode}`, daemonId = 'synthetic-daemon'
        await remote({ action: 'init', sessionId, immediate: mode === 'immediate', confirmed: mode !== 'void' })
        const conversation: any = { routeId: daemonId, daemonId, sessionId, tabKey, assistant: true,
            transport: 'pty', mode: 'chat', status: 'idle', title: 'Assistant', displayPrimary: 'Assistant', agentName: 'Codex',
            agentType: 'codex-cli', connectionState: 'connected', messages: [] }
        let latest: any, lastPayload: any, lostReceipts = mode === 'late_ack', frame = 0, queuedReply: any, releaseReply: (() => void) | undefined
        const send = vi.fn(async (_route: string, type: string, args: any) => {
            if (type === 'send_chat') {
                lastPayload = args
                const result = await remote({ action: 'submit', sessionId, message: args })
                if (mode === 'late_ack') { queuedReply = result;return await new Promise(resolve => { releaseReply = () => resolve(result) }) }
                return result
            }
            if (type === 'outgoing_receipts') {
                if (lostReceipts) throw new Error('Synthetic receipt timeout')
                return { success: true, ...(await remote({ action: 'peek', sessionId, ids: args.messageIds })) }
            }
            if (type === 'assistant_execution_state') return { success: true, executionEnabled: true, executionAvailable: true, restriction: 'enforced', choices: [] }
            if (type === 'assistant_staged_resolve') return { success: true, memory: [], skills: [], notes: [] }
            throw new Error(`Unexpected synthetic command ${type}`)
        })
        const transport = { sendCommand: send, sendData: vi.fn(() => false) }
        function Harness() {
            latest = useDashboardConversationCommands({ sendDaemonCommand: send, activeConv: conversation,
                setActionLogs: () => {}, isStandalone: true } as any)
            return <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><TransportProvider value={transport}>
                <DashboardMobileChatRoom selectedConversation={conversation} isStandalone commands={latest} actionLogs={[]}
                    onBack={() => {}} onOpenNativeConversation={() => {}} onOpenMachine={() => {}}
                    onOpenHistory={() => {}} onOpenRemote={() => {}} cliViewMode="chat" onSetCliViewMode={() => {}} />
            </TransportProvider></MemoryRouter>
        }
        const host = document.createElement('div');host.style.cssText='height:100dvh;display:flex;flex-direction:column';document.body.append(host)
        let root = createRoot(host)
        const render = async () => { await act(async () => root.render(<Harness />)) }
        const publish = async (messages: any[]) => {
            await act(async () => applyTranscriptViewToControllers(daemonId, sessionId, { schemaVersion: 2,
                sessionId, historySessionId: null, providerType: 'codex-cli', providerSessionId: null,
                producerDaemonId: daemonId, producerWriterId: 'synthetic-writer', epoch: 'synthetic-wire-epoch', frame: ++frame,
                observedAt: '2026-10-13T00:00:00Z', status: 'idle', providerObservedStatus: null, title: null,
                activeModal: null, activeInteractivePrompt: null, turn: null,
                provenance: { messageSource: null, transcriptProvenance: null }, messages,
                terminalMarkers: [], coverage: { mode: 'tail', totalMessageCount: messages.length,
                    returnedMessageCount: messages.length, omittedBefore: false } } as any))
        }
        try {
            await render()
            let sending: Promise<boolean>
            await act(async () => { sending = latest.handleSendChat('Public text and image', [image]);if (mode !== 'late_ack') await sending })
            if (mode === 'late_ack') await expect.poll(() => !!queuedReply).toBe(true)
            const id = lastPayload.messageId
            let state = await remote({ action: 'peek', sessionId, ids: [id] })
            if (mode !== 'immediate') { expect(state.writes).toBe(0);expect(state.receipts[0].state).toBe('accepted') }
            else expect(state.receipts[0].state).not.toBe('submitted')
            expect(state.messages[0].sourceMessageId).toBe(id)
            await publish(state.messages)
            expect(latest.pendingLocalMessages).toHaveLength(1) // Acceptance ACK never settles.
            await publish([{ ...state.messages[0], content: 'Public text and image\n[image: image/png]' }])
            expect(latest.pendingLocalMessages).toHaveLength(1) // Echo shape is irrelevant.
            await act(async () => { await page.screenshot({ path: `/tmp/assistant-queue-contract-accepted-${width}-${mode}.png` }) })
            lostReceipts = true
            state = await remote({ action: 'drain', sessionId, ids: [id] })
            expect(state.writes).toBe(2);expect(state.receipts[0].state).toBe('uncertain')
            await publish(state.messages)
            expect(latest.pendingLocalMessages[0].deliveryUncertain).toBe(true)
            expect(await latest.handleSendNowQueued(id)).toBe(false)
            expect(await latest.handleSendChat('Public text and image', [image])).toBe(false)
            const card = host.querySelector('[data-testid="pending-queue-strip"]')!
            const bounds = card.getBoundingClientRect(), input = host.querySelector('textarea')!.getBoundingClientRect()
            expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.right).toBeLessThanOrEqual(width)
            expect(bounds.bottom).toBeLessThanOrEqual(input.y)
            const buttons = [...card.querySelectorAll('button')].map(button => button.getBoundingClientRect())
            for (const button of buttons) {
                expect(button.width).toBeGreaterThan(0); expect(button.height).toBeGreaterThan(0)
                expect(button.right).toBeLessThanOrEqual(width); expect(button.bottom).toBeLessThanOrEqual(input.y)
            }
            expect(buttons[0].right).toBeLessThanOrEqual(buttons[1].x)
            const header = host.querySelector('header')?.getBoundingClientRect()
            if (header) expect(header.bottom).toBeLessThanOrEqual(bounds.y)
            console.log(JSON.stringify({ width, mode, queueBounds: bounds.toJSON(), inputBounds: input.toJSON(),
                controlBounds: buttons.map(b => b.toJSON()), headerBounds: header?.toJSON() }))
            expect(card.textContent).toContain('Delivery unconfirmed')
            expect([...card.querySelectorAll('button')].every(b => b.disabled)).toBe(true)
            await act(async () => { await page.screenshot({ path: `/tmp/assistant-queue-contract-uncertain-${width}-${mode}.png` }) })
            // Foreign attempt/generation cannot settle or change the active binding.
            await publish([{ ...state.messages[0], rev: state.messages[0].rev + 1,
                outgoingReceipt: { ...state.receipts[0], state: 'submitted', proof: 'native_write_ack', generation: 'foreign', revision: 999 } }])
            expect(latest.pendingLocalMessages).toHaveLength(1)
            state = await remote({ action: 'ack', sessionId, ids: [id] })
            expect(state.receipts[0].state).toBe(mode === 'void' ? 'uncertain' : 'submitted')
            // Missing event: remount + read-only journal replay retires, without sending.
            if (mode === 'late_ack') {
                await publish(state.messages) // Post-write event can precede its queued HTTP reply.
                await act(async () => { releaseReply!();await sending! })
            }
            await act(async () => root.unmount());root=createRoot(host);lostReceipts=false;await render()
            await expect.poll(() => latest.pendingLocalMessages.length).toBe(mode === 'void' ? 1 : 0)
            expect(readPendingQueuedMessages(tabKey)).toHaveLength(mode === 'void' ? 1 : 0)
            await publish(state.messages);await publish(state.messages)
            expect(latest.pendingLocalMessages).toHaveLength(mode === 'void' ? 1 : 0)
            await remote({ action: 'restart', sessionId })
            const duplicate = await remote({ action: 'submit', sessionId, message: lastPayload })
            expect(duplicate.deduplicated).toBe(true)
            expect((await remote({ action: 'peek', sessionId, ids: [id] })).writes).toBe(2)
            expect(send.mock.calls.filter(([, type]) => type === 'send_chat')).toHaveLength(1)
            await act(async () => { await page.screenshot({ path: `/tmp/assistant-queue-contract-settled-${width}-${mode}.png` }) })
            console.log(JSON.stringify({ width, mode, sessionId, ...state.receipts[0], nativeWrites: state.writes, nativeBodyCopies: 1 }))
        } finally { await act(async () => root.unmount());host.remove();await remote({ action: 'close', sessionId }) }
    }
})
