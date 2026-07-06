/**
 * antigravity-cli-transcript — Daemon-side built-in native history adapter for antigravity-cli.
 *
 * Antigravity CLI stores conversations in multiple complementary locations:
 *
 *   1. ~/.gemini/antigravity-cli/history.jsonl
 *      Lightweight index of user prompts, one row per turn:
 *        { conversationId: string, display: string, workspace: string, timestamp: number }
 *
 *   2. ~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript*.jsonl
 *      Per-session full transcript, one row per agent step:
 *        { source: 'USER_EXPLICIT'|'MODEL', type: string, content: string, status: 'DONE'|..., created_at: number }
 *
 *   3. ~/.gemini/antigravity-cli/conversations/<uuid>.pb
 *      Legacy protobuf binary — schema not publicly documented. Adapter extracts
 *      printable UTF-8 text runs as best-effort content (no proto library needed).
 *
 *   4. ~/.gemini/antigravity-cli/conversations/<uuid>.db  ← current format
 *      Per-session SQLite database. Recent antigravity migrated conversation
 *      storage from .pb (+ brain/*.jsonl) to a per-session SQLite db. The
 *      schema is a trajectory of `steps`, NOT a simple messages(role,content)
 *      table:
 *        steps(idx INTEGER PK, step_type INTEGER, status INTEGER,
 *              step_payload BLOB [protobuf], ...)
 *      Each `step_payload` is a protobuf message. Empirically (introspected
 *      from real stores):
 *        - step_type 14 → a USER turn. The prompt text is the largest
 *          contiguous UTF-8 run inside the payload (field 19 subtree).
 *        - step_type 15 → a MODEL/assistant turn. The assistant's final
 *          natural-language answer lives at payload field 20 → field 1
 *          (identical to field 8). Field 20 → field 3 is the internal
 *          reasoning summary and is intentionally NOT surfaced.
 *        - other step types are tool calls / ephemeral system context.
 *      We read the blobs with a tiny dependency-free protobuf field walker
 *      (no proto schema / codegen needed) and map the two message step types.
 *      Because the daemon does NOT read this db, native history previously
 *      returned 0 rows for these sessions and read_chat fell back to the
 *      pty parser (which only echoes the user's own input) — assistant
 *      answers appeared lost even though they were on disk.
 *
 *      Schema-drift resilience: the exact field path (20 → 1/8 for the answer,
 *      19 → 2/3 for the prompt) is empirically verified against real stores, but
 *      antigravity may move it in a future build. So when the known path yields
 *      no text, instead of silently dropping the turn we fall back to a UTF-8
 *      printable-run scan of the payload (recoverMessageText) that recovers the
 *      answer/prompt even if the field number drifted — while explicitly
 *      EXCLUDING the reasoning subtree (20 → 3) so internal reasoning is never
 *      surfaced as the answer. Only when even that finds nothing beyond
 *      reasoning/metadata is the step dropped, and a content-free DEBUG
 *      breadcrumb is logged so a real drift is greppable rather than invisible.
 *
 * This adapter provides:
 *   - Full coverage from a per-session .db (current format) — preferred.
 *   - Full coverage when a brain transcript exists (legacy authoritative source).
 *   - Partial coverage (user prompts only) from history.jsonl as fallback.
 *   - Best-effort raw-string extraction from .pb files when no other source exists.
 *
 * watchPath (from provider.v1.json):
 *   ~/.gemini/antigravity-cli/history.jsonl
 *   ~/.gemini/antigravity-cli/brain/{uuid}/.system_generated/logs/transcript*.jsonl
 *   ~/.gemini/antigravity-cli/conversations/{uuid}.pb
 *   ~/.gemini/antigravity-cli/conversations/{uuid}.db
 *
 * OSS code (AGPL-3.0). Must not import from packages/ (proprietary).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadBetterSqlite3 } from '../../system/load-better-sqlite3.js';
import { LOG } from '../../logging/logger.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export type NativeHistoryRole = 'user' | 'assistant' | 'system';
export type NativeHistoryKind = 'standard' | 'tool' | 'session_start';

export interface NativeHistoryMessage {
  ts: string;
  receivedAt: number;
  role: NativeHistoryRole;
  content: string;
  kind: NativeHistoryKind;
  senderName?: string;
  agent: 'antigravity-cli';
  historySessionId: string;
  workspace?: string;
  /** Stable per-message identity (v2 contract). */
  providerUnitKey?: string;
}

export interface NativeHistorySession {
  messages: NativeHistoryMessage[];
  providerSessionId: string;
  source: 'provider-native';
  sourcePath: string;
  sourceMtimeMs: number;
  /**
   * 'full' — brain transcript was available and parsed.
   * 'partial' — only history.jsonl user-prompts are available.
   * 'best-effort' — .pb file bytes were used for raw text extraction.
   */
  nativeHistoryCoverage: 'full' | 'partial' | 'best-effort';
  workspace?: string;
  partialReason?: string;
}

