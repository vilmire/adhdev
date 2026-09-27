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
 *     removed only on a DEFINITIVE daemon answer (accepted, or a non-retryable refusal) or
 *     when it ages past {@link WORKER_OUTBOX_MAX_AGE_MS}. Outcomes reached in the background
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
  report: new Set(['forward_failed', 'storage_failed', 'relay_result_malformed']),
  progress: new Set(['forward_failed', 'relay_result_malformed']),
};

/** A handler-level catch-all (`{ success:false, error: e.message }`) that names a transient condition. */
const TRANSIENT_ERROR_TEXT = /SQLITE_BUSY|database is locked|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE/i;

export interface WorkerOutboxEntry {
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

  constructor(private readonly dir: string | null, private readonly log: (line: string) => void = () => {}) {
    this.diskOk = !!dir;
    if (!dir) return;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(dir, name);
        try {
          const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as WorkerOutboxEntry;
          if (parsed?.v === 1 && typeof parsed.id === 'string' && (parsed.kind === 'report' || parsed.kind === 'progress')
            && typeof parsed.createdAtMs === 'number' && parsed.payload && typeof parsed.payload === 'object') {
            this.entries.set(parsed.id, parsed);
          } else {
            fs.rmSync(file, { force: true });
          }
        } catch {
          // A torn write from a crashed predecessor: unreadable, so unrecoverable.
          try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
        }
      }
    } catch (e: any) {
      this.diskOk = false;
      this.log(`outbox directory ${dir} unusable (${e?.message || e}); queued reports are kept in memory only`);
    }
  }

  private fileFor(id: string): string {
    return path.join(this.dir!, `${id}.json`);
  }

  put(entry: WorkerOutboxEntry): void {
    this.entries.set(entry.id, entry);
    if (!this.diskOk) return;
    try {
      const file = this.fileFor(entry.id);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e: any) {
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

export interface WorkerReportDeliveryOptions {
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
    return this.store.list().length;
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
    this.store.put(entry);

    let lastError = '';
    for (let i = 0; i < this.inlineAttempts; i += 1) {
      const attempt = await this.sendOnce(entry);
      if (attempt.kind === 'answered') {
        this.store.remove(entry.id);
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
          if (this.now() - entry.createdAtMs > this.maxAgeMs) {
            this.store.remove(entry.id);
            const what = entry.kind === 'report' ? 'completion report' : 'progress note';
            this.notices.push(
              `A queued ${what} (${entry.id}) could not be delivered within ${Math.round(this.maxAgeMs / 60_000)} min `
              + `(last error: ${entry.lastError || 'unknown'}) and was dropped. Put its content in your final message.`,
            );
            this.log(`${entry.kind} ${entry.id} expired undelivered`);
            continue;
          }
          const attempt = await this.sendOnce(entry);
          if (attempt.kind === 'answered') {
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
        if (this.store.list().length) this.schedule();
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
        deliveryId: entry.id,
        reportedAtMs: entry.createdAtMs,
      });
    } catch (e: any) {
      return this.retryable(entry, e?.message || String(e), true);
    }
    const error = typeof result?.error === 'string' ? result.error : '';
    if (result?.success !== true
      && (RETRYABLE_REFUSALS[entry.kind].has(error) || TRANSIENT_ERROR_TEXT.test(error))) {
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
