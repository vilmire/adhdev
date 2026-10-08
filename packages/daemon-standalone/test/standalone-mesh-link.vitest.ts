/**
 * Standalone multi-machine mesh wiring (design 2026-10-07 §4.3):
 * `StandaloneMeshLink` over REAL sockets on 127.0.0.1 — two links (a host
 * daemon and a member daemon) with their own peer-secret stores, the host
 * served through the same upgrade routing `index.ts` uses (a real
 * `StandaloneHttpApi` gate with a dashboard token configured).
 *
 * `@adhdev/daemon-core` resolves to its built dist at test time; the mesh
 * transport / handshake / secret-store modules are overlaid from source so
 * the test exercises the code this package wires, not a stale bundle.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

process.env.ADHDEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'adhdev-sa-mesh-link-'));

vi.mock('@adhdev/daemon-core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const transport = await import('../../daemon-core/src/mesh/transport/ws-mesh-transport.js');
  const handshake = await import('../../daemon-core/src/mesh/transport/mesh-peer-handshake.js');
  const secrets = await import('../../daemon-core/src/mesh/transport/mesh-peer-secrets.js');
  const seqscribeMesh = await import('../../daemon-core/src/seqscribe/standalone-mesh-seqscribe.js');
  return { ...actual, ...transport, ...handshake, ...secrets, ...seqscribeMesh };
});

type LinkModule = typeof import('../src/standalone-mesh-link.js');
type Secrets = typeof import('../../daemon-core/src/mesh/transport/mesh-peer-secrets.js');
let linkMod: LinkModule;
let secrets: Secrets;
let upgrade: typeof import('../src/standalone-seqscribe-upgrade.js');
let StandaloneHttpApi: typeof import('../src/standalone-http.js').StandaloneHttpApi;
let core: Record<string, any>;

beforeAll(async () => {
  linkMod = await import('../src/standalone-mesh-link.js');
  secrets = await import('../../daemon-core/src/mesh/transport/mesh-peer-secrets.js');
  upgrade = await import('../src/standalone-seqscribe-upgrade.js');
  ({ StandaloneHttpApi } = await import('../src/standalone-http.js'));
  core = await import('@adhdev/daemon-core') as Record<string, any>;
});

const MESH_ID = 'mesh-link-test';
const HOST_ID = 'standalone_mach_host0001';
const MEMBER_ID = 'standalone_mach_memb0001';
const HOST_CANON = 'daemon_mach_host0001';
const MEMBER_CANON = 'daemon_mach_memb0001';
const DASHBOARD_TOKEN = 'dashboard-token-for-mesh-test';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function storeFor(name: string): { filePath: string } {
  return { filePath: join(mkdtempSync(join(tmpdir(), `adhdev-mesh-store-${name}-`)), 'mesh-peer-secrets.json') };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface Calls {
  executed: Array<{ command: string; args: Record<string, unknown>; source: string }>;
  opened: string[];
  closed: string[];
  ready: number;
}

function makeLink(localDaemonId: string, store: { filePath: string }, seqscribe: any = null) {
  const link = new linkMod.StandaloneMeshLink({
    localDaemonId,
    secretStore: store,
    handshakeTimeoutMs: 1500,
    transport: { retryDelayMs: () => 50 },
  });
  const calls: Calls = { executed: [], opened: [], closed: [], ready: 0 };
  link.attach({
    execute: async (command, args, source) => {
      calls.executed.push({ command, args, source });
      return { success: true, answeredBy: localDaemonId, command };
    },
    router: {
      noteMeshPeerOpened: (id) => { calls.opened.push(id); },
      noteMeshPeerClosed: (id) => { calls.closed.push(id); },
      noteMeshTransportReady: () => { calls.ready += 1; },
    },
    seqscribe,
  });
  cleanups.push(() => link.close());
  return { link, calls };
}

/** The host's HTTP server, upgrade-routed exactly as index.ts routes it. */
async function serveHost(link: InstanceType<LinkModule['StandaloneMeshLink']>): Promise<{ port: number; base: string }> {
  const http = new StandaloneHttpApi({
    isReady: () => true,
    getStatus: () => ({}) as any,
    executeCommand: async () => ({}),
    rawTerminalService: () => ({}) as any,
    interactivePromptService: () => ({}) as any,
    isCliSession: () => false,
    createSessionHostClient: async () => ({}) as any,
  });
  http.configureAuth(DASHBOARD_TOKEN);
  const server: Server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => {
    const route = upgrade.routeStandaloneUpgrade(req, http, {
      seqscribePath: '/ws/seqscribe',
      seqscribeLaneAvailable: false,
      mesh: {
        rpcPath: core.WS_MESH_RPC_PATH,
        seqscribePath: core.STANDALONE_MESH_SEQSCRIBE_WS_PATH,
        isAvailable: (lane) => link.isAvailable(lane),
      },
    });
    if (route.kind === 'mesh') { link.handleUpgrade(route.lane, req, socket, head); return; }
    if (route.kind === 'reject') { upgrade.rejectStandaloneUpgrade(socket, route.status); return; }
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { port: address.port, base: `ws://127.0.0.1:${address.port}` };
}

function pair(hostStore: { filePath: string }, memberStore: { filePath: string }, port: number, opts: { memberSecret?: string } = {}): string {
  const secret = secrets.mintPeerSecret();
  const createdAt = new Date().toISOString();
  secrets.putPeerSecret({ meshId: MESH_ID, peerDaemonId: MEMBER_ID, role: 'host', secret, createdAt }, hostStore);
  secrets.putPeerSecret({
    meshId: MESH_ID,
    peerDaemonId: HOST_ID,
    role: 'member',
    secret: opts.memberSecret ?? secret,
    hostAddress: `http://127.0.0.1:${port}/some/dashboard/path`,
    createdAt,
  }, memberStore);
  return secret;
}

function rawDial(url: string, headers: Record<string, string> = {}): Promise<number | 'open' | 'destroyed'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => { resolve('open'); ws.terminate(); });
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
    ws.on('error', () => resolve('destroyed'));
  });
}

