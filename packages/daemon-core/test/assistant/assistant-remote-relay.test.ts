/**
 * Remote-hosted projects, the assistant daemon's half (owner decision
 * 2026-10-08): who hosts a mesh and whether it is reachable
 * (assistant-remote-host.ts `describeRemoteHost`), one host call with every
 * transport failure folded into `project_unreachable` (`callRemoteHost`, over a
 * fake `dispatchMeshCommand`), and the result path — the poller feeding the
 * host's committed coordinator turns into the real `AssistantRelay`, which
 * delivers the same `[ADHDev relay · project <slug> · <outcome>] … [/relay]`
 * card as a local relay, and an `unreachable` card when the host stops
 * answering (never a silent drop).
 */
import { describe, expect, it, vi } from 'vitest';
import { STATUS_PROBE_ARG_KEY, type SendPolicy } from '@adhdev/mesh-shared';
import { AssistantInputLog } from '../../src/assistant/assistant-input-log.js';
import { InMemoryAssistantRelayStore } from '../../src/assistant/assistant-relay-store.js';
import { AssistantRelay, type RelayClock } from '../../src/assistant/assistant-relay.js';
import { RELAY_QUIET_MS } from '../../src/assistant/assistant-relay-format.js';
import {
    ASSISTANT_REMOTE_PROJECT_COMMAND, REMOTE_OP_TIMEOUT_MS, callRemoteHost, describeRemoteHost, resolveHostMeshId,
    type RemoteCallOutcome, type RemoteHostView,
} from '../../src/assistant/assistant-remote-host.js';
import { AssistantRemoteRelayPoller, POLL_BACKOFF_MS, UNREACHABLE_AFTER_FAILURES } from '../../src/assistant/assistant-remote-relay.js';
import type { LocalMeshEntry } from '../../src/repo-mesh-types.js';
import { REQUEST_TIMEOUT_MS, resultTimeoutForCommand } from '../../src/mesh/transport/mesh-rpc-timeouts.js';

const SELF = 'daemon_mach_member000001';
const HOST = 'daemon_mach_host00000001';

const memberMesh = (extra: Record<string, unknown> = {}): LocalMeshEntry => ({
    id: 'mesh_local', name: 'Blog', repoIdentity: 'github.com/acme/blog',
    meshHost: { role: 'member', hostDaemonId: HOST, ...extra },
    nodes: [
        { id: 'n-host', workspace: '/w/blog', daemonId: HOST, machineNickname: 'win-box' },
        { id: 'n-self', workspace: '/m/blog', daemonId: SELF },
    ],
} as unknown as LocalMeshEntry);

describe('describeRemoteHost', () => {
    const dispatch = vi.fn();

    it('names the host and is reachable with a transport (a cloud peer opens on demand)', () => {
        expect(describeRemoteHost(memberMesh(), SELF, { dispatch, peerStatus: () => null }))
            .toEqual({ label: 'win-box', hostDaemonId: HOST, hostMeshId: 'mesh_local', reachable: true });
        expect(describeRemoteHost(memberMesh(), SELF, { dispatch, peerStatus: () => ({ state: 'connecting' }) }).reachable).toBe(true);
    });

    it('is unreachable with a reason: no transport, host link down where the link IS presence, host unknown', () => {
        expect(describeRemoteHost(memberMesh(), SELF, {})).toMatchObject({ reachable: false, reason: 'no_mesh_transport' });
        expect(describeRemoteHost(memberMesh(), SELF, { dispatch, peerStatus: () => ({ state: 'disconnected', linkIsPresence: true }) }))
            .toMatchObject({ reachable: false, reason: 'host_offline', label: 'win-box' });
        expect(describeRemoteHost(memberMesh(), SELF, { dispatch, peerStatus: () => ({ state: 'connected', linkIsPresence: true }) }).reachable).toBe(true);
        const noHost = { ...memberMesh(), meshHost: { role: 'member' } } as unknown as LocalMeshEntry;
        expect(describeRemoteHost(noHost, SELF, { dispatch })).toMatchObject({ reachable: false, reason: 'host_unknown', hostDaemonId: null });
    });

    it('addresses the host by the id it keys the mesh by', () => {
        expect(describeRemoteHost(memberMesh({ hostMeshId: 'mesh_on_host' }), SELF, { dispatch }).hostMeshId).toBe('mesh_on_host');
        // Pre-existing pairing (no persisted id): the member peer-secret record for this host names it.
        expect(resolveHostMeshId(memberMesh(), HOST, () => ['mesh_on_host'])).toBe('mesh_on_host');
        expect(resolveHostMeshId(memberMesh(), HOST, () => ['mesh_local', 'mesh_x'])).toBe('mesh_local');
        expect(resolveHostMeshId(memberMesh(), HOST, () => ['mesh_x', 'mesh_y'])).toBe('mesh_local'); // ambiguous → own id
    });
});

