/**
 * Raw terminal input into the assistant session (design
 * 2026-10-07-assistant-layer.md §4.10.7; assistant/assistant-human-input.ts
 * `reportSessionTerminalInput`, `AssistantRelay.recordHumanTerminalInput`):
 *  - the router stamps the command source on `pty_input` too (never the caller);
 *  - a dashboard write that carries a submit key into the bound assistant
 *    session logs one `human` entry (`term:<session>:<ms>:<n>`), at the write;
 *  - keystrokes without a submit key, non-dashboard sources and other sessions
 *    log nothing;
 *  - a multi-Enter write is capped at one entry; line breaks inside a
 *    bracketed paste are not submits, the Enter after it is;
 *  - relay → terminal Enter → review is still `review_tainted`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonCommandRouter } from '../../src/commands/router.js';
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js';
import { COMMAND_SOURCE_ARG } from '../../src/commands/command-args.js';
import { handlePtyInput } from '../../src/commands/stream-commands.js';
import type { CommandHelpers } from '../../src/commands/handler.js';
import { createAssistantServices, setAssistantServicesForTests, type AssistantServices } from '../../src/assistant/assistant-services.js';
import { AssistantRegistry } from '../../src/assistant/assistant-registry.js';
import { InMemoryAssistantRelayStore } from '../../src/assistant/assistant-relay-store.js';
import { wireAssistantRuntime, type AssistantRuntime } from '../../src/assistant/assistant-runtime.js';
import { countTerminalSubmits, reportSessionTerminalInput, TERMINAL_SUBMITS_PER_WRITE_CAP } from '../../src/assistant/assistant-human-input.js';

const SID = 'asst_1';
const OTHER = 'coder_1';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

let dir: string;
let svc: AssistantServices;
let runtime: AssistantRuntime | null = null;
let prevConfigDir: string | undefined;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adhdev-assistant-term-'));
    prevConfigDir = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = dir;
    svc = createAssistantServices({ configDir: dir, listMeshes: () => [] });
    setAssistantServicesForTests(svc);
});
afterEach(() => {
    runtime?.dispose();
    runtime = null;
    setAssistantServicesForTests(null);
    if (prevConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = prevConfigDir;
    rmSync(dir, { recursive: true, force: true });
});

describe('router stamps the command source on pty_input', () => {
    it('overwrites a caller-supplied source with the real one', async () => {
        const handleSpec = vi.fn(async (_spec: unknown, args: Record<string, unknown>) => ({ success: true, args }));
        const router = new DaemonCommandRouter({
            commandHandler: { handleSpec, rejectUnknown: vi.fn(async () => ({ success: false })) } as any,
            cliManager: {} as any,
            cdpManagers: new Map(),
            providerLoader: {} as any,
            instanceManager: { collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null } as any,
            detectedIdes: { value: [] },
            sessionRegistry: { get: () => undefined } as any,
            bus: createSessionLifecycleBus(),
        });
        await router.execute('pty_input', { targetSessionId: SID, data: '\r', [COMMAND_SOURCE_ARG]: 'standalone' }, 'api');
        expect(handleSpec.mock.calls[0]![1][COMMAND_SOURCE_ARG]).toBe('api');
        await router.execute('pty_input', { targetSessionId: SID, data: '\r' }, 'standalone');
        expect(handleSpec.mock.calls[1]![1][COMMAND_SOURCE_ARG]).toBe('standalone');
    });
});

describe('countTerminalSubmits', () => {
    it('counts CR, LF and CRLF as one submit each, outside bracketed pastes', () => {
        expect(countTerminalSubmits('hello')).toEqual({ submits: 0, inPaste: false });
        expect(countTerminalSubmits('\r')).toEqual({ submits: 1, inPaste: false });
        expect(countTerminalSubmits('\n')).toEqual({ submits: 1, inPaste: false });
        expect(countTerminalSubmits('a\r\nb\r\n')).toEqual({ submits: 2, inPaste: false });
        expect(countTerminalSubmits('a\rb\rc\r')).toEqual({ submits: 3, inPaste: false });
    });

    it('Alt+Enter (ESC CR) is a soft newline, not a submit', () => {
        expect(countTerminalSubmits('\x1b\r')).toEqual({ submits: 0, inPaste: false });
    });

    it('line breaks inside a bracketed paste are text; the Enter after the end marker submits', () => {
        expect(countTerminalSubmits(`${PASTE_START}one\ntwo\r\nthree${PASTE_END}`)).toEqual({ submits: 0, inPaste: false });
        expect(countTerminalSubmits(`${PASTE_START}one\ntwo${PASTE_END}\r`)).toEqual({ submits: 1, inPaste: false });
    });

    it('carries an unterminated paste across writes', () => {
        expect(countTerminalSubmits(`${PASTE_START}one\ntwo`)).toEqual({ submits: 0, inPaste: true });
        expect(countTerminalSubmits('\nthree', true)).toEqual({ submits: 0, inPaste: true });
        expect(countTerminalSubmits(`four${PASTE_END}\r`, true)).toEqual({ submits: 1, inPaste: false });
    });
});

describe('dashboard terminal input into the assistant session', () => {
    function setup() {
        const registry = new AssistantRegistry({ configDir: dir });
        registry.bindSession({ sessionId: SID, cliType: 'claude-cli', workspace: dir, at: 1 });
        svc.inputLog.begin(SID);
        runtime = wireAssistantRuntime({
            bus: { on: () => () => {} },
            instanceManager: { getInstance: () => undefined },
            router: { execute: async () => ({ success: true }) },
            cliManager: { input: { submit: async () => ({ kind: 'delivered' }), isParked: async () => false } },
        } as any, { registry, store: new InMemoryAssistantRelayStore(), metrics: null, tickMs: 3_600_000 });
        const written: Array<[string, string]> = [];
        const mkAdapter = (key: string) => ({ writeRaw: (d: string) => { written.push([key, d]); } });
        const adapters = new Map<string, any>([[SID, mkAdapter(SID)], [OTHER, mkAdapter(OTHER)]]);
        const helpersFor = (target: string) => ({
            currentSession: { sessionId: target, transport: 'pty' },
            getCliAdapter: (key: string) => adapters.get(key) ?? null,
            ctx: { adapters },
        } as unknown as CommandHelpers);
        const type = (data: string, source: string | undefined, target = SID) =>
            handlePtyInput(helpersFor(target), { targetSessionId: target, data, ...(source ? { [COMMAND_SOURCE_ARG]: source } : {}) });
        return { type, written };
    }

    it('a dashboard Enter logs one human entry with a synthetic terminal id, at the write', async () => {
        const { type, written } = setup();
        expect(await type('remember: answer in Korean', 'standalone')).toMatchObject({ success: true });
        expect(svc.inputLog.entries(SID)).toEqual([]); // keystrokes alone are not an input
        await type('\r', 'standalone');
        expect(written.map(([k]) => k)).toEqual([SID, SID]);
        const entries = svc.inputLog.entries(SID);
        expect(entries.map((e) => e.source)).toEqual(['human']);
        expect(entries[0]!.messageId).toMatch(new RegExp(`^term:${SID}:\\d+:\\d+$`));
        expect(svc.inputLog.writeContext(SID).origin).toBe('human');
    });

    it('api, absent and non-dashboard sources are not human; other sessions are untouched', async () => {
        const { type } = setup();
        await type('x\r', 'api');
        await type('x\r', undefined);
        await type('x\r', 'mesh');
        await type('x\r', 'ipc');
        await type('x\r', 'p2p', OTHER);
        expect(svc.inputLog.entries(SID)).toEqual([]);
        expect(svc.inputLog.has(OTHER)).toBe(false);
        reportSessionTerminalInput({ sessionIds: [SID], data: '\r', source: 'unknown' });
        expect(svc.inputLog.entries(SID)).toEqual([]);
    });

    it('a multi-Enter paste is capped per write', async () => {
        const { type } = setup();
        expect(TERMINAL_SUBMITS_PER_WRITE_CAP).toBe(1);
        await type('one\rtwo\rthree\rfour\rfive\rsix\rseven\r', 'p2p');
        expect(svc.inputLog.humanInputCount(SID)).toBe(1);
        await type('\r', 'p2p');
        expect(svc.inputLog.humanInputCount(SID)).toBe(2);
        const ids = svc.inputLog.entries(SID).map((e) => e.messageId);
        expect(new Set(ids).size).toBe(2);
    });

    it('a bracketed paste logs only at the Enter after it, even when split across writes', async () => {
        const { type } = setup();
        await type(`${PASTE_START}line 1\nline 2`, 'ws');
        await type(`\nline 3${PASTE_END}`, 'ws');
        expect(svc.inputLog.entries(SID)).toEqual([]);
        await type('\r', 'ws');
        expect(svc.inputLog.sources(SID)).toEqual(['human']);
    });

    it('the cloud P2P frame path reports through the same hook', () => {
        setup();
        reportSessionTerminalInput({ sessionIds: [SID], data: 'ok\r', source: 'p2p' });
        reportSessionTerminalInput({ sessionIds: [OTHER], data: 'ok\r', source: 'p2p' });
        expect(svc.inputLog.sources(SID)).toEqual(['human']);
        expect(svc.inputLog.has(OTHER)).toBe(false);
    });

    it('a relay followed by a terminal Enter: the review window is still tainted', async () => {
        const { type } = setup();
        svc.inputLog.append(SID, 'relay');
        svc.inputLog.closeTurn(SID);
        await type('thanks\r', 'standalone');
        expect(svc.inputLog.sources(SID)).toEqual(['relay', 'human']);
        svc.inputLog.closeTurn(SID);
        svc.inputLog.append(SID, 'review', { messageId: 'review:1' });
        expect(svc.inputLog.writeContext(SID).origin).toBe('review_tainted');
    });

    it('terminal Enters alone make a clean review window', async () => {
        const { type } = setup();
        await type('a\r', 'standalone');
        svc.inputLog.closeTurn(SID);
        await type('b\r', 'standalone');
        svc.inputLog.closeTurn(SID);
        expect(svc.inputLog.humanInputCount(SID)).toBe(2); // the review trigger's counter grows
        svc.inputLog.append(SID, 'review', { messageId: 'review:2' });
        expect(svc.inputLog.writeContext(SID).origin).toBe('review');
    });
});
