/**
 * SUBMIT-UNCONFIRMED-RECLAIM ① — the verdict on a MESH DISPATCH whose submit
 * budget ran out at an idle FSM (providers/spec/submit-verdict.ts).
 *
 * Every composer read is the EXACT native cursor row (ghostty getViewport), on
 * either screen. A dispatch owns the composer only when that row read as an
 * empty prompt right before the write and nothing else was input since.
 * Proven unsent → verified clear (one DEL at a time, each read back) → one
 * re-paste → proven unsent again → verified clear → `unconfirmed` reported and
 * the slot given back. Anything unproven → quarantine: slot held, nothing
 * cleared, re-sent or reported.
 *
 * The five rejected review scenarios are regression tests here (R1–R5 blocks),
 * plus the human path, which must stay main's byte for byte.
 *
 * The fake CLI keeps a composer string, renders it on the input row just above
 * the footer with the cursor at its end, and reacts to paste / DEL / Enter.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import { SEND_IN_FLIGHT_MAX_MS } from '../../../src/providers/spec/submit-policy.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

const BP_OPEN = '\x1b[200~';
const BP_CLOSE = '\x1b[201~';
const BODY = 'TASK-HEAD. ' + 'do the thing, carefully. '.repeat(40);
const chip = (n: number) => `[Pasted text #${n} +40 lines]`;
/** The input row sits just above the footer (the last row); the cursor is left at its end. */
const inputRow = (text: string) => `\x1b[999;1H\x1b[1A\r\x1b[2K> ${text}`;
/** Rewrite the footer, then put the cursor back at the end of the input row. */
const footer = (text: string) => `\x1b[999;1H\x1b[2K${text}\x1b[1A\x1b[999C`;

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4848;
    readonly ready = Promise.resolve();
    readonly writes: string[] = [];
    onWrite: ((data: string) => void) | null = null;
    private dataCb: ((chunk: string) => void) | null = null;
    private exitCb: ((info: { exitCode: number }) => void) | null = null;
    write(data: string): void { this.writes.push(data); const react = this.onWrite; if (react) queueMicrotask(() => react(data)); }
    resize(): void { /* no-op */ }
    kill(): void { this.exitCb?.({ exitCode: 0 }); }
    onData(cb: (chunk: string) => void): void { this.dataCb = cb; }
    onExit(cb: (info: { exitCode: number }) => void): void { this.exitCb = cb; }
    feed(chunk: string): void { this.dataCb?.(chunk); }
    /**
     * A session host's account of input (PtyRuntimeTransport.inputProvenance):
     * the hosted runtime every production CLI session runs on. `null` models a
     * host too old to announce inputs; `raw` (see readyDriver) removes the
     * method — a raw node-pty with no host at all.
     */
    host: { foreign: number; ownerAway: number; gaps: number; complete: boolean } | null = { foreign: 0, ownerAway: 0, gaps: 0, complete: true };
    inputProvenance(): { foreign: number; ownerAway: number; gaps: number; complete: boolean } | null { return this.host ? { ...this.host } : null; }
    /** Another client's input, announced by the host before it reaches the PTY. */
    hostInputFromOtherClient(): void { if (this.host) this.host.foreign += 1; }
    /** The host's compare-and-write (send_input_if_seq): refused unless the
     *  modelled account is known and complete; `refuseGuarded` models a host
     *  that saw other input in between. */
    refuseGuarded = false;
    async writeIfInputUnchanged(data: string): Promise<boolean> {
        if (!this.host || !this.host.complete || this.refuseGuarded) return false;
        this.write(data);
        return true;
    }
}

class DrivableFactory implements PtyTransportFactory {
    last: DrivablePty | null = null;
    constructor(private readonly raw = false) {}
    spawn(_command: string, _args: string[], _options: PtySpawnOptions): PtyRuntimeTransport {
        this.last = new DrivablePty();
        if (this.raw) {
            (this.last as { inputProvenance?: unknown }).inputProvenance = undefined;
            (this.last as { writeIfInputUnchanged?: unknown }).writeIfInputUnchanged = undefined;
        }
        return this.last;
    }
}

