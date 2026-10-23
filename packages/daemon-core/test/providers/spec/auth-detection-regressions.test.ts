import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { evaluateFsm, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';
import { stateById, statusForState, type CliSpecV4 } from '../../../src/providers/spec/fsm-types.js';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import { TerminalAdapter } from '../../../src/providers/spec/adapter.js';
import { isAnchoredSignInViewport } from '../../../src/providers/spec/send-submit-engine.js';
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js';
import { detectAuthFailureOnlyReply, detectProviderFailure } from '../../../src/providers/spec/provider-failure-classifier.js';
import {
    classifyAuthBillingOutput,
    createLiveAuthState,
    noteLiveAuthMatch,
    resolveLiveAuthSuspect,
} from '../../../src/providers/spec/live-auth-advisory.js';
import { projectAdapterStatus } from '../../../src/providers/spec/adapter-status-projection.js';
import { CliProviderInstance } from '../../../src/providers/cli-provider-instance.js';
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
    // Multi-line tool output block where 401 / authentication_error is on indented continuation lines under ⎿:
    [
        '  ⏺ Bash(curl -i https://api.anthropic.com/v1/messages)',
        '  ⎿  HTTP/1.1 401 Unauthorized',
        '     {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
        '     API Error: 401 {"type":"error","error":{"type":"authentication_error"}} · Please run /login',
    ].join('\n'),
    `  142: // Redirects when user is not signed in or session is not logged in`,
    `  + if (err.code === 'token_expired' || err.code === 'invalid_token') return reply.code(401).send({ error: 'Unauthorized' });`,
    `  ● Bash(command grep -n "401 Unauthorized" apps/api/tests/auth.test.ts)\n  ⎿  28:   it('returns HTTP 401 Unauthorized when user is not signed in', async () => {`,
];

const CLAUDE_CONSOLE_SUBSCREEN = [
    '',
    '  Anthropic Console account',
    '  How do you want to sign in?',
    '  ❯ 1. Sign in with your Console account',
    '    2. Enter API key',
    '',
].join('\n');

const CLAUDE_OPENING_BROWSER_SUBSCREEN = [
    '',
    '  Welcome to Claude Code',
    '  Opening browser to sign in…',
    '',
].join('\n');

const CLAUDE_CLOUD_GATEWAY_SUBSCREEN = [
    '',
    '  Cloud gateway · sign in',
    '  Browser didn\'t open? Visit:',
    '  https://gateway.example.com/oauth/login?code=1234',
    '',
].join('\n');

const CODEX_FINISH_BROWSER_SUBSCREEN = [
    '',
    '  Finish signing in via your browser',
    '  If the link doesn\'t open automatically, open the following URL:',
    '  http://localhost:1455/auth/callback',
    '',
].join('\n');

const CODEX_PREPARING_DEVICE_CODE_SUBSCREEN = [
    '',
    '  Preparing device code login...',
    '',
].join('\n');

const CODEX_API_KEY_BOX_SUBSCREEN = [
    '',
    '  Use your own OpenAI API key for usage-based billing',
    '  Paste or type your API key below. It will be stored locally in auth.json.',
    '  ╭──────────────────────────────────────────────────╮',
    '  │ >                                                │',
    '  ╰──────────────────────────────────────────────────╯',
    '',
].join('\n');

