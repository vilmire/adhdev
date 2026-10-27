import { reportMessageId } from '../../src/assistant/project-views.js';
/**
 * Missing-relay detector: a native final that no delivered relay part covers
 * gets one warn and one gap line. Open attempts are not flagged — capture
 * has not run yet.
 */
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { AssistantInputLog } from '../../src/assistant/assistant-input-log.js';
import { AssistantRelay, type RelayClock } from '../../src/assistant/assistant-relay.js';
import { collectCoordinatorReplies } from '../../src/assistant/assistant-relay-audit.js';
import type { AuditedCoordinatorReply } from '../../src/assistant/assistant-native-window.js';
import { InMemoryAssistantRelayStore } from '../../src/assistant/assistant-relay-store.js';
import { RELAY_QUIET_MS } from '../../src/assistant/assistant-relay-format.js';
import { ensureAssistantRelaySchema } from '../../src/mesh/mesh-runtime-store-schema.js';
import { ensureTurnLedgerSchema } from '../../src/mesh/turn-ledger/schema.js';
import { LOG } from '../../src/logging/logger.js';

vi.mock('../../src/config/mesh-config.js', () => ({ listMeshesReadOnly: () => [{ id: 'mesh' }] }));
vi.mock('../../src/mesh/coordinator-registry.js', () => ({
    listCoordinatorsForMesh: () => ['coord-none', 'coord-in', 'coord-boot', 'coord-open'].map(sessionId => ({ sessionId, meshId: 'mesh', cliType: 'codex-cli' })),
    getCoordinatorForSession: () => ({ cliType: 'codex-cli' }),
}));

class FakeClock implements RelayClock {
    t = Date.parse('2026-10-17T05:00:00Z');
    private timers: Array<{ at: number; fn: () => void; id: number }> = [];
    private next = 1;
    now() { return this.t; }
    setTimeout(fn: () => void, ms: number) { const id = this.next++; this.timers.push({ at: this.t + ms, fn, id }); return id; }
    clearTimeout(h: unknown) { this.timers = this.timers.filter((x) => x.id !== h); }
    advance(ms: number) {
        const end = this.t + ms;
        for (;;) {
            const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
            if (!due) break;
            this.timers = this.timers.filter((x) => x !== due);
            this.t = due.at;
            due.fn();
        }
        this.t = end;
    }
}

const TEXT = 'Yes, every task except one is pinned to Claude (claude-cli). None of them names a model.';
const AT = Date.parse('2026-10-17T05:15:06Z');

function makeRelay(opts: { audit: () => Promise<readonly AuditedCoordinatorReply[]>; report?: unknown }) {
    const clock = new FakeClock();
    const submits: string[] = [];
    let onEvent: (e: any) => void = () => {};
    const relay = new AssistantRelay({
        subscribe: (fn) => { onEvent = fn; return () => {}; },
        coordinatorMeshOf: () => 'mesh',
        projectSlug: () => 'blog',
        rehydrateAttemptReport: async () => (opts.report ?? 'covered body') as never,
        auditCoordinatorReplies: async () => (await opts.audit()).map(r => ({ ...r, messageId: reportMessageId({ role: 'assistant', timestamp: r.messageAt, content: r.text }) })),
        canReadCoordinatorReply: async () => true,
        meshWork: () => ({ activeMissions: 1, pending: 0, assigned: 1 }),
        hasAssistant: () => true,
        assistantSessionId: () => 'asst',
        isAssistantReady: () => true,
        submit: async (_sid, input) => { submits.push(input.text); return { kind: 'delivered' }; },
        inputLog: new AssistantInputLog(),
        store: new InMemoryAssistantRelayStore(),
        clock,
        // Full-push behavior under test; the notice pull is covered by relay-nudge.test.ts.
        maxNudgeAttempts: 0,
    });
    relay.start();
    relay.openThread('mesh');
    return { relay, clock, submits, onEvent: (e: any) => onEvent(e) };
}