/** agy's send shape: bracketed-paste text, tail echo, a small budget. */
function spec(): Record<string, unknown> {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'test.submit-unconfirmed',
        name: 'submit unconfirmed test',
        binary: '/bin/true',
        send_message: { submit_key: '\r', delay_ms_before_submit: 50, echo_confirm: 'tail', max_submit_resends: 3, posix_bracketed_paste_text: true },
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

const tmpDirs: string[] = [];
const ORIGINAL_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

afterEach(() => {
    vi.useRealTimers();
    setPlatform(ORIGINAL_PLATFORM);
    while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/**
 * A composer model. `takeEnterOnPaste` = which paste (1-based) an Enter submits
 * (0 = never); `del` = how a DEL acts on a chip ('whole' like Claude Code,
 * 'char' one character at a time, 'ignore' never).
 */
interface FakeCli { composer: string; pastes: number; submitted: string[]; render(): void }
function fakeCli(pty: DrivablePty, opts: { takeEnterOnPaste?: number; del?: 'whole' | 'char' | 'ignore'; renderPaste?: boolean } = {}): FakeCli {
    const cli: FakeCli = {
        composer: '', pastes: 0, submitted: [],
        render() { pty.feed(inputRow(cli.composer)); },
    };
    pty.onWrite = (data) => {
        if (data.startsWith(BP_OPEN)) {
            cli.pastes += 1;
            if (opts.renderPaste === false) return;
            cli.composer += chip(cli.pastes);
        } else if (data === '\x7f') {
            if (opts.del === 'ignore') return;
            if (opts.del === 'char') cli.composer = Array.from(cli.composer).slice(0, -1).join('');
            else if (/\[Pasted text #\d+ \+40 lines\]$/.test(cli.composer)) cli.composer = cli.composer.replace(/\[Pasted text #\d+ \+40 lines\]$/, '');
            else cli.composer = Array.from(cli.composer).slice(0, -1).join('');
        } else if (data === '\r') {
            if (opts.takeEnterOnPaste && cli.pastes === opts.takeEnterOnPaste && cli.composer) {
                cli.submitted.push(cli.composer);
                cli.composer = '';
                cli.render();
                pty.feed(footer('Thinking'));
                return;
            }
            return;
        } else if (!data.includes(BP_CLOSE)) {
            cli.composer += data; // raw keys (a human pty_write)
        }
        cli.render();
    };
    return cli;
}

async function readyDriver(opts: { normalScreen?: boolean; raw?: boolean } = {}): Promise<{ driver: FsmDriver; pty: DrivablePty }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-submit-unconfirmed-'));
    tmpDirs.push(dir);
    const specPath = path.join(dir, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify(spec()));
    const factory = new DrivableFactory(opts.raw === true);
    const driver = new FsmDriver({ specPath, workingDir: os.tmpdir(), hotReload: false, transportFactory: factory });
    driver.start();
    const pty = factory.last!;
    // The normal screen with scrollback (rows pushed off the top) is exact too.
    pty.feed((opts.normalScreen ? 'old 1\r\nold 2\r\n'.repeat(40) : '\x1b[?1049h') + inputRow('') + footer('? for shortcuts'));
    await vi.advanceTimersByTimeAsync(300);
    return { driver, pty };
}

/** Register a mesh-dispatch verdict observer (what SessionInputService does for an installed dispatch). */
function observe(
    driver: FsmDriver,
    id: string,
    taken = true,
    consumption: 'consumed' | 'not_consumed' | 'unknown' = 'not_consumed',
): Array<{ verdict: string; firstWrittenAt: number }> {
    const verdicts: Array<{ verdict: string; firstWrittenAt: number }> = [];
    driver.observeSubmitUnconfirmed(id, (verdict, info) => { verdicts.push({ verdict, firstWrittenAt: info.firstWrittenAt }); return taken; }, async () => consumption);
    return verdicts;
}

async function until(cond: () => boolean, maxMs = 60_000): Promise<void> {
    for (let t = 0; t < maxMs && !cond(); t += 50) await vi.advanceTimersByTimeAsync(50);
    expect(cond()).toBe(true);
}

const pastes = (pty: DrivablePty) => pty.writes.filter(w => w.startsWith(BP_OPEN)).length;
const dels = (pty: DrivablePty) => pty.writes.filter(w => w === '\x7f').length;
const crs = (pty: DrivablePty) => pty.writes.filter(w => w === '\r').length;
const wrote = (pty: DrivablePty, text: string) => pty.writes.filter(w => w.includes(text)).length;

describe('mesh dispatch, proven unsent: clear → one re-paste → clear → unconfirmed', () => {
    it('clears exactly its own chip, re-pastes once, then reports unconfirmed with the FIRST write time and releases the slot into an empty composer', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        const cli = fakeCli(pty, { del: 'whole' });
        try {
            const fired = observe(driver, 'task:t1:n0');
            const writtenAt = Date.now();
            expect(driver.sendMessageWithDisposition(BODY, false, 'task:t1:n0')).toEqual({ status: 'delivered' });
            expect(driver.sendMessageWithDisposition('SECOND QUEUED TASK', false, 'task:t2:n0').status).toBe('queued');
            await until(() => pastes(pty) === 2);
            expect(dels(pty)).toBe(1); // the chip went in one press
            expect(fired).toEqual([]);
            expect(driver.submitState('task:t1:n0')).toBe('in_flight');
            await until(() => fired.length === 1);
            expect(fired[0].verdict).toBe('unconfirmed');
            expect(fired[0].firstWrittenAt).toBeGreaterThanOrEqual(writtenAt);
            expect(fired[0].firstWrittenAt).toBeLessThan(writtenAt + 100); // not the re-paste's time
            expect(dels(pty)).toBe(2);
            expect(cli.composer).toBe('');
            expect(driver.submitState('task:t1:n0')).toBe('unconfirmed');
            expect(wrote(pty, 'SECOND QUEUED TASK')).toBe(0);
            await until(() => wrote(pty, 'SECOND QUEUED TASK') === 1, 2_000);
            expect(pastes(pty)).toBe(3); // 2 of ours + the queued body — never a third of ours
            await vi.advanceTimersByTimeAsync(SEND_IN_FLIGHT_MAX_MS);
            expect(fired).toHaveLength(1);
        } finally {
            driver.shutdown();
        }
    });

    it('a CLI that takes the re-paste is confirmed — no report, nothing more written', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        const cli = fakeCli(pty, { del: 'whole', takeEnterOnPaste: 2 });
        try {
            const fired = observe(driver, 'task:retake:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:retake:n0');
            await until(() => cli.submitted.length === 1);
            await vi.advanceTimersByTimeAsync(30_000);
            expect(fired).toEqual([]);
            expect(pastes(pty)).toBe(2);
            expect(cli.submitted).toEqual([chip(2)]);
            expect(driver.submitState('task:retake:n0')).toBe('confirmed');
        } finally {
            driver.shutdown();
        }
    });

    it('a CLI that deletes a chip one character per DEL is cleared step by step, never past empty', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        const cli = fakeCli(pty, { del: 'char' });
        try {
            const fired = observe(driver, 'task:chars:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:chars:n0');
            await until(() => pastes(pty) === 2);
            expect(dels(pty)).toBe(Array.from(chip(1)).length);
            await until(() => fired.length === 1);
            expect(dels(pty)).toBe(Array.from(chip(1)).length + Array.from(chip(2)).length);
            expect(cli.composer).toBe('');
        } finally {
            driver.shutdown();
        }
    });

    it('works on the NORMAL screen with scrollback: the native cursor row is exact there too', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver({ normalScreen: true });
        const cli = fakeCli(pty, { del: 'whole' });
        try {
            const fired = observe(driver, 'task:normal:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:normal:n0');
            await until(() => fired.length === 1);
            expect(pastes(pty)).toBe(2);
            expect(cli.composer).toBe('');
        } finally {
            driver.shutdown();
        }
    });

    it('review f8c79690 R4_COMBINED_MODE: after CSI ?1049h then the compound CSI ?1049;2004l the read follows the primary screen exactly', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        pty.feed('\x1b[?1049;2004l' + inputRow('') + footer('? for shortcuts'));
        const cli = fakeCli(pty, { del: 'whole' });
        try {
            const fired = observe(driver, 'task:mode:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:mode:n0');
            await until(() => fired.length === 1);
            expect(cli.composer).toBe('');
            expect(dels(pty)).toBe(2);
        } finally {
            driver.shutdown();
        }
    });

    it('DELAYED_FSM: a CLI that took the LAST key but paints it 2 s late is confirmed — no DEL, no re-paste', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        fakeCli(pty, { del: 'whole' });
        try {
            const fired = observe(driver, 'task:slow:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:slow:n0');
            await until(() => crs(pty) === 3);
            await vi.advanceTimersByTimeAsync(2_000);
            pty.feed(footer('Thinking'));
            await vi.advanceTimersByTimeAsync(30_000);
            expect(fired).toEqual([]);
            expect(pastes(pty)).toBe(1);
            expect(dels(pty)).toBe(0);
            expect(driver.submitState('task:slow:n0')).toBe('confirmed');
        } finally {
            driver.shutdown();
        }
    });

    it('the first key that takes ends the send as confirmed', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        fakeCli(pty, { takeEnterOnPaste: 1 });
        try {
            observe(driver, 'task:t3:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:t3:n0');
            await until(() => crs(pty) === 1);
            await vi.advanceTimersByTimeAsync(5_000);
            expect(crs(pty)).toBe(1);
            expect(driver.submitState('task:t3:n0')).toBe('confirmed');
        } finally {
            driver.shutdown();
        }
    });
});

