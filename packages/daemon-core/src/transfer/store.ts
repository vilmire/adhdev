/**
 * Durable transfer state under `<configDir>/project-transfers/`:
 *   records/<id>.json   state (no keys, no paths of foreign machines)
 *   spool/<id>/         frozen source bytes (private, 0700)
 *   receipts/<id>.json  detailed receipt (7 days)
 *   audit.jsonl         masked audit (30 days): ids/counts/outcomes only
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TRANSFER_RETENTION_MS } from './limits.js';
import type { ContentManifest, SelectionManifest } from './manifest.js';

export type TransferRole = 'source' | 'target';

export type TransferState =
  | 'previewed' | 'offered' | 'awaiting_approval' | 'freezing' | 'linking' | 'transferring' | 'paused'
  | 'verifying' | 'publishing' | 'completed' | 'failed' | 'cancelled' | 'expired' | 'revoked' | 'needs_reapproval';

export const TERMINAL_STATES: ReadonlySet<TransferState> = new Set(['completed', 'failed', 'cancelled', 'expired', 'revoked']);
/** States that count against the per-daemon concurrency cap. */
export const ACTIVE_STATES: ReadonlySet<TransferState> = new Set(['freezing', 'linking', 'transferring', 'paused', 'verifying', 'publishing']);

export interface ApprovalStamp {
  at: number;
  ownerAuthGeneration: string;
  restartEpoch: string;
}

export interface TransferRecord {
  v: 1;
  id: string;
  role: TransferRole;
  peerDaemonId: string;
  selection: SelectionManifest;
  selectionDigest: string;
  content?: ContentManifest;
  state: TransferState;
  errorCode?: string;
  errorDetail?: string;
  createdAt: number;
  updatedAt: number;
  activityAt: number;
  previewExpiresAt: number;
  localApproval?: ApprovalStamp;
  peerApproved?: boolean;
  linkGen: number;
  /** Per content file: blocks fully verified and checkpointed. */
  blocksDone: number[];
  bytesDone: number;
  totalBytes: number;
  publishedName?: string;
}

export interface TransferReceipt {
  id: string;
  role: TransferRole;
  outcome: string;
  errorCode?: string;
  finishedAt: number;
  publishedName?: string;
  files: Array<{ path: string; size: number; sha256: string }>;
  excluded: Array<{ path: string; reason: string }>;
}

export class TransferStore {
  constructor(readonly baseDir: string) {}

  private p(...parts: string[]): string { return path.join(this.baseDir, ...parts); }
  spoolDir(id: string): string { return this.p('spool', id); }

  private ensure(sub: string): string {
    const dir = this.p(sub);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  atomicWrite(file: string, data: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  }

  save(rec: TransferRecord): void {
    this.ensure('records');
    this.atomicWrite(this.p('records', `${rec.id}.json`), JSON.stringify(rec));
  }

  load(id: string): TransferRecord | null {
    try { return JSON.parse(fs.readFileSync(this.p('records', `${id}.json`), 'utf8')) as TransferRecord; } catch { return null; }
  }

  list(): TransferRecord[] {
    let names: string[] = [];
    try { names = fs.readdirSync(this.p('records')); } catch { return []; }
    const out: TransferRecord[] = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const rec = this.load(n.slice(0, -5));
      if (rec) out.push(rec);
    }
    return out;
  }

  remove(id: string): void {
    fs.rmSync(this.p('records', `${id}.json`), { force: true });
    this.removeSpool(id);
  }

  removeSpool(id: string): void {
    fs.rmSync(this.spoolDir(id), { recursive: true, force: true });
  }

  writeReceipt(r: TransferReceipt): void {
    this.atomicWrite(this.p('receipts', `${r.id}.json`), JSON.stringify(r));
  }

  readReceipt(id: string): TransferReceipt | null {
    try { return JSON.parse(fs.readFileSync(this.p('receipts', `${id}.json`), 'utf8')) as TransferReceipt; } catch { return null; }
  }

  /** Masked audit line: no file names, no paths. */
  audit(entry: { id: string; role: TransferRole; event: string; code?: string; files?: number; bytes?: number }, now = Date.now()): void {
    this.ensure('.');
    const line = JSON.stringify({ t: now, id: entry.id.slice(0, 8), role: entry.role, event: entry.event, ...(entry.code ? { code: entry.code } : {}), ...(entry.files !== undefined ? { files: entry.files } : {}), ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}) });
    fs.appendFileSync(this.p('audit.jsonl'), `${line}\n`, { mode: 0o600 });
  }

  /** Drop receipts > 7 d, audit lines > 30 d, terminal records > 7 d. Returns ids whose temp data is now stale. */
  gc(now = Date.now()): { staleTempIds: string[] } {
    try {
      for (const n of fs.readdirSync(this.p('receipts'))) {
        const f = this.p('receipts', n);
        if (now - fs.statSync(f).mtimeMs > TRANSFER_RETENTION_MS.receipt) fs.rmSync(f, { force: true });
      }
    } catch { /* none */ }
    try {
      const file = this.p('audit.jsonl');
      const kept = fs.readFileSync(file, 'utf8').split('\n').filter((l) => {
        if (!l) return false;
        try { return now - (JSON.parse(l).t as number) <= TRANSFER_RETENTION_MS.audit; } catch { return false; }
      });
      this.atomicWrite(file, kept.length ? `${kept.join('\n')}\n` : '');
    } catch { /* none */ }
    const staleTempIds: string[] = [];
    for (const rec of this.list()) {
      const idle = now - rec.activityAt;
      const age = now - rec.createdAt;
      if (TERMINAL_STATES.has(rec.state)) {
        this.removeSpool(rec.id);
        if (age > TRANSFER_RETENTION_MS.receipt) this.remove(rec.id);
      } else if (idle > TRANSFER_RETENTION_MS.tempIdle || age > TRANSFER_RETENTION_MS.tempMax) {
        staleTempIds.push(rec.id);
      }
    }
    return { staleTempIds };
  }
}
