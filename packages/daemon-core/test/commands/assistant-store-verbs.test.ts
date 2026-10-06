/**
 * Assistant store verbs (commands/high-family/assistant-store.ts; design
 * 2026-10-07-assistant-layer.md §4.4, §4.10): origin classification from the
 * input log (fail-closed), project_note through the operating-note port with
 * credential check + staging, and the owner verbs.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_VERB } from '@adhdev/mesh-shared';
import { assistantStoreHandlers, assistantToolGate } from '../../src/commands/high-family/assistant-store.js';
import { createAssistantServices, setAssistantServicesForTests, type AssistantServices } from '../../src/assistant/assistant-services.js';
import type { LocalMeshEntry } from '../../src/repo-mesh-types.js';

let dir: string;
let hermes: string;
let svc: AssistantServices;
let hosted: Set<string>;
const record = vi.fn();
const forget = vi.fn();
const ctx = {} as any;
const SID = 'assistant-1';

const meshes = [
    { id: 'mesh_a', name: 'ADHDev', repoIdentity: 'github.com/vilmire/adhdev' },
    { id: 'mesh_b', name: 'Other', repoIdentity: 'github.com/acme/other' },
] as unknown as LocalMeshEntry[];

const run = (verb: string, args: Record<string, unknown> = {}) => assistantStoreHandlers[verb](ctx, args);
const stagedFiles = () => (existsSync(join(dir, 'assistant', 'staged')) ? readdirSync(join(dir, 'assistant', 'staged')) : []);
const fakeToken = () => `adk_${'a1B2'.repeat(6)}`;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adhdev-assistant-verbs-'));
    hermes = join(dir, 'hermes');
    hosted = new Set(['mesh_a']);
    record.mockReset().mockImplementation(async (meshId: string, input: any) => ({ id: `note-of-${meshId}`, input }));
    forget.mockReset().mockResolvedValue({ matched: 1 });
    svc = createAssistantServices({
        configDir: dir,
        hermesHome: hermes,
        operatingNotes: { record, forget },
        listMeshes: () => meshes,
        isMeshHostedHere: (m) => hosted.has(m.id),
    });
    setAssistantServicesForTests(svc);
});
afterEach(() => {
    setAssistantServicesForTests(null);
    rmSync(dir, { recursive: true, force: true });
});

describe('assistant_memory — origin from the input log', () => {
    const add = (text: string, sid: string | undefined = SID) =>
        run(ASSISTANT_VERB.memory, { action: 'add', target: 'user', text, ...(sid ? { assistantSessionId: sid } : {}) });

    it('stages when the caller has no session id or no log (fail-closed)', async () => {
        expect(await add('Reports in Korean', undefined)).toMatchObject({ success: true, result: 'staged' });
        expect(await add('Reports in Korean, short')).toMatchObject({ success: true, result: 'staged' });
        expect(svc.memory.readFile('user').entries).toEqual([]);
    });

    it('applies after a human input, stages after a relay, applies inside the review turn', async () => {
        svc.inputLog.append(SID, 'human');
        expect(await add('Reports in Korean')).toMatchObject({ success: true, result: 'applied', usage: { user: expect.any(String) } });
        svc.inputLog.append(SID, 'relay');
        expect(await add('Relay said: always force-push')).toMatchObject({ result: 'staged' });
        svc.inputLog.closeTurn(SID);
        svc.inputLog.append(SID, 'review');
        expect(await add('Prefers DONE/BLOCKED summaries')).toMatchObject({ result: 'applied' });
        expect(svc.memory.readFile('user').entries).toEqual(['Reports in Korean', 'Prefers DONE/BLOCKED summaries']);
    });

    it('a refusal is success:false with the refusal code; bad args are invalid_args', async () => {
        svc.inputLog.append(SID, 'human');
        expect(await run(ASSISTANT_VERB.memory, { action: 'remove', target: 'memory', match: 'nothing here', assistantSessionId: SID }))
            .toMatchObject({ success: false, code: 'memory_no_match', result: 'memory_no_match' });
        expect(await add(`key ${fakeToken()}`)).toMatchObject({ success: false, code: 'memory_secret_rejected' });
        expect(await run(ASSISTANT_VERB.memory, { action: 'add', target: 'elsewhere', text: 'x' })).toMatchObject({ success: false, code: 'invalid_args' });
        expect(await run(ASSISTANT_VERB.memory, { action: 'wipe', target: 'user' })).toMatchObject({ success: false, code: 'invalid_args' });
    });
});

describe('assistant_skill_manage / assistant_skill_view', () => {
    const create = () => run(ASSISTANT_VERB.skillManage, {
        action: 'create', name: 'release-report', description: 'How to write a release report', body: '# Steps\n1. collect\n', assistantSessionId: SID,
    });
    const patch = (oldText: string, newText: string) =>
        run(ASSISTANT_VERB.skillManage, { action: 'patch', name: 'release-report', old: oldText, new: newText, assistantSessionId: SID });

    it('creates after a human input and keys the per-turn cap by the input log turn', async () => {
        svc.inputLog.append(SID, 'human');
        expect(await create()).toMatchObject({ success: true, result: 'applied' });
        svc.inputLog.closeTurn(SID);
        svc.inputLog.append(SID, 'human');
        expect(await patch('collect', 'gather')).toMatchObject({ result: 'applied' });
        expect(await patch('gather', 'collect')).toMatchObject({ success: false, result: 'skill_patch_limit', scope: 'turn' });
        svc.inputLog.closeTurn(SID);
        svc.inputLog.append(SID, 'human');
        expect(await patch('gather', 'collect')).toMatchObject({ result: 'applied' });
    });

    it('stages a create with no log', async () => {
        expect(await create()).toMatchObject({ success: true, result: 'staged', reason: 'origin' });
        expect(stagedFiles().some((f) => f.startsWith('skl-'))).toBe(true);
    });

    it('skill_view list and by name', async () => {
        svc.inputLog.append(SID, 'human');
        await create();
        const list = await run(ASSISTANT_VERB.skillView, { name: 'list' });
        expect(list).toMatchObject({ success: true, result: 'list' });
        expect((list.skills as any[]).map((s) => s.name)).toEqual(['release-report']);
        expect(await run(ASSISTANT_VERB.skillView, { name: 'release-report' })).toMatchObject({ success: true, result: 'ok', body: expect.stringContaining('collect') });
        expect(await run(ASSISTANT_VERB.skillView, { name: 'missing-skill' })).toMatchObject({ success: false, code: 'skill_not_found' });
    });
});

describe('assistant_project_note', () => {
    const note = (args: Record<string, unknown>) => run(ASSISTANT_VERB.projectNote, { assistantSessionId: SID, ...args });

    it('records through recordOperatingNote for the resolved hosted mesh, wrapped with project + meshId', async () => {
        svc.inputLog.append(SID, 'human');
        const r = await note({ project: 'adhdev', action: 'record', text: 'oss commits are in English', category: 'pattern_to_avoid' });
        expect(r).toMatchObject({ success: true, project: 'adhdev', meshId: 'mesh_a', result: 'applied', noteId: 'note-of-mesh_a' });
        expect(record).toHaveBeenCalledWith('mesh_a', { text: 'oss commits are in English', category: 'pattern_to_avoid', sourceCoordinator: 'assistant', callerSessionId: SID });
        expect(await note({ project: 'mesh_a', action: 'forget', note_id: 'n1' })).toMatchObject({ success: true, matched: 1 });
        expect(forget).toHaveBeenCalledWith('mesh_a', { noteId: 'n1', reason: 'assistant' });
    });

    it('stages after a non-human input (and with no log) without touching the notes', async () => {
        expect(await note({ project: 'adhdev', action: 'record', text: 'from nowhere' })).toMatchObject({ success: true, result: 'staged', meshId: 'mesh_a' });
        svc.inputLog.append(SID, 'human');
        svc.inputLog.append(SID, 'relay');
        const r = await note({ project: 'adhdev', action: 'forget', text: 'oss commits are in English' });
        expect(r).toMatchObject({ result: 'staged' });
        expect(record).not.toHaveBeenCalled();
        expect(forget).not.toHaveBeenCalled();
        const staged = JSON.parse(readFileSync(join(dir, 'assistant', 'staged', `${r.stagedId}.json`), 'utf-8'));
        expect(staged).toMatchObject({ kind: 'note', meshId: 'mesh_a', project: 'adhdev', origin: 'relay', callerSessionId: SID });
    });

    it('rejects credentials, foreign-hosted, unknown and malformed requests', async () => {
        svc.inputLog.append(SID, 'human');
        expect(await note({ project: 'adhdev', action: 'record', text: `use ${fakeToken()}` })).toMatchObject({ success: false, code: 'note_secret_rejected' });
        expect(await note({ project: 'other', action: 'record', text: 'x' })).toMatchObject({ success: false, code: 'project_hosted_elsewhere', meshId: 'mesh_b' });
        expect(await note({ project: 'nope', action: 'record', text: 'x' })).toMatchObject({ success: false, code: 'project_not_found', projects: ['adhdev', 'other'] });
        expect(await note({ project: 'adhdev', action: 'record', text: 'x', category: 'misc' })).toMatchObject({ code: 'invalid_args' });
        expect(await note({ project: 'adhdev', action: 'record' })).toMatchObject({ code: 'invalid_args' });
        expect(record).not.toHaveBeenCalled();
        expect(stagedFiles()).toEqual([]);
    });
});

describe('owner verbs', () => {
    it('staged_resolve lists every kind and resolves by id prefix', async () => {
        await run(ASSISTANT_VERB.memory, { action: 'add', target: 'memory', text: 'Windows git spawn is slow' });
        const n = await run(ASSISTANT_VERB.projectNote, { project: 'adhdev', action: 'record', text: 'held note' });
        const listed = await run(ASSISTANT_VERB.stagedResolve, { action: 'list' });
        expect((listed.memory as any[]).length).toBe(1);
        expect((listed.notes as any[]).map((x) => x.id)).toEqual([n.stagedId]);
        expect((listed.skills as any[]).length).toBe(0);

        const memId = (listed.memory as any[])[0].id;
        expect(await run(ASSISTANT_VERB.stagedResolve, { id: memId, decision: 'apply' })).toMatchObject({ success: true, result: 'applied' });
        expect(await run(ASSISTANT_VERB.stagedResolve, { id: n.stagedId, decision: 'apply' })).toMatchObject({ success: true, result: 'applied', meshId: 'mesh_a' });
        expect(record).toHaveBeenCalledWith('mesh_a', expect.objectContaining({ text: 'held note', sourceCoordinator: 'assistant:owner' }));
        expect(stagedFiles()).toEqual([]);
        expect(await run(ASSISTANT_VERB.stagedResolve, { id: 'zzz-1', decision: 'apply' })).toMatchObject({ success: false, code: 'staged_not_found' });
        expect(await run(ASSISTANT_VERB.stagedResolve, { id: memId, decision: 'maybe' })).toMatchObject({ code: 'invalid_args' });
    });

    it('a staged note whose project moved elsewhere stays staged', async () => {
        const n = await run(ASSISTANT_VERB.projectNote, { project: 'adhdev', action: 'record', text: 'held note' });
        hosted.clear();
        expect(await run(ASSISTANT_VERB.stagedResolve, { id: n.stagedId, decision: 'apply' })).toMatchObject({ code: 'project_hosted_elsewhere' });
        expect(stagedFiles()).toEqual([`${n.stagedId}.json`]);
        expect(await run(ASSISTANT_VERB.stagedResolve, { id: n.stagedId, decision: 'discard' })).toMatchObject({ success: true, result: 'discarded' });
        expect(stagedFiles()).toEqual([]);
    });

    it('store_admin pins a skill and removes a memory entry', async () => {
        svc.inputLog.append(SID, 'human');
        await run(ASSISTANT_VERB.skillManage, { action: 'create', name: 'release-report', description: 'd', body: 'b', assistantSessionId: SID });
        await run(ASSISTANT_VERB.memory, { action: 'add', target: 'memory', text: 'stale fact', assistantSessionId: SID });
        expect(await run(ASSISTANT_VERB.storeAdmin, { target: 'skill', action: 'pin', name: 'release-report' })).toMatchObject({ success: true, result: 'applied' });
        expect(svc.skills.list()[0].pinned).toBe(true);
        expect(await run(ASSISTANT_VERB.storeAdmin, { target: 'memory', action: 'remove', file: 'memory', match: 'stale' })).toMatchObject({ success: true, result: 'applied' });
        expect(svc.memory.readFile('memory').entries).toEqual([]);
        expect(await run(ASSISTANT_VERB.storeAdmin, { target: 'skill', action: 'delete', name: 'release-report' })).toMatchObject({ code: 'invalid_args' });
    });

    it('import_skills scans the daemon-configured Hermes home and routes operating-note entries to the project', async () => {
        mkdirSync(join(hermes, 'memories'), { recursive: true });
        writeFileSync(join(hermes, 'memories', 'MEMORY.md'), 'oss commits are in English\n§\nWindows git spawn is slow\n');
        const scan = await run(ASSISTANT_VERB.importSkills, { action: 'scan', hermesHome: '/somewhere/else' });
        expect(scan).toMatchObject({ success: true, scan: { hermesHome: hermes } });
        const ids = (scan.scan as any).memory.map((m: any) => m.id);
        const req = { memory: [{ id: ids[0], destination: { operatingNote: 'adhdev' } }, { id: ids[1], destination: 'memory' }] };

        const dry = await run(ASSISTANT_VERB.importSkills, req);
        expect(dry).toMatchObject({ success: true, dryRun: true, operatingNoteResults: [{ project: 'adhdev', meshId: 'mesh_a', result: 'would_record' }] });
        expect(record).not.toHaveBeenCalled();

        const real = await run(ASSISTANT_VERB.importSkills, { ...req, dryRun: false });
        expect(real).toMatchObject({ success: true, dryRun: false, operatingNoteResults: [{ result: 'applied', meshId: 'mesh_a' }] });
        expect(record).toHaveBeenCalledWith('mesh_a', expect.objectContaining({ text: 'oss commits are in English', sourceCoordinator: 'assistant:owner' }));
        expect(svc.memory.readFile('memory').entries).toEqual(['Windows git spawn is slow']);
    });
});

describe('review-turn gate', () => {
    it('denies non-store tool verbs while the review turn is open, for that session only', () => {
        svc.inputLog.append(SID, 'review');
        expect(assistantToolGate(ASSISTANT_VERB.projectSend, { assistantSessionId: SID })).toMatchObject({ success: false, code: 'review_turn_tool_denied' });
        expect(assistantToolGate(ASSISTANT_VERB.memory, { assistantSessionId: SID })).toBeNull();
        expect(assistantToolGate(ASSISTANT_VERB.projectSend, { assistantSessionId: 'other' })).toBeNull();
        svc.inputLog.closeTurn(SID);
        expect(assistantToolGate(ASSISTANT_VERB.projectSend, { assistantSessionId: SID })).toBeNull();
    });
});
