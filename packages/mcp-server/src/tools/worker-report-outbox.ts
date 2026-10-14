/**
 * Durable delivery for a worker's `report_completion` / `progress_update`.
 *
 * ─── Why ────────────────────────────────────────────────────────────────
 *
 * 2026-09-27, coordinator daemon overloaded by a seqscribe resync storm: a worker's
 * `report_completion` hit the 15s IPC timeout three times in a row. The work was done;
 * the report never reached the coordinator, which then closed the task on a transcript
 * probe with no structured result — two investigations had to be dug back out of the
 * provider's on-disk transcript by hand. Coordinator tools survived the same window only
 * because a human retried them. A worker cannot be relied on to do that, and should not
 * have to: its report is the primary completion evidence.
 *
 * ─── What this does ─────────────────────────────────────────────────────
 *
 *  1. WRITE-AHEAD. Every report/note is written to an outbox file BEFORE the first send
 *     (per-worker directory, keyed by a hash of the worker's bind — never the bind itself).
 *  2. BOUNDED INLINE RETRY. A transport failure (timeout, refused/closed connection) or a
 *     refusal the daemon itself calls retryable (`forward_failed`, `storage_failed`, …) is
 *     retried once after a short backoff while the tool call is still open — sized to stay
 *     inside common MCP client tool timeouts.
 *  3. HONEST RESULT. If the daemon still has not given a definitive answer, the tool returns
 *     "queued for delivery" — not an error. An error made the worker believe its work was
 *     lost (and, measured, say so in its transcript instead of anywhere the coordinator reads).
 *  4. BACKGROUND DELIVERY. Queued entries are re-sent with exponential backoff, on every
 *     later worker tool call, and on MCP-server shutdown; entries a previous MCP-server
 *     process left behind (same bind ⇒ same directory) are picked up at startup. An entry is
 *     removed only on a DEFINITIVE daemon answer (accepted, or a non-retryable refusal); it is
 *     quarantined, without deletion, when it ages past {@link WORKER_OUTBOX_MAX_AGE_MS}. Outcomes reached in the background
 *     are appended to the worker's next tool response.
 *
 * ─── Why re-sending is safe ─────────────────────────────────────────────
 *
 * Each entry carries a `deliveryId`, stable across every retry, and its creation time
 * `reportedAtMs`. The daemon (daemon-core mesh/worker-report-idempotency.ts +
 * worker-report.ts) answers a re-send of an already-accepted delivery from a replay record
 * (exactly-once effect), and files a report written before the session was handed its
 * current task against the attempt that was live when it was written — never the new task.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CommandTransport } from '../transports/mode.js';

export type WorkerDeliveryKind = 'report' | 'progress';

/**
 * How long a queued report is retried. Mirrors the daemon's
 * WORKER_REPORT_MAX_DELIVERY_DELAY_MS (daemon-core mesh/worker-report.ts): past this the
 * daemon refuses the report as stale anyway.
 */
export const WORKER_OUTBOX_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Override for the outbox base directory (tests, or an operator relocating it). */
export const WORKER_OUTBOX_DIR_ENV = 'ADHDEV_WORKER_OUTBOX_DIR';

const DAEMON_COMMAND: Record<WorkerDeliveryKind, string> = {
  report: 'worker_report_completion',
  progress: 'worker_progress_update',
};

/**
 * Daemon refusals that record NOTHING and say "call again" — a retry can succeed.
 * `storage_failed` is retryable for a report (a write failure), but for a progress note
 * it means "no active attempt to record against", which a retry cannot fix.
 */
const RETRYABLE_REFUSALS: Record<WorkerDeliveryKind, ReadonlySet<string>> = {
  report: new Set(['forward_failed', 'storage_failed', 'relay_result_malformed', 'worker_protocol_unsupported', 'worker_protocol_provenance_required', 'worker_delivery_identity_conflict']),
  progress: new Set(['forward_failed', 'storage_failed', 'relay_result_malformed', 'worker_protocol_unsupported', 'worker_protocol_provenance_required', 'worker_delivery_identity_conflict']),
};

