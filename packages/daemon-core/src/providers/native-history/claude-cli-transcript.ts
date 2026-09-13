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
import {
  foldUsageRecords,
  makeUsage,
  type NativeUsageRecord,
  type SessionUsageTotals,
} from '../../shared/usage-normalize.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export type { NativeHistoryRole, NativeHistoryKind } from './types.js';
import type { NativeHistoryRole, NativeHistoryKind } from './types.js';
import { statMtimeMs } from './fs-utils.js';
import {
  oneLine,
  TOOL_CALL_SUMMARY_MAX,
  TOOL_RESULT_SUMMARY_MAX,
} from '../spec/native-history-tool-blocks.js';
import type { NativeHistoryToolBlockRef } from '../spec/native-history-types.js';

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
  /**
   * (TOOL-EXPAND) Address of the source block this bubble was summarised from.
   * Present only on `kind:'tool'` bubbles the caps below actually truncated —
   * see `stampClaudeToolRef`.
   */
  toolBlockRef?: NativeHistoryToolBlockRef;
}

export interface NativeHistorySession {
  messages: NativeHistoryMessage[];
  providerSessionId: string;
  source: 'provider-native';
  sourcePath: string;
  sourceMtimeMs: number;
  nativeHistoryCoverage: 'full';
  workspace?: string;
  /** Token/cost totals, omitted when the transcript records no usage. */
  usage?: SessionUsageTotals;
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

function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9._:-]+$/.test(sessionId) && !sessionId.includes('..');
}

/**
 * A parsed content block, carrying the index it occupied in the raw `content`
 * array so a truncated tool bubble can be addressed back to its source block.
 * `blockIndex` is -1 for parts that did not come from an indexable array (a
 * plain string `content`), which are never tool bubbles and so never stamped.
 */
interface ContentPart {
  content: string;
  kind: NativeHistoryKind;
  senderName?: string;
  /** Index in the record's raw `content` array; -1 when not array-addressed. */
  blockIndex: number;
  /** True when a summary cap dropped text — the gate for stamping a ref. */
  truncated: boolean;
}

/**
 * Render a `tool_use` block's arguments for the bubble.
 *
 * The pre-existing behaviour showed ONLY `input.command`, so every non-shell
 * tool (Read, Edit, Task, …) rendered as a bare name with its arguments
 * nowhere — and, worse, a bash call with a 10KB heredoc rendered in full,
 * uncapped, on every read_chat. Both are fixed by summarising the same way the
 * spec parser does: prefer `command` when present (it is the most legible
 * single field), else the whole input object, then cap.
 */
function summarizeToolUseInput(block: Record<string, unknown>): { text: string; truncated: boolean } {
  const input = block.input;
  if (input == null) return { text: '', truncated: false };
  if (typeof input === 'object' && !Array.isArray(input)) {
    const command = (input as Record<string, unknown>).command;
    if (typeof command === 'string' && command.trim()) {
      return oneLine(command, TOOL_CALL_SUMMARY_MAX);
    }
  }
  const raw = typeof input === 'string' ? input : safeStringify(input);
  return oneLine(raw, TOOL_CALL_SUMMARY_MAX);
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? ''; } catch { return ''; }
}

/**
 * Expand assistant content array into flat text + kind.
 * For array content, text blocks → 'standard', tool_use blocks → 'tool'.
 */
