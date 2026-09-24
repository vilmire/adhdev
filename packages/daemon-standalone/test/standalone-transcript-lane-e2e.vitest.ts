/**
 * End-to-end over a REAL `ws` socket: standalone HTTP upgrade gate →
 * daemon-core `StandaloneTranscriptLane` → a real seqscribe node, dialed by a
 * second real node playing the dashboard's transcript worker
 * (wiring-unification G6 prerequisite).
 *
 * What this adds over daemon-core's fake-socket suite: the `ws` package's own
 * EventTarget surface (string `data` for text frames, numeric `readyState`) is
 * what `webSocketChannel` actually receives in production, and the token gate
 * is the real `StandaloneHttpApi`.
 *
 * daemon-core is imported from SOURCE (like `standalone-status-event-ws`),
 * because the package entry resolves to a prebuilt `dist/` that may predate
 * this lane.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { webSocketChannel, type PeerHandle, type Row } from 'seqscribe';

process.env.ADHDEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'adhdev-sa-transcript-lane-e2e-'));

let StandaloneHttpApi: typeof import('../src/standalone-http.js').StandaloneHttpApi;
let upgrade: typeof import('../src/standalone-seqscribe-upgrade.js');
let laneMod: typeof import('../../daemon-core/src/seqscribe/standalone-transcript-lane.js');
let nodeMod: typeof import('../../daemon-core/src/seqscribe/node.js');
let activation: typeof import('../../daemon-core/src/seqscribe/transcript-activation.js');
let claimsMod: typeof import('../../daemon-core/src/seqscribe/transcript-topic-claim.js');
let topics: typeof import('../../daemon-core/src/seqscribe/topics.js');

beforeAll(async () => {
  ({ StandaloneHttpApi } = await import('../src/standalone-http.js'));
  upgrade = await import('../src/standalone-seqscribe-upgrade.js');
  laneMod = await import('../../daemon-core/src/seqscribe/standalone-transcript-lane.js');
  nodeMod = await import('../../daemon-core/src/seqscribe/node.js');
  activation = await import('../../daemon-core/src/seqscribe/transcript-activation.js');
  claimsMod = await import('../../daemon-core/src/seqscribe/transcript-topic-claim.js');
  topics = await import('../../daemon-core/src/seqscribe/topics.js');
});

const TOKEN = 'e2e-lane-token';
const FLEET_SECRET = 'e2e-lane-fleet-secret';
const SESSION_ID = 'sess-e2e-lane';

type NodeHandle = import('../../daemon-core/src/seqscribe/node.js').SeqscribeNodeHandle;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function openNode(name: string): NodeHandle {
  const dir = mkdtempSync(join(tmpdir(), `adhdev-sa-lane-${name}-`));
  const handle = nodeMod.openSeqscribeNode({
    dbPath: join(dir, 'seq.db'),
    env: { ADHDEV_SEQSCRIBE_FLEET_SECRET: FLEET_SECRET },
    storedFleetSecret: null,
    meshIds: [],
  });
  cleanups.push(async () => {
    await handle.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  return handle;
}

async function startDaemon(daemon: NodeHandle): Promise<string> {
  const http = new StandaloneHttpApi({
    isReady: () => true,
    getStatus: () => ({}) as any,
    executeCommand: async () => ({}),
    rawTerminalService: () => ({}) as any,
    interactivePromptService: () => ({}) as any,
    isCliSession: () => false,
    createSessionHostClient: async () => ({}) as any,
  });
  http.configureAuth(TOKEN);
  const lane = new laneMod.StandaloneTranscriptLane(daemon);
  const wss = new WebSocketServer({ noServer: true });
  const server: Server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => {
    const route = upgrade.routeStandaloneUpgrade(req, http, {
      seqscribePath: laneMod.STANDALONE_SEQSCRIBE_WS_PATH,
      seqscribeLaneAvailable: true,
    });
    if (route.kind === 'seqscribe') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('error', () => {});
        lane.accept(ws);
      });
    } else if (route.kind === 'reject') {
      upgrade.rejectStandaloneUpgrade(socket, route.status);
    } else {
      socket.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => {
    lane.close();
    wss.close();
    server.closeAllConnections?.();
    server.close(() => resolve());
  }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return `ws://127.0.0.1:${address.port}${laneMod.STANDALONE_SEQSCRIBE_WS_PATH}`;
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('standalone transcript lane over a real ws socket', () => {
  it('pins the wire path the dashboard dials', () => {
    expect(laneMod.STANDALONE_SEQSCRIBE_WS_PATH).toBe('/ws/seqscribe');
  });

  it('authenticated dashboard SUBs view:tail and receives SNAP then DELTA rows', async () => {
    const daemon = openNode('daemon');
    const browser = openNode('browser');
    const topic = topics.sessionTranscriptTopic(SESSION_ID);
    const claims = new claimsMod.TranscriptTopicClaimRegistry();
    expect(activation.ensureSessionTranscriptTopic(daemon, claims, SESSION_ID, 'standalone_mach_e2e').ok).toBe(true);
    await daemon.node.log(topic).append('transcript.revision.begin', { n: 1 });

    const url = await startDaemon(daemon);
    const ws = new WebSocket(`${url}?token=${TOKEN}`);
    cleanups.push(() => { ws.terminate(); });
    const peer: PeerHandle = browser.node.attach(webSocketChannel(ws as any), {
      peerId: 'daemon',
      peerClass: 'content',
      grants: {},
    });
    await waitFor(() => peer.state() === 'ready', 'peer ready');

    browser.node.defineTopic(topic, topics.sessionTranscriptPolicy());
    const snaps: Row[][] = [];
    const deltas: Row[][] = [];
    const sub = browser.node.subscribe(peer, { view: 'tail', params: { topic } });
    sub.onSnapshot((rows) => snaps.push(rows));
    sub.onDelta(({ upserts }) => deltas.push(upserts));

    await waitFor(() => snaps.length > 0, 'SNAP');
    expect(snaps[0]!.map((r) => r.kind)).toEqual(['transcript.revision.begin']);
    await daemon.node.log(topic).append('transcript.revision.commit', { n: 2 });
    await waitFor(() => deltas.length > 0, 'DELTA');
    expect(deltas.flat().map((r) => r.kind)).toContain('transcript.revision.commit');
  });

  it('unauthenticated upgrade is refused before any seqscribe frame flows', async () => {
    const daemon = openNode('daemon-unauth');
    const url = await startDaemon(daemon);
    const status = await new Promise<number | 'open'>((resolve) => {
      const ws = new WebSocket(url);
      ws.on('open', () => { resolve('open'); ws.terminate(); });
      ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
      ws.on('error', () => {});
    });
    expect(status).toBe(401);
  });
});