/** A handler-level catch-all (`{ success:false, error: e.message }`) that names a transient condition. */
const TRANSIENT_ERROR_TEXT = /SQLITE_BUSY|database is locked|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE/i;

interface WorkerOutboxEntry {
  v: 1;
  /** The delivery id the daemon dedupes on — stable across every retry of this entry. */
  id: string;
  kind: WorkerDeliveryKind;
  /** Content hash, so re-submitting an identical report reuses the queued entry. */
  payloadHash: string;
  /** Sent as `reportedAtMs`: when the worker made the call (attribution fence, daemon side). */
  createdAtMs: number;
  attempts: number;
  lastError?: string;
  quarantined?: string;
  prepared?: Record<string, unknown>;
  preparationIntent?: boolean;
  legacyMode?: boolean;
  /** The daemon command's payload minus credentials: `{ report }` or `{ note }`. */
  payload: Record<string, unknown>;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The outbox directory for one worker credential, or null when there is no credential to
 * key it by. The bind is hashed: the directory name must not become a second copy of the
 * secret on disk.
 */
export function resolveWorkerOutboxDir(
  credentials: { bind?: string; token?: string },
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const who = credentials.bind || credentials.token;
  if (!who) return null;
  const base = (typeof env[WORKER_OUTBOX_DIR_ENV] === 'string' && env[WORKER_OUTBOX_DIR_ENV]!.trim())
    ? env[WORKER_OUTBOX_DIR_ENV]!.trim()
    : path.join(os.tmpdir(), 'adhdev-worker-outbox');
  const key = createHash('sha256').update(who).digest('hex').slice(0, 24);
  return path.join(base, key);
}

/**
 * The outbox itself: an in-memory map mirrored to one JSON file per entry. Disk failures
 * degrade to memory-only (the entry still retries for this process's lifetime) rather than
 * failing the tool call — the send must never be blocked by the durability layer.
 */
export class WorkerOutboxStore {
  private readonly entries = new Map<string, WorkerOutboxEntry>();
  private diskOk: boolean;
  private corruptFiles = 0;
  private acknowledgments = new Map<string, Record<string, unknown>>();
  private acknowledgmentsDurable = true;
  private fileDigests = new Map<string,string>();
  private ackTemporaryFiles: string[] = [];
  private ackUnknownFiles: string[] = [];


