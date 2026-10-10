import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions } from '../../../src/cli-adapters/pty-transport.js';
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js';
import {
    WIN32_VK_PACKET,
    chunkWin32TerminalInput,
    decodeWin32InputMode,
    encodeWin32TerminalInput,
} from '../../../src/providers/spec/win32-input-mode.js';
import { handlePtyInput } from '../../../src/commands/stream-commands.js';

// RAW terminal input (dashboard xterm → `pty_input`) on a win32 agy session:
// non-ASCII text must become win32-input-mode key records exactly like a chat
// body (agy drops `— “ ” … € → ✓ · ×` and emoji as plain UTF-8 through ConPTY),
// while every escape sequence the terminal emulator generated reaches the PTY
// byte-for-byte. Both pty_input paths — the standalone `pty_input` command
// (handlePtyInput) and the cloud P2P frame (cloud-p2p-wiring.ts) — end in
// SpecCliAdapter.writeRaw, which is where the encoding lives.

const rec = (u: number, down: 0 | 1) => `\x1b[${WIN32_VK_PACKET};0;${u};${down};0;1_`;
const bmp = (ch: string) => rec(ch.charCodeAt(0), 1) + rec(ch.charCodeAt(0), 0);

const ORIGINAL_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
afterEach(() => { setPlatform(ORIGINAL_PLATFORM); vi.useRealTimers(); });

describe('encodeWin32TerminalInput', () => {
    it('ASCII and control bytes pass through untouched', () => {
        const ascii = 'ls -la\r\x03\x7f\t\x1b';
        expect(encodeWin32TerminalInput(ascii)).toBe(ascii);
    });

    it('escape sequences pass through untouched: CSI, SS3, Ctrl/Shift arrows, SGR mouse, focus, OSC reply, paste markers', () => {
        const seqs = [
            '\x1b[A', '\x1b[1;5C', '\x1bOA', '\x1b[3~', '\x1b[27;2;13~',
            '\x1b[<0;120;40M', '\x1b[<0;120;40m', '\x1b[I', '\x1b[O',
            '\x1b]11;rgb:0000/0000/0000\x1b\\', '\x1b]10;rgb:ffff/ffff/ffff\x07',
            '\x1b[200~', '\x1b[201~',
        ];
        for (const s of seqs) expect(encodeWin32TerminalInput(s)).toBe(s);
        expect(encodeWin32TerminalInput(seqs.join(''))).toBe(seqs.join(''));
    });

    it('escape sequences that carry non-ASCII payload are NOT re-encoded (X10 mouse, Alt/Meta key)', () => {
        const x10 = `\x1b[M ${String.fromCharCode(32 + 150)}${String.fromCharCode(32 + 120)}`; // col 150 → char ≥ 0x80
        expect(encodeWin32TerminalInput(x10)).toBe(x10);
        expect(encodeWin32TerminalInput('\x1bé')).toBe('\x1bé');
        expect(encodeWin32TerminalInput('\x1b🙂')).toBe('\x1b🙂');
    });

    it('non-ASCII typed text is encoded as key records (letters too, as on the chat path)', () => {
        expect(encodeWin32TerminalInput('—')).toBe(bmp('—'));
        expect(encodeWin32TerminalInput('a→b')).toBe(`a${bmp('→')}b`);
        expect(encodeWin32TerminalInput('한')).toBe(bmp('한'));
    });

    it('surrogate pair: both downs, then the ups in reverse (live-proven order)', () => {
        expect(encodeWin32TerminalInput('🙂')).toBe(rec(0xd83d, 1) + rec(0xde42, 1) + rec(0xde42, 0) + rec(0xd83d, 0));
    });

    it('bracketed paste keeps its markers and encodes only the body', () => {
        const pasted = '\x1b[200~x — “q” 🙂\ry\x1b[201~';
        const enc = encodeWin32TerminalInput(pasted);
        expect(enc.startsWith('\x1b[200~x')).toBe(true);
        expect(enc.endsWith('y\x1b[201~')).toBe(true);
        expect(/[^\x00-\x7f]/.test(enc)).toBe(false);
        expect(decodeWin32InputMode(enc)).toBe(pasted);
    });

    it('chunking never cuts an escape sequence or a record group', () => {
        const atom = ['\x1b[200~', '\x1b[<0;120;40M', '\x1b]11;rgb:0000/0000/0000\x1b\\', '\x1b[1;5C'];
        const data = Array.from({ length: 60 }, (_, i) => `${atom[i % atom.length]}${i}—🙂ab`).join('');
        const segments = chunkWin32TerminalInput(data, 40);
        expect(segments.join('')).toBe(encodeWin32TerminalInput(data));
        // Every escape sequence and every key record lands whole inside one
        // segment: per-segment occurrence counts add up to the joined count.
        const count = (hay: string, needle: string) => hay.split(needle).length - 1;
        const joined = segments.join('');
        for (const needle of [...atom, rec(0xd83d, 1), rec(0xde42, 0), rec(0x2014, 1)]) {
            expect(segments.reduce((n, seg) => n + count(seg, needle), 0)).toBe(count(joined, needle));
        }
        // …and the surrogate pair's four records never straddle a boundary.
        const pair = rec(0xd83d, 1) + rec(0xde42, 1) + rec(0xde42, 0) + rec(0xd83d, 0);
        expect(segments.reduce((n, seg) => n + count(seg, pair), 0)).toBe(60);
    });
});