describe('StandaloneMeshLink — RPC lane', () => {
  it('a paired member dials the host; commands flow both ways with the proven sender stamped and source mesh', async () => {
    const hostStore = storeFor('host');
    const memberStore = storeFor('member');
    const host = makeLink(HOST_ID, hostStore);
    const { port } = await serveHost(host.link);
    const member = makeLink(MEMBER_ID, memberStore);
    expect(host.calls.ready).toBe(1);
    expect(member.calls.ready).toBe(1);

    // The member record lands AFTER attach: the store-change listener must start the dial.
    pair(hostStore, memberStore, port);
    await waitFor(() => member.link.transport.getPeerConnectionStatus(HOST_CANON)?.state === 'connected', 'member→host link');

    const memberBoot = member.link.bootConfig();
    const result = await memberBoot.dispatchMeshCommand!(HOST_ID, 'git_status', {
      meshId: MESH_ID,
      _statusProbe: true,
      // A peer-supplied sender claim must be overridden by the transport stamp.
      _meshSenderDaemonId: 'daemon_mach_evil',
    });
    expect(result).toMatchObject({ success: true, answeredBy: HOST_ID, command: 'git_status' });
    expect(host.calls.executed).toHaveLength(1);
    const inbound = host.calls.executed[0]!;
    expect(inbound.source).toBe('mesh');
    expect(inbound.args._meshSenderDaemonId).toBe(MEMBER_CANON);
    expect(inbound.args._meshDirectDispatch).toBe(true);
    expect(inbound.args).not.toHaveProperty('_statusProbe');
    expect(inbound.args.meshId).toBe(MESH_ID);

    // Reverse direction over the member-dialed socket.
    const reverse = await host.link.bootConfig().dispatchMeshCommand!(MEMBER_ID, 'mesh_status', { meshId: MESH_ID });
    expect(reverse).toMatchObject({ success: true, answeredBy: MEMBER_ID });
    expect(member.calls.executed[0]).toMatchObject({ command: 'mesh_status', source: 'mesh' });
    expect(member.calls.executed[0]!.args._meshSenderDaemonId).toBe(HOST_CANON);

    // Router lifecycle + peer status hooks.
    expect(member.calls.opened).toContain(HOST_CANON);
    expect(host.calls.opened).toContain(MEMBER_CANON);
    expect(host.link.bootConfig().getMeshPeerConnectionStatus!(MEMBER_ID)).toMatchObject({ state: 'connected', transport: 'direct' });
  });

  it('a member holding the wrong secret is refused by the handshake and no command runs on the host', async () => {
    const hostStore = storeFor('host-bad');
    const memberStore = storeFor('member-bad');
    const host = makeLink(HOST_ID, hostStore);
    const { port } = await serveHost(host.link);
    const member = makeLink(MEMBER_ID, memberStore);
    pair(hostStore, memberStore, port, { memberSecret: secrets.mintPeerSecret() });

    await waitFor(() => {
      const s = member.link.transport.getPeerConnectionStatus(HOST_CANON);
      return !!s && /HANDSHAKE/.test(String(s.lastFailureCode ?? ''));
    }, 'handshake rejection recorded');
    // Short connect-wait so the queued request gives up quickly instead of the 90 s deadline.
    await expect(member.link.transport.sendCommand(HOST_ID, 'git_status', { meshId: MESH_ID }, undefined, 200))
      .rejects.toMatchObject({ meshCode: expect.stringMatching(/PEER_NOT_CONNECTED|HANDSHAKE|RETAINED|NOT_CONNECTED/) });
    expect(host.calls.executed).toEqual([]);
    expect(host.calls.opened).toEqual([]);
  });

  it('revoking the host-side secret drops the live link, and the member cannot re-prove itself', async () => {
    const hostStore = storeFor('host-revoke');
    const memberStore = storeFor('member-revoke');
    const host = makeLink(HOST_ID, hostStore);
    const { port } = await serveHost(host.link);
    const member = makeLink(MEMBER_ID, memberStore);
    pair(hostStore, memberStore, port);
    await waitFor(() => host.link.transport.getPeerConnectionStatus(MEMBER_CANON)?.state === 'connected', 'link up');

    expect(secrets.removePeerSecret(MESH_ID, MEMBER_ID, hostStore)).toBe(true);
    await waitFor(() => host.link.transport.getPeerConnectionStatus(MEMBER_CANON)?.state !== 'connected', 'host dropped member');
    // The close edge reaches the router (it drops cached mesh_status renders of the member's nodes).
    expect(host.calls.closed).toContain(MEMBER_CANON);
    // The member keeps redialing (its record still exists) but the host no
    // longer admits it: with no host-role secret left the lane answers 503.
    await new Promise((r) => setTimeout(r, 300));
    expect(host.link.transport.getPeerConnectionStatus(MEMBER_CANON)?.state).not.toBe('connected');
    expect(member.link.transport.getPeerConnectionStatus(HOST_CANON)?.state).not.toBe('connected');
    expect(host.link.isAvailable('rpc')).toBe(false);
  });

  it('removing the member-side record stops dialing that host', async () => {
    const hostStore = storeFor('host-unpair');
    const memberStore = storeFor('member-unpair');
    const host = makeLink(HOST_ID, hostStore);
    const { port } = await serveHost(host.link);
    const member = makeLink(MEMBER_ID, memberStore);
    pair(hostStore, memberStore, port);
    await waitFor(() => member.link.transport.getPeerConnectionStatus(HOST_CANON)?.state === 'connected', 'link up');

    secrets.removePeerSecret(MESH_ID, HOST_ID, memberStore);
    await waitFor(() => host.link.transport.getPeerConnectionStatus(MEMBER_CANON)?.state !== 'connected', 'link down');
    const opensBefore = host.calls.opened.length;
    await new Promise((r) => setTimeout(r, 400));
    // retryDelayMs is 50 ms: a link that was still dialing would have reconnected by now.
    expect(host.calls.opened.length).toBe(opensBefore);
    expect(member.link.transport.getPeerConnectionStatus(HOST_CANON)?.state).not.toBe('connected');
  });
});

