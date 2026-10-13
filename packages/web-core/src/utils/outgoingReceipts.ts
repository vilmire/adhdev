import { readOutgoingReceipt, sameOutgoingAttempt, type OutgoingReceipt } from '@adhdev/daemon-core/seqscribe/transcript-keyed-codec'
export interface ReceiptPending {
    id?: string; targetSessionId?: string; inputDigest?: string; requiresReceipt?: boolean
    outgoingReceipt?: OutgoingReceipt; deliveryUncertain?: boolean; queued?: boolean
}
/** Only an authenticated command response/replay may bind the first attempt.
 * Transcript/history evidence must match that binding, including image digest. */
export function applyOutgoingReceipts<T extends ReceiptPending>(entries: readonly T[], values: readonly unknown[], allowBind = false): T[] {
    let changed = false
    const receipts = values.map(readOutgoingReceipt).filter((r): r is OutgoingReceipt => !!r)
    const next: T[] = []
    for (const entry of entries) {
        if (!entry.requiresReceipt) { next.push(entry); continue }
        let current = entry
        let submitted = false
        for (const receipt of receipts) {
            if (receipt.messageId !== entry.id || receipt.sessionId !== entry.targetSessionId || receipt.inputDigest !== entry.inputDigest) continue
            const prior = current.outgoingReceipt
            if (prior && (!sameOutgoingAttempt(prior, receipt) || receipt.revision < prior.revision)) continue
            if (!prior && !allowBind) continue
            if (receipt.state === 'submitted' && receipt.proof === 'native_write_ack') { submitted = true; break }
            if (prior && prior.revision === receipt.revision) continue
            current = { ...current, outgoingReceipt: receipt,
                deliveryUncertain: receipt.state === 'uncertain' || receipt.state === 'failed' }
        }
        if (submitted) { changed = true; continue }
        if (current !== entry) changed = true
        next.push(current)
    }
    return changed ? next : entries as T[]
}
