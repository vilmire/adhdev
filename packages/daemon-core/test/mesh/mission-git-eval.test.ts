import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Design 2026-11-01-mission-git-refs §8 acceptance 1, 4-6, 8-11 (+ close-candidate wording): the stored
// projection over REAL git repositories. Config/ledger I/O is isolated to a temp dir.
const testConfigDir = join(tmpdir(), `adhdev-mission-git-eval-${randomUUID().slice(0, 8)}`, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));
const meshConfigMocks = vi.hoisted(() => ({ getMesh: vi.fn(), getMeshByRepo: vi.fn(), listMeshes: vi.fn(() => [] as any[]) }));
vi.mock('../../src/config/mesh-config.js', () => ({
    getMesh: meshConfigMocks.getMesh, getMeshByRepo: meshConfigMocks.getMeshByRepo, listMeshes: meshConfigMocks.listMeshes,
}));

import { getMeshMission, upsertMeshMission, maybeEmitMissionCloseCandidate } from '../../src/mesh/mesh-missions.js';
import { upsertStructuredMission } from '../../src/mesh/mesh-mission-structured.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { enqueueTask, __clearMeshQueueForTests, __writeTaskStatusForTests } from '../../src/mesh/mesh-work-queue.js';
import { buildMissionRenderBlockForTest } from './mission-git-prompt-helper.js';
import {
    MISSION_GIT_EVAL_TTL_MS, evaluateMissionGitState, readMissionGitState,
} from '../../src/mesh/mesh-mission-git-eval.js';
import { MAX_EVALUATED_REFS_PER_MISSION, type MissionRefEvalEnv, type RemoteRefProber } from '../../src/mesh/mission-ref-evaluator.js';
import { evaluateActiveMissionsAfterRefine, scheduleStaleGitRefresh } from '../../src/mesh/mission-git-triggers.js';
import { getPendingMeshCoordinatorEvents, __clearMeshPendingEventsForTests } from '../helpers/pending-notices.js';
import { git, makeFixture, type MissionGitFixture } from './mission-git-fixture.js';

let meshId = '';
let fx: MissionGitFixture;
const store = () => MeshRuntimeStore.getInstance();
const env = (over: Partial<MissionRefEvalEnv> = {}): MissionRefEvalEnv => ({ defaultBranch: 'main', localRepos: [fx.work], ...over });
const gitEvents = (missionId: string) => store().missionItems().listEvents(meshId, missionId, { types: ['git_state_changed'], limit: 100 });

function mission(refs: Array<{ kind: 'commit' | 'branch'; value: string; repo?: string }>, opts: { status?: string; perItem?: number } = {}): string {
    const itemsAdd: unknown[] = [];
    const per = opts.perItem ?? 1;
    for (let i = 0; i < refs.length; i += per) {
        itemsAdd.push({ kind: 'evidence', text: `evidence ${i}`, refs: refs.slice(i, i + per), dedupe_key: `ev-${i}` });
    }
    const { record } = upsertStructuredMission(meshId, { title: 'M', goal: 'g', status: opts.status ?? 'active', itemsAdd });
    return record.id;
}

/** A feature commit that is merged (ancestor) into origin/main, and one that never landed. */
function landedAndNot(): { landed: string; notLanded: string } {
    git(fx.work, 'checkout', '-q', '-b', 'done');
    const landed = fx.commit('done.txt', 'd\n', 'done work');
    git(fx.work, 'checkout', '-q', 'main');
    git(fx.work, 'merge', '-q', '--no-ff', '-m', 'merge done', 'done');
    git(fx.work, 'checkout', '-q', '-b', 'pending');
    const notLanded = fx.commit('pending.txt', 'p\n', 'pending work');
    git(fx.work, 'checkout', '-q', 'main');
    git(fx.work, 'push', '-q', 'origin', 'main');
    return { landed, notLanded };
}

