/**
 * claude-cli-transcript — Daemon-side built-in native history adapter for claude-cli.
 *
 * Reads Claude Code JSONL transcript files directly without shelling out to a JS override.
 * The transcript format is one JSON object per line, where each line has:
 *   - type: 'user' | 'assistant'
 *   - message: { content: string | ContentBlock[] }
 *   - timestamp: number (ms epoch) | string (ISO)
 *   - sessionId?: string
 *   - cwd?: string
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
  agent: 'claude-cli';
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
  agent: 'claude-cli';
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

function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9._:-]+$/.test(sessionId) && !sessionId.includes('..');
}

/**
 * Expand assistant content array into flat text + kind.
 * For array content, text blocks → 'standard', tool_use blocks → 'tool'.
 */
function extractAssistantContentParts(
  content: unknown,
): Array<{ content: string; kind: NativeHistoryKind; senderName?: string }> {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed ? [{ content: trimmed, kind: 'standard' }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: Array<{ content: string; kind: NativeHistoryKind; senderName?: string }> = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const type = String((block as Record<string, unknown>).type || '').trim();
    if (type === 'text') {
      const text = String((block as Record<string, unknown>).text || '').trim();
      if (text) parts.push({ content: text, kind: 'standard' });
    } else if (type === 'tool_use') {
      const name = String((block as Record<string, unknown>).name || '').trim() || 'Tool';
      const input = (block as Record<string, unknown>).input;
      const command =
        input && typeof input === 'object'
          ? String((input as Record<string, unknown>).command || '').trim()
          : '';
      parts.push({
        content: command ? `${name}: ${command}` : name,
        kind: 'tool',
        senderName: 'Tool',
      });
    }
  }
  return parts;
}

/**
 * Expand user content array into flat text + role parts.
 * text blocks → role: 'user', tool_result blocks → role: 'assistant' kind: 'tool'.
 */
function extractUserContentParts(
  content: unknown,
): Array<{ role: NativeHistoryRole; content: string; kind: NativeHistoryKind; senderName?: string }> {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed ? [{ role: 'user', content: trimmed, kind: 'standard' }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: Array<{ role: NativeHistoryRole; content: string; kind: NativeHistoryKind; senderName?: string }> = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const type = String((block as Record<string, unknown>).type || '').trim();
    if (type === 'text') {
      const text = String((block as Record<string, unknown>).text || '').trim();
      if (text) parts.push({ role: 'user', content: text, kind: 'standard' });
    } else if (type === 'tool_result') {
      const raw = (block as Record<string, unknown>).content;
      let text = '';
      if (typeof raw === 'string') {
        text = raw.trim();
      } else if (Array.isArray(raw)) {
        text = (raw as unknown[])
          .map((entry) => {
            if (typeof entry === 'string') return entry.trim();
            if (!entry || typeof entry !== 'object') return '';
            const e = entry as Record<string, unknown>;
            if (typeof e.text === 'string') return e.text.trim();
            if (typeof e.content === 'string') return e.content.trim();
            return '';
          })
          .filter(Boolean)
          .join('\n');
      }
      if (text) parts.push({ role: 'assistant', content: text, kind: 'tool', senderName: 'Tool' });
    }
  }
  return parts;
}

/** Claude projects root: ~/.claude/projects */
function claudeProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Locate the JSONL transcript for `sessionId`.
 * Tries `~/.claude/projects/<workspaceDir>/<sessionId>.jsonl` first, then
 * scans all project subdirectories as fallback.
 */
