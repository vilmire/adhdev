/**
 * grok-cli-transcript — Daemon-side built-in native history adapter for grok-cli.
 *
 * Reads Grok Build's own on-disk transcript. Layout (verified live against
 * grok 1.0.4):
 *
 *   ~/.grok/sessions/<url-encoded-cwd>/<session-uuid>/chat_history.jsonl
 *
 * The url-encoded directory is the session's cwd percent-encoded with `/`
 * escaped as `%2F` (e.g. `/private/tmp/ws` → `%2Fprivate%2Ftmp%2Fws`), so the
 * per-workspace directory is resolvable without scanning every session.
 *
 * chat_history.jsonl is one JSON object per line. Unlike Claude Code's format
 * the record shape differs per `type`, and three of them are NOT chat:
 *
 *   type: 'system'       → the system prompt. Never surfaced.
 *   type: 'user'         → content is a ContentBlock[]. Two flavours:
 *                            - `synthetic_reason` present  → daemon/CLI-injected
 *                              context (system-reminders, MCP notices). Dropped:
 *                              these are not authored by the user.
 *                            - real prompts, wrapped in <user_query> … </user_query>
 *                              (plus a leading <user_info> environment preamble
 *                              on the first turn). The wrapper is unwrapped so the
 *                              dashboard shows what the user actually typed.
 *   type: 'assistant'    → content is a plain STRING (not a block array), and may
 *                          be empty when the turn was only a tool call — the call
 *                          itself lives in `tool_calls`. Empty text with tool_calls
 *                          is surfaced as a `tool` kind, not an empty bubble.
 *   type: 'reasoning'    → thinking. content is null; a human-readable digest is
 *                          in `summary[].text` (`encrypted_content` is opaque).
 *                          Dropped from the transcript for the same reason other
 *                          providers drop thinking blocks.
 *   type: 'tool_result'  → tool output. Surfaced as kind 'tool'.
 *
 * ★No timestamps. Unlike claude/codex JSONL, grok's chat_history records carry
 * no per-message `ts`. Ordering is file order (which is chronological), and
 * receivedAt is synthesized by interpolating between the session's created_at
 * (summary.json) and the file mtime so messages keep a stable, monotonic order
 * without inventing precise wall-clock times.
 *
 * OSS code (AGPL-3.0). Must not import from packages/ (proprietary).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Types ─────────────────────────────────────────────────────────────────

export type NativeHistoryRole = 'user' | 'assistant' | 'system';
export type NativeHistoryKind = 'standard' | 'tool' | 'session_start';

export interface GrokNativeHistoryMessage {
  ts: string;
  receivedAt: number;
  role: NativeHistoryRole;
  content: string;
  kind: NativeHistoryKind;
  agent: 'grok-cli';
  historySessionId: string;
  workspace?: string;
  providerUnitKey?: string;
}

export interface GrokNativeHistorySession {
  messages: GrokNativeHistoryMessage[];
  providerSessionId: string;
  source: 'provider-native';
  sourcePath: string;
  sourceMtimeMs: number;
  nativeHistoryCoverage: 'full';
  workspace?: string;
}

export interface GrokNativeHistorySessionMeta {
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
  agent: 'grok-cli';
  source: 'provider-native';
  nativeHistoryCoverage: 'full';
}

// ─── Path helpers ──────────────────────────────────────────────────────────

/** Root of grok's per-workspace session store, honouring $GROK_HOME. */
export function grokSessionsRoot(): string {
  const home = process.env.GROK_HOME && process.env.GROK_HOME.trim()
    ? process.env.GROK_HOME.trim()
    : path.join(os.homedir(), '.grok');
  return path.join(home, 'sessions');
}

/**
 * Grok's directory key for a workspace: the absolute path percent-encoded with
 * `/` → `%2F`. encodeURIComponent already escapes `/`, and leaves the same
 * unreserved set grok does, so it matches on the paths a workspace can be.
 */
export function encodeWorkspaceDir(workspace: string): string {
  return encodeURIComponent(workspace);
}

function statMtimeMs(filePath: string): number {
  try { return fs.statSync(filePath).mtimeMs; } catch { return 0; }
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
}

/**
 * macOS reports `/tmp/x` as `/private/tmp/x` once resolved, and grok encodes the
 * resolved path. Try the caller's path first, then its realpath.
 */