async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

async function deliver(h: ReturnType<typeof makeRelay>) {
    h.clock.advance(RELAY_QUIET_MS);
    await flush();
    await h.relay.idle();
}

describe('relay missing detector', () => {
    it('native final with no attempt → gap notice, once', async () => {
        const reply: AuditedCoordinatorReply = { sessionId: 'coord', messageAt: AT, chars: TEXT.length, text: TEXT, attemptId: null };
        const audit = vi.fn(async () => [reply]);
        const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
        const h = makeRelay({ audit });
        h.relay.tick(h.clock.now() + 60_000);
        await flush();
        await h.relay.idle();
        expect(h.submits).toHaveLength(1);
        expect(h.submits[0]).toContain('[ADHDev relay gap]');
        expect(h.submits[0]).toContain('no_attempt');
        expect(h.submits[0]).toContain('05:15:06');
        expect(warn).toHaveBeenCalledWith('Assistant', expect.stringContaining('class=no_attempt'));
        h.submits.length = 0;
        h.relay.tick(h.clock.now() + 120_000);
        await flush();
        await h.relay.idle();
        expect(h.submits).toHaveLength(0);
        warn.mockRestore();
        h.relay.stop();
    });

    it('flags inside_attempt and restart_closed, and skips open or empty bubbles', async () => {
        const audit = vi.fn(async () => [
            { sessionId: 'coord', messageAt: AT, chars: 4, text: 'open', attemptId: 'plain:open', attemptOpen: true },
            { sessionId: 'coord', messageAt: AT + 1, chars: 0, text: '', attemptId: null },
            { sessionId: 'coord', messageAt: AT + 2, chars: 11, text: 'inside text', attemptId: 'plain:done' },
            { sessionId: 'coord', messageAt: AT + 3, chars: 8, text: 'restarted', attemptId: 'plain:boot', restartClosed: true },
        ] satisfies AuditedCoordinatorReply[]);
        const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
        const h = makeRelay({ audit });
        h.relay.tick(h.clock.now() + 60_000);
        await flush();
        await h.relay.idle();
        const text = h.submits.join('\n');
        expect(text).toContain('inside_attempt');
        expect(text).toContain('restart_closed');
        expect(text).not.toContain('no_attempt');
        expect(warn.mock.calls.map((c) => String(c[1]))).toEqual(expect.arrayContaining([
            expect.stringContaining('class=inside_attempt'),
            expect.stringContaining('class=restart_closed'),
        ]));
        expect(warn.mock.calls.filter((c) => String(c[1]).includes('class=no_attempt'))).toHaveLength(0);
        warn.mockRestore();
        h.relay.stop();
    });

    it('treats a multi-reply capture as covering each part, and a last-only capture as a gap', async () => {
        const mid = 'Earlier reply inside the same attempt.';
        const last = 'The last reply, which is all a truncated capture kept.';
        const midAt = AT;
        const lastAt = AT + 20_000;
        const audit = vi.fn(async () => [
            { sessionId: 'coord', messageAt: midAt, chars: mid.length, text: mid, attemptId: 'plain:coord:e1' },
            { sessionId: 'coord', messageAt: lastAt, chars: last.length, text: last, attemptId: 'plain:coord:e1' },
        ] satisfies AuditedCoordinatorReply[]);
        const body = `[reply 1/2 · 05:15:06]\n${mid}\n\n[reply 2/2 · 05:15:26]\n${last}`;
        const h = makeRelay({
            audit,
            report: { body, completeness: 'final_native', parts: [{ at: midAt, chars: mid.length }, { at: lastAt, chars: last.length }] },
        });
        h.onEvent({ kind: 'turn', phase: 'committed', sessionId: 'coord', attemptId: 'plain:coord:e1', generation: 0, at: h.clock.now(), outcome: 'completed', strength: 'genuine' });
        await deliver(h);
        h.submits.length = 0;
        const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {});
        h.relay.tick(h.clock.now() + 60_000);
        await flush();
        await h.relay.idle();
        expect(h.submits).toHaveLength(0);
        h.relay.stop();

        const lastOnly = makeRelay({
            audit,
            report: { body: last, completeness: 'final_native', parts: [{ at: lastAt, chars: last.length }] },
        });
        lastOnly.onEvent({ kind: 'turn', phase: 'committed', sessionId: 'coord', attemptId: 'plain:coord:e1', generation: 0, at: lastOnly.clock.now(), outcome: 'completed', strength: 'genuine' });
        await deliver(lastOnly);
        lastOnly.submits.length = 0;
        lastOnly.relay.tick(lastOnly.clock.now() + 60_000);
        await flush();
        await lastOnly.relay.idle();
        expect(lastOnly.submits.join('\n')).toContain('inside_attempt');
        expect(lastOnly.submits.join('\n')).toContain('05:15:06');
        expect(lastOnly.submits.join('\n')).not.toContain(last);
        warn.mockRestore();
        lastOnly.relay.stop();
    });
});

