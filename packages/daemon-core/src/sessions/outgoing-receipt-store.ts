import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { LOG } from '../logging/logger.js';
import { readOutgoingReceipt, sameOutgoingAttempt, outgoingInputDigest, type OutgoingReceipt } from '../seqscribe/outgoing-receipt.js';

/** Metadata only. A per-ID cross-process lock covers read/modify/rename, and
 * acceptance is durably published before native input. Quarantine is a durable
 * dedupe tombstone: losing receipt evidence never authorizes another write. */
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
    private locked<T>(id: string, operation: () => T): T {
        if (!this.directory) return operation();
        fs.mkdirSync(this.directory, { recursive: true });
        const lock = this.filename(id) + '.lock';
        const deadline = Date.now() + 300;
        for (;;) {
            try { fs.mkdirSync(lock, { mode: 0o700 }); break; }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw error;
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
            }
        }
        // Never steal an abandoned lock: uncertain acceptance must not resend.
        try { return operation(); } finally { fs.rmdirSync(lock); }
    }
    isUnverified(messageId: string): boolean {
        if (!this.directory || !fs.existsSync(this.directory)) return false;
        const prefix = path.basename(this.filename(messageId)) + '.invalid-';
        return fs.readdirSync(this.directory).some(name => name.startsWith(prefix));
    }
    hasAcceptance(messageId: string): boolean {
        return this.records.has(messageId) || !!this.directory
            && (fs.existsSync(this.filename(messageId)) || this.isUnverified(messageId));
    }
    private read(messageId: string): OutgoingReceipt | undefined {
        if (!this.directory) return this.records.get(messageId);
        const file = this.filename(messageId);
        let bytes: string;
        try { bytes = fs.readFileSync(file, 'utf8'); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            const known = this.isUnverified(messageId) ? this.records.get(messageId) : undefined;
            return known ? { ...known, state: 'uncertain', proof: 'none', revision: known.revision + 1 } : undefined;
        }
        let receipt: OutgoingReceipt | null = null;
        try { receipt = readOutgoingReceipt(JSON.parse(bytes)); } catch { /* Preserve malformed JSON below. */ }
        if (receipt?.messageId === messageId) {
            this.records.set(messageId, receipt);
            return receipt;
        }
        let timestamp = Date.now();
        let quarantine = `${file}.invalid-${timestamp}`;
        while (fs.existsSync(quarantine)) quarantine = `${file}.invalid-${++timestamp}`;
        fs.renameSync(file, quarantine);
        LOG.warn('OutgoingReceipt', `Invalid outgoing receipt journal quarantined at ${quarantine}; delivery unverified, automatic resend suppressed`);
        this.syncDirectory();
        const known = this.records.get(messageId);
        return known ? { ...known, state: 'uncertain', proof: 'none', revision: known.revision + 1 } : undefined;
    }
    get(messageId: string): OutgoingReceipt | undefined {
        if (!this.directory) return this.records.get(messageId);
        if (!fs.existsSync(this.directory)) return undefined;
        return this.locked(messageId, () => this.read(messageId));
    }
    private write(receipt: OutgoingReceipt): void {
        // The reader and writer share the exact schema, including ID bounds.
        // Keep the full ID (and its filename hash) for retries of older sends.
        if (!readOutgoingReceipt(receipt)) throw new Error('Invalid outgoing receipt identity');
        if (!this.directory) { this.records.set(receipt.messageId, receipt); return; }
        const file = this.filename(receipt.messageId);
        const staging = `${file}.${randomUUID()}.tmp`;
        const fd = fs.openSync(staging, 'wx', 0o600);
        try {
            try { fs.writeFileSync(fd, JSON.stringify(receipt)); fs.fsyncSync(fd); }
            finally { fs.closeSync(fd); }
            fs.renameSync(staging, file);
            this.records.set(receipt.messageId, receipt);
            this.syncDirectory();
        } finally {
            // Only our own staging file; quarantined originals are never deleted.
            if (fs.existsSync(staging)) fs.unlinkSync(staging);
        }
    }
    accept(messageId: string, sessionId: string, input: unknown): { receipt: OutgoingReceipt; fresh: boolean } {
        return this.locked(messageId, () => {
            const inputDigest = outgoingInputDigest(input);
            const prior = this.read(messageId);
            // Memory-only callers retain their pre-write refusal retry behavior.
            if (prior && (this.directory || prior.state !== 'failed')) {
                if (prior.sessionId !== sessionId || prior.inputDigest !== inputDigest) throw new Error('Outgoing message identity conflict');
                return { receipt: prior, fresh: false };
            }
            const unverified = this.isUnverified(messageId);
            const receipt: OutgoingReceipt = { version: 1, messageId, sessionId, inputDigest,
                attemptId: randomUUID(), generation: randomUUID(), state: unverified ? 'uncertain' : 'accepted',
                revision: 1, proof: unverified ? 'none' : 'acceptance' };
            this.write(receipt);
            return { receipt, fresh: !unverified };
        });
    }
    advance(expected: OutgoingReceipt, state: OutgoingReceipt['state']): OutgoingReceipt | undefined {
        return this.locked(expected.messageId, () => {
            const current = this.read(expected.messageId);
            if (!current || !sameOutgoingAttempt(current, expected)) return undefined;
            if (this.isUnverified(expected.messageId)) return { ...current, state: 'uncertain', proof: 'none' };
            if (current.state === 'submitted' || current.state === 'failed' || state === 'accepted' || state === current.state) return current;
            const next = { ...current, state, revision: current.revision + 1,
                proof: state === 'submitted' ? 'native_write_ack' : state === 'failed' ? 'not_written' : 'none' } as OutgoingReceipt;
            this.write(next);
            return next;
        });
    }
    list(sessionId: string, ids: readonly string[]): OutgoingReceipt[] {
        return ids.slice(0, 32).flatMap(id => { const r = this.get(id); return r?.sessionId === sessionId ? [{ ...r }] : []; });
    }
}
