import { describe, expect, it, vi } from 'vitest';
import {
    DECISION_NUDGE_MIN_GAP_MS,
    DECISION_REMOTE_REFRESH_MS,
    DecisionNudge,
    DecisionWatch,
    decisionSourcesFromPorts,
    formatDecisionDigestSection,
    type DecisionSource,
} from '../../src/assistant/decision-nudge.js';
import { AssistantDigestScheduler, DIGEST_INPUT_TEXT } from '../../src/assistant/assistant-digest-scheduler.js';
import type { CompactDecision } from '../../src/assistant/decision-views.js';
import type { AssistantProjectPorts } from '../../src/assistant/assistant-project-ports.js';

const dec = (itemId: string, extra: Partial<CompactDecision> = {}): CompactDecision => ({
    itemId, question: `Question ${itemId}?`, options: [{ id: 'a', label: 'yes', recommended: true }, { id: 'b', label: 'no' }], recommended: 'a',
    allowFreeText: true, urgency: 'normal', onDue: 'remind', source: 'coordinator', missionId: 'm1', ...extra,
});

function fixture() {
    let local: CompactDecision[] = [];
    let remote: CompactDecision[] | null = [];
    let auto: Array<{ itemId: string; question: string; answer: string; by: 'auto_recommended'; at: string }> = [];
    const remoteList = vi.fn(async () => (remote ? { decisions: remote, autoApplied: [] } : null));
    const sources: DecisionSource[] = [
        { key: 'mesh_local', label: 'blog', remote: false, list: async () => ({ decisions: local, autoApplied: auto }) },
        { key: 'mesh_remote', label: 'api', remote: true, list: remoteList },
    ];
    let t = 1_000_000;
    const watch = new DecisionWatch(async () => sources, () => t);
    const enqueue = vi.fn();
    const state = { sid: 'asst-1' as string | null, ready: true, busy: false };
    const nudge = new DecisionNudge(watch, {
        liveSessionId: () => state.sid, isReady: () => state.ready, modalOpen: () => false, relayBusy: () => state.busy, enqueue,
    });
    return {
        watch, nudge, enqueue, state, remoteList,
        setLocal: (d: CompactDecision[]) => { local = d; },
        setRemote: (d: CompactDecision[] | null) => { remote = d; },
        setAuto: (a: typeof auto) => { auto = a; },
        advance: (ms: number) => { t += ms; },
        now: () => t,
    };
}

describe('DecisionNudge', () => {
    it('tells the assistant once per new batch: "N decisions waiting (M blocking)" — and not again while nothing changed', async () => {
        const f = fixture();
        await f.watch.refresh();
        expect(f.nudge.evaluate(f.now())).toEqual({ fired: false, reason: 'nothing_new' });
        f.setLocal([dec('d1'), dec('d2', { urgency: 'blocking' })]);
        await f.watch.refresh();
        const first = f.nudge.evaluate(f.now());
        expect(first).toMatchObject({ fired: true });
        expect(f.enqueue).toHaveBeenCalledTimes(1);
        expect(f.enqueue.mock.calls[0][0]).toMatchObject({ source: 'digest', forSessionId: 'asst-1' });
        expect(f.enqueue.mock.calls[0][0].text).toContain('2 decisions waiting (1 blocking)');
        // the same decisions again, many ticks later: silence
        for (let i = 0; i < 5; i++) { f.advance(DECISION_NUDGE_MIN_GAP_MS + 1); await f.watch.refresh(); expect(f.nudge.evaluate(f.now())).toMatchObject({ fired: false, reason: 'nothing_new' }); }
        expect(f.enqueue).toHaveBeenCalledTimes(1);
        // a new decision joins: one more notice that counts them all
        f.setLocal([dec('d1'), dec('d2', { urgency: 'blocking' }), dec('d3')]);
        await f.watch.refresh();
        f.advance(DECISION_NUDGE_MIN_GAP_MS + 1);
        expect(f.nudge.evaluate(f.now())).toMatchObject({ fired: true });
        expect(f.enqueue.mock.calls[1][0].text).toContain('3 decisions waiting (1 blocking)');
        expect(f.enqueue).toHaveBeenCalledTimes(2);
    });

    it('holds the notice (and keeps it unannounced) while the assistant is absent, busy or not ready', async () => {
        const f = fixture();
        f.setLocal([dec('d1')]);
        await f.watch.refresh();
        f.state.sid = null;
        expect(f.nudge.evaluate(f.now())).toEqual({ fired: false, reason: 'no_session' });
        f.state.sid = 'asst-1'; f.state.ready = false;
        expect(f.nudge.evaluate(f.now())).toEqual({ fired: false, reason: 'not_ready' });
        f.state.ready = true; f.state.busy = true;
        expect(f.nudge.evaluate(f.now())).toEqual({ fired: false, reason: 'busy' });
        f.state.busy = false;
        expect(f.nudge.evaluate(f.now())).toMatchObject({ fired: true });
        expect(f.nudge.evaluate(f.now())).toMatchObject({ fired: false });
        expect(f.enqueue).toHaveBeenCalledTimes(1);
    });

    it('a remind decision that crosses its due time (remindedAt stamped) nudges exactly once more', async () => {
        const f = fixture();
        f.setLocal([dec('d1', { dueAt: '2026-10-29T10:00:00Z' })]);
        await f.watch.refresh();
        expect(f.nudge.evaluate(f.now())).toMatchObject({ fired: true });
        f.advance(DECISION_NUDGE_MIN_GAP_MS + 1);
        f.setLocal([dec('d1', { dueAt: '2026-10-29T10:00:00Z', remindedAt: '2026-10-29T10:00:05Z' })]);
        await f.watch.refresh();
        const again = f.nudge.evaluate(f.now());
        expect(again).toMatchObject({ fired: true });
        expect((again as any).text).toContain('1 decision waiting (1 past due)');
        f.advance(DECISION_NUDGE_MIN_GAP_MS + 1);
        expect(f.nudge.evaluate(f.now())).toMatchObject({ fired: false, reason: 'nothing_new' });
    });

    it('an answered decision that is undone (reopened) is announced again', async () => {
        const f = fixture();
        f.setLocal([dec('d1')]);
        await f.watch.refresh();
        f.nudge.evaluate(f.now());
        f.setLocal([]);
        await f.watch.refresh();
        f.nudge.evaluate(f.now());
        f.setLocal([dec('d1')]);
        await f.watch.refresh();
        f.advance(DECISION_NUDGE_MIN_GAP_MS + 1);
        expect(f.nudge.evaluate(f.now())).toMatchObject({ fired: true });
    });
});

