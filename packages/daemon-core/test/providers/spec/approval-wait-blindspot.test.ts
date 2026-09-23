/**
 * APPROVAL-WAIT-BLINDSPOT (live defect, 2026-09-22) — four independent ways the
 * engine failed to see, or failed to keep alive, a session waiting on a human.
 *
 * ★Why this file exists at all is itself the lesson. The antigravity approval
 * fixtures that shipped before this bug were all SHORT two-option modals whose
 * labels fitted on one line. The defect lives entirely in what happens when a
 * label WRAPS — so the existing suite was structurally incapable of catching it,
 * and the bug reached production with a green test run behind it. Every fixture
 * below therefore carries the wrapped/tall/off-screen shape, not a tidied one.
 *
 * Covered here, all driven through the REAL engine entry points
 * (`extractButtonsFromRule` / `evaluateFsm` / `statusForState`) against the REAL
 * shipped spec files — never a standalone regex. A bare `new RegExp(pattern)`
 * assertion is a known false-positive trap in this repo: FSM `matches` compiles
 * without the 'm' flag, so `^`/`$` bind to the whole screen and a regex tested
 * in isolation behaves differently than it does in the engine.
 *
 *   ① continuation-line parsing invents a phantom button from a wrapped path
 *   ② there is no status value meaning "blocked on a human, outside the terminal"
 *   ③ transition guards read the viewport while button extraction reads scrollback
 *   ④ the stall watchdog reaps a worker that is merely waiting for a person
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { evaluateFsm, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';
import { extractButtonsFromRule } from '../../../src/providers/spec/evaluator.js';
import { statusForState, type CliSpecV4, type FsmState } from '../../../src/providers/spec/fsm-types.js';
import { runMeshStallTick, MESH_WORKER_STALL_IDLE_THRESHOLD_MS, type MeshStallHost } from '../../../src/providers/completion/mesh-stall-watchdog.js';

function repoRoot(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');
}

function loadSpec(rel: string): CliSpecV4 {
    const full = path.join(repoRoot(), rel);
    const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    const errs = validateFsmSpec(raw);
    if (errs.length) throw new Error(`${rel}: ${errs.join('; ')}`);
    return raw as CliSpecV4;
}

function stateOf(spec: CliSpecV4, id: string): FsmState {
    const s = spec.states.find(x => x.id === id);
    if (!s) throw new Error(`spec has no state '${id}'`);
    return s;
}

/** The approval state's REAL button rule, read from the shipped spec rather than
 *  restated here — a copy would let the spec drift away from what is tested. */
function approvalButtonRule(spec: CliSpecV4) {
    const rule = stateOf(spec, 'approval').extract?.buttons;
    if (!rule) throw new Error("spec 'approval' state declares no extract.buttons");
    return rule;
}

function clk(now: number, entered: number): FsmClock {
    return { now, stateEnteredAt: entered, regionLastChangedAt: new Map() };
}

/** Minimal drivable PTY (same shape driver-sections-frame-consistency uses) so
 *  the driver-level assertions run the REAL FsmDriver + ghostty pipeline rather
 *  than a hand-built buffer — the scrollback behaviour under test only exists
 *  once a real terminal emulator has actually scrolled. */
class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4247;
    readonly ready = Promise.resolve();
    private dataCb: ((chunk: string) => void) | null = null;
    private exitCb: ((info: { exitCode: number }) => void) | null = null;
    write(): void { /* no-op */ }
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

// ════════════════════════════════════════════════════════════════════════════
// ① Wrapped-path phantom button
// ════════════════════════════════════════════════════════════════════════════

/**
 * VERBATIM shape from the live incident: an antigravity approval whose first
 * option quotes a long absolute path. At 80 columns the path wraps, and the
 * wrap lands INSIDE a numeric directory segment — so the continuation line
 * begins `1790054.3821/...`, which the button pattern
 * `^\s*(?:[❯›>]\s*)?(\d+)\.\s*(\S.+?)\s*$` reads as "option number 1790054".
 *
 * The phantom is not the damage. The damage is that it sits BETWEEN real
 * options 1 and 2 in screen order, which breaks `lastContiguousNumberedBlock`'s
 * descend-by-one scan at that point: the block reduces to [2,3,4], option 1
 * silently disappears, and the modal still looks perfectly plausible. A
 * coordinator approving "option 1" then pressed option 3 — "No, and tell agent
 * what to do differently" instead of "Yes, run command".
 *
 * `cursor` is parameterized because the two spec families render the focused
 * row with different glyphs — antigravity's pattern accepts `❯›>`, codex's only
 * `›>`. Using one spec's marker against the other would make option 1 fail to
 * match for an uninteresting reason and quietly turn the assertion vacuous.
 */
