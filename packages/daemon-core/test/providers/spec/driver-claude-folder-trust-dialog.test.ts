/**
 * claude-cli folder-trust dialog (Claude Code 2.1.295/2.1.296).
 *
 * Live defect, 2026-10-10 (MainPC, win32): the dialog is now an UNNUMBERED
 * cursor list with the refusal first and focused. →approval needs a `1.` row,
 * so nothing matched; startup-grace carried the session to `idle` with the
 * dialog still on screen, the dashboard showed a ready session with no approval
 * card, and the owner's first message was typed into the dialog.
 *
 * The screen below is the one captured from that machine.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { evaluateFsm, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';
import { resolveSections } from '../../../src/providers/spec/evaluator.js';
import { deriveModal } from '../../../src/providers/spec/fsm-driver-modal.js';
import type { CliSpecV4 } from '../../../src/providers/spec/fsm-types.js';
import type { DashboardEvent } from '../../../src/providers/spec/fsm-driver-types.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

const SPEC_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../../../adhdev-providers/cli/claude-cli/specs/4.0.json',
);

function loadSpec(): CliSpecV4 {
    const raw = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
    const errs = validateFsmSpec(raw);
    if (errs.length) throw new Error(errs.join('; '));
    return raw as CliSpecV4;
}

const RULE = '─'.repeat(80);

function trustDialog(rows: string[]): string[] {
    return [
        '',
        RULE,
        ' Accessing workspace:',
        '',
        ' C:\\Users\\vilmi\\.adhdev-preview\\assistant',
        '',
        ' Quick safety check: Is this a project you created or one you trust? (Like your',
        ' own code, a well-known open source project, or work from your team). If not,',
        " take a moment to review what's in this folder first.",
        '',
        " Claude Code'll be able to read, edit, and execute files here.",
        '',
        ' Security guide',
        '',
        ...rows,
        '',
        ' Enter to confirm · Esc to cancel',
    ];
}

/** 2.1.295: refusal first, focused. */
const DIALOG_NO_FIRST = trustDialog([' ❯ No, exit', '   Yes, I trust this folder']);
/** The older numbered layout: acceptance first, focused. */
const DIALOG_NUMBERED = trustDialog([' ❯ 1. Yes, I trust this folder', '   2. No, exit']);

const COMPOSER = [
    ' ▐▛███▛█   Claude Code v2.1.295',
    '▝▜██████▀  Sonnet 5.5 with high effort · Claude Pro',
    ' ▝▝   ▝▝   ~\\.adhdev-preview\\assistant',
    '',
    RULE,
    '❯ Try "fix typecheck errors"',
    RULE,
    '  ⏸ manual mode on · ← for agents',
];

/** The same words, quoted in a conversation — not a live dialog. */
const QUOTED_IN_TRANSCRIPT = [
    '❯ what does the trust dialog say?',
    '',
    '● It offers two rows:',
    '',
    '   No, exit',
    '   Yes, I trust this folder',
    '',
    ' Enter to confirm · Esc to cancel',
    '',
    '✻ Crunched for 2s',
    '',
    RULE,
    '❯ ',
    RULE,
    '  ⏸ manual mode on · ← for agents',
];

const clk = (now: number): FsmClock => ({ now, stateEnteredAt: 0, regionLastChangedAt: new Map() });

function fired(spec: CliSpecV4, from: string, lines: string[], now = 500): string | null {
    const ev = evaluateFsm(spec, from, lines.join('\n'), { row: lines.length - 1, col: 0 }, undefined, clk(now));
    return ev.fired ? ev.fired.to : null;
}