describe('R1 — never a double run on an unknown state', () => {
    it('an unproven send is never re-pasted or re-written, however long it is held; its state stays unknown', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        fakeCli(pty, { del: 'whole' });
        try {
            const fired = observe(driver, 'task:unk:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:unk:n0');
            await until(() => crs(pty) === 3);
            driver.dispatch({ kind: 'pty_write', data: 'x' }); // ownership revoked
            await vi.advanceTimersByTimeAsync(5 * 60_000);
            expect(pastes(pty)).toBe(1);
            expect(wrote(pty, 'TASK-HEAD')).toBe(1);
            expect(dels(pty)).toBe(0);
            expect(fired).toEqual([]);
            expect(driver.submitState('task:unk:n0')).toBe('unknown');
        } finally {
            driver.shutdown();
        }
    });

    it('a re-paste needs the clear proven: a DEL that does nothing quarantines — never a second paste on top', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        fakeCli(pty, { del: 'ignore' });
        try {
            const fired = observe(driver, 'task:stuck:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:stuck:n0');
            driver.sendMessageWithDisposition('NEXT BODY', false, 'task:next:n0');
            await vi.advanceTimersByTimeAsync(3 * 60_000);
            expect(dels(pty)).toBe(1);
            expect(pastes(pty)).toBe(1);
            expect(fired).toEqual([]);
            expect(wrote(pty, 'NEXT BODY')).toBe(0);
        } finally {
            driver.shutdown();
        }
    });
});