describe('StandaloneMeshLink — upgrade gate', () => {
  it('mesh lanes skip the dashboard token/Origin gate but answer 503 until a host-role secret exists', async () => {
    const hostStore = storeFor('host-gate');
    const host = makeLink(HOST_ID, hostStore);
    const { base } = await serveHost(host.link);

    expect(await rawDial(`${base}/ws/mesh`)).toBe(503);
    expect(await rawDial(`${base}/ws/mesh-seqscribe`)).toBe(503);

    secrets.putPeerSecret({
      meshId: MESH_ID, peerDaemonId: MEMBER_ID, role: 'host', secret: secrets.mintPeerSecret(), createdAt: new Date().toISOString(),
    }, hostStore);
    // No dashboard token, a foreign Origin: still upgraded — the handshake is the gate.
    expect(await rawDial(`${base}/ws/mesh`, { Origin: 'https://evil.example' })).toBe('open');
    // The replication lane needs the seqscribe link (null here) as well.
    expect(await rawDial(`${base}/ws/mesh-seqscribe`)).toBe(503);
  });

  it('a member-role record alone does not open the host lanes (only members of a mesh we host may dial in)', () => {
    const store = storeFor('member-only');
    const { link } = makeLink(MEMBER_ID, store);
    secrets.putPeerSecret({
      meshId: MESH_ID, peerDaemonId: HOST_ID, role: 'member', secret: secrets.mintPeerSecret(),
      hostAddress: '127.0.0.1:1', createdAt: new Date().toISOString(),
    }, store);
    expect(link.isAvailable('rpc')).toBe(false);
  });

  it('an upgraded socket that never completes the handshake is closed and runs nothing', async () => {
    const hostStore = storeFor('host-silent');
    const host = makeLink(HOST_ID, hostStore);
    const { base } = await serveHost(host.link);
    secrets.putPeerSecret({
      meshId: MESH_ID, peerDaemonId: MEMBER_ID, role: 'host', secret: secrets.mintPeerSecret(), createdAt: new Date().toISOString(),
    }, hostStore);
    const ws = new WebSocket(`${base}/ws/mesh`);
    ws.on('error', () => {});
    const closeCode = await new Promise<number>((resolve) => {
      ws.on('open', () => {
        // A forged RPC frame before any handshake must not reach the command handler.
        ws.send(JSON.stringify({ type: 'rpc_req', id: 'x', command: 'mesh_status', args: {} }));
      });
      ws.on('close', (code) => resolve(code));
    });
    expect(closeCode).toBe(core.MESH_HANDSHAKE_CLOSE_CODE);
    expect(host.calls.executed).toEqual([]);
  });
});

