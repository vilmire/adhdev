/**
 * Two real daemon processes, each with its own config dir and SQLite store, moving
 * a project host through the real live-env ports. Only the session host and the mesh
 * transport are fakes. Failure injection happens at the transport (dropped RPCs) and
 * through process crashes. Never touches a live preview: every path is a temp dir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'two-daemon', 'daemon-fixture.ts');
const MESH = 'mesh_two_daemon';
const OTHER_MESH = 'mesh_other_project';
const AIR = 'daemon_mach_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BOOK = 'daemon_mach_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const WORKER = 'daemon_mach_cccccccccccccccccccccccccccccccc';
const REPO = 'github.com/acme/two-daemon';

type Fault = { verb: string; op?: string; mode: 'drop_request' | 'drop_response' | 'before'; times: number; run?: () => void | Promise<void> };

class Daemon {
    child!: ChildProcess;
    private calls = new Map<string, { resolve(v: any): void; reject(e: Error): void }>();
    constructor(readonly id: string, readonly dir: string, private readonly net: Net) {}
    async spawn(): Promise<void> {
        this.child = fork(FIXTURE, [], {
            execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'], cwd: join(HERE, '..', '..', '..', '..'),
            env: { ...process.env, ADHDEV_CONFIG_DIR: this.dir, ADHDEV_SESSION_HOST_NAME: `fixture-${this.id.slice(-4)}`, FIXTURE_DAEMON_ID: this.id, FIXTURE_MESH_ID: MESH, HOME: this.dir },
        });
        await new Promise<void>((resolve, reject) => {
            this.child.once('exit', code => reject(new Error(`fixture exited early: ${code}`)));
            this.child.on('message', (m: any) => {
                if (m.kind === 'ready') { this.child.removeAllListeners('exit'); this.child.on('exit', () => { for (const c of this.calls.values()) c.reject(new Error('daemon died')); this.calls.clear(); }); resolve(); }
                else if (m.kind === 'result') { const c = this.calls.get(m.id); this.calls.delete(m.id); if (m.error) c?.reject(new Error(m.error)); else c?.resolve(m.result); }
                else if (m.kind === 'dispatch') void this.net.route(this, m);
            });
        });
    }
    call<T = any>(op: string, args: Record<string, unknown> = {}): Promise<T> {
        const id = randomUUID();
        return new Promise<T>((resolve, reject) => { this.calls.set(id, { resolve, reject }); this.child.send({ id, op, args }); });
    }
    reply(m: unknown): void { if (this.child.connected) this.child.send(m as never); }
    async crash(): Promise<void> { if (this.child.exitCode === null && this.child.signalCode === null) { const gone = new Promise(r => this.child.once('exit', r)); this.child.kill('SIGKILL'); await gone; } }
    get dead(): boolean { return this.child.exitCode !== null || this.child.signalCode !== null; }
    async restart(): Promise<void> { await this.crash(); await this.spawn(); }
}

class Net {
    daemons = new Map<string, Daemon>();
    faults: Fault[] = [];
    oldProtocol = new Set<string>();
    log: string[] = [];
    async route(from: Daemon, m: { id: string; to: string; verb: string; args: Record<string, unknown> }): Promise<void> {
        const rule = this.faults.find(f => f.verb === m.verb && f.times > 0 && (!f.op || f.op === m.args.op));
        this.log.push(`${m.verb}:${String(m.args.op ?? '')}`);
        const fail = (error: string) => from.reply({ kind: 'dispatched', id: m.id, error });
        if (rule) rule.times--;
        if (rule?.mode === 'drop_request') return fail('request dropped');
        if (rule?.mode === 'before') await rule.run?.();
        const peer = this.daemons.get(m.to);
        if (!peer || peer.dead) return fail('peer not connected');
        if (m.verb === 'mesh_host_handoff_member_probe' && this.oldProtocol.has(m.to)) return from.reply({ kind: 'dispatched', id: m.id, result: { success: false, error: 'unknown command' } });
        try {
            const result = await peer.call('peer', { verb: m.verb, args: m.args, sender: from.id });
            if (rule?.mode === 'drop_response') return fail('response lost');
            from.reply({ kind: 'dispatched', id: m.id, result });
        } catch (e) { fail((e as Error).message); }
    }
    count(verb: string): number { return this.log.filter(l => l.startsWith(`${verb}:`)).length; }
}

function workspace(root: string, name: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '--quiet', dir]);
    execFileSync('git', ['-C', dir, 'config', 'remote.origin.url', `https://${REPO}.git`]);
    return dir;
}

async function until(probe: () => Promise<boolean>, ms = 20_000): Promise<void> {
    const end = Date.now() + ms;
    while (!(await probe())) { if (Date.now() > end) throw new Error('condition not reached'); await new Promise(r => setTimeout(r, 40)); }
}

describe.skipIf(process.platform === 'win32')('two real daemons moving a project host', () => {
    let root: string, net: Net, air: Daemon, book: Daemon, worker: Daemon, airWs: string, bookWs: string;
    const bookNode = 'node_book';
    const roster = () => [
        { id: 'node_air', daemonId: AIR, workspace: airWs, role: 'host', policy: {}, userOverrides: {} },
        { id: bookNode, daemonId: BOOK, workspace: bookWs, policy: {}, userOverrides: {} },
        { id: 'node_worker', daemonId: WORKER, workspace: '/elsewhere/worker', policy: {}, userOverrides: {} },
    ];
    const seed = async () => {
        const t = '2026-11-03T00:00:00.000Z';
        const sql = (s: string, ...args: unknown[]) => air.call('sql', { sql: s, args });
        await sql("INSERT INTO mesh_missions (id, mesh_id, title, goal, status, created_at, updated_at) VALUES ('m1', ?, 'Ship', 'g', 'active', ?, ?)", MESH, t, t);
        await sql("INSERT INTO mesh_mission_items (id, mission_id, mesh_id, kind, state, text, created_at, updated_at) VALUES ('i1','m1',?, 'task','open','keep me', ?, ?)", MESH, t, t);
        for (let n = 0; n < 40; n++) await sql('INSERT INTO mesh_queue (id, mesh_id, status, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)', `q${n}`, MESH, n % 2 ? 'pending' : 'completed', t, t, JSON.stringify({ message: 'task body '.repeat(40), n }));
        for (let n = 1; n <= 3; n++) await sql("INSERT INTO mesh_mission_events (mission_id, mesh_id, type, actor, payload_json, at) VALUES ('m1', ?, 'item_added', 'coordinator', '{}', ?)", MESH, t);
        await sql('INSERT INTO mesh_tool_call_log (id, mesh_id, tool, session_id, caller_role, called_at) VALUES (5, ?, ?, ?, ?, ?)', MESH, 'mesh_status', 's', 'coordinator', 11);
        await sql("INSERT INTO turn_events (event_id, mesh_id, generation, session_id, kind, source, verdict, dedupe_key, payload_json, publish_state, at_ms, recorded_at) VALUES ('shared-event', ?, 0, 's', 'k', 'x', 'recorded', 'shared', '{}', 'published', 1, 1)", MESH);
    };
    /** A worker daemon's real shape: no project record, an authenticated pin, and its own unrelated project history. */
    const pairTarget = async () => {
        await book.call('pinHost', { meshId: MESH, hostDaemonId: AIR, publicKey: await air.call('publicKey') });
    };
    const otherProjectHistory = async () => {
        const sql = (s: string, ...args: unknown[]) => book.call('sql', { sql: s, args });
        const t = '2026-11-01T00:00:00.000Z';
        await sql("INSERT INTO mesh_missions (id, mesh_id, title, goal, status, created_at, updated_at) VALUES ('other-m', ?, 'Other', 'g', 'active', ?, ?)", OTHER_MESH, t, t);
        for (let n = 1; n <= 2; n++) await sql("INSERT INTO mesh_mission_events (mission_id, mesh_id, type, actor, payload_json, at) VALUES ('other-m', ?, 'created', 'coordinator', '{}', ?)", OTHER_MESH, t);
        await sql('INSERT INTO mesh_tool_call_log (id, mesh_id, tool, session_id, caller_role, called_at) VALUES (5, ?, ?, ?, ?, ?)', OTHER_MESH, 'mesh_status', 's', 'coordinator', 12);
        await sql("INSERT INTO turn_events (event_id, mesh_id, generation, session_id, kind, source, verdict, dedupe_key, payload_json, publish_state, at_ms, recorded_at) VALUES ('shared-event', ?, 0, 's', 'k', 'x', 'recorded', 'shared', '{}', 'none', 1, 1)", MESH);
    };
    const start = () => air.call('start', { meshId: MESH, targetDaemonId: BOOK, targetNodeId: bookNode });
    const phase = async (handoffId: string) => (await air.call('source', { handoffId }))?.phase as string;
    const settled = async (handoffId: string, want: string) => until(async () => {
        await air.call('idle');
        const now = await phase(handoffId);
        if (now === 'uncertain' && want !== 'uncertain') await air.call('retry', { handoffId });
        return now === want;
    });
    const exactOwnership = async (host: Daemon, other: Daemon) => {
        expect(await host.call('live', { meshId: MESH })).toHaveLength(1);
        expect(await other.call('live', { meshId: MESH })).toEqual([]);
    };
    const rolledBack = async (before: unknown, handoffId: string) => {
        await until(async () => (await air.call('live', { meshId: MESH })).length === 1);
        expect((await air.call('source', { handoffId })).restore).toMatchObject({ ok: true });
        expect(await air.call('dump', { meshId: MESH })).toEqual(before);
        expect(await air.call('view', { meshId: MESH })).toMatchObject({ role: 'host' });
        expect(await air.call('admission', { meshId: MESH })).toBeNull();
        expect((await air.call('tryWrite', { sql: "UPDATE mesh_queue SET status='pending' WHERE id='q0' AND mesh_id=?", args: [MESH] })).ok).toBe(true);
        expect(await air.call('holds')).toBe(false);
        expect(await book.call('live', { meshId: MESH })).toEqual([]);
    };

    beforeEach(async () => {
        root = mkdtempSync(join(tmpdir(), 'two-daemon-handoff-'));
        net = new Net();
        for (const [id, name] of [[AIR, 'air'], [BOOK, 'book'], [WORKER, 'worker']] as const) {
            mkdirSync(join(root, name));
            net.daemons.set(id, new Daemon(id, join(root, name), net));
        }
        air = net.daemons.get(AIR)!; book = net.daemons.get(BOOK)!; worker = net.daemons.get(WORKER)!;
        airWs = workspace(root, 'air-ws'); bookWs = workspace(root, 'book-ws');
        await Promise.all([air.spawn(), book.spawn(), worker.spawn()]);
        await air.call('writeMeshes', { meshes: [{ id: MESH, name: 'Project', repoIdentity: REPO, defaultBranch: 'main', policy: { keep: 'policy' }, coordinator: {}, nodes: roster(),
            meshHost: { role: 'host', hostDaemonId: AIR, hostNodeId: 'node_air' }, createdAt: 'x', updatedAt: 'x' }] });
        await seed();
        await air.call('launch', { meshId: MESH });
        await worker.call('learnHost', { meshId: MESH, hostDaemonId: AIR });
    }, 60_000);
    afterEach(async () => {
        await Promise.all([air, book, worker].map(d => d.crash()));
        rmSync(root, { recursive: true, force: true });
    });

    it('preflight names each refusal and stops nothing: unpaired target, wrong key, stale member, open turn', async () => {
        const pf = await air.call('preflight', { meshId: MESH, targetDaemonId: BOOK, targetNodeId: bookNode });
        expect(pf.ok).toBe(false);
        expect(pf.checks).toContainEqual(expect.objectContaining({ id: 'peer_capability', ok: false, detail: 'target_not_member' }));
        await book.call('learnHost', { meshId: MESH, hostDaemonId: AIR });
        const unpinned = await air.call('preflight', { meshId: MESH, targetDaemonId: BOOK, targetNodeId: bookNode });
        expect(unpinned.checks).toContainEqual(expect.objectContaining({ id: 'host_key_pinned', ok: false, code: 'host_key_unpinned' }));
        await book.call('pinHost', { meshId: MESH, hostDaemonId: AIR, publicKey: await worker.call('publicKey') });
        const mismatch = await air.call('preflight', { meshId: MESH, targetDaemonId: BOOK, targetNodeId: bookNode });
        expect(mismatch.checks).toContainEqual(expect.objectContaining({ id: 'peer_capability', ok: false, detail: 'host_key_mismatch' }));
        await pairTarget();
        await book.call('sql', { sql: 'SELECT 1' });
        net.oldProtocol.add(WORKER);
        const stale = await air.call('preflight', { meshId: MESH, targetDaemonId: BOOK, targetNodeId: bookNode });
        expect(stale.checks).toContainEqual(expect.objectContaining({ id: 'fleet_members', ok: false, code: 'member_protocol_unsupported' }));
        net.oldProtocol.clear();
        await worker.crash();
        const away = await air.call('preflight', { meshId: MESH, targetDaemonId: BOOK, targetNodeId: bookNode });
        expect(away.checks).toContainEqual(expect.objectContaining({ id: 'fleet_members', ok: true, detail: expect.stringContaining('adopts on reconnect') }));
        expect(away.ok).toBe(true);
        await worker.spawn();
        expect(await air.call('live', { meshId: MESH })).toHaveLength(1);
        expect(net.log.filter(l => l === 'mesh_host_handoff_chunk:chunk' || l === 'mesh_host_handoff_chunk:manifest')).toEqual([]);
        expect(await air.call('admission', { meshId: MESH })).toBeNull();
    }, 60_000);

    it('moves everything to a target with no project record, one coordinator at every observable point', async () => {
        await pairTarget();
        await otherProjectHistory();
        const otherBefore = await book.call('dump', { meshId: OTHER_MESH });
        const before = await air.call('dump', { meshId: MESH });
        const pf = await air.call('preflight', { meshId: MESH, targetDaemonId: BOOK, targetNodeId: bookNode });
        expect(pf.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
        let liveDuringActivate: unknown[] = [];
        net.faults.push({ verb: 'mesh_host_handoff_activate', mode: 'before', times: 1, run: async () => {
            liveDuringActivate = [await air.call('live', { meshId: MESH }), await book.call('live', { meshId: MESH }), await air.call('admission', { meshId: MESH })];
        } });
        const r = await start();
        expect(r).toMatchObject({ success: true });
        await settled(r.handoffId, 'committed');
        // Stop strictly precedes authority: no coordinator anywhere while the switch is in flight.
        expect(liveDuringActivate[0]).toEqual([]);
        expect(liveDuringActivate[1]).toEqual([]);
        expect(liveDuringActivate[2]).toMatchObject({ code: 'mesh_host_handoff_fenced' });

        await exactOwnership(book, air);
        expect(await book.call('view', { meshId: MESH })).toMatchObject({ role: 'host', hostEpoch: 1, hostNodeId: bookNode });
        expect(await air.call('view', { meshId: MESH })).toMatchObject({ role: 'member', hostEpoch: 1, handedOff: true });
        expect(await book.call('hostRecord', { meshId: MESH })).toBeNull();

        // Queue, missions and history arrive with exact ids; the unrelated project is untouched.
        const after = await book.call('dump', { meshId: MESH });
        for (const table of ['mesh_queue', 'mesh_missions', 'mesh_mission_items', 'mesh_mission_events']) expect(after[table], table).toEqual(before[table]);
        expect(await book.call('dump', { meshId: OTHER_MESH })).toEqual(otherBefore);
        expect((await book.call('readMeshes')).find((m: { id: string }) => m.id === MESH)).toMatchObject({ policy: { keep: 'policy' }, repoIdentity: REPO });
        const fresh = await book.call('tryWrite', { sql: "INSERT INTO mesh_mission_events (mission_id, mesh_id, type, actor, payload_json, at) VALUES ('m1', ?, 'after_move', 'coordinator', '{}', 'now')", args: [MESH] });
        expect(fresh.ok).toBe(true);
        expect((await book.call('sql', { sql: "SELECT seq FROM mesh_mission_events WHERE mesh_id=? AND type='after_move'", args: [MESH] }))[0].seq).toBeGreaterThan(3);

        // The old host cannot come back: writes, launches and a restart all refuse.
        expect(await air.call('tryWrite', { sql: "UPDATE mesh_queue SET status='failed' WHERE id='q0' AND mesh_id=?", args: [MESH] })).toMatchObject({ ok: false, error: expect.stringContaining('mesh_host_handoff_fenced') });
        expect(await air.call('launch', { meshId: MESH })).toMatchObject({ success: false, error: 'mesh_host_handoff_fenced' });
        await air.restart();
        await air.call('resume');
        expect(await air.call('launch', { meshId: MESH })).toMatchObject({ success: false });
        expect(await air.call('dump', { meshId: MESH })).toEqual(before);
        await exactOwnership(book, air);
        expect(await air.call('holds')).toBe(false);

        // The third machine follows, on its learned trust, from the host it already trusted.
        await until(async () => { await air.call('tick'); return (await worker.call('hostRecord', { meshId: MESH }))?.hostDaemonId === BOOK; });
    }, 90_000);

    it('a member offline at commit adopts when it returns; a certificate from anyone else changes nothing', async () => {
        await pairTarget();
        await air.call('set', { offline: [WORKER] });
        const r = await start();
        await settled(r.handoffId, 'committed');
        expect((await worker.call('hostRecord', { meshId: MESH })).hostDaemonId).toBe(AIR);
        const certificate = (await air.call('sql', { sql: 'SELECT certificate_json FROM mesh_host_handoff_certificate WHERE handoff_id=?', args: [r.handoffId] }))[0].certificate_json;
        expect(await worker.call('peer', { verb: 'mesh_host_handoff_certificate', args: { meshId: MESH, certificate: JSON.parse(certificate) }, sender: BOOK })).toMatchObject({ success: false, code: 'certificate_wrong_signer' });
        expect((await worker.call('hostRecord', { meshId: MESH })).hostDaemonId).toBe(AIR);
        await air.call('set', { offline: [] });
        await air.call('shiftClock', { ms: 6 * 60_000 });
        await air.call('tick');
        expect((await worker.call('hostRecord', { meshId: MESH })).hostDaemonId).toBe(BOOK);
        expect((await air.call('source', { handoffId: r.handoffId })).memberAcks).toContain(WORKER);
    }, 60_000);

    it.each([
        ['every attempt at a chunk is lost', { verb: 'mesh_host_handoff_chunk', op: 'chunk', mode: 'drop_request', times: 3 } as Fault, 'transfer_interrupted'],
        ['the manifest is refused on the wire', { verb: 'mesh_host_handoff_chunk', op: 'manifest', mode: 'drop_request', times: 1 } as Fault, 'transfer_interrupted'],
    ])('rolls back with the coordinator restored when %s', async (_name, fault, reason) => {
        await pairTarget();
        const before = await air.call('dump', { meshId: MESH });
        net.faults.push(fault);
        const r = await start();
        await settled(r.handoffId, 'aborted');
        expect((await air.call('source', { handoffId: r.handoffId })).abortReason).toContain(reason);
        await rolledBack(before, r.handoffId);
        expect(net.count('mesh_host_handoff_activate')).toBe(0);
    }, 60_000);

    it('a conflict found while rehearsing the import on the target rolls back before any certificate leaves', async () => {
        await pairTarget();
        const row = "INSERT INTO turn_attempts (attempt_id,scope,mesh_id,session_id,owner_daemon_id,state,terminal_outcome,accepted_at,created_at,updated_at) VALUES ('conflict','mesh_queue',?,?,?,'terminal','completed',1,1,2)";
        await air.call('sql', { sql: row, args: [MESH, 'source-worker', AIR] });
        // The one collision that stays a refusal: the same id already belongs to another project here.
        await book.call('sql', { sql: row, args: [OTHER_MESH, 'target-worker', BOOK] });
        const bookBefore = await book.call('dump', { meshId: MESH });
        const before = await air.call('dump', { meshId: MESH });
        const r = await start();
        await settled(r.handoffId, 'aborted');
        // The dashboard shows this text, so it has to name the table and the key.
        expect((await air.call('source', { handoffId: r.handoffId })).abortReason).toMatch(/^snapshot_conflict: .*turn_attempts key \["conflict"\]/);
        expect((await book.call('target', { handoffId: r.handoffId })).phase).toBe('discarded');
        await rolledBack(before, r.handoffId);
        expect(await book.call('dump', { meshId: MESH })).toEqual(bookBefore);
        expect(net.count('mesh_host_handoff_activate')).toBe(0);
    }, 60_000);

    it('a member with its own overlapping history for the project takes the move and nothing it observed is lost', async () => {
        await pairTarget();
        const attempt = "INSERT INTO turn_attempts (attempt_id,scope,mesh_id,task_id,attempt_no,session_id,owner_daemon_id,state,terminal_outcome,data_json,accepted_at,created_at,updated_at) VALUES (?,'mesh_queue',?,?,?,?,?,'completed','completed',?,1,1,2)";
        const event = "INSERT INTO turn_events (event_id,mesh_id,attempt_id,generation,session_id,kind,source,verdict,dedupe_key,payload_json,publish_state,at_ms,recorded_at) VALUES (?,?,?,0,'worker',?,'x','recorded',?,?,?,1,1)";
        const artifact = "INSERT INTO session_artifacts (artifact_id,session_id,mesh_id,origin_daemon_id,workspace_root,rel_path,kind,mime,title,size_bytes,sha256,created_at,updated_at) VALUES (?,?,?,?,'/ws',?,'file','text/plain',?,1,'aa',1,2)";
        const on = (d: Daemon, sql: string, ...args: unknown[]) => d.call('sql', { sql, args });
        // The host's history: the attempt under the current id, its report event, and a notice it still owes.
        await on(air, attempt, 'host-attempt', MESH, 'q1', 0, 'worker', AIR, '{"from":"host"}');
        await on(air, attempt, 'same-id', MESH, 'q2', 0, 'worker-2', AIR, '{"from":"host"}');
        await on(air, event, 'host-report', MESH, 'host-attempt', 'report', 'r1', '{"from":"host"}', 'published');
        await on(air, event, 'host-notice', MESH, 'host-attempt', 'notify', 'n1', '{"from":"host"}', 'pending');
        await on(air, artifact, 'host-copy', 'worker', MESH, AIR, 'out.md', 'host copy');
        await on(air, artifact, 'host-record-of-member-file', 'worker', MESH, BOOK, 'member.md', 'host record');
        // The member's own rows for the same turns, under different ids, including a fact the host never saw.
        await on(book, attempt, 'member-attempt', MESH, 'q1', 0, 'worker', BOOK, '{"from":"member"}');
        await on(book, attempt, 'same-id', MESH, 'q2', 0, 'worker-2', BOOK, '{"from":"member"}');
        await on(book, event, 'member-only', MESH, 'member-attempt', 'turn_end', 'seen-here', '{"from":"member"}', 'none');
        await on(book, event, 'member-report', MESH, 'member-attempt', 'report', 'r1', '{"from":"member"}', 'none');
        await on(book, event, 'member-notice', MESH, 'member-attempt', 'notify', 'n1', '{"from":"member"}', 'none');
        await on(book, "INSERT INTO turn_holds (hold_id,attempt_id,reason,on_expire,created_at) VALUES ('member-attempt:owner','member-attempt','owner','hold',1)");
        await on(book, "INSERT INTO mesh_handoff_note_text (mesh_id,task_id,attempt_id,notes_json,recorded_at) VALUES (?,'member-task','member-attempt','[]','now')", MESH);
        await on(book, "INSERT INTO assistant_relays (attempt_id,mesh_id,coordinator_session_id,committed_at,kind,outcome) VALUES ('member-attempt',?,'c',1,'turn','completed')", MESH);
        await on(book, artifact, 'member-copy', 'worker', MESH, AIR, 'out.md', 'stale copy of a host file');
        await on(book, artifact, 'member-file', 'worker', MESH, BOOK, 'member.md', 'member wrote this');

        const pf = await air.call('preflight', { meshId: MESH, targetDaemonId: BOOK, targetNodeId: bookNode });
        expect(pf.checks).toContainEqual(expect.objectContaining({ id: 'no_snapshot_conflicts', ok: true }));
        const r = await start();
        expect(r).toMatchObject({ success: true });
        await settled(r.handoffId, 'committed');
        await exactOwnership(book, air);

        const rows = (sql: string, ...args: unknown[]) => book.call('sql', { sql, args });
        // The host's row is the turn; the member's id is gone but recorded as what it became.
        expect(await rows('SELECT attempt_id, data_json FROM turn_attempts WHERE mesh_id=? AND task_id IS NOT NULL ORDER BY attempt_id', MESH)).toEqual([
            { attempt_id: 'host-attempt', data_json: '{"from":"host"}' }, { attempt_id: 'same-id', data_json: '{"from":"host"}' },
        ]);
        expect(await rows("SELECT target_key FROM mesh_host_handoff_row_map WHERE table_name='turn_attempts' AND source_key=?", '["member-attempt"]')).toEqual([{ target_key: '["host-attempt"]' }]);
        // Events: the member's own fact moved onto the host's attempt; the member's copy of a shared fact stays;
        // a notice the source still owes replaces the local row.
        expect(await rows("SELECT event_id, attempt_id FROM turn_events WHERE attempt_id='host-attempt' ORDER BY event_id")).toEqual([
            { event_id: 'host-notice', attempt_id: 'host-attempt' }, { event_id: 'member-only', attempt_id: 'host-attempt' }, { event_id: 'member-report', attempt_id: 'host-attempt' },
        ]);
        // Everything that pointed at the replaced attempt follows it. No orphans.
        expect(await rows("SELECT hold_id, attempt_id, status FROM turn_holds WHERE attempt_id='host-attempt'")).toEqual([{ hold_id: 'host-attempt:owner', attempt_id: 'host-attempt', status: 'resolved' }]);
        expect(await rows("SELECT attempt_id FROM mesh_handoff_note_text WHERE task_id='member-task'")).toEqual([{ attempt_id: 'host-attempt' }]);
        expect(await rows("SELECT attempt_id FROM assistant_relays WHERE mesh_id=?", MESH)).toEqual([{ attempt_id: 'host-attempt' }]);
        for (const table of ['turn_events', 'turn_holds', 'assistant_relays', 'mesh_handoff_note_text']) {
            expect(await rows(`SELECT COUNT(*) AS n FROM ${table} c WHERE c.attempt_id='member-attempt'`), table).toEqual([{ n: 0 }]);
            expect(await rows(`SELECT COUNT(*) AS n FROM ${table} c WHERE c.attempt_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM turn_attempts a WHERE a.attempt_id=c.attempt_id)`), table).toEqual([{ n: 0 }]);
        }
        // Artifacts: a file from the source takes the source's row; the member's own file keeps its row.
        expect(await rows('SELECT artifact_id, rel_path FROM session_artifacts WHERE mesh_id=? ORDER BY rel_path', MESH)).toEqual([
            { artifact_id: 'member-file', rel_path: 'member.md' }, { artifact_id: 'host-copy', rel_path: 'out.md' },
        ]);
        // Both versions survive in the archive.
        const archive = Object.fromEntries((await rows('SELECT side, payload_json FROM mesh_host_handoff_archive WHERE handoff_id=?', r.handoffId) as Array<{ side: string; payload_json: string }>).map(a => [a.side, JSON.parse(a.payload_json)]));
        const ids = (side: string, table: string, column: string) => { const t = archive[side][table]; return t.rows.map((row: unknown[]) => row[t.columns.indexOf(column)]); };
        expect(ids('target-before', 'turn_attempts', 'attempt_id')).toEqual(expect.arrayContaining(['member-attempt', 'same-id']));
        expect(ids('target-before', 'turn_events', 'event_id')).toEqual(expect.arrayContaining(['member-only', 'member-report', 'member-notice']));
        expect(ids('target-before', 'session_artifacts', 'artifact_id')).toEqual(expect.arrayContaining(['member-copy', 'member-file']));
        const source = archive['source-snapshot'].tables;
        expect(source.turn_attempts.rows.map((row: unknown[]) => row[source.turn_attempts.columns.indexOf('attempt_id')])).toEqual(expect.arrayContaining(['host-attempt', 'same-id']));
        expect(source.turn_events.rows.map((row: unknown[]) => row[source.turn_events.columns.indexOf('event_id')])).toEqual(expect.arrayContaining(['host-report', 'host-notice']));
        const decided = (archive.reconciliation as Array<{ table: string; winner: string; incomingKey?: string }>).map(e => `${e.table}:${e.incomingKey}:${e.winner}`);
        expect(decided).toEqual(expect.arrayContaining(['turn_attempts:host-attempt:source', 'turn_events:host-report:target', 'turn_events:host-notice:source',
            'session_artifacts:host-copy:source', 'session_artifacts:host-record-of-member-file:target']));
    }, 60_000);

    it('preflight finds a collision only the owner can settle, before anything stops', async () => {
        await pairTarget();
        await book.call('sql', { sql: "INSERT INTO mesh_mission_events (seq, mission_id, mesh_id, type, actor, payload_json, at) VALUES (2, 'm1', ?, 'something_else', 'coordinator', '{}', 'then')", args: [MESH] });
        const pf = await air.call('preflight', { meshId: MESH, targetDaemonId: BOOK, targetNodeId: bookNode });
        expect(pf.ok).toBe(false);
        expect(pf.checks).toContainEqual(expect.objectContaining({ id: 'no_snapshot_conflicts', ok: false, code: 'snapshot_conflict', detail: expect.stringContaining(`mesh_mission_events key ["${MESH}",2]`) }));
        const r = await start();
        expect(r).toMatchObject({ success: false, code: 'snapshot_conflict' });
        expect(await air.call('live', { meshId: MESH })).toHaveLength(1);
        expect(await air.call('admission', { meshId: MESH })).toBeNull();
        expect(net.log.filter(l => l === 'mesh_host_handoff_chunk:chunk')).toEqual([]);
    }, 60_000);

    it('a provider that stops authenticating between ACK and activate discards on the target and rolls back on the source', async () => {
        await pairTarget();
        const before = await air.call('dump', { meshId: MESH });
        net.faults.push({ verb: 'mesh_host_handoff_activate', mode: 'before', times: 1, run: () => { writeFileSync(join(book.dir, 'canary-fails'), '1'); } });
        const r = await start();
        await settled(r.handoffId, 'aborted');
        expect((await book.call('target', { handoffId: r.handoffId })).phase).toBe('discarded');
        expect(await book.call('view', { meshId: MESH })).toBeNull();
        await rolledBack(before, r.handoffId);
    }, 60_000);

    it('a lost activate reply stays fenced; abort is refused; the probe converges to one coordinator on the target', async () => {
        await pairTarget();
        net.faults.push({ verb: 'mesh_host_handoff_activate', mode: 'drop_response', times: 1 });
        const r = await start();
        await settled(r.handoffId, 'uncertain');
        expect(await air.call('abort', { handoffId: r.handoffId })).toMatchObject({ success: false });
        await until(async () => { await air.call('retry', { handoffId: r.handoffId }); return (await phase(r.handoffId)) === 'committed'; });
        await exactOwnership(book, air);
    }, 60_000);

    it('an unreachable target after commit intent: abort needs proof, the source never revives, retry converges', async () => {
        await pairTarget();
        net.faults.push({ verb: 'mesh_host_handoff_activate', mode: 'drop_request', times: 1 });
        const r = await start();
        await settled(r.handoffId, 'uncertain');
        net.faults.push({ verb: 'mesh_host_handoff_status', mode: 'drop_request', times: 1 });
        expect(await air.call('abort', { handoffId: r.handoffId })).toMatchObject({ success: false, code: 'abort_requires_target_confirmation' });
        expect(await air.call('live', { meshId: MESH })).toEqual([]);
        expect(await air.call('admission', { meshId: MESH })).toMatchObject({ code: 'mesh_host_handoff_fenced' });
        await air.call('retry', { handoffId: r.handoffId });
        await settled(r.handoffId, 'committed');
        await exactOwnership(book, air);
    }, 60_000);

    it('target crash after applying, before authority: restart finishes forward and launches exactly once', async () => {
        await pairTarget();
        await book.call('set', { crashAtPostApply: true });
        const r = await start();
        await until(async () => book.dead);
        await book.spawn();
        await book.call('resume');
        await air.call('retry', { handoffId: r.handoffId });
        await settled(r.handoffId, 'committed');
        expect(await book.call('view', { meshId: MESH })).toMatchObject({ role: 'host', hostEpoch: 1 });
        await exactOwnership(book, air);
    }, 60_000);

    it('source crash right after proving stop: restart keeps the fence and carries on, never reviving', async () => {
        await pairTarget();
        await air.call('set', { crashAfterStop: true });
        void air.call('start', { meshId: MESH, targetDaemonId: BOOK, targetNodeId: bookNode }).catch(() => undefined);
        await until(async () => air.dead);
        await air.spawn();
        expect(await air.call('admission', { meshId: MESH })).toMatchObject({ code: 'mesh_host_handoff_fenced' });
        expect(await air.call('live', { meshId: MESH })).toEqual([]);
        await air.call('resume');
        await until(async () => { await air.call('idle'); return (await air.call('view', { meshId: MESH })).role === 'member' && !!(await book.call('view', { meshId: MESH }))?.role; });
        await until(async () => { await air.call('tick'); return (await book.call('live', { meshId: MESH })).length === 1; });
        await exactOwnership(book, air);
    }, 60_000);

    it('target launch fails after authority: the source commits, and the target retries on an empty census only', async () => {
        await pairTarget();
        await book.call('set', { launchFails: true });
        const r = await start();
        await settled(r.handoffId, 'committed');
        expect(await book.call('live', { meshId: MESH })).toEqual([]);
        expect(await air.call('live', { meshId: MESH })).toEqual([]);
        // Unknown census never launches.
        await book.call('set', { censusUnknown: true });
        await book.call('shiftClock', { ms: 2 * 60_000 });
        await book.call('tick');
        expect(await book.call('live', { meshId: MESH })).toEqual([]);
        await book.call('set', { censusUnknown: false });
        await book.call('tick');
        await exactOwnership(book, air);
        await book.call('shiftClock', { ms: 2 * 60_000 });
        await book.call('tick');
        expect(await book.call('live', { meshId: MESH })).toHaveLength(1);
    }, 60_000);

    it('owner abort while waiting for the ACK rolls back and a retry from scratch then succeeds', async () => {
        await pairTarget();
        const before = await air.call('dump', { meshId: MESH });
        net.faults.push({ verb: 'mesh_host_handoff_ack', mode: 'drop_request', times: 1 });
        const r = await start();
        await settled(r.handoffId, 'awaiting_ack');
        expect(await air.call('abort', { handoffId: r.handoffId })).toMatchObject({ success: true });
        await rolledBack(before, r.handoffId);
        const second = await start();
        expect(second).toMatchObject({ success: true });
        expect(second.handoffId).not.toBe(r.handoffId);
        await settled(second.handoffId, 'committed');
        await exactOwnership(book, air);
    }, 60_000);
});