/** A real SpecCliAdapter (built without the constructor, like the other adapter
 *  tests) whose driver records every pty_write it dispatches. */
function makeAdapter(flag: boolean | undefined): { adapter: any; writes: string[] } {
    const writes: string[] = [];
    const adapter: any = Object.create(SpecCliAdapter.prototype);
    Object.assign(adapter, {
        cliType: 'antigravity-cli',
        cliName: 'Antigravity',
        spec: { id: 'antigravity-cli', name: 'Antigravity', ...(flag === undefined ? {} : { win32_input_mode_non_ascii: flag }) },
        activeInteractivePrompt: null,
        claudeTuiPromptCaptureInFlight: false,
        claudeTuiCaptureSuppressed: false,
        driver: {
            snapshot: () => '',
            dispatch: (event: any) => { if (event?.kind === 'pty_write') writes.push(event.data); },
        },
    });
    return { adapter, writes };
}

describe('SpecCliAdapter.writeRaw — the shared pty_input seam', () => {
    const typed = 'a — “q” 🙂\x1b[A\x1b[200~€\x1b[201~';

    it('win32 + spec flag: non-ASCII encoded, ASCII and escapes intact', () => {
        setPlatform('win32');
        const { adapter, writes } = makeAdapter(true);
        adapter.writeRaw(typed);
        expect(writes).toEqual([encodeWin32TerminalInput(typed)]);
        expect(/[^\x00-\x7f]/.test(writes[0])).toBe(false);
        expect(writes[0]).toContain('\x1b[A');
        expect(decodeWin32InputMode(writes[0])).toBe(typed);
    });

    it('flag off or absent → raw (unchanged)', () => {
        setPlatform('win32');
        for (const flag of [false, undefined]) {
            const { adapter, writes } = makeAdapter(flag);
            adapter.writeRaw(typed);
            expect(writes).toEqual([typed]);
        }
    });

    it('off win32 → raw even with the flag', () => {
        setPlatform('linux');
        const { adapter, writes } = makeAdapter(true);
        adapter.writeRaw(typed);
        expect(writes).toEqual([typed]);
    });

    it('a large paste is paced in bounded segments, and a keystroke typed meanwhile queues behind it', () => {
        vi.useFakeTimers();
        setPlatform('win32');
        const { adapter, writes } = makeAdapter(true);
        const paste = `\x1b[200~${'한글 — 🙂 '.repeat(200)}\x1b[201~`;
        adapter.writeRaw(paste);
        adapter.writeRaw('\r');
        expect(writes.length).toBe(1); // first segment immediately, the rest paced
        vi.runAllTimers();
        expect(writes.length).toBeGreaterThan(2);
        for (const w of writes) expect(w.length).toBeLessThanOrEqual(1024);
        expect(writes.join('')).toBe(encodeWin32TerminalInput(paste) + '\r');
        expect(writes[writes.length - 1]).toBe('\r');
    });
});

