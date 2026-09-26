import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isTurnEvidence } from '@adhdev/mesh-shared';
import { DEFAULT_TURN_POLICY } from '../../src/mesh/turn-ledger/policy.js';
import {
    createComponentsProbeReader,
    probeEvidence,
    wantsTranscript,
    type TranscriptObservation,
    type TurnProbeRead,
} from '../../src/mesh/turn-ledger/probe.js';
import { isProbeDue, resolveProbeLocation, selectProbeTargets } from '../../src/mesh/turn-ledger/targets.js';
import type { TurnAttempt } from '../../src/mesh/turn-ledger/types.js';
import { SUMMARY, T0, dispatch, evd, ledgerOn, memDb } from './ledger-harness.js';

// C4 (C-W4): the coordinator probe maps a READ to EVIDENCE — the reducer is the
// only judge. Replaces the deleted PHASE-4 synth / assigned-row polls / acked-hold
// death backstop, which each decided on their own.

const P = DEFAULT_TURN_POLICY;

function attempt(over: Partial<TurnAttempt> = {}): TurnAttempt {
    return {
        attemptId: 'a1', scope: 'mesh_queue', meshId: 'm1', taskId: 't1', attemptNo: 0, sessionId: 's1', nodeId: 'n1',
        providerType: 'claude-cli', ownerDaemonId: 'dc', generation: 2, prevGeneration: null, dispatchNonce: 1, messageId: 'msg-1',
        consumeProfile: 'default', maxTaskRetries: 1, state: 'generating', suspension: null, redriveCount: 0, reclaimCount: 0,
        hollowCount: 0, livenessFailStreak: 0, lastLiveness: null, coordinator: { daemonId: 'dc', sessionId: 'coord' },
        acceptedAt: T0, deliveredAt: T0 + 100, consumedAt: T0 + 200, lastActivityAt: T0 + 300, weakSince: null,
        candidateNotifiedGeneration: null, lastNoProgressNoticeAt: null, notifiedAt: null, terminal: null, data: {},
        ...over,
    };
}

function obs(over: Partial<TranscriptObservation> = {}): TranscriptObservation {
    return { providerObservedStatus: 'idle', activeModal: false, selfAttributing: false, trailingActivity: 0, nativeRead: false, ...over };
}

const NOW = T0 + 60_000;
const ctx = { nowMs: NOW, observedBy: 'dc', policy: P };

function kinds(read: TurnProbeRead, a: TurnAttempt = attempt()): string[] {
    const out = probeEvidence(a, read, ctx);
    for (const ev of out) expect(isTurnEvidence(ev), `${ev.kind} passes the content guard`).toBe(true);
    return out.map((e) => (e.kind === 'liveness' ? `liveness:${e.result}` : e.kind));
}

