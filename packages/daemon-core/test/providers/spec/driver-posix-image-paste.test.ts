/**
 * POSIX image-prompt delivery via bracketed paste (multi-image attachment loss).
 *
 * Live reproduction on claude-cli v2.1.220 (macOS, 2026-08-26): a prompt body
 * carrying TWO materialized image paths was written raw into the composer. The
 * CLI only converts image paths to real attachments when a single input burst
 * exceeds its heuristic-paste threshold (~800 chars) — and if the write arrives
 * split (pipe chunking under load), only the paths inside the paste-sized burst
 * attach. Observed end state both times: the LAST image attaches, the earlier
 * one(s) reach the model as plain text only. A short body (< threshold) attaches
 * NONE. Wrapping the body in a bracketed-paste region (ESC[200~ … ESC[201~)
 * makes the CLI's paste handler process the whole body deterministically:
 * A/B against the real binary attached BOTH images (imagePasteIds: [1, 2]).
 *
 * The wrap is doubly gated so nothing else changes:
 *   1. the dispatch must carry `bracketedPaste: true` (set only when the input
 *      envelope actually contained image parts), and
 *   2. the provider spec must opt in via
 *      `send_message.posix_bracketed_paste_for_images: true`.
 * Text-only sends and non-opted-in providers keep the byte-for-byte legacy path.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

const BP_OPEN = '\x1b[200~';
const BP_CLOSE = '\x1b[201~';

class RecordingPty implements PtyRuntimeTransport {
    readonly pid = 4242;
    readonly ready = Promise.resolve();
    readonly writes: string[] = [];
    private dataCb: ((chunk: string) => void) | null = null;
    private exitCb: ((info: { exitCode: number }) => void) | null = null;
    write(data: string): void { this.writes.push(data); }
    resize(): void { /* no-op */ }
    kill(): void { this.exitCb?.({ exitCode: 0 }); }
    onData(cb: (chunk: string) => void): void { this.dataCb = cb; }
    onExit(cb: (info: { exitCode: number }) => void): void { this.exitCb = cb; }
    feed(chunk: string): void { this.dataCb?.(chunk); }
}

class RecordingFactory implements PtyTransportFactory {
    last: RecordingPty | null = null;
    spawn(): PtyRuntimeTransport {
        this.last = new RecordingPty();
        return this.last;
    }
}

function imagePasteSpec(optIn: boolean): Record<string, unknown> {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'test.posix-image-paste',
        name: 'posix image paste test',
        binary: '/bin/true',
        send_message: {
            submit_key: '\r',
            delay_ms_before_submit: 50,
            ...(optIn ? { posix_bracketed_paste_for_images: true } : {}),
        },
        sections: { footer: { from_bottom: 1 } },
        states: [
            { id: 'starting', label: 'Starting', initial: true, status: 'idle' },
            { id: 'idle', label: 'Ready', status: 'idle' },
            { id: 'generating', label: 'Generating', status: 'generating' },
        ],
        transitions: [
            {
                label: 'starting→idle',
                from: 'starting',
                to: 'idle',
                when: { section: 'footer', matches: '\\? for shortcuts' },
            },
            {
                label: 'idle→generating',
                from: 'idle',
                to: 'generating',
                when: { section: 'footer', matches: 'esc to interrupt' },
            },
        ],
    };
}

function writeSpec(spec: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-posix-paste-'));
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(spec));
    return p;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ORIGINAL_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

const BODY = '/tmp/adhdev-input-media/adhdev-input-image-1-0-aaaa.png\n/tmp/adhdev-input-media/adhdev-input-image-1-1-bbbb.png\nwhat are these?';

async function collectWrites(optIn: boolean, bracketedPaste: boolean, totalWaitMs = 600): Promise<string[]> {
    const factory = new RecordingFactory();
    const driver = new FsmDriver({
        specPath: writeSpec(imagePasteSpec(optIn)),
        workingDir: os.tmpdir(),
        hotReload: false,
        transportFactory: factory,
    });
    driver.start();
    const pty = factory.last!;
    try {
        pty.feed('\n>\n? for shortcuts');
        await sleep(200);
        const before = pty.writes.length;
        driver.dispatch({ kind: 'send_message', text: BODY, bracketedPaste });
        await sleep(totalWaitMs);
        return pty.writes.slice(before);
    } finally {
        driver.shutdown();
    }
}

describe('FsmDriver -- POSIX bracketed-paste image delivery', () => {
    afterEach(() => setPlatform(ORIGINAL_PLATFORM));

    it('wraps an image-bearing body in bracketed-paste markers when the spec opts in', async () => {
        setPlatform('darwin');
        const writes = await collectWrites(true, true);
        expect(writes[0]).toBe(`${BP_OPEN}${BODY}${BP_CLOSE}`);
        // Raw body must NOT also be written unwrapped.
        expect(writes).not.toContain(BODY);
        // The submit key still follows, on the verified cadence.
        expect(writes.filter(w => w === '\r').length).toBeGreaterThanOrEqual(1);
    });

    it('does NOT wait on the body echo gate before the first CR (the CLI renders paste chips, not the raw body)', async () => {
        setPlatform('darwin');
        // No echo is fed back at all: a wrapped body never echoes literally (image
        // paths become [Image #N] chips), so an echo-gated first CR would stall for
        // the 20s blind-fire backstop. The CR must land promptly instead.
        const writes = await collectWrites(true, true, 400);
        expect(writes.filter(w => w === '\r').length).toBeGreaterThanOrEqual(1);
    });

    it('keeps the legacy raw write when the dispatch carries no bracketedPaste flag', async () => {
        setPlatform('darwin');
        const writes = await collectWrites(true, false);
        expect(writes).toContain(BODY);
        expect(writes.join('')).not.toContain(BP_OPEN);
    });

    it('keeps the legacy raw write when the spec does not opt in', async () => {
        setPlatform('darwin');
        const writes = await collectWrites(false, true);
        expect(writes).toContain(BODY);
        expect(writes.join('')).not.toContain(BP_OPEN);
    });
});