describe('R2 — a user draft is never deleted', () => {
    it('a draft already in the composer before the write: the dispatch never owns it — zero DEL, nothing reported, slot held', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        const cli = fakeCli(pty, { del: 'char' });
        cli.composer = 'my private draft ';
        cli.render();
        try {
            const fired = observe(driver, 'task:draft:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:draft:n0');
            driver.sendMessageWithDisposition('NEXT BODY', false, 'task:next:n0');
            await vi.advanceTimersByTimeAsync(2 * 60_000);
            expect(dels(pty)).toBe(0);
            expect(cli.composer.startsWith('my private draft ')).toBe(true);
            expect(fired).toEqual([]);
            expect(wrote(pty, 'NEXT BODY')).toBe(0);
        } finally {
            driver.shutdown();
        }
    });

    it('HUMAN_DRAFT: raw input routed through the driver after the write revokes ownership — zero DEL', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        fakeCli(pty, { del: 'char' });
        try {
            const fired = observe(driver, 'task:typed:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:typed:n0');
            await until(() => crs(pty) === 2);
            driver.dispatch({ kind: 'pty_write', data: ' HUMAN DRAFT' });
            await vi.advanceTimersByTimeAsync(60_000);
            expect(dels(pty)).toBe(0);
            expect(fired).toEqual([]);
        } finally {
            driver.shutdown();
        }
    });

    it('a draft typed straight into the terminal (not through the driver) makes the row not ours — zero DEL', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        const cli = fakeCli(pty, { del: 'char' });
        try {
            const fired = observe(driver, 'task:local:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:local:n0');
            await until(() => crs(pty) === 3);
            cli.composer += ' typed locally';
            cli.render();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(dels(pty)).toBe(0);
            expect(fired).toEqual([]);
        } finally {
            driver.shutdown();
        }
    });

    it('a draft that only shares the body tail is not the body — zero DEL', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        fakeCli(pty, { renderPaste: false });
        try {
            const fired = observe(driver, 'task:tail:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:tail:n0');
            pty.feed(inputRow('HUMAN PRIVATE DRAFT ' + BODY.trim().slice(-8)));
            await vi.advanceTimersByTimeAsync(60_000);
            expect(dels(pty)).toBe(0);
            expect(fired).toEqual([]);
        } finally {
            driver.shutdown();
        }
    });

    it('a row that changes mid-clear in a way a DEL does not explain stops the clear at once', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        const cli = fakeCli(pty, { del: 'char' });
        try {
            const fired = observe(driver, 'task:midclear:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:midclear:n0');
            await until(() => dels(pty) === 3);
            cli.composer += 'X'; // someone typed at the local terminal during the clear
            cli.render();
            const atChange = dels(pty);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(dels(pty)).toBeLessThanOrEqual(atChange + 1); // at most the press already in flight
            expect(cli.composer.endsWith('X')).toBe(true);
            expect(pastes(pty)).toBe(1);
            expect(fired).toEqual([]);
        } finally {
            driver.shutdown();
        }
    });
});

describe('R3 — an idle-only state never produces a verdict (no hard stop)', () => {
    it('a body that never rendered, at an idle FSM, is never reported, however long — and is released only after the empty hold', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        fakeCli(pty, { renderPaste: false });
        try {
            const fired = observe(driver, 'task:idle:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:idle:n0');
            driver.sendMessageWithDisposition('NEXT BODY', false, 'task:next:n0');
            await vi.advanceTimersByTimeAsync(3_000 + 3 * 350 + 1_500 + 5_000);
            expect(wrote(pty, 'NEXT BODY')).toBe(0);
            await vi.advanceTimersByTimeAsync(5 * 60_000);
            expect(fired).toEqual([]);
            expect(dels(pty)).toBe(0);
            expect(wrote(pty, 'TASK-HEAD')).toBe(1);
            expect(wrote(pty, 'NEXT BODY')).toBe(1); // the row stayed an empty prompt
        } finally {
            driver.shutdown();
        }
    });

    it('an unreadable screen is unknown — no DEL, no report, the slot stays held', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        fakeCli(pty, { del: 'whole' });
        const internal = (driver as any).adapter;
        const getRow = internal.getCursorRow.bind(internal);
        let unreadable = false;
        internal.getCursorRow = () => { if (unreadable) throw new Error('screen unavailable'); return getRow(); };
        try {
            const fired = observe(driver, 'task:unreadable:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:unreadable:n0');
            driver.sendMessageWithDisposition('NEXT BODY', false, 'task:next:n0');
            await until(() => crs(pty) === 3);
            unreadable = true;
            await vi.advanceTimersByTimeAsync(2 * 60_000);
            expect(fired).toEqual([]);
            expect(dels(pty)).toBe(0);
            expect(wrote(pty, 'NEXT BODY')).toBe(0);
        } finally {
            internal.getCursorRow = getRow;
            driver.shutdown();
        }
    });

    it('a binding without the native viewport read makes every read unknown — no DEL, no report', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        fakeCli(pty, { del: 'whole' });
        const internal = (driver as any).adapter;
        const getRow = internal.getCursorRow;
        internal.getCursorRow = () => null;
        try {
            const fired = observe(driver, 'task:nobinding:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:nobinding:n0');
            await vi.advanceTimersByTimeAsync(60_000);
            expect(fired).toEqual([]);
            expect(dels(pty)).toBe(0);
            expect(pastes(pty)).toBe(1);
        } finally {
            internal.getCursorRow = getRow;
            driver.shutdown();
        }
    });
});

describe('R4 — a stale paste chip is never ours', () => {
    it('a leftover chip (same text) already in the composer before the write: zero DEL, no report, slot held', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        const cli = fakeCli(pty, { del: 'whole' });
        cli.composer = chip(1);
        cli.render();
        cli.pastes = 0; // our paste renders as "#1" again, right after the stale one
        try {
            const fired = observe(driver, 'task:stale:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:stale:n0');
            driver.sendMessageWithDisposition('NEXT BODY', false, 'task:next:n0');
            await vi.advanceTimersByTimeAsync(2 * 60_000);
            expect(dels(pty)).toBe(0);
            expect(fired).toEqual([]);
            expect(wrote(pty, 'NEXT BODY')).toBe(0);
        } finally {
            driver.shutdown();
        }
    });

    it('a stale chip in a transcript row above an empty prompt is not the input row; the first CR is not released by it', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        fakeCli(pty, { renderPaste: false });
        pty.feed(`\x1b[1;1H\x1b[2K> ${chip(1)}${inputRow('')}`);
        try {
            const fired = observe(driver, 'task:above:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:above:n0');
            await vi.advanceTimersByTimeAsync(2_500);
            expect(crs(pty)).toBe(0); // still waiting on its OWN chip (3 s backstop)
            await vi.advanceTimersByTimeAsync(60_000);
            expect(dels(pty)).toBe(0);
            expect(fired).toEqual([]);
        } finally {
            driver.shutdown();
        }
    });
});