const CODEX_API_KEY_DISABLED_SUBSCREEN = [
    '',
    '  Use your own OpenAI API key',
    '  >API key login is disabled.',
    '',
].join('\n');

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

    it('never confirms an unanchored or actively streaming auth suspect mid-turn even past 60s, but surfaces a quiet wedged busy session with an anchored 401/JSON error', () => {
        const state = createLiveAuthState();
        const t0 = 1_000_000;

        // 1. Unanchored/prose auth wording mid-turn (even at 65s and 120s) MUST NOT confirm
        for (const elapsed of [5_000, 60_106, 120_000]) {
            state.suspect = {
                failure: { errorReason: 'auth_failed', failureKind: 'auth', message: 'test' },
                suspectedAtMs: t0,
            };
            const outcome = resolveLiveAuthSuspect(
                state,
                { cliType: 'claude-cli', sessionLabel: 'sess-14e361bc', isCoordinator: false },
                {
                    midTurn: true,
                    readScreen: () => 'The worker reported: Your session has expired. Please run /login to continue.',
                    tail: 'The worker reported: Your session has expired. Please run /login to continue.',
                    submitInFlight: false,
                    now: t0 + elapsed,
                },
            );
            expect(outcome.advisory).toBeUndefined();
            expect(outcome.latch).toBeUndefined();
        }

        // 2. Anchored 401/JSON error while still actively outputting (quietMs < 5s) or before mid-turn window (5s) defers
        state.suspect = {
            failure: { errorReason: 'auth_failed', failureKind: 'auth', message: 'test' },
            suspectedAtMs: t0,
        };
        const earlyOutcome = resolveLiveAuthSuspect(
            state,
            { cliType: 'claude-cli', sessionLabel: 'sess-wedged', isCoordinator: false },
            {
                midTurn: true,
                readScreen: () => 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login',
                tail: 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login',
                submitInFlight: false,
                now: t0 + 5_000,
            },
        );
        expect(earlyOutcome.advisory).toBeUndefined();

        // 3. Anchored 401/JSON error on a quiet wedged busy screen (age >= 15s, quiet >= 5s) MUST surface advisory
        const wedgedOutcome = resolveLiveAuthSuspect(
            state,
            { cliType: 'claude-cli', sessionLabel: 'sess-wedged', isCoordinator: false },
            {
                midTurn: true,
                quietMs: 10_000,
                readScreen: () => 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login',
                tail: 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login',
                submitInFlight: false,
                now: t0 + 20_000,
            },
        );
        expect(wedgedOutcome.advisory).toBeDefined();
        expect(wedgedOutcome.advisory?.kind).toBe('auth_error');
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

describe('Review Finding 1 — healthy codex 0.133 and claude 2.1.309 sessions stay idle on tool output and always exit signing_in', () => {
    it('codex 0.133+ idle screen with "Sign in with ChatGPT…" in recent tool output stays idle and exits signing_in when composer renders below login text', () => {
        const spec = loadProviderSpec('codex-cli', '4.0.json');
        const codexIdleWithToolOutput = [
            '╭───────────────────────────────────────────────╮',
            '│ >_ OpenAI Codex (v0.133.0)                    │',
            '│ model:     gpt-5.4-codex   /model to change   │',
            '│ directory: /tmp/ws                            │',
            '╰───────────────────────────────────────────────╯',
            '',
            '• Ran grep -n "Sign in with ChatGPT" packages/auth/login.ts',
            '  Sign in with ChatGPT to use Codex as part of your paid plan',
            '  › 1. Sign in with ChatGPT',
            '    2. Sign in with Device Code',
            '',
            '› Ask Codex to do anything',
            '',
            '  gpt-5.4-codex medium · /tmp/ws · 84% left',
            '  ? for shortcuts',
        ].join('\n');

        const cursorRow = codexIdleWithToolOutput.split('\n').length - 4;
        // Must NOT enter signing_in from idle
        expect(evaluateFsm(spec, 'idle', codexIdleWithToolOutput, { row: cursorRow, col: 2 }, undefined, clk(5_000, 0)).fired).toBeNull();
        // When user finishes signing in and composer renders below leftover login text, signing_in→idle MUST fire
        expect(evaluateFsm(spec, 'signing_in', codexIdleWithToolOutput, { row: cursorRow, col: 2 }, undefined, clk(2_000, 0)).fired?.to).toBe('idle');
    });

    it('claude 2.1.309 idle screens (manual mode statusline and custom statusline) with "Select login method:" in recent tool output stay idle and exit signing_in', () => {
        const spec = loadProviderSpec('claude-cli', '4.0.json');
        const claudeManualModeScreen = [
            ' ▐▛███▜▌   Claude Code v2.1.309',
            '▝▜█████▛▘  Opus 4.6 · Claude Max',
            '  ▘▘ ▝▝    /tmp/ws',
            '',
            '⏺ Bash(grep -n "Select login method:" src/cli.ts)',
            '  ⎿  Select login method:',
            '     ❯ 1. Claude account with subscription',
            '       2. Anthropic Console account',
            '',
            '────────────────────────────────────────────────────────────────────────────────────────────────────',
            '❯ ',
            '────────────────────────────────────────────────────────────────────────────────────────────────────',
            '  ⏸ manual mode on · ← for agents',
        ].join('\n');

        const claudeCustomStatuslineScreen = [
            ' ▐▛███▜▌   Claude Code v2.1.309',
            '⏺ Bash(cat login-fixture.txt)',
            '  ⎿  Select login method:',
            '     Browser didn\'t open? Use the url below to sign in',
            '     Paste code here if prompted > ',
            '',
            '────────────────────────────────────────────────────────────────────────────────────────────────────',
            '❯ ',
            '────────────────────────────────────────────────────────────────────────────────────────────────────',
            '  [main] 0↑ 0↓ · ctx 14% · $0.04',
        ].join('\n');

        for (const screen of [claudeManualModeScreen, claudeCustomStatuslineScreen]) {
            const row = screen.split('\n').length - 3;
            expect(evaluateFsm(spec, 'idle', screen, { row, col: 2 }, undefined, clk(5_000, 0)).fired).toBeNull();
            expect(evaluateFsm(spec, 'starting', screen, { row, col: 2 }, undefined, clk(9_000, 0)).fired?.to).toBe('idle');
            expect(evaluateFsm(spec, 'signing_in', screen, { row, col: 2 }, undefined, clk(2_000, 0)).fired?.to).toBe('idle');
        }
    });

    it('every spec has both a live-chrome exit (composer below leftover login text) and a bounded timeout exit from signing_in', () => {
        const cases: Array<{ cli: string; file: string; signedInBelowLogin: string }> = [
            {
                cli: 'antigravity-cli',
                file: '4.0.json',
                signedInBelowLogin: [
                    AGY_SIGNIN_SELECTOR_SCREEN,
                    '────────────────────────────────────────────────────────────────────────────────',
                    '> Type your message or @path/to/file',
                    '────────────────────────────────────────────────────────────────────────────────',
                    '? for shortcuts                                          Gemini 3.7 Flash · high',
                ].join('\n'),
            },
            {
                cli: 'claude-cli',
                file: '4.0.json',
                signedInBelowLogin: [
                    CLAUDE_SIGNIN_SCREEN,
                    '────────────────────────────────────────────────────────────────────────────────',
                    '❯ ',
                    '────────────────────────────────────────────────────────────────────────────────',
                    '  ⏸ manual mode on · ← for agents',
                ].join('\n'),
            },
            {
                cli: 'codex-cli',
                file: '4.0.json',
                signedInBelowLogin: [
                    CODEX_SIGNIN_SCREEN,
                    '› Ask Codex to do anything',
                    '  gpt-5.4-codex medium · /tmp/ws · 92% left',
                    '  ? for shortcuts',
                ].join('\n'),
            },
            {
                cli: 'cursor-cli',
                file: '1.0.json',
                signedInBelowLogin: [
                    CURSOR_SIGNIN_SCREEN,
                    '  Claude 4.5 Sonnet · 4.2%',
                    '  /tmp/ws',
                ].join('\n'),
            },
            {
                cli: 'grok-cli',
                file: '1.0.json',
                signedInBelowLogin: [
                    GROK_SIGNIN_SCREEN,
                    '  │ ❯ ',
                    '  Shift+Tab: mode · Ctrl+x: shortcuts',
                ].join('\n'),
            },
            {
                cli: 'kimi',
                file: '1.0.json',
                signedInBelowLogin: [
                    KIMI_SIGNIN_DEVICE_CODE_SCREEN,
                    '  ╭──────────────────────────────────────────╮',
                    '  │ >                                        │',
                    '  ╰──────────────────────────────────────────╯',
                ].join('\n'),
            },
        ];

        for (const c of cases) {
            const spec = loadProviderSpec(c.cli, c.file);
            // 1. Live composer below leftover login text exits signing_in -> idle within 2s
            expect(
                evaluateFsm(spec, 'signing_in', c.signedInBelowLogin, { row: 6, col: 2 }, undefined, clk(2_000, 0)).fired?.to,
                `${c.cli} composer below login text`,
            ).toBe('idle');
            // 2. Bounded exit when login screen is cleared to a non-login screen
            const clearedScreen = '  Signed in successfully.\n  Ready.\n';
            const bounded = evaluateFsm(spec, 'signing_in', clearedScreen, { row: 1, col: 2 }, undefined, clk(65_000, 0)).fired?.to;
            expect(['idle', 'approval'], `${c.cli} bounded exit from signing_in`).toContain(bounded);
        }
    });
});

describe('Review Finding 2 — Claude and Codex sign-in sub-screens never count as idle and never receive queued input', () => {
    it.each([
        ['Anthropic Console account sub-screen', CLAUDE_CONSOLE_SUBSCREEN],
        ['forceLoginMethod Opening browser sub-screen', CLAUDE_OPENING_BROWSER_SUBSCREEN],
        ['Cloud gateway sign-in sub-screen', CLAUDE_CLOUD_GATEWAY_SUBSCREEN],
    ])('claude-cli sub-screen (%s): enters signing_in, blocks startup-grace and signing_in→idle, and holds queued input', async (_label, screen) => {
        const spec = loadProviderSpec('claude-cli', '4.0.json');
        expect(evaluateFsm(spec, 'starting', screen, { row: 3, col: 4 }, undefined, clk(2_000, 0)).fired?.to).toBe('signing_in');
        expect(evaluateFsm(spec, 'starting', screen, { row: 3, col: 4 }, undefined, clk(15_000, 0)).fired?.to).toBe('signing_in');
        expect(evaluateFsm(spec, 'signing_in', screen, { row: 3, col: 4 }, undefined, clk(30_000, 0)).fired).toBeNull();

        vi.useFakeTimers();
        try {
            const factory = new DrivableFactory();
            const driver = new FsmDriver({
                specPath: resolveProviderSpecPath('claude-cli', '4.0.json'),
                workingDir: os.tmpdir(),
                hotReload: false,
                transportFactory: factory,
            });
            driver.start();
            const pty = factory.last!;
            driver.dispatch({ kind: 'send_message', text: 'Do not drain into login UI' });
            pty.feed(screen.replace(/\n/g, '\r\n'));
            await vi.advanceTimersByTimeAsync(15_000);
            expect(driver.currentStateId).toBe('signing_in');
            expect(pty.writes.filter(w => w !== '\u001b[I')).toEqual([]);
            driver.shutdown();
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([
        ['Finish signing in via your browser', CODEX_FINISH_BROWSER_SUBSCREEN],
        ['Preparing device code login', CODEX_PREPARING_DEVICE_CODE_SUBSCREEN],
        ['Use your own OpenAI API key with > box', CODEX_API_KEY_BOX_SUBSCREEN],
        ['>API key login is disabled', CODEX_API_KEY_DISABLED_SUBSCREEN],
    ])('codex-cli sub-screen (%s): enters signing_in, blocks startup-grace and signing_in→idle, and holds queued input', async (_label, screen) => {
        const spec = loadProviderSpec('codex-cli', '4.0.json');
        expect(evaluateFsm(spec, 'starting', screen, { row: 3, col: 4 }, undefined, clk(2_000, 0)).fired?.to).toBe('signing_in');
        expect(evaluateFsm(spec, 'starting', screen, { row: 3, col: 4 }, undefined, clk(15_000, 0)).fired?.to).toBe('signing_in');
        expect(evaluateFsm(spec, 'signing_in', screen, { row: 3, col: 4 }, undefined, clk(30_000, 0)).fired).toBeNull();

        vi.useFakeTimers();
        try {
            const factory = new DrivableFactory();
            const driver = new FsmDriver({
                specPath: resolveProviderSpecPath('codex-cli', '4.0.json'),
                workingDir: os.tmpdir(),
                hotReload: false,
                transportFactory: factory,
            });
            driver.start();
            const pty = factory.last!;
            driver.dispatch({ kind: 'send_message', text: 'Do not drain into codex login UI' });
            pty.feed(screen.replace(/\n/g, '\r\n'));
            await vi.advanceTimersByTimeAsync(15_000);
            expect(driver.currentStateId).toBe('signing_in');
            expect(pty.writes.filter(w => w !== '\u001b[I')).toEqual([]);
            driver.shutdown();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('Review Finding 3 — total exits from starting (no startup deadlock when sign-in text and idle chrome co-occur)', () => {
    it('exits starting to idle when both sign-in text and idle chrome are in the viewport across antigravity-cli, claude-cli, codex-cli, cursor-cli, grok-cli, and kimi', () => {
        const coOccurringScreens: Array<{ cli: string; file: string; screen: string }> = [
            {
                cli: 'antigravity-cli',
                file: '4.0.json',
                screen: [
                    AGY_SIGNIN_SELECTOR_SCREEN,
                    '────────────────────────────────────────────────────────────────────────────────',
                    '> Type your message or @path/to/file',
                    '────────────────────────────────────────────────────────────────────────────────',
                    '? for shortcuts                                          Gemini 3.7 Flash · high',
                ].join('\n'),
            },
            {
                cli: 'claude-cli',
                file: '4.0.json',
                screen: [
                    CLAUDE_SIGNIN_SCREEN,
                    '────────────────────────────────────────────────────────────────────────────────',
                    '❯ ',
                    '────────────────────────────────────────────────────────────────────────────────',
                    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
                ].join('\n'),
            },
            {
                cli: 'codex-cli',
                file: '4.0.json',
                screen: [
                    CODEX_SIGNIN_SCREEN,
                    '› Ask Codex to do anything',
                    '  gpt-5.4-codex medium · /tmp/ws · 100% left',
                    '  ? for shortcuts',
                ].join('\n'),
            },
            {
                cli: 'cursor-cli',
                file: '1.0.json',
                screen: [
                    CURSOR_SIGNIN_SCREEN,
                    '  Claude 4.5 Sonnet · 2.1%',
                    '  /tmp/ws',
                ].join('\n'),
            },
            {
                cli: 'grok-cli',
                file: '1.0.json',
                screen: [
                    GROK_SIGNIN_SCREEN,
                    '  │ ❯ ',
                    '  Shift+Tab:mode │ Ctrl+x:shortcuts',
                ].join('\n'),
            },
            {
                cli: 'kimi',
                file: '1.0.json',
                screen: [
                    KIMI_SIGNIN_DEVICE_CODE_SCREEN,
                    '  │ >                                        │',
                ].join('\n'),
            },
        ];

        for (const item of coOccurringScreens) {
            const spec = loadProviderSpec(item.cli, item.file);
            const res = evaluateFsm(spec, 'starting', item.screen, { row: 4, col: 2 }, undefined, clk(16_000, 0));
            expect(res.fired?.to, `${item.cli} starting deadlock check`).toBe('idle');
        }
    });
});

describe('Review Finding 4 — mid-turn busy→signing_in transitions and starting midTurn flag', () => {
    it('all 6 specs transition busy → signing_in when an active sign-in screen replaces busy chrome mid-turn', () => {
        const cases: Array<{ cli: string; file: string; screen: string }> = [
            { cli: 'antigravity-cli', file: '4.0.json', screen: AGY_SIGNIN_SELECTOR_SCREEN },
            { cli: 'claude-cli', file: '4.0.json', screen: CLAUDE_SIGNIN_SCREEN },
            { cli: 'codex-cli', file: '4.0.json', screen: CODEX_SIGNIN_SCREEN },
            { cli: 'cursor-cli', file: '1.0.json', screen: CURSOR_SIGNIN_SCREEN },
            { cli: 'grok-cli', file: '1.0.json', screen: GROK_SIGNIN_SCREEN },
            { cli: 'kimi', file: '1.0.json', screen: KIMI_SIGNIN_DEVICE_CODE_SCREEN },
        ];
        for (const c of cases) {
            const spec = loadProviderSpec(c.cli, c.file);
            expect(
                evaluateFsm(spec, 'busy', c.screen, { row: 4, col: 4 }, undefined, clk(5_000, 0)).fired?.to,
                `${c.cli} busy -> signing_in`,
            ).toBe('signing_in');
        }
    });

    it('SpecCliAdapter treats starting state as midTurn=true (not settled idle) and surfaces wedged busy anchored 401 after quiet window', () => {
        const signals: any[] = [];
        const adapter = Object.create(SpecCliAdapter.prototype) as any;
        adapter.cliType = 'claude-cli';
        adapter.owningSessionId = 'sess-starting-midturn';
        adapter.runtimeSettings = {};
        adapter.providerFailure = null;
        adapter.exited = false;
        adapter.liveAuth = createLiveAuthState();
        const t0 = Date.now() - 7_000;
        adapter.liveAuth.suspect = {
            failure: { errorReason: 'auth_failed', failureKind: 'auth', message: 'test' },
            suspectedAtMs: t0,
        };
        // During 'starting', status is 'idle' in fsm-types, but id is 'starting' -> must NOT treat as turn-boundary idle at 7s
        adapter.latestState = { id: 'starting', label: 'Starting', title: null, status: 'idle' };
        const unanchoredBanner = 'Your session has expired. Please run /login';
        Object.defineProperty(adapter, 'rawTail', {
            value: {
                strippedTail: () => unanchoredBanner,
                clearStrippedTail: () => {},
            },
        });
        adapter.driver = {
            snapshot: () => unanchoredBanner,
            hasInFlightSubmit: () => false,
        };
        adapter.reportSignal = (sig: unknown) => signals.push(sig);
        adapter.notifyChange = () => {};

        adapter.maybeConfirmLiveAuthBillingSuspect();
        expect(signals).toHaveLength(0);
    });
});

describe('Review Finding 8 — completion ledger does not emit false turn completion when exiting signing_in (waiting_external) at boot', () => {
    it('does not arm generatingStartedAt or completedDebouncePending when starting → signing_in (waiting_approval with activeModal: null) → idle before any turn', () => {
        const events: any[] = [];
        const inst = Object.create(CliProviderInstance.prototype) as any;
        inst.type = 'claude-cli';
        inst.provider = { name: 'Claude Code', settings: {} };
        inst.workingDir = '/tmp/ws';
        inst.instanceId = 'sess-signin-boot';
        inst.settings = {};
        inst.lastStatus = 'starting';
        inst.generatingStartedAt = 0;
        inst.turnStartedThisBoot = false;
        inst.busyEpoch = 0;
        inst.generatingDebouncePending = null;
        inst.generatingDebounceTimer = null;
        inst.completedDebouncePending = null;
        inst.completedDebounceTimer = null;
        inst.lastApprovalEventFingerprint = '';
        inst.readyEventEmitted = false;
        inst.autoApproveBusy = false;
        inst.activeInteractivePrompt = null;
        inst.monitor = { check: () => [] };
        inst.checkMeshWorkerStall = () => {};
        inst.maybeAutoApproveStatus = () => false;
        inst.autoApproveMaskStalled = () => false;
        inst.stabilizeFlappingApprovalStatus = (s: any) => s;
        inst.hasAdapterPendingResponse = () => false;
        inst.hasEmittedGenuineCompletionForCurrentEpoch = () => false;
        inst.appendRuntimeSystemMessage = () => {};
        inst.pushEvent = (ev: any) => events.push(ev);
        inst.emitAgentReadyOnce = (chatTitle: string, ts: number) => {
            if (!inst.readyEventEmitted) {
                inst.readyEventEmitted = true;
                events.push({ event: 'agent:ready', chatTitle, timestamp: ts });
            }
        };

        let currentAdapterStatus: any = { status: 'waiting_approval', activeModal: null, fsmReadySeen: false };
        inst.adapter = {
            getStatus: () => currentAdapterStatus,
            getScriptParsedStatus: () => ({ status: 'idle', messages: [] }),
        };
        inst.shouldSuppressFreshLaunchStartupReplay = () => false;

        // 1. Boot enters signing_in (projected to waiting_approval, activeModal: null)
        inst.detectStatusTransition();
        expect(inst.lastStatus).toBe('waiting_approval');
        expect(inst.generatingStartedAt).toBe(0);

        // 2. User finishes sign-in -> transitions signing_in → idle
        currentAdapterStatus = { status: 'idle', activeModal: null, fsmReadySeen: true };
        inst.detectStatusTransition();
        expect(inst.lastStatus).toBe('idle');
        expect(inst.completedDebouncePending).toBeNull();
        expect(events.some(e => e.event === 'agent:generating_completed')).toBe(false);
        expect(events.some(e => e.event === 'agent:ready')).toBe(true);
    });
});

describe('Round 3 Finding 1 — pre-send screen guard blocks idle auth-expiry delivery into login screen', () => {
    it('blocks send and transitions to signing_in when a healthy idle Claude session clears the terminal and renders the Select login method screen', async () => {
        vi.useFakeTimers();
        try {
            const factory = new DrivableFactory();
            const driver = new FsmDriver({
                specPath: resolveProviderSpecPath('claude-cli', '4.0.json'),
                workingDir: os.tmpdir(),
                hotReload: false,
                transportFactory: factory,
            });
            driver.start();
            const pty = factory.last!;
            const nonFocusWrites = () => pty.writes.filter(w => w !== '\u001b[I');

            // 1. Healthy Claude reaches idle
            pty.feed('────────────────────\r\n❯ \r\n────────────────────\r\n  Opus 4.6 · 12% context\r\n');
            await vi.advanceTimersByTimeAsync(9_000);
            expect(driver.currentStateId).toBe('idle');
            expect(driver.hasSeenReady()).toBe(true);
            pty.writes.length = 0;

            // 2. Terminal is cleared and the login screen renders while FSM is still in idle
            pty.feed(
                '\u001b[2J\u001b[H' +
                'Claude Code v2.1.309\r\n\r\n' +
                'Select login method:\r\n' +
                ' ❯ 1. Claude account with subscription\r\n' +
                '   2. Anthropic Console account\r\n',
            );
            await vi.advanceTimersByTimeAsync(200);

            // 3. Next send must NOT write task body or CR into the login screen
            const disp = driver.sendMessageWithDisposition('secret task body after idle auth expiry', false, 'msg-idle-expiry-1');
            await vi.advanceTimersByTimeAsync(1_000);

            expect(nonFocusWrites()).toEqual([]);
            expect(disp).toEqual({
                status: 'queued',
                queueDepth: 1,
                reason: 'auth_required',
            });
            expect(driver.currentStateId).toBe('signing_in');
            expect(driver.hasQueuedSend('msg-idle-expiry-1')).toBe(true);

            // 4. Once login completes and the normal idle composer returns, the queued task drains cleanly
            pty.feed('\u001b[2J\u001b[H────────────────────\r\n❯ \r\n────────────────────\r\n  Opus 4.6 · 12% context\r\n');
            await vi.advanceTimersByTimeAsync(1_000);
            expect(driver.currentStateId).toBe('idle');
            expect(nonFocusWrites().join('')).toContain('secret task body after idle auth expiry');

            driver.shutdown();
        } finally {
            vi.useRealTimers();
        }
    });

    it('still sends normally on a healthy idle session with sign-in text in scrollback or recent tool output above composer chrome', async () => {
        vi.useFakeTimers();
        try {
            const factory = new DrivableFactory();
            const driver = new FsmDriver({
                specPath: resolveProviderSpecPath('claude-cli', '4.0.json'),
                workingDir: os.tmpdir(),
                hotReload: false,
                transportFactory: factory,
            });
            driver.start();
            const pty = factory.last!;
            const nonFocusWrites = () => pty.writes.filter(w => w !== '\u001b[I');

            // Print sign-in text into scrollback AND in tool output above the active idle composer chrome
            const scrollbackPadding = Array.from({ length: 45 }, (_, i) =>
                i === 2
                    ? 'Select login method:\r\n ❯ 1. Claude account with subscription\r\n   2. Anthropic Console account'
                    : `scrollback line ${i}`,
            ).join('\r\n');
            const activeIdleWithToolSignIn = [
                '⏺ Read(test/auth.test.ts)',
                '  ⎿  Select login method:',
                '       1. Claude account with subscription',
                '       2. Anthropic Console account',
                '────────────────────',
                '❯ ',
                '────────────────────',
                '  Opus 4.6 · 18% context',
            ].join('\r\n');

            pty.feed(`${scrollbackPadding}\r\n${activeIdleWithToolSignIn}\r\n`);
            await vi.advanceTimersByTimeAsync(9_000);
            expect(driver.currentStateId).toBe('idle');
            expect(driver.hasSeenReady()).toBe(true);
            pty.writes.length = 0;

            const disp = driver.sendMessageWithDisposition('healthy task with scrollback sign-in text', false, 'msg-healthy-1');
            await vi.advanceTimersByTimeAsync(1_000);

            expect(disp).toEqual({ status: 'delivered' });
            expect(driver.currentStateId).toBe('idle');
            expect(nonFocusWrites().join('')).toContain('healthy task with scrollback sign-in text');

            driver.shutdown();
        } finally {
            vi.useRealTimers();
        }
    });

    it('matches active sign-in viewports for all 6 providers and sub-screens, and rejects viewports where composer chrome is present below login text', () => {
        const providerCases: Array<{ cli: string; file: string; signInScreens: string[]; idleWithLoginAbove: string }> = [
            {
                cli: 'antigravity-cli',
                file: '4.0.json',
                signInScreens: [AGY_SIGNIN_SELECTOR_SCREEN, AGY_OAUTH_PASTE_CODE_SCREEN],
                idleWithLoginAbove: [
                    AGY_SIGNIN_SELECTOR_SCREEN,
                    '────────────────────────────────────────────────────────────────────────────────',
                    '> Type your message or @path/to/file',
                    '────────────────────────────────────────────────────────────────────────────────',
                    '? for shortcuts                                          Gemini 3.7 Flash · high',
                ].join('\n'),
            },
            {
                cli: 'claude-cli',
                file: '4.0.json',
                signInScreens: [
                    CLAUDE_SIGNIN_SCREEN,
                    CLAUDE_OAUTH_PASTE_CODE_SCREEN,
                    CLAUDE_CONSOLE_SUBSCREEN,
                    CLAUDE_OPENING_BROWSER_SUBSCREEN,
                    CLAUDE_CLOUD_GATEWAY_SUBSCREEN,
                ],
                idleWithLoginAbove: [
                    CLAUDE_SIGNIN_SCREEN,
                    '────────────────────────────────────────────────────────────────────────────────',
                    '❯ ',
                    '────────────────────────────────────────────────────────────────────────────────',
                    '  ⏸ manual mode on · ← for agents',
                ].join('\n'),
            },
            {
                cli: 'codex-cli',
                file: '4.0.json',
                signInScreens: [
                    CODEX_SIGNIN_SCREEN,
                    CODEX_FINISH_BROWSER_SUBSCREEN,
                    CODEX_PREPARING_DEVICE_CODE_SUBSCREEN,
                    CODEX_API_KEY_BOX_SUBSCREEN,
                    CODEX_API_KEY_DISABLED_SUBSCREEN,
                ],
                idleWithLoginAbove: [
                    CODEX_SIGNIN_SCREEN,
                    '› Ask Codex to do anything',
                    '  gpt-5.4-codex medium · /tmp/ws · 92% left',
                    '  ? for shortcuts',
                ].join('\n'),
            },
            {
                cli: 'cursor-cli',
                file: '1.0.json',
                signInScreens: [CURSOR_SIGNIN_SCREEN],
                idleWithLoginAbove: [
                    CURSOR_SIGNIN_SCREEN,
                    '  Claude 4.5 Sonnet · 4.2%',
                    '  /tmp/ws',
                ].join('\n'),
            },
            {
                cli: 'grok-cli',
                file: '1.0.json',
                signInScreens: [GROK_SIGNIN_SCREEN],
                idleWithLoginAbove: [
                    GROK_SIGNIN_SCREEN,
                    '  │ ❯ ',
                    '  Shift+Tab: mode · Ctrl+x: shortcuts',
                ].join('\n'),
            },
            {
                cli: 'kimi',
                file: '1.0.json',
                signInScreens: [KIMI_SIGNIN_DEVICE_CODE_SCREEN],
                idleWithLoginAbove: [
                    KIMI_SIGNIN_DEVICE_CODE_SCREEN,
                    '  ╭──────────────────────────────────────────╮',
                    '  │ >                                        │',
                    '  ╰──────────────────────────────────────────╯',
                ].join('\n'),
            },
        ];

        for (const c of providerCases) {
            const spec = loadProviderSpec(c.cli, c.file);
            for (const s of c.signInScreens) {
                expect(isAnchoredSignInViewport(s, spec), `${c.cli} sign-in screen`).toBe(true);
            }
            expect(isAnchoredSignInViewport(c.idleWithLoginAbove, spec), `${c.cli} idle composer below login text`).toBe(false);
        }
    });
});

describe('Round 3 Finding 2 — fenced code blocks, unified-diff context lines, and blank-separated tool continuations do not cause mid-turn auth advisories', () => {
    const t0 = 1_800_000_000_000;
    const ctx = { cliType: 'claude-cli', sessionLabel: 'sess-r3-f2', isCoordinator: false };

    it.each([
        [
            'fenced code block containing an indented API Error: 401 Unauthorized',
            [
                '⏺ Here is the reproduction snippet:',
                '```text',
                '  API Error: 401 Unauthorized',
                '```',
                '✻ Thinking… (esc to interrupt)',
            ].join('\n'),
        ],
        [
            'tilde-fenced code block containing an indented API Error: 401 Unauthorized',
            [
                '~~~',
                '  API Error: 401 Unauthorized',
                '~~~',
                '✻ Thinking… (esc to interrupt)',
            ].join('\n'),
        ],
        [
            'unified-diff context line with API Error: 401 Unauthorized',
            [
                'diff --git a/test/auth.test.ts b/test/auth.test.ts',
                '--- a/test/auth.test.ts',
                '+++ b/test/auth.test.ts',
                '@@ -10,4 +10,5 @@ describe("auth", () => {',
                ' API Error: 401 Unauthorized',
                '+expect(true).toBe(true);',
                ' });',
            ].join('\n'),
        ],
        [
            'indented tool continuation after a blank line',
            [
                '  ⎿  Running test suite...',
                '',
                '     API Error: 401 Unauthorized',
            ].join('\n'),
        ],
    ])('does NOT classify or fire mid-turn advisory for %s', (_label, screen) => {
        expect(detectProviderFailure(screen)).toBeNull();

        const state = createLiveAuthState();
        const failure = classifyAuthBillingOutput('claude-cli', screen);
        if (failure) noteLiveAuthMatch(state, ctx, failure);
        // Even if a prior suspicion existed on the session, mid-turn resolution at age 20s / quietMs 10s must not fire on this screen
        if (!state.suspect) {
            state.suspect = {
                failure: { errorReason: 'auth_failed', failureKind: 'auth', message: 'prior suspect' },
                suspectedAtMs: t0,
            };
        }
        const res = resolveLiveAuthSuspect(state, ctx, {
            midTurn: true,
            now: t0 + 20_000,
            quietMs: 10_000,
            tail: screen,
            readScreen: () => screen,
        });
        expect(res.advisory).toBeUndefined();
        expect(res.latch).toBeUndefined();
    });

    it('still triggers mid-turn advisory on a genuine provider 401 rendering anchored at line start near the bottom', () => {
        const genuineScreen = [
            '⏺ Working on the task...',
            'API Error: 401 Unauthorized — OAuth token has expired.',
        ].join('\n');
        const failure = classifyAuthBillingOutput('claude-cli', genuineScreen);
        expect(failure).toMatchObject({ errorReason: 'auth_failed', failureKind: 'auth' });

        const state = createLiveAuthState();
        state.suspect = { failure: failure!, suspectedAtMs: t0 };
        const res = resolveLiveAuthSuspect(state, ctx, {
            midTurn: true,
            now: t0 + 20_000,
            quietMs: 10_000,
            tail: genuineScreen,
            readScreen: () => genuineScreen,
        });
        expect(res.advisory).toBeDefined();
        expect(res.advisory?.kind).toBe('auth_error');
    });
});

describe('Round 3 Finding 5 — native Anthropic JSON authentication_error and Invalid authentication credentials', () => {
    it('classifies raw {"type":"error","error":{"type":"authentication_error","message":"Unauthorized"}} without API Error: 401 prefix', () => {
        const rawJson = '{"type":"error","error":{"type":"authentication_error","message":"Unauthorized"}}';
        expect(detectProviderFailure(rawJson)).toMatchObject({
            errorReason: 'auth_failed',
            failureKind: 'auth',
        });
        expect(detectAuthFailureOnlyReply(rawJson)).toMatchObject({
            errorReason: 'auth_failed',
            failureKind: 'auth',
        });

        const t0 = 1_800_000_000_000;
        const state = createLiveAuthState();
        state.suspect = {
            failure: detectProviderFailure(rawJson)!,
            suspectedAtMs: t0,
        };
        const res = resolveLiveAuthSuspect(
            state,
            { cliType: 'claude-cli', sessionLabel: 'sess-json-auth', isCoordinator: false },
            {
                midTurn: true,
                now: t0 + 20_000,
                quietMs: 10_000,
                tail: rawJson,
                readScreen: () => rawJson,
            },
        );
        expect(res.advisory).toBeDefined();
        expect(res.advisory?.kind).toBe('auth_error');
    });

    it('classifies "Invalid authentication credentials" in both banner and JSON form', () => {
        for (const sample of [
            'Invalid authentication credentials',
            'Error: Invalid authentication credentials',
            'API Error: Invalid authentication credentials',
            '{"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
        ]) {
            expect(detectProviderFailure(sample), sample).toMatchObject({
                errorReason: 'auth_failed',
                failureKind: 'auth',
            });
            expect(detectAuthFailureOnlyReply(sample), sample).toMatchObject({
                errorReason: 'auth_failed',
                failureKind: 'auth',
            });
        }
    });
});

// ── Round 4 regression tests (Codex review 23a93201) ─────────────────────────

const CURSOR_BROWSER_LOGIN_SUBSCREEN = [
    '',
    '  Signing in with the browser',
    '  If your browser didn\'t open, click this link to log in: https://cursor.com/login?code=ABCD-1234',
    '  Press q to show a QR code to log in',
    '',
].join('\n');

const GROK_BROWSER_APPROVAL_SUBSCREEN = [
    '',
    '  Approve in your browser',
    '  Waiting for approval...',
    '',
].join('\n');

const GROK_SIGN_IN_BUILD_SUBSCREEN = [
    '',
    '  Sign in to Grok Build',
    '  Enter your xAI API key',
    '',
].join('\n');

const CODEX_PASTE_API_KEY_ONLY_SUBSCREEN = [
    '',
    '  Paste or type your API key below. It will be stored locally in auth.json.',
    '  ╭──────────────────────────────────────────────────╮',
    '  │ >                                                │',
    '  ╰──────────────────────────────────────────────────╯',
    '',
].join('\n');

const KIMI_API_KEY_SAVED_SUBSCREEN = [
    '',
    '  Your key will be saved to ~/.kimi/config.toml',
    '',
].join('\n');

describe('Round 4 Finding 1 — pre-send guard evaluates provider spec signing_in entry conditions across all login screens', () => {
    const ALL_PROVIDER_LOGIN_CASES: Array<{
        cli: string;
        file: string;
        readyFrame: string;
        loginScreens: Array<{ name: string; screen: string }>;
    }> = [
        {
            cli: 'claude-cli',
            file: '4.0.json',
            readyFrame: '────────────────────\r\n❯ \r\n────────────────────\r\n  Opus 4.6 · 12% context\r\n',
            loginScreens: [
                { name: 'Select login method', screen: CLAUDE_SIGNIN_SCREEN },
                { name: 'Console sub-screen', screen: CLAUDE_CONSOLE_SUBSCREEN },
                { name: 'Opening browser', screen: CLAUDE_OPENING_BROWSER_SUBSCREEN },
                { name: 'Browser paste code', screen: CLAUDE_OAUTH_PASTE_CODE_SCREEN },
                { name: 'Cloud gateway', screen: CLAUDE_CLOUD_GATEWAY_SUBSCREEN },
            ],
        },
        {
            cli: 'codex-cli',
            file: '4.0.json',
            readyFrame: '› Ask Codex to do anything\r\n  gpt-5.4-codex medium · /tmp/ws · 92% left\r\n  ? for shortcuts\r\n',
            loginScreens: [
                { name: 'ChatGPT / Device Code / API key menu', screen: CODEX_SIGNIN_SCREEN },
                { name: 'Finish signing in via your browser', screen: CODEX_FINISH_BROWSER_SUBSCREEN },
                { name: 'Preparing device code login', screen: CODEX_PREPARING_DEVICE_CODE_SUBSCREEN },
                { name: 'Use your own OpenAI API key box', screen: CODEX_API_KEY_BOX_SUBSCREEN },
                { name: 'API key login is disabled', screen: CODEX_API_KEY_DISABLED_SUBSCREEN },
                { name: 'Paste or type your API key below standalone', screen: CODEX_PASTE_API_KEY_ONLY_SUBSCREEN },
            ],
        },
        {
            cli: 'cursor-cli',
            file: '1.0.json',
            readyFrame: '  Claude 4.5 Sonnet · 4.2%\r\n  /tmp/ws\r\n',
            loginScreens: [
                { name: 'Press Enter to sign in', screen: CURSOR_SIGNIN_SCREEN },
                { name: 'Signing in with the browser / QR code', screen: CURSOR_BROWSER_LOGIN_SUBSCREEN },
            ],
        },
        {
            cli: 'grok-cli',
            file: '1.0.json',
            readyFrame: '  │ ❯ \r\n  Shift+Tab:mode │ Ctrl+x:shortcuts\r\n',
            loginScreens: [
                { name: 'Paste your xAI API key', screen: GROK_SIGNIN_SCREEN },
                { name: 'Approve in your browser / Waiting for approval...', screen: GROK_BROWSER_APPROVAL_SUBSCREEN },
                { name: 'Sign in to Grok Build / Enter your xAI API key', screen: GROK_SIGN_IN_BUILD_SUBSCREEN },
            ],
        },
        {
            cli: 'kimi',
            file: '1.0.json',
            readyFrame: '  ╭──────────────────────────────────────────╮\r\n  │ >                                        │\r\n  ╰──────────────────────────────────────────╯\r\n',
            loginScreens: [
                { name: 'Kimi device code / Waiting for authorization', screen: KIMI_SIGNIN_DEVICE_CODE_SCREEN },
                { name: 'Your key will be saved to config.toml', screen: KIMI_API_KEY_SAVED_SUBSCREEN },
            ],
        },
        {
            cli: 'antigravity-cli',
            file: '4.0.json',
            readyFrame: '────────────────────────────────────────\r\n> Type your message or @path/to/file\r\n────────────────────────────────────────\r\n  ? for shortcuts\r\n',
            loginScreens: [
                { name: 'Select Google Cloud sign-in method', screen: AGY_SIGNIN_SELECTOR_SCREEN },
                { name: 'OAuth URL / paste authorization code', screen: AGY_OAUTH_PASTE_CODE_SCREEN },
            ],
        },
    ];

    it('blocks send and transitions to signing_in on every login screen across all 6 providers', async () => {
        vi.useFakeTimers();
        try {
            for (const provider of ALL_PROVIDER_LOGIN_CASES) {
                const spec = loadProviderSpec(provider.cli, provider.file);
                for (const login of provider.loginScreens) {
                    const label = `${provider.cli}: ${login.name}`;
                    expect(isAnchoredSignInViewport(login.screen, spec), label).toBe(true);

                    const factory = new DrivableFactory();
                    const driver = new FsmDriver({
                        specPath: resolveProviderSpecPath(provider.cli, provider.file),
                        workingDir: os.tmpdir(),
                        hotReload: false,
                        transportFactory: factory,
                    });
                    driver.start();
                    const pty = factory.last!;
                    const nonFocusWrites = () => pty.writes.filter(w => w !== '\u001b[I');

                    pty.feed(provider.readyFrame);
                    await vi.advanceTimersByTimeAsync(9_000);
                    expect(driver.currentStateId, `${label} initial idle`).toBe('idle');
                    expect(driver.hasSeenReady(), `${label} readySeenOnce`).toBe(true);
                    pty.writes.length = 0;

                    // Clear viewport and render the login screen while FSM is in idle
                    pty.feed('\u001b[2J\u001b[H' + login.screen.replace(/\n/g, '\r\n'));
                    await vi.advanceTimersByTimeAsync(200);

                    const msgId = `msg-${provider.cli}-${login.name}`;
                    const disp = driver.sendMessageWithDisposition('do not write into auth screen', false, msgId);
                    await vi.advanceTimersByTimeAsync(500);

                    expect(nonFocusWrites(), `${label} no PTY writes`).toEqual([]);
                    expect(disp, `${label} disposition`).toEqual({
                        status: 'queued',
                        queueDepth: 1,
                        reason: 'auth_required',
                    });
                    expect(driver.currentStateId, `${label} transitioned to signing_in`).toBe('signing_in');
                    expect(driver.hasQueuedSend(msgId), `${label} queued`).toBe(true);

                    driver.shutdown();
                }
            }
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('Round 4 Finding 2 — ordinary text does not block send, and forced signing_in exits and drains on a quiet terminal', () => {
    it('does NOT block send or force signing_in on a cleared screen showing "Let\'s get started with the implementation."', async () => {
        vi.useFakeTimers();
        try {
            const spec = loadProviderSpec('claude-cli', '4.0.json');
            const ordinaryScreen = 'Let\'s get started with the implementation.\n';
            expect(isAnchoredSignInViewport(ordinaryScreen, spec)).toBe(false);

            const factory = new DrivableFactory();
            const driver = new FsmDriver({
                specPath: resolveProviderSpecPath('claude-cli', '4.0.json'),
                workingDir: os.tmpdir(),
                hotReload: false,
                transportFactory: factory,
            });
            driver.start();
            const pty = factory.last!;
            const nonFocusWrites = () => pty.writes.filter(w => w !== '\u001b[I');

            pty.feed('────────────────────\r\n❯ \r\n────────────────────\r\n  Opus 4.6 · 12% context\r\n');
            await vi.advanceTimersByTimeAsync(9_000);
            expect(driver.currentStateId).toBe('idle');
            pty.writes.length = 0;

            // Clear screen to ordinary assistant prose with no composer chrome
            pty.feed('\u001b[2J\u001b[HLet\'s get started with the implementation.\r\n');
            await vi.advanceTimersByTimeAsync(200);

            const disp = driver.sendMessageWithDisposition('follow-up task on cleared screen', false, 'msg-ordinary-1');
            await vi.advanceTimersByTimeAsync(500);

            expect(disp).toEqual({ status: 'delivered' });
            expect(driver.currentStateId).toBe('idle');
            expect(nonFocusWrites().join('')).toContain('follow-up task on cleared screen');

            driver.shutdown();
        } finally {
            vi.useRealTimers();
        }
    });

    it('exits forced signing_in within the 15s grace period on a quiet terminal once the login screen disappears, and drains the queued task', async () => {
        vi.useFakeTimers();
        try {
            const factory = new DrivableFactory();
            const driver = new FsmDriver({
                specPath: resolveProviderSpecPath('claude-cli', '4.0.json'),
                workingDir: os.tmpdir(),
                hotReload: false,
                transportFactory: factory,
            });
            driver.start();
            const pty = factory.last!;
            const nonFocusWrites = () => pty.writes.filter(w => w !== '\u001b[I');

            // 1. Reach idle
            pty.feed('────────────────────\r\n❯ \r\n────────────────────\r\n  Opus 4.6 · 12% context\r\n');
            await vi.advanceTimersByTimeAsync(9_000);
            expect(driver.currentStateId).toBe('idle');
            pty.writes.length = 0;

            // 2. Real login screen appears while idle and blocks a send -> forced signing_in
            pty.feed('\u001b[2J\u001b[H' + CLAUDE_SIGNIN_SCREEN.replace(/\n/g, '\r\n'));
            await vi.advanceTimersByTimeAsync(200);
            const disp = driver.sendMessageWithDisposition('queued task waiting for login recovery', false, 'msg-quiet-drain-1');
            expect(disp).toEqual({
                status: 'queued',
                queueDepth: 1,
                reason: 'auth_required',
            });
            expect(driver.currentStateId).toBe('signing_in');
            expect(nonFocusWrites()).toEqual([]);

            // 3. Login screen disappears onto a quiet terminal (even without full composer chrome)
            pty.feed('\u001b[2J\u001b[HLogin successful.\r\n');
            // Terminal stays completely quiet from here on; within the 15s grace period signing_in must exit to idle and drain the queued task
            await vi.advanceTimersByTimeAsync(16_000);

            expect(driver.currentStateId).toBe('idle');
            expect(driver.hasQueuedSend('msg-quiet-drain-1')).toBe(false);
            expect(nonFocusWrites().join('')).toContain('queued task waiting for login recovery');

            driver.shutdown();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('Round 4 Finding 3 — chrome-looking lines inside an open fence or diff hunk do not reset protection', () => {
    const t0 = 1_800_000_000_000;
    const ctx = { cliType: 'claude-cli', sessionLabel: 'sess-r4-f3', isCoordinator: false };

    it.each([
        [
            'fenced block containing a 12-dash box-drawing line before API Error: 401 Unauthorized',
            [
                '⏺ Example terminal transcript:',
                '```text',
                '────────────',
                'API Error: 401 Unauthorized',
                '```',
                '✻ Thinking… (esc to interrupt)',
            ].join('\n'),
        ],
        [
            'fenced block containing "❯ sample prompt" before API Error: 401 Unauthorized',
            [
                '⏺ Example terminal transcript:',
                '```',
                '❯ sample prompt',
                'API Error: 401 Unauthorized',
                '```',
                '✻ Thinking… (esc to interrupt)',
            ].join('\n'),
        ],
        [
            'tilde-fenced block containing both 12-dash rule and "❯ sample prompt" before API Error: 401 Unauthorized',
            [
                '~~~markdown',
                '────────────────────',
                '❯ sample prompt',
                'API Error: 401 Unauthorized',
                '~~~',
            ].join('\n'),
        ],
        [
            'unified-diff hunk containing chrome-looking context lines before API Error: 401 Unauthorized',
            [
                'diff --git a/test/fixture.txt b/test/fixture.txt',
                '--- a/test/fixture.txt',
                '+++ b/test/fixture.txt',
                '@@ -1,4 +1,5 @@',
                ' ────────────',
                ' ❯ sample prompt',
                ' API Error: 401 Unauthorized',
                '+ok',
            ].join('\n'),
        ],
    ])('returns null from detectProviderFailure and emits no advisory for %s', (_label, screen) => {
        expect(detectProviderFailure(screen)).toBeNull();
        expect(classifyAuthBillingOutput('claude-cli', screen)).toBeNull();

        const state = createLiveAuthState();
        state.suspect = {
            failure: { errorReason: 'auth_failed', failureKind: 'auth', message: 'prior suspect' },
            suspectedAtMs: t0,
        };
        const res = resolveLiveAuthSuspect(state, ctx, {
            midTurn: true,
            now: t0 + 20_000,
            quietMs: 10_000,
            tail: screen,
            readScreen: () => screen,
        });
        expect(res.advisory).toBeUndefined();
        expect(res.latch).toBeUndefined();
    });
});

describe('Round 4 Finding 4 — TerminalAdapter.snapshot caches serialized screen across unchanged reads', () => {
    it('does not recompute screen.getText() on repeated snapshots when no new PTY output or resize occurred', () => {
        const factory = new DrivableFactory();
        const adapter = new TerminalAdapter(
            {
                binary: 'claude',
                cols: 80,
                rows: 24,
                transportFactory: factory,
            },
            {},
        );
        adapter.start();
        const pty = factory.last!;
        const internalScreen = (adapter as unknown as { screen: { getText: () => string } }).screen;
        const getTextSpy = vi.spyOn(internalScreen, 'getText');

        pty.feed('Hello from PTY\r\n');
        const first = adapter.snapshot();
        expect(first).toContain('Hello from PTY');
        expect(getTextSpy).toHaveBeenCalledTimes(1);

        // Repeated snapshots with no new PTY output must reuse cached screen without calling getText()
        expect(adapter.snapshot()).toBe(first);
        expect(adapter.snapshot()).toBe(first);
        expect(adapter.snapshot()).toBe(first);
        expect(getTextSpy).toHaveBeenCalledTimes(1);

        // New PTY output invalidates the cache and recomputes once
        pty.feed('Second line\r\n');
        const second = adapter.snapshot();
        expect(second).toContain('Second line');
        expect(getTextSpy).toHaveBeenCalledTimes(2);
        expect(adapter.snapshot()).toBe(second);
        expect(getTextSpy).toHaveBeenCalledTimes(2);

        // Resize also invalidates the cache and recomputes once
        adapter.resize(100, 30);
        expect(adapter.snapshot()).toContain('Second line');
        expect(getTextSpy).toHaveBeenCalledTimes(3);
        expect(adapter.snapshot()).toContain('Second line');
        expect(getTextSpy).toHaveBeenCalledTimes(3);

        adapter.kill();
    });
});

describe('Round 5 — HIGH-1: approval modals quoting login text stay in approval with card visible and never hijack into signing_in', () => {
    const claudeBashHeredocApproval = [
        '⏺ Bash(cat <<\'EOF\' > /tmp/login-fixture.txt)',
        '',
        '────────────────────────────────────────────────────────────────────────────────',
        ' Bash command',
        '',
        '   cat <<\'EOF\' > /tmp/login-fixture.txt',
        '   Select login method:',
        '    ❯ 1. Claude account with subscription',
        '      2. Anthropic Console account',
        '   EOF',
        '',
        ' Do you want to proceed?',
        ' ❯ 1. Yes',
        '   2. Yes, and don\'t ask again for cat commands in /tmp',
        '   3. No, and tell Claude what to do differently (esc)',
        '',
        ' Esc to cancel · Tab to amend',
    ].join('\n');

    const claudeCreateFileApproval = [
        '⏺ Write(/tmp/login-fixture.txt)',
        '',
        '────────────────────────────────────────────────────────────────────────────────',
        ' Create file',
        ' ../../../../tmp/login-fixture.txt',
        '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
        '  1 Select login method:',
        '  2 Anthropic Console account',
        '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
        ' Do you want to create login-fixture.txt?',
        ' ❯ 1. Yes',
        '   2. Yes, allow all edits in tmp/ during this session (shift+tab)',
        '   3. No',
        '',
        ' Esc to cancel · Tab to amend',
    ].join('\n');

    const codexCommandApproval = [
        'Would you like to run the following command?',
        '',
        '  $ printf "%s\\n" "Use your own OpenAI API key" "Sign in with ChatGPT to use Codex"',
        '',
        '› 1. Yes, proceed (y)',
        '  2. Yes, and don\'t ask again for this command (a)',
        '  3. No, and tell Codex what to do differently (esc)',
        '',
        '  Press enter to confirm or esc to cancel',
    ].join('\n');

    it.each([
        ['Claude Bash heredoc approval quoting login text', claudeBashHeredocApproval],
        ['Claude Create-file approval quoting login text', claudeCreateFileApproval],
    ])('%s keeps state approval with modal card visible across a send and 120s+, and never queues as auth_required', async (_label, approvalModalScreen) => {
        vi.useFakeTimers();
        try {
            const spec = loadProviderSpec('claude-cli', '4.0.json');
            expect(isAnchoredSignInViewport(approvalModalScreen, spec)).toBe(false);

            const factory = new DrivableFactory();
            const driver = new FsmDriver({
                specPath: resolveProviderSpecPath('claude-cli', '4.0.json'),
                workingDir: os.tmpdir(),
                hotReload: false,
                transportFactory: factory,
            });

            let latestModal: { title?: string; buttons: Array<{ index: number; label: string }>; kind?: string } | null = null;
            let latestStateId = '';
            driver.subscribe(ev => {
                if (ev.kind === 'state_changed') {
                    latestStateId = ev.state.id;
                    latestModal = ev.modal;
                }
            });

            driver.start();
            const pty = factory.last!;
            const nonFocusWrites = () => pty.writes.filter(w => w !== '\u001b[I');

            // 1. Reach idle past the 8s startup grace
            pty.feed('────────────────────\r\n❯ \r\n────────────────────\r\n  Opus 4.6 · 12% context\r\n');
            await vi.advanceTimersByTimeAsync(9_000);
            expect(driver.currentStateId).toBe('idle');
            expect(driver.hasSeenReady()).toBe(true);
            pty.writes.length = 0;

            // 2. Render approval modal quoting login text (clearing composer chrome off viewport)
            pty.feed('\u001b[2J\u001b[H' + approvalModalScreen.replace(/\n/g, '\r\n') + '\r\n');
            await vi.advanceTimersByTimeAsync(200);

            expect(driver.currentStateId).toBe('approval');
            expect(latestStateId).toBe('approval');
            expect(latestModal).not.toBeNull();
            expect(latestModal?.buttons.length).toBeGreaterThanOrEqual(2);
            expect(latestModal?.buttons[0]?.label).toMatch(/^Yes\b/);

            // 3. Send a message while the approval modal is up
            const disp = driver.sendMessageWithDisposition('follow-up message during approval', false, 'msg-during-claude-approval');
            expect(disp.status).toBe('queued');
            expect(disp.reason).not.toBe('auth_required');
            expect(disp.reason).toBe('machine is approval');
            expect(nonFocusWrites()).toEqual([]);

            // 4. State must remain approval with the modal card visible immediately and past 120s+
            expect(driver.currentStateId).toBe('approval');
            expect(latestStateId).toBe('approval');
            expect(latestModal).not.toBeNull();

            await vi.advanceTimersByTimeAsync(130_000);
            expect(driver.currentStateId).toBe('approval');
            expect(latestStateId).toBe('approval');
            expect(latestModal).not.toBeNull();
            expect(latestModal?.buttons[0]?.label).toMatch(/^Yes\b/);
            expect(nonFocusWrites()).toEqual([]);

            driver.shutdown();
        } finally {
            vi.useRealTimers();
        }
    });

    it('Codex command approval quoting "Use your own OpenAI API key" keeps state approval with modal card visible across a send and 120s+, and never queues as auth_required', async () => {
        vi.useFakeTimers();
        try {
            const spec = loadProviderSpec('codex-cli', '4.0.json');
            expect(isAnchoredSignInViewport(codexCommandApproval, spec)).toBe(false);

            const factory = new DrivableFactory();
            const driver = new FsmDriver({
                specPath: resolveProviderSpecPath('codex-cli', '4.0.json'),
                workingDir: os.tmpdir(),
                hotReload: false,
                transportFactory: factory,
            });

            let latestModal: { title?: string; buttons: Array<{ index: number; label: string }>; kind?: string } | null = null;
            let latestStateId = '';
            driver.subscribe(ev => {
                if (ev.kind === 'state_changed') {
                    latestStateId = ev.state.id;
                    latestModal = ev.modal;
                }
            });

            driver.start();
            const pty = factory.last!;
            const nonFocusWrites = () => pty.writes.filter(w => w !== '\u001b[I');

            // 1. Reach idle
            pty.feed('› Explain this codebase\r\n\r\n  gpt-5.4 high · 100% left · ~/repo\r\n');
            await vi.advanceTimersByTimeAsync(2_000);
            expect(driver.currentStateId).toBe('idle');
            expect(driver.hasSeenReady()).toBe(true);
            pty.writes.length = 0;

            // 2. Render Codex approval modal whose command quotes "Use your own OpenAI API key"
            pty.feed('\u001b[2J\u001b[H' + codexCommandApproval.replace(/\n/g, '\r\n') + '\r\n');
            await vi.advanceTimersByTimeAsync(200);

            expect(driver.currentStateId).toBe('approval');
            expect(latestStateId).toBe('approval');
            expect(latestModal).not.toBeNull();
            expect(latestModal?.buttons.length).toBeGreaterThanOrEqual(2);
            expect(latestModal?.buttons[0]?.label).toMatch(/^Yes, proceed/);

            // 3. Send a message while the approval modal is active
            const disp = driver.sendMessageWithDisposition('follow-up message during codex approval', false, 'msg-during-codex-approval');
            expect(disp.status).toBe('queued');
            expect(disp.reason).not.toBe('auth_required');
            expect(disp.reason).toBe('machine is approval');
            expect(nonFocusWrites()).toEqual([]);

            // 4. State must remain approval with the modal card visible immediately and past 120s+
            expect(driver.currentStateId).toBe('approval');
            expect(latestStateId).toBe('approval');
            expect(latestModal).not.toBeNull();

            await vi.advanceTimersByTimeAsync(130_000);
            expect(driver.currentStateId).toBe('approval');
            expect(latestStateId).toBe('approval');
            expect(latestModal).not.toBeNull();
            expect(latestModal?.buttons[0]?.label).toMatch(/^Yes, proceed/);
            expect(nonFocusWrites()).toEqual([]);

            driver.shutdown();
        } finally {
            vi.useRealTimers();
        }
    });

    it('signing_in → approval escape transitions out of signing_in when an approval modal renders in Claude or Codex', async () => {
        vi.useFakeTimers();
        try {
            for (const tc of [
                {
                    cli: 'claude-cli',
                    file: '4.0.json',
                    loginScreen: CLAUDE_SIGNIN_SCREEN,
                    approvalScreen: claudeBashHeredocApproval,
                },
                {
                    cli: 'codex-cli',
                    file: '4.0.json',
                    loginScreen: CODEX_SIGNIN_SCREEN,
                    approvalScreen: codexCommandApproval,
                },
            ]) {
                const factory = new DrivableFactory();
                const driver = new FsmDriver({
                    specPath: resolveProviderSpecPath(tc.cli, tc.file),
                    workingDir: os.tmpdir(),
                    hotReload: false,
                    transportFactory: factory,
                });

                let latestModal: { title?: string; buttons: Array<{ index: number; label: string }> } | null = null;
                driver.subscribe(ev => {
                    if (ev.kind === 'state_changed') {
                        latestModal = ev.modal;
                    }
                });

                driver.start();
                const pty = factory.last!;

                pty.feed(tc.loginScreen.replace(/\n/g, '\r\n') + '\r\n');
                await vi.advanceTimersByTimeAsync(200);
                expect(driver.currentStateId, `${tc.cli} entered signing_in`).toBe('signing_in');

                // Approval modal appears while in signing_in -> must immediately escape to approval with modal card visible
                pty.feed('\u001b[2J\u001b[H' + tc.approvalScreen.replace(/\n/g, '\r\n') + '\r\n');
                await vi.advanceTimersByTimeAsync(200);
                expect(driver.currentStateId, `${tc.cli} escaped signing_in → approval`).toBe('approval');
                expect(latestModal, `${tc.cli} modal card visible`).not.toBeNull();
                expect(latestModal?.buttons.length).toBeGreaterThanOrEqual(2);

                driver.shutdown();
            }
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('Round 5 — MEDIUM-3: unclosed fences terminate at strong turn boundaries so real subsequent 401 auth errors are detected', () => {
    const t0 = 1_850_000_000_000;
    const ctx = { cliType: 'claude-cli', sessionLabel: 'sess-r5-m3', isCoordinator: false };

    const unclosedTruncatedCatProbe = [
        '⏺ Bash(cat README.md)',
        '  ⎿  # Project Setup',
        '     ```bash',
        '     export API_KEY="demo"',
        '     npm test',
        '     … +42 lines (ctrl+o to expand)',
        '',
        '⏺ API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login',
    ].join('\n');

    const unclosedAgentProseFenceProbe = [
        '⏺ Here is the snippet I was writing before the request failed:',
        '```ts',
        'export function sum(a: number, b: number) {',
        '  return a + b;',
        '}',
        '',
        '⏺ API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}} · Please run /login',
    ].join('\n');

    const unclosedFenceBeforeSummaryProbe = [
        '⏺ Starting example block:',
        '```json',
        '{"hello": "world"}',
        '✻ Worked for 4s',
        'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
    ].join('\n');

    const unclosedDiffHunkProbe = [
        '⏺ Update(src/index.ts)',
        '@@ -1,3 +1,4 @@',
        ' const x = 1;',
        '+const y = 2;',
        '⏺ API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login',
    ].join('\n');

    const balancedFenceControl = [
        '⏺ Example snippet:',
        '```ts',
        'export const x = 1;',
        '```',
        '⏺ API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login',
    ].join('\n');

    it.each([
        ['unclosed fence in truncated cat README.md output ending "… +42 lines"', unclosedTruncatedCatProbe],
        ['unclosed fence in agent prose followed by a col-0 ⏺ API Error: 401 line', unclosedAgentProseFenceProbe],
        ['unclosed fence terminated by a ✻ turn summary line before API Error: 401', unclosedFenceBeforeSummaryProbe],
        ['unclosed diff hunk terminated by a col-0 ⏺ API Error: 401 line', unclosedDiffHunkProbe],
        ['balanced fence control followed by a real ⏺ API Error: 401 line', balancedFenceControl],
    ])('detects auth_failed and emits mid-turn auth_error advisory for %s', (_label, screen) => {
        const failure = detectProviderFailure(screen);
        expect(failure).not.toBeNull();
        expect(failure?.errorReason).toBe('auth_failed');

        const classified = classifyAuthBillingOutput('claude-cli', screen);
        expect(classified).not.toBeNull();
        expect(classified?.errorReason).toBe('auth_failed');

        const state = createLiveAuthState();
        state.suspect = {
            failure: { errorReason: 'auth_failed', failureKind: 'auth', message: '401 Unauthorized' },
            suspectedAtMs: t0,
        };
        const res = resolveLiveAuthSuspect(state, ctx, {
            midTurn: true,
            now: t0 + 20_000,
            quietMs: 10_000,
            tail: screen,
            readScreen: () => screen,
        });
        expect(res.advisory).toBeDefined();
        expect(res.advisory?.kind).toBe('auth_error');
        expect(res.latch).toBeUndefined();
    });
});

describe('Round 6 — NEW HIGH: login menus with Esc/cancel hints stay in signing_in, block sends, and never expose approval cards', () => {
    const claudeLoginWithEsc = [
        ' Select login method:',
        '❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise',
        '  2. Anthropic Console account · API usage billing',
        '  3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI',
        '',
        ' Esc to cancel',
    ].join('\n');

    const claudeLoginWithoutEsc = [
        ' Select login method:',
        '❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise',
        '  2. Anthropic Console account · API usage billing',
        '  3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI',
    ].join('\n');

    const codexLoginWithCancelHint = [
        '  Sign in with ChatGPT to use Codex',
        '',
        '  › 1. Sign in with ChatGPT',
        '    2. Sign in with Device Code',
        '    3. Provide your own API key',
        '',
        '  enter to submit | esc to cancel',
    ].join('\n');

    const agyLoginWithCancelHint = [
        '  Welcome back! You are currently not signed in.',
        '  Select Google Cloud sign-in method:',
        '  ❯ 1. Sign in with Google (Browser OAuth)',
        '    2. Use Application Default Credentials (ADC)',
        '',
        '  Esc to cancel',
    ].join('\n');

    const cursorLoginWithCancelHint = [
        '  Welcome to Cursor Agent',
        '  Signing in with the browser...',
        '  ❯ 1. Sign in with browser',
        '    2. Sign in with API key',
        '',
        '  Press Enter to sign in · Esc to cancel',
    ].join('\n');

    const grokLoginWithCancelHint = [
        '  Welcome to Grok CLI',
        '  Sign in to Grok Build',
        '  1 (●) Sign in with browser',
        '  2 (○) Paste your xAI API key',
        '',
        '  1/2:select  Esc:cancel',
    ].join('\n');

    const kimiLoginWithCancelHint = [
        '╭──────────────────────────────────────────────────────────╮',
        '│ Sign in to Kimi Code                                     │',
        '│ ❯ 1. Authorize via browser (device code)                 │',
        '│   2. Paste API key                                       │',
        '│                                                          │',
        '│ Esc to cancel                                            │',
        '╰──────────────────────────────────────────────────────────╯',
    ].join('\n');

    const providerLoginMenus: Array<{
        label: string;
        cli: string;
        specFile: string;
        idleFrame: string;
        loginScreen: string;
    }> = [
        {
            label: 'claude-cli Select login method with Esc to cancel',
            cli: 'claude-cli',
            specFile: '4.0.json',
            idleFrame: '────────────────────\r\n❯ \r\n────────────────────\r\n  Opus 4.6 · 12% context\r\n',
            loginScreen: claudeLoginWithEsc,
        },
        {
            label: 'claude-cli Select login method without Esc to cancel',
            cli: 'claude-cli',
            specFile: '4.0.json',
            idleFrame: '────────────────────\r\n❯ \r\n────────────────────\r\n  Opus 4.6 · 12% context\r\n',
            loginScreen: claudeLoginWithoutEsc,
        },
        {
            label: 'codex-cli login menu with enter to submit | esc to cancel',
            cli: 'codex-cli',
            specFile: '4.0.json',
            idleFrame: '› \r\n  gpt-5.4 · 98% context left · ? for shortcuts\r\n',
            loginScreen: codexLoginWithCancelHint,
        },
        {
            label: 'antigravity-cli login menu with Esc to cancel',
            cli: 'antigravity-cli',
            specFile: '4.0.json',
            idleFrame: '❯ Type your message\r\n  ? for shortcuts\r\n',
            loginScreen: agyLoginWithCancelHint,
        },
        {
            label: 'cursor-cli login menu with Esc to cancel',
            cli: 'cursor-cli',
            specFile: '1.0.json',
            idleFrame: '  Cursor Agent\r\n  → Plan, search, build anything\r\n  Auto · 3.2%\r\n  ~/work/repo · main\r\n',
            loginScreen: cursorLoginWithCancelHint,
        },
        {
            label: 'grok-cli login menu with 1/2:select and Esc:cancel',
            cli: 'grok-cli',
            specFile: '1.0.json',
            idleFrame: '  │ ❯ \r\n  Shift+Tab: mode · Ctrl+x: shortcuts\r\n',
            loginScreen: grokLoginWithCancelHint,
        },
        {
            label: 'kimi login menu with Esc to cancel',
            cli: 'kimi',
            specFile: '1.0.json',
            idleFrame: '┌──────────────────────────────────────────┐\r\n│ >                                        │\r\n└──────────────────────────────────────────┘\r\n',
            loginScreen: kimiLoginWithCancelHint,
        },
    ];

    it.each(providerLoginMenus)(
        '$label enters/stays in signing_in, isAnchoredSignInViewport is true, and never transitions to approval',
        ({ cli, specFile, loginScreen }) => {
            const spec = loadProviderSpec(cli, specFile);
            expect(isAnchoredSignInViewport(loginScreen, spec)).toBe(true);

            const fromStarting = evaluateFsm(spec, 'starting', loginScreen, { row: 3, col: 2 }, undefined, clk(2_000, 0));
            expect(fromStarting.fired?.to).toBe('signing_in');

            const fromSigningIn = evaluateFsm(spec, 'signing_in', loginScreen, { row: 3, col: 2 }, undefined, clk(5_000, 0));
            expect(fromSigningIn.fired?.to ?? 'signing_in').toBe('signing_in');

            const fromIdle = evaluateFsm(spec, 'idle', loginScreen, { row: 3, col: 2 }, undefined, clk(5_000, 0));
            expect(fromIdle.fired?.to).not.toBe('approval');
            expect(fromIdle.fired?.to).not.toBe('trust');
            expect(fromIdle.fired?.to).not.toBe('picker');
        },
    );

    it.each(providerLoginMenus)(
        '$label blocks sends on FsmDriver (from starting and from idle) and exposes no approval card or buttons',
        async ({ cli, specFile, idleFrame, loginScreen }) => {
            vi.useFakeTimers();
            try {
                // 1. Boot directly into login menu -> must enter signing_in with no modal card
                const bootFactory = new DrivableFactory();
                const bootDriver = new FsmDriver({
                    specPath: resolveProviderSpecPath(cli, specFile),
                    workingDir: os.tmpdir(),
                    hotReload: false,
                    transportFactory: bootFactory,
                });
                let bootModal: { title?: string; buttons: Array<{ index: number; label: string }> } | null = null;
                bootDriver.subscribe(ev => {
                    if (ev.kind === 'state_changed') bootModal = ev.modal;
                });
                bootDriver.start();
                const bootPty = bootFactory.last!;
                bootPty.feed(loginScreen.replace(/\n/g, '\r\n') + '\r\n');
                await vi.advanceTimersByTimeAsync(1_000);
                expect(bootDriver.currentStateId).toBe('signing_in');
                expect(bootModal).toBeNull();
                bootDriver.shutdown();

                // 2. Reach idle first, then render login menu with cancel hint -> must block send, enter signing_in, and expose no modal card
                const idleFactory = new DrivableFactory();
                const idleDriver = new FsmDriver({
                    specPath: resolveProviderSpecPath(cli, specFile),
                    workingDir: os.tmpdir(),
                    hotReload: false,
                    transportFactory: idleFactory,
                });
                let activeModal: { title?: string; buttons: Array<{ index: number; label: string }> } | null = null;
                idleDriver.subscribe(ev => {
                    if (ev.kind === 'state_changed') activeModal = ev.modal;
                });
                idleDriver.start();
                const idlePty = idleFactory.last!;
                const nonFocusWrites = () => idlePty.writes.filter(w => w !== '\u001b[I');

                idlePty.feed(idleFrame);
                await vi.advanceTimersByTimeAsync(16_000);
                expect(idleDriver.currentStateId).toBe('idle');
                idlePty.writes.length = 0;

                idlePty.feed('\u001b[2J\u001b[H' + loginScreen.replace(/\n/g, '\r\n') + '\r\n');
                await vi.advanceTimersByTimeAsync(400);
                expect(idleDriver.currentStateId).not.toBe('approval');
                expect(activeModal).toBeNull();

                const disp = idleDriver.sendMessageWithDisposition('do not type into login menu', false, `msg-r6-${cli}`);
                await vi.advanceTimersByTimeAsync(500);
                expect(disp).toEqual({
                    status: 'queued',
                    queueDepth: 1,
                    reason: 'auth_required',
                });
                expect(idleDriver.currentStateId).toBe('signing_in');
                expect(activeModal).toBeNull();
                expect(nonFocusWrites()).toEqual([]);

                idleDriver.shutdown();
            } finally {
                vi.useRealTimers();
            }
        },
    );
});

describe('Round 6 — NEW MEDIUM: balanced >40-line fences, balanced fences with composer chrome, and >40-line diff hunks stay suppressed', () => {
    const t0 = 1_860_000_000_000;
    const ctx = { cliType: 'claude-cli', sessionLabel: 'sess-r6-fences', isCoordinator: false };

    // 1. A 45-line balanced fence in tool output (`⏺ Bash(cat docs/auth.md)`) with a quoted 401 JSON at line 44,
    //    plus indented tool lines after the closing fence to verify inToolBlock is preserved across the fence.
    const toolBalanced45LineFence = [
        '⏺ Bash(cat docs/auth.md)',
        '  ⎿  # Authentication Troubleshooting',
        '     ```json',
        ...Array.from({ length: 43 }, (_, i) => `     "line_${i + 1}": "documentation line ${i + 1}",`),
        '     {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
        '     ```',
        '     API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Still inside tool block"}}',
    ].join('\n');

    // 2. A 45-line col-0 balanced fence (codex style) with a 401 at line 44.
    const codexCol0Balanced45LineFence = [
        '• Here is the 45-line example response payload:',
        '```json',
        ...Array.from({ length: 43 }, (_, i) => `{"step": ${i + 1}, "status": "ok"}`),
        'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid API key"}}',
        '```',
    ].join('\n');

    // 3. A balanced fence quoting a composer block (`───`/`❯ `/`───`) followed by a quoted 401.
    const balancedFenceQuotingComposer = [
        '⏺ Example transcript showing an expired session after the composer prompt:',
        '```text',
        '────────────────────',
        '❯ ',
        '────────────────────',
        'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login',
        '```',
    ].join('\n');

    // 4. A diff hunk longer than 40 lines with a quoted 401 near its end.
    const longDiffHunkWith401NearEnd = [
        'diff --git a/src/auth.ts b/src/auth.ts',
        '--- a/src/auth.ts',
        '+++ b/src/auth.ts',
        '@@ -1,45 +1,46 @@',
        ...Array.from({ length: 42 }, (_, i) => ` const line${i + 1} = ${i + 1};`),
        '+// Example: API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
        ' API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
        ' const tailLine = true;',
    ].join('\n');

    it.each([
        ['45-line balanced fence in tool output with quoted 401 JSON at line 44 and trailing indented tool line', toolBalanced45LineFence],
        ['45-line col-0 balanced fence (codex style) with a 401 at line 44', codexCol0Balanced45LineFence],
        ['balanced fence quoting a composer block (───/❯ /───) followed by a quoted 401', balancedFenceQuotingComposer],
        ['diff hunk longer than 40 lines with a quoted 401 near its end', longDiffHunkWith401NearEnd],
    ])('suppresses %s in detectProviderFailure, classifyAuthBillingOutput, and resolveLiveAuthSuspect', (_label, screen) => {
        expect(detectProviderFailure(screen)).toBeNull();
        expect(classifyAuthBillingOutput('claude-cli', screen)).toBeNull();
        expect(classifyAuthBillingOutput('codex-cli', screen)).toBeNull();

        const state = createLiveAuthState();
        state.suspect = {
            failure: { errorReason: 'auth_failed', failureKind: 'auth', message: '401 Unauthorized' },
            suspectedAtMs: t0,
        };
        const res = resolveLiveAuthSuspect(state, ctx, {
            midTurn: true,
            now: t0 + 20_000,
            quietMs: 10_000,
            tail: screen,
            readScreen: () => screen,
        });
        expect(res.advisory).toBeUndefined();
        expect(res.latch).toBeUndefined();
    });

    it('still detects a real 401 after an unclosed fence that exceeds the 40-line cap', () => {
        const unclosed45LineFenceThenReal401 = [
            '```json',
            ...Array.from({ length: 42 }, (_, i) => `{"line": ${i + 1}}`),
            'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
        ].join('\n');
        expect(detectProviderFailure(unclosed45LineFenceThenReal401)?.errorReason).toBe('auth_failed');
    });
});

describe('Round 6 — NEW MEDIUM: ⏺-prefixed assistant prose is never classified as an auth failure unless it carries an API Error 401/authentication_error envelope', () => {
    const t0 = 1_870_000_000_000;
    const ctx = { cliType: 'claude-cli', sessionLabel: 'sess-r6-prose', isCoordinator: false };

    it.each([
        '⏺ Please run /login in the other terminal before retrying…',
        '⏺ Your session expired handling now refreshes the cookie…',
        '⏺ Invalid API key responses are now mapped to a 401…',
    ])('does NOT detect assistant prose line: %s', (line) => {
        expect(detectProviderFailure(line)).toBeNull();
        expect(detectAuthFailureOnlyReply(line)).toBeNull();
        expect(classifyAuthBillingOutput('claude-cli', line)).toBeNull();

        const state = createLiveAuthState();
        state.suspect = {
            failure: { errorReason: 'auth_failed', failureKind: 'auth', message: '401 Unauthorized' },
            suspectedAtMs: t0,
        };
        const res = resolveLiveAuthSuspect(state, ctx, {
            midTurn: false,
            now: t0 + 10_000,
            quietMs: 6_000,
            tail: line,
            readScreen: () => line,
        });
        expect(res.advisory).toBeUndefined();
        expect(res.latch).toBeUndefined();
    });

    it('still detects ⏺ API Error: 401 {…authentication_error…}', () => {
        const realErrorLine = '⏺ API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}';
        expect(detectProviderFailure(realErrorLine)).toMatchObject({
            errorReason: 'auth_failed',
            failureKind: 'auth',
        });
        expect(classifyAuthBillingOutput('claude-cli', realErrorLine)).toMatchObject({
            errorReason: 'auth_failed',
            failureKind: 'auth',
        });
    });
});

describe('Round 7 — LOW classifier findings: balanced fences with ⏺/✻, quadruple-backtick fences, >512-line fences, and wrapped ⏺ prose continuation lines', () => {
    const t0 = 1_880_000_000_000;
    const ctx = { cliType: 'claude-cli', sessionLabel: 'sess-r7-low', isCoordinator: false };

    // 1. A balanced fence containing a quoted ⏺/✻ line must stay suppressed
    const balancedFenceWithQuotedTurnBoundaries = [
        '⏺ Here is an example of a captured Claude session transcript:',
        '```text',
        '⏺ Bash(curl https://example.com)',
        '✻ Worked for 4s',
        '⏺ API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login',
        '```',
    ].join('\n');

    // 2. A quadruple-backtick fence must not be closed by an inner ```
    const quadrupleBacktickFenceWithInnerTripleFence = [
        '⏺ Here is the markdown documentation with an embedded code block:',
        '````markdown',
        '```json',
        '{"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
        '```',
        'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login',
        '````',
    ].join('\n');

    // 3. A fence closed after more than 512 lines must stay suppressed
    const fenceClosedAfterMoreThan512Lines = [
        '⏺ Dumping the full 600-line fixture inside a fenced block:',
        '```json',
        ...Array.from({ length: 560 }, (_, i) => `  "line_${i + 1}": "fixture entry ${i + 1}",`),
        '  "error_sample": "API Error: 401 {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"authentication_error\\",\\"message\\":\\"OAuth token has expired.\\"}} · Please run /login"',
        '  API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login',
        '```',
    ].join('\n');

    // 4. Wrapped ⏺ prose continuation lines ("\n  Please run /login…", "\n  not signed in.") must not be detected
    const wrappedProsePleaseRunLogin = [
        '⏺ Before retrying the request in the other terminal,',
        '  Please run /login to refresh the test fixture.',
    ].join('\n');

    const wrappedProseNotSignedIn = [
        '⏺ The middleware redirects the browser whenever the current user is',
        '  not signed in.',
    ].join('\n');

    const wrappedProseMultiLine = [
        '⏺ In the auth handler, we check whether the token was revoked or the',
        '  session expired before returning the login redirect when the user is',
        '  not signed in.',
    ].join('\n');

    it.each([
        ['balanced fence containing quoted ⏺/✻ and tool header lines', balancedFenceWithQuotedTurnBoundaries],
        ['quadruple-backtick fence containing an inner ``` fence and quoted 401', quadrupleBacktickFenceWithInnerTripleFence],
        ['balanced fence closed after >512 lines (560+ lines)', fenceClosedAfterMoreThan512Lines],
        ['wrapped ⏺ prose continuation "\\n  Please run /login…"', wrappedProsePleaseRunLogin],
        ['wrapped ⏺ prose continuation "\\n  not signed in."', wrappedProseNotSignedIn],
        ['multi-line wrapped ⏺ prose continuation mentioning session expired and not signed in', wrappedProseMultiLine],
    ])('suppresses %s across detectProviderFailure, detectAuthFailureOnlyReply, classifyAuthBillingOutput, and resolveLiveAuthSuspect', (_label, screen) => {
        expect(detectProviderFailure(screen)).toBeNull();
        expect(detectAuthFailureOnlyReply(screen)).toBeNull();
        expect(classifyAuthBillingOutput('claude-cli', screen)).toBeNull();
        expect(classifyAuthBillingOutput('codex-cli', screen)).toBeNull();

        const state = createLiveAuthState();
        state.suspect = {
            failure: { errorReason: 'auth_failed', failureKind: 'auth', message: '401 Unauthorized' },
            suspectedAtMs: t0,
        };
        const res = resolveLiveAuthSuspect(state, ctx, {
            midTurn: false,
            now: t0 + 10_000,
            quietMs: 6_000,
            tail: screen,
            readScreen: () => screen,
        });
        expect(res.advisory).toBeUndefined();
        expect(res.latch).toBeUndefined();
    });
});

describe('Round 8 — MEDIUM-1: real login screens with quoted approval questions above them enter signing_in, block sends, and never expose approval buttons', () => {
    const quotedApprovalAboveLoginCases: Array<{
        label: string;
        cli: string;
        specFile: string;
        idleFrame: string;
        screen: string;
    }> = [
        {
            label: 'codex login menu under ⏺ The tool earlier printed "Would you like to run the following command?"…',
            cli: 'codex-cli',
            specFile: '4.0.json',
            idleFrame: '› \r\n  gpt-5.4 · 98% context left · ? for shortcuts\r\n',
            screen: [
                '⏺ The tool earlier printed "Would you like to run the following command?"…',
                CODEX_SIGNIN_SCREEN,
            ].join('\n'),
        },
        {
            label: 'codex login menu under standalone "  Would you like to run the following command?"',
            cli: 'codex-cli',
            specFile: '4.0.json',
            idleFrame: '› \r\n  gpt-5.4 · 98% context left · ? for shortcuts\r\n',
            screen: [
                '  Would you like to run the following command?',
                CODEX_SIGNIN_SCREEN,
            ].join('\n'),
        },
        {
            label: 'antigravity login menu under standalone "  Allow calling this tool?"',
            cli: 'antigravity-cli',
            specFile: '4.0.json',
            idleFrame: '❯ Type your message\r\n  ? for shortcuts\r\n',
            screen: [
                '  Allow calling this tool?',
                AGY_SIGNIN_SELECTOR_SCREEN,
            ].join('\n'),
        },
        {
            label: 'cursor login menu under standalone "  Run this command?"',
            cli: 'cursor-cli',
            specFile: '1.0.json',
            idleFrame: '  Cursor Agent\r\n  → Plan, search, build anything\r\n  Auto · 3.2%\r\n  ~/work/repo · main\r\n',
            screen: [
                '  Run this command?',
                '  Cursor Agent',
                '  Sign in required',
                '  ❯ 1. Sign in with browser',
                '    2. Use API key',
                '  Enter to confirm · Esc to cancel',
            ].join('\n'),
        },
        {
            label: 'cursor browser sign-in screen under ⏺ The tool earlier printed "Run this command?"…',
            cli: 'cursor-cli',
            specFile: '1.0.json',
            idleFrame: '  Cursor Agent\r\n  → Plan, search, build anything\r\n  Auto · 3.2%\r\n  ~/work/repo · main\r\n',
            screen: [
                '⏺ The tool earlier printed "Run this command?"…',
                CURSOR_BROWSER_LOGIN_SUBSCREEN,
            ].join('\n'),
        },
        {
            label: 'grok API-key sign-in screen under ⏺ The tool earlier printed "Do you want to proceed?"…',
            cli: 'grok-cli',
            specFile: '1.0.json',
            idleFrame: '  │ ❯ \r\n  Shift+Tab: mode · Ctrl+x: shortcuts\r\n',
            screen: [
                '⏺ The tool earlier printed "Do you want to proceed?"…',
                GROK_SIGNIN_SCREEN,
            ].join('\n'),
        },
        {
            label: 'grok browser approval login screen under standalone "  Run this command?"',
            cli: 'grok-cli',
            specFile: '1.0.json',
            idleFrame: '  │ ❯ \r\n  Shift+Tab: mode · Ctrl+x: shortcuts\r\n',
            screen: [
                '  Run this command?',
                GROK_BROWSER_APPROVAL_SUBSCREEN,
            ].join('\n'),
        },
        {
            label: 'kimi login menu under standalone "  ▶ Run command?"',
            cli: 'kimi',
            specFile: '1.0.json',
            idleFrame: '┌──────────────────────────────────────────┐\r\n│ >                                        │\r\n└──────────────────────────────────────────┘\r\n',
            screen: [
                '  ▶ Run command?',
                '╭──────────────────────────────────────────────────────────╮',
                '│ Sign in to Kimi Code                                     │',
                '│ ❯ 1. Authorize via browser (device code)                 │',
                '│   2. Paste API key                                       │',
                '│ Esc to cancel                                            │',
                '╰──────────────────────────────────────────────────────────╯',
            ].join('\n'),
        },
        {
            label: 'kimi device-code screen under ⏺ The tool earlier printed "▶ Run command?"…',
            cli: 'kimi',
            specFile: '1.0.json',
            idleFrame: '┌──────────────────────────────────────────┐\r\n│ >                                        │\r\n└──────────────────────────────────────────┘\r\n',
            screen: [
                '⏺ The tool earlier printed "▶ Run command?"…',
                KIMI_SIGNIN_DEVICE_CODE_SCREEN,
            ].join('\n'),
        },
        {
            label: 'claude login menu under standalone "  Do you want to proceed?"',
            cli: 'claude-cli',
            specFile: '4.0.json',
            idleFrame: '────────────────────\r\n❯ \r\n────────────────────\r\n  Opus 4.6 · 12% context\r\n',
            screen: [
                '  Do you want to proceed?',
                CLAUDE_SIGNIN_SCREEN,
            ].join('\n'),
        },
    ];

    it.each(quotedApprovalAboveLoginCases)(
        '$label transitions to signing_in from starting/idle/busy, sets pre-send guard true, and blocks FsmDriver sends without modal buttons',
        async ({ cli, specFile, idleFrame, screen }) => {
            const spec = loadProviderSpec(cli, specFile);
            expect(isAnchoredSignInViewport(screen, spec), 'isAnchoredSignInViewport').toBe(true);

            for (const from of ['starting', 'idle', 'busy'] as const) {
                const res = evaluateFsm(spec, from, screen, { row: 4, col: 2 }, undefined, clk(5_000, 0));
                expect(res.fired?.to, `from ${from}`).toBe('signing_in');
            }
            const fromSigningIn = evaluateFsm(spec, 'signing_in', screen, { row: 4, col: 2 }, undefined, clk(5_000, 0));
            expect(fromSigningIn.fired?.to ?? 'signing_in', 'from signing_in').toBe('signing_in');

            vi.useFakeTimers();
            try {
                const factory = new DrivableFactory();
                const driver = new FsmDriver({
                    specPath: resolveProviderSpecPath(cli, specFile),
                    workingDir: os.tmpdir(),
                    hotReload: false,
                    transportFactory: factory,
                });
                let activeModal: { title?: string; buttons: Array<{ index: number; label: string }> } | null = null;
                driver.subscribe(ev => {
                    if (ev.kind === 'state_changed') activeModal = ev.modal;
                });
                driver.start();
                const pty = factory.last!;
                const nonFocusWrites = () => pty.writes.filter(w => w !== '\u001b[I');

                pty.feed(idleFrame);
                await vi.advanceTimersByTimeAsync(16_000);
                expect(driver.currentStateId).toBe('idle');
                pty.writes.length = 0;

                pty.feed('\u001b[2J\u001b[H' + screen.replace(/\n/g, '\r\n') + '\r\n');
                await vi.advanceTimersByTimeAsync(400);
                expect(driver.currentStateId).toBe('signing_in');
                expect(activeModal).toBeNull();

                const disp = driver.sendMessageWithDisposition('secret prompt must not enter login field', false, `msg-r8-m1-${cli}`);
                await vi.advanceTimersByTimeAsync(500);
                expect(disp).toEqual({
                    status: 'queued',
                    queueDepth: 1,
                    reason: 'auth_required',
                });
                expect(driver.currentStateId).toBe('signing_in');
                expect(activeModal).toBeNull();
                expect(nonFocusWrites()).toEqual([]);

                driver.shutdown();
            } finally {
                vi.useRealTimers();
            }
        },
    );
});

describe('Round 8 — MEDIUM-2: cursor and grok idle workers with quoted login menus ending in Esc to cancel / Esc:cancel stay idle and never stick or flap busy', () => {
    const cursorQuotedLoginMenuIdle = [
        '  Welcome to Cursor Agent',
        '  1. Sign in with browser',
        '  2. Use API key',
        '  Esc to cancel',
        '',
        '  Claude 4.5 Sonnet · 18.1%',
        '  ~/work/app · main',
    ].join('\n');

    const grokQuotedLoginMenuIdle = [
        '  Welcome to Grok CLI',
        '  1 (●) Sign in with browser (xAI account)',
        '  2 (○) Paste your xAI API key',
        '  1/2:select │ Enter:confirm',
        '  Esc:cancel',
        '  ╭──────────────────────────────────────────────────────────────────────────╮',
        '  │ ❯                                                                        │',
        '  ╰──────────────────────────────────────────────────────────────────────────╯',
        '  Shift+Tab:mode │ Ctrl+x:shortcuts',
    ].join('\n');

    it('cursor-cli and grok-cli stay idle from idle and transition busy → idle without sticking or flapping when a login menu with Esc cancel hint is quoted above the settled composer', async () => {
        const cursorSpec = loadProviderSpec('cursor-cli', '1.0.json');
        expect(evaluateFsm(cursorSpec, 'idle', cursorQuotedLoginMenuIdle, { row: 6, col: 2 }, undefined, clk(5_000, 0)).fired).toBeNull();
        expect(evaluateFsm(cursorSpec, 'busy', cursorQuotedLoginMenuIdle, { row: 6, col: 2 }, undefined, clk(5_000, 0)).fired?.to).toBe('idle');

        const grokSpec = loadProviderSpec('grok-cli', '1.0.json');
        expect(evaluateFsm(grokSpec, 'idle', grokQuotedLoginMenuIdle, { row: 8, col: 2 }, undefined, clk(5_000, 0)).fired).toBeNull();
        expect(evaluateFsm(grokSpec, 'busy', grokQuotedLoginMenuIdle, { row: 8, col: 2 }, undefined, clk(5_000, 0)).fired?.to).toBe('idle');

        vi.useFakeTimers();
        try {
            for (const tc of [
                {
                    cli: 'cursor-cli',
                    specFile: '1.0.json',
                    busyFrame: '  ⠙ Generating… ctrl+c to stop\r\n',
                    settledIdleFrame: cursorQuotedLoginMenuIdle,
                },
                {
                    cli: 'grok-cli',
                    specFile: '1.0.json',
                    busyFrame: '  ⠋ Reading file 2.4s [stop]\r\n  Esc:cancel\r\n',
                    settledIdleFrame: grokQuotedLoginMenuIdle,
                },
            ]) {
                const factory = new DrivableFactory();
                const driver = new FsmDriver({
                    specPath: resolveProviderSpecPath(tc.cli, tc.specFile),
                    workingDir: os.tmpdir(),
                    hotReload: false,
                    transportFactory: factory,
                });
                const states: string[] = [];
                driver.subscribe(ev => {
                    if (ev.kind === 'state_changed') states.push(ev.state.id);
                });
                driver.start();
                const pty = factory.last!;

                pty.feed(tc.busyFrame);
                await vi.advanceTimersByTimeAsync(1_000);
                expect(driver.currentStateId, `${tc.cli} entered busy`).toBe('busy');

                states.length = 0;
                pty.feed('\u001b[2J\u001b[H' + tc.settledIdleFrame.replace(/\n/g, '\r\n') + '\r\n');
                await vi.advanceTimersByTimeAsync(5_000);

                expect(driver.currentStateId, `${tc.cli} settled to idle`).toBe('idle');
                expect(states, `${tc.cli} transitioned once to idle without flapping`).toEqual(['idle']);

                driver.shutdown();
            }
        } finally {
            vi.useRealTimers();
        }
    });
});






