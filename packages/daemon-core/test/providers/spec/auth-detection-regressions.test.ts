import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { evaluateFsm, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';
import { stateById, statusForState, type CliSpecV4 } from '../../../src/providers/spec/fsm-types.js';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js';
import { detectProviderFailure } from '../../../src/providers/spec/provider-failure-classifier.js';
import {
    classifyAuthBillingOutput,
    createLiveAuthState,
    resolveLiveAuthSuspect,
} from '../../../src/providers/spec/live-auth-advisory.js';
import { projectAdapterStatus } from '../../../src/providers/spec/adapter-status-projection.js';
import type {
    PtyTransportFactory,
    PtyRuntimeTransport,
    PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../../../..');

function resolveProviderSpecPath(cliDir: string, specFile: string): string {
    return path.join(REPO_ROOT, 'adhdev-providers/cli', cliDir, 'specs', specFile);
}

function loadProviderSpec(cliDir: string, specFile: string): CliSpecV4 {
    const p = resolveProviderSpecPath(cliDir, specFile);
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const errs = validateFsmSpec(raw);
    if (errs.length) throw new Error(`${cliDir}/${specFile}: ${errs.join('; ')}`);
    return raw as CliSpecV4;
}

function clk(now: number, entered = 0): FsmClock {
    return { now, stateEnteredAt: entered, regionLastChangedAt: new Map() };
}

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4242;
    readonly ready = Promise.resolve();
    readonly writes: string[] = [];
    private dataCb: ((chunk: string) => void) | null = null;
    private exitCb: ((info: { exitCode: number }) => void) | null = null;
    write(data: string): void {
        this.writes.push(data);
        this.dataCb?.(data);
    }
    resize(): void {}
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

// ── Real shapes from /tmp/adhdev-rc27-auth-false-positive/REPORT.md (redacted, no secrets) ──

const AGY_SIGNIN_SELECTOR_SCREEN = [
    '',
    '  Welcome back! You are currently not signed in.',
    '',
    '  Select Google Cloud sign-in method:',
    '  ❯ 1. Sign in with Google (antigravity)',
    '    2. Sign in with Google (gcloud)',
    '    3. Enter Authorization Code',
    '    4. Cancel',
    '',
    '  (Use arrow keys to navigate, Enter to select)',
].join('\n');

const AGY_OAUTH_PASTE_CODE_SCREEN = [
    '',
    '  Authentication required. Please visit the URL to log in:',
    '',
    '  Your browser should open automatically. If not:',
    '  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=REDACTED.apps.googleusercontent.com&redirect_uri=http%3A%2F%2Flocalhost%3A40000%2Foauth-callback&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform&state=REDACTED',
    '  If you aren\'t automatically redirected, paste the authorization code below:',
    '  authorization code...',
].join('\n');

const CLAUDE_SIGNIN_SCREEN = [
    '',
    '  Welcome to Claude Code',
    '',
    '  Select login method:',
    '  ❯ 1. Claude account with subscription',
    '    2. Anthropic Console account',
    '',
].join('\n');

const CLAUDE_OAUTH_PASTE_CODE_SCREEN = [
    '',
    '  Browser didn\'t open? Use the url below to sign in',
    '  https://claude.ai/oauth/authorize?client_id=REDACTED&response_type=code',
    '',
    '  Paste code here if prompted > ',
].join('\n');

const CODEX_SIGNIN_SCREEN = [
    '',
    '  Sign in with ChatGPT to use Codex as part of your paid plan',
    '  or connect an API key for usage-based billing',
    '',
    '  › 1. Sign in with ChatGPT',
    '    2. Sign in with Device Code',
    '    3. Provide your own API key',
    '',
].join('\n');

const KIMI_SIGNIN_DEVICE_CODE_SCREEN = [
    '',
    '  ╭──────────────────────────────────────────────────────────╮',
    '  │                                                          │',
    '  │  Sign in to Kimi Code                                    │',
    '  │                                                          │',
    '  │  Visit the URL below in your browser to authorize:       │',
    '  │  https://kimi.com/oauth/device?user_code=ABCD-1234       │',
    '  │                                                          │',
    '  │  Verification code:  ABCD-1234                           │',
    '  │                                                          │',
    '  │  Press Ctrl-C to cancel                                  │',
    '  │                                                          │',
    '  ╰──────────────────────────────────────────────────────────╯',
    '  ⠋ Waiting for authorization…',
].join('\n');

const CURSOR_SIGNIN_SCREEN = [
    '',
    '  Cursor Agent v0.45.0',
    '  Welcome to Cursor Agent',
    '',
    '  ▸ Press Enter to sign in',
    '  (opens browser to authenticate with your Cursor account)',
    '',
].join('\n');

const GROK_SIGNIN_SCREEN = [
    '',
    '  Welcome to Grok CLI',
    '  Paste your xAI API key to continue:',
    '  > ',
].join('\n');

const REPORT_MD_TOOL_AND_CODE_FALSE_POSITIVES = [
    // From session 14e361bc (Claude worker editing OpenAPI + route tests):
    `"401": \${err("Token invalid, tampered, expired, unknown or already used (code = invalid_recovery_token)")}`,
    `it('returns 401 invalid_recovery_token when recovery token is expired', async () => {`,
    // From session fc03017d (Codex worker editing license activation route):
    `// returns 401 invalid_license_key or HTTP 401 Unauthorized when license is missing`,
    `expect(res.status).toBe(401); expect(res.body).toEqual({ status: 401, error: 'Unauthorized' });`,
    // Tool output & code comments mentioning "not signed in", "401", "Unauthorized", "token_expired":
    `  ⎿  {"status": 401, "error": "Unauthorized", "code": "invalid_token"}`,
    `  142: // Redirects when user is not signed in or session is not logged in`,
    `  + if (err.code === 'token_expired' || err.code === 'invalid_token') return reply.code(401).send({ error: 'Unauthorized' });`,
    `  ● Bash(command grep -n "401 Unauthorized" apps/api/tests/auth.test.ts)\n  ⎿  28:   it('returns HTTP 401 Unauthorized when user is not signed in', async () => {`,
];

describe('Requirement 1 & 3 — antigravity-cli genuine sign-in screen → signing_in (waiting_external), no input delivered', () => {
    const spec = loadProviderSpec('antigravity-cli', '4.0.json');

    it('declares signing_in with status waiting_external (never generating or modal)', () => {
        const st = stateById(spec, 'signing_in');
        expect(st).toBeDefined();
        expect(st?.status).toBe('waiting_external');
        expect(st?.modal).toBeUndefined();
        expect(st?.extract?.buttons).toBeUndefined();
    });

    it('transitions starting → signing_in on agy sign-in method selector screen and blocks startup-grace past 15s', () => {
        expect(evaluateFsm(spec, 'starting', AGY_SIGNIN_SELECTOR_SCREEN, { row: 5, col: 4 }, undefined, clk(2_000, 0)).fired?.to).toBe('signing_in');
        expect(evaluateFsm(spec, 'starting', AGY_SIGNIN_SELECTOR_SCREEN, { row: 5, col: 4 }, undefined, clk(16_000, 0)).fired?.to).toBe('signing_in');
        expect(evaluateFsm(spec, 'signing_in', AGY_SIGNIN_SELECTOR_SCREEN, { row: 5, col: 4 }, undefined, clk(65_000, 0)).fired).toBeNull();
    });

    it('transitions starting → signing_in on agy OAuth URL / paste-code screen and blocks startup-grace past 15s and 60s', () => {
        expect(evaluateFsm(spec, 'starting', AGY_OAUTH_PASTE_CODE_SCREEN, { row: 6, col: 20 }, undefined, clk(2_000, 0)).fired?.to).toBe('signing_in');
        expect(evaluateFsm(spec, 'starting', AGY_OAUTH_PASTE_CODE_SCREEN, { row: 6, col: 20 }, undefined, clk(16_000, 0)).fired?.to).toBe('signing_in');
        expect(evaluateFsm(spec, 'signing_in', AGY_OAUTH_PASTE_CODE_SCREEN, { row: 6, col: 20 }, undefined, clk(65_000, 0)).fired).toBeNull();
    });

    it('does NOT deliver queued task input into agy sign-in screen even past 15s startup-grace', async () => {
        vi.useFakeTimers();
        try {
            const factory = new DrivableFactory();
            const driver = new FsmDriver({
                specPath: resolveProviderSpecPath('antigravity-cli', '4.0.json'),
                workingDir: os.tmpdir(),
                hotReload: false,
                transportFactory: factory,
            });
            driver.start();
            const pty = factory.last!;
            const nonFocusWrites = () => pty.writes.filter(w => w !== '\u001b[I');

            // Queue a task prompt before ready (exact incident shape from REPORT.md)
            driver.dispatch({ kind: 'send_message', text: 'Investigate auth false positives and report completion' });

            // Render agy sign-in selector screen into the PTY
            pty.feed(AGY_SIGNIN_SELECTOR_SCREEN.replace(/\n/g, '\r\n'));
            await vi.advanceTimersByTimeAsync(1_000);
            expect(driver.currentStateId).toBe('signing_in');
            const curState = stateById(spec, driver.currentStateId)!;
            expect(statusForState(curState)).toBe('waiting_external');
            expect(nonFocusWrites()).toEqual([]);

            // Advance past 15s startup-grace and 60s signing_in timeout
            await vi.advanceTimersByTimeAsync(20_000);
            expect(driver.currentStateId).toBe('signing_in');
            expect(nonFocusWrites()).toEqual([]);

            await vi.advanceTimersByTimeAsync(50_000);
            expect(driver.currentStateId).toBe('signing_in');
            expect(nonFocusWrites()).toEqual([]);

            // Status projection surfaces needing owner attention immediately (not hidden behind boot starting hold)
            const projected = projectAdapterStatus({
                providerSessionId: undefined,
                providerFailure: null,
                exited: false,
                spawned: true,
                activeInteractivePrompt: null,
                modal: null,
                readySeen: () => driver.hasSeenReady(),
                state: { id: curState.id, label: curState.label, title: null, status: statusForState(curState) },
            });
            expect(projected.status).toBe('waiting_approval');
            expect(projected.activeModal).toBeNull();

            driver.shutdown();
        } finally {
            vi.useRealTimers();
        }
    });

    it('ignores scrollback sign-in text when the live viewport shows a normal ready or busy session', () => {
        const scrollbackLines = [
            '', '', '', '', '', '',
            '  Signing in to your Google account...',
            ...AGY_SIGNIN_SELECTOR_SCREEN.split('\n'),
        ];
        while (scrollbackLines.length < 40) scrollbackLines.push('');
        const liveViewport = Array.from({ length: 36 }, (_, i) => i === 0 ? '  Completed the fix.' : '');
        liveViewport.push(
            '────────────────────────────────────────',
            '> Type your message or @path/to/file',
            '────────────────────────────────────────',
            '  ? for shortcuts',
        );
        const bootViewport = Array.from({ length: 40 }, (_, i) => i === 0 ? '  Loading workspace...' : '');
        const bootGuardScreen = [...scrollbackLines, ...bootViewport].join('\n');
        const viewportStartRow = scrollbackLines.length;
        expect(evaluateFsm(spec, 'starting', bootGuardScreen, { row: bootGuardScreen.split('\n').length - 1, col: 2 }, undefined, clk(2_000, 0), null, viewportStartRow).fired?.to).not.toBe('signing_in');
        const guardScreen = [...scrollbackLines, ...liveViewport].join('\n');
        expect(evaluateFsm(spec, 'idle', guardScreen, { row: guardScreen.split('\n').length - 1, col: 2 }, undefined, clk(20_000, 0), null, viewportStartRow).fired).toBeNull();
    });
});

describe('Requirement 1 & 3 — other CLI specs viewport-anchored signing_in states', () => {
    it('claude-cli: enters signing_in (waiting_external) on login method / OAuth code screen and blocks startup-grace', () => {
        const spec = loadProviderSpec('claude-cli', '4.0.json');
        const st = stateById(spec, 'signing_in');
        expect(st?.status).toBe('waiting_external');
        expect(evaluateFsm(spec, 'starting', CLAUDE_SIGNIN_SCREEN, { row: 5, col: 4 }, undefined, clk(10_000, 0)).fired?.to).toBe('signing_in');
        expect(evaluateFsm(spec, 'starting', CLAUDE_OAUTH_PASTE_CODE_SCREEN, { row: 4, col: 30 }, undefined, clk(10_000, 0)).fired?.to).toBe('signing_in');
        expect(evaluateFsm(spec, 'signing_in', CLAUDE_SIGNIN_SCREEN, { row: 5, col: 4 }, undefined, clk(30_000, 0)).fired).toBeNull();
    });

    it('codex-cli: enters signing_in (waiting_external) on ChatGPT / Device Code sign-in screen and blocks startup-grace', () => {
        const spec = loadProviderSpec('codex-cli', '4.0.json');
        const st = stateById(spec, 'signing_in');
        expect(st?.status).toBe('waiting_external');
        expect(evaluateFsm(spec, 'starting', CODEX_SIGNIN_SCREEN, { row: 4, col: 4 }, undefined, clk(10_000, 0)).fired?.to).toBe('signing_in');
        expect(evaluateFsm(spec, 'signing_in', CODEX_SIGNIN_SCREEN, { row: 4, col: 4 }, undefined, clk(30_000, 0)).fired).toBeNull();
    });

    it('kimi: enters signing_in (waiting_external) on DeviceCodeBoxComponent login screen and blocks startup-grace', () => {
        const spec = loadProviderSpec('kimi', '1.0.json');
        const st = stateById(spec, 'signing_in');
        expect(st?.status).toBe('waiting_external');
        expect(evaluateFsm(spec, 'starting', KIMI_SIGNIN_DEVICE_CODE_SCREEN, { row: 10, col: 4 }, undefined, clk(10_000, 0)).fired?.to).toBe('signing_in');
        expect(evaluateFsm(spec, 'signing_in', KIMI_SIGNIN_DEVICE_CODE_SCREEN, { row: 10, col: 4 }, undefined, clk(30_000, 0)).fired).toBeNull();
    });

    it('cursor-cli: enters signing_in on browser login prompt, blocks startup-grace, and does NOT trigger from busy or scrollback', () => {
        const spec = loadProviderSpec('cursor-cli', '1.0.json');
        expect(evaluateFsm(spec, 'starting', CURSOR_SIGNIN_SCREEN, { row: 4, col: 4 }, undefined, clk(15_000, 0)).fired?.to).toBe('signing_in');
        const busyWithUrl = [
            '  Reading docs from https://cursor.com/cli and Sign in with Cursor guide',
            '  ⠋ Generating response (esc to cancel)',
            '  / commands · @ files',
        ].join('\n');
        expect(evaluateFsm(spec, 'busy', busyWithUrl, { row: 2, col: 4 }, undefined, clk(5_000, 0)).fired?.to).not.toBe('signing_in');
    });

    it('grok-cli: enters signing_in on API key prompt, blocks startup-grace, and does NOT trigger from scrollback or busy', () => {
        const spec = loadProviderSpec('grok-cli', '1.0.json');
        expect(evaluateFsm(spec, 'starting', GROK_SIGNIN_SCREEN, { row: 2, col: 4 }, undefined, clk(15_000, 0)).fired?.to).toBe('signing_in');
        const scrollbackAndReady = [
            '  Paste your xAI API key to continue:',
            ...Array.from({ length: 30 }, () => ''),
            '  │ ❯ ',
            '  Shift+Tab: mode · Ctrl+x: shortcuts',
        ].join('\n');
        expect(evaluateFsm(spec, 'idle', scrollbackAndReady, { row: 31, col: 4 }, undefined, clk(5_000, 0)).fired?.to).not.toBe('signing_in');
    });
});

describe('Requirement 2 & 3 — tool output or code with "401", "Unauthorized", "not signed in" produces no auth failure and no mid-turn advisory past 60s', () => {
    it('detectProviderFailure and classifyAuthBillingOutput return null on all REPORT.md tool output and code shapes', () => {
        for (const snippet of REPORT_MD_TOOL_AND_CODE_FALSE_POSITIVES) {
            expect(detectProviderFailure(snippet), `snippet: ${snippet}`).toBeNull();
            for (const cli of ['claude-cli', 'codex-cli', 'antigravity-cli', 'kimi', 'cursor-cli', 'grok-cli', 'opencode']) {
                expect(classifyAuthBillingOutput(cli, snippet), `${cli} snippet: ${snippet}`).toBeNull();
            }
        }
    });

    it('never confirms a live auth suspect mid-turn even when busy for more than 60s (STUCK_BUSY_ESCAPE_MS removed)', () => {
        const state = createLiveAuthState();
        const t0 = 1_000_000;

        // At 65s and 180s while still midTurn=true (busy/generating), confirmation MUST NOT fire
        for (const elapsed of [5_000, 60_106, 120_000]) {
            state.suspect = {
                failure: { errorReason: 'auth_failed', failureKind: 'auth', message: 'test' },
                suspectedAtMs: t0,
            };
            const outcome = resolveLiveAuthSuspect(
                state,
                { cliType: 'claude-cli', sessionLabel: 'sess-14e361bc' },
                {
                    midTurn: true,
                    readScreen: () => 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login',
                    tail: 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login',
                    submitInFlight: false,
                    now: t0 + elapsed,
                },
            );
            expect(outcome.advisory).toBeUndefined();
            expect(outcome.latch).toBeUndefined();
        }
    });

    it('kimi does not hard-latch error mid-turn past 60s or from unanchored text', () => {
        const state = createLiveAuthState();
        const t0 = 1_000_000;
        state.suspect = {
            failure: { errorReason: 'auth_failed', failureKind: 'auth', message: 'test' },
            suspectedAtMs: t0,
        };

        // Mid-turn at 65s: no latch
        const midTurnOutcome = resolveLiveAuthSuspect(
            state,
            { cliType: 'kimi', sessionLabel: 'sess-kimi-1' },
            {
                midTurn: true,
                readScreen: () => '[provider.auth_error] 403 You\'ve reached your 5-hour usage limit',
                tail: '[provider.auth_error] 403 You\'ve reached your 5-hour usage limit',
                submitInFlight: false,
                now: t0 + 65_000,
            },
        );
        expect(midTurnOutcome.latch).toBeUndefined();
        expect(midTurnOutcome.advisory).toBeUndefined();

        // At turn boundary (midTurn=false) with generic non-Kimi-UI text on screen: no hard latch
        state.suspect = {
            failure: { errorReason: 'auth_failed', failureKind: 'auth', message: 'test' },
            suspectedAtMs: t0,
        };
        const genericScreenOutcome = resolveLiveAuthSuspect(
            state,
            { cliType: 'kimi', sessionLabel: 'sess-kimi-1' },
            {
                midTurn: false,
                readScreen: () => 'Error: 401 Unauthorized — not logged in',
                tail: 'Error: 401 Unauthorized — not logged in',
                submitInFlight: false,
                now: t0 + 66_000,
            },
        );
        expect(genericScreenOutcome.latch).toBeUndefined();
    });

    it('SpecCliAdapter busy for >60s writing 401/Unauthorized/not-signed-in code emits no advisory and does not latch error', () => {
        const signals: unknown[] = [];
        const adapter = Object.create(SpecCliAdapter.prototype) as any;
        adapter.cliType = 'claude-cli';
        adapter.owningSessionId = 'sess-busy-60s';
        adapter.runtimeSettings = {};
        adapter.providerFailure = null;
        adapter.exited = false;
        adapter.liveAuth = null;
        adapter.latestState = { id: 'busy', label: 'Generating', title: null, status: 'generating' };
        const screenWithCode = REPORT_MD_TOOL_AND_CODE_FALSE_POSITIVES.join('\n');
        Object.defineProperty(adapter, 'rawTail', {
            value: {
                strippedTail: () => screenWithCode,
                clearStrippedTail: () => {},
            },
        });
        adapter.driver = {
            snapshot: () => screenWithCode,
            hasInFlightSubmit: () => false,
        };
        adapter.reportSignal = (sig: unknown) => signals.push(sig);
        adapter.notifyChange = () => {};

        adapter.observeProviderFailureOutput(screenWithCode);
        expect(adapter.liveAuth?.suspect ?? null).toBeNull();
        adapter.maybeConfirmLiveAuthBillingSuspect();
        expect(signals).toEqual([]);
        expect(adapter.providerFailure).toBeNull();
    });
});
