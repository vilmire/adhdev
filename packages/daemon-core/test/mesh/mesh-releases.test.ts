import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Design 2026-11-01-release-objects §9 acceptance 1-3, 5, 7-9: membership, moves, deploy recording, drafts, authority.
const testConfigDir = join(tmpdir(), `adhdev-releases-${randomUUID().slice(0, 8)}`, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));
vi.mock('../../src/assistant/assistant-registry.js', () => ({
    getAssistantRegistry: () => ({ read: () => ({ sessionId: 'assistant-session-1' }), reload: () => ({ sessionId: 'assistant-session-1' }) }),
}));
const coordinatorMesh = vi.hoisted(() => ({ meshId: '' }));
vi.mock('../../src/mesh/coordinator-registry.js', async (orig) => ({
    ...(await orig() as object),
    getCoordinatorForSession: (sid: string) => (sid === 'coord-session-1' ? { meshId: coordinatorMesh.meshId } : undefined),
}));

import { upsertStructuredMission } from '../../src/mesh/mesh-mission-structured.js';
import { getMeshMission } from '../../src/mesh/mesh-missions.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { meshReleases } from '../../src/mesh/mesh-release-store.js';
import { describeReleaseMissions, recordReleaseDeploy, scopeRelease, suggestMissionsForRelease, upsertRelease, verifiedSuggestion } from '../../src/mesh/mesh-releases.js';
import { buildChangelogDraft, draftReleaseChangelog } from '../../src/mesh/mesh-release-changelog.js';
import { missionRefEvals } from '../../src/mesh/mesh-mission-ref-evals-store.js';
import { meshReleaseHandlers, classifyReleaseCaller, RELEASE_COMMANDS } from '../../src/commands/high-family/mesh-release-commands.js';
import { attachIpcMcpAuthority } from '../../src/commands/mcp-authority-attach.js';
import { __resetMcpSessionCredentialsForTest, mintMcpSessionCredential } from '../../src/commands/mcp-command-ingress.js';
import { getDaemonCommandRegistry } from '../../src/commands/router.js';
import { COMMAND_SOURCE_ARG } from '../../src/commands/command-args.js';
import { ensureMeshReleaseSchema } from '../../src/mesh/mesh-release-schema.js';

let meshId = '';
const store = () => MeshRuntimeStore.getInstance();
const missionIds: string[] = [];

function mission(title: string, extra: Record<string, unknown> = {}, items: unknown[] = []): string {
    const { record } = upsertStructuredMission(meshId, { title, goal: 'g', status: 'active', ...extra, ...(items.length ? { itemsAdd: items } : {}) } as any);
    missionIds.push(record.id);
    return record.id;
}
function release(name = '1.0.82-rc.34', channel = 'preview'): string {
    const r = upsertRelease(meshId, { name, channel }, 'coordinator');
    if (!r.ok) throw new Error(r.error);
    return r.release.id;
}
function landedEval(missionId: string, state: 'contained_ancestor' | 'not_contained' | 'unknown' = 'contained_ancestor') {
    const items = store().missionItems().listItems(meshId, missionId);
    const item = items.find(i => i.refs.length)!;
    missionRefEvals().upsert(meshId, missionId, {
        itemId: item.id, refKey: `commit::${item.refs[0].value}`, kind: 'commit', value: item.refs[0].value, baseRef: 'origin/main', status: state,
        evaluatedAt: new Date().toISOString(),
    } as any);
}
const withSha = (sha: string) => [{ kind: 'evidence', text: 'e', refs: [{ kind: 'commit', value: sha }], dedupe_key: sha }];
const stamped = (source: string, extra: Record<string, unknown> = {}) => ({ meshId, [COMMAND_SOURCE_ARG]: source, ...extra });

