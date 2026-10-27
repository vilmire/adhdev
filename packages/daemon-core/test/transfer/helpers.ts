import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectTransferEngine, type TransferHostPorts } from '../../src/transfer/engine.js';
import { createMemoryLinkPair, type TransferLink, type TransferLinkFactory } from '../../src/transfer/link.js';
import { TransferRateLimiter } from '../../src/transfer/rate-limit.js';

export function tmpDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `adh-xfer-${prefix}-`)));
}

export class LinkBroker {
  pairs = new Map<string, [TransferLink, TransferLink]>();
  taps: Array<(d: Uint8Array) => Uint8Array | null> = [];
  fingerprints?: [string, string];
  remoteSeen?: { a?: string; b?: string };
  created: string[] = [];
  factory(): TransferLinkFactory {
    return {
      create: ({ transferId, role, linkGen }) => {
        const key = `${transferId}:${linkGen}`;
        this.created.push(`${role}:${linkGen}`);
        let pair = this.pairs.get(key);
        if (!pair) {
          pair = createMemoryLinkPair({ fingerprints: this.fingerprints, remoteSeenByA: this.remoteSeen?.a, remoteSeenByB: this.remoteSeen?.b });
          this.pairs.set(key, pair);
          const tap = this.taps[0];
          if (tap) (pair[0] as any).__setTap(tap);
        }
        return role === 'initiator' ? pair[0] : pair[1];
      },
    };
  }
  /** Drop a live link (simulates network loss). */
  drop(transferId: string, gen: number): void { this.pairs.get(`${transferId}:${gen}`)?.[0].close(); }
}

export interface Side {
  id: string;
  engine: ProjectTransferEngine;
  ws: { id: string; path: string };
  base: string;
  ports: TransferHostPorts;
  authGen: { value: string };
  authorized: { value: boolean };
}

export function makeSide(id: string, broker: LinkBroker, peers: Map<string, Side>, opts?: { noLink?: boolean; rate?: TransferRateLimiter; base?: string; ws?: string }): Side {
  const base = opts?.base ?? tmpDir(`${id}-base`);
  const wsPath = opts?.ws ?? tmpDir(`${id}-ws`);
  const authGen = { value: 'gen-1' };
  const authorized = { value: true };
  const ports: TransferHostPorts = {
    baseDir: base,
    selfDaemonId: () => id,
    dispatchPeer: async (peerId, args) => {
      const peer = peers.get(peerId);
      if (!peer) return { ok: false, code: 'PEER_UNREACHABLE' };
      return peer.engine.handlePeerOp(id, JSON.parse(JSON.stringify(args)));
    },
    ownerAuthGeneration: () => authGen.value,
    isPeerAuthorized: () => authorized.value,
    resolveWorkspace: (wid) => (wid === `ws-${id}` ? { id: wid, path: wsPath } : null),
    linkFactory: opts?.noLink ? undefined : broker.factory(),
    rate: opts?.rate ?? new TransferRateLimiter(1e12),
  };
  const side: Side = { id, engine: new ProjectTransferEngine(ports), ws: { id: `ws-${id}`, path: wsPath }, base, ports, authGen, authorized };
  peers.set(id, side);
  return side;
}

export function writeTree(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, data] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    if (rel.endsWith('/')) { fs.mkdirSync(abs, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
  }
}

export function readTree(root: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  const dir = path.join(root, rel);
  for (const n of fs.readdirSync(dir).sort()) {
    const r = rel ? `${rel}/${n}` : n;
    const st = fs.lstatSync(path.join(root, r));
    if (st.isDirectory()) { out[`${r}/`] = ''; Object.assign(out, readTree(root, r)); } else out[r] = fs.readFileSync(path.join(root, r)).toString('latin1');
  }
  return out;
}

export async function waitFor<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 15));
  }
}

export async function setupPair(files: Record<string, string | Buffer>, finalName = 'incoming', selected = ['proj']) {
  const broker = new LinkBroker();
  const peers = new Map<string, Side>();
  const a = makeSide('daemon_mach_a', broker, peers);
  const b = makeSide('daemon_mach_b', broker, peers);
  writeTree(a.ws.path, files);
  const created = await a.engine.create({ workspaceId: a.ws.id, selected, targetDaemonId: b.id, targetWorkspaceId: b.ws.id, finalName });
  if (!created.ok) throw new Error(`create failed ${created.code}`);
  return { broker, peers, a, b, id: created.transferId, rec: created.record };
}

export async function approveBoth(a: Side, b: Side, id: string, digest: string) {
  const ra = await a.engine.approve(id, digest);
  const rb = await b.engine.approve(id, digest);
  return [ra, rb] as const;
}
