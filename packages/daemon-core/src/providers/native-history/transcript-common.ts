/**
 * Parsing primitives the built-in JSONL transcript readers share (claude-cli,
 * codex-cli, grok-cli, antigravity-cli): timestamp coercion, the raw record
 * reader the TOOL-EXPAND path indexes against, the session-id shape check, and
 * the recursive session listing claude and codex run over their stores.
 *
 * OSS code (AGPL-3.0). Must not import from packages/ (proprietary).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isSafeFilename, statMtimeMs } from './fs-utils.js';

/** Epoch-ms from a number or a numeric / ISO string; 0 when unusable. */
export function extractTimestampValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

/** A canonical UUID (the session-id shape codex and antigravity key their stores by). */
export function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Re-read a JSONL transcript into the record array a TOOL-EXPAND address
 * (`recordIndex`) indexes against: one entry per line that parses to an object,
 * blank / malformed / non-object lines skipped.
 *
 * Deliberately re-implemented rather than reusing the spec path's
 * `readJsonlLines`: that cache indexes the records IT chose to keep, and its
 * skip rule is maintained independently of these readers'. Two parsers agreeing
 * today is not the same as two parsers that cannot disagree, and a one-record
 * drift between them would silently return a neighbouring tool's output — the
 * exact mis-addressing the mtime seal exists to prevent, but invisible to it
 * because the seal would still match.
 */
export function readJsonlRecords(filePath: string): Record<string, unknown>[] {
  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown = null;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;
    out.push(parsed as Record<string, unknown>);
  }
  return out;
}

interface ListedTranscriptMessage {
  kind?: string;
  content: string;
  receivedAt?: number;
  workspace?: string;
}

/** The provider-neutral part of a listed JSONL session's metadata. */
export interface ListedJsonlSession {
  historySessionId: string;
  sessionId: string;
  sourcePath: string;
  sourceMtimeMs: number;
  messageCount: number;
  firstMessageAt: number;
  lastMessageAt: number;
  sessionTitle: string;
  preview: string;
  workspace: string | undefined;
}

/**
 * List every `*.jsonl` session under the watchPath's base dir (or `fallbackRoot`
 * when that does not exist), newest first. `watchPath` is the provider.v1.json
 * pattern; `~/` is expanded and any glob tail dropped — the canonical root is
 * always scanned recursively regardless of the pattern's content. `parse`
 * resolves one file to its session id + messages, or null to skip it.
 */
export function listJsonlTranscriptSessions(
  watchPath: string,
  fallbackRoot: string,
  parse: (entryPath: string, fileName: string) => { sessionId: string; messages: ListedTranscriptMessage[] } | null,
): ListedJsonlSession[] {
  const expandedBase = watchPath.startsWith('~/')
    ? path.join(os.homedir(), watchPath.slice(2).split('/**')[0].split('/*')[0])
    : watchPath.split('/**')[0].split('/*')[0];
  const root = fs.existsSync(expandedBase) ? expandedBase : fallbackRoot;
  if (!fs.existsSync(root)) return [];

  const results: ListedJsonlSession[] = [];
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
      if (!isSafeFilename(path.basename(entry.name, '.jsonl'))) continue;

      const parsed = parse(entryPath, entry.name);
      if (!parsed) continue;
      const { sessionId, messages } = parsed;
      const sourceMtimeMs = statMtimeMs(entryPath);
      const visible = messages.filter((m) => m.kind !== 'session_start');
      if (visible.length === 0) continue;

      const firstSystem = messages.find((m) => m.kind === 'session_start');
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
        workspace: firstSystem?.workspace || firstSystem?.content || undefined,
      });
    }
  }

  results.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
  return results;
}