function workspaceCandidates(workspace: string): string[] {
  const out = [workspace];
  try {
    const real = fs.realpathSync(workspace);
    if (real && real !== workspace) out.push(real);
  } catch { /* workspace may not exist locally */ }
  return out;
}

/** Resolve the chat_history.jsonl for a (workspace, sessionId) pair. */
export function resolveGrokPath(workspace: string, sessionId: string): string | null {
  if (!sessionId || !isUuidLike(sessionId)) return null;
  const root = grokSessionsRoot();
  if (!fs.existsSync(root)) return null;

  for (const candidate of workspaceCandidates(workspace || '')) {
    if (!candidate) continue;
    const file = path.join(root, encodeWorkspaceDir(candidate), sessionId, 'chat_history.jsonl');
    if (fs.existsSync(file)) return file;
  }

  // Workspace key unknown (symlinked/renamed cwd): the session uuid is globally
  // unique, so a bounded one-level scan still resolves it exactly.
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, sessionId, 'chat_history.jsonl');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// ─── Content extraction ────────────────────────────────────────────────────

const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/;

/**
 * Unwrap the `<user_query>` envelope grok wraps real prompts in. The first turn
 * also carries a `<user_info>` environment preamble in the same record; keeping
 * only the query body is what the dashboard should show.
 */
export function unwrapUserQuery(text: string): string {
  const match = USER_QUERY_RE.exec(text);
  if (match) return match[1].trim();
  return text.trim();
}

function blocksToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (typeof record.text === 'string') parts.push(record.text);
    else if (record.type === 'image') parts.push('[image]');
  }
  return parts.join('\n');
}

interface ParsedRecord {
  role: NativeHistoryRole;
  content: string;
  kind: NativeHistoryKind;
}

/**
 * Map one chat_history.jsonl record to a transcript message, or null when the
 * record is not user-visible chat (system prompt, synthetic reminder, thinking).
 */
export function parseGrokRecord(raw: unknown): ParsedRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';

  // System prompt + injected context are never chat.
  if (type === 'system') return null;
  if (type === 'reasoning') return null;

  if (type === 'user') {
    // CLI-injected context (system-reminders, MCP notices) — not authored by
    // the user, so it must not render as a user bubble.
    if (typeof record.synthetic_reason === 'string' && record.synthetic_reason) return null;
    const text = unwrapUserQuery(blocksToText(record.content));
    if (!text) return null;
    return { role: 'user', content: text, kind: 'standard' };
  }

  if (type === 'assistant') {
    const text = blocksToText(record.content).trim();
    const toolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
    if (!text) {
      if (toolCalls.length === 0) return null;
      // Tool-only turn: name the calls rather than emit an empty bubble.
      const names = toolCalls
        .map((call) => (call && typeof call === 'object' ? (call as Record<string, unknown>).name : null))
        .filter((name): name is string => typeof name === 'string' && name.length > 0);
      const label = names.length > 0 ? names.join(', ') : 'tool';
      return { role: 'assistant', content: `[tool: ${label}]`, kind: 'tool' };
    }
    return { role: 'assistant', content: text, kind: 'standard' };
  }

  if (type === 'tool_result') {
    const text = blocksToText(record.content).trim();
    if (!text) return null;
    return { role: 'assistant', content: text, kind: 'tool' };
  }

  return null;
}

// ─── Session read ──────────────────────────────────────────────────────────

