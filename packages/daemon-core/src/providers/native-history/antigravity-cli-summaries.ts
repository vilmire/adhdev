/**
 * Synchronous saved-session enumerator for Antigravity CLI.
 *
 * `list_saved_sessions` consumes a SYNCHRONOUS lister, so the async
 * `listSessions` in antigravity-cli-transcript.ts (which parses every
 * brain/.db/.pb source) cannot serve it, and parsing ~500 conversation dbs
 * would be too slow anyway. agy keeps its own per-conversation index in
 * `conversation_summaries.db` (id, title, preview, step_count,
 * last_modified_time, workspace_uris), which is exactly what a picker needs.
 * history.jsonl (user prompts) fills in conversations the index lacks.
 *
 * Ids are agy conversation uuids — the same value `resume` passes to
 * `agy --conversation <id>`.
 */
'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadBetterSqlite3 } from '../../system/load-better-sqlite3.js';
import { statMtimeMs } from './fs-utils.js';
import {
  listHistoryJsonlSessionMetas,
  readHistoryRows,
  type NativeHistorySessionMeta,
} from './antigravity-cli-transcript.js';

const TEXT_MAX = 200;

function agyRoot(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

function clip(s: unknown): string | undefined {
  if (typeof s !== 'string') return undefined;
  const t = s.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, TEXT_MAX) : undefined;
}

/** First `file://` workspace URI → absolute path. */
function workspaceFromUris(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  let uris: unknown;
  try { uris = JSON.parse(raw); } catch { return undefined; }
  if (!Array.isArray(uris)) return undefined;
  const first = uris.find((u) => typeof u === 'string' && u.startsWith('file://')) as string | undefined;
  if (!first) return undefined;
  try {
    let p = decodeURIComponent(first.slice('file://'.length));
    if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1); // file:///C:/x on win32
    return p || undefined;
  } catch { return undefined; }
}

function parseTimeMs(v: unknown): number {
  if (typeof v !== 'string' || !v || v.startsWith('0001-')) return 0;
  const ms = Date.parse(v.replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : 0;
}

interface SummaryRow {
  conversation_id: string;
  title: string;
  preview: string;
  step_count: number;
  last_modified_time: string;
  workspace_uris: string;
  parent_conversation_id: string;
}

function readSummaryRows(dbPath: string): SummaryRow[] {
  if (!fs.existsSync(dbPath)) return [];
  let Database: any;
  try { Database = loadBetterSqlite3(); } catch { return []; }
  let db: any;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return db.prepare(
      'SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, parent_conversation_id FROM conversation_summaries',
    ).all() as SummaryRow[];
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function conversationFile(convRoot: string, id: string): string | null {
  for (const ext of ['db', 'pb']) {
    const p = path.join(convRoot, `${id}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Saved agy conversations, most recently active first. */
export function listAntigravityCliSessionsSync(limit = 50): NativeHistorySessionMeta[] {
  const root = agyRoot();
  const convRoot = path.join(root, 'conversations');
  const summariesPath = path.join(root, 'conversation_summaries.db');
  const historyRows = readHistoryRows();
  const firstPromptAt = new Map<string, number>();
  const historyWorkspace = new Map<string, string>();
  for (const r of historyRows) {
    const prev = firstPromptAt.get(r.conversationId);
    if (prev === undefined || r.receivedAt < prev) firstPromptAt.set(r.conversationId, r.receivedAt);
    if (r.workspace && !historyWorkspace.has(r.conversationId)) historyWorkspace.set(r.conversationId, r.workspace);
  }

  const seen = new Set<string>();
  const results: NativeHistorySessionMeta[] = [];
  for (const row of readSummaryRows(summariesPath)) {
    const id = String(row.conversation_id || '').trim();
    if (!id || seen.has(id)) continue;
    if (row.parent_conversation_id) continue; // sub-agent conversation, not user-resumable
    const file = conversationFile(convRoot, id);
    if (!file) continue; // index entry whose conversation was deleted
    const sourceMtimeMs = statMtimeMs(file);
    const lastMessageAt = parseTimeMs(row.last_modified_time) || sourceMtimeMs;
    const preview = clip(row.preview);
    results.push({
      historySessionId: id,
      sessionId: id,
      sourcePath: file,
      sourceMtimeMs,
      messageCount: Math.max(0, Number(row.step_count) || 0),
      firstMessageAt: Math.min(firstPromptAt.get(id) ?? lastMessageAt, lastMessageAt),
      lastMessageAt,
      sessionTitle: clip(row.title) ?? preview,
      preview,
      workspace: workspaceFromUris(row.workspace_uris) ?? historyWorkspace.get(id),
      agent: 'antigravity-cli',
      source: 'provider-native',
      nativeHistoryCoverage: 'full',
    });
    seen.add(id);
  }

  // Conversations the index does not know (older agy, missing index): the
  // user-prompt log still lets them be listed and resumed.
  results.push(...listHistoryJsonlSessionMetas(historyRows, seen));

  results.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
  return results.slice(0, Math.max(1, limit));
}