describe('claude-cli spec — folder-trust dialog', () => {
    const spec = loadSpec();

    it('enters `trust` from starting instead of sitting in starting until startup-grace', () => {
        expect(fired(spec, 'starting', DIALOG_NO_FIRST)).toBe('trust');
        expect(fired(spec, 'starting', DIALOG_NUMBERED)).toBe('trust');
    });

    it('wins over startup-grace once the grace has elapsed, and is caught from idle too', () => {
        expect(fired(spec, 'starting', DIALOG_NO_FIRST, 60_000)).toBe('trust');
        expect(fired(spec, 'idle', DIALOG_NO_FIRST, 60_000)).toBe('trust');
    });

    it('is an approval-status modal', () => {
        const st = spec.states.find(s => s.id === 'trust')!;
        expect(st.modal).toBe(true);
        expect(st.modal_kind).toBe('approval');
    });

    it('parses both rows in screen order with the cursor row flagged', () => {
        const st = spec.states.find(s => s.id === 'trust')!;
        const text = DIALOG_NO_FIRST.join('\n');
        const modal = deriveModal(st, resolveSections(spec.sections, DIALOG_NO_FIRST, { row: 0, col: 0 }), text, () => {});
        expect(modal?.buttons.map(b => [b.index, b.label, b.current])).toEqual([
            [1, 'No, exit', true],
            [2, 'Yes, I trust this folder', false],
        ]);
        expect(modal?.title).toContain('Accessing workspace:');
        expect(modal?.title).toContain('C:\\Users\\vilmi\\.adhdev-preview\\assistant');

        const numbered = DIALOG_NUMBERED.join('\n');
        const m2 = deriveModal(st, resolveSections(spec.sections, DIALOG_NUMBERED, { row: 0, col: 0 }), numbered, () => {});
        expect(m2?.buttons.map(b => [b.index, b.label, b.current])).toEqual([
            [1, 'Yes, I trust this folder', true],
            [2, 'No, exit', false],
        ]);
    });

    it('does not fire on the composer, nor on the dialog text quoted in a transcript', () => {
        expect(fired(spec, 'starting', COMPOSER)).not.toBe('trust');
        expect(fired(spec, 'idle', COMPOSER)).not.toBe('trust');
        expect(fired(spec, 'idle', QUOTED_IN_TRANSCRIPT)).not.toBe('trust');
    });

    it('leaves `trust` for `starting` (not idle) once the dialog is gone, so startup-grace runs again', () => {
        expect(fired(spec, 'trust', DIALOG_NO_FIRST, 5_000)).toBeNull();
        expect(fired(spec, 'trust', COMPOSER, 5_000)).toBe('starting');
    });
});

// ── End to end through FsmDriver ────────────────────────────────────────────

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4848;
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
    spawn(_c: string, _a: string[], _o: PtySpawnOptions): PtyRuntimeTransport {
        this.last = new DrivablePty();
        return this.last;
    }
}

const CLEAR = '\x1b[2J\x1b[H';
const ORIGINAL_PLATFORM = process.platform;
const tmpHomes: string[] = [];

afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true });
    while (tmpHomes.length > 0) fs.rmSync(tmpHomes.pop()!, { recursive: true, force: true });
});

describe('FsmDriver + claude-cli spec — a session parked on the folder-trust dialog', () => {
    it('reports approval (never ready), holds the first message, answers by arrow keys, then delivers', async () => {
        vi.useFakeTimers();
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-trust-dialog-home-'));
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-trust-dialog-ws-'));
        tmpHomes.push(home, ws);
        const factory = new DrivableFactory();
        const driver = new FsmDriver({
            specPath: SPEC_PATH,
            workingDir: ws,
            hotReload: false,
            transportFactory: factory,
            extraEnv: { HOME: home, USERPROFILE: home },
        });
        const states: { id: string; status: string; buttons: string[] }[] = [];
        driver.subscribe((ev: DashboardEvent) => {
            if (ev.kind === 'state_changed') {
                states.push({ id: ev.state.id, status: ev.state.status, buttons: (ev.modal?.buttons ?? []).map(b => b.label) });
            }
        });
        driver.start();
        const pty = factory.last!;
        try {
            pty.feed(DIALOG_NO_FIRST.join('\r\n'));
            // Well past startup-grace (8 s): the session must still not read ready.
            await vi.advanceTimersByTimeAsync(12_000);
            const last = states[states.length - 1];
            expect(last.id).toBe('trust');
            expect(last.status).toBe('approval');
            expect(last.buttons).toEqual(['No, exit', 'Yes, I trust this folder']);
            expect(states.some(s => s.id === 'idle')).toBe(false);

            // The owner's first message is parked, not typed into the dialog.
            expect(driver.sendMessageWithDisposition('HELLO-ASSISTANT', false, 'm1').status).toBe('queued');
            await vi.advanceTimersByTimeAsync(3_000);
            expect(pty.writes.join('')).not.toContain('HELLO-ASSISTANT');

            // "Yes, I trust this folder" is row 2; the cursor is on row 1.
            pty.writes.length = 0;
            driver.dispatch({ kind: 'click_modal_button', index: 2 });
            expect(pty.writes.join('')).toBe('\x1b[B\r');

            // The CLI boots into its composer.
            pty.feed(CLEAR + COMPOSER.join('\r\n'));
            await vi.advanceTimersByTimeAsync(2_000);
            expect(states[states.length - 1].id).toBe('starting');
            expect(pty.writes.join('')).not.toContain('HELLO-ASSISTANT');

            await vi.advanceTimersByTimeAsync(9_000);
            expect(states[states.length - 1].id).toBe('idle');
            expect(pty.writes.join('')).toContain('HELLO-ASSISTANT');
        } finally {
            driver.shutdown();
        }
    });
});