export interface NativeHistorySessionMeta {
  historySessionId: string;
  sessionId: string;
  sourcePath: string;
  sourceMtimeMs: number;
  messageCount: number;
  firstMessageAt: number;
  lastMessageAt: number;
  sessionTitle?: string;
  preview?: string;
  workspace?: string;
  agent: 'antigravity-cli';
  source: 'provider-native';
  nativeHistoryCoverage: 'full' | 'partial' | 'best-effort';
  partialReason?: string;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function extractTimestampValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function statMtimeMs(filePath: string): number {
  try { return fs.statSync(filePath).mtimeMs; } catch { return 0; }
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function antigravityRoot(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

function historyJsonlPath(): string {
  return path.join(antigravityRoot(), 'history.jsonl');
}

function brainRoot(): string {
  return path.join(antigravityRoot(), 'brain');
}

function conversationsRoot(): string {
  return path.join(antigravityRoot(), 'conversations');
}

function resolvePathInside(root: string, ...segments: string[]): string | null {
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(rootPath, ...segments);
  if (targetPath !== rootPath && !targetPath.startsWith(rootPath + path.sep)) return null;
  return targetPath;
}

/**
 * Find the brain transcript file for a given session UUID.
 * Prefers transcript_full.jsonl over transcript.jsonl when both exist.
 */
function findBrainTranscriptPath(sessionId: string): string | null {
  if (!isUuidLike(sessionId)) return null;
  const logsRoot = resolvePathInside(brainRoot(), sessionId, '.system_generated', 'logs');
  if (!logsRoot || !fs.existsSync(logsRoot)) return null;

  const candidates = (['transcript_full.jsonl', 'transcript.jsonl'] as const)
    .map((file) => resolvePathInside(logsRoot, file))
    .filter((p): p is string => p !== null && fs.existsSync(p));

  if (candidates.length === 0) {
    // Look for any transcript*.jsonl
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(logsRoot, { withFileTypes: true }); } catch { return null; }
    const transcriptFiles = entries
      .filter((e) => e.isFile() && /^transcript.*\.jsonl$/.test(e.name))
      .map((e) => path.join(logsRoot, e.name));
    if (transcriptFiles.length === 0) return null;
    transcriptFiles.sort((a, b) => statMtimeMs(b) - statMtimeMs(a));
    return transcriptFiles[0];
  }

  candidates.sort((a, b) => statMtimeMs(b) - statMtimeMs(a));
  return candidates[0];
}

/**
 * List all session UUIDs that have a brain transcript directory.
 */
function listBrainSessions(): Array<{ sessionId: string; transcriptPath: string; sourceMtimeMs: number }> {
  const root = brainRoot();
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }

  const results: Array<{ sessionId: string; transcriptPath: string; sourceMtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isUuidLike(entry.name)) continue;
    const transcriptPath = findBrainTranscriptPath(entry.name);
    if (!transcriptPath) continue;
    results.push({
      sessionId: entry.name,
      transcriptPath,
      sourceMtimeMs: statMtimeMs(transcriptPath),
    });
  }
  return results;
}

/**
 * Strip USER_REQUEST XML wrapper from antigravity user prompts.
 * Antigravity wraps structured user input in <USER_REQUEST>...</USER_REQUEST>.
 */
function extractUserRequestContent(content: string): string {
  const raw = content.trim();
  const match = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (match) return match[1].trim();
  return raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .replace(/<\/?USER_REQUEST>/gi, '')
    .trim();
}

/**
 * Determine the NativeHistoryKind from an antigravity transcript row type.
 */
function antigravityRowKind(rowType: string): NativeHistoryKind {
  if (rowType === 'PLANNER_RESPONSE') return 'standard';
  if (rowType && rowType !== 'USER_INPUT') return 'tool';
  return 'standard';
}

// ─── Brain transcript parser ─────────────────────────────────────────────────

interface TranscriptRow {
  source?: string;
  type?: string;
  content?: string;
  status?: string;
  created_at?: unknown;
}

/**
 * Parse a brain transcript JSONL file into NativeHistoryMessages.
 * Only rows with status === 'DONE' are processed.
 * USER_EXPLICIT / USER_INPUT rows → user role.
 * MODEL rows → assistant role.
 */
function parseBrainTranscript(
  filePath: string,
  sessionId: string,
  workspace?: string,
): NativeHistoryMessage[] | null {
  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const lines = raw.split('\n').filter(Boolean);
  if (lines.length === 0) return null;

  const records: NativeHistoryMessage[] = [];
  const normalizedWorkspace = typeof workspace === 'string' ? workspace.trim() : '';
  let fallbackTs = statMtimeMs(filePath) || Date.now();

  for (const line of lines) {
    let row: TranscriptRow | null = null;
    try { row = JSON.parse(line) as TranscriptRow; } catch { continue; }
    if (!row || typeof row !== 'object') continue;
    if (row.status !== 'DONE') continue;

    const rowSource = String(row.source ?? '').trim();
    const rowType = String(row.type ?? '').trim();
    const rawContent = typeof row.content === 'string' ? row.content : '';
    const receivedAt = extractTimestampValue(row.created_at) || fallbackTs + records.length;

    if (rowSource === 'USER_EXPLICIT' && rowType === 'USER_INPUT') {
      const content = extractUserRequestContent(rawContent);
      if (!content) continue;
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
      records.push(msg);
    } else if (rowSource === 'MODEL') {
      const content = rawContent.trim();
      if (!content) continue;
      const kind = antigravityRowKind(rowType);
      const msg: NativeHistoryMessage = {
        ts: new Date(receivedAt).toISOString(),
        receivedAt,
        role: 'assistant',
        content,
        kind,
        agent: 'antigravity-cli',
        historySessionId: sessionId,
      };
      if (kind === 'tool') msg.senderName = 'Tool';
      if (normalizedWorkspace) msg.workspace = normalizedWorkspace;
      records.push(msg);
    }
  }

  return records.length > 0 ? records : null;
}

