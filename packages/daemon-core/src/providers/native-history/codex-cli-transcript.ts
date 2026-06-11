/**
 * codex-cli-transcript — Daemon-side built-in native history adapter for codex-cli.
 *
 * Reads Codex CLI rollout JSONL session files directly without shelling out to a JS override.
 * Files are stored at ~/.codex/sessions/<uuid>[-<slug>].jsonl.
 *
 * Format — each line is a JSON object of one of these types:
 *   { type: 'session_meta', timestamp: number, payload: { id: string, cwd: string, ... } }
 *   { type: 'response_item', timestamp: number, payload: { type: 'message', role: 'user'|'assistant', content: ... } }
 *   { type: 'response_item', timestamp: number, payload: { type: 'function_call' | 'custom_tool_call', name?: string, arguments?: string, input?: unknown } }
 *   { type: 'response_item', timestamp: number, payload: { type: 'function_call_output' | 'custom_tool_call_output', output?: string, result?: string } }
 *
 * watchPath (from provider.v1.json): ~/.codex/sessions
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
  agent: 'codex-cli';
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
  nativeHistoryCoverage: 'full';
  workspace?: string;
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
  agent: 'codex-cli';
  source: 'provider-native';
  nativeHistoryCoverage: 'full';
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

function isUuidLikeSessionId(sessionId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId);
}

function isSafeFilename(name: string): boolean {
  return /^[A-Za-z0-9._:-]+$/.test(name) && !name.includes('..');
}

function codexSessionsRoot(): string {
  return path.join(os.homedir(), '.codex', 'sessions');
}

/**
 * Flatten Codex content (string, array, or nested object with text/output/message) into plain text.
 */
function flattenCodexContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (content == null) return '';
  if (Array.isArray(content)) {
    return (content as unknown[]).map(flattenCodexContent).filter(Boolean).join('\n').trim();
  }
  if (typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text.trim();
    if (typeof obj.content === 'string' || Array.isArray(obj.content)) return flattenCodexContent(obj.content);
    if (typeof obj.output === 'string') return obj.output.trim();
    if (typeof obj.message === 'string') return obj.message.trim();
  }
  return '';
}

/**
 * Summarize tool call arguments into a compact string.
 */
function summarizeToolArguments(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return (value as unknown[]).map(String).join(' ').trim();
  if (!value || typeof value !== 'object') return '';
  const obj = value as Record<string, unknown>;
  const direct = obj.command ?? obj.cmd ?? obj.query ?? obj.path ?? obj.prompt;
  if (typeof direct === 'string') return direct.trim();
  if (Array.isArray(direct)) return (direct as unknown[]).map(String).join(' ').trim();
  try { return JSON.stringify(value).trim(); } catch { return ''; }
}

/**
 * Build a human-readable summary of a Codex tool call payload.
 */
function summarizeToolCall(payload: Record<string, unknown>): string {
  const name = String(payload.name ?? payload.type ?? 'tool').trim() || 'tool';
  const rawArguments = payload.arguments ?? payload.input;
  let argumentValue = '';
  if (typeof rawArguments === 'string') {
    const trimmed = rawArguments.trim();
    try {
      argumentValue = summarizeToolArguments(JSON.parse(trimmed));
    } catch {
      argumentValue = trimmed;
    }
  } else {
    argumentValue = summarizeToolArguments(rawArguments);
  }
  return argumentValue ? `${name}: ${argumentValue}` : name;
}

/**
 * Extract text content from a tool output payload.
 */
function extractToolOutputContent(payload: Record<string, unknown>): string {
  const output = payload.output ?? payload.result ?? payload.content;
  const text = flattenCodexContent(output);
  if (text) return text;
  if (output && typeof output === 'object') {
    try { return JSON.stringify(output).trim(); } catch { return ''; }
  }
  return '';
}

function hasAssistantStandardMessageSinceLastUser(records: NativeHistoryMessage[], content: string): boolean {
  const normalized = content.trim();
  if (!normalized) return false;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record.kind === 'session_start') continue;
    if (record.role === 'user') return false;
    if (record.role === 'assistant' && record.kind === 'standard' && record.content.trim() === normalized) {
      return true;
    }
  }
  return false;
}

function pushAssistantStandardMessage(
  records: NativeHistoryMessage[],
  sessionId: string,
  receivedAt: number,
  content: string,
  workspace?: string,
): void {
  const text = content.trim();
  if (!text) return;
  if (hasAssistantStandardMessageSinceLastUser(records, text)) return;

  const msg: NativeHistoryMessage = {
    ts: new Date(receivedAt).toISOString(),
    receivedAt,
    role: 'assistant',
    content: text,
    kind: 'standard',
    agent: 'codex-cli',
    historySessionId: sessionId,
  };
  if (workspace) msg.workspace = workspace;
  records.push(msg);
}