describe('probeEvidence — read → evidence (pure, content-free)', () => {
    it('maps presence and read failures to liveness results', () => {
        expect(kinds({ presence: 'absent' })).toEqual(['liveness:dead']);
        expect(kinds({ presence: 'unknown' })).toEqual(['liveness:unknown']);
        expect(kinds({ presence: 'unknown' }, attempt({ lastLiveness: 'unknown' }))).toEqual([]); // once per streak
        expect(kinds({ presence: 'present', transcript: null })).toEqual(['liveness:read_failed']);
    });

    it('a busy worker is alive (+ transcript_activity only when the tail moved past lastActivityAt)', () => {
        expect(kinds({ presence: 'present', status: 'generating' })).toEqual(['liveness:alive']);
        expect(kinds({ presence: 'present', status: 'generating', transcript: obs({ providerObservedStatus: 'generating', newestActivityAt: T0 + 50_000 }) }))
            .toEqual(['liveness:alive', 'transcript_activity']);
        expect(kinds({ presence: 'present', status: 'generating', transcript: obs({ providerObservedStatus: 'generating', newestActivityAt: T0 + 300 }) }))
            .toEqual(['liveness:alive']);
    });

    it('idle + a final bubble dated in THIS turn → transcript_final{coordinator_probe} carrying live state, never a commit', () => {
        const out = probeEvidence(attempt(), { presence: 'present', status: 'idle', transcript: obs({ finalAssistantAt: T0 + 40_000, newestActivityAt: T0 + 55_000, trailingActivity: 1 }) }, { ...ctx, summary: SUMMARY });
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            kind: 'transcript_final', source: 'coordinator_probe', selfAttributing: false, nativeRead: false,
            live: { modal: false, adapterPending: false, trailingTool: true, newestActivityAt: T0 + 55_000 },
            messageAt: T0 + 40_000, summary: SUMMARY, attemptRef: { attemptId: 'a1', generation: 2 },
        });
    });

    it('a final bubble from BEFORE the turn start is a prior turn’s tail — no transcript_final', () => {
        expect(kinds({ presence: 'present', status: 'idle', transcript: obs({ finalAssistantAt: T0 + 150 }) })).toEqual(['liveness:alive']);
    });

    it('a scoped native marker admits even with no dated bubble', () => {
        expect(kinds({ presence: 'present', status: 'idle', transcript: obs({ nativeRead: true, nativeMarker: { outcome: 'completed' } }) })).toEqual(['transcript_final']);
    });

    it('idle with no final assistant: no_progress only once stalled past stallNoticeMs (and never with a parked modal)', () => {
        expect(kinds({ presence: 'present', status: 'idle', transcript: obs() })).toEqual(['liveness:alive']);
        const late = { ...ctx, nowMs: T0 + 300 + P.stallNoticeMs + 1 };
        expect(probeEvidence(attempt(), { presence: 'present', status: 'idle', transcript: obs() }, late).map((e) => e.kind)).toEqual(['no_progress']);
        expect(probeEvidence(attempt(), { presence: 'present', status: 'idle', transcript: obs({ activeModal: true }) }, late).map((e) => e.kind)).toEqual(['liveness']);
    });

    it('delivered/accepted: a post-delivery agent bubble is the consumed proof (retro turn_started); nothing otherwise', () => {
        const delivered = attempt({ state: 'delivered', consumedAt: null, lastActivityAt: null });
        expect(kinds({ presence: 'present', status: 'idle', transcript: obs({ newestAgentActivityAt: T0 + 5_000 }) }, delivered)).toEqual(['turn_started']);
        expect(kinds({ presence: 'present', status: 'idle', transcript: obs({ newestAgentActivityAt: T0 + 50 }) }, delivered)).toEqual([]);
    });

    it('eventIds are unique per probe and carry the current generation', () => {
        const a = probeEvidence(attempt(), { presence: 'absent' }, ctx)[0]!;
        const b = probeEvidence(attempt(), { presence: 'absent' }, { ...ctx, nowMs: NOW + 1 })[0]!;
        expect(a.eventId).not.toBe(b.eventId);
        expect(a.eventId).toContain(':g2:');
    });

    it('probe.ts decides nothing: it never imports the ledger / store or writes a turn table', () => {
        const src = readFileSync(join(import.meta.dirname, '../../src/mesh/turn-ledger/probe.ts'), 'utf8');
        expect(src).not.toMatch(/from '\.\/(ledger|store|reducer|effects)\.js'/);
        expect(src).not.toMatch(/\.observe\(|updateTaskStatus|INSERT|UPDATE turn_|DELETE FROM/);
    });
});

describe('wantsTranscript', () => {
    it('a busy status alone answers alive; transcript holds, idle, delivered and finalizing need the read', () => {
        expect(wantsTranscript(attempt(), ['liveness'], 'generating')).toBe(false);
        expect(wantsTranscript(attempt(), ['liveness', 'transcript_quiet'], 'generating')).toBe(true);
        expect(wantsTranscript(attempt(), [], 'idle')).toBe(true);
        expect(wantsTranscript(attempt({ state: 'delivered' }), [], 'generating')).toBe(true);
        expect(wantsTranscript(attempt({ state: 'finalizing' }), [], 'generating')).toBe(true);
    });
});