// ─── History JSONL parser ────────────────────────────────────────────────────

interface HistoryRow {
  conversationId: string;
  display: string;
  workspace: string;
  receivedAt: number;
}

function readHistoryRows(): HistoryRow[] {
  const sourcePath = historyJsonlPath();
  let lines: string[] = [];
  try { lines = fs.readFileSync(sourcePath, 'utf-8').split('\n').filter(Boolean); } catch { return []; }

  const rows: HistoryRow[] = [];
  for (const line of lines) {
    let parsed: unknown = null;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;

    const row = parsed as Record<string, unknown>;
    const conversationId = String(row.conversationId ?? '').trim();
    const display = typeof row.display === 'string' ? row.display.trim() : '';
    const workspace = typeof row.workspace === 'string' ? row.workspace.trim() : '';
    const receivedAt = extractTimestampValue(row.timestamp);

    if (!conversationId || !isUuidLike(conversationId) || !display || !receivedAt) continue;
    rows.push({ conversationId, display, workspace, receivedAt });
  }
  return rows;
}

// ─── Protobuf best-effort text extraction ────────────────────────────────────

const MIN_PRINTABLE_RUN = 8;

/**
 * Extract printable UTF-8 text runs from raw binary data (similar to the `strings` command).
 * Runs of printable ASCII/UTF-8 characters of length >= MIN_PRINTABLE_RUN are collected.
 * This is used as a best-effort fallback when the .pb schema is not available.
 */
function extractStringsFromBuffer(buf: Buffer): string[] {
  const strings: string[] = [];
  let current: number[] = [];

  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    // Accept printable ASCII (32-126) and common whitespace (9=tab, 10=LF, 13=CR)
    if ((byte >= 32 && byte <= 126) || byte === 9 || byte === 10 || byte === 13) {
      current.push(byte);
    } else {
      if (current.length >= MIN_PRINTABLE_RUN) {
        const str = Buffer.from(current).toString('utf-8').trim();
        if (str) strings.push(str);
      }
      current = [];
    }
  }
  // Flush remaining
  if (current.length >= MIN_PRINTABLE_RUN) {
    const str = Buffer.from(current).toString('utf-8').trim();
    if (str) strings.push(str);
  }

  return strings;
}

/**
 * Read a .pb conversation file and extract best-effort text content.
 * Returns a single NativeHistoryMessage with the extracted content,
 * or null if nothing readable was found.
 */
function parsePbFile(
  filePath: string,
  sessionId: string,
): NativeHistoryMessage[] | null {
  let buf: Buffer;
  try { buf = fs.readFileSync(filePath); } catch { return null; }
  if (buf.length === 0) return null;

  const strings = extractStringsFromBuffer(buf);
  // Filter out very short or likely-binary strings
  const meaningful = strings.filter((s) => s.length >= MIN_PRINTABLE_RUN && /\w/.test(s));
  if (meaningful.length === 0) return null;

  const content = meaningful.join('\n');
  const sourceMtimeMs = statMtimeMs(filePath);

  return [
    {
      ts: new Date(sourceMtimeMs).toISOString(),
      receivedAt: sourceMtimeMs,
      role: 'assistant',
      content,
      kind: 'standard',
      agent: 'antigravity-cli',
      historySessionId: sessionId,
    },
  ];
}

// ─── SQLite (.db) conversation reader ────────────────────────────────────────
//
// Recent antigravity stores each conversation in a per-session SQLite db at
// conversations/<uuid>.db. See the file header for the schema. We decode the
// protobuf `step_payload` blobs with a minimal, dependency-free field walker —
// we only need two leaf strings (user prompt / assistant answer), so a full
// proto schema is unnecessary.

/** Antigravity step_type values that map to a chat message. */
const AGY_STEP_TYPE_USER = 14;
const AGY_STEP_TYPE_MODEL = 15;

interface ProtoField {
  field: number;
  wireType: number;
  /** For wireType 2 (length-delimited): the raw bytes. */
  bytes?: Buffer;
  /** For wireType 0 (varint): the value. */
  varint?: number;
}

/**
 * Read a base-128 varint starting at `offset`. Returns [value, nextOffset].
 * Values are read as JS numbers (safe: the fields we consume are small).
 */
function readVarint(buf: Buffer, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i];
    i += 1;
    result += (byte & 0x7f) * Math.pow(2, shift);
    if ((byte & 0x80) === 0) return [result, i];
    shift += 7;
    if (shift > 63) break; // malformed / oversized
  }
  return [result, i];
}