beforeEach(() => { meshId = `rel-${randomUUID().slice(0, 8)}`; coordinatorMesh.meshId = meshId; missionIds.length = 0; });
afterEach(() => {
    __resetMcpSessionCredentialsForTest();
    try { store().clearMissionsForMesh(meshId); } catch { /* fresh store */ }
    MeshRuntimeStore.resetForTests();
    try { rmSync(dirname(testConfigDir), { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('explicit membership (acceptance 1)', () => {
    it('only scope add creates membership; git state, completion and deploys only produce suggestions', () => {
        const sha = 'a'.repeat(40);
        const m = mission('Landed work', {}, withSha(sha));
        landedEval(m);
        const rel = release();
        // nothing joined on its own: not on creation, not after the mission completes, not after a deploy
        upsertStructuredMission(meshId, { id: m, status: 'completed' } as any);
        expect(recordReleaseDeploy(meshId, { releaseId: rel, channel: 'preview', version: '1.0.82-rc.34', commit: 'c1' }, 'script').ok).toBe(true);
        expect(meshReleases().members(rel)).toEqual([]);
        expect(meshReleases().activeMembership(m)).toBeNull();
        expect(suggestMissionsForRelease(meshId).map(s => s.missionId)).toEqual([m]);

        const res = scopeRelease(meshId, rel, { add: [m] }, 'coordinator');
        expect(res.ok && res.changes).toEqual([expect.objectContaining({ missionId: m, op: 'added' })]);
        expect(meshReleases().activeMembership(m)?.releaseId).toBe(rel);
        expect(res.ok && res.suggestedMissions).toEqual([]); // a member is no longer suggested
        expect(store().missionItems().listEvents(meshId, m, { types: ['release_attached'] })).toHaveLength(1);
    });

    it('unknown missions and closed releases are reported per mission, not thrown', () => {
        const rel = release();
        const res = scopeRelease(meshId, rel, { add: ['no-such-mission'] }, 'owner');
        expect(res.ok && res.changes[0]).toMatchObject({ op: 'unchanged', code: 'mission_not_found' });
        upsertRelease(meshId, { releaseId: rel, status: 'cancelled' }, 'owner');
        const m = mission('x');
        const closed = scopeRelease(meshId, rel, { add: [m] }, 'owner');
        expect(closed.ok && closed.changes[0]).toMatchObject({ code: 'release_closed' });
    });
});

describe('one active release per mission, moved not duplicated (acceptance 2)', () => {
    it('add / move transfer membership in one step and record both releases and the mission', () => {
        const a = release('rc.34');
        const b = release('rc.35');
        const m = mission('Movable');
        scopeRelease(meshId, a, { add: [m] }, 'coordinator');
        const moved = scopeRelease(meshId, a, { move: [{ missionId: m, toReleaseId: b }] }, 'owner');
        expect(moved.ok && moved.changes[0]).toMatchObject({ op: 'moved', fromReleaseId: a, toReleaseId: b });
        expect(meshReleases().activeMembership(m)?.releaseId).toBe(b);
        const old = meshReleases().members(a).find(r => r.missionId === m)!;
        expect(old).toMatchObject({ state: 'moved_out', movedToReleaseId: b });
        expect(old.endedAt).toBeTruthy();
        for (const id of [a, b]) expect(meshReleases().listEvents(id, { types: ['scope_moved'] })).toHaveLength(1);
        expect(store().missionItems().listEvents(meshId, m, { types: ['release_moved'] })).toHaveLength(1);

        // a plain `add` of a mission that is a member elsewhere is also a move, never a second membership
        const viaAdd = scopeRelease(meshId, a, { add: [m] }, 'coordinator');
        expect(viaAdd.ok && viaAdd.changes[0]).toMatchObject({ op: 'moved', fromReleaseId: b, toReleaseId: a });
        const actives = [a, b].flatMap(id => meshReleases().members(id, ['member'])).filter(r => r.missionId === m);
        expect(actives).toHaveLength(1);
        // re-adding to the release it is already in is a no-op
        const again = scopeRelease(meshId, a, { add: [m] }, 'coordinator');
        expect(again.ok && again.changes[0].op).toBe('unchanged');
    });

    it('the unique index is the backstop: a second active row for one mission is rejected by the database', () => {
        const a = release('rc.34');
        const m = mission('Unique');
        scopeRelease(meshId, a, { add: [m] }, 'coordinator');
        expect(() => store().db.prepare(
            `INSERT INTO mesh_release_missions (release_id, mesh_id, mission_id, state, added_by, added_at) VALUES ('rel_other', ?, ?, 'member', 'x', ?)`,
        ).run(meshId, m, new Date(Date.now() + 5).toISOString())).toThrow(/UNIQUE/);
    });
});

describe('scope changes after deploy (acceptance 3)', () => {
    it('removing / moving out of a deployed release is allowed, flagged and logged', () => {
        const a = release('rc.34');
        const b = release('rc.35');
        const m1 = mission('One');
        const m2 = mission('Two');
        scopeRelease(meshId, a, { add: [m1, m2] }, 'coordinator');
        recordReleaseDeploy(meshId, { releaseId: a, channel: 'preview', version: '1.0.82-rc.34', commit: 'c1' }, 'script');
        const removed = scopeRelease(meshId, a, { remove: [m1] }, 'owner');
        expect(removed.ok).toBe(true);
        if (!removed.ok) return;
        expect(removed.changes[0]).toMatchObject({ op: 'removed', afterFreeze: true });
        expect(removed.warnings.join(' ')).toMatch(/deployed but is no longer in its scope/);
        expect(meshReleases().listEvents(a, { types: ['scope_removed'] })[0].payload).toMatchObject({ missionId: m1, afterFreeze: true });
        const moved = scopeRelease(meshId, a, { move: [{ missionId: m2, toReleaseId: b }] }, 'owner');
        expect(moved.ok && moved.warnings.join(' ')).toMatch(/left release/);
        expect(store().missionItems().listEvents(meshId, m1, { types: ['release_detached'] })).toHaveLength(1);
    });
});

describe('deploy recording (acceptance 4, daemon side)', () => {
    it('merges per-stage target snapshots, marks the release deployed and is repeatable', () => {
        const rel = release('1.0.82-rc.34');
        const npm = { npm: { commit: 'c1', deployedAt: '2026-11-01T00:00:00.000Z', previewVersion: '1.0.82-rc.34' } };
        const r1 = recordReleaseDeploy(meshId, { releaseId: 'auto', channel: 'preview', version: '1.0.82-rc.34', commit: 'c1', targets: npm }, 'script');
        expect(r1.ok && r1.release).toMatchObject({ id: rel, status: 'deployed', headCommit: 'c1', version: '1.0.82-rc.34' });
        const r2 = recordReleaseDeploy(meshId, { releaseId: 'auto', channel: 'preview', version: '1.0.82-rc.34', commit: 'c1', targets: { web: { commit: 'c1', deployedAt: 'x' } } }, 'script');
        expect(r2.ok && r2.created).toBe(false); // the second stage finds the same release by version
        expect(r2.ok && Object.keys(r2.release.targets!).sort()).toEqual(['npm', 'web']);
        expect(meshReleases().listEvents(rel, { types: ['deploy_recorded'] })).toHaveLength(2);
    });

    it('auto creates a release when none is open, and warns about notes/draft', () => {
        const m = mission('No note yet');
        const created = recordReleaseDeploy(meshId, { channel: 'stable', version: '1.0.82', commit: 'c9' }, 'script');
        expect(created.ok && created.created).toBe(true);
        if (!created.ok) return;
        scopeRelease(meshId, created.release.id, { add: [m] }, 'owner');
        const again = recordReleaseDeploy(meshId, { releaseId: created.release.id, channel: 'stable', version: '1.0.82', commit: 'c9' }, 'script');
        expect(again.ok && again.warnings.join(' ')).toMatch(/no release_note/);
        expect(again.ok && again.warnings.join(' ')).toMatch(/no CHANGELOG draft/);
        expect(again.ok && again.needsNote).toEqual([m]);
    });

    it('a cancelled release refuses a deploy record; invalid channels are refused', () => {
        const rel = release();
        upsertRelease(meshId, { releaseId: rel, status: 'cancelled' }, 'owner');
        expect(recordReleaseDeploy(meshId, { releaseId: rel, channel: 'preview' }, 'script')).toMatchObject({ ok: false, code: 'release_closed' });
        expect(recordReleaseDeploy(meshId, { channel: 'beta' }, 'script')).toMatchObject({ ok: false, code: 'invalid_channel' });
    });
});

describe('status lifecycle and the verified suggestion (acceptance 8)', () => {
    it('verified is only suggested when every live check of the members is closed, and never applied automatically', () => {
        const rel = release();
        const m = mission('Live', {}, [{ kind: 'live_check', text: 'check it', machine: 'mac' }]);
        scopeRelease(meshId, rel, { add: [m] }, 'coordinator');
        recordReleaseDeploy(meshId, { releaseId: rel, channel: 'preview', commit: 'c1' }, 'script');
        let release1 = meshReleases().get(meshId, rel)!;
        let views = describeReleaseMissions(meshId, release1);
        expect(views[0]).toMatchObject({ openLiveChecks: 1, machines: ['mac'] });
        expect(verifiedSuggestion(release1, views)).toMatchObject({ suggested: false, openLiveChecks: 1 });
        const liveItem = store().missionItems().listItems(meshId, m, { kinds: ['live_check'] })[0];
        upsertStructuredMission(meshId, { id: m, itemsUpdate: [{ id: liveItem.id, state: 'done' }] } as any);
        views = describeReleaseMissions(meshId, release1);
        expect(verifiedSuggestion(release1, views)).toMatchObject({ suggested: true });
        expect(meshReleases().get(meshId, rel)!.status).toBe('deployed'); // never auto-transitioned
        // the coordinator confirms explicitly
        expect(upsertRelease(meshId, { releaseId: rel, status: 'verified' }, 'coordinator').ok).toBe(true);
        release1 = meshReleases().get(meshId, rel)!;
        expect(release1.status).toBe('verified');
        // terminal states are final; backwards jumps are refused
        expect(upsertRelease(meshId, { releaseId: rel, status: 'planned' }, 'owner')).toMatchObject({ ok: false, code: 'invalid_transition' });
    });
});

describe('CHANGELOG draft (acceptance 5)', () => {
    it('uses release_note, marks the rest, excludes unshipped missions and warns about unconfirmed git state', () => {
        const rel = release();
        const noted = mission('Dashboard badge', { releaseNote: 'Added a release badge to mission cards.' }, withSha('b'.repeat(40)));
        const plain = mission('Quiet fix', { summary: 'Fixed the wave 3 crash on boot' });
        const dropped = mission('Dropped', { releaseNote: 'Should not appear.' });
        const unlanded = mission('Unlanded', { releaseNote: '[Fixed] Corrected the queue order.' }, withSha('c'.repeat(40)));
        landedEval(noted);
        landedEval(unlanded, 'not_contained');
        upsertStructuredMission(meshId, { id: dropped, status: 'abandoned', outcome: 'superseded' } as any);
        scopeRelease(meshId, rel, { add: [noted, plain, dropped, unlanded] }, 'coordinator');

        const draft = buildChangelogDraft(meshId, meshReleases().get(meshId, rel)!);
        const by = Object.fromEntries(draft.entries.map(e => [e.missionId, e]));
        expect(by[noted]).toMatchObject({ section: 'Added', text: 'Added a release badge to mission cards.', source: 'release_note', marker: `<!-- m:${noted.slice(0, 8)} -->` });
        expect(by[noted].needsWording).toBeUndefined();
        expect(by[plain]).toMatchObject({ section: 'Fixed', source: 'summary', needsWording: true });
        expect(by[plain].text).toContain('[needs user-facing wording]');
        expect(by[plain].lint?.join(' ')).toMatch(/wave number/);
        expect(by[unlanded]).toMatchObject({ section: 'Fixed', text: 'Corrected the queue order.' });
        expect(draft.needsNote).toEqual([plain]);
        expect(draft.excluded).toEqual([{ missionId: dropped, reason: 'outcome superseded' }]);
        expect(draft.warnings).toEqual([expect.objectContaining({ missionId: unlanded, gitState: 'not_landed' })]);
        expect(by[noted].evidence).toMatchObject({ gitState: 'landed', shas: ['b'.repeat(12)] });
        expect(JSON.stringify(draft.entries.map(e => e.text))).not.toMatch(/bbbbbbbb|landed/); // evidence never reaches the text
    });

    it('is stored, logged, and markApplied stamps the stored draft (CHANGELOG.md itself is never touched here)', () => {
        const rel = release();
        const m = mission('x', { releaseNote: 'Added a thing.' });
        scopeRelease(meshId, rel, { add: [m] }, 'coordinator');
        expect(draftReleaseChangelog(meshId, rel, 'owner', { markApplied: true })).toMatchObject({ code: 'no_draft' });
        const drafted = draftReleaseChangelog(meshId, rel, 'coordinator');
        expect('draft' in drafted && drafted.draft.entries).toHaveLength(1);
        expect(meshReleases().get(meshId, rel)!.changelog?.appliedAt).toBeUndefined();
        const applied = draftReleaseChangelog(meshId, rel, 'owner', { markApplied: true });
        expect('draft' in applied && applied.draft.appliedAt).toBeTruthy();
        expect(meshReleases().listEvents(rel, { types: ['changelog_drafted', 'changelog_applied'] }).map(e => e.type).sort()).toEqual(['changelog_applied', 'changelog_drafted']);
    });
});

describe('release_note on missions (L5)', () => {
    it('is stored through the structured writer, bounded, and recorded in the mission history', () => {
        const m = mission('Noted', { releaseNote: '  Added   a thing.  ' });
        expect(getMeshMission(meshId, m)?.releaseNote).toBe('Added a thing.');
        const { result } = upsertStructuredMission(meshId, { id: m, releaseNote: 'x'.repeat(500) } as any);
        expect(getMeshMission(meshId, m)?.releaseNote).toHaveLength(400);
        expect(result.warnings.join(' ')).toMatch(/release_note truncated/);
        upsertStructuredMission(meshId, { id: m, releaseNote: '' } as any);
        expect(getMeshMission(meshId, m)?.releaseNote).toBeUndefined();
        expect(store().missionItems().listEvents(meshId, m, { types: ['release_note_changed'] }).length).toBe(3);
    });
});

describe('authority (acceptance 7)', () => {
    const C = 'release_scope';
    it('the commands are registered for owner/local transports only, never mesh/api/ws/internal', () => {
        const registry = getDaemonCommandRegistry();
        for (const name of RELEASE_COMMANDS) {
            const spec = registry.get(name)!;
            expect(spec, name).toBeTruthy();
            expect(spec.sources).toEqual(['p2p', 'standalone', 'ext', 'ipc']);
        }
    });

    it('classifies owner transports and credential-less ipc as owner; other sources are refused', () => {
        for (const s of ['p2p', 'standalone', 'ext', 'ipc']) expect(classifyReleaseCaller(stamped(s), C)).toEqual({ ok: true, actor: 'owner' });
        for (const s of ['mesh', 'internal', 'ws', 'api', 'push_relay', '']) expect(classifyReleaseCaller(stamped(s), C)).toMatchObject({ ok: false });
        expect(classifyReleaseCaller(stamped('ipc', { actor: 'script' }), 'release_record_deploy')).toEqual({ ok: true, actor: 'script' });
        expect(classifyReleaseCaller(stamped('ipc', { actor: 'script' }), C)).toEqual({ ok: true, actor: 'owner' }); // only record_deploy honours it
    });

    it('a worker credential (worker token, or a plain session credential) is refused for every release command', () => {
        for (const command of RELEASE_COMMANDS) {
            expect(classifyReleaseCaller(stamped('ipc', { token: 't' }), command)).toMatchObject({ ok: false });
            const workerToken = mintMcpSessionCredential({ sessionId: 'worker-session-9', meshId, isCoordinator: false });
            const viaSession = stamped('ipc');
            attachIpcMcpAuthority(viaSession, command, { sessionCredential: workerToken });
            expect(classifyReleaseCaller(viaSession, command), command).toMatchObject({ ok: false, code: 'release_not_allowed' });
            const viaWorker = stamped('ipc');
            attachIpcMcpAuthority(viaWorker, command, { workerCredential: 'wk_live_or_dead' });
            expect(classifyReleaseCaller(viaWorker, command), command).toMatchObject({ ok: false, code: 'release_not_allowed' });
        }
    });

    it('a coordinator bound to this mesh is allowed; one bound to another mesh, and the assistant label rules, hold', () => {
        const coordToken = mintMcpSessionCredential({ sessionId: 'coord-session-1', meshId, isCoordinator: true });
        const ok = stamped('ipc');
        attachIpcMcpAuthority(ok, C, { sessionCredential: coordToken });
        expect(classifyReleaseCaller(ok, C)).toEqual({ ok: true, actor: 'coordinator' });
        const other = { ...stamped('ipc'), meshId: 'another-mesh' };
        attachIpcMcpAuthority(other, C, { sessionCredential: coordToken });
        expect(classifyReleaseCaller(other, C)).toMatchObject({ ok: false });
        const assistantToken = mintMcpSessionCredential({ sessionId: 'assistant-session-1', isCoordinator: false });
        const asst = stamped('ipc');
        attachIpcMcpAuthority(asst, C, { sessionCredential: assistantToken });
        expect(classifyReleaseCaller(asst, C)).toEqual({ ok: true, actor: 'assistant' });
    });

    it('the handler refuses a worker and changes nothing', async () => {
        const rel = release();
        const m = mission('Worker target');
        const args: Record<string, unknown> = { ...stamped('ipc'), releaseId: rel, add: [m] };
        attachIpcMcpAuthority(args, 'release_scope', { workerCredential: 'wk' });
        const res: any = await meshReleaseHandlers.release_scope({} as any, args);
        expect(res).toMatchObject({ success: false, code: 'release_not_allowed' });
        expect(meshReleases().members(rel)).toEqual([]);
    });

    it('owner handler round trip: upsert -> scope -> list shows membership and suggestions', async () => {
        const up: any = await meshReleaseHandlers.release_upsert({} as any, { ...stamped('p2p'), name: 'rc.40', channel: 'preview' });
        expect(up).toMatchObject({ success: true, created: true });
        const m = mission('Round trip');
        const sc: any = await meshReleaseHandlers.release_scope({} as any, { ...stamped('p2p'), releaseId: up.release.id, add: [m] });
        expect(sc.changes[0].op).toBe('added');
        const all: any = await meshReleaseHandlers.release_list({} as any, stamped('p2p'));
        expect(all.releases[0]).toMatchObject({ id: up.release.id, missionCount: 1 });
        expect(all.membership[m]).toEqual({ releaseId: up.release.id, name: 'rc.40' });
        const one: any = await meshReleaseHandlers.release_list({} as any, { ...stamped('p2p'), releaseId: up.release.id, include: ['git', 'events'] });
        expect(one.missions[0]).toMatchObject({ missionId: m, gitState: 'no_refs' });
        expect(one.events.map((e: any) => e.type)).toContain('scope_added');
    });
});

describe('schema migration (acceptance 9)', () => {
    it('adds the tables and the release_note column on an existing DB and is safe to rerun', () => {
        const db = store().db;
        const cols = () => (db.prepare('PRAGMA table_info(mesh_missions)').all() as Array<{ name: string }>).map(c => c.name);
        expect(cols()).toContain('release_note');
        db.exec('ALTER TABLE mesh_missions DROP COLUMN release_note');
        db.exec('DROP TABLE mesh_release_events');
        expect(cols()).not.toContain('release_note');
        ensureMeshReleaseSchema(db);
        ensureMeshReleaseSchema(db);
        expect(cols()).toContain('release_note');
        expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('mesh_releases','mesh_release_missions','mesh_release_events','idx_mesh_release_missions_one_active')").all()).toHaveLength(4);
    });
});