describe('R5 — a queued body is never written over residue', () => {
    it('a proven verdict nobody takes (the dispatch moved on): released only once the composer is cleared — the queued body lands in an empty row', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        const cli = fakeCli(pty, { del: 'whole' });
        let composerAtNext: string | null = null;
        const react = pty.onWrite!;
        pty.onWrite = (data) => { if (data.includes('NEXT BODY') && composerAtNext === null) composerAtNext = cli.composer; react(data); };
        try {
            const fired = observe(driver, 'task:gone:n0', false);
            driver.sendMessageWithDisposition(BODY, false, 'task:gone:n0');
            driver.sendMessageWithDisposition('NEXT BODY', false, 'task:next:n0');
            await until(() => fired.length === 1);
            await until(() => wrote(pty, 'NEXT BODY') === 1, 2_000);
            expect(composerAtNext).toBe('');
        } finally {
            driver.shutdown();
        }
    });

    it('review R5-3 (+12 s port loss): a quarantined dispatch is never given back to main — NEXT BODY waits for an empty row', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        const cli = fakeCli(pty, { del: 'ignore' });
        try {
            observe(driver, 'task:lost:n0', false);
            driver.sendMessageWithDisposition(BODY, false, 'task:lost:n0');
            driver.sendMessageWithDisposition('NEXT BODY', false, 'task:next:n0');
            await vi.advanceTimersByTimeAsync(12_000);
            await vi.advanceTimersByTimeAsync(SEND_IN_FLIGHT_MAX_MS + 3 * 60_000);
            expect(wrote(pty, 'NEXT BODY')).toBe(0);
            cli.composer = ''; // the residue is cleared by someone else
            cli.render();
            await vi.advanceTimersByTimeAsync(5_000);
            expect(wrote(pty, 'NEXT BODY')).toBe(0); // one empty read is not enough
            await vi.advanceTimersByTimeAsync(10_000);
            expect(wrote(pty, 'NEXT BODY')).toBe(1);
        } finally {
            driver.shutdown();
        }
    });

    it('consumption (the FSM leaves idle) ends a quarantine as confirmed and frees the slot', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        fakeCli(pty, { del: 'ignore' });
        try {
            observe(driver, 'task:late:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:late:n0');
            await vi.advanceTimersByTimeAsync(20_000);
            pty.feed(footer('Thinking'));
            await vi.advanceTimersByTimeAsync(1_000);
            expect(driver.submitState('task:late:n0')).toBe('confirmed');
        } finally {
            driver.shutdown();
        }
    });
});

