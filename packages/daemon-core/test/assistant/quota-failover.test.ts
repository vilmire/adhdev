import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
    FAILOVER_AUTO_COOLDOWN_MS, FAILOVER_AUTO_PER_DAY, FAILOVER_MIN_WAIT_MS, FAILOVER_STALL_MS,
    QuotaFailoverTicker, decideFailover, type FailoverSubject, type QuotaFailoverPorts,
} from '../../src/assistant/quota-failover.js';
import { exhaustedResetsAt } from '../../src/assistant/session-control-runtime.js';
import { buildCloudStatusReportPayload } from '../../src/status/reporter.js';
import { projectServerStatusEvent } from '../../src/status/status-event.js';
import { LaunchDefaultsStore, fallbackListIssue, isLaunchDefaultsDocument } from '../../src/launch-defaults/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const NOW = 10_000_000_000;
const subject = (over: Partial<FailoverSubject> = {}): FailoverSubject => ({
    role: 'coordinator', project: 'blog', meshId: 'mesh-1', sessionId: 'coord-1', cliType: 'claude-cli',
    state: 'idle', remainingPct: 0, resetsAt: NOW + 5 * 3600_000, ...over,
});
const FALLBACK = [{ provider: 'codex-cli' }, { provider: 'kimi-cli' }];
const decide = (s: FailoverSubject, over: Partial<Parameters<typeof decideFailover>[0]> = {}) => decideFailover({
    subject: s, now: NOW, fallback: FALLBACK,
    quotaOf: (p) => ({ remainingPct: p === 'codex-cli' ? 80 : 50 }), isEligible: () => true, ...over,
});

describe('acceptance 7: decision', () => {
    it('proposes the first eligible fallback with enough quota when exhausted, idle and the reset is far', () => {
        expect(decide(subject())).toMatchObject({ kind: 'switch', to: { provider: 'codex-cli' }, toRemainingPct: 80 });
    });
    it('skips an ineligible or low-quota fallback and walks the order', () => {
        expect(decide(subject(), { isEligible: (s) => s.provider !== 'codex-cli' })).toMatchObject({ kind: 'switch', to: { provider: 'kimi-cli' } });
        expect(decide(subject(), { quotaOf: (p) => ({ remainingPct: p === 'codex-cli' ? 19 : 50 }) })).toMatchObject({ to: { provider: 'kimi-cli' } });
        expect(decide(subject(), { quotaOf: () => ({ remainingPct: null }) })).toMatchObject({ kind: 'no_fallback' });
    });
    it('does nothing when quota remains, when the session is working, or when the window resets soon', () => {
        expect(decide(subject({ remainingPct: 40 }))).toMatchObject({ kind: 'none', reason: 'not_exhausted' });
        expect(decide(subject({ remainingPct: null }))).toMatchObject({ kind: 'none', reason: 'not_exhausted' });
        expect(decide(subject({ state: 'busy', busyForMs: 60_000 }))).toMatchObject({ kind: 'none', reason: 'busy' });
        expect(decide(subject({ resetsAt: NOW + FAILOVER_MIN_WAIT_MS - 1 }))).toMatchObject({ kind: 'none', reason: 'resets_soon' });
        expect(decide(subject({ resetsAt: NOW + FAILOVER_MIN_WAIT_MS }))).toMatchObject({ kind: 'switch' });
    });
    it('a stalled generating session counts like an idle one', () => {
        expect(decide(subject({ state: 'busy', busyForMs: FAILOVER_STALL_MS }))).toMatchObject({ kind: 'switch' });
    });
    it('no configured fallback is a distinct quiet outcome; configured-but-unusable is no_fallback', () => {
        expect(decide(subject(), { fallback: [] })).toMatchObject({ kind: 'none', reason: 'no_fallback_configured' });
        expect(decide(subject(), { isEligible: () => false })).toMatchObject({ kind: 'no_fallback' });
    });
    it('exhaustedResetsAt waits for the LAST exhausted window', () => {
        expect(exhaustedResetsAt({ session: { usedPercent: 100, resetsAt: NOW + 1000 }, weekly: { usedPercent: 100, resetsAt: NOW + 9000 }, monthly: { usedPercent: 10, resetsAt: NOW + 99999 } }, NOW)).toBe(NOW + 9000);
        expect(exhaustedResetsAt({ session: { usedPercent: 50, resetsAt: NOW + 1000 } }, NOW)).toBeUndefined();
    });
});