describe('probeDue targets (a ledger query)', () => {
    it('isProbeDue: forced, transcript holds every tick, quiet running/delivered attempts every authoritative window', () => {
        const quiet = T0 + 300 + P.quietWindowMs;
        expect(isProbeDue(attempt(), [], null, quiet - 1, P, false)).toBe(false);
        expect(isProbeDue(attempt(), [], null, quiet, P, false)).toBe(true);
        expect(isProbeDue(attempt(), [], quiet, quiet + 1_000, P, false)).toBe(false);
        expect(isProbeDue(attempt(), [], quiet, quiet + 60_000, P, false)).toBe(true);
        expect(isProbeDue(attempt(), ['weak_candidate'], T0, T0 + P.tickMs, P, false)).toBe(true);
        expect(isProbeDue(attempt({ state: 'suspended' }), [], null, T0 + 3_600_000, P, false)).toBe(false);
        expect(isProbeDue(attempt({ state: 'accepted' }), [], null, T0 + 3_600_000, P, false)).toBe(false);
        expect(isProbeDue(attempt({ scope: 'plain' }), [], null, T0 + 3_600_000, P, false)).toBe(false);
        expect(isProbeDue(attempt({ scope: 'plain' }), [], null, T0, P, true)).toBe(true);
    });

    it('selectProbeTargets only returns attempts this daemon owns, and writes nothing', () => {
        const db = memDb();
        const ledger = ledgerOn(db);
        ledger.observe(dispatch({ scope: 'mesh_queue' }));
        ledger.observe(evd('delivered', { messageId: 'msg-1', outcome: 'delivered', via: 'local' }, { source: 'input_service' }));
        const before = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
        const mine = selectProbeTargets({ store: ledger.store, selfDaemonId: 'daemon_dc', nowMs: T0 + P.quietWindowMs + 1, policy: P });
        const foreign = selectProbeTargets({ store: ledger.store, selfDaemonId: 'daemon_other', nowMs: T0 + P.quietWindowMs + 1, policy: P });
        expect((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n).toBe(before);
        expect(foreign).toEqual([]);
        // 'daemon_dc' is the same daemon as the ledger's 'dc' under another id form.
        expect(mine.map((t) => [t.attempt.attemptId, t.attempt.state, t.forced])).toEqual([['a1', 'delivered', false]]);
        expect(mine[0]!.holds.sort()).toEqual(['await_consume', 'await_turn', 'hard_ceiling']);
    });

    it('resolveProbeLocation: registry → local (no RPC); another daemon’s node → remote; no node → unknown', () => {
        const registry = new Set(['s-local']);
        const comps = {
            sessionRegistry: { has: (id: string) => registry.has(id) } as never,
            instanceManager: { getInstance: () => undefined } as never,
            resolveMesh: () => ({ nodes: [{ id: 'n-remote', daemonId: 'daemon_mach_remote', workspace: '/w' }, { id: 'n-self', daemonId: 'daemon_mach_self' }] }),
        };
        expect(resolveProbeLocation(comps, attempt({ sessionId: 's-local' }), 'daemon_mach_self')).toEqual({ kind: 'local' });
        expect(resolveProbeLocation(comps, attempt({ sessionId: 's-x', nodeId: 'n-remote' }), 'daemon_mach_self')).toEqual({ kind: 'remote', daemonId: 'daemon_mach_remote', workspace: '/w' });
        expect(resolveProbeLocation(comps, attempt({ sessionId: 's-x', nodeId: 'n-self' }), 'daemon_mach_self')).toEqual({ kind: 'local' });
        expect(resolveProbeLocation(comps, attempt({ sessionId: 's-x', nodeId: 'n-gone' }), 'daemon_mach_self')).toEqual({ kind: 'unknown' });
    });
});

describe('B4 locality — 0 get_status_metadata for the local node; 1 cached probe per remote daemon', () => {
    function components() {
        const handle = vi.fn(async (cmd: string) => (cmd === 'read_chat'
            ? { success: true, status: 'idle', providerObservedStatus: 'idle', messages: [] }
            : { success: true, status: { sessions: [] } }));
        const dispatchMeshCommand = vi.fn(async (_daemon: string, cmd: string) => (cmd === 'get_status_metadata'
            ? { success: true, status: { sessions: [{ id: 's-r1', status: 'generating' }, { id: 's-r2', status: 'generating' }] } }
            : { success: true, messages: [] }));
        return {
            handle,
            dispatchMeshCommand,
            comps: {
                sessionRegistry: { get: (id: string) => (id === 's-local' ? { sessionId: id, transport: 'pty', instanceKey: id } : undefined), list: () => [] },
                instanceManager: { getInstance: (id: string) => (id === 's-local' ? { getState: () => ({ status: 'generating' }) } : undefined) },
                commandHandler: { handle },
                dispatchMeshCommand,
                getMeshPeerConnectionStatus: () => ({ state: 'connected' }),
                transcriptReplicaStore: undefined,
            } as never,
        };
    }

    it('a local busy session is answered from the registry + instance — no command at all', async () => {
        const { comps, handle, dispatchMeshCommand } = components();
        const reader = createComponentsProbeReader(comps, { analyzer: () => obs() });
        const read = await reader.read(attempt({ sessionId: 's-local' }), { kind: 'local' }, ['liveness']);
        expect(read).toEqual({ presence: 'present', status: 'generating' });
        expect(handle).not.toHaveBeenCalled();
        expect(dispatchMeshCommand).not.toHaveBeenCalled();
    });

    it('a local session missing from the registry is absent, still with 0 get_status_metadata', async () => {
        const { comps, handle } = components();
        const reader = createComponentsProbeReader(comps, { analyzer: () => obs() });
        expect(await reader.read(attempt({ sessionId: 's-gone' }), { kind: 'local' }, [])).toEqual({ presence: 'absent' });
        expect(handle.mock.calls.filter((c) => c[0] === 'get_status_metadata')).toHaveLength(0);
    });

    it('two attempts on one remote daemon cost ONE get_status_metadata inside the 5 s cache', async () => {
        const { comps, dispatchMeshCommand } = components();
        const reader = createComponentsProbeReader(comps, { analyzer: () => obs(), now: () => T0 });
        const loc = { kind: 'remote' as const, daemonId: 'daemon_mach_remote' };
        expect(await reader.read(attempt({ sessionId: 's-r1' }), loc, ['liveness'])).toMatchObject({ presence: 'present', status: 'generating' });
        expect(await reader.read(attempt({ sessionId: 's-r2' }), loc, ['liveness'])).toMatchObject({ presence: 'present', status: 'generating' });
        expect(await reader.read(attempt({ sessionId: 's-r3' }), loc, ['liveness'])).toEqual({ presence: 'absent' });
        expect(dispatchMeshCommand.mock.calls.filter((c) => c[1] === 'get_status_metadata')).toHaveLength(1);
    });

    it('a disconnected peer is `unknown` without dialing', async () => {
        const { comps, dispatchMeshCommand } = components();
        (comps as { getMeshPeerConnectionStatus: () => unknown }).getMeshPeerConnectionStatus = () => ({ state: 'connecting' });
        const reader = createComponentsProbeReader(comps, { analyzer: () => obs() });
        expect(await reader.read(attempt({ sessionId: 's-r1' }), { kind: 'remote', daemonId: 'daemon_mach_remote' }, [])).toEqual({ presence: 'unknown' });
        expect(dispatchMeshCommand).not.toHaveBeenCalled();
    });
});

// Coordinator-held node state (mesh-node-git-state.ts): a remote session's
// presence / status comes from the member-PUSHED runtime summary the coordinator
// holds, not a per-tick get_status_metadata round trip. The live probe remains
// the fallback for members that do not push (older builds) or a stale hold, and
// transcript content still comes from the replica / read_chat.
describe('remote presence from the coordinator-held runtime', () => {
    function components() {
        const dispatchMeshCommand = vi.fn(async (_daemon: string, cmd: string) => (cmd === 'get_status_metadata'
            ? { success: true, status: { sessions: [{ id: 's-live', status: 'generating' }] } }
            : { success: true, status: 'idle', providerObservedStatus: 'idle', messages: [] }));
        return {
            dispatchMeshCommand,
            comps: {
                sessionRegistry: { get: () => undefined, list: () => [] },
                instanceManager: { getInstance: () => undefined },
                commandHandler: { handle: vi.fn() },
                dispatchMeshCommand,
                getMeshPeerConnectionStatus: () => ({ state: 'connected' }),
                transcriptReplicaStore: undefined,
            } as never,
        };
    }
    const loc = { kind: 'remote' as const, daemonId: 'daemon_mach_remote' };
    const statusCalls = (d: ReturnType<typeof components>['dispatchMeshCommand']) => d.mock.calls.filter((c) => c[1] === 'get_status_metadata');

    it('a live held list answers presence + status with ZERO get_status_metadata', async () => {
        const { comps, dispatchMeshCommand } = components();
        const readHeldSessions = vi.fn(() => ({ sessions: [{ id: 's1', status: 'generating' }], observedAt: T0 + 50_000 }));
        const reader = createComponentsProbeReader(comps, { analyzer: () => obs(), now: () => NOW, readHeldSessions });
        expect(await reader.read(attempt(), loc, ['liveness'])).toEqual({ presence: 'present', status: 'generating' });
        expect(readHeldSessions).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', meshId: 'm1', nodeId: 'n1' }), 'daemon_mach_remote');
        expect(statusCalls(dispatchMeshCommand)).toHaveLength(0);
    });

    it('an idle held session still reads the transcript (read_chat), but not the status list', async () => {
        const { comps, dispatchMeshCommand } = components();
        const reader = createComponentsProbeReader(comps, {
            analyzer: () => obs({ finalAssistantAt: T0 + 40_000 }),
            now: () => NOW,
            readHeldSessions: () => ({ sessions: [{ id: 's1', status: 'idle' }], observedAt: T0 + 50_000 }),
        });
        const read = await reader.read(attempt(), loc, []);
        expect(read).toMatchObject({ presence: 'present', status: 'idle', transcript: expect.objectContaining({ finalAssistantAt: T0 + 40_000 }) });
        expect(statusCalls(dispatchMeshCommand)).toHaveLength(0);
        expect(dispatchMeshCommand.mock.calls.filter((c) => c[1] === 'read_chat')).toHaveLength(1);
    });

    it('absent from a held list observed well after the turn boundary → absent, no live call', async () => {
        const { comps, dispatchMeshCommand } = components();
        const reader = createComponentsProbeReader(comps, {
            analyzer: () => obs(),
            now: () => NOW,
            readHeldSessions: () => ({ sessions: [{ id: 's-other', status: 'idle' }], observedAt: T0 + 50_000 }),
        });
        expect(await reader.read(attempt(), loc, [])).toEqual({ presence: 'absent' });
        expect(statusCalls(dispatchMeshCommand)).toHaveLength(0);
    });

    it('absent from a held list that predates the turn (a just-launched session may not be pushed yet) → live fallback', async () => {
        const { comps, dispatchMeshCommand } = components();
        const reader = createComponentsProbeReader(comps, {
            analyzer: () => obs(),
            now: () => NOW,
            // Observed only 1 s after consumedAt — inside the skew / push-debounce margin.
            readHeldSessions: () => ({ sessions: [{ id: 's-other', status: 'idle' }], observedAt: T0 + 1_200 }),
        });
        expect(await reader.read(attempt({ sessionId: 's-live' }), loc, ['liveness'])).toEqual({ presence: 'present', status: 'generating' });
        expect(statusCalls(dispatchMeshCommand)).toHaveLength(1);
    });

    it('no live hold (older member / stale / probe-only snapshot) → the live get_status_metadata answers', async () => {
        const { comps, dispatchMeshCommand } = components();
        const reader = createComponentsProbeReader(comps, { analyzer: () => obs(), now: () => NOW, readHeldSessions: () => null });
        expect(await reader.read(attempt({ sessionId: 's-live' }), loc, ['liveness'])).toEqual({ presence: 'present', status: 'generating' });
        expect(statusCalls(dispatchMeshCommand)).toHaveLength(1);
    });

    it('a disconnected peer stays `unknown` even when a hold exists (the R32u grace hold is unchanged)', async () => {
        const { comps, dispatchMeshCommand } = components();
        (comps as { getMeshPeerConnectionStatus: () => unknown }).getMeshPeerConnectionStatus = () => null;
        const reader = createComponentsProbeReader(comps, {
            analyzer: () => obs(),
            now: () => NOW,
            readHeldSessions: () => ({ sessions: [{ id: 's1', status: 'generating' }], observedAt: T0 + 50_000 }),
        });
        expect(await reader.read(attempt(), loc, [])).toEqual({ presence: 'unknown' });
        expect(dispatchMeshCommand).not.toHaveBeenCalled();
    });

    it('readLiveHeldRuntime trusts only a live member push of the SAME daemon', async () => {
        const { MeshNodeGitStateStore } = await import('../../src/mesh/mesh-node-git-state.js');
        const { readLiveHeldRuntime, MESH_NODE_STATE_STALE_MS } = await import('../../src/mesh/mesh-node-git-refresher.js');
        const now = 10_000_000;
        const store = new MeshNodeGitStateStore(null, () => now);
        const runtime = { sessions: [{ id: 's1', status: 'generating' }] };
        store.recordRuntimeObservation({ meshId: 'm1', nodeId: 'n1', workspace: '/w', runtime, source: 'member_push', observedAt: now - 60_000, daemonId: 'daemon_mach_remote' });
        expect(readLiveHeldRuntime(store, { meshId: 'm1', nodeId: 'n1', daemonId: 'daemon_mach_remote' }, now)?.runtime.sessions[0]).toMatchObject({ id: 's1', status: 'generating' });
        // Another daemon now serves the node → never answer for it.
        expect(readLiveHeldRuntime(store, { meshId: 'm1', nodeId: 'n1', daemonId: 'daemon_mach_other' }, now)).toBeNull();
        // The member stopped pushing.
        expect(readLiveHeldRuntime(store, { meshId: 'm1', nodeId: 'n1', daemonId: 'daemon_mach_remote' }, now + MESH_NODE_STATE_STALE_MS)).toBeNull();
        // A one-off coordinator probe snapshot is not maintained by anyone.
        store.recordRuntimeObservation({ meshId: 'm1', nodeId: 'n2', workspace: '/w2', runtime, source: 'coordinator_probe', observedAt: now - 1_000, daemonId: 'daemon_mach_remote' });
        expect(readLiveHeldRuntime(store, { meshId: 'm1', nodeId: 'n2', daemonId: 'daemon_mach_remote' }, now)).toBeNull();
    });
});
