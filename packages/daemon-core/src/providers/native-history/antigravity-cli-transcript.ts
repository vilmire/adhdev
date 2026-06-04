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
 *      Protobuf binary — schema not publicly documented. Adapter extracts
 *      printable UTF-8 text runs as best-effort content (no proto library needed).
 *
 * This adapter provides:
 *   - Full coverage when a brain transcript exists (authoritative source).
 *   - Partial coverage (user prompts only) from history.jsonl as fallback.
 *   - Best-effort raw-string extraction from .pb files when no other source exists.
 *
 * watchPath (from provider.v1.json):
 *   ~/.gemini/antigravity-cli/history.jsonl
 *   ~/.gemini/antigravity-cli/brain/{uuid}/.system_generated/logs/transcript*.jsonl
 *   ~/.gemini/antigravity-cli/conversations/{uuid}.pb
 *
 * OSS code (AGPL-3.0). Must not import from packages/ (proprietary).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Read a single Antigravity CLI session by its source file path.
 *
 * `sessionPath` is the absolute path to one of:
 *   - A brain transcript JSONL: ~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript*.jsonl
 *   - The shared history.jsonl: ~/.gemini/antigravity-cli/history.jsonl
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

  // ── Case 2: .pb conversation file ───────────────────────────────────────
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
    const resolvedSessionId = sessionId || '';
    if (!resolvedSessionId || !isUuidLike(resolvedSessionId)) return null;

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
      sourcePath: sessionPath,
      sourceMtimeMs,
      nativeHistoryCoverage: 'partial',
      partialReason: 'antigravity_cli_history_jsonl_contains_user_prompts_only',
    };
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

  // ── Step 3: .pb files without any other source ─────────────────────────
  const convRoot = conversationsRoot();
  if (fs.existsSync(convRoot)) {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(convRoot, { withFileTypes: true }); } catch { /* ignore */ }

    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f-]+\.pb$/i.test(entry.name)) continue;
      const pbSessionId = entry.name.replace(/\.pb$/, '');
      if (!isUuidLike(pbSessionId) || seen.has(pbSessionId)) continue;

      const pbPath = path.join(convRoot, entry.name);
      const pbMtime = statMtimeMs(pbPath);

      results.push({
        historySessionId: pbSessionId,
        sessionId: pbSessionId,
        sourcePath: pbPath,
        sourceMtimeMs: pbMtime,
        messageCount: 0,
        firstMessageAt: pbMtime,
        lastMessageAt: pbMtime,
        agent: 'antigravity-cli',
        source: 'provider-native',
        nativeHistoryCoverage: 'best-effort',
        partialReason: 'antigravity_cli_pb_raw_text_extraction',
      });
      seen.add(pbSessionId);
    }
  }

  results.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
  return results;
}
