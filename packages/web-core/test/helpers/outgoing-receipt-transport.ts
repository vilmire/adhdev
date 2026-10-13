import { outgoingInputDigest, type OutgoingReceipt } from '@adhdev/daemon-core/seqscribe/transcript-keyed-codec'
import { readPendingQueuedMessages } from '../../src/utils/pendingQueuedMessages'
const accepted = new Map<string, { receipt: OutgoingReceipt; content: string }>()
export function resetOutgoingReceiptFixture() { accepted.clear() }
function accept(id: string, content: string, input: unknown): OutgoingReceipt {
    const prior = accepted.get(id)
    if (prior) return prior.receipt
    const receipt: OutgoingReceipt = { version: 1, messageId: id, sessionId: 'sess-1', attemptId: `test-attempt-${id}`,
        generation: 'test-generation', inputDigest: outgoingInputDigest(input), state: 'accepted', revision: 1, proof: 'acceptance' }
    accepted.set(id, { receipt, content });return receipt
}
/** Legacy behavioral suites now model explicit write receipts. Replay is
 * separate from the write mock, so their native-command count guards survive. */
export function receiptAwareTransport(send: (...args: any[]) => Promise<any>, tabKey = 'tab-1') {
    return async (...args: any[]) => {
        const [, type, payload] = args
        if (type === 'outgoing_receipts') {
            for (const entry of readPendingQueuedMessages(tabKey)) {
                if (!accepted.has(entry.id) && !entry.requiresReceipt) accept(entry.id, entry.content, entry.input ?? { parts: [{ type: 'text', text: entry.content }], textFallback: entry.content })
            }
            return { success: true, receipts: payload.messageIds.flatMap((id: string) => accepted.has(id) ? [accepted.get(id)!.receipt] : []) }
        }
        const result = await send(...args)
        if (type !== 'send_chat') return result
        const receipt = accept(payload.messageId, payload.input.textFallback, payload.input)
        return { ...result, outgoingReceipt: receipt }
    }
}
/** Explicit fixture post-write signal. It is not inferred from production text. */
export function postWriteFixtureEcho(content: string) {
    const row = [...accepted.values()].find(r => r.content === content && r.receipt.state === 'accepted')
    if (!row) return { id: `echo-${content}`, role: 'user', kind: 'standard', content }
    row.receipt = { ...row.receipt, state: 'submitted', proof: 'native_write_ack', revision: row.receipt.revision + 1 }
    return { id: `echo-${content}`, role: 'user', kind: 'standard', content,
        meta: { outgoingReceipt: row.receipt, sourceMessageId: row.receipt.messageId, runtimeInputAck: true } }
}