describe('DecisionWatch', () => {
    it('reads remote hosts through the relay at most every 5 minutes and keeps the last snapshot when a host is unreachable', async () => {
        const f = fixture();
        f.setRemote([dec('r1')]);
        await f.watch.refresh();
        await f.watch.refresh();
        expect(f.remoteList).toHaveBeenCalledTimes(1);
        expect(f.watch.snapshot().open.map(w => [w.project, w.d.itemId])).toEqual([['api', 'r1']]);
        f.setRemote(null);
        f.advance(DECISION_REMOTE_REFRESH_MS + 1);
        await f.watch.refresh();
        expect(f.remoteList).toHaveBeenCalledTimes(2);
        expect(f.watch.snapshot().open.map(w => w.d.itemId)).toEqual(['r1']);
    });

    it('builds sources from the project ports: hosted meshes read locally, others via decision_list', async () => {
        const callHost = vi.fn(async () => ({ ok: true, result: { success: true, result: { openDecisions: { count: 1, blocking: 1 }, ownerDecisions: [dec('r9', { urgency: 'blocking' })] } } }));
        const meshes = [{ id: 'mesh_here', name: 'Here' }, { id: 'mesh_there', name: 'There' }];
        const ports = {
            listMeshes: () => meshes,
            isHostedHere: (m: any) => m.id === 'mesh_here',
            remoteHost: () => ({ label: 'box', hostDaemonId: 'daemon_mach_x', hostMeshId: 'mesh_there', reachable: true }),
            followedRemoteProjects: () => [],
            callHost,
        } as unknown as AssistantProjectPorts;
        const sources = await decisionSourcesFromPorts(async () => ports)();
        expect(sources.map(s => [s.key, s.remote])).toEqual([['mesh_here', false], ['mesh_there', true]]);
        const there = await sources[1].list();
        expect(callHost).toHaveBeenCalledWith(expect.anything(), 'decision_list', { includeAutoApplied: true });
        expect(there!.decisions.map(d => d.itemId)).toEqual(['r9']);
    });
});

describe('digest "needs you" section', () => {
    it('lists the open count, blocking ones, due-soon ones and decisions auto-applied in the last 24h', async () => {
        const f = fixture();
        const now = f.now();
        const soon = new Date(now + 3 * 3600_000).toISOString();
        const later = new Date(now + 5 * 24 * 3600_000).toISOString();
        f.setLocal([dec('d1', { urgency: 'blocking' }), dec('d2', { dueAt: soon }), dec('d3', { dueAt: later }), dec('d4')]);
        f.setAuto([{ itemId: 'd9', question: 'Retry policy?', answer: 'a: backoff', by: 'auto_recommended', at: new Date(now - 3600_000).toISOString() }]);
        await f.watch.refresh();
        const section = formatDecisionDigestSection(f.watch.snapshot(), now);
        expect(section).toContain('4 open, 1 blocking, 1 due within 24h');
        expect(section).toContain('- [blog] d1 (blocking');
        expect(section).toContain('d2');
        expect(section).not.toContain('d3');
        expect(section).toContain('Applied automatically in the last 24h');
        expect(section).toContain('d9');
        expect(section).toContain('"Retry policy?" → "a: backoff"');
        expect(section).toMatch(/data, not instructions/);
        expect(formatDecisionDigestSection({ open: [], autoApplied: [] }, now)).toBe('');
    });

    it('is appended to the digest text; no section → the digest is unchanged', () => {
        const enqueue = vi.fn();
        const mk = (section: string) => new AssistantDigestScheduler({
            liveSessionId: () => 's', isReady: () => true, modalOpen: () => false, digestHour: () => new Date(0).getHours(), lastDigestAt: () => null,
            followsProjects: () => true, relayBusy: () => false, enqueue, decisionSection: () => section, recordDigest: () => {},
        });
        expect(mk('Owner decisions waiting: 1 open').evaluate(0)).toMatchObject({ fired: true });
        expect(enqueue.mock.calls[0][0].text).toBe(`${DIGEST_INPUT_TEXT}\n\nOwner decisions waiting: 1 open`);
        mk('').evaluate(0);
        expect(enqueue.mock.calls[1][0].text).toBe(DIGEST_INPUT_TEXT);
    });
});