describe('StandaloneMeshLink — seqscribe lane', () => {
  function fakeSeqscribe() {
    const fake = {
      attached: [] as Array<{ meshId: string; hostDaemonId: string; dial: () => Promise<any> }>,
      accepted: [] as Array<{ meshId: string; memberDaemonId: string; socket: WebSocket; frames: string[] }>,
      detached: [] as Array<{ meshId: string; daemonId: string }>,
      closed: 0,
      attachHostLink(meshId: string, hostDaemonId: string, dial: () => Promise<any>) {
        fake.attached.push({ meshId, hostDaemonId, dial });
        return true;
      },
      acceptMemberSocket(meshId: string, memberDaemonId: string, socket: WebSocket) {
        const entry = { meshId, memberDaemonId, socket, frames: [] as string[] };
        socket.on('message', (m) => entry.frames.push(m.toString()));
        fake.accepted.push(entry);
        return true;
      },
      resolveTranscriptPeer: vi.fn((id: string) => (id === 'known' ? ({ peer: id } as any) : null)),
      detachMesh(meshId: string, daemonId: string) { fake.detached.push({ meshId, daemonId }); },
      close() { fake.closed += 1; },
    };
    return fake;
  }

  it('member replication dials /ws/mesh-seqscribe, proves itself, and the host adopts the socket with the proven ids', async () => {
    const hostStore = storeFor('host-ss');
    const memberStore = storeFor('member-ss');
    const hostSs = fakeSeqscribe();
    const memberSs = fakeSeqscribe();
    const host = makeLink(HOST_ID, hostStore, hostSs);
    const { port } = await serveHost(host.link);
    makeLink(MEMBER_ID, memberStore, memberSs);
    pair(hostStore, memberStore, port);

    await waitFor(() => memberSs.attached.length === 1, 'replication link attached');
    expect(memberSs.attached[0]).toMatchObject({ meshId: MESH_ID, hostDaemonId: HOST_CANON });
    const socket: WebSocket = await memberSs.attached[0]!.dial();
    expect(socket.readyState).toBe(WebSocket.OPEN);
    await waitFor(() => hostSs.accepted.length === 1, 'host adopted member socket');
    expect(hostSs.accepted[0]).toMatchObject({ meshId: MESH_ID, memberDaemonId: MEMBER_CANON });

    // The first post-handshake frame reaches the adopter intact.
    socket.send('HELLO-after-handshake');
    await waitFor(() => hostSs.accepted[0]!.frames.length === 1, 'frame delivered');
    expect(hostSs.accepted[0]!.frames).toEqual(['HELLO-after-handshake']);
    socket.terminate();

    // resolveTranscriptPeer is the boot hook, delegated lazily.
    expect(host.link.bootConfig().resolveTranscriptPeer!('known')).toEqual({ peer: 'known' });
    expect(host.link.bootConfig().resolveTranscriptPeer!('other')).toBeNull();

    // Unpairing on the member side detaches that mesh from replication.
    secrets.removePeerSecret(MESH_ID, HOST_ID, memberStore);
    expect(memberSs.detached).toContainEqual({ meshId: MESH_ID, daemonId: HOST_CANON });
    await expect(memberSs.attached[0]!.dial()).rejects.toThrow(/no longer present/);
  });

  it('close() closes the seqscribe link and refuses later upgrades', async () => {
    const store = storeFor('close');
    const ss = fakeSeqscribe();
    const { link } = makeLink(HOST_ID, store, ss);
    secrets.putPeerSecret({
      meshId: MESH_ID, peerDaemonId: MEMBER_ID, role: 'host', secret: secrets.mintPeerSecret(), createdAt: new Date().toISOString(),
    }, store);
    expect(link.isAvailable('seqscribe')).toBe(true);
    link.close();
    link.close();
    expect(ss.closed).toBe(1);
    expect(link.isAvailable('rpc')).toBe(false);
    expect(link.bootConfig().resolveTranscriptPeer!('known')).toBeNull();
  });
});