function resolveTranscriptPath(sessionId: string, workspace?: string): string | null {
  const root = claudeProjectsRoot();
  if (!fs.existsSync(root)) return null;

  const normalizedWorkspace = typeof workspace === 'string' ? workspace.trim() : '';
  if (normalizedWorkspace) {
    const workspaceDir = normalizedWorkspace.replace(/[\\/]/g, '-');
    const directPath = path.resolve(root, workspaceDir, `${sessionId}.jsonl`);
    // Safety: must remain inside root
    if (directPath.startsWith(root + path.sep) || directPath === root) {
      if (fs.existsSync(directPath)) return directPath;
    }
  }

  // Scan all project subdirectories for a matching file
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Parse a single JSONL transcript file into NativeHistoryMessages.
 * Malformed lines are silently skipped.
 */
function parseTranscriptFile(
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

    // Validate sessionId when present in line
    const lineSessionId = String(record.sessionId || '').trim();
    if (lineSessionId && lineSessionId !== sessionId) continue;

    const receivedAt = extractTimestampValue(record.timestamp) || fallbackTs;
    fallbackTs = receivedAt + 1;

    // Capture workspace from first cwd encountered
    const lineCwd = String(record.cwd || '').trim();
    if (!detectedWorkspace && lineCwd) detectedWorkspace = lineCwd;

    // Emit session_start system record once (first line that has cwd or any content)
    if (records.length === 0 && detectedWorkspace) {
      records.push({
        ts: new Date(receivedAt).toISOString(),
        receivedAt,
        role: 'system',
        content: detectedWorkspace,
        kind: 'session_start',
        agent: 'claude-cli',
        historySessionId: sessionId,
        workspace: detectedWorkspace,
      });
    }

    const type = String(record.type || '').trim();
    const message = record.message && typeof record.message === 'object'
      ? (record.message as Record<string, unknown>)
      : null;

    if (!message) continue;

    if (type === 'user') {
      for (const part of extractUserContentParts(message.content)) {
        const msg: NativeHistoryMessage = {
          ts: new Date(receivedAt).toISOString(),
          receivedAt,
          role: part.role,
          content: part.content,
          kind: part.kind,
          agent: 'claude-cli',
          historySessionId: sessionId,
        };
        if (part.senderName) msg.senderName = part.senderName;
        if (detectedWorkspace) msg.workspace = detectedWorkspace;
        records.push(msg);
      }
    } else if (type === 'assistant') {
      for (const part of extractAssistantContentParts(message.content)) {
        const msg: NativeHistoryMessage = {
          ts: new Date(receivedAt).toISOString(),
          receivedAt,
          role: 'assistant',
          content: part.content,
          kind: part.kind,
          agent: 'claude-cli',
          historySessionId: sessionId,
        };
        if (part.senderName) msg.senderName = part.senderName;
        if (detectedWorkspace) msg.workspace = detectedWorkspace;
        records.push(msg);
      }
    }
  }

  return records;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Read a single Claude Code session by its transcript file path.
 *
 * `sessionPath` is the absolute path to a `<uuid>.jsonl` file.
 * Returns `null` when the file is missing, empty, or yields no parseable messages.
 */
export async function readSession(sessionPath: string): Promise<NativeHistorySession | null> {
  if (!sessionPath || !path.isAbsolute(sessionPath)) return null;

  const basename = path.basename(sessionPath, '.jsonl');
  if (!isSafeSessionId(basename)) return null;
  if (!fs.existsSync(sessionPath)) return null;

  const sourceMtimeMs = statMtimeMs(sessionPath);
  const messages = parseTranscriptFile(sessionPath, basename);
  if (messages.length === 0) return null;

  const firstSystem = messages.find((m) => m.kind === 'session_start');
  const workspace = firstSystem?.workspace || firstSystem?.content || undefined;

  return {
    messages,
    providerSessionId: basename,
    source: 'provider-native',
    sourcePath: sessionPath,
    sourceMtimeMs,
    nativeHistoryCoverage: 'full',
    workspace,
  };
}

/**
 * List all Claude Code sessions under the given glob-style watchPath base dir.
 *
 * `watchPath` is the pattern from provider.v1.json (`~/.claude/projects/**\/*.jsonl`).
 * This implementation expands the home directory and scans `~/.claude/projects/`
 * recursively, collecting all `.jsonl` files.
 *
 * Returns summary metadata for each session (no full message reads on this hot path;
 * each file is opened only for lightweight scanning).
 */
export async function listSessions(watchPath: string): Promise<NativeHistorySessionMeta[]> {
  // Resolve base dir from watchPath: strip leading `~/` then resolve globs.
  // We always scan the canonical root regardless of glob pattern content.
  const expandedBase = watchPath.startsWith('~/')
    ? path.join(os.homedir(), watchPath.slice(2).split('/**')[0].split('/*')[0])
    : watchPath.split('/**')[0].split('/*')[0];

  // Fall back to the canonical ~/.claude/projects root
  const root = fs.existsSync(expandedBase) ? expandedBase : claudeProjectsRoot();
  if (!fs.existsSync(root)) return [];

  const results: NativeHistorySessionMeta[] = [];

  // Recursive directory scan
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

      const sessionId = path.basename(entryPath, '.jsonl');
      if (!isSafeSessionId(sessionId)) continue;

      const sourceMtimeMs = statMtimeMs(entryPath);
      const messages = parseTranscriptFile(entryPath, sessionId);
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
        agent: 'claude-cli',
        source: 'provider-native',
        nativeHistoryCoverage: 'full',
      });
    }
  }

  // Sort by most recently updated first
  results.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
  return results;
}