describe('review R6 (independent Codex probes, ported) — ownership needs provenance, exact content and an exact baseline', () => {
    it('R6-1: never deletes a second chip pasted locally before the first render poll', async () => {
        vi.useFakeTimers(); setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        const cli = fakeCli(pty, { del: 'whole' });
        try {
            const verdicts = observe(driver, 'task:localchip:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:localchip:n0');
            // The PTY rendered our paste, before the engine's delayed first cursor-row read.
            await vi.advanceTimersByTimeAsync(1);
            expect(cli.composer).toBe(chip(1));
            // Someone pastes another multi-line draft straight into the local terminal.
            cli.composer += chip(99);
            cli.render();
            await vi.advanceTimersByTimeAsync(15_000);
            expect(dels(pty)).toBe(0);
            expect(cli.composer).toContain(chip(99));
            expect(verdicts).toEqual([]);
        } finally { driver.shutdown(); }
    });

    it('R6-1 (variant): a local chip rendered BEFORE ours — the first sighting is two chips, never ours', async () => {
        vi.useFakeTimers(); setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        const cli = fakeCli(pty, { del: 'whole', renderPaste: false });
        try {
            const verdicts = observe(driver, 'task:before:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:before:n0');
            cli.composer = chip(7) + chip(8);
            cli.render();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(dels(pty)).toBe(0);
            expect(verdicts).toEqual([]);
        } finally { driver.shutdown(); }
    });

    it('R6-2: never re-pastes over pipe residue from a literal body', async () => {
        vi.useFakeTimers(); setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        let composer = '';
        const beforePaste: string[] = [];
        pty.onWrite = data => {
            if (data.startsWith(BP_OPEN)) {
                beforePaste.push(composer);
                composer += data.slice(BP_OPEN.length, -BP_CLOSE.length);
            } else if (data === '\x7f') composer = composer.slice(0, -1);
            else return;
            pty.feed(inputRow(composer));
        };
        try {
            observe(driver, 'task:pipe:n0');
            driver.sendMessageWithDisposition('|x', false, 'task:pipe:n0');
            await until(() => beforePaste.length === 2);
            expect(beforePaste).toEqual(['', '']);
        } finally { driver.shutdown(); }
    });

    it('R6-2 (release): a quarantine is never released onto an editable pipe right of the cursor', async () => {
        vi.useFakeTimers(); setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        fakeCli(pty, { renderPaste: false });
        try {
            observe(driver, 'task:pipe2:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:pipe2:n0');
            driver.sendMessageWithDisposition('NEXT BODY', false, 'task:next:n0');
            pty.feed(inputRow('|') + '\x1b[D'); // residue right of the cursor
            await vi.advanceTimersByTimeAsync(3 * 60_000);
            expect(wrote(pty, 'NEXT BODY')).toBe(0);
        } finally { driver.shutdown(); }
    });

    it('R6-3: does not delete a draft with different whitespace from the pending body', async () => {
        vi.useFakeTimers(); setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        const cli = fakeCli(pty, { renderPaste: false, del: 'char' });
        try {
            observe(driver, 'task:space:n0');
            driver.sendMessageWithDisposition('Please preserve "a b"', false, 'task:space:n0');
            await vi.advanceTimersByTimeAsync(1);
            cli.composer = 'Please preserve "ab"'; // local edit; the payload did not render
            cli.render();
            await vi.advanceTimersByTimeAsync(15_000);
            expect(dels(pty)).toBe(0);
            expect(cli.composer).toBe('Please preserve "ab"');
        } finally { driver.shutdown(); }
    });

    it('an exact literal body is still recovered (the literal path works without normalisation)', async () => {
        vi.useFakeTimers(); setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        let composer = '';
        const beforePaste: string[] = [];
        pty.onWrite = data => {
            if (data.startsWith(BP_OPEN)) { beforePaste.push(composer); composer += data.slice(BP_OPEN.length, -BP_CLOSE.length); }
            else if (data === '\x7f') composer = Array.from(composer).slice(0, -1).join('');
            else return;
            pty.feed(inputRow(composer));
        };
        try {
            const fired = observe(driver, 'task:lit:n0');
            driver.sendMessageWithDisposition('Please preserve "a b"', false, 'task:lit:n0');
            await until(() => fired.length === 1);
            expect(beforePaste).toEqual(['', '']);
            expect(composer).toBe('');
        } finally { driver.shutdown(); }
    });

    it('another writable client attached to the runtime (a local terminal) makes ownership unprovable — zero DEL', async () => {
        vi.useFakeTimers(); setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        (pty as any).otherWritableClients = () => true;
        fakeCli(pty, { del: 'whole' });
        try {
            const fired = observe(driver, 'task:attached:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:attached:n0');
            await vi.advanceTimersByTimeAsync(60_000);
            expect(dels(pty)).toBe(0);
            expect(pastes(pty)).toBe(1);
            expect(fired).toEqual([]);
        } finally { driver.shutdown(); }
    });

    it('an unknown attached-client state (null) fails closed — zero DEL', async () => {
        vi.useFakeTimers(); setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        (pty as any).otherWritableClients = () => null;
        fakeCli(pty, { del: 'whole' });
        try {
            observe(driver, 'task:nullattached:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:nullattached:n0');
            await vi.advanceTimersByTimeAsync(60_000);
            expect(dels(pty)).toBe(0);
        } finally { driver.shutdown(); }
    });

    it('a write that bypasses the driver dispatch (any other caller of the adapter) revokes ownership — zero DEL', async () => {
        vi.useFakeTimers(); setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        fakeCli(pty, { del: 'whole' });
        try {
            const fired = observe(driver, 'task:bypass:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:bypass:n0');
            await until(() => crs(pty) === 3);
            (driver as any).adapter.send_keys('\x1b[I'); // e.g. a focus-in wake, not the engine's
            await vi.advanceTimersByTimeAsync(60_000);
            expect(dels(pty)).toBe(0);
            expect(fired).toEqual([]);
        } finally { driver.shutdown(); }
    });
});