describe('callRemoteHost (fake dispatchMeshCommand)', () => {
    const target = { hostDaemonId: HOST, hostMeshId: 'mesh_on_host' };

    it('sends assistant_remote_project to the HOST under its mesh id and unwraps the answer', async () => {
        const dispatch = vi.fn(async () => ({ result: { success: true, result: { status: 'queued' } } }));
        const out = await callRemoteHost({ dispatch }, target, 'send', { text: 'hi', clientId: 'c1' });
        expect(out).toEqual({ ok: true, result: { success: true, result: { status: 'queued' } } });
        expect(dispatch).toHaveBeenCalledWith(HOST, ASSISTANT_REMOTE_PROJECT_COMMAND, { text: 'hi', clientId: 'c1', meshId: 'mesh_on_host', op: 'send' });
    });

    it('the transport ceiling for the verb covers the longest op (a send may launch the coordinator first)', () => {
        expect(resultTimeoutForCommand(ASSISTANT_REMOTE_PROJECT_COMMAND)).toBeGreaterThanOrEqual(REMOTE_OP_TIMEOUT_MS.send);
        expect(resultTimeoutForCommand(ASSISTANT_REMOTE_PROJECT_COMMAND)).toBeGreaterThan(REQUEST_TIMEOUT_MS);
    });

    it('a poll carries the status-probe marker (short connect wait for an offline host)', async () => {
        const dispatch = vi.fn(async () => ({ success: true }));
        await callRemoteHost({ dispatch }, target, 'poll', {});
        expect((dispatch.mock.calls[0] as any[])[2]).toMatchObject({ op: 'poll', [STATUS_PROBE_ARG_KEY]: true });
    });

    it('folds every transport failure into project_unreachable with a reason', async () => {
        const offline = await callRemoteHost({ dispatch: async () => { throw new Error('P2P target daemon offline'); } }, target, 'status');
        expect(offline).toMatchObject({ ok: false, kind: 'unreachable', code: 'project_unreachable', reason: 'host_offline' });
        const slow = await callRemoteHost({ dispatch: () => new Promise(() => {}) }, target, 'status', {}, { timeoutMs: 20 });
        expect(slow).toMatchObject({ ok: false, kind: 'unreachable', reason: 'relay_timeout' });
        const structured = await callRemoteHost({ dispatch: async () => ({ success: false, code: 'p2p_not_connected', error: 'peer not connected' }) }, target, 'status');
        expect(structured).toMatchObject({ ok: false, kind: 'unreachable', reason: 'relay_failed' });
        expect(await callRemoteHost({}, target, 'status')).toMatchObject({ ok: false, reason: 'no_mesh_transport' });
        expect(await callRemoteHost({ dispatch: vi.fn() }, { hostDaemonId: null, hostMeshId: 'x' }, 'status')).toMatchObject({ ok: false, reason: 'host_unknown' });
        expect(await callRemoteHost({ dispatch: async () => 'garbage' }, target, 'status')).toMatchObject({ ok: false, reason: 'relay_failed' });
    });

    it('a host refusal keeps the host\'s code; an old host without the verb is host_unsupported', async () => {
        const refused = await callRemoteHost({ dispatch: async () => ({ success: false, code: 'mesh_sender_not_on_roster', error: 'mesh_sender_not_on_roster' }) }, target, 'send');
        expect(refused).toMatchObject({ ok: false, kind: 'refused', code: 'mesh_sender_not_on_roster' });
        const old = await callRemoteHost({ dispatch: async () => ({ success: false, error: `Unknown command: ${ASSISTANT_REMOTE_PROJECT_COMMAND}` }) }, target, 'send');
        expect(old).toMatchObject({ ok: false, kind: 'refused', code: 'host_unsupported' });
    });
});

