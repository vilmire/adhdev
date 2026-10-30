import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIRST_JSONL_RECORD_MAX_BYTES as CAP, readFirstJsonlRecord } from '../../../src/providers/native-history/first-jsonl-record.js';
import { pickSessionBoundFile, readCandidateSessionMeta } from '../../../src/providers/spec/native-history-paths.js';

vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>();
    const mocked = { ...actual, readSync: vi.fn(actual.readSync), closeSync: vi.fn(actual.closeSync) };
    return { ...mocked, default: mocked };
});

const dirs: string[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function file(data: string | Buffer): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-jsonl-')); dirs.push(dir);
    const name = path.join(dir, 'synthetic.jsonl'); fs.writeFileSync(name, data); return name;
}
const meta = { type: 'session_meta', payload: { cwd: '/synthetic/workspace', timestamp: 1790000000000 } };
function sizedRecord(size: number): string {
    const empty = JSON.stringify({ ...meta, padding: '' });
    return JSON.stringify({ ...meta, padding: 'x'.repeat(size - Buffer.byteLength(empty)) });
}

describe('bounded first JSONL record', () => {
    it.each(['\n', ''])('reads a short record with terminator %j and ignores later records', end => {
        const name = file(JSON.stringify(meta) + end + (end ? '{broken second record' : ''));
        expect(readFirstJsonlRecord(name)).toEqual(meta);
        expect(readCandidateSessionMeta(name)).toEqual({ cwd: meta.payload.cwd, sessionTimestampMs: meta.payload.timestamp });
    });
    it.each([false, true])('reads 22 KiB metadata with instructions before identity=%s and split UTF-8', before => {
        const prefix = '{"type":"session_meta","payload":{"base_instructions":"';
        // Put the first byte of a three-byte character at offset 8191.
        const instructions = 'x'.repeat(8191 - Buffer.byteLength(prefix)) + '한' + 'y'.repeat(14000);
        const payload = before ? { base_instructions: instructions, ...meta.payload }
            : { ...meta.payload, base_instructions: instructions };
        const name = file(JSON.stringify({ type: 'session_meta', payload }) + '\n');
        expect(readFirstJsonlRecord(name)).toEqual({ type: 'session_meta', payload });
        expect(readCandidateSessionMeta(name)).toEqual({ cwd: meta.payload.cwd, sessionTimestampMs: meta.payload.timestamp });
    });
    it.each(['\n', ''])('accepts the exact byte cap with terminator %j', end => {
        const name = file(sizedRecord(CAP) + end);
        expect(readFirstJsonlRecord(name)?.type).toBe('session_meta');
        expect(readCandidateSessionMeta(name)?.cwd).toBe(meta.payload.cwd);
    });
    it.each(['', '{broken}\n', JSON.stringify(meta).slice(0, -1), 'null', '[]', '\n' + JSON.stringify(meta)])('fails closed for empty, malformed or truncated first records: %j', data => {
        expect(readFirstJsonlRecord(file(data))).toBeNull();
        expect(readCandidateSessionMeta(file(data))).toBeNull();
    });
    it.each(['\n', ''])('rejects over-cap records with terminator %j without reading history', end => {
        const name = file(sizedRecord(CAP + 1) + end + 'z'.repeat(CAP));
        const read = vi.mocked(fs.readSync); read.mockClear();
        expect(readFirstJsonlRecord(name)).toBeNull();
        expect(read.mock.calls.reduce((sum, call) => sum + Number(call[3]), 0)).toBe(CAP + 1);
        expect(readCandidateSessionMeta(name)).toBeNull();
    });
    it('does not accept a valid JSON prefix followed by bytes beyond the cap', () => {
        expect(readFirstJsonlRecord(file(sizedRecord(CAP) + 'x\n'))).toBeNull();
    });
    it('rejects invalid UTF-8 instead of silently replacing identity bytes', () => {
        const data = Buffer.from(JSON.stringify(meta)); data[data.indexOf('synthetic')] = 0xff;
        expect(readFirstJsonlRecord(file(data))).toBeNull();
    });
    it('handles short reads and closes its descriptor on parse failure', () => {
        const original = vi.mocked(fs.readSync).getMockImplementation()!;
        const read = vi.mocked(fs.readSync); read.mockClear();
        read.mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
            original(fd, buffer, offset, Math.min(length, 7), position)) as typeof fs.readSync);
        const close = vi.mocked(fs.closeSync); close.mockClear();
        expect(readFirstJsonlRecord(file(JSON.stringify(meta)))).toEqual(meta);
        expect(read.mock.calls.length).toBeGreaterThan(2);
        expect(readFirstJsonlRecord(file('{broken'))).toBeNull();
        expect(close).toHaveBeenCalledTimes(2);
        read.mockImplementation(original);
    });
    it('fails closed for missing files and non-session records', () => {
        const name = file('{"type":"response_item","payload":{}}');
        expect(readCandidateSessionMeta(name)).toBeNull();
        expect(readFirstJsonlRecord(name + '.missing')).toBeNull();
    });
    it('binds large spec candidates by workspace and spawn time despite a newer competitor', () => {
        const start = Date.now();
        const name = file(JSON.stringify({ type: 'session_meta', payload: {
            base_instructions: 'x'.repeat(22000), cwd: meta.payload.cwd, timestamp: start + 2237,
        } }) + '\n');
        const dir = path.dirname(name);
        const pick = () => pickSessionBoundFile(dir, /\.jsonl$/, 300_000, start, meta.payload.cwd);
        expect(pick()).toBe(name);
        const competitor = path.join(dir, 'competitor.jsonl');
        for (const payload of [
            { cwd: '/synthetic/other', timestamp: start },
            { cwd: meta.payload.cwd, timestamp: start + 10_001 },
        ]) {
            fs.writeFileSync(competitor, JSON.stringify({ type: 'session_meta', payload }));
            expect(pick()).toBe(name);
        }
        fs.writeFileSync(name, '{truncated');
        expect(pick()).toBeNull();
    });
});
