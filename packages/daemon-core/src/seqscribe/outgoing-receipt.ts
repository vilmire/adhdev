import { jcs, sha256HexUtf8, type JsonValue } from 'seqscribe';
/** Content-free evidence for one dashboard input. Submission means acknowledged
 * body + submit writes, never inference from an echo, FSM status or turn finish. */
export interface OutgoingReceipt {
    version: 1;
    messageId: string;
    sessionId: string;
    attemptId: string;
    generation: string;
    inputDigest: string;
    state: 'accepted' | 'submitted' | 'uncertain' | 'failed';
    revision: number;
    proof: 'acceptance' | 'native_write_ack' | 'none' | 'not_written';
}
export function readOutgoingReceipt(value: unknown): OutgoingReceipt | null {
    if (!value || typeof value !== 'object') return null;
    const r = value as Record<string, unknown>;
    if (r.version !== 1 || !['accepted', 'submitted', 'uncertain', 'failed'].includes(String(r.state))
        || !['acceptance', 'native_write_ack', 'none', 'not_written'].includes(String(r.proof))
        || !Number.isSafeInteger(r.revision) || Number(r.revision) < 1) return null;
    for (const k of ['messageId', 'sessionId', 'attemptId', 'generation', 'inputDigest']) {
        if (typeof r[k] !== 'string' || !r[k] || (r[k] as string).length > 256) return null;
    }
    if (r.state === 'submitted' && r.proof !== 'native_write_ack') return null;
    if (r.state === 'failed' && r.proof !== 'not_written') return null;
    return { version: 1, messageId: r.messageId as string, sessionId: r.sessionId as string,
        attemptId: r.attemptId as string, generation: r.generation as string, inputDigest: r.inputDigest as string,
        state: r.state as OutgoingReceipt['state'], revision: r.revision as number, proof: r.proof as OutgoingReceipt['proof'] };
}
export function sameOutgoingAttempt(a: OutgoingReceipt, b: OutgoingReceipt): boolean {
    return a.messageId === b.messageId && a.sessionId === b.sessionId && a.attemptId === b.attemptId
        && a.generation === b.generation && a.inputDigest === b.inputDigest;
}

/** Canonical image-inclusive identity; object field order cannot change an ID. */
export function outgoingInputDigest(input: unknown): string {
    return sha256HexUtf8(jcs(JSON.parse(JSON.stringify(input)) as JsonValue));
}
