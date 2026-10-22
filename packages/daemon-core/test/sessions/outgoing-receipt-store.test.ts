import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { afterEach, expect, it, vi } from 'vitest';
import { OutgoingReceiptStore } from '../../src/sessions/outgoing-receipt-store.js';
import { createSessionInputService } from '../../src/sessions/session-input-service.js';
import { LOG } from '../../src/logging/logger.js';

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

it.each([true, false])('recovers an expired receipt lock (owner record: %s)', owned => {
    const f = fixture();
    const lock = f.file + '.lock';
    fs.mkdirSync(lock);
    if (owned) fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, nonce: 'expired', acquiredAt: Date.now() - 31_000 }));
    else fs.utimesSync(lock, new Date(0), new Date(Date.now() - 31_000));
    expect(f.store.accept('message', 'session', input).fresh).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
});

it('keeps a fresh live owner and caps explicit contention waits at 10 ms', () => {
    const f = fixture();
    const lock = f.file + '.lock';
    fs.mkdirSync(lock);
    const owner = JSON.stringify({ pid: process.pid, nonce: 'live', acquiredAt: Date.now() });
    fs.writeFileSync(path.join(lock, 'owner.json'), owner);
    const wait = vi.spyOn(Atomics, 'wait');
    expect(() => f.store.accept('message', 'session', input)).toThrow();
    const waits = wait.mock.calls.map(call => Number(call[3]));
    expect(waits.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(10);
    expect(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).toBe(owner);
    expect(fs.existsSync(f.file)).toBe(false);
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