function ticker(over: Partial<QuotaFailoverPorts> = {}, subjects: FailoverSubject[] = [subject()]) {
    let clock = NOW;
    const rows: Array<{ at: number; role: string; meshId: string; mode: string }> = [];
    const staged: any[] = [];
    const notices: string[] = [];
    const metrics: string[] = [];
    const ports: QuotaFailoverPorts = {
        now: () => clock,
        subjects: async () => subjects,
        mode: () => 'notify',
        fallbackOrder: () => FALLBACK,
        quotaOf: (p) => ({ remainingPct: p === 'codex-cli' ? 80 : 50 }),
        isEligible: () => true,
        hasOpenCard: (_m, _r, sid) => staged.some(s => s.sessionId === sid),
        stage: (p) => { staged.push(p); return { id: `ctl-${staged.length}` }; },
        notify: (t) => { notices.push(t); },
        autoSwitch: vi.fn(async () => ({ success: true })),
        history: {
            autoCountSince: (role, meshId, since) => rows.filter(r => r.role === role && r.meshId === meshId && r.mode === 'auto' && r.at >= since).length,
            lastAt: (role, meshId) => rows.filter(r => r.role === role && r.meshId === meshId).reduce<number | null>((m, r) => (m === null || r.at > m ? r.at : m), null),
            record: (e) => { rows.push({ at: e.at, role: e.role, meshId: e.meshId, mode: e.mode }); },
        },
        metric: (c) => { metrics.push(c); },
        log: () => {},
        ...over,
    };
    return { t: new QuotaFailoverTicker(ports), ports, staged, notices, metrics, rows, advance: (ms: number) => { clock += ms; } };
}

