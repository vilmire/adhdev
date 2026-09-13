/**
 * FORCE-NO-OP regression coverage.
 *
 * `SpecCliAdapter.sendMessage` accepts `{ force: true }` and IGNORES it. That is
 * correct — raw-writing a body into a generating PTY is the retired data-loss
 * path ("force-inject-into-generating stays intentionally removed", see
 * mesh/mesh-reconcile-coordinator-drain.ts) — but it was not obvious, because
 * the parameter was spelled `_opts` and no test pinned the behaviour.
 *
 * The hazard this locks down is a REVERSAL, in either direction:
 *
 *   1. Someone "fixes" the unused parameter by making `force` bypass the idle
 *      gate, silently resurrecting force-inject and with it the composer-residue
 *      defect (oss 7cd5b777: a 10,937-char notification written into a PTY whose
 *      submit CR never fired, left in the composer for 1h42m).
 *   2. Someone deletes `force` from the signature, breaking the shared
 *      `CliInstanceAdapter` contract that non-spec adapters implement, and
 *      taking the MODAL fail-closed guard in cli-provider-instance.ts with it —
 *      that guard genuinely still reads the flag.
 *
 * So: force must be ACCEPTED, must NOT change delivery, and a busy session must
 * still park the body in the FIFO exactly as an unforced send does.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 7781;
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

class DrivableFactory implements PtyTransportFactory {
    last: DrivablePty | null = null;
    spawn(_command: string, _args: string[], _options: PtySpawnOptions): PtyRuntimeTransport {
        this.last = new DrivablePty();
        return this.last;
    }
}

function busyCycleSpec(): Record<string, unknown> {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'test.force-noop',
        name: 'force no-op test',
        binary: '/bin/true',
        send_message: { submit_key: '\r' },
        sections: { footer: { from_bottom: 1 } },
        states: [
            { id: 'starting', label: 'Starting', initial: true, status: 'idle' },
            { id: 'idle', label: 'Ready', status: 'idle' },
            { id: 'generating', label: 'Working', status: 'generating' },
        ],
        transitions: [
            { label: 'starting→idle', from: 'starting', to: 'idle', when: { section: 'footer', matches: '\\? for shortcuts' } },
            { label: 'idle→generating', from: 'idle', to: 'generating', when: { section: 'footer', matches: 'Thinking' } },
            { label: 'generating→idle', from: 'generating', to: 'idle', when: { section: 'footer', matches: '\\? for shortcuts' } },
        ],
    };
}

const __tmpDirsToClean: string[] = [];

function writeSpec(spec: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-force-noop-'));
    __tmpDirsToClean.push(dir);
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(spec));
    return p;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const IDLE_FRAME = '\n>\n? for shortcuts';
const BUSY_FRAME = '\n>\nThinking...';

function makeAdapter(): { adapter: SpecCliAdapter; pty: DrivablePty } {
    const factory = new DrivableFactory();
    const adapter = new SpecCliAdapter(
        writeSpec(busyCycleSpec()),
        os.tmpdir(),
        [],
        {},
        factory,
        'sess-force-noop-0001',
    );
    void adapter.spawn();
    return { adapter, pty: factory.last! };
}

afterEach(() => {
    for (const dir of __tmpDirsToClean.splice(0)) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

describe('FORCE-NO-OP: SpecCliAdapter.sendMessage ignores `force`', () => {
    it('★ force:true on a BUSY session does NOT write to the PTY — it queues, exactly like an unforced send', async () => {
        const { adapter, pty } = makeAdapter();
        pty.feed(IDLE_FRAME);
        await sleep(300);
        pty.feed(BUSY_FRAME);
        await sleep(300);

        const writesBefore = pty.writes.length;
        const result = await adapter.sendMessage('a terminal mesh completion notification', { force: true });

        // The whole point: force did NOT buy a bypass. Nothing reached the PTY.
        expect(pty.writes.length).toBe(writesBefore);
        expect(result).toEqual({ status: 'queued' });

        adapter.shutdown();
    });

    it('★ force:true and force-absent are INDISTINGUISHABLE on a busy session', async () => {
        const forced = makeAdapter();
        forced.pty.feed(IDLE_FRAME); await sleep(300);
        forced.pty.feed(BUSY_FRAME); await sleep(300);
        const forcedBefore = forced.pty.writes.length;
        const forcedResult = await forced.adapter.sendMessage('same body', { force: true });
        const forcedWrote = forced.pty.writes.length - forcedBefore;

        const plain = makeAdapter();
        plain.pty.feed(IDLE_FRAME); await sleep(300);
        plain.pty.feed(BUSY_FRAME); await sleep(300);
        const plainBefore = plain.pty.writes.length;
        const plainResult = await plain.adapter.sendMessage('same body');
        const plainWrote = plain.pty.writes.length - plainBefore;

        expect(forcedResult).toEqual(plainResult);
        expect(forcedWrote).toBe(plainWrote);

        forced.adapter.shutdown();
        plain.adapter.shutdown();
    });

    it('★ force:true on an IDLE session still delivers normally (the flag breaks nothing)', async () => {
        const { adapter, pty } = makeAdapter();
        pty.feed(IDLE_FRAME);
        await sleep(300);

        const result = await adapter.sendMessage('idle delivery with force', { force: true });
        expect(result).toEqual({ status: 'delivered' });

        adapter.shutdown();
    });
});
