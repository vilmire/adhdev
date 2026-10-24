import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { afterEach, expect, it, vi } from 'vitest';
import { OutgoingReceiptStore } from '../../src/sessions/outgoing-receipt-store.js';
import { createSessionInputService } from '../../src/sessions/session-input-service.js';
import { LOG } from '../../src/logging/logger.js';

vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const directories: string[] = [];
const input = { parts: [{ type: 'text', text: 'Synthetic input' }], textFallback: 'Synthetic input' };
function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-receipt-store-'));
    directories.push(directory);
    const file = path.join(directory, createHash('sha256').update('message').digest('hex') + '.json');
    return { directory, file, store: new OutgoingReceiptStore(directory) };
}
afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

it.each(['{"version":', '{"version":2}', '{"version":1,"state":"alien"}', 'foreign_id'])(
    'quarantines %s unchanged with a warning and never admits a fresh retry, even after restart', invalid => {
        const f = fixture();
        const receipt = f.store.accept('message', 'session', input).receipt;
        const bytes = invalid === 'foreign_id' ? JSON.stringify({ ...receipt, messageId: 'foreign' }) : invalid;
        fs.writeFileSync(f.file, bytes);
        const warn = vi.spyOn(LOG, 'warn');
        const restored = new OutgoingReceiptStore(f.directory);
        expect(restored.get('message')).toBeUndefined();
        const quarantined = fs.readdirSync(f.directory).filter(file => file.includes('.invalid-'));
        expect(quarantined).toHaveLength(1);
        expect(fs.readFileSync(path.join(f.directory, quarantined[0]), 'utf8')).toBe(bytes);
        expect(warn).toHaveBeenCalledWith('OutgoingReceipt', expect.stringContaining('quarantined'));
        expect(restored.accept('message', 'session', input)).toMatchObject({ fresh: false, receipt: { state: 'uncertain', proof: 'none' } });
        expect(new OutgoingReceiptStore(f.directory).accept('message', 'session', input).fresh).toBe(false);
        expect(fs.readFileSync(path.join(f.directory, quarantined[0]), 'utf8')).toBe(bytes);
    },
);

it('validates writer identity before publishing and exposes only complete JSON at rename', () => {
    const f = fixture();
    expect(() => f.store.accept('message', 's'.repeat(257), input)).toThrow('Invalid outgoing receipt identity');
    expect(fs.existsSync(f.file)).toBe(false);
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        expect(fs.existsSync(f.file)).toBe(false);
        expect(JSON.parse(fs.readFileSync(source, 'utf8'))).toMatchObject({ messageId: 'message', state: 'accepted' });
        rename(source, destination);
    });
    expect(f.store.accept('message', 'session', input).fresh).toBe(true);
    expect(f.store.get('message')).toMatchObject({ state: 'accepted' });
    expect(fs.readdirSync(f.directory)).toEqual([path.basename(f.file)]);
});

it('does not publish a partial acceptance when the staging write fails', () => {
    const f = fixture();
    const write = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
        if (typeof file === 'number') throw new Error('synthetic disk failure');
        write(file, data, options);
    });
    expect(() => f.store.accept('message', 'session', input)).toThrow('synthetic disk failure');
    expect(fs.existsSync(f.file)).toBe(false);
    expect(fs.readdirSync(f.directory)).toEqual([]);
});

it('recovers a receipt lock left by a dead PID and records its new owner', () => {
    const f = fixture();
    const child = spawnSync(process.execPath, ['-e', '']);
    expect(child.status).toBe(0);
    const lock = f.file + '.lock';
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: child.pid, nonce: 'dead', acquiredAt: Date.now() }));
    const rename = fs.renameSync;
    const owners: any[] = [];
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        owners.push(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')));
        rename(source, destination);
    });
    expect(f.store.accept('message', 'session', input).fresh).toBe(true);
    expect(owners).toEqual([expect.objectContaining({ pid: process.pid, acquiredAt: expect.any(Number), nonce: expect.any(String) })]);
    expect(fs.existsSync(lock)).toBe(false);
});

it('recovers an ownerless receipt lock after 30 seconds', () => {
    const f = fixture();
    const lock = f.file + '.lock';
    fs.mkdirSync(lock);
    fs.utimesSync(lock, new Date(0), new Date(Date.now() - 31_000));
    expect(f.store.accept('message', 'session', input).fresh).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
});