describe('acceptance 7: policy', () => {
    it('notify (default): one card, one notice, no switch; the next tick does not stack a second card', async () => {
        const f = ticker();
        expect(await f.t.tick()).toEqual([{ subject: 'coordinator:mesh-1:coord-1', outcome: 'proposed', stagedId: 'ctl-1' }]);
        expect(f.staged[0]).toMatchObject({ kind: 'session_control', trigger: 'quota_exhausted', action: 'switch_provider', provider: 'codex-cli', quota: { fromProvider: 'claude-cli', toProvider: 'codex-cli', toRemainingPct: 80 } });
        expect(f.notices).toHaveLength(1);
        expect(f.notices[0]).toContain("owner's approval");
        expect(f.ports.autoSwitch).not.toHaveBeenCalled();
        expect(f.metrics).toEqual(['quota_failovers_proposed']);
        expect((await f.t.tick())[0]).toMatchObject({ outcome: 'skipped', why: 'card_open' });
        expect(f.staged).toHaveLength(1);
    });
    it('off never acts', async () => {
        const f = ticker({ mode: () => 'off' });
        expect((await f.t.tick())[0]).toMatchObject({ outcome: 'skipped', why: 'off' });
    });
    it('without a usable fallback only a notice goes out (once per hour), never a card', async () => {
        const f = ticker({ isEligible: () => false });
        expect((await f.t.tick())[0]).toMatchObject({ outcome: 'no_fallback' });
        await f.t.tick();
        expect(f.notices).toHaveLength(1);
        expect(f.notices[0]).toContain('no_fallback');
        expect(f.staged).toHaveLength(0);
        f.advance(61 * 60_000);
        await f.t.tick();
        expect(f.notices).toHaveLength(2);
    });
    it('auto: switches without a card, records it, and is capped at 2 per day and 6 hours apart', async () => {
        const f = ticker({ mode: () => 'auto' }, [subject({ resetsAt: undefined })]);
        expect((await f.t.tick())[0]).toMatchObject({ outcome: 'auto_done' });
        expect(f.ports.autoSwitch).toHaveBeenCalledTimes(1);
        expect(f.staged).toHaveLength(0);
        expect(f.metrics).toEqual(['quota_failovers_auto']);
        // cooldown: no second switch within 6 hours
        f.advance(FAILOVER_AUTO_COOLDOWN_MS - 1);
        expect((await f.t.tick())[0]).toMatchObject({ outcome: 'auto_blocked', why: 'cooldown' });
        f.advance(2);
        expect((await f.t.tick())[0]).toMatchObject({ outcome: 'auto_done' });
        expect(FAILOVER_AUTO_PER_DAY).toBe(2);
        // third within 24h: daily cap even after another cooldown
        f.advance(FAILOVER_AUTO_COOLDOWN_MS + 1);
        expect((await f.t.tick())[0]).toMatchObject({ outcome: 'auto_blocked', why: 'daily_cap' });
        expect(f.ports.autoSwitch).toHaveBeenCalledTimes(2);
        // a day after the first one it may act again
        f.advance(24 * 3600_000);
        expect((await f.t.tick())[0]).toMatchObject({ outcome: 'auto_done' });
    });
    it('a failed auto switch is not recorded (it may retry) and reports switch_failed', async () => {
        const f = ticker({ mode: () => 'auto', autoSwitch: vi.fn(async () => ({ success: false, code: 'provider_not_detected' })) });
        expect((await f.t.tick())[0]).toMatchObject({ outcome: 'auto_blocked', why: 'switch_failed' });
        expect(f.rows).toHaveLength(0);
    });
    it('roles are independent: a coordinator auto cap does not block the assistant', async () => {
        const f = ticker({ mode: () => 'auto' }, [subject(), subject({ role: 'assistant', meshId: '', sessionId: 'asst-1', project: 'assistant' })]);
        const out = await f.t.tick();
        expect(out.map(o => o.outcome)).toEqual(['auto_done', 'auto_done']);
    });
});

describe('acceptance 8: server content boundary', () => {
    it('failover/control data never appears in the cloud status payload', () => {
        const payload = buildCloudStatusReportPayload([{
            id: 's1', providerType: 'claude-cli', status: 'idle',
            stagedControl: { id: 'ctl-1', reason: 'quota_exhausted', interpretedFrom: 'switch the coordinator' },
            hostHandoff: { phase: 'frozen', handoffId: 'h1' }, failover: { state: 'proposed' },
            pendingSessionControl: { action: 'restart' },
        }], undefined, 1);
        const wire = JSON.stringify(payload);
        for (const needle of ['ctl-1', 'quota_exhausted', 'switch the coordinator', 'frozen', 'h1', 'proposed', 'restart']) expect(wire).not.toContain(needle);
    });
    it('status events carry no session-control or failover event', () => {
        for (const event of ['assistant:session_control', 'quota:failover_proposed', 'host:handoff_phase', 'agent:failover']) {
            expect(projectServerStatusEvent({ event, message: 'ctl-1 switch coordinator' } as never)).toBeNull();
        }
    });
    it('no status/ or server-bound module imports the control, failover or handoff modules', () => {
        const root = join(__dirname, '..', '..', 'src', 'status');
        const files: string[] = [];
        const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
        walk(root);
        expect(files.length).toBeGreaterThan(5);
        for (const f of files) {
            expect(readFileSync(f, 'utf8'), f).not.toMatch(/staged-control|session-control|quota-failover|host-handoff|coordinator-handoff-brief/);
        }
    });
});

