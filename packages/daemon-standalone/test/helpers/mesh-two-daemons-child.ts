/**
 * Child process for standalone-mesh-two-daemons.vitest.ts — ONE standalone
 * daemon core, wired the way `StandaloneServer.start` (src/index.ts) wires it,
 * minus the parts that would start other processes:
 *
 *   real:  bootDaemonRuntime (all eight stages: providers, router, seqscribe
 *          node, mesh runtime, loops) · createDaemonHostRuntime ·
 *          StandaloneMeshLink (WsMeshTransport + StandaloneMeshSeqscribe) ·
 *          StandaloneHttpApi (/api/v1/command, /api/v1/mesh/join) ·
 *          routeStandaloneUpgrade (/ws/mesh, /ws/mesh-seqscribe)
 *   absent: the session host (no adhdev-sessiond is spawned — `sessionHost: {}`,
 *          so no CLI agent can launch), the dashboard /ws lane, static files,
 *          the local IPC server, the dev server.
 *
 * The parent sets ADHDEV_CONFIG_DIR / HOME to per-node temp dirs and drives
 * the node through its REAL HTTP API; test-only probes (peer status, raw
 * socket kill, seqscribe register write/observe) go over the IPC channel.
 */
import { createServer, type Server } from 'node:http';
import {
  bootDaemonRuntime,
  createDaemonHostRuntime,
  loadConfig,
  setLogLevel,
  setConsoleLogLevel,
  StandaloneMeshSeqscribe,
  STANDALONE_SEQSCRIBE_WS_PATH,
  MESH_RPC_WS_PATH,
  MESH_SEQSCRIBE_WS_PATH,
  type DaemonHostRuntime,
  type DaemonRuntime,
} from '@adhdev/daemon-core';
import { StandaloneHttpApi } from '../../src/standalone-http.js';
import { routeStandaloneUpgrade, rejectStandaloneUpgrade } from '../../src/standalone-seqscribe-upgrade.js';
import { StandaloneMeshLink } from '../../src/standalone-mesh-link.js';
import { createStandaloneHostTransport } from '../../src/standalone-host-transport.js';

type Msg = { id: number; op: string; [k: string]: unknown };

const send = (payload: unknown): void => { process.send?.(payload); };