  constructor(private readonly dir: string | null, private readonly log: (line: string) => void = () => {}) {
    this.diskOk = !!dir;
    if (!dir) return;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      dir=fs.realpathSync(dir);this.dir=dir;
      this.readAcknowledgments();
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(dir, name);
        try {
          const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('untrusted outbox file');
          const raw=fs.readFileSync(file,'utf8');
          const parsed = JSON.parse(raw) as WorkerOutboxEntry;
          this.fileDigests.set(name,createHash('sha256').update(raw).digest('hex'));
          if (parsed?.v === 1 && typeof parsed.id === 'string' && (parsed.kind === 'report' || parsed.kind === 'progress')
            && typeof parsed.createdAtMs === 'number' && parsed.payload && typeof parsed.payload === 'object') {
            this.entries.set(parsed.id, parsed);
          } else {
            this.corruptFiles += 1;
            this.log(`quarantined unreadable outbox file ${name}; preserved on disk`);
          }
        } catch {
          // A torn write from a crashed predecessor: unreadable, so unrecoverable.
          this.corruptFiles += 1;
          this.log(`quarantined unreadable outbox file ${name}; preserved on disk`);
        }
      }
    } catch (e: any) {
      this.diskOk = false;
      this.log(`outbox directory ${dir} unusable (${e?.message || e}); queued reports are kept in memory only`);
    }
  }

  private readAcknowledgments(): void {
    this.ackTemporaryFiles=[];this.ackUnknownFiles=[];
    if(!this.dir)return;
    const dir=path.join(this.dir,'.maintenance-acks');
    const seen=new Set<string>();let directoryObserved=false;
    try {
      const stat=fs.lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(dir)!==dir||stat.uid!==process.getuid?.())throw new Error('unknown acknowledgment directory');directoryObserved=true;
      for(const name of fs.readdirSync(dir).sort()){
        if(name.endsWith('.tmp')){this.ackTemporaryFiles.push(name);continue;}
        if(!/^(report|progress)-[A-Za-z0-9_.:-]{8,128}\.json$/.test(name)){this.ackUnknownFiles.push(name);continue;}
        const file=path.join(dir,name),s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>4096||(s.mode&0o077))throw new Error('unknown acknowledgment');
        const row=JSON.parse(fs.readFileSync(file,'utf8'));
        if(!row||typeof row.id!=='string'||!['report','progress'].includes(row.kind)||!['receipt','unproven'].includes(row.proof)||name!==`${row.kind}-${row.id}.json`)throw new Error('unknown acknowledgment');
        if(row.proof==='receipt'&&(!/^[a-f0-9]{64}$/.test(row.digest??'')||!['ownerDaemonId','senderDaemonId','taskId','attemptId','sessionId'].every(k=>typeof row[k]==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(row[k]))||!Number.isSafeInteger(row.generation)||row.generation<0))throw new Error('invalid receipt metadata');
        const selected=row.proof==='receipt'?{id:row.id,kind:row.kind,proof:row.proof,digest:row.digest,ownerDaemonId:row.ownerDaemonId,senderDaemonId:row.senderDaemonId,taskId:row.taskId,attemptId:row.attemptId,generation:row.generation,sessionId:row.sessionId}:{id:row.id,kind:row.kind,proof:row.proof};
        const prior=this.acknowledgments.get(`${row.kind}:${row.id}`);
        if(prior&&JSON.stringify(prior)!==JSON.stringify(selected))throw new Error('conflicting receipt');
        this.acknowledgments.set(`${row.kind}:${row.id}`,selected);seen.add(`${row.kind}:${row.id}`);
      }
      if([...this.acknowledgments.keys()].some(k=>!seen.has(k)))this.acknowledgmentsDurable=false;
    }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT'||directoryObserved||this.acknowledgments.size)this.acknowledgmentsDurable=false;}
  }

  /** Actual process-local metadata only. An empty directory cannot prove that
   * a different/old MCP process has no memory fallback or unacknowledged send. */
  maintenanceInventory() {
    this.readAcknowledgments();
    const entries = this.list().map(e => ({id:e.id,kind:e.kind,payloadHash:e.payloadHash,createdAtMs:e.createdAtMs,attempts:e.attempts,quarantined:!!e.quarantined}));
    let files: string[] = [], readable = false;
    try {
      if (this.dir) {
        const s=fs.lstatSync(this.dir);
        if (s.isDirectory() && !s.isSymbolicLink() && fs.realpathSync(this.dir)===path.resolve(this.dir)
          && (!process.getuid || s.uid===process.getuid())) {
          files=fs.readdirSync(this.dir).sort();
          readable=true;
        }
      }
    } catch { /* unknown remains closed */ }
    let changedFiles=0;
    if(readable&&this.dir)for(const name of files){
      if(name==='.maintenance-acks')continue;
      const expected=this.fileDigests.get(name);
      if(!expected)continue;
      try{const file=path.join(this.dir,name),s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==expected)changedFiles++;}catch{changedFiles++;}
    }
    const expected=entries.map(e=>`${e.id}.json`).sort();
    const temporaryFiles=[...files.filter(name=>name.endsWith('.tmp')),...this.ackTemporaryFiles.map(name=>`.maintenance-acks/${name}`)];
    const unknownFiles=[...files.filter(name=>name!=='.maintenance-acks'&&!expected.includes(name)),...this.ackUnknownFiles.map(name=>`.maintenance-acks/${name}`)];
    return {schema:1,pid:process.pid,durable:this.diskOk,directoryReadable:readable,
      diskSetMatchesMemory:readable && changedFiles===0 && JSON.stringify(files.filter(n=>n!=='.maintenance-acks'))===JSON.stringify(expected),
      quarantinedFileCount:this.corruptFiles+changedFiles,temporaryFiles,unknownFiles,
      memoryFallback:!this.diskOk,entries,acknowledgments:[...this.acknowledgments.values()].sort((a,b)=>`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),acknowledgmentsDurable:this.acknowledgmentsDurable&&this.diskOk};
  }

  /** Persist only actual definitive ACK metadata before forgetting the outbox
   * entry. Legacy/non-receipted answers stay explicitly unproven. */
  acknowledge(entry: WorkerOutboxEntry, result: any): void {
    const r=result?.deliveryReceipt;
    const exact=result?.success===true && r?.protocol===1 && r.deliveryId===entry.id && /^[a-f0-9]{64}$/.test(r.digest??'')
      && ['ownerDaemonId','senderDaemonId','taskId','attemptId','sessionId'].every(k=>typeof r[k]==='string'&&r[k].length>0)
      && Number.isSafeInteger(r.generation)&&r.generation>=0;
    const row={id:entry.id,kind:entry.kind,proof:exact?'receipt':'unproven',...(exact?{digest:r.digest,ownerDaemonId:r.ownerDaemonId,senderDaemonId:r.senderDaemonId,taskId:r.taskId,attemptId:r.attemptId,generation:r.generation,sessionId:r.sessionId}:{})};
    this.acknowledgments.set(`${entry.kind}:${entry.id}`,row);
    if(!this.dir||!this.diskOk){this.acknowledgmentsDurable=false;return;}
    const dir=path.join(this.dir,'.maintenance-acks'),bytes=JSON.stringify(row);
    const target=path.join(dir,`${entry.kind}-${entry.id}.json`),tmp=`${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(dir,{recursive:true,mode:0o700});
      const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||fs.realpathSync(dir)!==dir||s.uid!==process.getuid?.())throw new Error('untrusted acknowledgment directory');
      const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      // Immutable per-delivery files prevent concurrent MCP writers from losing
      // each other's ACKs. Never replace a conflicting receipt or prune history.
      try{fs.linkSync(tmp,target);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST'||fs.readFileSync(target,'utf8')!==bytes)throw e;}
      fs.unlinkSync(tmp);
      if(process.platform!=='win32'){for(const directory of [dir,this.dir]){const d=fs.openSync(directory,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}}
    }catch{this.acknowledgmentsDurable=false;}
  }

  private fileFor(id: string): string {
    return path.join(this.dir!, `${id}.json`);
  }

  get quarantinedFileCount(): number { return this.corruptFiles; }
  get durable(): boolean { return this.diskOk; }

  put(entry: WorkerOutboxEntry): void {
    this.entries.set(entry.id, entry);
    if (!this.diskOk) return;
    try {
      const file = this.fileFor(entry.id);
      const tmp = `${file}.${process.pid}.tmp`;
      const fd = fs.openSync(tmp, 'w', 0o600);
      const bytes=JSON.stringify(entry);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);this.fileDigests.set(path.basename(file),createHash('sha256').update(bytes).digest('hex'));
      // Persist the rename before claiming write-ahead durability. Windows
      // cannot fsync directories; file fsync + atomic rename covers process death.
      if (process.platform !== 'win32') {
        const parent = fs.openSync(this.dir!, 'r');
        try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      }
    } catch (e: any) {
      this.diskOk = false;
      this.log(`could not persist outbox entry ${entry.id} (${e?.message || e}); it is kept in memory only`);
    }
  }

  remove(id: string): void {
    this.entries.delete(id);
    if (!this.diskOk) return;
    try { fs.rmSync(this.fileFor(id), { force: true }); } catch { /* already gone */ }
  }

  list(): WorkerOutboxEntry[] {
    return [...this.entries.values()].sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  findByHash(kind: WorkerDeliveryKind, payloadHash: string): WorkerOutboxEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.kind === kind && entry.payloadHash === payloadHash) return entry;
    }
    return undefined;
  }
}