describe('review R7 (independent Codex probes, ported) — input provenance is the session host\'s', () => {
    it('R7-1: a single foreign chip before the first output chunk is never owned or deleted (raw PTY: nothing accounts for its input)', async () => {
        vi.useFakeTimers(); setPlatform('darwin');
        const { driver, pty } = await readyDriver({ raw: true });
        const cli = fakeCli(pty, { renderPaste: false, del: 'whole' });
        try {
            const fired = observe(driver, 'task:foreign-first:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:foreign-first:n0');
            await vi.advanceTimersByTimeAsync(1);
            // Our write has produced no screen output; an uncounted writer's chip is the first post-write chunk.
            cli.composer = chip(99); cli.render();
            await vi.advanceTimersByTimeAsync(15_000);
            expect(dels(pty)).toBe(0); expect(cli.composer).toBe(chip(99)); expect(fired).toEqual([]);
        } finally { driver.shutdown(); }
    });

    it('R7-1 (hosted): the same single chip after another client\'s announced input is never owned or deleted', async () => {
        vi.useFakeTimers(); setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        const cli = fakeCli(pty, { renderPaste: false, del: 'whole' });
        try {
            const fired = observe(driver, 'task:hosted-first:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:hosted-first:n0');
            await vi.advanceTimersByTimeAsync(1);
            pty.hostInputFromOtherClient(); // announced before its bytes reach the PTY
            cli.composer = chip(99); cli.render();
            await vi.advanceTimersByTimeAsync(15_000);
            expect(dels(pty)).toBe(0); expect(cli.composer).toBe(chip(99)); expect(fired).toEqual([]);
        } finally { driver.shutdown(); }
    });

    it('R7-1 (hosted, late announcement): another client\'s input announced after its chip rendered still blocks recovery', async () => {
        vi.useFakeTimers(); setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        const cli = fakeCli(pty, { renderPaste: false, del: 'whole' });
        try {
            const fired = observe(driver, 'task:late-ann:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:late-ann:n0');
            await vi.advanceTimersByTimeAsync(1);
            cli.composer = chip(99); cli.render();
            await vi.advanceTimersByTimeAsync(500);
            pty.hostInputFromOtherClient();
            await vi.advanceTimersByTimeAsync(15_000);
            expect(dels(pty)).toBe(0); expect(fired).toEqual([]);
        } finally { driver.shutdown(); }
    });

    it.each([
        ['an older host that does not announce inputs', (pty: DrivablePty) => { pty.host = null; }],
        ['announcements still in flight (incomplete)', (pty: DrivablePty) => { pty.host!.complete = false; }],
        ['write ownership moved to another client', (pty: DrivablePty) => { pty.host!.ownerAway += 1; }],
        ['a lost or replayed announcement (gap)', (pty: DrivablePty) => { pty.host!.gaps += 1; }],
    ])('fails closed on %s — zero DEL', async (_label, mutate) => {
        vi.useFakeTimers(); setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        fakeCli(pty, { del: 'whole' });
        try {
            const fired = observe(driver, 'task:prov:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:prov:n0');
            await until(() => crs(pty) === 1);
            mutate(pty);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(dels(pty)).toBe(0); expect(fired).toEqual([]);
        } finally { driver.shutdown(); }
    });

    it('R8-1: a guarded DEL the host refuses (input arrived since the check) quarantines at once — no DEL written, nothing reported', async () => {
        vi.useFakeTimers(); setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        const cli = fakeCli(pty, { del: 'whole' });
        try {
            const fired = observe(driver, 'task:refused:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:refused:n0');
            driver.sendMessageWithDisposition('NEXT BODY', false, 'task:next:n0');
            pty.refuseGuarded = true;
            await vi.advanceTimersByTimeAsync(2 * 60_000);
            expect(dels(pty)).toBe(0);
            expect(cli.composer).toBe(chip(1));
            expect(pastes(pty)).toBe(1);
            expect(fired).toEqual([]);
            expect(wrote(pty, 'NEXT BODY')).toBe(0);
        } finally { driver.shutdown(); }
    });

    for (const body of ['│x', 'x│', '│x│', '한🙂x', '👩‍💻x']) {
        it(`recovers an exact literal rendered as a prefix first, with edge content ${body}`, async () => {
            vi.useFakeTimers(); setPlatform('darwin');
            const { driver, pty } = await readyDriver();
            let composer = '';
            const before: string[] = [];
            pty.onWrite = (data) => {
                if (data.startsWith(BP_OPEN)) {
                    before.push(composer);
                    const value = data.slice(BP_OPEN.length, -BP_CLOSE.length);
                    composer = Array.from(value).slice(0, 1).join(''); pty.feed(inputRow(composer));
                    composer = value; pty.feed(inputRow(composer));
                } else if (data === '\x7f') { composer = Array.from(composer).slice(0, -1).join(''); pty.feed(inputRow(composer)); }
            };
            try {
                const fired = observe(driver, 'task:lit:n0');
                driver.sendMessageWithDisposition(body, false, 'task:lit:n0');
                await until(() => fired.length === 1);
                expect(before).toEqual(['', '']);
                expect(composer).toBe('');
            } finally { driver.shutdown(); }
        });
    }

    it('a nonempty baseline draft prevents ownership and deletion', async () => {
        vi.useFakeTimers(); setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        const cli = fakeCli(pty, { del: 'whole' });
        cli.composer = 'existing draft'; cli.render();
        try {
            const fired = observe(driver, 'task:draft:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:draft:n0');
            await vi.advanceTimersByTimeAsync(60_000);
            expect(dels(pty)).toBe(0); expect(pastes(pty)).toBe(1); expect(fired).toEqual([]);
            expect(cli.composer).toContain('existing draft');
        } finally { driver.shutdown(); }
    });

    it('a footer-only repaint preserving the cursor cells does not prevent recovery', async () => {
        vi.useFakeTimers(); setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        fakeCli(pty, { del: 'whole' });
        const ticker = setInterval(() => pty.feed('\x1b[s\x1b[1;1H\x1b[2Kspinner tick\x1b[u'), 200);
        try {
            const fired = observe(driver, 'task:ticker:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:ticker:n0');
            await until(() => fired.length === 1);
            expect(pastes(pty)).toBe(2);
        } finally { clearInterval(ticker); driver.shutdown(); }
    });

    it('KNOWN LIMIT (accepted, fail-closed): a split erase → partial chip → full chip repaint of the input row permanently disables local recovery for that send', async () => {
        vi.useFakeTimers(); setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        fakeCli(pty, { del: 'whole' });
        try {
            const fired = observe(driver, 'task:repaint:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:repaint:n0');
            await until(() => crs(pty) === 1);
            pty.feed(inputRow('')); pty.feed(inputRow('[Pasted te')); pty.feed(inputRow(chip(1)));
            await vi.advanceTimersByTimeAsync(60_000);
            expect(dels(pty)).toBe(0); expect(fired).toEqual([]);
            expect(driver.submitState('task:repaint:n0')).toBe('unknown');
        } finally { driver.shutdown(); }
    });
});

describe('R9-3 — consumed or ambiguous with the chip still up is not re-pasted and not reported', () => {
    for (const consumption of ['consumed', 'unknown'] as const) {
        it(`turn evidence ${consumption} while the footer stays idle and the chip stays up: one paste, no DEL, no unconfirmed`, async () => {
            vi.useFakeTimers();
            setPlatform('darwin');
            const { driver, pty } = await readyDriver();
            const cli = fakeCli(pty, { del: 'whole' });
            try {
                const fired = observe(driver, 'task:late:n0', true, consumption);
                driver.sendMessageWithDisposition(BODY, false, 'task:late:n0');
                await until(() => crs(pty) === 3);
                await vi.advanceTimersByTimeAsync(60_000);
                expect(fired).toEqual([]);
                expect(pastes(pty)).toBe(1);
                expect(dels(pty)).toBe(0);
                expect(cli.composer).toBe(chip(1));
                expect(driver.submitState('task:late:n0')).toBe('unknown');
            } finally { driver.shutdown(); }
        });
    }

    it('a missing consumption probe is ambiguous: the chip is left, nothing is re-pasted or reported', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        const cli = fakeCli(pty, { del: 'whole' });
        const fired: string[] = [];
        try {
            driver.observeSubmitUnconfirmed('task:noprobe:n0', (verdict) => { fired.push(verdict); return true; });
            driver.sendMessageWithDisposition(BODY, false, 'task:noprobe:n0');
            await until(() => crs(pty) === 3);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(fired).toEqual([]);
            expect(pastes(pty)).toBe(1);
            expect(dels(pty)).toBe(0);
            expect(cli.composer).toBe(chip(1));
        } finally { driver.shutdown(); }
    });
});