/**
 * Read the first line of a Codex JSONL session file and parse the session_meta record.
 * Returns the payload object (containing id, cwd, etc.) or null.
 */
function readSessionMeta(filePath: string): Record<string, unknown> | null {
  try {
    const firstLine = fs.readFileSync(filePath, 'utf-8').split('\n').find(Boolean);
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine) as Record<string, unknown>;
    if (String(parsed.type ?? '') !== 'session_meta') return null;
    return parsed.payload && typeof parsed.payload === 'object'
      ? (parsed.payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Parse a Codex session JSONL file into NativeHistoryMessages.
 * The sessionId must be the UUID from the session_meta row.
 */
function parseSessionFile(
  filePath: string,
  sessionId: string,
  workspaceFallback?: string,
): NativeHistoryMessage[] {
  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }

  const lines = raw.split('\n').filter(Boolean);
  const records: NativeHistoryMessage[] = [];
  let fallbackTs = Date.now();
  let detectedWorkspace = typeof workspaceFallback === 'string' ? workspaceFallback.trim() : '';

  for (const line of lines) {
    let parsed: unknown = null;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;

    const record = parsed as Record<string, unknown>;
    const receivedAt = extractTimestampValue(record.timestamp) || fallbackTs;
    fallbackTs = receivedAt + 1;

    const type = String(record.type ?? '').trim();
    const payload = record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : null;
    if (!payload) continue;

    if (type === 'session_meta') {
      // Validate session identity — if the meta reports a different id, bail out
      const metaId = String(payload.id ?? '').trim();
      if (metaId && metaId !== sessionId) return [];

      const metaWorkspace = String(payload.cwd ?? '').trim();
      if (!detectedWorkspace && metaWorkspace) detectedWorkspace = metaWorkspace;

      // Emit session_start system record once
      if (records.length === 0 && detectedWorkspace) {
        records.push({
          ts: new Date(receivedAt).toISOString(),
          receivedAt,
          role: 'system',
          content: detectedWorkspace,
          kind: 'session_start',
          agent: 'codex-cli',
          historySessionId: sessionId,
          workspace: detectedWorkspace,
        });
      }
      continue;
    }

    const payloadType = String(payload.type ?? '').trim();

    if (type === 'event_msg') {
      if (payloadType === 'task_complete') {
        pushAssistantStandardMessage(
          records,
          sessionId,
          receivedAt,
          flattenCodexContent(payload.last_agent_message),
          detectedWorkspace,
        );
      } else if (payloadType === 'agent_message' && String(payload.phase ?? '').trim() === 'final_answer') {
        pushAssistantStandardMessage(
          records,
          sessionId,
          receivedAt,
          flattenCodexContent(payload.message),
          detectedWorkspace,
        );
      }
      continue;
    }

    if (type !== 'response_item') continue;

    if (payloadType === 'message') {
      const role = String(payload.role ?? '').trim();
      if (role !== 'user' && role !== 'assistant') continue;

      const content = flattenCodexContent(payload.content);
      if (!content) continue;
      if (role === 'assistant' && hasAssistantStandardMessageSinceLastUser(records, content)) continue;

      const msg: NativeHistoryMessage = {
        ts: new Date(receivedAt).toISOString(),
        receivedAt,
        role: role as 'user' | 'assistant',
        content,
        kind: 'standard',
        agent: 'codex-cli',
        historySessionId: sessionId,
      };
      if (detectedWorkspace) msg.workspace = detectedWorkspace;
      records.push(msg);
    } else if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
      const content = summarizeToolCall(payload);
      if (!content) continue;

      const msg: NativeHistoryMessage = {
        ts: new Date(receivedAt).toISOString(),
        receivedAt,
        role: 'assistant',
        content,
        kind: 'tool',
        senderName: 'Tool',
        agent: 'codex-cli',
        historySessionId: sessionId,
      };
      if (detectedWorkspace) msg.workspace = detectedWorkspace;
      records.push(msg);
    } else if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
      const content = extractToolOutputContent(payload);
      if (!content) continue;

      const msg: NativeHistoryMessage = {
        ts: new Date(receivedAt).toISOString(),
        receivedAt,
        role: 'assistant',
        content,
        kind: 'tool',
        senderName: 'Tool',
        agent: 'codex-cli',
        historySessionId: sessionId,
      };
      if (detectedWorkspace) msg.workspace = detectedWorkspace;
      records.push(msg);
    }
  }

  return records;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Read a single Codex CLI session by its JSONL file path.
 *
 * `sessionPath` is the absolute path to a `<uuid>[-<slug>].jsonl` file
 * under ~/.codex/sessions/.
 * Returns `null` when the file is missing, empty, or yields no parseable messages.
 */
