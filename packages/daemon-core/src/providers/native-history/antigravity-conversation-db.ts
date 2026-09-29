/**
 * antigravity-cli per-session conversation database (`conversations/<uuid>.db`,
 * the current store format): the step trajectory → message projection, the
 * on-demand tool-block re-read, and the background-task lifecycle reader.
 *
 * Split out of antigravity-cli-transcript.ts (file-size gate).
 */
import * as path from 'path';
import { loadBetterSqlite3 } from '../../system/load-better-sqlite3.js';
import { LOG } from '../../logging/logger.js';
import { recordBlockSource } from '../../chat/message-source-address.js';
import { oneLine, TOOL_RESULT_SUMMARY_MAX } from '../spec/native-history-tool-blocks.js';
import {
    firstLenField, decodeProtoFields, AGY_STEP_TYPE_USER, AGY_STEP_TYPE_MODEL, AGY_STATUS_DONE,
    AGY_STEP_TYPES_NEVER_TOOL, extractUserPrompt, recoverMessageText, topLevelFieldNumbers,
    extractModelToolCalls, summarizeAgyToolCallArgs, extractModelAnswer, extractModelReasoning,
    extractTaskNotification, isSettledToolStatus, extractToolStepResult, fullAgyToolCallArgs, extractUserRequestContent,
} from './antigravity-proto.js';
import type { NativeHistoryMessage } from './antigravity-cli-transcript.js';
import { statMtimeMs } from './fs-utils.js';

interface AgyDbStepRow {
  idx: number;
  step_type: number;
  step_payload: Buffer | null;
  /** Absent when the store's `steps` table has no `metadata` column. */
  metadata?: Buffer | null;
  /** Absent when the store's `steps` table has no `status` column. */
  status?: number;
  /** Absent when the store's `steps` table has no `error_details` column. */
  error_details?: Buffer | null;
}

/**
 * (ANTIGRAVITY-STALE-TURN-TIMESTAMP) Decode a step's REAL creation time from its
 * `metadata` blob.
 *
 * The reader used to synthesize every message's `receivedAt` from the .db file's
 * CURRENT mtime (`baseTs + messages.length`). That collapses a whole multi-turn
 * conversation into a few consecutive milliseconds, and — because mtime moves
 * every time antigravity touches the store — it RESTAMPS old turns to "now".
 * The completion gate's staleness guard (completionHasFinalAssistantMessage:
 * `ts < turnStartedAt` ⇒ reject) then fails open: the previous task's answer
 * looks like it arrived after the new turn started, so injecting a new task
 * completes instantly against the OLD reply, leaving the screen on an empty
 * prompt while the session sits in `generating`.
 *
 * `metadata` is a protobuf message whose field 1 is a google.protobuf.Timestamp
 * (seconds + nanos) holding the step's creation time. Verified across every real
 * store: all 2723 step_type 14/15 rows in 291 conversations decode, and the
 * decoded times are monotonic by idx in 100% of stores.
 *
 * Returns null when the blob is absent or carries no plausible timestamp, so the
 * caller can fall back to the old mtime synthesis rather than dropping the turn.
 */
function extractStepCreatedAtMs(metadata: Buffer | null): number | null {
  if (!metadata || !Buffer.isBuffer(metadata) || metadata.length === 0) return null;
  const stamp = firstLenField(metadata, 1);
  if (!stamp) return null;
  let seconds = 0;
  let nanos = 0;
  for (const f of decodeProtoFields(stamp)) {
    if (f.wireType !== 0 || typeof f.varint !== 'number') continue;
    if (f.field === 1) seconds = f.varint;
    else if (f.field === 2) nanos = f.varint;
  }
  // Sanity-bound the value so a mis-decoded field can never produce a wild
  // timestamp: accept only 2017-07-14 .. 2049-03-22 (epoch seconds).
  if (!(seconds > 1_500_000_000 && seconds < 2_500_000_000)) return null;
  const ms = seconds * 1000 + Math.floor(nanos / 1_000_000);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * True when an error thrown by better-sqlite3 open/read is a transient
 * SQLITE_BUSY / "database is locked" condition rather than a permanent one.
 *
 * On win32 antigravity holds a mandatory WAL write/checkpoint lock while it
 * persists a step; a readonly open racing that lock throws SQLITE_BUSY. That
 * is transient — the answer IS already on disk — so it must be retried, NOT
 * collapsed to "no session" (which erases the just-written assistant answer on
 * a chat_history re-query). macOS advisory locking + WAL reader-doesn't-block-
 * writer masks this, which is why it is win32-specific.
 */
function isSqliteBusyError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as any).code;
  if (typeof code === 'string' && code.includes('SQLITE_BUSY')) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /SQLITE_BUSY|database is locked|database table is locked/i.test(msg);
}

