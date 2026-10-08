/**
 * Two standalone daemons, one mesh (design
 * docs/design/2026-10-07-standalone-multi-machine-mesh.md §5 step 8, §8 risks 1 and 4).
 *
 * Two CHILD PROCESSES (test/helpers/mesh-two-daemons-child.ts), each a real
 * standalone daemon core — staged boot, router, seqscribe node, StandaloneMeshLink,
 * the real HTTP API and upgrade router — with its own ADHDEV_CONFIG_DIR/HOME and
 * its own 127.0.0.1 port. No session host is started, so no CLI agent can run.
 *
 * The pairing is driven exactly as the dashboard card drives it: host
 * `create_mesh_host_pairing_token`, member `configure_mesh_host_pairing`
 * (bare `127.0.0.1:<port>`) + `join_mesh_host_pairing` with only meshId + token,
 * all through each daemon's /api/v1/command. Then: both sides hold peer secrets,
 * the member's WS link connects, RPC works in both directions, a seqscribe
 * register entry written on the member reaches the host, a host-side socket kill
 * and a full host restart are both followed by reconnection.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';

const CHILD = resolve(__dirname, 'helpers/mesh-two-daemons-child.ts');

interface Ready {
  port: number;
  statusInstanceId: string;
  machineId: string;
  configDir: string;
  seqscribe: boolean;
}

class Node {
  private seq = 0;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  readonly logs: string[] = [];
  ready!: Ready;
  private exited = false;

  private constructor(readonly name: string, readonly child: ChildProcess) {
    child.on('message', (raw: any) => {
      if (raw && typeof raw.id === 'number') {
        const waiter = this.pending.get(raw.id);
        if (!waiter) return;
        this.pending.delete(raw.id);
        if (raw.ok) waiter.resolve(raw.result);
        else waiter.reject(new Error(`${name}: ${raw.error}`));
      }
    });
    const keep = (chunk: Buffer) => {
      this.logs.push(chunk.toString('utf8'));
      if (this.logs.length > 400) this.logs.shift();
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('exit', () => {
      this.exited = true;
      for (const waiter of this.pending.values()) waiter.reject(new Error(`${name} exited`));
      this.pending.clear();
    });
  }

  static async start(name: string, home: string, port = 0): Promise<Node> {
    const configDir = join(home, '.adhdev-standalone');
    mkdirSync(configDir, { recursive: true });
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD], {
      cwd: resolve(__dirname, '..'),
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ADHDEV_CONFIG_DIR: configDir,
        MESH_TEST_PORT: String(port),
        MESH_TEST_REDIAL_MS: '300',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    const node = new Node(name, child);
    node.ready = await new Promise<Ready>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name} did not boot in 40s:\n${node.logs.join('')}`)), 40_000);
      child.on('message', (raw: any) => {
        if (raw?.type === 'ready') { clearTimeout(timer); resolveReady(raw as Ready); }
        if (raw?.type === 'fatal') { clearTimeout(timer); reject(new Error(`${name} boot failed: ${raw.error}\n${node.logs.join('')}`)); }
      });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`${name} exited during boot (${code}):\n${node.logs.join('')}`)); });
    });
    return node;
  }

  get base(): string { return `http://127.0.0.1:${this.ready.port}`; }

  op<T = any>(op: string, extra: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolveOp, reject) => {
      this.pending.set(id, { resolve: resolveOp as (v: unknown) => void, reject });
      this.child.send({ id, op, ...extra });
    });
  }

  /** The daemon's real HTTP command route (no dashboard token configured). */
  async command<T = any>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`${this.base}/api/v1/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, payload }),
    });
    return (await res.json()) as T;
  }

  async stop(): Promise<void> {
    if (this.exited) return;
    await this.op('shutdown').catch(() => {});
    await new Promise<void>((done) => {
      if (this.exited) return done();
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); done(); }, 5_000);
      this.child.once('exit', () => { clearTimeout(timer); done(); });
    });
  }
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value as T;
      last = value;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

/** HTTP status a raw WebSocket upgrade request gets (101 when it would upgrade). */
function upgradeStatus(port: number, path: string): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port, path,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolveStatus(res.statusCode ?? 101); });
    req.on('response', (res) => { res.resume(); resolveStatus(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
}

function readSecrets(configDir: string): Array<{ meshId: string; peerDaemonId: string; role: string; hostAddress?: string; secret: string }> {
  const raw = JSON.parse(readFileSync(join(configDir, 'mesh-peer-secrets.json'), 'utf8'));
  return Array.isArray(raw) ? raw : Array.isArray(raw?.records) ? raw.records : Object.values(raw?.peers ?? raw ?? {});
}

function unwrap(result: any): any {
  // dispatchMeshCommand resolves with the remote router result (possibly wrapped).
  return result && typeof result === 'object' && 'result' in result && !('success' in result) ? result.result : result;
}

const roots: string[] = [];
const nodes: Node[] = [];

afterAll(async () => {
  await Promise.all(nodes.map((n) => n.stop()));
  // Exited children can still have a pending fs write in flight; retry once.
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  await new Promise((r) => setTimeout(r, 300));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}, 30_000);

describe('standalone multi-machine mesh — two daemon processes', () => {
  it('pairs by address + code, links over WS, relays RPC both ways, replicates seqscribe and reconnects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-mesh-two-'));
    roots.push(root);
    const hostHome = join(root, 'host');
    const memberHome = join(root, 'member');
    const memberRepo = join(root, 'member-repo');
    const hostRepo = join(root, 'host-repo');
    for (const dir of [hostHome, memberHome, memberRepo, hostRepo]) mkdirSync(dir, { recursive: true });
    for (const repo of [hostRepo, memberRepo]) {
      writeFileSync(join(repo, 'README.md'), 'repo\n');
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, windowsHide: true });
    }

    let host = await Node.start('host', hostHome);
    nodes.push(host);
    const member = await Node.start('member', memberHome);
    nodes.push(member);

    // §8 risk 4: separate config dirs ⇒ distinct machine ids on one machine.
    expect(host.ready.configDir).not.toBe(member.ready.configDir);
    expect(host.ready.machineId).toBeTruthy();
    expect(member.ready.machineId).toBeTruthy();
    expect(host.ready.machineId).not.toBe(member.ready.machineId);
    expect(host.ready.seqscribe).toBe(true);
    expect(member.ready.seqscribe).toBe(true);
    const hostId = host.ready.statusInstanceId;
    const memberId = member.ready.statusInstanceId;

    // ── Host: mesh + one-time code; the card's address info (loopback bind). ──
    const hostMesh = await host.command('create_mesh', { name: 'host-mesh', repoIdentity: 'github.com/acme/two-daemons' });
    expect(hostMesh.success).toBe(true);
    const hostMeshId = hostMesh.mesh.id as string;
    // The host's own checkout is the mesh's first node, as after onboarding.
    const hostNode = await host.command('add_mesh_node', { meshId: hostMeshId, workspace: hostRepo });
    expect(hostNode.success).toBe(true);
    const token = await host.command('create_mesh_host_pairing_token', { meshId: hostMeshId });
    expect(token.success).toBe(true);
    expect(typeof token.token).toBe('string');
    const pairingInfo = await host.command('get_mesh_host_pairing', { meshId: hostMeshId });
    expect(pairingInfo.addressCandidates).toEqual([]);
    expect(pairingInfo.bindWarning).toBe('loopback_only');

    // No pairing secret yet ⇒ the mesh lanes are closed (503, no handshake surface).
    expect(await upgradeStatus(host.ready.port, '/ws/mesh')).toBe(503);
    expect(await upgradeStatus(host.ready.port, '/ws/mesh-seqscribe')).toBe(503);

    // ── Member: its own mesh + node, then address + code only (the card flow). ──
    const memberMesh = await member.command('create_mesh', { name: 'member-mesh', repoIdentity: 'github.com/acme/two-daemons', workspace: memberRepo });
    expect(memberMesh.success).toBe(true);
    const memberMeshId = memberMesh.mesh.id as string;
    const added = await member.command('add_mesh_node', { meshId: memberMeshId, workspace: memberRepo });
    expect(added.success).toBe(true);
    const configured = await member.command('configure_mesh_host_pairing', {
      meshId: memberMeshId, hostAddress: `127.0.0.1:${host.ready.port}`, token: token.token,
    });
    expect(configured.success).toBe(true);
    const joined = await member.command('join_mesh_host_pairing', { meshId: memberMeshId, token: token.token });
    expect(joined.success, JSON.stringify(joined)).toBe(true);
    expect(joined.transport).toBe('standalone_http_mesh_join');
    expect(joined.peerSecretStored).toBe(true);
    expect(joined.peerSecretMeshId).toBe(hostMeshId);
    expect(JSON.stringify(joined)).not.toMatch(/"peerSecret":"(?!\[redacted\])/);

    // A replay of the spent code is refused.
    const replay = await fetch(`${host.base}/api/v1/mesh/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meshId: hostMeshId, token: token.token, memberNode: { workspace: '/x', daemonId: 'standalone_mach_attacker' } }),
    });
    expect(replay.status).toBe(403);

    // ── Both sides hold the same secret, keyed by the host's mesh id. ──
    const hostSecrets = readSecrets(host.ready.configDir);
    const memberSecrets = readSecrets(member.ready.configDir);
    const hostRecord = hostSecrets.find((r) => r.meshId === hostMeshId && r.role === 'host');
    const memberRecord = memberSecrets.find((r) => r.meshId === hostMeshId && r.role === 'member');
    expect(hostRecord, JSON.stringify(hostSecrets.map((r) => ({ ...r, secret: '*' })))).toBeTruthy();
    expect(memberRecord).toBeTruthy();
    expect(memberRecord!.secret).toBe(hostRecord!.secret);
    expect(memberRecord!.hostAddress).toBe(`127.0.0.1:${host.ready.port}`);

    // Paired ⇒ the lane upgrades (the HMAC handshake, not HTTP, is the gate now).
    expect(await upgradeStatus(host.ready.port, '/ws/mesh')).toBe(101);

    // ── The member's WS link reaches 'connected' (both perspectives). ──
    await waitFor('member → host link connected', async () => (await member.op('peerStatus', { daemonId: hostId }))?.state === 'connected');
    await waitFor('host sees member connected', async () => (await host.op('peerStatus', { daemonId: memberId }))?.state === 'connected');

    // ── RPC host → member and member → host over dispatchMeshCommand. ──
    const fromMember = unwrap(await host.op('dispatch', { daemonId: memberId, command: 'get_status_metadata', args: {} }));
    expect(JSON.stringify(fromMember)).toContain(member.ready.machineId);
    const fromHost = unwrap(await member.op('dispatch', { daemonId: hostId, command: 'get_status_metadata', args: {} }));
    expect(JSON.stringify(fromHost)).toContain(host.ready.machineId);

    // The host's mesh_status reports the member's live link on node.connection.
    const status = await host.command('mesh_status', { meshId: hostMeshId });
    const memberNode = (status?.nodes ?? status?.status?.nodes ?? []).find((n: any) => typeof n?.daemonId === 'string' && n.daemonId.includes(member.ready.machineId));
    expect(memberNode?.connection?.state, JSON.stringify(status).slice(0, 2000)).toBe('connected');

    // ── The coordinator's routing: the member's checkout path EXISTS on this
    //    shared filesystem, yet the node is the member's (a live linked peer) —
    //    so it routes remote, not 'checkout_on_this_machine'. ──
    const memberNodeId = String(memberNode?.id ?? memberNode?.nodeId ?? '');
    expect(memberNodeId).toBeTruthy();
    const routes = await host.command('mesh_node_route', { meshId: hostMeshId });
    expect(routes?.routes?.[memberNodeId], JSON.stringify(routes)).toMatchObject({ route: 'remote', reason: 'owner_is_linked_peer' });

    // ── mesh_relay_command (the coordinator MCP's remote-node entry, over the
    //    real HTTP command route): the verb runs on the MEMBER daemon. ──
    const relayed = await host.command('mesh_relay_command', { targetDaemonId: memberId, command: 'get_status_metadata', args: {} });
    expect(relayed?.success, JSON.stringify(relayed).slice(0, 1000)).not.toBe(false);
    expect(JSON.stringify(relayed)).toContain(member.ready.machineId);
    const relayedGit = await host.command('mesh_relay_command', { targetDaemonId: memberId, command: 'git_status', args: { workspace: memberRepo } });
    expect(relayedGit?.success, JSON.stringify(relayedGit).slice(0, 1000)).toBe(true);
    // Self-targeted (any id form) runs on this daemon instead of self-dialing.
    const selfRelayed = await host.command('mesh_relay_command', { targetDaemonId: `daemon_${host.ready.machineId}`, command: 'get_status_metadata', args: {} });
    expect(JSON.stringify(selfRelayed)).toContain(host.ready.machineId);
    expect(JSON.stringify(selfRelayed)).not.toContain('SELF_DIAL');

    // ── seqscribe: a register entry written on the member reaches the host. ──
    const marker = { from: 'member', at: Date.now() };
    await member.op('ssSet', { key: 'test.twoDaemons', value: marker });
    const memberWriter = await member.op<string>('ssWriter');
    const replicated = await waitFor<{ key: string; value: any; writer?: string }>('host observes the member seqscribe entry', async () => {
      const seen = await host.op<Array<{ key: string; value: any; writer?: string }>>('ssSeen');
      return seen.find((e) => JSON.stringify(e).includes(String(marker.at)));
    }, 15_000);
    // Written by the MEMBER's writer, observed in the HOST's node.
    expect(memberWriter).toBeTruthy();
    expect(replicated.writer).toBe(memberWriter);
    expect(await host.op<string>('ssWriter')).not.toBe(memberWriter);
    // Both nodes define the host mesh's topics, so mesh events/handoff can replicate.
    expect(await member.op<string[]>('ssTopics')).toContain(`mesh.${hostMeshId}.events`);
    expect(await host.op<string[]>('ssTopics')).toContain(`mesh.${hostMeshId}.events`);

    // ── Host drops the sockets (TCP level) → the member redials. ──
    const killed = await host.op<number>('killMeshSockets');
    expect(killed).toBeGreaterThanOrEqual(1);
    await waitFor('member notices the drop', async () => (await member.op('peerStatus', { daemonId: hostId }))?.state !== 'connected', 5_000);
    await waitFor('member reconnects after a socket kill', async () => (await member.op('peerStatus', { daemonId: hostId }))?.state === 'connected');
    const afterKill = unwrap(await host.op('dispatch', { daemonId: memberId, command: 'get_status_metadata', args: {} }));
    expect(JSON.stringify(afterKill)).toContain(member.ready.machineId);

    // ── Host process restarts on the same port + config dir → the member reconnects. ──
    const port = host.ready.port;
    await host.stop();
    nodes.splice(nodes.indexOf(host), 1);
    await waitFor('member sees the host gone', async () => (await member.op('peerStatus', { daemonId: hostId }))?.state !== 'connected', 5_000);
    host = await Node.start('host', hostHome, port);
    nodes.push(host);
    expect(host.ready.statusInstanceId).toBe(hostId);
    await waitFor('member reconnects to the restarted host', async () => (await member.op('peerStatus', { daemonId: hostId }))?.state === 'connected', 15_000);
    const afterRestart = unwrap(await member.op('dispatch', { daemonId: hostId, command: 'get_status_metadata', args: {} }));
    expect(JSON.stringify(afterRestart)).toContain(host.ready.machineId);
  }, 90_000);
});
