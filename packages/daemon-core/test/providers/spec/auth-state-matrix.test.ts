/**
 * Cross-Provider Auth & State-Classification Matrix Gate.
 *
 * Permanent regression gate covering all 6 TUI providers:
 *   - claude-cli
 *   - codex-cli
 *   - antigravity-cli
 *   - cursor-cli
 *   - grok-cli
 *   - kimi
 *
 * Screens per provider:
 *   (a) every real login/sign-in sub-screen, with and without cancel/select hints;
 *   (b) every real approval/permission modal: tool/command approvals, edit/patch,
 *       MCP approvals, trust-folder;
 *   (c) pickers (AskUserQuestion / numbered selects);
 *   (d) a busy/streaming turn, including spinners with verbs other than
 *       Generating/Running/Thinking (e.g. Reading file / Editing / Searching);
 *   (e) idle composer.
 *
 * Variants for each of (b), (c), and (d):
 *   - clean (baseline)
 *   - login text QUOTED inside the body
 *   - login text quoted ABOVE the question
 *   - login text quoted in earlier transcript within the viewport
 *   - login text quoted in status_tail
 *
 * Assertions per case:
 *   - FSM state from starting / idle / busy / signing_in
 *   - preSendGuard (isAnchoredSignInViewport)
 *   - modal/approval card (deriveModal)
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { evaluateFsm, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';
import { resolveSections } from '../../../src/providers/spec/evaluator.js';
import { deriveModal } from '../../../src/providers/spec/fsm-driver-modal.js';
import { isAnchoredSignInViewport } from '../../../src/providers/spec/send-submit-engine.js';
import { detectKimiIdleSelectorPrompt } from '../../../src/providers/kimi-pending-question.js';
import type { CliSpecV4, FsmState } from '../../../src/providers/spec/fsm-types.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../../../..');

type ProviderId = 'claude-cli' | 'codex-cli' | 'antigravity-cli' | 'cursor-cli' | 'grok-cli' | 'kimi';

const SPEC_FILES: Record<ProviderId, string> = {
    'claude-cli': '4.0.json',
    'codex-cli': '4.0.json',
    'antigravity-cli': '4.0.json',
    'cursor-cli': '1.0.json',
    'grok-cli': '1.0.json',
    'kimi': '1.0.json',
};

const specCache = new Map<ProviderId, CliSpecV4>();

function loadSpec(provider: ProviderId): CliSpecV4 {
    const cached = specCache.get(provider);
    if (cached) return cached;
    const specFile = SPEC_FILES[provider];
    const candidates = [
        path.join(REPO_ROOT, 'adhdev-providers/cli', provider, 'specs', specFile),
        path.join(process.env.HOME ?? '', '.adhdev/providers/.upstream/cli', provider, 'specs', specFile),
    ];
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) throw new Error(`${provider} ${specFile} not found in ${candidates.join(', ')}`);
    const raw = JSON.parse(fs.readFileSync(found, 'utf8'));
    const errs = validateFsmSpec(raw);
    if (errs.length) throw new Error(`${provider}: ${errs.join('; ')}`);
    const spec = raw as CliSpecV4;
    specCache.set(provider, spec);
    return spec;
}

function readFixture(name: string): string {
    return fs.readFileSync(path.join(TEST_DIR, 'fixtures', name), 'utf8').replace(/\n$/, '');
}

function clk(now = 20_000, entered = 0): FsmClock {
    return { now, stateEnteredAt: entered, regionLastChangedAt: new Map() };
}

function stateOf(spec: CliSpecV4, id: string): FsmState {
    const st = spec.states.find(s => s.id === id);
    if (!st) throw new Error(`State ${id} not found in ${spec.id}`);
    return st;
}

function effectiveStateFrom(spec: CliSpecV4, from: string, screen: string, now = 20_000): string {
    const lines = screen.split('\n');
    const cursor = { row: Math.max(0, lines.length - 1), col: 2 };
    const ev = evaluateFsm(spec, from, screen, cursor, undefined, clk(now, 0));
    const next = ev.fired ? ev.fired.to : from;
    if (from === 'starting' && next === 'idle') {
        const afterGrace = evaluateFsm(spec, 'idle', screen, cursor, undefined, clk(now, 0));
        if (afterGrace.fired) return afterGrace.fired.to;
    }
    return next;
}

export type MatrixCategory = 'a_login' | 'b_approval' | 'c_picker' | 'd_busy' | 'e_idle';
export type QuoteVariant = 'clean' | 'quoted_in_body' | 'quoted_above_question' | 'quoted_in_viewport_transcript' | 'quoted_in_status_tail';

export interface MatrixCase {
    provider: ProviderId;
    category: MatrixCategory;
    variant: QuoteVariant;
    name: string;
    screen: string;
    expectedState: string;
    expectedPreSendGuard: boolean;
    expectedModalButtons: boolean;
    kimiIdleSelector?: boolean;
}

// Representative login lines per provider that previously triggered false vetoes or false signing_in
const PROVIDER_LOGIN_QUOTES: Record<ProviderId, string[]> = {
    'claude-cli': [
        '  Select login method:',
        '  ❯ 1. Claude account with subscription',
        '  How do you want to sign in?',
        '  Opening browser to sign in…',
        "  Browser didn't open? Use the url below to sign in",
        '  Paste code here if prompted > ',
    ],
    'codex-cli': [
        '  Sign in with ChatGPT to use Codex as part of your paid plan',
        '  › 1. Sign in with ChatGPT',
        '    2. Sign in with Device Code',
        '    3. Provide your own API key',
        '  Finish signing in via your browser',
        '  Use your own OpenAI API key',
    ],
    'antigravity-cli': [
        '  You are currently not signed in.',
        '  Select Google Cloud sign-in method:',
        '  Authentication required. Please visit the URL to log in:',
        '  https://accounts.google.com/o/oauth2/auth?client_id=test',
        '  If you aren\'t automatically redirected, paste the authorization code below:',
        '  Signing in to your Google account...',
    ],
    'cursor-cli': [
        '  Welcome to Cursor Agent',
        '  ▸ Press Enter to sign in',
        '  Signing in with the browser',
        "  If your browser didn't open, click this link to log in:",
        '  Press q to show a QR code to log in',
    ],
    'grok-cli': [
        '  Sign in to Grok Build',
        '  Approve in your browser, then rerun or continue here.',
        '  Waiting for approval...',
        '  Paste your xAI API key to continue:',
        '  Enter your API key in .env first.',
    ],
    'kimi': [
        '  Sign in to Kimi Code',
        '  Visit the URL below in your browser to authorize:',
        '  Verification code: ABCD-1234',
        '  ⠋ Waiting for authorization…',
        '  Your key will be saved to ~/.kimi/config.toml',
    ],
};

interface ScreenTemplate {
    provider: ProviderId;
    category: 'b_approval' | 'c_picker' | 'd_busy';
    name: string;
    expectedState: string;
    expectedModalButtons: boolean;
    kimiIdleSelector?: boolean;
    /** Lines before the question/spinner landmark (transcript/header) */
    preamble: string[];
    /** The question/header line(s) of the modal/picker/spinner */
    header: string[];
    /** Body/detail lines between the header and the interactive controls/footer */
    body: string[];
    /** The interactive controls / button rows / footer at the bottom of the screen */
    controlsAndFooter: string[];
}