describe('a human send (no verdict observer) keeps main exactly (review 9719d681 R3-1)', () => {
    it('ungated first CR, give-up at the last key: no gap, no read-driven wait, no DEL, no re-paste, no hold — the next chat goes out ~350 ms later', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        fakeCli(pty, { renderPaste: false });
        try {
            driver.sendMessageWithDisposition(BODY, false, 'msg_human_1');
            expect(driver.sendMessageWithDisposition('SECOND CHAT', false, 'msg_human_2').status).toBe('queued');
            const sentAt = Date.now();
            while (crs(pty) < 1) await vi.advanceTimersByTimeAsync(10);
            expect(Date.now() - sentAt).toBeLessThan(1_000); // main's skipEchoGate: never waits on a chip (the mesh gate's 3 s backstop)
            while (crs(pty) < 3) await vi.advanceTimersByTimeAsync(10);
            await vi.advanceTimersByTimeAsync(300);
            expect(wrote(pty, 'SECOND CHAT')).toBe(0);
            expect(driver.lastSubmitUnconfirmed()).toBe(true);
            await vi.advanceTimersByTimeAsync(200);
            expect(wrote(pty, 'SECOND CHAT')).toBe(1);
            expect(dels(pty)).toBe(0);
            expect(wrote(pty, 'TASK-HEAD')).toBe(1);
        } finally {
            driver.shutdown();
        }
    });

    it('a human chip left in the composer is never touched (main leaves it)', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        const cli = fakeCli(pty, { del: 'whole' });
        try {
            driver.sendMessageWithDisposition(BODY, false, 'msg_human_3');
            await vi.advanceTimersByTimeAsync(60_000);
            expect(dels(pty)).toBe(0);
            expect(pastes(pty)).toBe(1);
            expect(cli.composer).toBe(chip(1));
        } finally {
            driver.shutdown();
        }
    });
});

describe('DISPATCH-ACK PRODUCER — the engine serializes each dispatch\'s input acceptance', () => {
    it('a proven-unsent dispatch carries an unaccepted watermark bound to its exact messageId, readable from the verdict observer', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        fakeCli(pty, { del: 'whole' });
        try {
            const seen: Array<ReturnType<FsmDriver['dispatchAcknowledgement']>> = [];
            let firstWrittenAt = 0;
            driver.observeSubmitUnconfirmed('task:ack:n0', (_verdict, info) => {
                firstWrittenAt = info.firstWrittenAt;
                seen.push(driver.dispatchAcknowledgement('task:ack:n0'));
                return true;
            }, async () => 'not_consumed');
            driver.sendMessageWithDisposition(BODY, false, 'task:ack:n0');
            expect(driver.dispatchAcknowledgement('task:ack:n0')).toMatchObject({ messageId: 'task:ack:n0', unacceptedConfirmed: false });
            await until(() => seen.length === 1);
            expect(seen[0]).toMatchObject({ messageId: 'task:ack:n0', unacceptedConfirmed: true });
            expect(seen[0]!.watermarkSeq).toBeGreaterThanOrEqual(firstWrittenAt);
            // Exact id only — a neighbouring nonce or an unseen id has no watermark.
            expect(driver.dispatchAcknowledgement('task:ack:n1')).toBeNull();
            expect(driver.dispatchAcknowledgement(' task:ack:n0')).toBeNull();
        } finally {
            driver.shutdown();
        }
    });

    it('a dispatch the CLI took is never claimed unaccepted', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        fakeCli(pty, { takeEnterOnPaste: 1 });
        try {
            observe(driver, 'task:ack-taken:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:ack-taken:n0');
            await until(() => driver.submitState('task:ack-taken:n0') === 'confirmed');
            expect(driver.dispatchAcknowledgement('task:ack-taken:n0')).toMatchObject({ unacceptedConfirmed: false });
        } finally {
            driver.shutdown();
        }
    });

    it('an unproven (quarantined) dispatch is never claimed unaccepted', async () => {
        vi.useFakeTimers();
        setPlatform('darwin');
        const { driver, pty } = await readyDriver();
        fakeCli(pty, { del: 'whole' });
        try {
            observe(driver, 'task:ack-unk:n0');
            driver.sendMessageWithDisposition(BODY, false, 'task:ack-unk:n0');
            await until(() => crs(pty) === 3);
            driver.dispatch({ kind: 'pty_write', data: 'x' });
            await vi.advanceTimersByTimeAsync(60_000);
            expect(driver.submitState('task:ack-unk:n0')).toBe('unknown');
            expect(driver.dispatchAcknowledgement('task:ack-unk:n0')).toMatchObject({ unacceptedConfirmed: false });
        } finally {
            driver.shutdown();
        }
    });
});