function extractAssistantContentParts(content: unknown): ContentPart[] {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed ? [{ content: trimmed, kind: 'standard', blockIndex: -1, truncated: false }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: ContentPart[] = [];
  for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
    const block = content[blockIndex];
    if (!block || typeof block !== 'object') continue;
    const type = String((block as Record<string, unknown>).type || '').trim();
    if (type === 'text') {
      const text = String((block as Record<string, unknown>).text || '').trim();
      if (text) parts.push({ content: text, kind: 'standard', blockIndex, truncated: false });
    } else if (type === 'tool_use') {
      const name = String((block as Record<string, unknown>).name || '').trim() || 'Tool';
      const { text: args, truncated } = summarizeToolUseInput(block as Record<string, unknown>);
      parts.push({
        content: args ? `${name}: ${args}` : name,
        kind: 'tool',
        senderName: 'Tool',
        blockIndex,
        truncated,
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
): Array<ContentPart & { role: NativeHistoryRole }> {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed
      ? [{ role: 'user', content: trimmed, kind: 'standard', blockIndex: -1, truncated: false }]
      : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: Array<ContentPart & { role: NativeHistoryRole }> = [];
  for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
    const block = content[blockIndex];
    if (!block || typeof block !== 'object') continue;
    const type = String((block as Record<string, unknown>).type || '').trim();
    if (type === 'text') {
      const text = String((block as Record<string, unknown>).text || '').trim();
      if (text) {
        parts.push({ role: 'user', content: text, kind: 'standard', blockIndex, truncated: false });
      }
    } else if (type === 'tool_result') {
      const raw = flattenToolResultContent((block as Record<string, unknown>).content);
      if (!raw) continue;
      // Tool results are the big ones — measured up to 125KB in a live
      // ~/.claude transcript. Before this cap they were carried in FULL on
      // every read_chat payload; now the bubble shows a summary and the body
      // stays on disk behind the ref.
      const { text, truncated } = oneLine(raw, TOOL_RESULT_SUMMARY_MAX);
      if (!text) continue;
      parts.push({
        role: 'assistant',
        content: text,
        kind: 'tool',
        senderName: 'Tool',
        blockIndex,
        truncated,
      });
    }
  }
  return parts;
}

/**
 * Flatten a `tool_result` block's `content` to plain text.
 *
 * Shared by the parse path and the expand path so both agree on what "the
 * result body" is — an expand that flattened differently would return text the
 * reader could not match against the bubble it clicked.
 */
function flattenToolResultContent(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (!Array.isArray(raw)) return '';
  return (raw as unknown[])
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

/**
 * Extract a per-message usage delta from a claude-cli transcript line.
 *
 * Shape (assistant lines only): `message.usage = { input_tokens,
 * output_tokens, cache_creation_input_tokens, cache_read_input_tokens, ... }`.
 * Returns null when the line carries no usage — user lines, tool results, and
 * transcripts written by older CLI versions all legitimately lack it.
 *
 * Note `usage.iterations[]` is deliberately ignored: it is a per-iteration
 * BREAKDOWN of the same totals already on the parent object, so folding it in
 * would double-count every streamed message.
 */
function extractClaudeUsage(
  message: Record<string, unknown>,
  receivedAt: number,
): NativeUsageRecord | null {
  const raw = message.usage;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const usage = raw as Record<string, unknown>;

  const normalized = makeUsage({
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
    model: typeof message.model === 'string' ? message.model : undefined,
  });

  // A usage object present but entirely zero still counts as an observation —
  // dropping it would silently lose the record count. Only a structurally
  // absent usage returns null (handled above).
  return { ...normalized, mode: 'delta', receivedAt };
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
 * Attach an expand ref to a bubble, but ONLY when expanding would actually show
 * something new.
 *
 * Three conditions, all necessary:
 *   - `kind === 'tool'`: nothing else has a truncated body behind it.
 *   - `part.truncated`: the cap actually bit. Stamping a complete bubble gives
 *     the reader a button that returns the string they are already looking at.
 *   - `sourceMtimeMs > 0` and `blockIndex >= 0`: without a seal the ref cannot
 *     be validated on resolve, and without an array position it cannot be
 *     addressed at all.
 */
function stampToolBlockRef(
  msg: NativeHistoryMessage,
  part: { kind: NativeHistoryKind; blockIndex: number; truncated: boolean },
  recordIndex: number,
  sourceMtimeMs: number,
): void {
  if (part.kind !== 'tool') return;
  if (!part.truncated) return;
  if (!(sourceMtimeMs > 0) || part.blockIndex < 0 || recordIndex < 0) return;
  msg.toolBlockRef = { sourceMtimeMs, recordIndex, blockIndex: part.blockIndex };
}

/**
 * Re-parse the transcript into the SAME record array `parseTranscriptFile`
 * indexes against, for the expand path to address by `recordIndex`.
 *
 * Deliberately re-implemented here rather than reusing the spec path's
 * `readJsonlLines`: that cache indexes the records IT chose to keep, and its
 * skip rule (trim-then-parse, malformed dropped) is maintained independently of
 * this reader's. Two parsers agreeing today is not the same as two parsers that
 * cannot disagree, and a one-record drift between them would silently return a
 * neighbouring tool's output — the exact mis-addressing the mtime seal exists
 * to prevent, but invisible to it because the seal would still match.
 */
export function readClaudeRecords(filePath: string): Record<string, unknown>[] {
  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split('\n').filter(Boolean)) {
    let parsed: unknown = null;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;
    out.push(parsed as Record<string, unknown>);
  }
  return out;
}

/**
 * Read one addressed claude tool block at full length.
 *
 * Returns null when the address does not name a tool block, so the caller can
 * report a typed refusal rather than an empty body.
 */
export function readClaudeToolBlockAt(
  record: Record<string, unknown>,
  blockIndex: number,
): { toolName?: string; callArgs?: string; result?: string } | null {
  const message = record.message && typeof record.message === 'object'
    ? (record.message as Record<string, unknown>)
    : null;
  if (!message) return null;
  const content = message.content;
  if (!Array.isArray(content)) return null;
  if (blockIndex < 0 || blockIndex >= content.length) return null;
  const block = content[blockIndex];
  if (!block || typeof block !== 'object') return null;

  const b = block as Record<string, unknown>;
  const type = String(b.type || '').trim();
  if (type === 'tool_use') {
    const toolName = String(b.name || '').trim() || 'Tool';
    const input = b.input;
    // Return the WHOLE input, not just `command`. The summary prefers
    // `command` for legibility, but the point of expanding is to see
    // everything the summary dropped — including the other arguments.
    const callArgs = input == null
      ? ''
      : typeof input === 'string' ? input : safeStringifyPretty(input);
    return { toolName, callArgs };
  }
  if (type === 'tool_result') {
    const result = flattenToolResultContent(b.content);
    return { result };
  }
  return null;
}

function safeStringifyPretty(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? ''; } catch { return ''; }
}

/**
 * Parse a single JSONL transcript file into NativeHistoryMessages plus the
 * session's token usage.
 *
 * Malformed lines are silently skipped. Usage collection is additive: the
 * `messages` array is byte-for-byte what this function returned before usage
 * existed, so every existing caller is unaffected.
 */
function parseTranscriptFile(
  filePath: string,
  sessionId: string,
  workspaceFallback?: string,
  /**
   * (TOOL-EXPAND) mtime seal for refs minted here. Passed in rather than
   * re-stat'ed so the seal is the SAME value the session reports as
   * `sourceMtimeMs` — a second stat could observe a newer mtime and mint refs
   * that the expand path then rejects as `source_changed` on first click.
   * Omitted (0) by callers that only want message text, which skips stamping.
   */
  sourceMtimeMs = 0,
): { messages: NativeHistoryMessage[]; usageRecords: NativeUsageRecord[] } {
  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { return { messages: [], usageRecords: [] }; }

  const lines = raw.split('\n').filter(Boolean);
  const records: NativeHistoryMessage[] = [];
  const usageRecords: NativeUsageRecord[] = [];
  // Claude re-emits a streamed assistant message across several lines that
  // share one `message.id`, each carrying the same cumulative usage for that
  // message. Keying on the id keeps exactly one observation per message so a
  // long streamed reply is not counted many times over.
  const seenUsageMessageIds = new Set<string>();
  let fallbackTs = Date.now();
  let detectedWorkspace = typeof workspaceFallback === 'string' ? workspaceFallback.trim() : '';

  // recordIndex counts SURVIVING records — every line this loop successfully
  // parses, including ones it later skips for other reasons. It must not count
  // raw lines, because `readClaudeRecords` (the expand path) rebuilds the same
  // array from the same rule; addressing by raw line number would drift by one
  // for every malformed or blank line in the file.
  let recordIndex = -1;
  for (const line of lines) {
    let parsed: unknown = null;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;
    recordIndex++;

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

    // Collect usage BEFORE the content switch: an assistant line whose content
    // yields no renderable parts (e.g. a pure tool_use turn already deduped
    // away) still consumed tokens and must still be billed.
    const usageRecord = extractClaudeUsage(message, receivedAt);
    if (usageRecord) {
      const messageId = String(message.id || '').trim();
      if (!messageId || !seenUsageMessageIds.has(messageId)) {
        if (messageId) seenUsageMessageIds.add(messageId);
        usageRecords.push(usageRecord);
      }
    }

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
        stampToolBlockRef(msg, part, recordIndex, sourceMtimeMs);
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
        stampToolBlockRef(msg, part, recordIndex, sourceMtimeMs);
        records.push(msg);
      }
    }
  }

  return { messages: records, usageRecords };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Read a single Claude Code session by its transcript file path.
 *
 * `sessionPath` is the absolute path to a `<uuid>.jsonl` file.
 * Returns `null` when the file is missing, empty, or yields no parseable messages.
 */
export function readSession(sessionPath: string): NativeHistorySession | null {
  if (!sessionPath || !path.isAbsolute(sessionPath)) return null;

  const basename = path.basename(sessionPath, '.jsonl');
  if (!isSafeSessionId(basename)) return null;
  if (!fs.existsSync(sessionPath)) return null;

  const sourceMtimeMs = statMtimeMs(sessionPath);
  // Seal the refs with the mtime this session will report, so an expand
  // request minted from this read validates against the same number.
  const { messages, usageRecords } = parseTranscriptFile(sessionPath, basename, undefined, sourceMtimeMs);
  if (messages.length === 0) return null;

  const firstSystem = messages.find((m) => m.kind === 'session_start');
  const workspace = firstSystem?.workspace || firstSystem?.content || undefined;

  const session: NativeHistorySession = {
    messages,
    providerSessionId: basename,
    source: 'provider-native',
    sourcePath: sessionPath,
    sourceMtimeMs,
    nativeHistoryCoverage: 'full',
    workspace,
  };
  if (usageRecords.length > 0) {
    session.usage = foldUsageRecords(usageRecords, {
      providerSessionId: basename,
      agent: 'claude-cli',
    });
  }
  return session;
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
      const { messages } = parseTranscriptFile(entryPath, sessionId);
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