export type WorkerSubmitOutcome =
  | { status: 'answered'; result: any; attempts: number }
  | { status: 'queued'; entryId: string; error: string; attempts: number };

type SendAttempt = { kind: 'answered'; result: any } | { kind: 'retryable'; error: string };

interface WorkerReportDeliveryOptions {
  transport: CommandTransport;
  credentials: { bind?: string; token?: string };
  /** Outbox directory; `null` = memory-only. Default: {@link resolveWorkerOutboxDir}. */
  dir?: string | null;
  /** Renders a background-delivered daemon answer into the line the worker sees next. */
  describeAnswer?: (kind: WorkerDeliveryKind, result: any) => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Sends made while the tool call is still open. Default 2 (≈ 2 × 15s IPC budget). */
  inlineAttempts?: number;
  strictProtocol?: boolean;
  inlineBackoffMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxAgeMs?: number;
  /** Background timer on/off (tests drive `flush()` directly). Default true. */
  autoSchedule?: boolean;
  log?: (line: string) => void;
}

const UNREACHABLE_HOLD_MS = 30_000;

export class WorkerReportDelivery {
  private readonly store: WorkerOutboxStore;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly inlineAttempts: number;
  private readonly inlineBackoffMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxAgeMs: number;
  private readonly autoSchedule: boolean;
  private readonly log: (line: string) => void;
  private readonly notices: string[] = [];
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private lastTransportFailureAt = 0;
  private disposed = false;
  private activeSubmits = 0;

