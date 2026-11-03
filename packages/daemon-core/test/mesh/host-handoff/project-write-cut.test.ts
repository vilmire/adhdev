import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireProjectFileCut, withProjectApprovalWrite } from '../../../src/mesh/host-handoff/project-write-cut.js';
import { StagedControlStore } from '../../../src/assistant/staged-control.js';
import { AssistantNoteStaging } from '../../../src/assistant/note-staging.js';
import { saveMeshConfig, saveMeshConfigDurable, withStrictMeshConfigWriteLock, withHandoffConfigWrite } from '../../../src/config/mesh-config-store.js';

const inventory = () => ({ meshes: [{ id: 'project', name: 'Project', nodes: [], meshHost: { role: 'host' } }, { id: 'other', name: 'Other', nodes: [], meshHost: { role: 'host' } }] });
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-file-cut-'));
    writeFileSync(join(dir, 'meshes.json'), JSON.stringify(inventory()));
    return dir;
}
function fence(dir: string) {
    const config = inventory();
    (config.meshes[0]!.meshHost as any).handoffFence = { handoffId: 'handoff', epoch: 1 };
    writeFileSync(join(dir, 'meshes.json'), JSON.stringify(config));
    return config;
}
afterEach(() => vi.unstubAllEnvs());

describe('project file/config mutation cut', () => {
    it('retains a lock across asynchronous approval resolution and never locks another project', async () => {
        const dir = fixture(); const store = new StagedControlStore({ configDir: dir });
        const record = store.write({ meshId: 'project', project: 'Project', kind: 'session_control', trigger: 'owner_request', role: 'coordinator', action: 'restart' });
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        const resolving = store.resolve(record.id, 'apply', async () => { entered(); await gate; return { success: true }; });
        await waiting;
        expect(() => acquireProjectFileCut(dir, 'project')).toThrow('in flight');
        expect(withProjectApprovalWrite(dir, 'other', () => 'unrelated')).toBe('unrelated');
        fence(dir); // Admission is fenced before handoff tries to cut old writers.
        expect(() => acquireProjectFileCut(dir, 'project')).toThrow();
        release(); expect(await resolving).toMatchObject({ success: true });
        const cut = acquireProjectFileCut(dir, 'project'); cut.release();
        expect(() => store.write({ ...record, meshId: 'project' })).toThrow('fenced');
    });

    it('consumes host-handoff consent before the callback acquires its own cut and retains a non-replayable receipt', async () => {
        const dir = fixture(); const store = new StagedControlStore({ configDir: dir });
        const record = store.write({ meshId: 'project', project: 'Project', kind: 'host_handoff', trigger: 'owner_request', targetDaemonId: 'target' });
        const apply = vi.fn(async () => {
            fence(dir);
            const cut = acquireProjectFileCut(dir, 'project'); cut.release();
            return { success: true, phase: 'frozen' };
        });
        expect(await store.resolve(record.id, 'apply', apply)).toMatchObject({ success: true, applied: { phase: 'frozen' } });
        expect(apply).toHaveBeenCalledOnce();
        expect(readFileSync(join(store.dir, `${record.id}.json.consumed`), 'utf8')).toContain(record.id);
        expect(await store.resolve(record.id, 'apply', apply)).toMatchObject({ success: false, code: 'staged_not_found' });
    });

    it('keeps global assistant controls writable when a project is frozen', () => {
        const dir = fixture(); fence(dir);
        const store = new StagedControlStore({ configDir: dir });
        const proposal = store.write({ meshId: 'project', project: 'Project', kind: 'session_control', role: 'assistant', trigger: 'owner_request', action: 'restart' });
        expect(proposal.role).toBe('assistant');
    });

    it('keeps frozen approval bytes through resolve/expiry and allows unrelated proposal writes', async () => {
        const dir = fixture(); let now = 1;
        const store = new StagedControlStore({ configDir: dir, now: () => now });
        const record = store.write({ meshId: 'project', project: 'Project', kind: 'session_control', trigger: 'owner_request' });
        const path = join(store.dir, `${record.id}.json`), before = readFileSync(path, 'utf8');
        fence(dir); const apply = vi.fn();
        expect(await store.resolve(record.id, 'apply', apply)).toMatchObject({ success: false, code: 'staged_apply_failed' });
        expect(apply).not.toHaveBeenCalled();
        now = record.expiresAt + 1; store.list();
        expect(readFileSync(path, 'utf8')).toBe(before);
        expect(store.write({ meshId: 'other', project: 'Other', kind: 'session_control', trigger: 'owner_request' }).meshId).toBe('other');
        const notes = new AssistantNoteStaging({ configDir: dir });
        expect(() => notes.write({ meshId: 'project', project: 'Project', origin: 'review', op: { action: 'record', text: 'must remain staged' } })).toThrow('fenced');
    });

    it('protects an entire note application/removal callback across await', async () => {
        const dir = fixture(); const notes = new AssistantNoteStaging({ configDir: dir });
        const id = notes.write({ meshId: 'project', project: 'Project', origin: 'review', op: { action: 'record', text: 'pending' } });
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        const applying = notes.withResolution(id, async (_record, remove) => { entered(); await gate; remove(); return 'applied'; });
        await waiting; expect(() => acquireProjectFileCut(dir, 'project')).toThrow();
        release(); expect(await applying).toBe('applied');
        expect(existsSync(join(notes.dir, `${id}.json`))).toBe(false);
    });

    it('refuses stale ordinary/durable config saves but preserves unrelated project updates and internal CAS effects', () => {
        const dir = fixture(); vi.stubEnv('ADHDEV_CONFIG_DIR', dir);
        const frozen = fence(dir);
        const stale = inventory(); stale.meshes[0]!.name = 'unapproved stale update';
        expect(() => saveMeshConfig(stale as never)).toThrow('fenced');
        expect(() => withStrictMeshConfigWriteLock(() => saveMeshConfigDurable(stale as never))).toThrow('fenced');
        frozen.meshes[1]!.name = 'unrelated update'; saveMeshConfig(frozen as never);
        expect(JSON.parse(readFileSync(join(dir, 'meshes.json'), 'utf8')).meshes[1].name).toBe('unrelated update');
        delete (frozen.meshes[0]!.meshHost as any).handoffFence;
        const saved = withHandoffConfigWrite('project', () => withStrictMeshConfigWriteLock(() => saveMeshConfigDurable(frozen as never)));
        expect(saved.ok).toBe(true);
    });

    it('lets the protocol-id permit adopt a fenced paired member and still refuses other fenced edits', () => {
        const dir = fixture(); vi.stubEnv('ADHDEV_CONFIG_DIR', dir);
        const config = inventory();
        config.meshes[0] = { id: 'mesh_local', name: 'Member', nodes: [{ id: 'node-local', workspace: '/local' }], meshHost: { role: 'member', hostMeshId: 'mesh_host', hostDaemonId: 'standalone_mach_host', handoffFence: { handoffId: 'handoff', epoch: 1 } } } as never;
        writeFileSync(join(dir, 'meshes.json'), JSON.stringify(config));
        const adopted = JSON.parse(JSON.stringify(config));
        adopted.meshes[0].id = 'mesh_host';
        adopted.meshes[0].nodes.push({ id: 'node-source', daemonId: 'standalone_mach_host' });
        expect(() => saveMeshConfig(adopted)).toThrow('fenced');
        const edited = JSON.parse(JSON.stringify(config));
        edited.meshes[0].name = 'still fenced';
        expect(() => withHandoffConfigWrite('mesh_host', () => saveMeshConfig(edited))).toThrow('fenced');
        withHandoffConfigWrite('mesh_host', () => saveMeshConfig(adopted));
        expect(JSON.parse(readFileSync(join(dir, 'meshes.json'), 'utf8')).meshes[0].id).toBe('mesh_host');
    });
});