function wrappedPathApproval(cursor: string): string {
    return [
        '  Do you want to proceed?',
        '',
        `${cursor} 1. Yes, run command 'node /Users/vilmire/Work/adhdev/.cache/build-`,
        "     1790054.3821/emit.mjs'",
        "  2. Yes, and don't ask again for this command",
        '  3. No, and tell agent what to do differently',
        '  4. No, and cancel',
    ].join('\n');
}

describe('① wrapped path in a numbered option must not invent a button', () => {
    for (const { rel, cursor } of [
        { rel: 'adhdev-providers/cli/antigravity-cli/specs/4.0.json', cursor: '❯' },
        { rel: 'adhdev-providers/cli/codex-cli/specs/4.0.json', cursor: '›' },
    ]) {
        it(`${path.basename(path.dirname(path.dirname(rel)))}: keeps all four options and their labels`, () => {
            const spec = loadSpec(rel);
            const rule = approvalButtonRule(spec);
            // Precondition: this spec is one of the three that actually use the
            // continuation-lines path. If that ever stops being true the test
            // below would pass vacuously against the non-wrapping branch.
            expect(rule.continuation_lines, 'this test only means anything on the continuation path').toBe(true);

            const screen = wrappedPathApproval(cursor);
            // Precondition: the cursor glyph must actually be one this spec's
            // pattern accepts, or option 1 would fail to match for a reason that
            // has nothing to do with the bug under test.
            expect(new RegExp(rule.pattern, 'm').test(screen.split('\n')[2]),
                `spec pattern must accept the '${cursor}' focus marker`).toBe(true);

            const buttons = extractButtonsFromRule(rule, screen);

            // The regression: before the fix this was [2, 3, 4].
            expect(buttons.map(b => b.index)).toEqual([1, 2, 3, 4]);

            // The wrapped tail must be FOLDED INTO option 1's label, not dropped
            // and not promoted to its own row — the label is what the dashboard
            // shows and what pickApprovalButton matches on.
            expect(buttons[0].label).toContain('Yes, run command');
            expect(buttons[0].label).toContain('1790054.3821/emit.mjs');
            expect(buttons[0].current, 'the ❯ cursor row must still be option 1').toBe(true);

            // And the option a coordinator means by "1" is the affirmative one.
            expect(buttons[0].label).toMatch(/^Yes/);
            expect(buttons[2].label).toMatch(/^No/);
        });
    }

    it('codex 0.137 (legacy modal_buttons rule) is fixed by the same engine change', () => {
        // codex 0.137 carries its rule at states[].modal_buttons rather than
        // extract.buttons. Reading it from the shipped file keeps this honest:
        // the point is that ONE engine fix covers all three continuation specs.
        const raw = JSON.parse(fs.readFileSync(
            path.join(repoRoot(), 'adhdev-providers/cli/codex-cli/specs/0.137.json'), 'utf8'));
        const rules = (raw.states ?? [])
            .map((s: any) => s.modal_buttons)
            .filter((r: any) => r?.continuation_lines === true);
        expect(rules.length, 'codex 0.137 should declare continuation_lines rules').toBeGreaterThan(0);
        for (const rule of rules) {
            expect(extractButtonsFromRule(rule, wrappedPathApproval('›')).map((b: any) => b.index))
                .toEqual([1, 2, 3, 4]);
        }
    });

    it('does NOT clamp legitimately long option lists (no hardcoded ceiling)', () => {
        // The guard is structural (an index may only open a new button if it
        // CONTINUES the sequence), deliberately not a magnitude cap — a cap
        // would merely relocate the cliff to the first picker with many rows.
        const spec = loadSpec('adhdev-providers/cli/antigravity-cli/specs/4.0.json');
        const many = Array.from({ length: 12 }, (_, i) => `  ${i + 1}. Option number ${i + 1}`).join('\n');
        expect(extractButtonsFromRule(approvalButtonRule(spec), many).map(b => b.index))
            .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    });

    it('still folds ordinary (non-numeric) wrapped labels, as before the fix', () => {
        const spec = loadSpec('adhdev-providers/cli/antigravity-cli/specs/4.0.json');
        const screen = [
            '  1. Yes, apply this very long edit to the configuration file that',
            '     continues onto a second line',
            '  2. No',
        ].join('\n');
        const buttons = extractButtonsFromRule(approvalButtonRule(spec), screen);
        expect(buttons.map(b => b.index)).toEqual([1, 2]);
        expect(buttons[0].label).toContain('continues onto a second line');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// ② A status value for "waiting on a human, outside the terminal"
// ════════════════════════════════════════════════════════════════════════════

/**
 * VERBATIM grok-cli browser-login screen. Before this fix it matched NO state in
 * the spec at all: the FSM sat in `starting`, the startup grace timer moved it
 * to `idle` after 8s, and a session that could not accept a single keystroke was
 * advertised as ready. Nothing was logged, so the approval inbox showed zero
 * rows and the coordinator had no way to learn a human was needed.
 */
const GROK_BROWSER_LOGIN = [
    '',
    '                              Sign in to Grok Build',
    '',
    '            Approve in your browser to continue. If the page did not open,',
    '            visit https://x.ai/device and enter code  WQDF-7TZP',
    '',
    '                                Waiting for approval...',
    '',
    '                                          Grok Build  1.0.4 [stable]',
].join('\n');

describe('② an external-auth wait is representable and visible', () => {
    const spec = loadSpec('adhdev-providers/cli/grok-cli/specs/1.0.json');

    it('grok login screen drives the FSM into signing_in from starting', () => {
        const res = evaluateFsm(spec, 'starting', GROK_BROWSER_LOGIN, { row: 0, col: 0 },
            GROK_BROWSER_LOGIN.split('\n'), clk(1_000_000, 1_000_000 - 9000));
        expect((res.fired as { to?: string } | null)?.to).toBe('signing_in');
    });

    it('signing_in reports waiting_external — not generating, not idle', () => {
        const st = stateOf(spec, 'signing_in');
        expect(statusForState(st)).toBe('waiting_external');
        // ★It must NOT be modal. There are no buttons on a browser-login screen,
        // so declaring it modal would produce an approval the coordinator could
        // never answer (mesh_approve with nothing to press) — the deadlock shape
        // grok's old button-less `trust` state already cost us once.
        expect(st.modal ?? false).toBe(false);
        expect(st.extract?.buttons).toBeUndefined();
    });

    it('the login wait outranks the 8s startup grace (it must not decay to idle)', () => {
        // startup-grace fires starting→idle on elapsed_ms alone. Without a higher
        // priority the login screen would be reported ready after 8 seconds.
        const grace = spec.transitions.find(t => t.label === 'startup-grace');
        const signin = spec.transitions.find(t => t.label === '→signing_in');
        expect((signin?.priority ?? 0)).toBeGreaterThan(grace?.priority ?? 0);
    });

    it('leaves signing_in once the prompt is drawn', () => {
        const readyScreen = [
            '  │ ❯',
            '  Shift+Tab:mode │ Ctrl+x:shortcuts',
        ].join('\n');
        const res = evaluateFsm(spec, 'signing_in', readyScreen, { row: 0, col: 0 },
            readyScreen.split('\n'), clk(1_000_000, 1_000_000 - 9000));
        expect((res.fired as { to?: string } | null)?.to).toBe('idle');
    });

    it('a waiting_external state may not also be modal (loader rejects it)', () => {
        const bad = JSON.parse(JSON.stringify(spec));
        bad.states.find((s: any) => s.id === 'signing_in').modal = true;
        expect(validateFsmSpec(bad).join(' ')).toMatch(/waiting_external.*modal/);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// ③ Transition guards must see what button extraction sees
// ════════════════════════════════════════════════════════════════════════════

describe('③ a tall modal whose anchor scrolled above the viewport still transitions', () => {
    const spec = loadSpec('adhdev-providers/cli/antigravity-cli/specs/4.0.json');

    // A tall diff pushes the modal's anchor text above the viewport. The buttons
    // remain visible at the bottom, so `deriveModal` (scrollback-inclusive) found
    // them all along — while the `→approval` guard, reading the viewport only,
    // saw no anchor and never fired. Live cost: `waiting_approval` arrived 4
    // minutes late, by which point the task had been reaped and the event was
    // dropped as `stale`.
    const modalAnchorLine = '  Do you want to proceed?';
    const buttonLines = [
        '❯ 1. Yes, run command',
        "  2. Yes, and don't ask again for this command",
        '  3. No, and tell agent what to do differently',
    ];
    const tallDiff = Array.from({ length: 60 }, (_, i) => `  + added line ${i + 1} of the diff`);

    const fullBuffer = [modalAnchorLine, ...tallDiff, ...buttonLines];
    // The viewport shows only the tail — the anchor has scrolled off the top.
    const viewportOnly = fullBuffer.slice(fullBuffer.length - 24);

    it('the viewport alone genuinely loses the anchor (fixture precondition)', () => {
        expect(viewportOnly.join('\n')).not.toContain('Do you want to proceed?');
        expect(viewportOnly.join('\n')).toContain('2. Yes, and');
    });

    it('guards evaluated on the scrollback-inclusive frame DO reach approval', () => {
        const res = evaluateFsm(spec, 'busy', fullBuffer.join('\n'), { row: 0, col: 0 },
            fullBuffer, clk(1_000_000, 1_000_000 - 30_000));
        expect((res.fired as { to?: string } | null)?.to).toBe('approval');
    });

    it('guards evaluated on the viewport alone do NOT — which is the defect', () => {
        const res = evaluateFsm(spec, 'busy', viewportOnly.join('\n'), { row: 0, col: 0 },
            viewportOnly, clk(1_000_000, 1_000_000 - 30_000));
        expect((res.fired as { to?: string } | null)?.to).not.toBe('approval');
    });

    // ── End-to-end through the REAL driver ──────────────────────────────────
    //
    // The two assertions above pin the evaluator's behaviour given each frame,
    // but the DEFECT was never in the evaluator — it was in which frame the
    // driver handed it. Only a test that drives a real FsmDriver over a real PTY
    // can catch a regression in FsmDriver.buildGuardFrame, so the scrollback
    // path is exercised here rather than simulated.
    it('the real driver reaches approval when the anchor has scrolled off-screen', async () => {
        const factory = new DrivableFactory();
        const driver = new FsmDriver({
            specPath: path.join(repoRoot(), 'adhdev-providers/cli/antigravity-cli/specs/4.0.json'),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;
        try {
            // Paint the anchor, then push it above the viewport with a tall diff,
            // leaving only the choices visible. `\r\n` so ghostty genuinely
            // scrolls (and thus genuinely moves the anchor into scrollback)
            // rather than us hand-constructing a buffer.
            pty.feed('\x1b[2J\x1b[1;1H');
            pty.feed('Do you want to proceed?\r\n');
            for (let i = 0; i < 60; i += 1) pty.feed(`  + added line ${i + 1} of the diff\r\n`);
            pty.feed('❯ 1. Yes, run command\r\n');
            pty.feed("  2. Yes, and don't ask again for this command\r\n");
            pty.feed('  3. No, and tell agent what to do differently\r\n');
            await new Promise(r => setTimeout(r, 120));

            // Precondition: the anchor really is gone from the viewport, so the
            // assertion below cannot pass for the trivial reason.
            expect(driver.snapshot()).not.toContain('Do you want to proceed?');
            expect(driver.snapshot()).toContain("2. Yes, and don't ask again");

            // The whole point: the →approval guard fires even though its anchor
            // is no longer in the viewport. Assert the COMMITTED state — the
            // transition has already happened by now, so inspecting outgoing
            // transitions would find no `→approval` edge left to look at.
            const debug = driver.getFsmDebug();
            expect(debug.currentState,
                'the →approval guard must fire on the scrollback-inclusive guard frame').toBe('approval');
            expect(debug.status).toBe('approval');
        } finally {
            driver.shutdown();
        }
    });

    it('getSections (no argument) reports the off-screen anchor text too', async () => {
        const factory = new DrivableFactory();
        const driver = new FsmDriver({
            specPath: path.join(repoRoot(), 'adhdev-providers/cli/antigravity-cli/specs/4.0.json'),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;
        try {
            pty.feed('\x1b[2J\x1b[1;1H');
            pty.feed('Do you want to proceed?\r\n');
            for (let i = 0; i < 60; i += 1) pty.feed(`  + added line ${i + 1} of the diff\r\n`);
            pty.feed('❯ 1. Yes, run command\r\n');
            pty.feed('  2. No\r\n');
            await new Promise(r => setTimeout(r, 120));
            expect(driver.snapshot()).not.toContain('Do you want to proceed?');

            const sections = driver.getSections();
            expect(sections).not.toBeNull();
            const joined = sections!.map(s => s.text).join('\n');
            expect(joined,
                'a self-snapshotting getSections must use the same frame the guards do').toContain('Do you want to proceed?');
        } finally {
            driver.shutdown();
        }
    });

    it('the caller-supplied-screen contract is unchanged (frame consistency)', async () => {
        // driver-sections-frame-consistency.test.ts owns this contract; asserted
        // here too because fix ③ touched the very branch it guards — a caller
        // who hands in a screen must still get sections sliced from THAT screen,
        // never from a scrollback-extended second read.
        const factory = new DrivableFactory();
        const driver = new FsmDriver({
            specPath: path.join(repoRoot(), 'adhdev-providers/cli/antigravity-cli/specs/4.0.json'),
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        const pty = factory.last!;
        try {
            pty.feed('\x1b[2J\x1b[1;1HFRAME-A\x1b[30;1HFOOTER-A');
            await new Promise(r => setTimeout(r, 50));
            const held = driver.snapshot();
            pty.feed('\x1b[2J\x1b[1;1HFRAME-B\x1b[30;1HFOOTER-B');
            await new Promise(r => setTimeout(r, 50));

            const byId = Object.fromEntries(driver.getSections(held)!.map(s => [s.id, s.text]));
            expect(byId.body).toContain('FRAME-A');
            expect(byId.body).not.toContain('FRAME-B');
        } finally {
            driver.shutdown();
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════
// ④ The stall watchdog must not reap a worker waiting on a person
// ════════════════════════════════════════════════════════════════════════════

function stallHost(observedStatus: string, approvalResolvedAt = 0, lastOutputAt = 1_000): MeshStallHost & { events: Record<string, unknown>[] } {
    const events: Record<string, unknown>[] = [];
    return {
        events,
        instanceId: 'sess-blindspot',
        type: 'antigravity',
        startedAt: 0,
        adapter: {
            isAlive: () => true,
            // allowParse:false status read — the ONLY liveness fact that survives
            // a broken event path, which is the whole point of fix ④.
            getStatus: () => ({ lastOutputAt, status: observedStatus }),
            getLastApprovalResolvedAt: () => approvalResolvedAt,
        },
        meshStallAnchorAt: 1_000,
        meshStallEmittedForAnchor: false,
        meshStallTurnActiveLast: false,
        meshStallLastFiredAt: -1,
        meshStallTranscriptSignalSampled: false,
        isMeshWorkerSession: () => true,
        hasAdapterPendingResponse: () => false,
        probeNativeTranscriptSignals: () => null,
        tryReconcileTranscriptCompletionForStall: () => false,
        meshTraceCtx: () => ({}),
        completingTurnTaskId: () => 'task-blindspot',
        pushEvent: (e) => { events.push(e); },
    };
}

/** Well past the idle threshold, so the watchdog would fire but for a veto. */
const WAY_PAST_THRESHOLD = 1_000 + MESH_WORKER_STALL_IDLE_THRESHOLD_MS + 60_000;

describe('④ stall watchdog vetoes on a live prompt, with no ledger row required', () => {
    it('does not fire while the adapter reports waiting_approval', () => {
        const host = stallHost('waiting_approval');
        runMeshStallTick(host, WAY_PAST_THRESHOLD);
        expect(host.events.map(e => e.event)).not.toContain('monitor:no_progress');
        // Re-armed, not permanently suppressed: the episode clock restarts so a
        // session that later genuinely wedges is still caught.
        expect(host.meshStallAnchorAt).toBe(WAY_PAST_THRESHOLD);
        expect(host.meshStallEmittedForAnchor).toBe(false);
    });

    it('does not fire while the adapter reports waiting_choice', () => {
        const host = stallHost('waiting_choice');
        runMeshStallTick(host, WAY_PAST_THRESHOLD);
        expect(host.events.map(e => e.event)).not.toContain('monitor:no_progress');
    });

    it('STILL fires for a genuinely wedged generating worker', () => {
        // The veto must be narrow. A worker stuck mid-turn with no prompt on
        // screen is the real stall this watchdog exists for and must survive.
        const host = stallHost('generating');
        runMeshStallTick(host, WAY_PAST_THRESHOLD);
        expect(host.events.map(e => e.event)).toContain('monitor:no_progress');
    });

    it('STILL fires for a silently idle wedged worker', () => {
        const host = stallHost('idle');
        runMeshStallTick(host, WAY_PAST_THRESHOLD);
        expect(host.events.map(e => e.event)).toContain('monitor:no_progress');
    });

    it('fires when a successful approval decision is newer than the stale waiting_approval latch', () => {
        const host = stallHost('waiting_approval', 2_000, 1_000);
        runMeshStallTick(host, WAY_PAST_THRESHOLD);
        expect(host.events.map(e => e.event)).toContain('monitor:no_progress');
    });

    it('still protects a new genuine approval rendered after the previous resolution', () => {
        const host = stallHost('waiting_approval', 2_000, 3_000);
        runMeshStallTick(host, WAY_PAST_THRESHOLD);
        expect(host.events.map(e => e.event)).not.toContain('monitor:no_progress');
    });
});