/**
 * Decode the top-level fields of a protobuf message. Best-effort: stops on the
 * first malformed byte rather than throwing, so a partially-corrupt blob still
 * yields the fields decoded so far.
 */
function decodeProtoFields(buf: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let i = 0;
  while (i < buf.length) {
    const [key, afterKey] = readVarint(buf, i);
    if (afterKey === i) break;
    i = afterKey;
    const field = Math.floor(key / 8);
    const wireType = key & 7;
    if (field <= 0) break;
    if (wireType === 0) {
      const [value, next] = readVarint(buf, i);
      if (next === i) break;
      i = next;
      fields.push({ field, wireType, varint: value });
    } else if (wireType === 2) {
      const [len, afterLen] = readVarint(buf, i);
      i = afterLen;
      if (len < 0 || i + len > buf.length) break;
      fields.push({ field, wireType, bytes: buf.subarray(i, i + len) });
      i += len;
    } else if (wireType === 5) {
      i += 4;
    } else if (wireType === 1) {
      i += 8;
    } else {
      break; // wireType 3/4 (groups) — unused by antigravity payloads
    }
  }
  return fields;
}

/** Return the bytes of the first length-delimited field with number `field`. */
function firstLenField(buf: Buffer, field: number): Buffer | null {
  for (const f of decodeProtoFields(buf)) {
    if (f.field === field && f.wireType === 2 && f.bytes) return f.bytes;
  }
  return null;
}

/** Heuristic: is this buffer (mostly) printable UTF-8 text? */
function looksLikeText(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  let printable = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    // ASCII printable + common whitespace, or any high byte (UTF-8 lead/cont).
    if ((b >= 32 && b <= 126) || b === 9 || b === 10 || b === 13 || b >= 0x80) printable += 1;
  }
  return printable / buf.length >= 0.9;
}

/**
 * Antigravity prefixes some assistant answers with a literal `MARKER_V1`
 * sentinel followed by a blank line. Strip it so the user-visible bubble starts
 * at the real text.
 */
function stripAnswerMarker(text: string): string {
  return text.replace(/^\s*MARKER_V1\s*/, '');
}

/**
 * Extract the assistant's final natural-language answer from a step_type 15
 * payload: field 20 → field 1 (identical to field 8). Field 20 → field 3 is the
 * private reasoning summary and is deliberately skipped. Returns '' if absent
 * (e.g. a pure reasoning / tool-only model step, which carries no user-visible
 * answer text).
 */
function extractModelAnswer(payload: Buffer): string {
  const inner = firstLenField(payload, 20);
  if (!inner) return '';
  const answer = firstLenField(inner, 1) ?? firstLenField(inner, 8);
  if (!answer || !looksLikeText(answer)) return '';
  return stripAnswerMarker(answer.toString('utf-8')).trim();
}

/**
 * Extract the user prompt from a step_type 14 payload: field 19 → field 2 (the
 * clean prompt text; field 19 → field 3 wraps the same string with a leading
 * newline and is used only as a fallback). The USER_REQUEST XML wrapper, when
 * present, is unwrapped to match the brain-transcript reader's output.
 */
function extractUserPrompt(payload: Buffer): string {
  const inner = firstLenField(payload, 19);
  if (!inner) return '';
  const raw = firstLenField(inner, 2) ?? firstLenField(inner, 3);
  if (!raw || !looksLikeText(raw)) return '';
  const text = raw.toString('utf-8').trim();
  if (!text) return '';
  return extractUserRequestContent(text);
}

/**
 * The model step's private reasoning summary lives at field 20 → field 3. We
 * surface it nowhere, but we DO need it: the schema-drift recovery below scans
 * the raw payload for a plausible answer run, and the reasoning is itself a long
 * natural-language run — so we extract it here purely to EXCLUDE it and avoid
 * accidentally surfacing internal reasoning as the assistant answer.
 */
function extractModelReasoning(payload: Buffer): string {
  const inner = firstLenField(payload, 20);
  if (!inner) return '';
  const reasoning = firstLenField(inner, 3);
  if (!reasoning || !looksLikeText(reasoning)) return '';
  return reasoning.toString('utf-8').trim();
}

/** Top-level protobuf field numbers present in a payload (for drift breadcrumbs). */
function topLevelFieldNumbers(payload: Buffer): number[] {
  return decodeProtoFields(payload).map((f) => f.field);
}

const MIN_RECOVERED_MESSAGE_CHARS = 12;

/**
 * Split a payload into UTF-8 text runs, schema-agnostically. Unlike
 * extractStringsFromBuffer (ASCII-only, used for legacy .pb), this is UTF-8 aware
 * so CJK / accented answers survive intact: we decode the whole blob as UTF-8
 * (invalid byte sequences collapse to U+FFFD) and split on runs of C0/C1 control
 * chars + the replacement char. Protobuf framing bytes (field tags, varint length
 * prefixes) are almost always control or invalid-UTF-8, so each natural-language
 * string field emerges as its own run while binary framing is discarded.
 */