describe('standalone pty_input → handlePtyInput', () => {
    it('win32 agy session: the command path writes the encoded input', async () => {
        setPlatform('win32');
        const { adapter, writes } = makeAdapter(true);
        const h: any = { getCliAdapter: () => adapter, currentSession: null };
        const result = await handlePtyInput(h, { targetSessionId: 'sess-1', data: 'x…y' });
        expect(result.success).toBe(true);
        expect(writes).toEqual([`x${bmp('…')}y`]);
    });

    it('flag off: the command path writes the raw input', async () => {
        setPlatform('win32');
        const { adapter, writes } = makeAdapter(false);
        const h: any = { getCliAdapter: () => adapter, currentSession: null };
        await handlePtyInput(h, { targetSessionId: 'sess-1', data: 'x…y' });
        expect(writes).toEqual(['x…y']);
    });
});

// End-to-end through a REAL constructed adapter: the flag is read from the spec
// file's `send_message` block, and the encoded bytes reach the PTY transport.
class RecordingPty implements PtyRuntimeTransport {
    readonly pid = 7790;
    readonly ready = Promise.resolve();
    readonly writes: string[] = [];
    write(data: string): void { this.writes.push(data); }
    resize(): void { /* no-op */ }
    kill(): void { /* no-op */ }
    onData(): void { /* no-op */ }
    onExit(): void { /* no-op */ }
}

class RecordingFactory implements PtyTransportFactory {
    last: RecordingPty | null = null;
    spawn(_command: string, _args: string[], _options: PtySpawnOptions): PtyRuntimeTransport {
        this.last = new RecordingPty();
        return this.last;
    }
}

const tmpDirs: string[] = [];
afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

async function spawnRealAdapter(flag: boolean): Promise<{ adapter: SpecCliAdapter; pty: RecordingPty }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win32-raw-input-'));
    tmpDirs.push(dir);
    const specPath = path.join(dir, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify({
        $schema: 'adhdev:cli/spec@4',
        id: 'test.win32-raw-input',
        name: 'win32 raw input test',
        binary: '/bin/true',
        send_message: { submit_key: '\r', ...(flag ? { win32_input_mode_non_ascii: true } : {}) },
        sections: { footer: { from_bottom: 1 } },
        states: [{ id: 'idle', label: 'Ready', initial: true, status: 'idle' }],
        transitions: [],
    }));
    const factory = new RecordingFactory();
    const adapter = new SpecCliAdapter(specPath, os.tmpdir(), [], {}, factory, 'sess-win32-raw-0001');
    void adapter.spawn();
    for (let i = 0; i < 50 && !factory.last; i += 1) await new Promise(r => setTimeout(r, 10));
    return { adapter, pty: factory.last! };
}

describe('constructed SpecCliAdapter: spec flag → PTY bytes', () => {
    it('win32 + send_message.win32_input_mode_non_ascii: the PTY receives key records', async () => {
        setPlatform('win32');
        const { adapter, pty } = await spawnRealAdapter(true);
        pty.writes.length = 0;
        adapter.writeRaw('→\x1b[B');
        expect(pty.writes).toEqual([`${bmp('→')}\x1b[B`]);
        adapter.shutdown();
    });

    it('win32 without the flag: the PTY receives the raw UTF-8 string', async () => {
        setPlatform('win32');
        const { adapter, pty } = await spawnRealAdapter(false);
        pty.writes.length = 0;
        adapter.writeRaw('→\x1b[B');
        expect(pty.writes).toEqual(['→\x1b[B']);
        adapter.shutdown();
    });
});