  constructor(private readonly opts: WorkerReportDeliveryOptions) {
    this.log = opts.log ?? ((line) => { process.stderr.write(`[adhdev-mcp] worker-outbox: ${line}\n`); });
    this.store = new WorkerOutboxStore(
      opts.dir === undefined ? resolveWorkerOutboxDir(opts.credentials) : opts.dir,
      this.log,
    );
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.inlineAttempts = Math.max(1, opts.inlineAttempts ?? 2);
    this.inlineBackoffMs = opts.inlineBackoffMs ?? 1_500;
    this.retryBaseMs = opts.retryBaseMs ?? 2_000;
    this.retryMaxMs = opts.retryMaxMs ?? 60_000;
    this.maxAgeMs = opts.maxAgeMs ?? WORKER_OUTBOX_MAX_AGE_MS;
    this.autoSchedule = opts.autoSchedule !== false;
  }

  /** Entries still awaiting a definitive daemon answer. */
  pendingCount(): number {
    return this.store.list().length + this.store.quarantinedFileCount;
  }

  /** No payloads, credentials, notices text or fabricated receipt proof. The
   * caller must join BOTH kinds with daemon ACKs and all other live MCPs. */
  maintenanceInventory() {
    return {...this.store.maintenanceInventory(),activeSubmits:this.activeSubmits,flushing:this.flushing!==null,
      pendingNoticeCount:this.notices.length,disposed:this.disposed,receiptsProven:false};
  }

  /** True shortly after a send failed at the transport — callers skip optional round trips. */
  daemonRecentlyUnreachable(): boolean {
    return this.lastTransportFailureAt > 0 && this.now() - this.lastTransportFailureAt < UNREACHABLE_HOLD_MS;
  }

  /** Background outcomes not yet shown to the worker; draining clears them. */
  takeNotices(): string[] {
    return this.notices.splice(0, this.notices.length);
  }