it.each([0, 31_000, 86_400_000])('keeps a live owner aged %i ms and caps explicit contention waits at 10 ms', age => {
    const f = fixture();
    const lock = f.file + '.lock';
    fs.mkdirSync(lock);
    const owner = JSON.stringify({ pid: process.pid, nonce: 'live', acquiredAt: Date.now() - age });
    fs.writeFileSync(path.join(lock, 'owner.json'), owner);
    const wait = vi.spyOn(Atomics, 'wait');
    expect(() => f.store.accept('message', 'session', input)).toThrow();
    const waits = wait.mock.calls.map(call => Number(call[3]));
    expect(waits.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(10);
    expect(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).toBe(owner);
    expect(fs.existsSync(f.file)).toBe(false);
});

it.each(['accept', 'advance'] as const)('excludes a competing writer while %s stalls before rename beyond the old TTL', operation => {
    const f = fixture();
    const peer = new OutgoingReceiptStore(f.directory);
    const initial = operation === 'advance' ? f.store.accept('message', 'session', input).receipt : undefined;
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const rename = fs.renameSync;
    let stalled = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        if (!stalled && String(destination) === f.file) {
            stalled = true;
            const ownerFile = path.join(f.file + '.lock', 'owner.json');
            const owner = fs.readFileSync(ownerFile, 'utf8');
            clock.mockReturnValue(now + 31_000);
            // The original repro let this peer accept fresh, advance submitted,
            // then lose that proof when the first writer resumed its rename.
            expect(() => peer.accept('message', 'session', input)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
            if (initial) expect(() => peer.advance(initial, 'submitted')).toThrow(expect.objectContaining({ code: 'EEXIST' }));
            expect(fs.readFileSync(ownerFile, 'utf8')).toBe(owner);
        }
        rename(source, destination);
    });
    const first = initial ? f.store.advance(initial, 'uncertain')! : f.store.accept('message', 'session', input).receipt;
    expect(stalled).toBe(true);
    const second = peer.accept('message', 'session', input);
    expect(second).toMatchObject({ fresh: false, receipt: { attemptId: first.attemptId, generation: first.generation } });
    expect(peer.advance(second.receipt, 'submitted')).toMatchObject({ state: 'submitted', proof: 'native_write_ack' });
    expect(f.store.advance(first, 'uncertain')).toMatchObject({ state: 'submitted', proof: 'native_write_ack' });
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toMatchObject({ attemptId: first.attemptId, state: 'submitted', proof: 'native_write_ack' });
});

it('detects tombstones across stores without scanning the directory on submit', () => {
    const f = fixture();
    fs.writeFileSync(f.file, '{"version":');
    expect(f.store.get('message')).toBeUndefined();
    const restored = new OutgoingReceiptStore(f.directory);
    const scan = vi.spyOn(fs, 'readdirSync').mockImplementation(() => { throw new Error('unexpected journal scan'); });
    expect(restored.isUnverified('message')).toBe(true);
    expect(restored.hasAcceptance('message')).toBe(true);
    expect(restored.hasAcceptance('absent')).toBe(false);
    expect(restored.accept('message', 'session', input).fresh).toBe(false);
    expect(scan).not.toHaveBeenCalled();
});

it('indexes legacy timestamped quarantines once at startup without deleting their bytes', () => {
    const f = fixture();
    const legacy = f.file + '.invalid-123';
    fs.writeFileSync(legacy, '{"version":');
    const restored = new OutgoingReceiptStore(f.directory);
    const scan = vi.spyOn(fs, 'readdirSync');
    expect(restored.hasAcceptance('message')).toBe(true);
    expect(restored.accept('message', 'session', input).fresh).toBe(false);
    expect(scan).not.toHaveBeenCalled();
    expect(fs.readFileSync(legacy, 'utf8')).toBe('{"version":');
    expect(fs.existsSync(f.file + '.invalid')).toBe(true);
});