describe('launch-defaults fallback order', () => {
    it('is part of the strict document schema: at most 3, distinct, not the entry\'s own provider', () => {
        const entry = (fallback: unknown) => ({ version: 1, revision: 2, coordinator: { provider: 'claude-cli', revision: 2, setBy: 'owner', setAt: 1, fallback }, history: [] });
        expect(isLaunchDefaultsDocument(entry([{ provider: 'codex-cli' }]))).toBe(true);
        expect(isLaunchDefaultsDocument(entry([{ provider: 'codex-cli' }, { provider: 'codex-cli' }]))).toBe(false);
        expect(isLaunchDefaultsDocument(entry([{ provider: 'claude-cli' }]))).toBe(false);
        expect(isLaunchDefaultsDocument(entry([{ provider: 'a' }, { provider: 'b' }, { provider: 'c' }, { provider: 'd' }]))).toBe(false);
        expect(isLaunchDefaultsDocument(entry([{ provider: '' }]))).toBe(false);
        expect(fallbackListIssue([])).toBeUndefined();
        // an older document with no fallback key stays valid
        expect(isLaunchDefaultsDocument({ version: 1, revision: 1, coordinator: { provider: 'claude-cli', revision: 1, setBy: 'owner', setAt: 1 }, history: [] })).toBe(true);
    });
    it('the store writes, preserves and clears the list under the same CAS', () => {
        const dir = mkdtempSync(join(tmpdir(), 'ld-fallback-'));
        try {
            const ports = {
                resolveAlias: (p: string) => p,
                getProvider: (type: string) => ({ type, category: 'cli', enabled: true, detected: true, assistant: { supported: true, toolRestriction: 'enforced' }, coordinator: 'supported' }),
            } as never;
            const store = new LaunchDefaultsStore(dir, ports);
            const base = { role: 'coordinator' as const, by: 'owner' as const, origin: 'owner' as const };
            const a = store.write({ ...base, selection: { provider: 'claude-cli' }, fallback: [{ provider: 'codex-cli' }, { provider: 'kimi-cli' }], expectedRevision: 0 });
            expect(a.ok && a.document.coordinator?.fallback).toEqual([{ provider: 'codex-cli' }, { provider: 'kimi-cli' }]);
            // a set without `fallback` keeps the list; a changed main provider drops itself from it
            const b = store.write({ ...base, selection: { provider: 'codex-cli' }, expectedRevision: 1 });
            expect(b.ok && b.document.coordinator?.fallback).toEqual([{ provider: 'kimi-cli' }]);
            const c = store.write({ ...base, selection: { provider: 'codex-cli' }, fallback: [], expectedRevision: 2 });
            expect(c.ok && c.document.coordinator?.fallback).toBeUndefined();
            expect(store.write({ ...base, selection: { provider: 'claude-cli' }, fallback: [{ provider: 'claude-cli' }], expectedRevision: 3 })).toMatchObject({ ok: false, code: 'invalid_args' });
            expect(store.read()).toMatchObject({ status: 'ok' });
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});

import { AssistantRegistry } from '../../src/assistant/assistant-registry.js';

describe('quota failover policy storage (assistant.json)', () => {
    it('defaults to unset (= notify), merges per role, ignores junk and survives a reload', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qf-registry-'));
        try {
            const reg = new AssistantRegistry({ configDir: dir });
            reg.bindSession({ sessionId: 'rt_1', cliType: 'claude-cli', workspace: join(dir, 'assistant'), at: 1 });
            expect(reg.read()?.quotaFailover).toBeUndefined();
            reg.updateSettings({ quotaFailover: { coordinator: 'auto' } });
            reg.updateSettings({ quotaFailover: { assistant: 'off' } });
            expect(new AssistantRegistry({ configDir: dir }).read()?.quotaFailover).toEqual({ assistant: 'off', coordinator: 'auto' });
            reg.updateSettings({ quotaFailover: { coordinator: 'bogus' as never } });
            expect(new AssistantRegistry({ configDir: dir }).read()?.quotaFailover).toEqual({ assistant: 'off' });
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});