// ── result path: poller → AssistantRelay ────────────────────────────────────

class FakeClock implements RelayClock {
    t = Date.parse('2026-10-08T12:00:00Z');
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

const MESH = 'mesh_local';
const TARGET: RemoteHostView = { label: 'win-box', hostDaemonId: HOST, hostMeshId: 'mesh_on_host', reachable: true };

function harness() {
    const clock = new FakeClock();
    const store = new InMemoryAssistantRelayStore();
    const submits: Array<{ sessionId: string; text: string; messageId: string; policy: SendPolicy }> = [];
    const localTail = vi.fn(async () => 'LOCAL TAIL — must not be used for a remote project');
    const relay = new AssistantRelay({
        subscribe: () => () => {},
        coordinatorMeshOf: () => null,
        projectSlug: (m) => (m === MESH ? 'blog' : null),
        readCoordinatorTail: localTail,
        meshStatusLine: () => '[Mesh] LOCAL',
        meshWork: () => null,
        hasAssistant: () => true,
        assistantSessionId: () => 'asst',
        isAssistantReady: () => true,
        submit: async (sessionId, input) => { submits.push({ sessionId, ...input }); return { kind: 'delivered' }; },
        inputLog: new AssistantInputLog(),
        store,
        clock,
    });
    relay.start();
    let answer: (args: { afterAttemptId?: string }) => RemoteCallOutcome = () => ({ ok: true, result: { success: true, commits: [] } as any });
    const poll = vi.fn(async (_t: RemoteHostView, args: { afterAttemptId?: string }) => answer(args));
    let target: RemoteHostView | null = TARGET;
    const poller = new AssistantRemoteRelayPoller({
        openThreads: () => store.openThreads().map((t) => ({ meshId: t.meshId, lastSendAt: t.lastSendAt })),
        remoteTarget: () => target,
        poll,
        relay,
        now: () => clock.now(),
    });
    return {
        clock, store, submits, relay, poller, poll, localTail,
        setAnswer: (fn: typeof answer) => { answer = fn; },
        setTarget: (t: RemoteHostView | null) => { target = t; },
    };
}

const ok = (r: Record<string, unknown>): RemoteCallOutcome => ({ ok: true, result: { success: true, ...r } as any });

describe('remote relay poller → AssistantRelay', () => {
    it('relays the host\'s committed turn after the send with the host\'s reply, in the usual card', async () => {
        const h = harness();
        h.relay.openThread(MESH);
        h.poller.noteSent(MESH, 'plain:coord:old');
        h.setAnswer((args) => {
            expect(args).toEqual({ afterAttemptId: 'plain:coord:old' });
            return ok({
                coordinatorSessionId: 'coord', open: false, modal: false, cursor: 'plain:coord:new', cursorFound: true,
                commits: [{ attemptId: 'plain:coord:new', outcome: 'completed', ageMs: 2_000 }],
                body: 'Done: RSS feed fixed and merged.', work: { activeMissions: 0, pending: 0, assigned: 0 }, statusLine: '[Mesh] idle',
            });
        });
        await h.poller.tick();
        h.clock.advance(RELAY_QUIET_MS + 1);
        await h.relay.idle();
        expect(h.submits).toHaveLength(1);
        const text = h.submits[0]!.text;
        expect(text.split('\n')[0]).toBe('[ADHDev relay · project blog · completed]');
        expect(text).toContain('Done: RSS feed fixed and merged.');
        expect(text).toContain('[Mesh] idle');
        expect(text).toContain('[idle]');
        expect(text.trim().endsWith('[/relay]')).toBe(true);
        expect(h.localTail).not.toHaveBeenCalled();
        expect(h.submits[0]!.messageId).toBe(`relay:${MESH}:plain:coord:new`);

        // Next poll starts from the new cursor; the same commit is never relayed twice.
        h.setAnswer((args) => {
            expect(args).toEqual({ afterAttemptId: 'plain:coord:new' });
            return ok({ coordinatorSessionId: 'coord', commits: [{ attemptId: 'plain:coord:new', outcome: 'completed', ageMs: 9_000 }], cursor: 'plain:coord:new', cursorFound: false });
        });
        await h.poller.tick();
        h.clock.advance(RELAY_QUIET_MS + 1);
        await h.relay.idle();
        expect(h.submits).toHaveLength(1);
    });

    it('without a usable cursor only commits younger than the last send are relayed (host-clock ages)', async () => {
        const h = harness();
        h.relay.openThread(MESH);
        h.clock.advance(30_000); // the send was 30 s ago (this daemon restarted since: no cursor)
        h.setAnswer(() => ok({
            coordinatorSessionId: 'coord', cursor: 'plain:coord:after', cursorFound: false,
            commits: [
                { attemptId: 'plain:coord:before', outcome: 'completed', ageMs: 600_000 },
                { attemptId: 'plain:coord:after', outcome: 'completed', ageMs: 10_000 },
            ],
            body: 'the answer',
        }));
        await h.poller.tick();
        h.clock.advance(RELAY_QUIET_MS + 1);
        await h.relay.idle();
        expect(h.submits).toHaveLength(1);
        expect(h.submits[0]!.messageId).toBe(`relay:${MESH}:plain:coord:after`);
        expect(h.submits[0]!.text).not.toContain('earlier turn'); // the pre-send turn was not folded in
        expect(h.store.listUndelivered()).toEqual([]);
    });

    it('a host that stops answering yields ONE unreachable card, backs off, and resumes when it answers', async () => {
        const h = harness();
        h.relay.openThread(MESH);
        h.poller.noteSent(MESH, null);
        h.setAnswer(() => ({ ok: false, kind: 'unreachable', code: 'project_unreachable', reason: 'host_offline', error: 'offline' }));
        for (let i = 0; i < UNREACHABLE_AFTER_FAILURES + 2; i++) await h.poller.tick();
        await h.relay.idle();
        expect(h.poll).toHaveBeenCalledTimes(UNREACHABLE_AFTER_FAILURES); // backed off after the card
        expect(h.submits).toHaveLength(1);
        const card = h.submits[0]!.text;
        expect(card.split('\n')[0]).toBe('[ADHDev relay · project blog · unreachable]');
        expect(card).toContain('win-box');
        expect(card).toContain('the host machine is offline');
        expect(card.trim().endsWith('[/relay]')).toBe(true);

        h.clock.advance(POLL_BACKOFF_MS + 1);
        h.setAnswer(() => ok({ coordinatorSessionId: 'coord', cursor: 'plain:coord:1', cursorFound: false, commits: [{ attemptId: 'plain:coord:1', outcome: 'completed', ageMs: 1_000 }], body: 'back' }));
        await h.poller.tick();
        h.clock.advance(RELAY_QUIET_MS + 1);
        await h.relay.idle();
        expect(h.submits).toHaveLength(2);
        expect(h.submits[1]!.text).toContain('back');
    });

    it('a target already known unreachable (offline host / no transport) also surfaces as a card, without a call', async () => {
        const h = harness();
        h.relay.openThread(MESH);
        h.setTarget({ ...TARGET, reachable: false, reason: 'no_mesh_transport' });
        for (let i = 0; i < UNREACHABLE_AFTER_FAILURES; i++) await h.poller.tick();
        await h.relay.idle();
        expect(h.poll).not.toHaveBeenCalled();
        expect(h.submits[0]!.text).toMatch(/^\[ADHDev relay · project blog · unreachable\]/);
    });

    it('locally hosted or closed threads are not polled; a modal on the host raises the approval signal once', async () => {
        const h = harness();
        h.setTarget(null);
        h.relay.openThread(MESH);
        await h.poller.tick();
        expect(h.poll).not.toHaveBeenCalled();
        h.setTarget(TARGET);
        h.setAnswer(() => ok({ coordinatorSessionId: 'coord', open: true, modal: true, commits: [], cursor: null, cursorFound: false }));
        await h.poller.tick();
        await h.poller.tick();
        await h.relay.idle();
        expect(h.submits.map((s) => s.text)).toEqual(['[project blog] waiting for an approval or a choice — the user can answer it in the Inbox.']);
        h.store.closeThread(MESH, h.clock.now());
        h.poll.mockClear();
        await h.poller.tick();
        expect(h.poll).not.toHaveBeenCalled();
    });
});
