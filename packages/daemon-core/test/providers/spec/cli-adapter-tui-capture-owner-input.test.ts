import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { evaluateFsm, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';
import { resolveSections, sectionText, extractButtonsFromRule } from '../../../src/providers/spec/evaluator.js';
import type { CliSpecV4 } from '../../../src/providers/spec/fsm-types.js';

// MULTI-CHOICE SUBMIT TANGLE (owner-reported, live-reproduced): on a claude-cli
// AskUserQuestion picker with TWO OR THREE question tabs, pressing Enter in the
// attached terminal frequently does nothing — the screen stays parked on the
// selection. A single-question prompt always works.
//
// Root cause: maybeCaptureClaudeTuiPrompt() injects Tab / Shift-Tab into the
// PTY to snapshot pages 2..N for the dashboard. A single-question prompt never
// injects (the page loop is empty); a 2-3 question prompt injects 2(N-1)
// navigation keys into the SAME input stream the owner is typing into. Worse,
// when the capture cannot produce a prompt (the focused page is the final
// "Ready to submit your answers?" review screen, which parses to null by
// design), activeInteractivePrompt stays null — so the NEXT pty_data frame
// re-detects the picker and injects the navigation keys AGAIN, exactly as the
// owner reported: "서밋 누를 때 디텍트가 한번 더 되면서 꼬인다".
//
// The fix (all in the adapter, no spec change):
//   1. Never start a capture on the review/submit screen.
//   2. An owner keystroke (writeRaw) while the picker is on screen suppresses
//      capture for the rest of that picker's lifetime and aborts an in-flight
//      capture before its next injected key.
//   3. A capture that fails to parse is retried at most once per prompt (nav
//      line identity), so an unparseable picker cannot become a key-injection
//      storm.
//   4. (latch-gap follow-up) The latch from (2) used to clear on ONE frame
//      without the picker footer — but claude repaints the picker in chunks,
//      so a mid-repaint frame re-armed capture and restarted injection while
//      the owner was mid-answer. The latch now re-arms only after the footer
//      has stayed absent for the repaint-grace window, and writeRaw treats a
//      held prompt / in-flight capture as picker-on-screen evidence so a
//      keystroke landing on a footer-less repaint frame still sets it.
//
// These tests drive the REAL SpecCliAdapter against a scripted driver, so a
// revert of the fix turns them red.

const footer = 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel';

function page(nav: string, question: string, options: string[], multi = true): string {
    return [
        nav,
        '',
        question,
        '',
        ...options.map((o, i) => `${i === 0 ? '❯' : ' '} ${i + 1}. ${multi ? '[ ] ' : ''}${o}`),
        '────────────────────────────────────────────────',
        footer,
    ].join('\n');
}

const nav1 = '←  ☐ 모드  ✔ Submit  →';
const nav2 = '←  ☐ 아침  ☐ 점심  ✔ Submit  →';
const nav3 = '←  ☐ 아침  ☐ 점심  ☐ 저녁  ✔ Submit  →';

const singleQuestionPage = page(nav1, '실행 모드를 고르세요', ['빠르게', '안전하게']);

const threeQuestionPages = [
    page(nav3, '아침 반찬으로 무엇을 드시겠어요?', ['계란말이', '김구이', '콩자반']),
    page(nav3, '점심 반찬으로 무엇을 드시겠어요?', ['제육볶음', '시금치나물', '감자조림']),
    page(nav3, '저녁 반찬으로 무엇을 드시겠어요?', ['고등어구이', '두부조림', '오이무침']),
];

// The final review screen: nav line all-checked, Submit pre-selected, and the
// "Enter to select" footer still rendered — so maybeCaptureClaudeTuiPrompt
// sees a capturable picker, while parseClaudeInteractiveTuiQuestion returns
// null for it BY DESIGN (interactive-prompt.ts review-screen guard).
const reviewScreen = [
    '←  ☒ 아침  ☒ 점심  ✔ Submit  →',
    '',
    'Ready to submit your answers?',
    '',
    '❯ Submit answers',
    '  Cancel',
    '',
    footer,
].join('\n');

// A picker page whose option rows are clipped/scrolled out: nav + question +
// footer but NO numbered options, so the capture can never parse it.
const unparseablePage = [
    nav2,
    '',
    '아침 반찬으로 무엇을 드시겠어요?',
    '',
    '────────────────────────────────────────────────',
    footer,
].join('\n');

interface ScriptedAdapter {
    adapter: any;
    injected: string[];
}

/** A SpecCliAdapter whose driver serves a scripted screen and records every
 *  pty_write the adapter dispatches (the keys it would inject into the PTY). */
function makeAdapter(currentScreen: () => string): ScriptedAdapter {
    const injected: string[] = [];
    const adapter: any = Object.create(SpecCliAdapter.prototype);
    Object.assign(adapter, {
        cliType: 'claude-cli',
        cliName: 'Claude Code',
        workingDir: '/tmp/work',
        spec: { id: 'claude-cli', name: 'Claude Code' },
        activeInteractivePrompt: null,
        interactivePromptTransport: null,
        interactivePromptLostAt: null,
        claudeTuiPromptCaptureInFlight: false,
        claudeTuiCaptureSuppressed: false,
        claudeTuiCaptureFailures: null,
        claudeTuiCaptureFooterAbsentAt: null,
        statusCallback: vi.fn(),
        driver: {
            snapshot: currentScreen,
            dispatch: (event: any) => {
                if (event?.kind === 'pty_write') injected.push(event.data);
            },
        },
    });
    return { adapter, injected };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe('claude TUI capture — owner-in-terminal interference', () => {
    it('single-question picker: capture injects ZERO keys (regression guard — this case always worked)', async () => {
        const { adapter, injected } = makeAdapter(() => singleQuestionPage);
        adapter.maybeCaptureClaudeTuiPrompt();
        await sleep(400);
        expect(injected).toEqual([]);
        expect(adapter.activeInteractivePrompt).not.toBeNull();
        expect(adapter.activeInteractivePrompt.questions).toHaveLength(1);
    });

    it('multi-question picker with NO owner input: capture still completes (dashboard value preserved)', async () => {
        let focused = 0;
        const { adapter, injected } = makeAdapter(() => threeQuestionPages[focused]);
        adapter.driver.dispatch = (event: any) => {
            if (event?.kind !== 'pty_write') return;
            injected.push(event.data);
            if (event.data === '\t') focused = Math.min(focused + 1, 2);
            if (event.data === '\x1b[Z') focused = Math.max(focused - 1, 0);
        };
        adapter.maybeCaptureClaudeTuiPrompt();
        await sleep(1500);
        expect(adapter.activeInteractivePrompt).not.toBeNull();
        expect(adapter.activeInteractivePrompt.questions.map((q: any) => q.question)).toEqual([
            '아침 반찬으로 무엇을 드시겠어요?',
            '점심 반찬으로 무엇을 드시겠어요?',
            '저녁 반찬으로 무엇을 드시겠어요?',
        ]);
        // Characterization: 2(N-1) navigation keys for N=3. This is exactly the
        // injection the owner races against when answering in the terminal.
        expect(injected).toEqual(['\t', '\t', '\x1b[Z', '\x1b[Z']);
    });

    it('review/submit screen: capture must NOT inject keys and must NOT re-detect', async () => {
        const { adapter, injected } = makeAdapter(() => reviewScreen);
        adapter.maybeCaptureClaudeTuiPrompt();
        await sleep(1600); // a full (failing) capture cycle, pre-fix
        adapter.maybeCaptureClaudeTuiPrompt(); // the "detect once more" frame
        await sleep(200);
        expect(injected).toEqual([]);
        expect(adapter.activeInteractivePrompt).toBeNull();
    });

    it('an owner keystroke while the picker is open aborts an in-flight capture and suppresses re-capture', async () => {
        let focused = 0;
        const { adapter, injected } = makeAdapter(() => threeQuestionPages[focused]);
        adapter.driver.dispatch = (event: any) => {
            if (event?.kind !== 'pty_write') return;
            injected.push(event.data);
            if (event.data === '\t') focused = Math.min(focused + 1, 2);
            if (event.data === '\x1b[Z') focused = Math.max(focused - 1, 0);
        };
        adapter.maybeCaptureClaudeTuiPrompt(); // capture starts; first Tab is synchronous
        adapter.writeRaw('1'); // the owner answers question 1 in the terminal
        await sleep(1000);
        // Count only daemon-injected navigation keys (the scripted driver also
        // records the owner's own '1'). The first Tab went out on the detection
        // frame (before the owner could possibly react); every daemon key
        // AFTER the owner's input must be withheld.
        const navKeys = () => injected.filter(k => k === '\t' || k === '\x1b[Z');
        expect(navKeys().length).toBeLessThanOrEqual(1);
        expect(adapter.activeInteractivePrompt).toBeNull(); // capture bailed, nothing half-held
        // The picker is still on screen; re-detection must stay suppressed.
        adapter.maybeCaptureClaudeTuiPrompt();
        await sleep(300);
        expect(navKeys().length).toBeLessThanOrEqual(1);
    });

    it('an unparseable picker is retried at most once — no key-injection storm', async () => {
        const { adapter, injected } = makeAdapter(() => unparseablePage);
        // Three consecutive detection frames (each pty_data re-runs maybeCapture).
        for (let attempt = 0; attempt < 3; attempt += 1) {
            adapter.maybeCaptureClaudeTuiPrompt();
            await sleep(1700); // one full capture cycle (Tab + settle + Shift-Tab + settle)
        }
        // 2 questions → one full capture attempt injects 2 keys (Tab + Shift-Tab).
        // The fix allows at most 2 attempts per prompt identity, then gives up.
        expect(injected.length).toBeLessThanOrEqual(4);
        expect(adapter.activeInteractivePrompt).toBeNull();
    }, 20000);
});

// ────────────────────────────────────────────────────────────────────────────
// LATCH RE-ARM RACE (rc.9 residual, owner-reported 2026-08-24): with the
// owner-input latch already in place, a 3-question picker STILL tangled at
// Submit. Root cause: the latch cleared on ONE frame without the "Enter to
// select" footer, but claude repaints the picker in chunks — a mid-repaint
// frame re-armed capture, and the next footer frame restarted Tab/Shift-Tab
// injection into the stream the owner was typing in. These tests pin the
// frame ORDER deterministically with fake timers (no wall-clock races).
// ────────────────────────────────────────────────────────────────────────────

describe('claude TUI capture — latch repaint hysteresis (deterministic race repro)', () => {
    // Footer-less frame DURING a chunked repaint: nav + question still on
    // screen, only the footer chunk has not arrived yet.
    const midRepaintFrame = [nav3, '', '아침 반찬으로 무엇을 드시겠어요?', ''].join('\n');

    it('a mid-repaint footer-less frame must NOT re-arm capture while the owner is answering', async () => {
        vi.useFakeTimers();
        try {
            let focused = 0;
            let screen: string = threeQuestionPages[0];
            const { adapter, injected } = makeAdapter(() => screen);
            adapter.driver.dispatch = (event: any) => {
                if (event?.kind !== 'pty_write') return;
                injected.push(event.data);
                if (event.data === '\t') focused = Math.min(focused + 1, 2);
                if (event.data === '\x1b[Z') focused = Math.max(focused - 1, 0);
            };
            const navKeys = () => injected.filter(k => k === '\t' || k === '\x1b[Z');

            // Frame 1: picker detected; capture starts and injects Tab #1
            // synchronously (before any human could react — by design).
            adapter.maybeCaptureClaudeTuiPrompt();
            expect(navKeys()).toHaveLength(1);

            // The owner starts answering in the terminal → latch set; the
            // in-flight capture bails at its next key boundary.
            adapter.writeRaw(' ');
            await vi.advanceTimersByTimeAsync(1000);
            expect(navKeys()).toHaveLength(1);
            expect(adapter.activeInteractivePrompt).toBeNull();

            // The owner's own keystroke makes claude redraw the picker in
            // chunks: a frame WITHOUT the footer, then one WITH it again.
            screen = midRepaintFrame;
            adapter.maybeCaptureClaudeTuiPrompt(); // mid-repaint frame
            screen = threeQuestionPages[focused];
            adapter.maybeCaptureClaudeTuiPrompt(); // footer restored

            // Pre-fix: the footer-less frame cleared the latch instantly, so
            // the restored-footer frame restarted capture and injected
            // another Tab — into the stream the owner is typing in.
            // Post-fix: the latch survives the transient frame.
            expect(navKeys()).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(2000);
            expect(navKeys()).toHaveLength(1);
            expect(adapter.activeInteractivePrompt).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('an owner keystroke landing on a footer-less mid-repaint frame still sets the latch', async () => {
        vi.useFakeTimers();
        try {
            let screen: string = midRepaintFrame; // footer chunk not yet arrived
            const { adapter, injected } = makeAdapter(() => screen);
            const navKeys = () => injected.filter(k => k === '\t' || k === '\x1b[Z');

            // A prompt is held from an earlier capture — the picker is alive,
            // only the footer chunk is missing from this frame.
            adapter.activeInteractivePrompt = { promptId: 'held-prompt' };
            adapter.writeRaw('2'); // owner answers mid-repaint
            adapter.activeInteractivePrompt = null; // then resolved/cleared

            // Footer restored. Pre-fix: the mid-repaint keystroke never set
            // the latch (footer absent in that instant's snapshot), so this
            // frame starts injecting. Post-fix: held-prompt evidence set the
            // latch, capture stays suppressed.
            screen = threeQuestionPages[0];
            adapter.maybeCaptureClaudeTuiPrompt();
            await vi.advanceTimersByTimeAsync(2000);
            expect(navKeys()).toHaveLength(0);
            expect(adapter.activeInteractivePrompt).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('the latch still re-arms once the picker is genuinely gone (grace window elapsed)', async () => {
        vi.useFakeTimers();
        try {
            let screen: string = threeQuestionPages[0];
            const { adapter, injected } = makeAdapter(() => screen);
            const injectedTabs = () => injected.filter(k => k === '\t');

            adapter.writeRaw('1'); // owner keystroke with picker on screen
            expect(adapter.claudeTuiCaptureSuppressed).toBe(true);
            adapter.maybeCaptureClaudeTuiPrompt();
            expect(injectedTabs()).toHaveLength(0);

            // Picker closes: footer absent, but only past the grace window.
            screen = '';
            adapter.maybeCaptureClaudeTuiPrompt(); // grace starts
            expect(adapter.claudeTuiCaptureSuppressed).toBe(true);
            await vi.advanceTimersByTimeAsync(2000); // > INTERACTIVE_PROMPT_LOST_GRACE_MS
            adapter.maybeCaptureClaudeTuiPrompt(); // grace elapsed → re-armed
            expect(adapter.claudeTuiCaptureSuppressed).toBe(false);

            // A NEW picker must be able to capture again (dashboard value).
            screen = threeQuestionPages[0];
            adapter.maybeCaptureClaudeTuiPrompt();
            expect(injectedTabs().length).toBeGreaterThan(0);
        } finally {
            vi.useRealTimers();
        }
    });
});

// ────────────────────────────────────────────────────────────────────────────
// FSM 판정 실측 — the "missing m flag breaks modal anchoring for 2-3 items"
// hypothesis. anchor / anchor_context / until are compiled without flags but
// evaluated PER LINE (evaluator.ts resolveSections), so `^`/`$` anchor to each
// line, not the whole screen; `matches` conditions default to 'i' but the spec
// writes them with explicit (?:^|\n). These tests pin the empirical result:
// the engine's judgment does NOT depend on the number of choices.
// ────────────────────────────────────────────────────────────────────────────

function resolveSpecPath(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '../../../../../..');
    const candidates = [
        path.join(repoRoot, 'adhdev-providers/cli/claude-cli/specs/4.0.json'),
        path.join(process.env.HOME ?? '', '.adhdev/providers/.upstream/cli/claude-cli/specs/4.0.json'),
    ];
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) throw new Error('claude-cli 4.0.json spec not found in: ' + candidates.join(', '));
    return found;
}

function loadSpec(): CliSpecV4 {
    const raw = JSON.parse(fs.readFileSync(resolveSpecPath(), 'utf8'));
    const errs = validateFsmSpec(raw);
    if (errs.length) throw new Error(errs.join('; '));
    return raw as CliSpecV4;
}

function clk(now: number, entered: number): FsmClock {
    return { now, stateEnteredAt: entered, regionLastChangedAt: new Map() };
}

/** Single-question AskUserQuestion picker with `optionCount` numbered options. */
function askScreenByOptions(optionCount: number): string {
    const labels = ['알파', '베타', '감마'].slice(0, optionCount);
    return [
        '⏺ 확인할 게 있어요.',
        '────────────────────────────────────────────────',
        '어떤 방식으로 진행할까요?',
        ...labels.map((o, i) => `${i === 0 ? ' ❯' : '   '} ${i + 1}. ${o}`),
        '────────────────────────────────────────────────',
        ' Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
}

/** Multi-question AskUserQuestion picker (nav tab line), page 1 focused. */
function askScreenByQuestions(questionCount: number): string {
    const nav = '←  ' + Array.from({ length: questionCount }, (_, i) => `☐ Q${i + 1}`).join('  ') + '  ✔ Submit  →';
    return [
        nav,
        '',
        '어떤 반찬을 고를까요?',
        ' ❯ 1. 계란말이',
        '   2. 김구이',
        '   3. 콩자반',
        '────────────────────────────────────────────────',
        ' Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
    ].join('\n');
}

describe('claude-cli v4 FSM — choice-count independence (실측)', () => {
    const spec = loadSpec();

    it.each([1, 2, 3])('option count %i: →picker fires identically and the modal section holds every option', (n) => {
        const screen = askScreenByOptions(n);
        const lines = screen.split('\n');
        const ev = evaluateFsm(spec, 'idle', screen, { row: lines.length - 1, col: 2 }, undefined, clk(10000, 0));
        expect(ev.fired?.to).toBe('picker');

        const sections = resolveSections(spec.sections ?? {}, lines);
        const modal = sectionText(sections, 'modal', screen);
        for (let i = 1; i <= n; i += 1) expect(modal).toContain(`${i}.`);

        const picker = spec.states.find(s => s.id === 'picker')!;
        const buttons = extractButtonsFromRule(picker.extract!.buttons!, modal);
        expect(buttons.map(b => b.index)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    });

    it.each([1, 2, 3])('question count %i: →picker fires identically', (n) => {
        const screen = askScreenByQuestions(n);
        const lines = screen.split('\n');
        const ev = evaluateFsm(spec, 'idle', screen, { row: lines.length - 1, col: 2 }, undefined, clk(10000, 0));
        expect(ev.fired?.to).toBe('picker');
    });
});
