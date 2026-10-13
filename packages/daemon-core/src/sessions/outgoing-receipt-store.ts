import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readOutgoingReceipt, sameOutgoingAttempt, outgoingInputDigest, type OutgoingReceipt } from '../seqscribe/outgoing-receipt.js';

/** Metadata only. Atomic per-ID reservation precedes native writes, including
 * across independent daemon/store instances. An ambiguous identity is retained. */
export class OutgoingReceiptStore {
    private readonly records = new Map<string, OutgoingReceipt>();
    constructor(private readonly directory?: string) {}
    private filename(id: string): string {
        return path.join(this.directory!, createHash('sha256').update(id).digest('hex') + '.json');
    }
    private syncDirectory(): void {
        if (!this.directory || process.platform === 'win32') return;
        const fd = fs.openSync(this.directory, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    get(messageId: string): OutgoingReceipt | undefined {
        if (!this.directory) return this.records.get(messageId);
        const file = this.filename(messageId);
        if (!fs.existsSync(file)) return undefined;
        const receipt = readOutgoingReceipt(JSON.parse(fs.readFileSync(file, 'utf8')));
        if (!receipt || receipt.messageId !== messageId) throw new Error('Invalid outgoing receipt journal');
        return receipt;
    }
    accept(messageId: string, sessionId: string, input: unknown): { receipt: OutgoingReceipt; fresh: boolean } {
        const inputDigest = outgoingInputDigest(input);
        const existing = () => {
            const prior = this.get(messageId);
            if (!prior || prior.sessionId !== sessionId || prior.inputDigest !== inputDigest) throw new Error('Outgoing message identity conflict');
            return { receipt: prior, fresh: false };
        };
        const prior = this.get(messageId);
        // Memory-only callers retain their pre-write refusal retry behavior.
        // Durable dashboard callers use a fresh ID after an explicit rejection.
        if (prior && (this.directory || prior.state !== 'failed')) return existing();
        const receipt: OutgoingReceipt = { version: 1, messageId, sessionId, inputDigest,
            attemptId: randomUUID(), generation: randomUUID(), state: 'accepted', revision: 1, proof: 'acceptance' };
        if (this.directory) {
            fs.mkdirSync(this.directory, { recursive: true });
            let fd: number;
            try { fd = fs.openSync(this.filename(messageId), 'wx', 0o600); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return existing(); throw error; }
            try { fs.writeFileSync(fd, JSON.stringify(receipt)); fs.fsyncSync(fd); }
            finally { fs.closeSync(fd); }
            this.syncDirectory();
        } else this.records.set(messageId, receipt);
        return { receipt, fresh: true };
    }
    advance(expected: OutgoingReceipt, state: OutgoingReceipt['state']): OutgoingReceipt | undefined {
        const current = this.get(expected.messageId);
        if (!current || !sameOutgoingAttempt(current, expected)) return undefined;
        if (current.state === 'submitted' || current.state === 'failed' || state === 'accepted' || state === current.state) return current;
        const next = { ...current, state, revision: current.revision + 1,
            proof: state === 'submitted' ? 'native_write_ack' : state === 'failed' ? 'not_written' : 'none' } as OutgoingReceipt;
        if (this.directory) {
            const file = this.filename(current.messageId);
            const staging = `${file}.${randomUUID()}.tmp`;
            const fd = fs.openSync(staging, 'wx', 0o600);
            try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); }
            finally { fs.closeSync(fd); }
            fs.renameSync(staging, file); this.syncDirectory();
        } else this.records.set(current.messageId, next);
        return next;
    }
    list(sessionId: string, ids: readonly string[]): OutgoingReceipt[] {
        return ids.slice(0, 32).flatMap(id => { const r = this.get(id); return r?.sessionId === sessionId ? [{ ...r }] : []; });
    }
}