function readSessionCreatedAtMs(sessionDir: string): number {
  try {
    const summary = JSON.parse(fs.readFileSync(path.join(sessionDir, 'summary.json'), 'utf8'));
    const created = summary?.created_at;
    if (typeof created === 'string') {
      const parsed = Date.parse(created);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  } catch { /* summary is optional */ }
  return 0;
}

/**
 * Read one grok session transcript.
 *
 * `sourcePath` is the chat_history.jsonl; the session uuid is its parent dir.
 */
export function readSession(
  sourcePath: string,
  sessionId: string,
  workspace?: string,
): GrokNativeHistorySession | null {
  let text: string;
  try { text = fs.readFileSync(sourcePath, 'utf8'); } catch { return null; }

  const sessionDir = path.dirname(sourcePath);
  const providerSessionId = path.basename(sessionDir);
  const sourceMtimeMs = statMtimeMs(sourcePath);

  const parsed: ParsedRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: unknown;
    try { record = JSON.parse(trimmed); } catch { continue; }
    const message = parseGrokRecord(record);
    if (message) parsed.push(message);
  }

  // No per-message timestamps exist in this format (see file header). Spread
  // messages between session start and last write so ordering is stable and
  // monotonic without fabricating precise times.
  const startMs = readSessionCreatedAtMs(sessionDir) || sourceMtimeMs;
  const endMs = Math.max(sourceMtimeMs, startMs);
  const span = endMs - startMs;
  const step = parsed.length > 1 ? Math.floor(span / (parsed.length - 1)) : 0;

  const messages: GrokNativeHistoryMessage[] = parsed.map((message, index) => {
    const receivedAt = parsed.length > 1 ? startMs + step * index : endMs;
    return {
      ts: new Date(receivedAt).toISOString(),
      receivedAt,
      role: message.role,
      content: message.content,
      kind: message.kind,
      agent: 'grok-cli',
      historySessionId: sessionId || providerSessionId,
      ...(workspace ? { workspace } : {}),
      providerUnitKey: `${providerSessionId}:${index}`,
    };
  });

  return {
    messages,
    providerSessionId,
    source: 'provider-native',
    sourcePath,
    sourceMtimeMs,
    nativeHistoryCoverage: 'full',
    ...(workspace ? { workspace } : {}),
  };
}

// ─── Session listing ───────────────────────────────────────────────────────

/** List grok sessions for a workspace, newest first. */
export function listSessions(workspace: string, limit = 50): GrokNativeHistorySessionMeta[] {
  const root = grokSessionsRoot();
  if (!fs.existsSync(root)) return [];

  const dirs: string[] = [];
  for (const candidate of workspaceCandidates(workspace || '')) {
    if (!candidate) continue;
    const dir = path.join(root, encodeWorkspaceDir(candidate));
    if (fs.existsSync(dir)) dirs.push(dir);
  }
  if (dirs.length === 0) return [];

  const out: GrokNativeHistorySessionMeta[] = [];
  for (const dir of dirs) {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isUuidLike(entry.name)) continue;
      const sourcePath = path.join(dir, entry.name, 'chat_history.jsonl');
      if (!fs.existsSync(sourcePath)) continue;
      const session = readSession(sourcePath, entry.name, workspace);
      if (!session || session.messages.length === 0) continue;
      const first = session.messages[0];
      const last = session.messages[session.messages.length - 1];
      // The first user record is grok's own <user_info> environment preamble
      // (OS/shell/cwd/date), not something the user typed — titling a session
      // with it makes every session in the list look identical. Prefer the
      // first real prompt and fall back to the preamble only if there is none.
      const firstUser = session.messages.find(
        (m) => m.role === 'user' && !m.content.startsWith('<user_info>'),
      ) ?? session.messages.find((m) => m.role === 'user');
      out.push({
        historySessionId: entry.name,
        sessionId: entry.name,
        sourcePath,
        sourceMtimeMs: session.sourceMtimeMs,
        messageCount: session.messages.length,
        firstMessageAt: first.receivedAt,
        lastMessageAt: last.receivedAt,
        ...(firstUser ? { sessionTitle: firstUser.content.slice(0, 80) } : {}),
        ...(firstUser ? { preview: firstUser.content.slice(0, 200) } : {}),
        ...(workspace ? { workspace } : {}),
        agent: 'grok-cli',
        source: 'provider-native',
        nativeHistoryCoverage: 'full',
      });
    }
  }

  out.sort((a, b) => b.sourceMtimeMs - a.sourceMtimeMs);
  return out.slice(0, limit);
}

/**
 * List grok sessions across EVERY workspace in the store, newest first.
 *
 * The `list_saved_sessions` command path hands the enumerator only
 * {agentType, format, watchPath, args} — no workspace — so a workspace-scoped
 * lister would always return empty there. Each session directory records its
 * own cwd in summary.json, so the workspace is recovered per session by
 * decoding the directory key.
 */
export function listSessionsAllWorkspaces(limit = 50): GrokNativeHistorySessionMeta[] {
  const root = grokSessionsRoot();
  if (!fs.existsSync(root)) return [];

  let dirs: fs.Dirent[] = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }

  const out: GrokNativeHistorySessionMeta[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    let workspace = '';
    try { workspace = decodeURIComponent(dir.name); } catch { continue; }
    out.push(...listSessions(workspace, limit));
  }

  out.sort((a, b) => b.sourceMtimeMs - a.sourceMtimeMs);
  return out.slice(0, limit);
}
