import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    AssistantRegistry,
    busyInputModeToSendPolicy,
    findAssistantRestoreRecord,
    matchesAssistantRestore,
    subscribeAssistantRegistry,
} from '../../src/assistant/assistant-registry.js';
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js';

/**
 * `<configDir>/assistant.json` (design 2026-10-07-assistant-layer.md §4.5):
 * single entry, atomic 0600 writes, binding survives daemon_shutdown, prune
 * against the full restore set, exact-runtimeId restore matching.
 */

let dir: string;
const reg = () => new AssistantRegistry({ configDir: dir });
const file = () => join(dir, 'assistant.json');
const bind = (r: AssistantRegistry, sessionId = 'rt_1', at = 1000) =>
    r.bindSession({ sessionId, cliType: 'claude-cli', workspace: join(dir, 'assistant'), mcpConfigPath: '/x/assistant.json', at });

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adhdev-assistant-reg-'));
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('AssistantRegistry', () => {
    it('is empty before the first launch', () => {
        expect(reg().read()).toBeNull();
        expect(existsSync(file())).toBe(false);
    });

    it('creates the entry with every design field and writes 0600 atomically', () => {
        const { entry, previous } = bind(reg());
        expect(previous).toBeNull();
        expect(entry).toMatchObject({
            sessionId: 'rt_1', cliType: 'claude-cli', mcpConfigPath: '/x/assistant.json', aliases: {}, createdAt: 1000,
            firstRelayAt: null, busyInputMode: 'queue', reviewTurn: true, lastTurnState: { state: 'idle', at: 1000, sessionId: 'rt_1' },
        });
        if (process.platform !== 'win32') expect(statSync(file()).mode & 0o777).toBe(0o600);
        expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
        expect(new AssistantRegistry({ configDir: dir }).read()).toEqual(entry);
    });

    it('hands back the previous turn state only for a NEW session id', () => {
        const r = reg();
        bind(r);
        r.recordTurnState('rt_1', 'working', 2000);
        expect(bind(r, 'rt_1', 3000).previous).toBeNull(); // restore re-bind keeps state
        expect(r.read()!.lastTurnState).toEqual({ state: 'working', at: 2000, sessionId: 'rt_1' });
        const { previous, entry } = bind(r, 'rt_2', 4000);
        expect(previous).toEqual({ state: 'working', at: 2000, sessionId: 'rt_1' });
        expect(entry.lastTurnState).toEqual({ state: 'idle', at: 4000, sessionId: 'rt_2' });
        expect(entry.createdAt).toBe(1000);
    });

    it('ignores turn edges of other sessions', () => {
        const r = reg();
        bind(r);
        r.recordTurnState('someone_else', 'working', 5000);
        expect(r.read()!.lastTurnState!.state).toBe('idle');
    });

    it('keeps the binding on daemon_shutdown and clears only the binding otherwise', () => {
        const r = reg();
        bind(r);
        r.updateSettings({ aliases: { blog: 'mesh_b' }, busyInputMode: 'steer' });
        r.recordTurnState('rt_1', 'working', 2000);
        expect(r.releaseSession('rt_1', 'daemon_shutdown')).toBe(false);
        expect(r.read()!.sessionId).toBe('rt_1');
        expect(r.releaseSession('rt_other', 'pty_exit')).toBe(false);
        expect(r.releaseSession('rt_1', 'pty_exit')).toBe(true);
        const e = r.read()!;
        expect(e.sessionId).toBeNull();
        expect(e.mcpConfigPath).toBeUndefined();
        expect(e.aliases).toEqual({ blog: 'mesh_b' });
        expect(e.busyInputMode).toBe('steer');
        expect(e.lastTurnState).toEqual({ state: 'working', at: 2000, sessionId: 'rt_1' }); // restart-note input survives
    });

    it('prunes a dead binding only against the full live set', () => {
        const r = reg();
        bind(r);
        expect(r.pruneAfterRestore(new Set(['rt_1', 'rt_x']))).toBeNull();
        expect(r.read()!.sessionId).toBe('rt_1');
        expect(r.pruneAfterRestore(new Set(['rt_x']))).toBe('rt_1');
        expect(r.read()!.sessionId).toBeNull();
    });

    it('validates settings and records the first relay once', () => {
        const r = reg();
        expect(r.updateSettings({ reviewTurn: false })).toBeNull(); // no entry yet
        bind(r);
        expect(() => r.updateSettings({ busyInputMode: 'yolo' as never })).toThrow(/busyInputMode/);
        r.updateSettings({ reviewTurn: false, memoryBudget: { memory: 99_999 } });
        expect(r.read()!.reviewTurn).toBe(false);
        expect(r.memoryBudgets().memory).toBe(8000); // clamped by resolveMemoryBudgets
        r.markFirstRelay(7000);
        r.markFirstRelay(8000);
        expect(r.read()!.firstRelayAt).toBe(7000);
    });

    it('keeps a corrupt file aside instead of overwriting it silently', () => {
        writeFileSync(file(), '{not json');
        const r = reg();
        expect(r.read()).toBeNull();
        bind(r);
        expect(readdirSync(dir).some((f) => f.startsWith('assistant.json.corrupt-'))).toBe(true);
        expect(JSON.parse(readFileSync(file(), 'utf-8')).sessionId).toBe('rt_1');
    });

    it('normalizes unknown busy modes from a hand-edited file to queue', () => {
        writeFileSync(file(), JSON.stringify({ cliType: 'codex-cli', workspace: '/w', createdAt: 1, busyInputMode: 'weird', aliases: { ' a ': 'm', b: 3 } }));
        const e = reg().read()!;
        expect(e.busyInputMode).toBe('queue');
        expect(e.aliases).toEqual({ a: 'm' });
        expect(e.sessionId).toBeNull();
    });
});