beforeEach(() => { meshId = `mission-git-${randomUUID().slice(0, 8)}`; fx = makeFixture(); });
afterEach(() => {
    fx.cleanup();
    __clearMeshQueueForTests(meshId);
    try { __clearMeshPendingEventsForTests(meshId); } catch { /* fresh store */ }
    try { store().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
    MeshRuntimeStore.resetForTests();
    vi.clearAllMocks();
});
afterEach(() => { try { rmSync(dirname(testConfigDir), { recursive: true, force: true }); } catch { /* best effort */ } });

describe('projection (acceptance 1, 4, 5)', () => {
    it('landed / not_landed / partial / partial+unknown / unknown / no_refs', async () => {
        const { landed, notLanded } = landedAndNot();
        const bogus = 'deadbeef'.repeat(5);
        const a = mission([{ kind: 'commit', value: landed }]);
        const b = mission([{ kind: 'commit', value: notLanded }]);
        const c = mission([{ kind: 'commit', value: landed }, { kind: 'commit', value: notLanded }]);
        const d = mission([{ kind: 'commit', value: landed }, { kind: 'commit', value: bogus }]);
        const e = mission([{ kind: 'commit', value: bogus }]);
        const f = mission([]);
        const states = Object.fromEntries(await Promise.all([a, b, c, d, e, f].map(async (id, i) => [i, await evaluateMissionGitState(meshId, id, env())])));
        expect(states[0]).toMatchObject({ state: 'landed', counts: { contained: 1, total: 1 } });
        expect(states[1]).toMatchObject({ state: 'not_landed' });
        expect(states[2]).toMatchObject({ state: 'partial', partialUnknown: false });
        expect(states[3]).toMatchObject({ state: 'partial', partialUnknown: true });
        expect(states[4]).toMatchObject({ state: 'unknown' });
        expect(states[4].refs[0].status).toBe('unknown'); // never folded into not_contained
        expect(states[5]).toMatchObject({ state: 'no_refs' });
        expect(states[0].baseRef).toBe('origin/main');
        expect(states[0].baseSha).toBe(git(fx.work, 'rev-parse', 'origin/main'));
    });

    it('pr / url / task refs are not evaluated; decision-item refs do not vote', async () => {
        const { record } = upsertStructuredMission(meshId, {
            title: 'M', goal: 'g', status: 'active',
            itemsAdd: [{ kind: 'evidence', text: 'pr', refs: [{ kind: 'pr', value: '42' }, { kind: 'url', value: 'https://example.invalid' }] }],
        });
        expect((await evaluateMissionGitState(meshId, record.id, env())).state).toBe('no_refs');
    });
});

describe('branch pinning (acceptance 6)', () => {
    it('a branch is pinned at first evaluation and re-evaluated by that SHA after the branch is deleted', async () => {
        git(fx.work, 'checkout', '-q', '-b', 'feat');
        const tip = fx.commit('f.txt', 'f\n', 'feat');
        git(fx.work, 'push', '-q', 'origin', 'feat');
        git(fx.work, 'checkout', '-q', 'main');
        git(fx.work, 'merge', '-q', '--no-ff', '-m', 'merge feat', 'feat');
        git(fx.work, 'push', '-q', 'origin', 'main');
        const id = mission([{ kind: 'branch', value: 'feat' }]);
        const first = await evaluateMissionGitState(meshId, id, env());
        expect(first.state).toBe('landed');
        expect(first.refs[0].pinnedSha).toBe(tip);

        git(fx.work, 'branch', '-D', 'feat');
        git(fx.work, 'push', '-q', 'origin', '--delete', 'feat');
        git(fx.work, 'fetch', '-q', '--prune', 'origin');
        expect(() => git(fx.work, 'rev-parse', '--verify', 'feat')).toThrow();
        const second = await evaluateMissionGitState(meshId, id, env());
        expect(second.state).toBe('landed');
        expect(second.refs[0].pinnedSha).toBe(tip);
    });

    it('an unresolvable branch with no pin is unknown(branch_not_found); the base branch name itself is not evidence', async () => {
        const id = mission([{ kind: 'branch', value: 'ghost' }, { kind: 'branch', value: 'main' }]);
        const s = await evaluateMissionGitState(meshId, id, env());
        const reasons = s.refs.map(r => r.detail?.unknownReason).sort();
        expect(reasons).toEqual(['base_branch_ref', 'branch_not_found']);
        expect(s.state).toBe('unknown');
    });
});

describe('landed never changes the mission (acceptance 8)', () => {
    it('mission row, items and version are identical before and after evaluation; only a git_state_changed event is added', async () => {
        const { landed } = landedAndNot();
        const id = mission([{ kind: 'commit', value: landed }]);
        const snap = () => JSON.stringify({ m: getMeshMission(meshId, id), items: store().missionItems().listItems(meshId, id) });
        const before = snap();
        const state = await evaluateMissionGitState(meshId, id, env());
        expect(state.state).toBe('landed');
        expect(snap()).toBe(before);
        expect(getMeshMission(meshId, id)?.status).toBe('active');
    });

    it('the close-candidate hint gains a git-evidence sentence when landed (and not otherwise); status stays active', async () => {
        const { landed, notLanded } = landedAndNot();
        meshConfigMocks.getMesh.mockReturnValue({ id: meshId, name: 'M', policy: {}, nodes: [] });
        const withGit = async (ref: string) => {
            const id = mission([{ kind: 'commit', value: ref }]);
            await evaluateMissionGitState(meshId, id, env());
            const t = enqueueTask(meshId, 'task', { missionId: id, difficulty: 'medium' });
            __writeTaskStatusForTests(meshId, t.id, 'completed');
            expect(maybeEmitMissionCloseCandidate(meshId, id)).toBe(true);
            expect(getMeshMission(meshId, id)?.status).toBe('active');
            const ev = getPendingMeshCoordinatorEvents(meshId).filter(e => e.event === 'mission_close_candidate' && (e.metadataEvent as any).missionId === id);
            return String((ev[0] as any).coordinatorMessage ?? '');
        };
        expect(await withGit(landed)).toContain('Git evidence');
        expect(await withGit(notLanded)).not.toContain('Git evidence');
    });

    it('the coordinator prompt line says "Git: landed" without implying completion', async () => {
        const { landed } = landedAndNot();
        const id = mission([{ kind: 'commit', value: landed }]);
        await evaluateMissionGitState(meshId, id, env());
        const block = buildMissionRenderBlockForTest(meshId, id);
        expect(block).toContain('Git: landed');
        expect(block.length).toBeLessThanOrEqual(600);
    });
});

describe('events only on transitions (acceptance 9)', () => {
    it('one git_state_changed per transition; an unchanged re-evaluation writes none', async () => {
        const { landed, notLanded } = landedAndNot();
        const id = mission([{ kind: 'commit', value: landed }]);
        await evaluateMissionGitState(meshId, id, env());
        expect(gitEvents(id)).toHaveLength(1);
        expect(gitEvents(id)[0].payload).toMatchObject({ from: 'none', to: 'landed' });
        await evaluateMissionGitState(meshId, id, env());
        await evaluateMissionGitState(meshId, id, env());
        expect(gitEvents(id)).toHaveLength(1);

        // A new unlanded ref turns it partial: exactly one more event.
        upsertStructuredMission(meshId, { id, itemsAdd: [{ kind: 'evidence', text: 'more', refs: [{ kind: 'commit', value: notLanded }], dedupe_key: 'more' }] });
        await evaluateMissionGitState(meshId, id, env());
        expect(gitEvents(id)).toHaveLength(2);
        expect(gitEvents(id)[1].payload).toMatchObject({ from: 'landed', to: 'partial' });
    });

    it('a mission with no refs never records an event', async () => {
        const id = mission([]);
        await evaluateMissionGitState(meshId, id, env());
        expect(gitEvents(id)).toHaveLength(0);
    });
});

describe('TTL, budget, concurrency, triggers (acceptance 10)', () => {
    it('cached verdicts are fresh for the TTL and stale after it; a mission never evaluated is stale', async () => {
        const { landed } = landedAndNot();
        const id = mission([{ kind: 'commit', value: landed }]);
        expect(readMissionGitState(meshId, id)).toMatchObject({ state: 'unknown', stale: true });
        await evaluateMissionGitState(meshId, id, env());
        const now = Date.now();
        expect(readMissionGitState(meshId, id, now).stale).toBe(false);
        expect(readMissionGitState(meshId, id, now + MISSION_GIT_EVAL_TTL_MS - 5_000).stale).toBe(false);
        expect(readMissionGitState(meshId, id, now + MISSION_GIT_EVAL_TTL_MS + 5_000).stale).toBe(true);
    });

    it(`refs beyond ${MAX_EVALUATED_REFS_PER_MISSION} become unknown(budget)`, async () => {
        const refs = Array.from({ length: MAX_EVALUATED_REFS_PER_MISSION + 3 }, (_, i) => ({ kind: 'commit' as const, value: (i.toString(16).padStart(2, '0') + 'ab').repeat(10) }));
        const id = mission(refs, { perItem: 8 });
        const s = await evaluateMissionGitState(meshId, id, env());
        expect(s.counts.total).toBe(MAX_EVALUATED_REFS_PER_MISSION + 3);
        expect(s.refs.filter(r => r.detail?.unknownReason === 'budget')).toHaveLength(3);
    });

    it('evaluation runs one mission at a time, and concurrent callers for one mission share a run', async () => {
        let active = 0;
        let maxActive = 0;
        let calls = 0;
        const remote: RemoteRefProber = {
            nodes: [{ nodeId: 'n1', daemonId: 'd1' }],
            probe: async () => { calls++; active++; maxActive = Math.max(maxActive, active); await new Promise(r => setTimeout(r, 40)); active--; return null; },
        };
        const bogus1 = 'deadbeef'.repeat(5);
        const bogus2 = 'cafebabe'.repeat(5);
        const m1 = mission([{ kind: 'commit', value: bogus1 }]);
        const m2 = mission([{ kind: 'commit', value: bogus2 }]);
        const e = env({ remote });
        await Promise.all([evaluateMissionGitState(meshId, m1, e), evaluateMissionGitState(meshId, m2, e), evaluateMissionGitState(meshId, m1, e)]);
        expect(maxActive).toBe(1);
        expect(calls).toBe(2); // m1 evaluated once for its two callers
    });

    it('after a Refinery push only ACTIVE missions that have refs are re-evaluated, with a fetch (G2); a plain evaluation does not fetch', async () => {
        const { landed } = landedAndNot();
        const active = mission([{ kind: 'commit', value: landed }]);
        const done = mission([{ kind: 'commit', value: landed }], { status: 'completed' });
        const noRefs = mission([]);
        await evaluateMissionGitState(meshId, active, env());
        const staleBase = readMissionGitState(meshId, active).baseSha;

        // Someone else pushes to origin/main; this clone's remote-tracking ref is behind.
        const other = join(fx.root, 'other');
        git(fx.root, 'clone', '-q', fx.origin, other);
        writeFileAndPush(other);
        const newOrigin = git(fx.origin, 'rev-parse', 'main');
        expect(newOrigin).not.toBe(staleBase);

        await evaluateMissionGitState(meshId, active, env()); // no fetch: base stays behind (G2)
        expect(readMissionGitState(meshId, active).baseSha).toBe(staleBase);

        const mesh = { id: meshId, defaultBranch: 'main', nodes: [{ id: 'n', workspace: fx.work, daemonId: 'self' }] };
        const evaluated = await evaluateActiveMissionsAfterRefine(meshId, mesh, { selfDaemonId: 'self' });
        expect(evaluated).toEqual([active]);
        expect(readMissionGitState(meshId, active).baseSha).toBe(newOrigin); // fetched
        expect(readMissionGitState(meshId, done).refs).toHaveLength(0);
        expect(readMissionGitState(meshId, noRefs).refs).toHaveLength(0);
    });

    it('a lazy read refresh evaluates a stale mission in the background without fetching', async () => {
        const { landed } = landedAndNot();
        const id = mission([{ kind: 'commit', value: landed }]);
        meshConfigMocks.getMesh.mockReturnValue({ id: meshId, defaultBranch: 'main', nodes: [{ id: 'n', workspace: fx.work, daemonId: 'self' }] });
        scheduleStaleGitRefresh(meshId, [id], { selfDaemonId: 'self' });
        await vi.waitFor(() => expect(readMissionGitState(meshId, id).state).toBe('landed'));
    });
});

describe('member-node probe fallback (acceptance 11, decision G1)', () => {
    it('the host evaluates itself first; when it lacks the object a member node answer is used', async () => {
        const sha = 'deadbeef'.repeat(5);
        const probes: string[] = [];
        const remote: RemoteRefProber = {
            nodes: [{ nodeId: 'win', daemonId: 'd-win' }, { nodeId: 'lin', daemonId: 'd-lin' }],
            probe: async (daemonId) => {
                probes.push(daemonId);
                return daemonId === 'd-win' ? null : [{ value: sha, status: 'contained_ancestor', method: 'ancestry', baseRef: 'origin/main', baseSha: 'b'.repeat(40) }];
            },
        };
        const id = mission([{ kind: 'commit', value: sha }]);
        const s = await evaluateMissionGitState(meshId, id, env({ remote }));
        expect(probes).toEqual(['d-win', 'd-lin']); // offline node skipped, next one asked
        expect(s.state).toBe('landed');
        expect(s.refs[0].detail?.nodeId).toBe('lin');
    });

    it('a host-local answer wins without asking any member; all members offline → unknown(node_offline), never not_contained', async () => {
        const { landed } = landedAndNot();
        let asked = 0;
        const remote: RemoteRefProber = { nodes: [{ nodeId: 'n', daemonId: 'd' }], probe: async () => { asked++; return null; } };
        const local = mission([{ kind: 'commit', value: landed }]);
        expect((await evaluateMissionGitState(meshId, local, env({ remote }))).state).toBe('landed');
        expect(asked).toBe(0);

        const missing = mission([{ kind: 'commit', value: 'deadbeef'.repeat(5) }]);
        const s = await evaluateMissionGitState(meshId, missing, env({ remote }));
        expect(s.refs[0]).toMatchObject({ status: 'unknown', detail: { unknownReason: 'node_offline' } });
    });
});

function writeFileAndPush(clone: string): void {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(join(clone, 'later.txt'), 'later\n');
    git(clone, 'add', 'later.txt');
    git(clone, 'commit', '-q', '-m', 'later main commit');
    git(clone, 'push', '-q', 'origin', 'main');
}