it('serializes independent processes accepting and advancing the same ID without downgrading submitted', async () => {
    const f = fixture();
    const bundle = path.join(f.directory, 'store.cjs');
    buildSync({ entryPoints: [path.resolve('src/sessions/outgoing-receipt-store.ts')], outfile: bundle,
        bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const startAt = Date.now() + 500;
    const run = (state: string) => new Promise<{ fresh: boolean; attemptId: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', `
            const { OutgoingReceiptStore } = require(process.argv[1]);
            const store = new OutgoingReceiptStore(process.argv[2]);
            // Contending callers yield between short store attempts instead of
            // relying on a 300 ms main-thread wait inside the store.
            async function retry(operation) {
                for (let attempt = 0; ; attempt++) {
                    try { return operation(); }
                    catch (error) {
                        if (error.code !== 'EEXIST' || attempt >= 100) throw error;
                        await new Promise(resolve => setTimeout(resolve, 5));
                    }
                }
            }
            (async () => {
                await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(process.argv[3]) - Date.now())));
                const {receipt, fresh} = await retry(() => store.accept('message', 'session', JSON.parse(process.argv[4])));
                await retry(() => store.advance(receipt, process.argv[5]));
                process.stdout.write(JSON.stringify({fresh, attemptId: receipt.attemptId}));
            })().catch(error => { process.stderr.write(error.stack); process.exitCode = 1; });
        `, bundle, f.directory, String(startAt), JSON.stringify(input), state]);
        let stdout = '', stderr = '';
        child.stdout.on('data', data => { stdout += data; });
        child.stderr.on('data', data => { stderr += data; });
        child.on('error', reject);
        child.on('close', code => {
            if (code !== 0) { reject(new Error(stderr)); return; }
            try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
        });
    });
    const results = await Promise.all([run('submitted'), run('uncertain')]);
    expect(results.filter(result => result.fresh)).toHaveLength(1);
    expect(results[0].attemptId).toBe(results[1].attemptId);
    expect(f.store.get('message')).toMatchObject({ state: 'submitted', proof: 'native_write_ack' });
});

it('protects a separate process blocked before rename across a forward clock jump', async () => {
    const f = fixture();
    const bundle = path.join(f.directory, 'store.cjs');
    buildSync({ entryPoints: [path.resolve('src/sessions/outgoing-receipt-store.ts')], outfile: bundle,
        bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const child = spawn(process.execPath, ['-e', `
        const fs = require('node:fs');
        const { OutgoingReceiptStore } = require(process.argv[1]);
        const rename = fs.renameSync;
        fs.renameSync = (source, destination) => {
            if (destination === process.argv[3]) {
                fs.writeSync(1, 'staged\\n');
                // A real synchronous stall at the original repro's publication
                // boundary. The parent advances its clock before contending.
                if (fs.readFileSync(0, 'utf8') !== 'resume') throw new Error('missing resume');
            }
            return rename(source, destination);
        };
        const store = new OutgoingReceiptStore(process.argv[2]);
        process.stdout.write(JSON.stringify(store.accept('message', 'session', JSON.parse(process.argv[4]))));
    `, bundle, f.directory, f.file, JSON.stringify(input)]);
    let stdout = '', stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const exited = new Promise<number | null>(resolve => child.once('close', resolve));
    const staged = new Promise<void>((resolve, reject) => {
        child.stdout.on('data', data => { stdout += data; if (stdout.startsWith('staged\n')) resolve(); });
        child.once('error', reject);
        child.once('close', () => reject(new Error(stderr || 'writer exited before staging')));
    });
    try {
        await staged;
        const ownerFile = path.join(f.file + '.lock', 'owner.json');
        const owner = fs.readFileSync(ownerFile, 'utf8');
        expect(JSON.parse(owner).pid).toBe(child.pid);
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
        expect(() => f.store.accept('message', 'session', input)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
        expect(fs.readFileSync(ownerFile, 'utf8')).toBe(owner);
        expect(fs.existsSync(f.file)).toBe(false);
    } finally {
        child.stdin.end('resume');
        await exited;
    }
    expect(await exited, stderr).toBe(0);
    const first = JSON.parse(stdout.slice('staged\n'.length));
    expect(first.fresh).toBe(true);
    const retry = f.store.accept('message', 'session', input);
    expect(retry).toMatchObject({ fresh: false, receipt: { attemptId: first.receipt.attemptId } });
    expect(f.store.advance(retry.receipt, 'submitted')).toMatchObject({ state: 'submitted', proof: 'native_write_ack' });
    expect(new OutgoingReceiptStore(f.directory).get('message')).toMatchObject({
        attemptId: first.receipt.attemptId, state: 'submitted', proof: 'native_write_ack',
    });
});

it('uses a quarantine tombstone to dedupe non-dashboard input without preparation after restart', async () => {
    const f = fixture();
    fs.writeFileSync(f.file, '{"version":');
    expect(f.store.get('message')).toBeUndefined();
    const sendMessage = vi.fn(async () => ({ status: 'delivered' as const }));
    const service = createSessionInputService({ receiptStore: new OutgoingReceiptStore(f.directory),
        resolveSession: () => ({ sendMessage }) });
    expect(await service.submit({ messageId: 'message', sessionId: 'session', input, origin: 'assistant',
        policy: { mode: 'queue' }, createdAt: 1 } as any)).toMatchObject({ kind: 'duplicate' });
    expect(sendMessage).not.toHaveBeenCalled();
});


it('never spawns ps or sysctl while acquiring a receipt lock', () => {
    const f = fixture();
    const probe = vi.mocked(execFileSync);
    probe.mockClear();
    expect(f.store.accept('message', 'session', input).fresh).toBe(true);
    expect(probe).not.toHaveBeenCalled();
});