export function readSession(sessionPath: string): NativeHistorySession | null {
  if (!sessionPath || !path.isAbsolute(sessionPath)) return null;
  if (!fs.existsSync(sessionPath)) return null;

  // Derive the session UUID from the file.
  // The meta row's id is authoritative; the filename may also carry a UUID.
  // When both are present they must agree — a mismatch means the file is corrupt
  // or belongs to a different session, so we reject it.
  const meta = readSessionMeta(sessionPath);
  const metaId = String(meta?.id ?? '').trim();

  // Extract UUID from filename (filename may include a slug suffix like <uuid>-name)
  const basename = path.basename(sessionPath, '.jsonl');
  const uuidMatch = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  const filenameUuid = uuidMatch ? uuidMatch[1] : '';

  // Reject when both IDs are present but don't match
  if (metaId && filenameUuid && metaId !== filenameUuid) return null;

  const sessionId = metaId || filenameUuid;
  if (!sessionId || !isUuidLikeSessionId(sessionId)) return null;

  const workspaceFallback = typeof meta?.cwd === 'string' ? meta.cwd : undefined;
  const sourceMtimeMs = statMtimeMs(sessionPath);
  const messages = parseSessionFile(sessionPath, sessionId, workspaceFallback);
  if (messages.length === 0) return null;

  const firstSystem = messages.find((m) => m.kind === 'session_start');
  const workspace = firstSystem?.workspace || firstSystem?.content || undefined;

  return {
    messages,
    providerSessionId: sessionId,
    source: 'provider-native',
    sourcePath: sessionPath,
    sourceMtimeMs,
    nativeHistoryCoverage: 'full',
    workspace,
  };
}

/**
 * List all Codex CLI sessions under the given watchPath base dir.
 *
 * `watchPath` is the value from provider.v1.json (`~/.codex/sessions`).
 * Expands the home directory and scans the directory recursively,
 * collecting all `.jsonl` files.
 *
 * Returns summary metadata for each session, sorted by most recently updated first.
 */
export async function listSessions(watchPath: string): Promise<NativeHistorySessionMeta[]> {
  const expandedBase = watchPath.startsWith('~/')
    ? path.join(os.homedir(), watchPath.slice(2).split('/**')[0].split('/*')[0])
    : watchPath.split('/**')[0].split('/*')[0];

  const root = fs.existsSync(expandedBase) ? expandedBase : codexSessionsRoot();
  if (!fs.existsSync(root)) return [];

  const results: NativeHistorySessionMeta[] = [];
  const uuidPattern = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      if (!isSafeFilename(entry.name.replace('.jsonl', ''))) continue;

      // Derive session UUID from meta or filename
      const meta = readSessionMeta(entryPath);
      const metaId = String(meta?.id ?? '').trim();
      const filenameMatch = entry.name.replace('.jsonl', '').match(uuidPattern);
      const sessionId = metaId || (filenameMatch ? filenameMatch[1] : '');
      if (!sessionId || !isUuidLikeSessionId(sessionId)) continue;

      const workspaceFallback = typeof meta?.cwd === 'string' ? meta.cwd : undefined;
      const sourceMtimeMs = statMtimeMs(entryPath);
      const messages = parseSessionFile(entryPath, sessionId, workspaceFallback);
      const visible = messages.filter((m) => m.kind !== 'session_start');
      if (visible.length === 0) continue;

      const firstSystem = messages.find((m) => m.kind === 'session_start');
      const workspace = firstSystem?.workspace || firstSystem?.content || undefined;
      const firstMsg = visible[0];
      const lastMsg = visible[visible.length - 1];

      results.push({
        historySessionId: sessionId,
        sessionId,
        sourcePath: entryPath,
        sourceMtimeMs,
        messageCount: visible.length,
        firstMessageAt: firstMsg.receivedAt || sourceMtimeMs,
        lastMessageAt: lastMsg.receivedAt || sourceMtimeMs,
        sessionTitle: lastMsg.content,
        preview: lastMsg.content,
        workspace,
        agent: 'codex-cli',
        source: 'provider-native',
        nativeHistoryCoverage: 'full',
      });
    }
  }

  results.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
  return results;
}
