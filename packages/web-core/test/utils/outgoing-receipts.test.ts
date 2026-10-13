import { expect, it } from 'vitest'
import { applyOutgoingReceipts } from '../../src/utils/outgoingReceipts'
import { readOutgoingReceipt } from '@adhdev/daemon-core/seqscribe/transcript-keyed-codec'
const accepted = { version: 1, messageId: 'message', sessionId: 'session', attemptId: 'attempt', generation: 'generation',
    inputDigest: 'image-inclusive-digest', state: 'accepted', proof: 'acceptance', revision: 1 } as const
const submitted = { ...accepted, state: 'submitted', proof: 'native_write_ack', revision: 3 } as const
const pending = { id: accepted.messageId, targetSessionId: accepted.sessionId, inputDigest: accepted.inputDigest,
    requiresReceipt: true, outgoingReceipt: accepted }
it('never treats acceptance as settlement, binds only authoritative replay and retires exact post-write evidence', () => {
    const unbound = { ...pending, outgoingReceipt: undefined }
    expect(applyOutgoingReceipts([unbound], [submitted])).toEqual([unbound])
    expect(applyOutgoingReceipts([unbound], [accepted], true)).toHaveLength(1)
    expect(applyOutgoingReceipts([pending], [accepted])).toEqual([pending])
    expect(applyOutgoingReceipts([pending], [submitted])).toEqual([])
})
it.each(['messageId', 'sessionId', 'attemptId', 'generation', 'inputDigest'] as const)('rejects foreign %s without changing the pending row', field => {
    expect(applyOutgoingReceipts([pending], [{ ...submitted, [field]: 'foreign' }])).toEqual([pending])
})
it('ignores out-of-order and malformed receipts and keeps explicit uncertainty/failure visible', () => {
    const uncertain = { ...accepted, state: 'uncertain', proof: 'none', revision: 2 } as const
    const entries = applyOutgoingReceipts([pending], [uncertain])
    expect(entries[0].deliveryUncertain).toBe(true)
    expect(applyOutgoingReceipts(entries, [accepted])).toBe(entries)
    expect(readOutgoingReceipt({ ...submitted, proof: 'acceptance' })).toBeNull()
    expect(applyOutgoingReceipts(entries, [{ ...submitted, proof: 'acceptance' }])).toBe(entries)
    expect(applyOutgoingReceipts(entries, [{ ...submitted, state: 'failed', proof: 'not_written' }])).toHaveLength(1)
    expect(applyOutgoingReceipts(entries, [submitted, submitted])).toEqual([])
})