function extractUtf8TextRuns(buf: Buffer): string[] {
  if (buf.length === 0) return [];
  const decoded = buf.toString('utf-8');
  // Keep tab/newline/CR (0x09/0x0A/0x0D) inside runs — answers contain newlines.
  // Everything else in C0 (incl. 0x1A, the field-3 tag that separates reasoning
  // from the answer), DEL, and the replacement char are run separators.
  const parts = decoded.split(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]+/);
  const runs: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length >= MIN_PRINTABLE_RUN) runs.push(trimmed);
  }
  return runs;
}

/**
 * Is this run plausibly a user-visible prose message, as opposed to the other
 * text the payload also carries — internal reasoning (excluded separately),
 * tool-call JSON arguments, code blobs, file paths, and uuid/session-id
 * metadata? These filters were tuned against real antigravity stores so that a
 * blind printable-run scan recovers a genuinely drifted answer while surfacing
 * NONE of the tool-call / metadata runs that legitimately answer-less steps
 * carry (verified: zero false recoveries across real conversation dbs).
 */
function isPlausibleMessageText(s: string): boolean {
  if (s.length < MIN_RECOVERED_MESSAGE_CHARS) return false;
  if (!/[A-Za-zÀ-￿]/.test(s)) return false; // must contain letters (incl. CJK)
  if (/^(file:\/\/|[A-Za-z]:[\\/]|\/[A-Za-z0-9._-]+\/)/.test(s)) return false; // path/URI
  // Prose is multi-word: real answers have several spaces; uuids / ids / tokens
  // have none. This is the single strongest prose-vs-metadata discriminator.
  if ((s.match(/ /g) ?? []).length < 2) return false;
  // Reject structured tool-call args / JSON / code blobs. A model tool step
  // carries its arguments as JSON (e.g. {"Query":...}, {"CommandLine":...});
  // those must never be surfaced as an assistant answer.
  if (/[[{]\s*"/.test(s)) return false;
  const structural = (s.match(/[{}[\]":\\]/g) ?? []).length;
  if (structural / s.length > 0.12) return false;
  return true;
}

/**
 * Schema-agnostic recovery of a message's text when the known field path yields
 * nothing (a possible antigravity step_payload schema drift). Scans the payload
 * for UTF-8 text runs and returns the longest plausible message run, EXCLUDING
 * any run that matches one of `excludeTexts` (e.g. the reasoning subtree) so we
 * never surface internal reasoning as the answer. Returns '' when nothing beyond
 * reasoning/metadata is present — i.e. a legitimately answer-less step.
 */
function recoverMessageText(payload: Buffer, excludeTexts: string[]): string {
  const exclusions = excludeTexts.map((t) => t.trim()).filter(Boolean);
  let best = '';
  for (const run of extractUtf8TextRuns(payload)) {
    const candidate = stripAnswerMarker(run).trim();
    if (!isPlausibleMessageText(candidate)) continue;
    // Drop runs that are (or are contained in / contain) an excluded subtree.
    if (exclusions.some((e) => e === candidate || e.includes(candidate) || candidate.includes(e))) {
      continue;
    }
    if (candidate.length > best.length) best = candidate;
  }
  return best;
}

interface AgyDbStepRow {
  idx: number;
  step_type: number;
  step_payload: Buffer | null;
}

/**
 * Parse a per-session conversations/<uuid>.db (SQLite) into NativeHistoryMessages.
 * Returns null when the db is unreadable, empty, or yields no chat messages.
 */
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

function parseConversationDb(
  filePath: string,
  sessionId: string,
  workspace?: string,
): NativeHistoryMessage[] | null {
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
  let lastBusyErr: unknown;

  for (let attempt = 1; attempt <= AGY_DB_MAX_ATTEMPTS; attempt++) {
    let db: any;
    try {
      db = new Database(filePath, { readonly: true, fileMustExist: true });
      // Ask SQLite itself to wait (rather than failing fast) if the WAL
      // lock is momentarily held by antigravity. Set as early as possible
      // after open so the prepare/all below inherits the wait.
      try { db.pragma(`busy_timeout = ${AGY_DB_BUSY_TIMEOUT_MS}`); } catch { /* ignore */ }
      rows = db
        .prepare(
          `SELECT idx, step_type, step_payload
             FROM steps
            WHERE step_type IN (${AGY_STEP_TYPE_USER}, ${AGY_STEP_TYPE_MODEL})
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
        lastBusyErr = err;
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

  void lastBusyErr; // referenced only for retry bookkeeping above

  if (!Array.isArray(rows) || rows.length === 0) return null;

  const normalizedWorkspace = typeof workspace === 'string' ? workspace.trim() : '';
  const baseTs = statMtimeMs(filePath) || Date.now();
  const messages: NativeHistoryMessage[] = [];

  for (const row of rows) {
    const payload = row.step_payload;
    if (!payload || !Buffer.isBuffer(payload) || payload.length === 0) continue;

    // Steps are ordered by idx; the db carries no per-step timestamp we can
    // trust as ms, so synthesize a monotonically increasing receivedAt that
    // preserves order (idx-derived) around the file mtime.
    const receivedAt = baseTs + messages.length;

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
      messages.push(msg);
    } else if (row.step_type === AGY_STEP_TYPE_MODEL) {
      let content = extractModelAnswer(payload);
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
      messages.push(msg);
    }
  }

  return messages.length > 0 ? messages : null;
}

/**
 * Assemble the history.jsonl user-prompt index for a single session id into a
 * partial NativeHistorySession (user prompts only — history.jsonl never carries
 * assistant answers). Returns null when the index has no rows for this session.
 * Shared by the history.jsonl read case and the .db sibling fallback.
 */
function readHistoryJsonlSession(
  resolvedSessionId: string,
  workspace?: string,
): NativeHistorySession | null {
  if (!isUuidLike(resolvedSessionId)) return null;
  const rows = readHistoryRows().filter((r) => r.conversationId === resolvedSessionId);
  if (rows.length === 0) return null;

  rows.sort((a, b) => a.receivedAt - b.receivedAt);
  const firstWorkspace = workspace || rows.find((r) => r.workspace)?.workspace || '';

  const messages: NativeHistoryMessage[] = [];
  if (firstWorkspace) {
    messages.push({
      ts: new Date(rows[0].receivedAt).toISOString(),
      receivedAt: rows[0].receivedAt,
      role: 'system',
      content: firstWorkspace,
      kind: 'session_start',
      agent: 'antigravity-cli',
      historySessionId: resolvedSessionId,
      workspace: firstWorkspace,
    });
  }

  for (const row of rows) {
    const msg: NativeHistoryMessage = {
      ts: new Date(row.receivedAt).toISOString(),
      receivedAt: row.receivedAt,
      role: 'user',
      content: row.display,
      kind: 'standard',
      agent: 'antigravity-cli',
      historySessionId: resolvedSessionId,
    };
    if (row.workspace) msg.workspace = row.workspace;
    messages.push(msg);
  }

  return {
    messages,
    providerSessionId: resolvedSessionId,
    source: 'provider-native',
    sourcePath: historyJsonlPath(),
    sourceMtimeMs: statMtimeMs(historyJsonlPath()),
    nativeHistoryCoverage: 'partial',
    partialReason: 'antigravity_cli_history_jsonl_contains_user_prompts_only',
  };
}

/**
 * ANTIGRAVITY-COMPLETION-DASHBOARD-GAP: recover a bound session's transcript
 * from the legacy sibling sources when its per-session .db read came back empty
 * (transient WAL lock, assistant step not yet flushed, or a decode miss on a
 * future step_payload schema). Tried in descending fidelity for the SAME
 * session id — never cross-binds to another conversation:
 *   1. brain transcript (full coverage, authoritative when present),
 *   2. sibling conversations/<uuid>.pb (best-effort raw text),
 *   3. history.jsonl (partial — user prompts only).
 * Returns null when no sibling yields any message.
 */
function readAntigravitySiblingFallback(
  sessionId: string,
  workspace?: string,
): NativeHistorySession | null {
  if (!isUuidLike(sessionId)) return null;

  // (1) brain transcript — full coverage when antigravity actually wrote it.
  const brainPath = findBrainTranscriptPath(sessionId);
  if (brainPath && statMtimeMs(brainPath) > 0) {
    const brainMessages = parseBrainTranscript(brainPath, sessionId, workspace);
    if (brainMessages && brainMessages.length > 0) {
      return {
        messages: brainMessages,
        providerSessionId: sessionId,
        source: 'provider-native',
        sourcePath: brainPath,
        sourceMtimeMs: statMtimeMs(brainPath),
        nativeHistoryCoverage: 'full',
        workspace,
      };
    }
  }

  // (2) sibling .pb — best-effort raw text extraction.
  const pbPath = resolvePathInside(conversationsRoot(), `${sessionId}.pb`);
  if (pbPath && fs.existsSync(pbPath)) {
    const pbMessages = parsePbFile(pbPath, sessionId);
    if (pbMessages && pbMessages.length > 0) {
      return {
        messages: pbMessages,
        providerSessionId: sessionId,
        source: 'provider-native',
        sourcePath: pbPath,
        sourceMtimeMs: statMtimeMs(pbPath),
        nativeHistoryCoverage: 'best-effort',
        partialReason: 'antigravity_cli_pb_raw_text_extraction',
        workspace,
      };
    }
  }

  // (3) history.jsonl — partial (user prompts only). Last resort so the
  //     dashboard at least shows the prompt when no answer source is readable.
  return readHistoryJsonlSession(sessionId, workspace);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Read a single Antigravity CLI session by its source file path.
 *
 * `sessionPath` is the absolute path to one of:
 *   - A brain transcript JSONL: ~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript*.jsonl
 *   - The shared history.jsonl: ~/.gemini/antigravity-cli/history.jsonl
 *   - A conversation SQLite db: ~/.gemini/antigravity-cli/conversations/<uuid>.db
 *   - A conversation protobuf: ~/.gemini/antigravity-cli/conversations/<uuid>.pb
 *
 * The session UUID is inferred from the directory name (brain), filename (pb), or
 * must be provided explicitly via `sessionId` for history.jsonl paths.
 *
 * Returns `null` when the file is missing, empty, or yields no parseable messages.
 */
export function readSession(
  sessionPath: string,
  sessionId?: string,
  workspace?: string,
): NativeHistorySession | null {
  if (!sessionPath || !path.isAbsolute(sessionPath)) return null;
  if (!fs.existsSync(sessionPath)) return null;

  const sourceMtimeMs = statMtimeMs(sessionPath);

  // ── Case 1: brain transcript JSONL ──────────────────────────────────────
  const brainRootPath = brainRoot();
  if (sessionPath.startsWith(brainRootPath + path.sep) && sessionPath.endsWith('.jsonl')) {
    // Extract UUID from the path: brain/<uuid>/.system_generated/...
    const relative = sessionPath.slice(brainRootPath.length + 1);
    const uuidFromPath = relative.split(path.sep)[0];
    const resolvedSessionId = sessionId || (isUuidLike(uuidFromPath) ? uuidFromPath : '');
    if (!resolvedSessionId) return null;

    const messages = parseBrainTranscript(sessionPath, resolvedSessionId, workspace);
    if (!messages || messages.length === 0) return null;

    return {
      messages,
      providerSessionId: resolvedSessionId,
      source: 'provider-native',
      sourcePath: sessionPath,
      sourceMtimeMs,
      nativeHistoryCoverage: 'full',
      workspace,
    };
  }

  // ── Case 2a: .db conversation file (current per-session SQLite format) ───
  if (sessionPath.endsWith('.db')) {
    const dbSessionId = sessionId || path.basename(sessionPath, '.db');
    if (!isUuidLike(dbSessionId)) return null;

    const messages = parseConversationDb(sessionPath, dbSessionId, workspace);
    if (messages && messages.length > 0) {
      return {
        messages,
        providerSessionId: dbSessionId,
        source: 'provider-native',
        sourcePath: sessionPath,
        sourceMtimeMs,
        nativeHistoryCoverage: 'full',
        workspace,
      };
    }

    // ANTIGRAVITY-COMPLETION-DASHBOARD-GAP: the bound .db yielded nothing this
    // read — transient (WAL lock / assistant step not yet flushed) or a decode
    // miss on a future schema. The dispatcher binds STRAIGHT to <uuid>.db once
    // the session id is known and never re-resolves to a sibling source, so a
    // null here previously collapsed the whole read to native-unavailable even
    // when the SAME session's assistant answer was recoverable from the legacy
    // brain transcript / .pb / history.jsonl. Fall back across those sibling
    // sources for the same session id before giving up. This is read-only,
    // scoped to the bound session, and cannot cross-bind to another conversation.
    const siblingFallback = readAntigravitySiblingFallback(dbSessionId, workspace);
    if (siblingFallback) return siblingFallback;

    return null;
  }

  // ── Case 2b: .pb conversation file (legacy protobuf) ─────────────────────
  if (sessionPath.endsWith('.pb')) {
    const pbSessionId = sessionId || path.basename(sessionPath, '.pb');
    if (!isUuidLike(pbSessionId)) return null;

    const messages = parsePbFile(sessionPath, pbSessionId);
    if (!messages || messages.length === 0) return null;

    return {
      messages,
      providerSessionId: pbSessionId,
      source: 'provider-native',
      sourcePath: sessionPath,
      sourceMtimeMs,
      nativeHistoryCoverage: 'best-effort',
      partialReason: 'antigravity_cli_pb_raw_text_extraction',
    };
  }

  // ── Case 3: history.jsonl (user prompts index) ──────────────────────────
  if (path.basename(sessionPath) === 'history.jsonl') {
    return readHistoryJsonlSession(sessionId || '', workspace);
  }

  return null;
}

/**
 * List all Antigravity CLI sessions found across all watchPath locations.
 *
 * Priority:
 *   1. Brain transcript sessions (full coverage) — preferred source.
 *   2. History JSONL entries without a brain transcript (partial coverage).
 *   3. .pb conversation files without any other source (best-effort).
 *
 * Returns summary metadata sorted by most recently updated first.
 */
export async function listSessions(_watchPath: string): Promise<NativeHistorySessionMeta[]> {
  const results: NativeHistorySessionMeta[] = [];
  const seen = new Set<string>();

  // ── Step 1: brain transcripts (full coverage) ──────────────────────────
  const historyRows = readHistoryRows();
  const workspaceBySession = new Map<string, string>();
  for (const row of historyRows) {
    if (row.workspace && !workspaceBySession.has(row.conversationId)) {
      workspaceBySession.set(row.conversationId, row.workspace);
    }
  }

  for (const { sessionId, transcriptPath, sourceMtimeMs } of listBrainSessions()) {
    const workspace = workspaceBySession.get(sessionId);
    const messages = parseBrainTranscript(transcriptPath, sessionId, workspace);
    if (!messages || messages.length === 0) continue;

    const visible = messages.filter((m) => m.kind !== 'session_start');
    if (visible.length === 0) continue;

    const firstMsg = visible[0];
    const lastMsg = visible[visible.length - 1];

    results.push({
      historySessionId: sessionId,
      sessionId,
      sourcePath: transcriptPath,
      sourceMtimeMs,
      messageCount: visible.length,
      firstMessageAt: firstMsg.receivedAt || sourceMtimeMs,
      lastMessageAt: lastMsg.receivedAt || sourceMtimeMs,
      sessionTitle: lastMsg.content,
      preview: lastMsg.content,
      workspace,
      agent: 'antigravity-cli',
      source: 'provider-native',
      nativeHistoryCoverage: 'full',
    });
    seen.add(sessionId);
  }

  // ── Step 2: history.jsonl entries without brain transcripts ────────────
  const grouped = new Map<
    string,
    {
      firstMessageAt: number;
      lastMessageAt: number;
      messageCount: number;
      sessionTitle?: string;
      preview?: string;
      workspace?: string;
    }
  >();
  for (const row of historyRows) {
    const existing = grouped.get(row.conversationId) ?? {
      firstMessageAt: row.receivedAt,
      lastMessageAt: row.receivedAt,
      messageCount: 0,
    };
    existing.messageCount += 1;
    existing.firstMessageAt = Math.min(existing.firstMessageAt, row.receivedAt);
    if (row.receivedAt >= existing.lastMessageAt) {
      existing.lastMessageAt = row.receivedAt;
      existing.sessionTitle = row.display;
      existing.preview = row.display;
      if (row.workspace) existing.workspace = row.workspace;
    }
    grouped.set(row.conversationId, existing);
  }

  const historySrc = historyJsonlPath();
  const historyMtime = statMtimeMs(historySrc);

  for (const [sessionId, info] of grouped.entries()) {
    if (seen.has(sessionId)) continue;
    results.push({
      historySessionId: sessionId,
      sessionId,
      sourcePath: historySrc,
      sourceMtimeMs: historyMtime,
      messageCount: info.messageCount,
      firstMessageAt: info.firstMessageAt,
      lastMessageAt: info.lastMessageAt,
      sessionTitle: info.sessionTitle,
      preview: info.preview,
      workspace: info.workspace,
      agent: 'antigravity-cli',
      source: 'provider-native',
      nativeHistoryCoverage: 'partial',
      partialReason: 'antigravity_cli_history_jsonl_contains_user_prompts_only',
    });
    seen.add(sessionId);
  }

  // ── Step 3: conversations/<uuid>.db and .pb without any other source ────
  //
  // Current antigravity writes per-session SQLite dbs; older sessions kept a
  // .pb protobuf. Both can coexist in conversations/. Discover both, but when
  // the same uuid has a .db, prefer it (full coverage) over the .pb (best
  // effort). brain/history sources already in `seen` still win over either.
  const convRoot = conversationsRoot();
  if (fs.existsSync(convRoot)) {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(convRoot, { withFileTypes: true }); } catch { /* ignore */ }

    // Group by uuid so a .db supersedes a sibling .pb of the same session.
    const byUuid = new Map<string, { db?: string; pb?: string }>();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const dbMatch = /^([0-9a-f-]+)\.db$/i.exec(entry.name);
      const pbMatch = /^([0-9a-f-]+)\.pb$/i.exec(entry.name);
      if (dbMatch && isUuidLike(dbMatch[1])) {
        const g = byUuid.get(dbMatch[1]) ?? {};
        g.db = path.join(convRoot, entry.name);
        byUuid.set(dbMatch[1], g);
      } else if (pbMatch && isUuidLike(pbMatch[1])) {
        const g = byUuid.get(pbMatch[1]) ?? {};
        g.pb = path.join(convRoot, entry.name);
        byUuid.set(pbMatch[1], g);
      }
    }

    for (const [uuid, files] of byUuid.entries()) {
      if (seen.has(uuid)) continue;

      if (files.db) {
        // Parse the db so listSessions reports accurate counts/preview and the
        // session surfaces with full coverage (assistant answers included).
        const workspace = workspaceBySession.get(uuid);
        const messages = parseConversationDb(files.db, uuid, workspace);
        const dbMtime = statMtimeMs(files.db);
        if (messages && messages.length > 0) {
          const lastMsg = messages[messages.length - 1];
          const firstMsg = messages[0];
          results.push({
            historySessionId: uuid,
            sessionId: uuid,
            sourcePath: files.db,
            sourceMtimeMs: dbMtime,
            messageCount: messages.length,
            firstMessageAt: firstMsg.receivedAt || dbMtime,
            lastMessageAt: lastMsg.receivedAt || dbMtime,
            sessionTitle: lastMsg.content,
            preview: lastMsg.content,
            workspace,
            agent: 'antigravity-cli',
            source: 'provider-native',
            nativeHistoryCoverage: 'full',
          });
          seen.add(uuid);
          continue;
        }
        // db unreadable/empty (e.g. sqlite binding unavailable) → fall through
        // to the .pb best-effort entry below if one exists.
      }

      if (files.pb) {
        const pbMtime = statMtimeMs(files.pb);
        results.push({
          historySessionId: uuid,
          sessionId: uuid,
          sourcePath: files.pb,
          sourceMtimeMs: pbMtime,
          messageCount: 0,
          firstMessageAt: pbMtime,
          lastMessageAt: pbMtime,
          agent: 'antigravity-cli',
          source: 'provider-native',
          nativeHistoryCoverage: 'best-effort',
          partialReason: 'antigravity_cli_pb_raw_text_extraction',
        });
        seen.add(uuid);
      }
    }
  }

  results.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
  return results;
}