  /**
   * Deliver one report/note: write-ahead, bounded inline retry, then queue. Never throws
   * for a transport failure — that is what `queued` is for.
   */
  async submit(kind: WorkerDeliveryKind, payload: Record<string, unknown>): Promise<WorkerSubmitOutcome> {
    this.activeSubmits++;
    try { return await this.submitInternal(kind,payload); }
    finally { this.activeSubmits--; }
  }

  private async submitInternal(kind: WorkerDeliveryKind, payload: Record<string, unknown>): Promise<WorkerSubmitOutcome> {
    const payloadHash = createHash('sha256').update(`${kind}\u0000${stableStringify(payload)}`).digest('hex');
    // An identical report already queued (the worker re-called after "queued") reuses the
    // SAME delivery id, so the daemon sees one delivery, not two.
    let entry = this.store.findByHash(kind, payloadHash);
    if (!entry) {
      entry = {
        v: 1,
        id: `${kind === 'report' ? 'wr' : 'wp'}_${payloadHash.slice(0, 16)}_${randomBytes(6).toString('hex')}`,
        kind,
        payloadHash,
        createdAtMs: this.now(),
        attempts: 0,
        payload,
      };
    }
    const resumePreparation = entry.preparationIntent === true;
    if (this.opts.strictProtocol) { entry.preparationIntent = true; this.store.put(entry); }
    if (this.opts.strictProtocol && !this.store.durable) return { status: 'answered', result: { success: false, error: 'outbox_storage_failed', hint: 'No report was sent; repair local durable storage and call again.' }, attempts: entry.attempts };
    if (this.opts.strictProtocol && !entry.prepared && !entry.legacyMode && !entry.quarantined) {
      try {
        const proof: any = await this.opts.transport.command('worker_bridge_prepare', { ...this.opts.credentials, deliveryId: entry.id, reportedAtMs: entry.createdAtMs, resume: resumePreparation });
        if (proof?.success === true && proof?.protocol === 0 && proof?.legacy === true) entry.legacyMode = true;
        else {
          if (proof?.success !== true || proof?.protocol !== 1 || !proof?.prepared) throw new Error('worker_protocol_provenance_required');
          entry.prepared = proof.prepared;
        }
      } catch { entry.quarantined = 'provenance_unavailable_at_creation'; }
    }
    this.store.put(entry);
    if (entry.quarantined) { this.schedule(); return { status: 'answered', result: { success: false, error: 'worker_delivery_quarantined', detail: entry.quarantined }, attempts: entry.attempts }; }

    let lastError = '';
    for (let i = 0; i < this.inlineAttempts; i += 1) {
      const attempt = await this.sendOnce(entry);
      if (attempt.kind === 'answered') {
        if (!attempt.result?.receiptPending) { this.store.acknowledge(entry,attempt.result); this.store.remove(entry.id); }
        else this.schedule();
        return { status: 'answered', result: attempt.result, attempts: entry.attempts };
      }
      lastError = attempt.error;
      if (i < this.inlineAttempts - 1) await this.sleep(this.inlineBackoffMs);
    }
    this.log(`${kind} ${entry.id} queued after ${entry.attempts} failed send(s): ${lastError}`);
    this.schedule();
    return { status: 'queued', entryId: entry.id, error: lastError, attempts: entry.attempts };
  }

  /** Start a background flush if anything is queued (fire-and-forget). */
  kick(): void {
    if (this.disposed || !this.store.list().length) return;
    void this.flush();
  }