function buildVariantsFromTemplate(t: ScreenTemplate): MatrixCase[] {
    const quoteLines = PROVIDER_LOGIN_QUOTES[t.provider];
    const primaryQuote = quoteLines[0];
    const secondaryQuote = quoteLines[1] ?? quoteLines[0];

    const assemble = (preamble: string[], header: string[], body: string[], controls: string[]) =>
        [...preamble, ...header, ...body, ...controls].join('\n');

    return [
        {
            provider: t.provider,
            category: t.category,
            variant: 'clean',
            name: `${t.name} [clean]`,
            screen: assemble(t.preamble, t.header, t.body, t.controlsAndFooter),
            expectedState: t.expectedState,
            expectedPreSendGuard: false,
            expectedModalButtons: t.expectedModalButtons,
            kimiIdleSelector: t.kimiIdleSelector,
        },
        {
            provider: t.provider,
            category: t.category,
            variant: 'quoted_in_body',
            name: `${t.name} [login text quoted inside body]`,
            screen: assemble(
                t.preamble,
                t.header,
                [...t.body, primaryQuote, secondaryQuote],
                t.controlsAndFooter,
            ),
            expectedState: t.expectedState,
            expectedPreSendGuard: false,
            expectedModalButtons: t.expectedModalButtons,
            kimiIdleSelector: t.kimiIdleSelector,
        },
        {
            provider: t.provider,
            category: t.category,
            variant: 'quoted_above_question',
            name: `${t.name} [login text quoted above question]`,
            screen: assemble(
                [...t.preamble, primaryQuote, secondaryQuote],
                t.header,
                t.body,
                t.controlsAndFooter,
            ),
            expectedState: t.expectedState,
            expectedPreSendGuard: false,
            expectedModalButtons: t.expectedModalButtons,
            kimiIdleSelector: t.kimiIdleSelector,
        },
        {
            provider: t.provider,
            category: t.category,
            variant: 'quoted_in_viewport_transcript',
            name: `${t.name} [login text quoted in earlier viewport transcript]`,
            screen: assemble(
                [
                    '  • Earlier transcript in viewport:',
                    ...quoteLines.slice(0, 3),
                    '',
                    ...t.preamble,
                ],
                t.header,
                t.body,
                t.controlsAndFooter,
            ),
            expectedState: t.expectedState,
            expectedPreSendGuard: false,
            expectedModalButtons: t.expectedModalButtons,
            kimiIdleSelector: t.kimiIdleSelector,
        },
        {
            provider: t.provider,
            category: t.category,
            variant: 'quoted_in_status_tail',
            name: `${t.name} [login text quoted in status_tail]`,
            screen: assemble(
                t.preamble,
                [primaryQuote, ...t.header],
                t.body,
                t.controlsAndFooter,
            ),
            expectedState: t.expectedState,
            expectedPreSendGuard: false,
            expectedModalButtons: t.expectedModalButtons,
            kimiIdleSelector: t.kimiIdleSelector,
        },
    ];
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) LOGIN / SIGN-IN SUB-SCREENS (with and without cancel/select hints)
// ─────────────────────────────────────────────────────────────────────────────
const LOGIN_CASES: MatrixCase[] = [
    // claude-cli
    {
        provider: 'claude-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'claude login method selector (no cancel hint)',
        screen: [
            ' ▐▛███▜▌   Claude Code v2.1.309',
            '',
            '  Select login method:',
            '  ❯ 1. Claude account with subscription',
            '    2. Anthropic Console account',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
    {
        provider: 'claude-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'claude login method selector (with Enter to confirm · Esc to cancel)',
        screen: [
            ' ▐▛███▜▌   Claude Code v2.1.309',
            '',
            '  Select login method:',
            '  ❯ 1. Claude account with subscription',
            '    2. Anthropic Console account',
            '',
            '  Enter to confirm · Esc to cancel',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
    {
        provider: 'claude-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'claude Console account sub-screen (with Esc to cancel)',
        screen: [
            '  Anthropic Console account',
            '  How do you want to sign in?',
            '  ❯ 1. Sign in with your Console account',
            '    2. Enter API key',
            '',
            '  Esc to cancel',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
    {
        provider: 'claude-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'claude Opening browser to sign in sub-screen',
        screen: [
            '  Welcome to Claude Code',
            '  Opening browser to sign in…',
            '  Press Esc to cancel',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
    {
        provider: 'claude-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'claude OAuth paste-code sub-screen',
        screen: [
            "  Browser didn't open? Use the url below to sign in",
            '  https://claude.ai/oauth/authorize?client_id=REDACTED&response_type=code',
            '',
            '  Paste code here if prompted > ',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
    {
        provider: 'claude-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'claude Cloud gateway sign-in sub-screen',
        screen: [
            '  Cloud gateway · sign in',
            "  Browser didn't open? Visit:",
            '  https://gateway.example.com/oauth/login?code=1234',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },

    // codex-cli
    {
        provider: 'codex-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'codex Sign in with ChatGPT selector (no cancel hint)',
        screen: [
            '  Sign in with ChatGPT to use Codex as part of your paid plan',
            '  or connect an API key for usage-based billing',
            '',
            '  › 1. Sign in with ChatGPT',
            '    2. Sign in with Device Code',
            '    3. Provide your own API key',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
    {
        provider: 'codex-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'codex Sign in with ChatGPT selector (with Esc to cancel)',
        screen: [
            '  Sign in with ChatGPT to use Codex as part of your paid plan',
            '  › 1. Sign in with ChatGPT',
            '    2. Sign in with Device Code',
            '    3. Provide your own API key',
            '',
            '  Press Enter to select · Esc to cancel',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
    {
        provider: 'codex-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'codex Sign in with ChatGPT selector (with enter to submit | esc to cancel)',
        screen: [
            '  Sign in with ChatGPT to use Codex',
            '',
            '  › 1. Sign in with ChatGPT',
            '    2. Sign in with Device Code',
            '    3. Provide your own API key',
            '',
            '  enter to submit | esc to cancel',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
    {
        provider: 'codex-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'codex Finish signing in via your browser sub-screen',
        screen: [
            '  Finish signing in via your browser',
            "  If the link doesn't open automatically, open the following URL:",
            '  http://localhost:1455/auth/callback',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
    {
        provider: 'codex-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'codex Preparing device code login sub-screen',
        screen: '  Preparing device code login...',
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
    {
        provider: 'codex-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'codex API key input box sub-screen',
        screen: [
            '  Use your own OpenAI API key for usage-based billing',
            '  Paste or type your API key below. It will be stored locally in auth.json.',
            '  ╭──────────────────────────────────────────────────╮',
            '  │ >                                                │',
            '  ╰──────────────────────────────────────────────────╯',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
    {
        provider: 'codex-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'codex API key login is disabled sub-screen',
        screen: [
            '  Use your own OpenAI API key',
            '  >API key login is disabled.',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },

    // antigravity-cli
    {
        provider: 'antigravity-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'agy sign-in method selector (no cancel hint)',
        screen: [
            '  Welcome back! You are currently not signed in.',
            '  Select Google Cloud sign-in method:',
            '  ❯ 1. Sign in with Google (OAuth)',
            '    2. Use Gemini API key',
            '    3. Vertex AI (ADC)',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
    {
        provider: 'antigravity-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'agy sign-in method selector (with 4. Cancel and Esc to cancel)',
        screen: [
            '  You are currently not signed in.',
            '  Select Google Cloud sign-in method:',
            '  ❯ 1. Sign in with Google',
            '    2. Use Gemini API key',
            '    3. Vertex AI',
            '    4. Cancel',
            '',
            '  Esc to cancel',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
    {
        provider: 'antigravity-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'agy OAuth URL and paste authorization code sub-screen',
        screen: [
            '  Authentication required. Please visit the URL to log in:',
            '  https://accounts.google.com/o/oauth2/auth?client_id=123&response_type=code',
            '',
            "  If you aren't automatically redirected, paste the authorization code below:",
            '  > ',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
    {
        provider: 'antigravity-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'agy Signing in to your Google account startup sub-screen',
        screen: [
            '  Antigravity CLI',
            '  Signing in to your Google account...',
            '  Please wait...',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },

    // cursor-cli
    {
        provider: 'cursor-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'cursor Press Enter to sign in (no cancel hint)',
        screen: [
            '  Cursor Agent v0.45.0',
            '  Welcome to Cursor Agent',
            '',
            '  ▸ Press Enter to sign in',
            '  (opens browser to authenticate with your Cursor account)',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
    {
        provider: 'cursor-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'cursor Press Enter to sign in (with numbered options and Esc to cancel)',
        screen: [
            '  Welcome to Cursor Agent',
            '  ▸ Press Enter to sign in',
            '    1. Sign in with browser',
            '    2. Use API key',
            '  Esc to cancel',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
    {
        provider: 'cursor-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'cursor Signing in with the browser menu (with Press Enter to sign in · Esc to cancel)',
        screen: [
            '  Welcome to Cursor Agent',
            '  Signing in with the browser...',
            '  ❯ 1. Sign in with browser',
            '    2. Sign in with API key',
            '',
            '  Press Enter to sign in · Esc to cancel',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
    {
        provider: 'cursor-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'cursor Signing in with the browser / QR code sub-screen',
        screen: [
            '  Signing in with the browser',
            "  If your browser didn't open, click this link to log in:",
            '  https://cursor.com/loginDeepControl?code=xyz',
            '  Press q to show a QR code to log in',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },

    // grok-cli
    {
        provider: 'grok-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'grok browser sign-in wait screen (no cancel hint)',
        screen: [
            '  Sign in to Grok Build',
            '  Approve in your browser, then rerun or continue here.',
            '  Waiting for approval...',
            '',
            '  Grok Build 1.0.4 [stable]',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
    {
        provider: 'grok-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'grok sign-in menu (with numbered options and Esc:cancel)',
        screen: [
            '  Sign in to Grok Build',
            '  Approve in your browser, then rerun or continue here.',
            '  1. Sign in with browser',
            '  2. Paste your xAI API key',
            '  Esc:cancel',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
    {
        provider: 'grok-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'grok sign-in menu (with radio rows 1 (●) / 2 (○) and 1/2:select Esc:cancel)',
        screen: [
            '  Welcome to Grok CLI',
            '  Sign in to Grok Build',
            '  1 (●) Sign in with browser',
            '  2 (○) Paste your xAI API key',
            '',
            '  1/2:select  Esc:cancel',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
    {
        provider: 'grok-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'grok Paste your xAI API key sub-screen',
        screen: [
            '  Welcome to Grok CLI',
            '  Paste your xAI API key to continue:',
            '  > ',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
    {
        provider: 'grok-cli',
        category: 'a_login',
        variant: 'clean',
        name: 'grok Enter your xAI API key sub-screen',
        screen: [
            '  Enter your xAI API key:',
            '  > ',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },

    // kimi
    {
        provider: 'kimi',
        category: 'a_login',
        variant: 'clean',
        name: 'kimi DeviceCodeBoxComponent OAuth screen (with Press Ctrl-C to cancel)',
        screen: [
            '  ╭──────────────────────────────────────────────────────────╮',
            '  │  Sign in to Kimi Code                                    │',
            '  │  Visit the URL below in your browser to authorize:       │',
            '  │  https://kimi.com/oauth/device?user_code=ABCD-1234       │',
            '  │  Verification code:  ABCD-1234                           │',
            '  │  Press Ctrl-C to cancel                                  │',
            '  ╰──────────────────────────────────────────────────────────╯',
            '  ⠋ Waiting for authorization…',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
    {
        provider: 'kimi',
        category: 'a_login',
        variant: 'clean',
        name: 'kimi sign-in menu (with numbered options and Esc to cancel)',
        screen: [
            '  Sign in to Kimi Code',
            '  Visit the URL below in your browser to authorize:',
            '  ❯ 1. Log in with browser (OAuth)',
            '    2. Enter API key manually',
            '  Esc to cancel',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
    {
        provider: 'kimi',
        category: 'a_login',
        variant: 'clean',
        name: 'kimi API key save config.toml sub-screen',
        screen: [
            '  Sign in to Kimi Code',
            '  Your key will be saved to ~/.kimi/config.toml',
            '  API Key: ',
        ].join('\n'),
        expectedState: 'signing_in',
        expectedPreSendGuard: true,
        expectedModalButtons: false,
    },
];

// ─────────────────────────────────────────────────────────────────────────────
// (b) APPROVAL / PERMISSION MODALS + (c) PICKERS + (d) BUSY TURNS TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────
const TEMPLATES: ScreenTemplate[] = [
    // ── claude-cli (b) approvals ──
    {
        provider: 'claude-cli',
        category: 'b_approval',
        name: 'claude Bash command approval (divider-based)',
        expectedState: 'approval',
        expectedModalButtons: true,
        preamble: [
            ' ▐▛███▜▌   Claude Code v2.1.302',
            '▝▜█████▛▘  Opus 4.6 with medium effort · Claude Max',
            '  ▘▘ ▝▝    /tmp/adhdev-capture-claude/ws',
        ],
        header: [
            '────────────────────────────────────────────────────────────────────────────────',
            ' Bash command',
        ],
        body: [
            '   git status --short',
            ' Do you want to proceed?',
        ],
        controlsAndFooter: [
            ' ❯ 1. Yes',
            '   2. No, and tell Claude what to do differently (esc)',
            '',
            ' Esc to cancel · Tab to amend',
        ],
    },
    {
        provider: 'claude-cli',
        category: 'b_approval',
        name: 'claude Edit file patch approval',
        expectedState: 'approval',
        expectedModalButtons: true,
        preamble: [
            ' ▐▛███▜▌   Claude Code v2.1.302',
            '⏺ I will update the auth handler.',
        ],
        header: [
            '────────────────────────────────────────────────────────────────────────────────',
            ' Edit file src/auth.ts',
        ],
        body: [
            '   @@ -10,3 +10,4 @@',
            '   +const signedIn = true;',
            ' Do you want to make this edit to src/auth.ts?',
        ],
        controlsAndFooter: [
            ' ❯ 1. Yes',
            '   2. Yes, allow all edits during this session (shift+tab)',
            '   3. No',
            ' Esc to cancel',
        ],
    },
    {
        provider: 'claude-cli',
        category: 'b_approval',
        name: 'claude MCP tool approval',
        expectedState: 'approval',
        expectedModalButtons: true,
        preamble: [
            ' ▐▛███▜▌   Claude Code v2.1.302',
        ],
        header: [
            '────────────────────────────────────────────────────────────────────────────────',
            ' Tool use: adhdev-mesh / report_completion',
        ],
        body: [
            '   {"outcome":"completed"}',
            ' Do you want to proceed?',
        ],
        controlsAndFooter: [
            ' ❯ 1. Yes',
            "   2. Yes, and don't ask again for adhdev-mesh",
            '   3. No',
            ' Esc to cancel',
        ],
    },
    {
        provider: 'claude-cli',
        category: 'b_approval',
        name: 'claude folder-trust dialog (unnumbered cursor list)',
        expectedState: 'trust',
        expectedModalButtons: true,
        preamble: [
            '────────────────────────────────────────────────────────────────────────────────',
        ],
        header: [
            ' Accessing workspace:',
        ],
        body: [
            ' /tmp/adhdev-capture-claude/ws',
            ' Quick safety check: Is this a project you created or one you trust?',
            ' Security guide',
        ],
        controlsAndFooter: [
            ' ❯ No, exit',
            '   Yes, I trust this folder',
            '',
            ' Enter to confirm · Esc to cancel',
        ],
    },

    // ── claude-cli (c) pickers ──
    {
        provider: 'claude-cli',
        category: 'c_picker',
        name: 'claude AskUserQuestion picker (rc.19 footer)',
        expectedState: 'picker',
        expectedModalButtons: true,
        preamble: [
            ' ▐▛███▜▌   Claude Code v2.1.302',
            '⏺ One gate remains before the canary ships.',
        ],
        header: [
            '────────────────────────────────────────────────────────────────────────────────',
            ' ☐ Canary gate',
        ],
        body: [
            ' Which rollout strategy should we use?',
        ],
        controlsAndFooter: [
            ' ❯ 1. Continue with staged rollout',
            '   2. Abort rollout',
            '   3. Type something.',
            '   4. Chat about this',
            '',
            ' Enter to select · ↑/↓ to navigate',
        ],
    },
    {
        provider: 'claude-cli',
        category: 'c_picker',
        name: 'claude /model picker',
        expectedState: 'picker',
        expectedModalButtons: true,
        preamble: [
            ' ▐▛███▜▌   Claude Code v2.1.302',
        ],
        header: [
            '────────────────────────────────────────────────────────────────────────────────',
            ' Select a model',
        ],
        body: [
            ' Switch between Claude models for this session',
        ],
        controlsAndFooter: [
            ' ❯ 1. claude-sonnet-4-6',
            '   2. claude-opus-4-6',
            ' Enter to select · Esc to cancel',
        ],
    },

    // ── claude-cli (d) busy turns ──
    {
        provider: 'claude-cli',
        category: 'd_busy',
        name: 'claude streaming turn with Reading file spinner verb',
        expectedState: 'busy',
        expectedModalButtons: false,
        preamble: [
            ' ▐▛███▜▌   Claude Code v2.1.302',
        ],
        header: [
            '⏺ Inspecting authentication flow.',
        ],
        body: [
            '  ⎿  Read 120 lines',
        ],
        controlsAndFooter: [
            '⠋ Reading file src/auth.ts… (4s · ↑ 1.2k tokens)',
            '────────────────────────────────────────────────────────────────────────────────',
            '❯ ',
            '────────────────────────────────────────────────────────────────────────────────',
            '  esc to interrupt · ctrl+t to hide tasks',
        ],
    },
    {
        provider: 'claude-cli',
        category: 'd_busy',
        name: 'claude streaming turn with Editing spinner verb',
        expectedState: 'busy',
        expectedModalButtons: false,
        preamble: [
            ' ▐▛███▜▌   Claude Code v2.1.302',
        ],
        header: [
            '⏺ Updating spec definitions.',
        ],
        body: [],
        controlsAndFooter: [
            '⠹ Editing src/providers/spec/fsm-evaluator.ts… (7s)',
            '────────────────────────────────────────────────────────────────────────────────',
            '❯ ',
            '────────────────────────────────────────────────────────────────────────────────',
            '  ⏸ manual mode on',
        ],
    },

    // ── codex-cli (b) approvals ──
    {
        provider: 'codex-cli',
        category: 'b_approval',
        name: 'codex command approval (Would you like to run the following command?)',
        expectedState: 'approval',
        expectedModalButtons: true,
        preamble: [
            '╭───────────────────────────────────────────────╮',
            '│ >_ OpenAI Codex (v0.162.1)                    │',
            '╰───────────────────────────────────────────────╯',
        ],
        header: [
            '  Would you like to run the following command?',
        ],
        body: [
            '  $ git status --short',
        ],
        controlsAndFooter: [
            '  › 1. Yes, proceed (y)',
            '    2. No, and tell Codex what to do differently (esc)',
            '',
            '  enter to submit | esc to cancel',
        ],
    },
    {
        provider: 'codex-cli',
        category: 'b_approval',
        name: 'codex edit/patch approval (Would you like to make the following edits?)',
        expectedState: 'approval',
        expectedModalButtons: true,
        preamble: [
            '╭───────────────────────────────────────────────╮',
            '│ >_ OpenAI Codex (v0.162.1)                    │',
            '╰───────────────────────────────────────────────╯',
        ],
        header: [
            '  Would you like to make the following edits?',
        ],
        body: [
            '  src/auth/login.ts',
            '  + export const authReady = true;',
        ],
        controlsAndFooter: [
            '  › 1. Yes, apply edits (y)',
            '    2. No, reject edits (esc)',
            '',
            '  Press enter to confirm or esc to cancel',
        ],
    },
    {
        provider: 'codex-cli',
        category: 'b_approval',
        name: 'codex permissions approval (Would you like to grant these permissions?)',
        expectedState: 'approval',
        expectedModalButtons: true,
        preamble: [
            '╭───────────────────────────────────────────────╮',
            '│ >_ OpenAI Codex (v0.162.1)                    │',
            '╰───────────────────────────────────────────────╯',
        ],
        header: [
            '  Would you like to grant these permissions?',
        ],
        body: [
            '  network: https://api.openai.com',
        ],
        controlsAndFooter: [
            '  › 1. Yes, grant permissions (y)',
            '    2. No, deny (esc)',
            '',
            '  enter to submit | esc to cancel',
        ],
    },
    {
        provider: 'codex-cli',
        category: 'b_approval',
        name: 'codex MCP server approval (<server> needs your approval.)',
        expectedState: 'approval',
        expectedModalButtons: true,
        preamble: [
            '╭───────────────────────────────────────────────╮',
            '│ >_ OpenAI Codex (v0.162.1)                    │',
            '╰───────────────────────────────────────────────╯',
        ],
        header: [
            '  adhdev-mesh needs your approval.',
        ],
        body: [
            '  Tool: report_completion',
        ],
        controlsAndFooter: [
            '  › 1. Yes, allow this tool call',
            '    2. No, deny this tool call',
            '',
            '  enter to submit | esc to cancel',
        ],
    },
    {
        provider: 'codex-cli',
        category: 'b_approval',
        name: 'codex folder-trust modal',
        expectedState: 'trust',
        expectedModalButtons: true,
        preamble: [
            '  ~/Work/adhdev',
        ],
        header: [
            '  Do you trust the contents of this directory?',
        ],
        body: [
            '  Execution of project configuration files requires folder trust.',
        ],
        controlsAndFooter: [
            '  › 1. Yes, trust this directory',
            '    2. No, use safe mode',
            '',
            '  Press enter to confirm or esc to cancel',
        ],
    },

    // ── codex-cli (c) pickers ──
    {
        provider: 'codex-cli',
        category: 'c_picker',
        name: 'codex /model picker (Select a model)',
        expectedState: 'picker',
        expectedModalButtons: true,
        preamble: [
            '  Model selection',
        ],
        header: [
            '  Select a model',
        ],
        body: [
            '  Choose a model for this Codex session:',
        ],
        controlsAndFooter: [
            '  › 1. gpt-5.4',
            '    2. gpt-5.4-mini',
        ],
    },

    // ── codex-cli (d) busy turns ──
    {
        provider: 'codex-cli',
        category: 'd_busy',
        name: 'codex streaming turn with Working spinner',
        expectedState: 'busy',
        expectedModalButtons: false,
        preamble: [
            '╭───────────────────────────────────────────────╮',
            '│ >_ OpenAI Codex (v0.162.1)                    │',
            '╰───────────────────────────────────────────────╯',
        ],
        header: [
            '• Reading file and searching references...',
        ],
        body: [
            '   Examining src/auth.ts',
        ],
        controlsAndFooter: [
            '  Working (⣿ 4s · esc to interrupt)',
            '',
            '› ',
            '  tab to queue message  ·  ⏎ send',
        ],
    },
    {
        provider: 'codex-cli',
        category: 'd_busy',
        name: 'codex streaming turn with Thinking spinner',
        expectedState: 'busy',
        expectedModalButtons: false,
        preamble: [
            '╭───────────────────────────────────────────────╮',
            '│ >_ OpenAI Codex (v0.162.1)                    │',
            '╰───────────────────────────────────────────────╯',
        ],
        header: [
            '• Editing authentication spec...',
        ],
        body: [
            '   Updating transitions',
        ],
        controlsAndFooter: [
            '  Thinking (⣾ 7s · esc to interrupt)',
            '',
            '› ',
            '  tab to queue message  ·  ⏎ send',
        ],
    },

    // ── antigravity-cli (b) approvals ──
    {
        provider: 'antigravity-cli',
        category: 'b_approval',
        name: 'agy command approval (Do you want to proceed?)',
        expectedState: 'approval',
        expectedModalButtons: true,
        preamble: [
            '  ● Running command',
        ],
        header: [
            '  Requesting permission for: git status',
            '  Do you want to proceed?',
        ],
        body: [
            '  $ git status --short',
        ],
        controlsAndFooter: [
            '  ❯ 1. Yes, run this',
            '    2. No, skip',
            '  ? for shortcuts',
        ],
    },
    {
        provider: 'antigravity-cli',
        category: 'b_approval',
        name: 'agy file edit approval (Accept this file edit?)',
        expectedState: 'approval',
        expectedModalButtons: true,
        preamble: [
            '  ● edit_file(src/auth.ts)',
        ],
        header: [
            'Accept this file edit?',
        ],
        body: [
            '  + const signedIn = true;',
        ],
        controlsAndFooter: [
            '> 1. Yes, accept this change',
            '  2. No, reject this change',
            '  ↑/↓ Navigate · tab Amend · f full diff',
        ],
    },
    {
        provider: 'antigravity-cli',
        category: 'b_approval',
        name: 'agy MCP tool approval (Allow calling this tool?)',
        expectedState: 'approval',
        expectedModalButtons: true,
        preamble: [
            '  MCP',
            '  ────────────────────────────────────────',
            '  adhdev-mesh/report_completion',
        ],
        header: [
            '  Allow calling this tool?',
        ],
        body: [
            '  arguments: {"summary":"verified auth flow"}',
        ],
        controlsAndFooter: [
            '  > 1. Yes, allow tool call',
            "    2. Yes, and always allow tool 'adhdev-mesh/report_completion' in this conversation",
            '    3. No, deny tool call',
            '  ↑/↓ Navigate · tab Amend',
            'esc to cancel                                           Claude Opus 5.5 · medium',
        ],
    },
    {
        provider: 'antigravity-cli',
        category: 'b_approval',
        name: 'agy folder-trust modal (Do you trust the files in this folder?)',
        expectedState: 'trust',
        expectedModalButtons: true,
        preamble: [
            '  /workspace/adhdev-wt/fix-auth-detection',
        ],
        header: [
            '  Do you trust the files in this folder?',
        ],
        body: [
            '  Trusting allows Antigravity CLI to execute workspace tools.',
        ],
        controlsAndFooter: [
            '  ❯ Yes, trust this folder',
            '    No, use restricted mode',
            '  ? for shortcuts',
        ],
    },

    // ── antigravity-cli (c) pickers / choice ──
    {
        provider: 'antigravity-cli',
        category: 'c_picker',
        name: 'agy ask_question single-select choice picker',
        expectedState: 'choice',
        expectedModalButtons: false,
        preamble: [
            '  ● ask_question',
        ],
        header: [
            '  Question',
            '  ────────────────────────────────────────',
            '  Question 1/2: Which database engine should we use?',
        ],
        body: [
            '  Select the primary storage backend:',
        ],
        controlsAndFooter: [
            '  > 1. PostgreSQL',
            '    2. SQLite',
            '    3. Write-in...',
            '',
            '  ↑/↓ Navigate • Enter Select • <esc> Skip',
            '  ? for shortcuts                                      Gemini 4 Argon · medium',
        ],
    },

    // ── antigravity-cli (d) busy turns ──
    {
        provider: 'antigravity-cli',
        category: 'd_busy',
        name: 'agy streaming turn with Reading file spinner and esc to cancel footer',
        expectedState: 'busy',
        expectedModalButtons: false,
        preamble: [
            '  ● Read(src/providers/spec/fsm-evaluator.ts)',
        ],
        header: [
            '  ⠋ Reading file src/providers/spec/fsm-evaluator.ts...',
        ],
        body: [
            '  Examining state precedence rules...',
        ],
        controlsAndFooter: [
            '────────────────────────────────────────────────────────────────────────────────',
            '> ',
            '────────────────────────────────────────────────────────────────────────────────',
            'esc to cancel                                            Gemini 3.7 Flash · high',
        ],
    },
    {
        provider: 'antigravity-cli',
        category: 'd_busy',
        name: 'agy streaming turn with Searching spinner and esc to cancel footer',
        expectedState: 'busy',
        expectedModalButtons: false,
        preamble: [
            '  ● Search(adhdev-providers/cli)',
        ],
        header: [
            '  ⠹ Searching for login patterns across specs...',
        ],
        body: [
            '  Scanned 6 provider manifests',
        ],
        controlsAndFooter: [
            '────────────────────────────────────────────────────────────────────────────────',
            '> ',
            '────────────────────────────────────────────────────────────────────────────────',
            'esc to cancel                                            Gemini 4 Argon · medium',
        ],
    },

    // ── cursor-cli (b) approvals ──
    {
        provider: 'cursor-cli',
        category: 'b_approval',
        name: 'cursor command approval (Run this command? parenthetical buttons)',
        expectedState: 'approval',
        expectedModalButtons: true,
        preamble: [
            '  ────────────────────────────────────────',
            '  $ git status --short',
        ],
        header: [
            '  Run this command?',
        ],
        body: [
            '  Working directory: /workspace/adhdev-wt/fix-auth-detection',
        ],
        controlsAndFooter: [
            '  → Run (once) (y)',
            '    Always run (tab)',
            '    Reject (esc or n)',
        ],
    },
    {
        provider: 'cursor-cli',
        category: 'b_approval',
        name: 'cursor edit approval (Do you want to make these edits?)',
        expectedState: 'approval',
        expectedModalButtons: true,
        preamble: [
            '  Editing src/auth.ts',
        ],
        header: [
            '  Do you want to make these edits to src/auth.ts?',
        ],
        body: [
            '  + export const isSignedIn = true;',
        ],
        controlsAndFooter: [
            '  → Apply (once) (y)',
            '    Reject (esc or n)',
        ],
    },
    {
        provider: 'cursor-cli',
        category: 'b_approval',
        name: 'cursor MCP approval (Allow MCP tool?)',
        expectedState: 'approval',
        expectedModalButtons: true,
        preamble: [
            '  MCP server: adhdev-mesh',
        ],
        header: [
            '  Allow MCP tool adhdev-mesh/report_completion?',
        ],
        body: [
            '  Args: {"outcome":"completed"}',
        ],
        controlsAndFooter: [
            '  → Allow (once) (y)',
            '    Always allow (tab)',
            '    Deny (esc or n)',
        ],
    },
    {
        provider: 'cursor-cli',
        category: 'b_approval',
        name: 'cursor workspace trust modal (Do you trust the files in this folder?)',
        expectedState: 'approval',
        expectedModalButtons: true,
        preamble: [
            '  Workspace check',
        ],
        header: [
            '  Do you trust the files in this folder?',
        ],
        body: [
            '  /workspace/adhdev-wt/fix-auth-detection',
        ],
        controlsAndFooter: [
            '  → Trust folder (y)',
            '    Do not trust (esc or n)',
        ],
    },

    // ── cursor-cli (c) pickers (numbered select) ──
    {
        provider: 'cursor-cli',
        category: 'c_picker',
        name: 'cursor numbered select modal',
        expectedState: 'approval',
        expectedModalButtons: true,
        preamble: [
            '  Configuration prompt',
        ],
        header: [
            '  Do you want to proceed with this configuration?',
        ],
        body: [
            '  Target environment: staging',
        ],
        controlsAndFooter: [
            '  → Proceed (once) (y)',
            '    Cancel (esc or n)',
        ],
    },

    // ── cursor-cli (d) busy turns ──
    {
        provider: 'cursor-cli',
        category: 'd_busy',
        name: 'cursor streaming turn with Generating spinner and ctrl+c to stop',
        expectedState: 'busy',
        expectedModalButtons: false,
        preamble: [
            '  Analyzing auth state transitions...',
        ],
        header: [
            '  ⠙ Generating… ctrl+c to stop',
        ],
        body: [
            '  Checking cursor-cli/specs/1.0.json',
        ],
        controlsAndFooter: [
            '  ctrl+c to stop',
        ],
    },
    {
        provider: 'cursor-cli',
        category: 'd_busy',
        name: 'cursor streaming turn with Reading file spinner and ctrl+c to cancel / esc to skip',
        expectedState: 'busy',
        expectedModalButtons: false,
        preamble: [
            '  Inspecting files...',
        ],
        header: [
            '  ⠋ Reading file src/auth.ts…',
        ],
        body: [
            '  120 lines read',
        ],
        controlsAndFooter: [
            '  ctrl+c to cancel · esc to skip',
        ],
    },

    // ── grok-cli (b) approvals ──
    {
        provider: 'grok-cli',
        category: 'b_approval',
        name: 'grok real captured radio-row tool approval (◆ Run Fetch, no question phrase)',
        expectedState: 'approval',
        expectedModalButtons: true,
        preamble: [
            '  ╭──────────────────────────────────────────────────────────────────────────╮',
            '  │ ◆ Run Fetch (https://example.com)                                        │',
            '  ╰──────────────────────────────────────────────────────────────────────────╯',
        ],
        header: [
            '  ┃',
        ],
        body: [
            '  ┃ URL: https://example.com/api/status',
        ],
        controlsAndFooter: [
            "  ┃ 1 (●) Yes, and don't ask again for example.com",
            '  ┃ 2 (○) Yes, proceed',
            '  ┃ 3 (○) No, reject',
            '  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛',
            '  1/3:select │ Tab:next option │ Enter:confirm',
        ],
    },
    {
        provider: 'grok-cli',
        category: 'b_approval',
        name: 'grok edit/patch radio-row approval (◆ Edit file)',
        expectedState: 'approval',
        expectedModalButtons: true,
        preamble: [
            '  ╭──────────────────────────────────────────────────────────────────────────╮',
            '  │ ◆ Edit src/auth.ts                                                       │',
            '  ╰──────────────────────────────────────────────────────────────────────────╯',
        ],
        header: [
            '  ┃',
        ],
        body: [
            '  ┃ + export const authOk = true;',
        ],
        controlsAndFooter: [
            '  ┃ 1 (●) Yes, apply edit',
            '  ┃ 2 (○) No, reject edit',
            '  1/2:select │ Tab:next option │ Enter:confirm',
        ],
    },
    {
        provider: 'grok-cli',
        category: 'b_approval',
        name: 'grok MCP radio-row approval (◆ Run mcp tool)',
        expectedState: 'approval',
        expectedModalButtons: true,
        preamble: [
            '  ╭──────────────────────────────────────────────────────────────────────────╮',
            '  │ ◆ Run adhdev-mesh:report_completion                                      │',
            '  ╰──────────────────────────────────────────────────────────────────────────╯',
        ],
        header: [
            '  ┃',
        ],
        body: [
            '  ┃ {"outcome":"completed"}',
        ],
        controlsAndFooter: [
            '  ┃ 1 (●) Yes, proceed',
            '  ┃ 2 (○) No, reject',
            '  1/2:select │ Tab:next option │ Enter:confirm',
        ],
    },
    {
        provider: 'grok-cli',
        category: 'b_approval',
        name: 'grok workspace trust modal (Do you trust the contents of this directory?)',
        expectedState: 'trust',
        expectedModalButtons: true,
        preamble: [
            '  Grok Build 1.0.4',
        ],
        header: [
            '  Do you trust the contents of this directory?',
        ],
        body: [
            '  /workspace/adhdev-wt/fix-auth-detection',
        ],
        controlsAndFooter: [
            '  Yes, proceed   y',
            '  No, exit       n',
        ],
    },

    // ── grok-cli (c) pickers (radio select) ──
    {
        provider: 'grok-cli',
        category: 'c_picker',
        name: 'grok numbered radio-select picker',
        expectedState: 'approval',
        expectedModalButtons: true,
        preamble: [
            '  ◆ Select target configuration',
        ],
        header: [
            '  ┃',
        ],
        body: [
            '  ┃ Choose the deployment profile:',
        ],
        controlsAndFooter: [
            '  ┃ 1 (●) Production profile',
            '  ┃ 2 (○) Staging profile',
            '  1/2:select │ Tab:next option │ Enter:confirm',
        ],
    },

    // ── grok-cli (d) busy turns ──
    {
        provider: 'grok-cli',
        category: 'd_busy',
        name: 'grok streaming turn with Reading file spinner and [stop] / Esc:cancel',
        expectedState: 'busy',
        expectedModalButtons: false,
        preamble: [
            '  ● Reading src/auth.ts',
        ],
        header: [
            '  ⠋ Reading file 2.4s [stop]',
        ],
        body: [
            '  Analyzing auth state transitions...',
        ],
        controlsAndFooter: [
            '  Esc:cancel │ Ctrl+x:shortcuts',
        ],
    },
    {
        provider: 'grok-cli',
        category: 'd_busy',
        name: 'grok streaming turn with Searching spinner and elapsed seconds',
        expectedState: 'busy',
        expectedModalButtons: false,
        preamble: [
            '  ● Searching repository',
        ],
        header: [
            '  ⠹ Searching 4.1s [stop]',
        ],
        body: [
            '  Found 6 provider specs',
        ],
        controlsAndFooter: [
            '  Esc:cancel',
        ],
    },

    // ── kimi (b) approvals ──
    {
        provider: 'kimi',
        category: 'b_approval',
        name: 'kimi command approval (▶ Run command? with multi-line body)',
        expectedState: 'approval',
        expectedModalButtons: true,
        preamble: [
            '  Kimi Code v0.36',
        ],
        header: [
            '  ▶ Run command?',
        ],
        body: [
            '    $ git status --short',
            '    Working directory: /workspace/adhdev-wt/fix-auth-detection',
        ],
        controlsAndFooter: [
            '  ❯ 1. Yes, run once',
            '    2. Yes, allow for session',
            '    3. No, reject',
        ],
    },
    {
        provider: 'kimi',
        category: 'b_approval',
        name: 'kimi edit approval (▶ Apply these edits?)',
        expectedState: 'approval',
        expectedModalButtons: true,
        preamble: [
            '  Kimi Code v0.36',
        ],
        header: [
            '  ▶ Apply these edits?',
        ],
        body: [
            '    File: src/auth.ts',
            '    + export const authReady = true;',
        ],
        controlsAndFooter: [
            '  ❯ 1. Yes, apply changes',
            '    2. No, reject changes',
        ],
    },
    {
        provider: 'kimi',
        category: 'b_approval',
        name: 'kimi MCP tool approval (▶ Approve mcp__adhdev-mesh__report_completion?)',
        expectedState: 'approval',
        expectedModalButtons: true,
        preamble: [
            '  Kimi Code v0.36',
        ],
        header: [
            '  ▶ Approve mcp__adhdev-mesh__report_completion?',
        ],
        body: [
            '    Server: adhdev-mesh',
            '    Arguments: {"outcome":"completed"}',
        ],
        controlsAndFooter: [
            '  ❯ 1. Yes, approve once',
            '    2. Yes, approve for session',
            '    3. No, reject',
        ],
    },
    {
        provider: 'kimi',
        category: 'b_approval',
        name: 'kimi workspace trust / permission modal (Do you want to allow access?)',
        expectedState: 'approval',
        expectedModalButtons: true,
        preamble: [
            '  Kimi Code v0.36',
        ],
        header: [
            '  Do you want to allow access to this workspace?',
        ],
        body: [
            '    /workspace/adhdev-wt/fix-auth-detection',
        ],
        controlsAndFooter: [
            '  ❯ 1. Yes, allow',
            '    2. No, exit',
        ],
    },

    // ── kimi (c) pickers ──
    {
        provider: 'kimi',
        category: 'c_picker',
        name: 'kimi built-in idle/cache-expired selector picker',
        expectedState: 'idle',
        expectedModalButtons: false,
        kimiIdleSelector: true,
        preamble: [
            '  prior assistant output line',
            ' ──────────────────────────────────────────────',
        ],
        header: [
            '  This session has been idle for 32m and is ~392k tokens.',
            '  ↑↓ navigate · Enter select · Esc cancel',
        ],
        body: [
            '',
            '  Cache expired — the next message re-sends the entire history at full price.',
        ],
        controlsAndFooter: [
            '  ❯ Compact and continue    one-time compact cost',
            '    Start a new session     zero context cost',
            '    Continue as-is          full history kept',
            ' ──────────────────────────────────────────────',
            '┌──────────────────────────────────────────┐',
            '│ >                                        │',
            '└──────────────────────────────────────────┘',
        ],
    },

    // ── kimi (d) busy turns ──
    {
        provider: 'kimi',
        category: 'd_busy',
        name: 'kimi streaming turn with Reading file and moon-phase spinner',
        expectedState: 'busy',
        expectedModalButtons: false,
        preamble: [
            '  Kimi Code v0.36',
        ],
        header: [
            '  • Reading file src/auth.ts...',
        ],
        body: [
            '    Inspecting lines 1-120',
        ],
        controlsAndFooter: [
            '  🌒 · Tip: Use /compact to reduce context usage',
        ],
    },
    {
        provider: 'kimi',
        category: 'd_busy',
        name: 'kimi streaming turn with Editing and braille working spinner',
        expectedState: 'busy',
        expectedModalButtons: false,
        preamble: [
            '  Kimi Code v0.36',
        ],
        header: [
            '  • Editing spec files...',
        ],
        body: [
            '    Updating transitions',
        ],
        controlsAndFooter: [
            '  ⠋ working...',
        ],
    },
];

// ─────────────────────────────────────────────────────────────────────────────
// (e) IDLE COMPOSER SCREENS
// ─────────────────────────────────────────────────────────────────────────────
const IDLE_CASES: MatrixCase[] = [
    {
        provider: 'claude-cli',
        category: 'e_idle',
        variant: 'clean',
        name: 'claude real captured finished turn idle composer',
        screen: readFixture('claude-background-shell-finished-2026-10-18.txt'),
        expectedState: 'idle',
        expectedPreSendGuard: false,
        expectedModalButtons: false,
    },
    {
        provider: 'claude-cli',
        category: 'e_idle',
        variant: 'quoted_in_viewport_transcript',
        name: 'claude idle composer with Select login method quoted in tool output above composer',
        screen: [
            ' ▐▛███▜▌   Claude Code v2.1.309',
            '⏺ Bash(cat login-fixture.txt)',
            '  ⎿  Select login method:',
            "     Browser didn't open? Use the url below to sign in",
            '     Paste code here if prompted > ',
            '',
            '✻ Crunched for 2s',
            '',
            '────────────────────────────────────────────────────────────────────────────────────────────────────',
            '❯ ',
            '────────────────────────────────────────────────────────────────────────────────────────────────────',
            '  ⏸ manual mode on · ← for agents',
        ].join('\n'),
        expectedState: 'idle',
        expectedPreSendGuard: false,
        expectedModalButtons: false,
    },
    {
        provider: 'codex-cli',
        category: 'e_idle',
        variant: 'clean',
        name: 'codex real captured finished turn idle composer',
        screen: readFixture('codex-background-terminal-finished-2026-10-18.txt'),
        expectedState: 'idle',
        expectedPreSendGuard: false,
        expectedModalButtons: false,
    },
    {
        provider: 'codex-cli',
        category: 'e_idle',
        variant: 'quoted_in_viewport_transcript',
        name: 'codex idle composer with Sign in with ChatGPT quoted in recent output',
        screen: [
            '╭───────────────────────────────────────────────╮',
            '│ >_ OpenAI Codex (v0.162.1)                    │',
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
        ].join('\n'),
        expectedState: 'idle',
        expectedPreSendGuard: false,
        expectedModalButtons: false,
    },
    {
        provider: 'antigravity-cli',
        category: 'e_idle',
        variant: 'clean',
        name: 'agy real captured redrawn idle composer',
        screen: readFixture('antigravity-redrawn-idle-2026-09-24.txt'),
        expectedState: 'idle',
        expectedPreSendGuard: false,
        expectedModalButtons: false,
    },
    {
        provider: 'antigravity-cli',
        category: 'e_idle',
        variant: 'quoted_in_viewport_transcript',
        name: 'agy idle composer with You are currently not signed in quoted above composer',
        screen: [
            '● Bash(git grep "not signed in")',
            '  You are currently not signed in.',
            '  Select Google Cloud sign-in method:',
            '────────────────────────────────────────────────────────────────────────────────',
            '> Type your message or @path/to/file',
            '────────────────────────────────────────────────────────────────────────────────',
            '? for shortcuts                                          Gemini 3.7 Flash · high',
        ].join('\n'),
        expectedState: 'idle',
        expectedPreSendGuard: false,
        expectedModalButtons: false,
    },
    {
        provider: 'cursor-cli',
        category: 'e_idle',
        variant: 'clean',
        name: 'cursor settled two-line idle footer',
        screen: [
            '  Completed the requested changes.',
            '',
            '  Claude 4.5 Sonnet · 12.4%',
            '  ~/Documents/Work/adhdev',
        ].join('\n'),
        expectedState: 'idle',
        expectedPreSendGuard: false,
        expectedModalButtons: false,
    },
    {
        provider: 'cursor-cli',
        category: 'e_idle',
        variant: 'quoted_in_viewport_transcript',
        name: 'cursor idle footer with Press Enter to sign in quoted in output above footer',
        screen: [
            '  Welcome to Cursor Agent',
            '  ▸ Press Enter to sign in',
            '  Signing in with the browser',
            '',
            '  Claude 4.5 Sonnet · 14.2%',
            '  ~/Documents/Work/adhdev',
        ].join('\n'),
        expectedState: 'idle',
        expectedPreSendGuard: false,
        expectedModalButtons: false,
    },
    {
        provider: 'grok-cli',
        category: 'e_idle',
        variant: 'clean',
        name: 'grok idle composer with Shift+Tab:mode │ Ctrl+x:shortcuts footer',
        screen: [
            '  Worked for 3s',
            '  ╭──────────────────────────────────────────────────────────────────────────╮',
            '  │ ❯                                                                        │',
            '  ╰──────────────────────────────────────────────────────────────────────────╯',
            '  Shift+Tab:mode │ Ctrl+x:shortcuts',
        ].join('\n'),
        expectedState: 'idle',
        expectedPreSendGuard: false,
        expectedModalButtons: false,
    },
    {
        provider: 'grok-cli',
        category: 'e_idle',
        variant: 'quoted_in_viewport_transcript',
        name: 'grok idle composer with Sign in to Grok Build quoted above composer',
        screen: [
            '  Sign in to Grok Build',
            '  Approve in your browser, then rerun or continue here.',
            '  ╭──────────────────────────────────────────────────────────────────────────╮',
            '  │ ❯                                                                        │',
            '  ╰──────────────────────────────────────────────────────────────────────────╯',
            '  Shift+Tab:mode │ Ctrl+x:shortcuts',
        ].join('\n'),
        expectedState: 'idle',
        expectedPreSendGuard: false,
        expectedModalButtons: false,
    },
    {
        provider: 'kimi',
        category: 'e_idle',
        variant: 'clean',
        name: 'kimi idle composer box',
        screen: [
            '  Task completed.',
            '┌──────────────────────────────────────────┐',
            '│ >                                        │',
            '└──────────────────────────────────────────┘',
        ].join('\n'),
        expectedState: 'idle',
        expectedPreSendGuard: false,
        expectedModalButtons: false,
    },
    {
        provider: 'kimi',
        category: 'e_idle',
        variant: 'quoted_in_viewport_transcript',
        name: 'kimi idle composer with Sign in to Kimi Code quoted above composer',
        screen: [
            '  Sign in to Kimi Code',
            '  Visit the URL below in your browser to authorize:',
            '┌──────────────────────────────────────────┐',
            '│ >                                        │',
            '└──────────────────────────────────────────┘',
        ].join('\n'),
        expectedState: 'idle',
        expectedPreSendGuard: false,
        expectedModalButtons: false,
    },
    // ── Round 8 MEDIUM-2: login menu ending in Esc:cancel / Esc to cancel quoted above settled idle composer ──
    {
        provider: 'cursor-cli',
        category: 'e_idle',
        variant: 'quoted_in_viewport_transcript',
        name: 'cursor idle footer with login menu ending in "Enter to confirm · Esc to cancel" quoted above composer',
        screen: [
            '  Cursor Agent',
            '  Sign in required',
            '  ❯ 1. Sign in with browser',
            '    2. Use API key',
            '  Enter to confirm · Esc to cancel',
            '',
            '  → Plan, search, build anything',
            '  Claude 4.5 Sonnet · 14.2%',
            '  ~/work/app · main',
        ].join('\n'),
        expectedState: 'idle',
        expectedPreSendGuard: false,
        expectedModalButtons: false,
    },
    {
        provider: 'cursor-cli',
        category: 'e_idle',
        variant: 'quoted_in_viewport_transcript',
        name: 'cursor post-turn idle footer with login menu ending in standalone "Esc to cancel" quoted above footer',
        screen: [
            '  Welcome to Cursor Agent',
            '  1. Sign in with browser',
            '  2. Use API key',
            '  Esc to cancel',
            '',
            '  Claude 4.5 Sonnet · 18.1%',
            '  ~/work/app · main',
        ].join('\n'),
        expectedState: 'idle',
        expectedPreSendGuard: false,
        expectedModalButtons: false,
    },
    {
        provider: 'cursor-cli',
        category: 'e_idle',
        variant: 'quoted_in_viewport_transcript',
        name: 'cursor idle footer with primary sign-in screen ("Press Enter to sign in ... or Esc to cancel.") quoted above footer',
        screen: [
            '  Welcome to Cursor Agent',
            '  Press Enter to sign in with your browser, or Esc to cancel.',
            '  [Enter] Sign in with browser    [Esc] Cancel',
            '',
            '  Claude 4.5 Sonnet · 14.2%',
            '  ~/work/app · main',
        ].join('\n'),
        expectedState: 'idle',
        expectedPreSendGuard: false,
        expectedModalButtons: false,
    },
    {
        provider: 'grok-cli',
        category: 'e_idle',
        variant: 'quoted_in_viewport_transcript',
        name: 'grok idle composer with Welcome to Grok CLI login menu ending in "Esc:cancel" quoted above composer',
        screen: [
            '  Welcome to Grok CLI',
            '  1 (●) Sign in with browser (xAI account)',
            '  2 (○) Paste your xAI API key',
            '  1/2:select │ Enter:confirm',
            '  Esc:cancel',
            '  ╭──────────────────────────────────────────────────────────────────────────╮',
            '  │ ❯                                                                        │',
            '  ╰──────────────────────────────────────────────────────────────────────────╯',
            '  Shift+Tab:mode │ Ctrl+x:shortcuts',
        ].join('\n'),
        expectedState: 'idle',
        expectedPreSendGuard: false,
        expectedModalButtons: false,
    },
    {
        provider: 'grok-cli',
        category: 'e_idle',
        variant: 'quoted_in_viewport_transcript',
        name: 'grok idle composer with Sign in to Grok Build login menu ending in "Esc:cancel" quoted above composer',
        screen: [
            '  Sign in to Grok Build',
            '  Approve in your browser, then rerun or continue here.',
            '  Waiting for approval...',
            '  Esc:cancel',
            '  ╭──────────────────────────────────────────────────────────────────────────╮',
            '  │ ❯                                                                        │',
            '  ╰──────────────────────────────────────────────────────────────────────────╯',
            '  Shift+Tab:mode │ Ctrl+x:shortcuts',
        ].join('\n'),
        expectedState: 'idle',
        expectedPreSendGuard: false,
        expectedModalButtons: false,
    },
];

// ─────────────────────────────────────────────────────────────────────────────
// ROUND 8 MEDIUM-1 MIRROR CASES: real login screens with provider approval
// questions quoted in transcript above them (both inline prose and standalone
// question lines) → must classify as signing_in with preSendGuard=true and no
// approval buttons across starting, idle, busy, and signing_in.
// ─────────────────────────────────────────────────────────────────────────────
const PROVIDER_APPROVAL_QUOTES: Record<ProviderId, [string, string]> = {
    'claude-cli': [
        'Do you want to proceed?',
        'Select a model',
    ],
    'codex-cli': [
        'Would you like to run the following command?',
        'adhdev-mesh needs your approval.',
    ],
    'antigravity-cli': [
        'Do you want to proceed?',
        'Allow calling this tool?',
    ],
    'cursor-cli': [
        'Run this command?',
        'Do you want to proceed?',
    ],
    'grok-cli': [
        'Do you want to proceed?',
        'Run this command?',
    ],
    'kimi': [
        '▶ Run command?',
        'Run this command?',
    ],
};

const LOGIN_WITH_QUOTED_APPROVAL_CASES: MatrixCase[] = LOGIN_CASES.flatMap((lc): MatrixCase[] => {
    const [q1, q2] = PROVIDER_APPROVAL_QUOTES[lc.provider];
    return [
        {
            ...lc,
            variant: 'quoted_above_question',
            name: `${lc.name} [inline approval quote above login: ⏺ The tool earlier printed "${q1}"…]`,
            screen: `⏺ The tool earlier printed "${q1}"…\n${lc.screen}`,
        },
        {
            ...lc,
            variant: 'quoted_above_question',
            name: `${lc.name} [raw approval question line above login: "${q1}"]`,
            screen: `  ${q1}\n${lc.screen}`,
        },
        {
            ...lc,
            variant: 'quoted_above_question',
            name: `${lc.name} [secondary approval/picker question line above login: "${q2}"]`,
            screen: `  ${q2}\n${lc.screen}`,
        },
    ];
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPLICIT ROUND-6 REVIEW REPROS (180b479b)
// ─────────────────────────────────────────────────────────────────────────────
const ROUND6_REVIEW_REPROS: MatrixCase[] = [
    // 1. grok: real approval (◆ Run…, radio rows, 1/3:select) + status_tail line
    //    "Approve in your browser, then rerun…" / "Sign in to Grok Build" / "Enter your API key in .env first."
    ...[
        '  Approve in your browser, then rerun or continue here.',
        '  Sign in to Grok Build',
        '  Enter your API key in .env first.',
    ].map((loginLine): MatrixCase => ({
        provider: 'grok-cli',
        category: 'b_approval',
        variant: 'quoted_in_status_tail',
        name: `round-6 repro — grok real approval + status_tail "${loginLine.trim()}"`,
        screen: [
            loginLine,
            '  ╭──────────────────────────────────────────────────────────────────────────╮',
            '  │ ◆ Run Fetch (https://example.com)                                        │',
            '  ╰──────────────────────────────────────────────────────────────────────────╯',
            '  ┃',
            "  ┃ 1 (●) Yes, and don't ask again for example.com",
            '  ┃ 2 (○) Yes, proceed',
            '  ┃ 3 (○) No, reject',
            '  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛',
            '  1/3:select │ Tab:next option │ Enter:confirm',
        ].join('\n'),
        expectedState: 'approval',
        expectedPreSendGuard: false,
        expectedModalButtons: true,
    })),

    // 2. agy: streaming turn with footer "esc to cancel  Gemini…", spinner verb other than
    //    Generating/Running/Thinking, and viewport line "Signing in…" / oauth2 URL / "You are currently not signed in."
    ...[
        '  Signing in…',
        '  https://accounts.google.com/o/oauth2/auth',
        '  You are currently not signed in.',
    ].map((loginLine): MatrixCase => ({
        provider: 'antigravity-cli',
        category: 'd_busy',
        variant: 'quoted_in_viewport_transcript',
        name: `round-6 repro — agy streaming turn (Reading file spinner + esc to cancel Gemini footer) + "${loginLine.trim()}"`,
        screen: [
            loginLine,
            '  ⠋ Reading file src/auth/login.ts...',
            '────────────────────────────────────────────────────────────────────────────────',
            '> ',
            '────────────────────────────────────────────────────────────────────────────────',
            'esc to cancel                                            Gemini 3.7 Flash · high',
        ].join('\n'),
        expectedState: 'busy',
        expectedPreSendGuard: false,
        expectedModalButtons: false,
    })),

    // 3. claude: AskUserQuestion picker whose earlier transcript in viewport quotes "  Select login method:"
    {
        provider: 'claude-cli',
        category: 'c_picker',
        variant: 'quoted_in_viewport_transcript',
        name: 'round-6 repro — claude AskUserQuestion picker under transcript quoting "  Select login method:"',
        screen: [
            '⏺ Read(test/auth.test.ts)',
            '  ⎿  Select login method:',
            '     1. Claude account with subscription',
            '',
            ' ☐ Auth strategy',
            '',
            ' ❯ 1. Keep structural section anchors',
            '   2. Fallback',
            '   3. Type something.',
            '   4. Chat about this',
            '',
            ' Enter to select · ↑/↓ to navigate',
        ].join('\n'),
        expectedState: 'picker',
        expectedPreSendGuard: false,
        expectedModalButtons: true,
    },

    // 4. codex: "Would you like to make the following edits?" and MCP "<server> needs your approval."
    //    with the footer, plus a body line "Sign in with ChatGPT…" / "Provide your own API key"
    ...[
        '  Sign in with ChatGPT to use Codex',
        '  Provide your own API key',
    ].flatMap((loginLine): MatrixCase[] => [
        {
            provider: 'codex-cli',
            category: 'b_approval',
            variant: 'quoted_in_body',
            name: `round-6 repro — codex "Would you like to make the following edits?" quoting "${loginLine.trim()}"`,
            screen: [
                '  Would you like to make the following edits?',
                `  + ${loginLine.trim()}`,
                '  › 1. Yes, apply edits (y)',
                '    2. No, skip edits (esc)',
                '  enter to submit | esc to cancel',
            ].join('\n'),
            expectedState: 'approval',
            expectedPreSendGuard: false,
            expectedModalButtons: true,
        },
        {
            provider: 'codex-cli',
            category: 'b_approval',
            variant: 'quoted_in_body',
            name: `round-6 repro — codex MCP "<server> needs your approval." quoting "${loginLine.trim()}"`,
            screen: [
                '  adhdev-mesh needs your approval.',
                `  ${loginLine}`,
                '  › 1. Yes, allow tool call',
                '    2. No, deny tool call',
                '  enter to submit | esc to cancel',
            ].join('\n'),
            expectedState: 'approval',
            expectedPreSendGuard: false,
            expectedModalButtons: true,
        },
    ]),

    // 5. cursor: status_tail quoting a login line plus "ctrl+c to cancel" / "esc to skip",
    //    and "⠙ Generating… ctrl+c to stop"
    ...[
        '  ctrl+c to cancel',
        '  esc to skip',
        '  ⠙ Generating… ctrl+c to stop',
    ].map((busyLine): MatrixCase => ({
        provider: 'cursor-cli',
        category: 'd_busy',
        variant: 'quoted_in_status_tail',
        name: `round-6 repro — cursor "${busyLine.trim()}" + quoted login line in status_tail`,
        screen: [
            '  Welcome to Cursor Agent',
            '  ▸ Press Enter to sign in',
            '  Signing in with the browser',
            busyLine,
        ].join('\n'),
        expectedState: 'busy',
        expectedPreSendGuard: false,
        expectedModalButtons: false,
    })),

    // 6. kimi: "▶ Run command?" with a multi-line body containing "Sign in to Kimi Code"
    {
        provider: 'kimi',
        category: 'b_approval',
        variant: 'quoted_in_body',
        name: 'round-6 repro — kimi "▶ Run command?" with multi-line body containing "Sign in to Kimi Code"',
        screen: [
            '  ▶ Run command?',
            '    $ grep -rn "Sign in to Kimi Code" adhdev-providers/',
            '    Sign in to Kimi Code',
            '    Visit the URL below in your browser to authorize:',
            '  ❯ 1. Yes, run once',
            '    2. Yes, allow for session',
            '    3. No, reject',
        ].join('\n'),
        expectedState: 'approval',
        expectedPreSendGuard: false,
        expectedModalButtons: true,
    },

    // 7. agy: "Allow calling this tool?" with args below quoting "You are currently not signed in."
    {
        provider: 'antigravity-cli',
        category: 'b_approval',
        variant: 'quoted_in_body',
        name: 'round-6 repro — agy "Allow calling this tool?" with args below quoting "You are currently not signed in."',
        screen: [
            '  MCP',
            '  ────────────────────────────────────────',
            '  adhdev-mesh/report_completion',
            '  Allow calling this tool?',
            '  You are currently not signed in.',
            '  Select Google Cloud sign-in method:',
            '  > 1. Yes, allow tool call',
            '    2. No, deny tool call',
            '  ↑/↓ Navigate · tab Amend',
            'esc to cancel                                           Claude Opus 5.5 · medium',
        ].join('\n'),
        expectedState: 'approval',
        expectedPreSendGuard: false,
        expectedModalButtons: true,
    },
];

export const ALL_MATRIX_CASES: MatrixCase[] = [
    ...LOGIN_CASES,
    ...LOGIN_WITH_QUOTED_APPROVAL_CASES,
    ...TEMPLATES.flatMap(buildVariantsFromTemplate),
    ...IDLE_CASES,
    ...ROUND6_REVIEW_REPROS,
];

describe('Cross-provider auth & state-classification matrix', () => {
    const FROM_STATES = ['starting', 'idle', 'busy', 'signing_in'] as const;

    it.each(ALL_MATRIX_CASES)(
        '[$provider] [$category] $name → state=$expectedState, guard=$expectedPreSendGuard, buttons=$expectedModalButtons',
        (tc) => {
            const spec = loadSpec(tc.provider);

            // 1. Pre-send guard
            expect(isAnchoredSignInViewport(tc.screen, spec), 'preSendGuard').toBe(tc.expectedPreSendGuard);

            // 2. FSM state from starting / idle / busy / signing_in
            for (const from of FROM_STATES) {
                const actualState = effectiveStateFrom(spec, from, tc.screen);
                expect(actualState, `from ${from}`).toBe(tc.expectedState);
            }

            // 3. Modal / approval card extraction
            const targetStateObj = stateOf(spec, tc.expectedState);
            const lines = tc.screen.split('\n');
            const sections = resolveSections(spec.sections ?? {}, lines);
            const modal = deriveModal(targetStateObj, sections, tc.screen, () => {});
            if (tc.expectedModalButtons) {
                expect(modal, 'modal card must be present').not.toBeNull();
                expect(modal!.buttons.length, 'modal must have >= 2 buttons').toBeGreaterThanOrEqual(2);
            } else {
                expect(modal, 'modal card must be null').toBeNull();
            }

            // 4. Optional Kimi built-in idle selector check
            if (tc.kimiIdleSelector) {
                const prompt = detectKimiIdleSelectorPrompt(tc.screen);
                expect(prompt, 'detectKimiIdleSelectorPrompt').not.toBeNull();
                expect(prompt!.questions[0].options.length).toBeGreaterThanOrEqual(2);
            }
        },
    );
});