describe('collectCoordinatorReplies', () => {
    it('classifies no_attempt, inside_attempt, restart_closed and skips tool bubbles and open attempts', async () => {
        const db = new Database(':memory:');
        ensureAssistantRelaySchema(db);
        ensureTurnLedgerSchema(db);
        const insert = db.prepare(`INSERT INTO turn_attempts
            (attempt_id, scope, session_id, owner_daemon_id, state, accepted_at, terminal_at, terminal_reason, terminal_source, created_at, updated_at)
            VALUES (?, 'plain', ?, 'host', ?, ?, ?, ?, ?, ?, ?)`);
        insert.run('a-out', 'coord-none', 'completed', AT - 50_000, AT - 40_000, 'turn_end', 'completion_flush_genuine', AT - 50_000, AT - 40_000);
        insert.run('a-in', 'coord-in', 'completed', AT - 1000, AT + 5000, 'turn_end', 'completion_flush_genuine', AT - 1000, AT);
        insert.run('a-boot', 'coord-boot', 'completed', AT - 1000, AT + 1000, 'session_error', 'session_registry', AT - 1000, AT);
        insert.run('a-open', 'coord-open', 'running', AT - 1000, null, null, null, AT - 1000, AT);
        const messages: Record<string, unknown[]> = {
            'coord-none': [{ role: 'assistant', timestamp: AT, content: TEXT }, { role: 'assistant', kind: 'tool', timestamp: AT, content: 'tool only' }],
            'coord-in': [{ role: 'assistant', timestamp: AT, content: 'inside' }],
            'coord-boot': [{ role: 'assistant', timestamp: AT, content: 'closed by boot' }],
            'coord-open': [{ role: 'assistant', timestamp: AT, content: 'still open' }],
        };
        const replies = await collectCoordinatorReplies({
            db, sinceMs: AT - 1000, now: AT + 60_000,
            execute: async (_cmd, args) => ({ success: true, coverage: 'full', messageSource: { selected: 'native-history' }, debugReadChat: { provider: 'codex-cli' },
                messages: (messages[String(args.targetSessionId)] ?? []).map(m => ({ bubbleState: 'final', ...(m as object) })) }),
        });
        const bySession = Object.fromEntries(replies.map((r) => [r.sessionId, r]));
        expect(bySession['coord-none']).toMatchObject({ attemptId: null, text: TEXT });
        expect(bySession['coord-in']?.attemptId).toBe('a-in');
        expect(bySession['coord-in']?.attemptOpen).toBeUndefined();
        expect(bySession['coord-in']?.restartClosed).toBeUndefined();
        expect(bySession['coord-boot']).toMatchObject({ attemptId: 'a-boot', restartClosed: true });
        expect(bySession['coord-open']).toMatchObject({ attemptId: 'a-open', attemptOpen: true });
        expect(replies.some((r) => r.text === 'tool only')).toBe(false);
        db.close();
    });
});