describe('restore matcher', () => {
    it('matches by exact runtimeId only', () => {
        const entry = { sessionId: 'rt_ABC' };
        expect(matchesAssistantRestore(entry, { runtimeId: 'rt_ABC' })).toBe(true);
        expect(matchesAssistantRestore(entry, { runtimeId: 'rt_abc' })).toBe(false);
        expect(matchesAssistantRestore(entry, { runtimeId: ' rt_ABC' })).toBe(false);
        expect(matchesAssistantRestore({ sessionId: null }, { runtimeId: '' })).toBe(false);
        expect(matchesAssistantRestore(null, { runtimeId: 'rt_ABC' })).toBe(false);
        const records = [{ runtimeId: 'x', workspace: '/assistant' }, { runtimeId: 'rt_ABC', workspace: '/elsewhere' }];
        expect(findAssistantRestoreRecord(entry, records)).toBe(records[1]);
        expect(findAssistantRestoreRecord({ sessionId: 'gone' }, records)).toBeNull();
    });
});

describe('busyInputModeToSendPolicy', () => {
    it('maps the §4.3 table and defaults to queue', () => {
        expect(busyInputModeToSendPolicy('queue')).toEqual({ mode: 'queue' });
        expect(busyInputModeToSendPolicy('interrupt')).toEqual({ mode: 'interrupt' });
        expect(busyInputModeToSendPolicy('steer')).toEqual({ mode: 'send_now' });
        expect(busyInputModeToSendPolicy(undefined)).toEqual({ mode: 'queue' });
    });
});

describe('subscribeAssistantRegistry', () => {
    it('tracks turn state and releases on termination via the bus', () => {
        const r = reg();
        bind(r);
        const bus = createSessionLifecycleBus();
        subscribeAssistantRegistry(bus, r);
        bus.emit({ kind: 'turn', phase: 'started', sessionId: 'rt_1', attemptId: 'plain:rt_1:e1', generation: 0, at: 2000 });
        expect(r.read()!.lastTurnState).toEqual({ state: 'working', at: 2000, sessionId: 'rt_1' });
        bus.emit({ kind: 'turn', phase: 'committed', sessionId: 'rt_1', attemptId: 'plain:rt_1:e1', generation: 0, outcome: 'completed', at: 3000 });
        expect(r.read()!.lastTurnState!.state).toBe('idle');
        bus.emit({ kind: 'terminated', sessionId: 'rt_1', at: 4000, cause: 'daemon_shutdown', providerType: 'claude-cli', runtimeSettings: {} });
        expect(r.read()!.sessionId).toBe('rt_1');
        bus.emit({ kind: 'terminated', sessionId: 'rt_1', at: 5000, cause: 'pty_exit', providerType: 'claude-cli', runtimeSettings: {} });
        expect(r.read()!.sessionId).toBeNull();
        bus.close();
    });
});