const AGY_DB_BUSY_TIMEOUT_MS = 3000;
const AGY_DB_MAX_ATTEMPTS = 4;
const AGY_DB_RETRY_BACKOFF_MS = [50, 100, 150];

function sleepBusy(ms: number): void {
  // Synchronous busy-wait: parseConversationDb is a sync function called from a
  // sync read path, and better-sqlite3 itself is synchronous. The waits are
  // tiny (≤150ms) and only occur under genuine lock contention, so a short
  // spin-sleep is acceptable and keeps the call site synchronous.
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

/**
 * Parse a per-session conversations/<uuid>.db (SQLite) into NativeHistoryMessages.
 * Returns null when the db is unreadable, empty, or yields no chat messages.
 */
export function parseConversationDb(
  filePath: string,
  sessionId: string,
  workspace?: string,
  options: { includeTools?: boolean } = {},
): NativeHistoryMessage[] | null {
  // (AGY-TOOL-BUBBLES) Tool rows are read by default. listSessions opts out:
  // it only needs counts/preview, and tool payloads (file contents, command
  // output) are the bulk of a store's bytes.
  const includeTools = options.includeTools !== false;
  const rows = readConversationStepRows(filePath, includeTools);
  if (!rows || rows.length === 0) return null;
  const messages = projectConversationSteps(rows, filePath, sessionId, workspace, includeTools);
  return messages.length > 0 ? messages : null;
}

/**
 * Read the `steps` rows the projection needs, retrying transient SQLITE_BUSY
 * lock contention. Null when the binding is unavailable, the store stays
 * locked, or the schema is unreadable.
 */
function readConversationStepRows(filePath: string, includeTools: boolean): AgyDbStepRow[] | null {
  let Database: any;
  try {
    Database = loadBetterSqlite3();
  } catch (err) {
    // better-sqlite3 binding genuinely unavailable (ABI mismatch / not built
    // into this bundle). This is the only true "cannot read at all" case — a
    // real load failure, distinct from transient lock contention below. Warn
    // once at WARN so it is greppable; the reader degrades gracefully (returns
    // null → dispatcher falls back to brain/.pb).
    LOG.warn(
      'NativeHistory',
      `antigravity .db reader could not load better-sqlite3 for ${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)} (native binding unavailable — assistant answers in this .db will not surface)`,
    );
    return null;
  }

  let rows: AgyDbStepRow[] | null = null;

  for (let attempt = 1; attempt <= AGY_DB_MAX_ATTEMPTS; attempt++) {
    let db: any;
    try {
      db = new Database(filePath, { readonly: true, fileMustExist: true });
      // Ask SQLite itself to wait (rather than failing fast) if the WAL
      // lock is momentarily held by antigravity. Set as early as possible
      // after open so the prepare/all below inherits the wait.
      try { db.pragma(`busy_timeout = ${AGY_DB_BUSY_TIMEOUT_MS}`); } catch { /* ignore */ }
      // Both `status` and `metadata` are present in every real store, but they
      // are the two columns this reader added a dependency on — so probe the
      // actual table shape rather than assuming it. A store that lacks either
      // (schema drift, or a legacy/synthetic db) then degrades to the previous
      // behaviour instead of throwing and collapsing the whole read to null.
      let columns: Set<string>;
      try {
        columns = new Set<string>(
          (db.prepare('PRAGMA table_info(steps)').all() as Array<{ name?: unknown }>)
            .map((c) => String(c?.name ?? '')),
        );
      } catch {
        columns = new Set<string>();
      }
      const hasStatus = columns.has('status');
      const hasMetadata = columns.has('metadata');
      const hasErrorDetails = columns.has('error_details');
      // Message steps keep their DONE-only filter (see AGY_STATUS_DONE). Tool
      // rows are admitted at any status and settled-filtered in code, because
      // "settled" for them depends on error_details (isSettledToolStatus).
      const messageClause =
        `(step_type IN (${AGY_STEP_TYPE_USER}, ${AGY_STEP_TYPE_MODEL})${hasStatus ? ` AND status = ${AGY_STATUS_DONE}` : ''})`;
      const toolClause = includeTools
        ? ` OR step_type NOT IN (${[AGY_STEP_TYPE_USER, AGY_STEP_TYPE_MODEL, ...AGY_STEP_TYPES_NEVER_TOOL].join(', ')})`
        : '';
      rows = db
        .prepare(
          `SELECT idx, step_type, step_payload${hasMetadata ? ', metadata' : ''}${hasStatus ? ', status' : ''}${hasErrorDetails ? ', error_details' : ''}
             FROM steps
            WHERE ${messageClause}${toolClause}
            ORDER BY idx ASC`,
        )
        .all() as AgyDbStepRow[];
      break; // success
    } catch (err) {
      if (isSqliteBusyError(err)) {
        // Transient WAL lock contention. Do NOT collapse to null on the first
        // failure — the assistant answer is already persisted; treating a busy
        // lock as "no session" is exactly what erased answers on re-query.
        // Retry with a small backoff; only give up after attempts exhausted.
        if (attempt < AGY_DB_MAX_ATTEMPTS) {
          sleepBusy(AGY_DB_RETRY_BACKOFF_MS[attempt - 1] ?? 150);
          continue;
        }
        LOG.warn(
          'NativeHistory',
          `antigravity .db ${path.basename(filePath)} stayed locked (SQLITE_BUSY) after ${AGY_DB_MAX_ATTEMPTS} attempts: ${err instanceof Error ? err.message : String(err)} (WAL write/checkpoint lock contention — assistant answers may transiently not surface this read)`,
        );
        return null;
      }
      // `steps` table absent / unexpected schema, or a genuine open/parse
      // failure that is not lock contention — a real (but recoverable) shape
      // mismatch. Log at debug so a schema drift in a future antigravity
      // release is diagnosable without spamming logs for every legacy db.
      LOG.debug(
        'NativeHistory',
        `antigravity .db ${path.basename(filePath)} not readable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }

  return rows;
}

/** Project the step trajectory into chat + tool messages (see the module header for the step types). */
function projectConversationSteps(
  rows: AgyDbStepRow[],
  filePath: string,
  sessionId: string,
  workspace: string | undefined,
  includeTools: boolean,
): NativeHistoryMessage[] {

  const normalizedWorkspace = typeof workspace === 'string' ? workspace.trim() : '';
  const sealMtimeMs = statMtimeMs(filePath);
  const baseTs = sealMtimeMs || Date.now();
  const messages: NativeHistoryMessage[] = [];

  const pushToolMessage = (
    receivedAt: number,
    toolName: string,
    summary: { text: string; truncated: boolean },
    recordIndex: number,
    blockIndex: number,
  ): void => {
    if (!summary.text) return;
    const msg: NativeHistoryMessage = {
      ts: new Date(receivedAt).toISOString(),
      receivedAt,
      role: 'assistant',
      content: summary.text,
      kind: 'tool',
      senderName: 'Tool',
      toolName,
      agent: 'antigravity-cli',
      historySessionId: sessionId,
    };
    // Same stamping rule as claude's stampToolBlockRef: only when the cap bit,
    // and only with a real seal — a 0 seal can never resolve.
    if (summary.truncated && sealMtimeMs > 0 && recordIndex >= 0) {
      msg.toolBlockRef = { sourceMtimeMs: sealMtimeMs, recordIndex, blockIndex };
    }
    if (normalizedWorkspace) msg.workspace = normalizedWorkspace;
    // A step row grows in place (status 8→3) under the SAME idx, which is
    // exactly why its address, not its content, is the identity.
    const src = recordBlockSource(sessionId, recordIndex, blockIndex);
    if (src) msg._src = src;
    messages.push(msg);
  };

  for (const row of rows) {
    const payload = row.step_payload;
    if (!payload || !Buffer.isBuffer(payload) || payload.length === 0) continue;

    // (ANTIGRAVITY-STALE-TURN-TIMESTAMP) Prefer the step's REAL creation time
    // from its metadata blob. Only when that is unavailable do we fall back to
    // the old mtime-derived synthesis — which cannot distinguish turns and
    // restamps the whole conversation to "now" on every write, defeating the
    // completion gate's `ts < turnStartedAt` staleness guard.
    const realCreatedAt = extractStepCreatedAtMs(row.metadata ?? null);
    const receivedAt = realCreatedAt ?? baseTs + messages.length;

    if (row.step_type === AGY_STEP_TYPE_USER) {
      let content = extractUserPrompt(payload);
      if (!content) {
        // Primary field path (field 19 → 2/3) missed. Recover schema-agnostically
        // rather than silently drop a user turn: scan the payload for the longest
        // plausible prompt run (metadata/paths/tokens are filtered out). There is
        // no reasoning subtree to exclude on the user side.
        const recovered = extractUserRequestContent(recoverMessageText(payload, []));
        if (recovered) {
          content = recovered;
          LOG.debug(
            'NativeHistory',
            `antigravity .db ${path.basename(filePath)} step ${row.idx} (type ${row.step_type}): user prompt absent at field 19; recovered ${content.length} chars via printable-run fallback — possible step_payload schema drift`,
          );
        } else {
          LOG.debug(
            'NativeHistory',
            `antigravity .db ${path.basename(filePath)} step ${row.idx} (type ${row.step_type}) dropped: no user prompt text (payload ${payload.length}B, top-level fields [${topLevelFieldNumbers(payload).join(',')}])`,
          );
          continue;
        }
      }
      const msg: NativeHistoryMessage = {
        ts: new Date(receivedAt).toISOString(),
        receivedAt,
        role: 'user',
        content,
        kind: 'standard',
        agent: 'antigravity-cli',
        historySessionId: sessionId,
      };
      if (normalizedWorkspace) msg.workspace = normalizedWorkspace;
      const userSrc = recordBlockSource(sessionId, row.idx, -1);
      if (userSrc) msg._src = userSrc;
      messages.push(msg);
    } else if (row.step_type === AGY_STEP_TYPE_MODEL) {
      // (AGY-TOOL-BUBBLES) A model step that calls tools carries them at
      // 20 → 7. Its prose answer (if any) is emitted FIRST, then one tool
      // bubble per call — the model writes prose, then acts — so a row with
      // both becomes [standard, tool…] and neither is double-counted.
      const toolCalls = includeTools ? extractModelToolCalls(payload) : [];
      const emitToolCalls = (): void => {
        toolCalls.forEach((call, blockIndex) => {
          const args = summarizeAgyToolCallArgs(call.argsJson);
          pushToolMessage(
            receivedAt,
            call.name,
            { text: args.text ? `${call.name}: ${args.text}` : call.name, truncated: args.truncated },
            row.idx,
            blockIndex,
          );
        });
      };
      let content = extractModelAnswer(payload);
      if (!content && toolCalls.length > 0) {
        // A decoded call at 20 → 7 proves the 20.x layout is current, so a
        // missing 20 → 1/8 answer is the ordinary "tool-only step", NOT schema
        // drift — skip the printable-run recovery, which could otherwise lift a
        // stray run into a fake prose bubble next to the real tool bubble.
        emitToolCalls();
        continue;
      }
      if (!content) {
        // The known answer path (field 20 → 1/8) yielded nothing. This is either
        // (a) a legitimate reasoning-only / tool-planning step — the common case,
        // which carries no user-visible answer — or (b) antigravity moved the
        // answer to a different field/subtree (schema drift). Attempt a
        // schema-agnostic recovery that EXCLUDES the reasoning subtree (field
        // 20 → 3) so internal reasoning is never surfaced as the answer.
        const reasoning = extractModelReasoning(payload);
        const recovered = recoverMessageText(payload, reasoning ? [reasoning] : []);
        if (recovered) {
          content = recovered;
          LOG.debug(
            'NativeHistory',
            `antigravity .db ${path.basename(filePath)} step ${row.idx} (type ${row.step_type}): answer absent at field 20; recovered ${content.length} chars via printable-run fallback — possible step_payload schema drift`,
          );
        } else {
          // No answer at the primary path and nothing recoverable beyond
          // reasoning/metadata → drop. Content-free breadcrumb so a genuine
          // future drift (answer present but unreadable) is greppable, and the
          // expected reasoning-only case is distinguishable via reasoningOnly.
          LOG.debug(
            'NativeHistory',
            `antigravity .db ${path.basename(filePath)} step ${row.idx} (type ${row.step_type}) dropped: no answer text (payload ${payload.length}B, top-level fields [${topLevelFieldNumbers(payload).join(',')}], reasoningOnly=${reasoning ? 'yes' : 'no'})`,
          );
          continue;
        }
      }
      const msg: NativeHistoryMessage = {
        ts: new Date(receivedAt).toISOString(),
        receivedAt,
        role: 'assistant',
        content,
        kind: 'standard',
        agent: 'antigravity-cli',
        historySessionId: sessionId,
      };
      if (normalizedWorkspace) msg.workspace = normalizedWorkspace;
      const answerSrc = recordBlockSource(sessionId, row.idx, -1);
      if (answerSrc) msg._src = answerSrc;
      messages.push(msg);
      emitToolCalls();
    } else if (includeTools) {
      // Execution step (any step_type carrying the 5 → 4 call header) or a
      // step_type 101 task notification. Everything else (task boundaries,
      // system context) yields null and is skipped.
      const status = typeof row.status === 'number' ? row.status : null;
      const errorDetails = row.error_details && Buffer.isBuffer(row.error_details) ? row.error_details : null;
      const block = row.step_type === AGY_STEP_TYPE_TASK_MESSAGE
        ? extractTaskNotification(payload)
        : isSettledToolStatus(status, errorDetails)
          ? extractToolStepResult(payload, errorDetails, status)
          : null;
      if (block) pushToolMessage(receivedAt, block.name, oneLine(block.text, TOOL_RESULT_SUMMARY_MAX), row.idx, -1);
    }
  }

  return messages;
}

/**
 * (TOOL-EXPAND) Re-read one tool bubble's source step at full length — the
 * resolver for the refs parseConversationDb stamps. Addressed by the step's
 * `idx` PRIMARY KEY, which antigravity only ever appends, so an address cannot
 * silently shift onto a neighbouring step; the caller's mtime seal is the
 * freshness check on top. Returns null when the address names no tool block.
 */
export function readAntigravityToolBlockAt(
  filePath: string,
  idx: number,
  blockIndex: number,
): { toolName?: string; callArgs?: string; result?: string } | null {
  if (!filePath.endsWith('.db') || !Number.isInteger(idx) || idx < 0) return null;
  let Database: any;
  try { Database = loadBetterSqlite3(); } catch { return null; }
  let row: AgyDbStepRow | undefined;
  let db: any;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    try { db.pragma(`busy_timeout = ${AGY_DB_BUSY_TIMEOUT_MS}`); } catch { /* ignore */ }
    const columns = new Set<string>(
      (db.prepare('PRAGMA table_info(steps)').all() as Array<{ name?: unknown }>).map((c) => String(c?.name ?? '')),
    );
    row = db
      .prepare(
        `SELECT idx, step_type, step_payload${columns.has('status') ? ', status' : ''}${columns.has('error_details') ? ', error_details' : ''}
           FROM steps WHERE idx = ?`,
      )
      .get(idx) as AgyDbStepRow | undefined;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  const payload = row?.step_payload;
  if (!row || !payload || !Buffer.isBuffer(payload)) return null;

  if (row.step_type === AGY_STEP_TYPE_MODEL) {
    const call = blockIndex >= 0 ? extractModelToolCalls(payload)[blockIndex] : undefined;
    return call ? { toolName: call.name, callArgs: fullAgyToolCallArgs(call.argsJson) } : null;
  }
  if (blockIndex !== -1) return null;
  const status = typeof row.status === 'number' ? row.status : null;
  const errorDetails = row.error_details && Buffer.isBuffer(row.error_details) ? row.error_details : null;
  const block = row.step_type === AGY_STEP_TYPE_TASK_MESSAGE
    ? extractTaskNotification(payload)
    : extractToolStepResult(payload, errorDetails, status);
  return block ? { toolName: block.name, result: block.text } : null;
}

// ─── Background-task lifecycle reader (completion-hold authority) ────────────
//
// Antigravity's `run_command` tool goes ASYNC when the command outlives its
// WaitMsBeforeAsync window. The launch step then carries the durable task
// identity `<conversation-uuid>/task-<launchStepIdx>` in its `task_details`
// blob; a sync command that finished inside the window leaves task_details
// EMPTY and never spawns a task.
//
// The launch is identified by (task_details carries a task id) AND (the
// payload's tool name is `run_command`) — NOT by step_type. Surveyed across 40
// live stores: async run_command launches appear under BOTH step_type 21 (40
// rows) and step_type 132 (12 rows), so keying on a single step_type silently
// misses most launches. The tool-name test is what actually discriminates.
//
// It also has to: step_type 132 rows carrying a task id in task_details are
// `schedule` timers (16 rows — "Timer: 30s, Prompt: Check task status"), not
// commands. Timers NEVER emit a terminal signal — measured resolution over the
// same 40 stores was run_command 51/52 (98%) vs schedule 0/16 (0%) — so
// admitting them as launches would pin the completion hold until the cap on
// every session that used one. They are excluded by tool name.
//
// The cell's terminal state lands later as either
//   (a) a step_type 101 task message — `Task id "<id>" finished with result:` /
//       `Task id "<id>" was canceled with result:` (every observed 101 task
//       message is terminal), or
//   (b) a manage_task status-check result (`Task: <id>\nStatus: DONE`;
//       RUNNING is NOT terminal).
// The background-task detector (providers/spec/background-task-detector.ts)
// consumes these normalized steps to hold completion while a causally-owned
// async command is still unresolved.

/** step_type carrying tool call/result steps. Both 21 and 132 appear for
 *  run_command; the union is scanned and the tool name discriminates. */
const AGY_STEP_TYPE_TOOL = 132;
const AGY_STEP_TYPE_TOOL_ALT = 21;
/** step_type for injected task messages (a background cell's terminal result). */
const AGY_STEP_TYPE_TASK_MESSAGE = 101;

/** Tool name that spawns a real background command cell. `schedule` (timer)
 *  also writes a task id into task_details but never resolves — see header.
 *
 *  Matched only in the protobuf header region that precedes the args JSON:
 *  across the surveyed stores the tool name is always written just before the
 *  `{"…}` args blob (offset ~36-38 vs json ~47-52), never inside it. A bare
 *  substring test would be loose — a manage_task status-check payload embeds
 *  the string `run_command` in its result text — so anchoring on position is
 *  what keeps a status row from ever being read as a launch. (No such row
 *  carries populated task_details today, so this is defence in depth.) */
function isBackgroundLaunchPayload(payload: string): boolean {
  const argsAt = payload.indexOf('{"');
  const header = argsAt >= 0 ? payload.slice(0, argsAt) : payload.slice(0, 200);
  return /\brun_command\b/.test(header);
}

/** Durable async-task identity, as written in `task_details` / result text. */
const AGY_TASK_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/task-\d+/i;

/** `Status:` values from manage_task results. Verified live: DONE (terminal)
 *  and RUNNING (not). The remaining tokens are defensive — resolution requires
 *  an EXPLICIT terminal token, so an unknown future status fails toward
 *  holding (itself time-bounded by BACKGROUND_TASK_HOLD_MAX_MS downstream). */
const AGY_TERMINAL_TASK_STATUSES = new Set(['DONE', 'CANCELED', 'CANCELLED', 'FAILED', 'ERROR', 'KILLED', 'STOPPED']);

/**
 * One normalized background-task lifecycle observation, in `idx` (append)
 * order. This is the record shape detectAntigravityFromRecords pairs over.
 */
export interface AgyTaskLifecycleStep {
  idx: number;
  /** user — turn boundary (ownership scope); launch — async run_command went
   *  background; status — manage_task result; notification — task message. */
  kind: 'user' | 'launch' | 'status' | 'notification';
  /** `<conversation-uuid>/task-<n>` — present on launch/status/notification. */
  taskId?: string;
  /** status/notification only: the observation proves the cell terminal. */
  terminal?: boolean;
}

/**
 * Read the background-task lifecycle steps of a per-session conversations/<uuid>.db.
 * Returns null when the db is unreadable (missing/locked past retry/no steps
 * table) — callers fail open, same as the message reader above. Only the
 * lifecycle-relevant step types are selected, and only the two text signals
 * (task_details identity, `Task:/Status:` result lines) are extracted — the
 * full protobuf message decode is unnecessary here.
 */
export function readTaskLifecycleSteps(filePath: string): AgyTaskLifecycleStep[] | null {
  let Database: any;
  try {
    Database = loadBetterSqlite3();
  } catch {
    // Native binding unavailable — same degradation as parseConversationDb.
    return null;
  }

  interface Row { idx: number; step_type: number; step_payload: Buffer | null; task_details?: Buffer | null }
  let rows: Row[] | null = null;

  for (let attempt = 1; attempt <= AGY_DB_MAX_ATTEMPTS; attempt++) {
    let db: any;
    try {
      db = new Database(filePath, { readonly: true, fileMustExist: true });
      try { db.pragma(`busy_timeout = ${AGY_DB_BUSY_TIMEOUT_MS}`); } catch { /* ignore */ }
      // `task_details` is present in every current store but is the column this
      // query depends on — probe the shape so a legacy/synthetic db degrades to
      // "no launches" instead of throwing the whole read away.
      let columns: Set<string>;
      try {
        columns = new Set<string>(
          (db.prepare('PRAGMA table_info(steps)').all() as Array<{ name?: unknown }>)
            .map((c) => String(c?.name ?? '')),
        );
      } catch {
        columns = new Set<string>();
      }
      const hasTaskDetails = columns.has('task_details');
      rows = db
        .prepare(
          `SELECT idx, step_type, step_payload${hasTaskDetails ? ', task_details' : ''}
             FROM steps
            WHERE step_type IN (${AGY_STEP_TYPE_USER}, ${AGY_STEP_TYPE_TOOL}, ${AGY_STEP_TYPE_TOOL_ALT}, ${AGY_STEP_TYPE_TASK_MESSAGE})
            ORDER BY idx ASC`,
        )
        .all() as Row[];
      break; // success
    } catch (err) {
      if (isSqliteBusyError(err)) {
        // Transient WAL lock contention — retry, never collapse to "no tasks"
        // on the first busy (same contract as parseConversationDb).
        if (attempt < AGY_DB_MAX_ATTEMPTS) {
          sleepBusy(AGY_DB_RETRY_BACKOFF_MS[attempt - 1] ?? 150);
          continue;
        }
        return null;
      }
      LOG.debug(
        'NativeHistory',
        `antigravity .db ${path.basename(filePath)} task-lifecycle read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }

  if (!Array.isArray(rows) || rows.length === 0) return null;

  const out: AgyTaskLifecycleStep[] = [];
  for (const row of rows) {
    if (row.step_type === AGY_STEP_TYPE_USER) {
      out.push({ idx: row.idx, kind: 'user' });
      continue;
    }
    if (row.step_type === AGY_STEP_TYPE_TASK_MESSAGE) {
      const text = row.step_payload ? row.step_payload.toString('utf8') : '';
      // `Task id "<id>" finished with result:` / `… was canceled with result:`.
      // Every observed step_type 101 task message is a TERMINAL delivery.
      for (const match of text.matchAll(/Task id "([0-9a-f-]{36}\/task-\d+)"[^:]{0,80}?\bwith result\b/gi)) {
        out.push({ idx: row.idx, kind: 'notification', taskId: match[1], terminal: true });
      }
      continue;
    }
    // Tool step (21 or 132): an async launch is (task id in `task_details`)
    // AND (payload tool name is run_command) — the tool-name test excludes
    // `schedule` timers, which carry a task id but never resolve. A manage_task
    // status result lives in the payload as `Task:/Status:` lines.
    const payload = row.step_payload ? row.step_payload.toString('utf8') : '';
    const details = row.task_details && Buffer.isBuffer(row.task_details)
      ? row.task_details.toString('utf8')
      : '';
    const launchId = details.match(AGY_TASK_ID_RE);
    if (launchId && isBackgroundLaunchPayload(payload)) {
      out.push({ idx: row.idx, kind: 'launch', taskId: launchId[0] });
    }
    for (const match of payload.matchAll(/Task:\s*([0-9a-f-]{36}\/task-\d+)[\s\S]{0,200}?\bStatus:\s*([A-Z_]+)/gi)) {
      const status = match[2].toUpperCase();
      out.push({ idx: row.idx, kind: 'status', taskId: match[1], terminal: AGY_TERMINAL_TASK_STATUSES.has(status) });
    }
  }
  return out;
}