  /**
   * Re-send every queued entry, oldest first. Single-flight. Stops at the first transport
   * failure (the daemon is still unreachable — hammering it helps nobody) and reschedules.
   */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      try {
        for (const entry of this.store.list()) {
          if (entry.quarantined === 'provenance_unavailable_at_creation' && this.now() - entry.createdAtMs <= this.maxAgeMs) {
            try {
              const proof: any = await this.opts.transport.command('worker_bridge_prepare', { ...this.opts.credentials, deliveryId: entry.id, reportedAtMs: entry.createdAtMs, resume: true });
              if (proof?.success === true && proof?.protocol === 1 && proof?.prepared) { entry.prepared = proof.prepared; delete entry.quarantined; this.store.put(entry); }
            } catch { /* retain the unbound report; never infer a new attempt */ }
          }
          if (entry.quarantined && entry.quarantined !== 'provenance_unavailable_at_creation') continue;
          if (this.now() - entry.createdAtMs > this.maxAgeMs) {
            if (entry.quarantined === 'expired_undelivered') continue;
            entry.quarantined = 'expired_undelivered';
            this.store.put(entry);
            const what = entry.kind === 'report' ? 'completion report' : 'progress note';
            this.notices.push(
              `A queued ${what} (${entry.id}) could not be delivered within ${Math.round(this.maxAgeMs / 60_000)} min `
              + `(last error: ${entry.lastError || 'unknown'}) is quarantined locally for review; it was not dropped or accepted.`,
            );
            this.log(`${entry.kind} ${entry.id} expired undelivered`);
            continue;
          }
          if (entry.quarantined) continue;
          const attempt = await this.sendOnce(entry);
          if (attempt.kind === 'answered') {
            if (attempt.result?.receiptPending) { this.store.put(entry); continue; }
            this.store.acknowledge(entry,attempt.result);
            this.store.remove(entry.id);
            const rendered = this.opts.describeAnswer?.(entry.kind, attempt.result)
              ?? (attempt.result?.success === true ? 'delivered' : `refused (${attempt.result?.error || 'unknown_error'})`);
            const what = entry.kind === 'report' ? 'completion report' : 'progress note';
            this.notices.push(`Your queued ${what} (${entry.id}) reached the daemon after ${entry.attempts} attempt(s): ${rendered}`);
            this.log(`${entry.kind} ${entry.id} delivered from the outbox after ${entry.attempts} attempt(s)`);
            continue;
          }
          break;
        }
      } finally {
        this.flushing = null;
        if (this.store.list().some((entry) => !entry.quarantined || entry.quarantined === 'provenance_unavailable_at_creation')) this.schedule();
      }
    })();
    return this.flushing;
  }

  /** Stop the background timer (entries stay on disk for a successor process). */
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (!this.autoSchedule || this.disposed || this.timer) return;
    const exponent = Math.max(0, this.consecutiveFailures - 1);
    const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(exponent, 16));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
    // The stdio transport keeps the process alive while the worker is attached; a pending
    // retry must not be what holds a finished process open.
    this.timer.unref?.();
  }

  private async sendOnce(entry: WorkerOutboxEntry): Promise<SendAttempt> {
    entry.attempts += 1;
    let result: any;
    try {
      result = await this.opts.transport.command(DAEMON_COMMAND[entry.kind], {
        ...this.opts.credentials,
        ...entry.payload,
        ...(entry.prepared ? { prepared: entry.prepared } : {}),
        deliveryId: entry.id,
        reportedAtMs: entry.createdAtMs,
      });
    } catch (e: any) {
      return this.retryable(entry, e?.message || String(e), true);
    }
    const error = typeof result?.error === 'string' ? result.error : '';
    if (result?.success !== true
      && (RETRYABLE_REFUSALS[entry.kind].has(error) || error.includes('request failed decode') || error.startsWith('Unknown command: worker_') || TRANSIENT_ERROR_TEXT.test(error))) {
      const detail = typeof result?.detail === 'string' && result.detail ? ` — ${result.detail}` : '';
      return this.retryable(entry, `${error}${detail}`, false);
    }
    this.consecutiveFailures = 0;
    this.lastTransportFailureAt = 0;
    return { kind: 'answered', result };
  }

  private retryable(entry: WorkerOutboxEntry, error: string, transport: boolean): SendAttempt {
    entry.lastError = error;
    this.consecutiveFailures += 1;
    if (transport) this.lastTransportFailureAt = this.now();
    this.store.put(entry);
    return { kind: 'retryable', error };
  }
}