describe('meshPeerWsUrl', () => {
  it('maps every stored host-address form to the lane URL', () => {
    const { meshPeerWsUrl } = linkMod;
    expect(meshPeerWsUrl('192.168.1.5:3847', '/ws/mesh')).toBe('ws://192.168.1.5:3847/ws/mesh');
    expect(meshPeerWsUrl('100.64.0.2:3847/', '/ws/mesh-seqscribe')).toBe('ws://100.64.0.2:3847/ws/mesh-seqscribe');
    expect(meshPeerWsUrl('http://host.lan:3847/api/v1/mesh/join?x=1#y', '/ws/mesh')).toBe('ws://host.lan:3847/ws/mesh');
    expect(meshPeerWsUrl('https://user:pw@host.example/dash', '/ws/mesh')).toBe('wss://host.example/ws/mesh');
    expect(meshPeerWsUrl('ws://10.0.0.2:4000/whatever', '/ws/mesh')).toBe('ws://10.0.0.2:4000/ws/mesh');
    expect(meshPeerWsUrl('[fd00::1]:3847', '/ws/mesh')).toBe('ws://[fd00::1]:3847/ws/mesh');
    expect(() => meshPeerWsUrl('  ', '/ws/mesh')).toThrow(/hostAddress required/);
    expect(() => meshPeerWsUrl('ftp://x:1', '/ws/mesh')).toThrow(/unsupported/);
  });

  it('the lanes index.ts serves are the ones the join response advertises', async () => {
    const pairing = await import('../../daemon-core/src/commands/med-family/mesh-host-pairing.js');
    expect(core.WS_MESH_RPC_PATH).toBe(pairing.MESH_JOIN_TRANSPORT.wsPath);
    expect(core.STANDALONE_MESH_SEQSCRIBE_WS_PATH).toBe(pairing.MESH_JOIN_TRANSPORT.seqscribePath);
    // The cold source import of mesh-host-pairing (and its daemon-core graph) can
    // exceed the 5s default on a fresh CI runner (v1.0.77 tag run timed out here).
  }, 60_000);
});