async function main(): Promise<void> {
  setLogLevel('warn');
  setConsoleLogLevel('error');
  const port = Number(process.env.MESH_TEST_PORT || 0);
  const redialMs = Number(process.env.MESH_TEST_REDIAL_MS || 300);
  const cfg = loadConfig();
  const statusInstanceId = `standalone_${cfg.machineId || 'mach_unknown'}`;

  const meshLink = new StandaloneMeshLink({
    localDaemonId: statusInstanceId,
    // Test-speed redial; the production ladder starts at 4 s.
    transport: { retryDelayMs: () => redialMs },
  });

  const bootMesh = meshLink.bootConfig();
  const runtime: DaemonRuntime = await bootDaemonRuntime({
    statusInstanceId,
    statusVersion: 'test',
    statusDaemonMode: false,
    sessionHost: {},
    enabledIdes: [],
    tickIntervalMs: 3000,
    cdpScanIntervalMs: 3_600_000,
    restoreHostedSessions: false,
    mesh: bootMesh,
  });
  const host: DaemonHostRuntime = createDaemonHostRuntime(runtime, createStandaloneHostTransport({
    statusInstanceId,
    version: 'test',
    clients: new Set(),
    wsByConnectionId: new Map(),
    getRuntime: () => runtime,
    getSessionHostControl: () => null,
    runtimeOutputTargets: () => [],
    flushTopic: () => {},
  }));
  const meshSeqscribe = runtime.seqscribe
    ? new StandaloneMeshSeqscribe(runtime.seqscribe.node, {
      localDaemonId: statusInstanceId,
      backoff: { minMs: redialMs, maxMs: 2_000, factor: 2 },
    })
    : null;
  meshLink.attach({
    execute: (command, args, source) => host.execute(command, args, source),
    router: runtime.components.router,
    seqscribe: meshSeqscribe,
  });

  const http = new StandaloneHttpApi({
    isReady: () => true,
    getStatus: () => ({}) as any,
    executeCommand: (type, payload) => host.execute(type, payload ?? {}, 'standalone') as Promise<any>,
    rawTerminalService: () => { throw new Error('no session host in this harness'); },
    interactivePromptService: () => { throw new Error('no session host in this harness'); },
    isCliSession: () => false,
    createSessionHostClient: async () => { throw new Error('no session host in this harness'); },
  });
  http.listenHost = '127.0.0.1';
  const server: Server = createServer((req, res) => http.handle(req, res));
  server.on('upgrade', (req, socket, head) => {
    const route = routeStandaloneUpgrade(req, http, {
      seqscribePath: STANDALONE_SEQSCRIBE_WS_PATH,
      seqscribeLaneAvailable: false,
      mesh: {
        rpcPath: MESH_RPC_WS_PATH,
        seqscribePath: MESH_SEQSCRIBE_WS_PATH,
        isAvailable: (lane) => meshLink.isAvailable(lane),
      },
    });
    if (route.kind === 'mesh') { meshLink.handleUpgrade(route.lane, req, socket, head); return; }
    if (route.kind === 'reject') { rejectStandaloneUpgrade(socket, route.status); return; }
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const bound = server.address();
  const boundPort = bound && typeof bound === 'object' ? bound.port : port;
  meshLink.setListenAddress({ host: '127.0.0.1', port: boundPort });

  const seen: Array<{ key: string; value: unknown; writer?: string }> = [];
  if (runtime.seqscribe) {
    runtime.seqscribe.node.node.onEntry('config.settings', 'mesh-two-daemons-test', (entry: any) => {
      seen.push({ key: String(entry?.key ?? ''), value: entry?.payload ?? entry?.value, writer: entry?.writer });
    });
  }

  const ops: Record<string, (msg: Msg) => Promise<unknown> | unknown> = {
    peerStatus: (m) => meshLink.transport.getPeerConnectionStatus(String(m.daemonId)),
    listPeers: () => meshLink.transport.listPeers(),
    // The exact hook the boot received as DaemonBootConfig.mesh.dispatchMeshCommand.
    dispatch: (m) => bootMesh.dispatchMeshCommand!(String(m.daemonId), String(m.command), (m.args ?? {}) as Record<string, unknown>),
    // Host side: drop every accepted mesh socket at the TCP level (no close frame).
    killMeshSockets: () => {
      const wss = (meshLink as unknown as { wss: { clients: Set<{ terminate(): void }> } }).wss;
      const count = wss.clients.size;
      for (const client of wss.clients) client.terminate();
      return count;
    },
    ssSet: async (m) => {
      if (!runtime.seqscribe) throw new Error('seqscribe node not open');
      await runtime.seqscribe.node.node.register('config.settings').set(String(m.key), m.value as any);
      return true;
    },
    ssSeen: () => seen,
    ssTopics: () => (runtime.seqscribe?.node.topics ?? []).map((t) => t.topic),
    ssWriter: () => runtime.seqscribe?.node.writerId ?? null,
    shutdown: async () => {
      meshLink.close();
      await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
      await runtime.shutdown();
      return true;
    },
  };

  process.on('message', async (raw) => {
    const msg = raw as Msg;
    const op = ops[msg.op];
    try {
      if (!op) throw new Error(`unknown op ${msg.op}`);
      const result = await op(msg);
      send({ id: msg.id, ok: true, result });
      if (msg.op === 'shutdown') setTimeout(() => process.exit(0), 50);
    } catch (error) {
      send({ id: msg.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  send({
    type: 'ready',
    port: boundPort,
    statusInstanceId,
    machineId: cfg.machineId,
    configDir: process.env.ADHDEV_CONFIG_DIR,
    seqscribe: !!runtime.seqscribe,
  });
}

main().catch((error) => {
  send({ type: 'fatal', error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) });
  setTimeout(() => process.exit(1), 50);
});
