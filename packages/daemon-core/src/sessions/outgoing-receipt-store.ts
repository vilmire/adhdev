import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { LOG } from '../logging/logger.js';
import { acquireOwnedLock } from '../launch-defaults/owned-lock.js';
import { readOutgoingReceipt, sameOutgoingAttempt, outgoingInputDigest, type OutgoingReceipt } from '../seqscribe/outgoing-receipt.js';

/** Metadata only. A per-ID cross-process lock covers read/modify/rename, and
 * acceptance is durably published before native input. Quarantine is a durable
 * dedupe tombstone: losing receipt evidence never authorizes another write. */
export class OutgoingReceiptStore {
    private readonly records = new Map<string, OutgoingReceipt>();
    constructor(private readonly directory?: string) {
        if (!directory) return;
        let names: string[];
        try { names = fs.readdirSync(directory); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        // One startup migration for timestamped quarantines from older builds.
        // Hot-path lookups use a fixed marker name, never a directory scan.
        for (const name of names) {
            if (!/^[a-f0-9]{64}\.json\.invalid-\d+$/.test(name)) continue;
            this.markInvalid(path.join(directory, name.slice(0, name.indexOf('.invalid-'))), path.join(directory, name));
        }
    }
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
        // These transactions never await. Expire crashed/stalled ownership after
        // 30 seconds, but spend at most 10 ms explicitly waiting on a live peer.
        const deadline = performance.now() + 10;
        let waitBudget = 10;
        for (;;) {
            const acquired = acquireOwnedLock(lock, { maxAgeMs: 30_000 });
            if (acquired.ok) {
                try { return operation(); } finally { acquired.release(); }
            }
            const remaining = Math.min(waitBudget, deadline - performance.now());
            if (!acquired.busy || remaining <= 0) throw Object.assign(new Error(acquired.reason), { code: acquired.errno ?? 'EEXIST' });
            const delay = Math.min(1, remaining);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
            waitBudget -= delay;
        }
    }
    isUnverified(messageId: string): boolean {
        return !!this.directory && fs.existsSync(this.filename(messageId) + '.invalid');
    }
    private markInvalid(file: string, source = file): void {
        // A hard link preserves the original bytes and atomically establishes a
        // fixed-name tombstone BEFORE the timestamped quarantine rename. A crash
        // between these operations therefore cannot permit a duplicate send.
        try { fs.linkSync(source, file + '.invalid'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
        this.syncDirectory();
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
        this.markInvalid(file);
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
