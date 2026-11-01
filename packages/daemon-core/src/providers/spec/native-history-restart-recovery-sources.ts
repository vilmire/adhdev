/**
 * Per-provider candidate finders for post-restart transcript recovery (kimi,
 * cursor-cli, opencode). The provider-neutral safety rules live in
 * native-history-restart-recovery.ts; here each store only answers "which
 * transcripts have a FIRST user message equal to this instance's first
 * persisted input, in this workspace, inside a plausible time window".
 * Codex has its own finder (native-history-codex-recovery.ts).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadBetterSqlite3 } from '../../system/load-better-sqlite3.js';
import type { NativeHistoryJsonlSource, NativeHistorySqliteSource } from './types.js';
import type { NativeHistoryInput } from './native-history-types.js';
import { readJsonlLines } from './native-history-jsonl-cache.js';
import { compileRecordShapes, projectMessages } from './native-history-projection.js';
import {
    claimKeyForPath, expandDirGlob, expandPath, globToRegex, listMatchingFiles, safeMtimeMs, workspaceFromInputIfSlugMatches,
} from './native-history-paths.js';
import { jsonPathGet } from './native-history-jsonpath.js';
import { normInput, recoverUnique, type PersistedInput, type RecoveryMatch } from './native-history-restart-recovery.js';

const MAX_CANDIDATES = 150;
/** A prompt record may be stamped slightly before / well after the daemon logged the send (startup, trust modals). */
const PROMPT_BEFORE_INPUT_SLACK_MS = 30_000;
const PROMPT_AFTER_INPUT_SLACK_MS = 10 * 60_000;

function realOrRaw(p: string): string { try { return fs.realpathSync(p); } catch { return p; } }

/** First non-empty user message of a jsonl transcript, with its declared timestamp when the spec maps one. */
function firstUserMessage(file: string, src: NativeHistoryJsonlSource): { text: string; ts: number | null } | null {
    const shapes = compileRecordShapes(src);
    const lines = readJsonlLines(file);
    for (let i = 0; i < lines.length; i += 1) {
        const shape = shapes.pick(lines[i]);
        if (!shape) continue;
        for (const msg of projectMessages(lines[i], shape.map, i, lines.length, 0)) {
            if (msg.role !== 'user' || !msg.content) continue;
            return { text: normInput(msg.content), ts: shape.map.timestamp_ms ? msg.receivedAt : null };
        }
    }
    return null;
}

function jsonlMatches(files: string[], src: NativeHistoryJsonlSource, first: PersistedInput): RecoveryMatch[] {
    const out: RecoveryMatch[] = [];
    for (const f of files.slice(0, MAX_CANDIDATES)) {
        if (safeMtimeMs(f) < first.at) continue;
        const u = firstUserMessage(f, src);
        if (!u || u.text !== first.text) continue;
        if (u.ts != null && (u.ts < first.at - PROMPT_BEFORE_INPUT_SLACK_MS || u.ts > first.at + PROMPT_AFTER_INPUT_SLACK_MS)) continue;
        out.push({ id: f, claimKey: claimKeyForPath(f) });
    }
    return out;
}

function allFiles(template: string, pattern: RegExp): string[] {
    const out: string[] = [];
    for (const d of expandDirGlob(template)) for (const p of listMatchingFiles(d, pattern)) out.push(p);
    return out;
}

/** kimi: wire.jsonl under a glob, workspace from the per-session sidecar state.json. */
export function recoverKimiSourceFromPersistedInputs(
    src: NativeHistoryJsonlSource, input: NativeHistoryInput, owner: string,
): string | null {
    const sidecar = src.workspace_from_sidecar;
    const template = expandPath(src.path, input);
    const workspace = String(input.workspace || '').trim();
    if (!sidecar || !template || !workspace) return null;
    const wsReal = realOrRaw(workspace);
    const pattern = src.file_pattern ? globToRegex(src.file_pattern) : /.*\.jsonl$/;
    return recoverUnique({
        provider: String(input.agentType || 'kimi'), instanceId: String(input.instanceId || '').trim(), owner, workspace,
        stillValid: fs.existsSync,
        find: (first) => {
            const files = allFiles(template, pattern).filter((p) => {
                try {
                    const side = JSON.parse(fs.readFileSync(path.resolve(path.dirname(p), sidecar.rel_path), 'utf8'));
                    const ws = jsonPathGet(side, sidecar.workspace_path);
                    return typeof ws === 'string' && ws.trim() !== '' && (ws.trim() === workspace || realOrRaw(ws.trim()) === wsReal);
                } catch { return false; }
            });
            return jsonlMatches(files, src, first);
        },
    });
}

/** cursor-cli: agent-transcripts/<uuid>/<uuid>.jsonl; the workspace lives only in the lossy project slug. */
export function recoverCursorSourceFromPersistedInputs(
    src: NativeHistoryJsonlSource, input: NativeHistoryInput, owner: string,
): string | null {
    const template = expandPath(src.path, input);
    const workspace = String(input.workspace || '').trim();
    if (!template || !workspace || !src.workspace_from_input) return null;
    const pattern = src.file_pattern ? globToRegex(src.file_pattern) : /.*\.jsonl$/;
    return recoverUnique({
        provider: String(input.agentType || 'cursor-cli'), instanceId: String(input.instanceId || '').trim(), owner, workspace,
        stillValid: fs.existsSync,
        find: (first) => jsonlMatches(allFiles(template, pattern).filter(p => workspaceFromInputIfSlugMatches(p, input)), src, first),
    });
}

/** opencode: sqlite; candidates come from the spec's own list_query (id, workspace, first_at, last_at). */
export function recoverSqliteSessionFromPersistedInputs(
    src: NativeHistorySqliteSource, input: NativeHistoryInput, owner: string, dbPath: string,
): string | null {
    const workspace = String(input.workspace || '').trim();
    if (!src.list_query || !workspace) return null;
    const wsReal = realOrRaw(workspace);
    return recoverUnique({
        provider: String(input.agentType || 'opencode'), instanceId: String(input.instanceId || '').trim(), owner, workspace,
        find: (first) => {
            let db: any;
            try { db = new (loadBetterSqlite3())(dbPath, { readonly: true, fileMustExist: true }); } catch { return []; }
            try {
                const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
                const rows: any[] = db.prepare(src.list_query!).all();
                const matches: RecoveryMatch[] = [];
                for (const r of rows.slice(0, MAX_CANDIDATES * 4)) {
                    const id = r?.id != null ? String(r.id) : '';
                    const ws = typeof r?.workspace === 'string' ? r.workspace.trim() : '';
                    if (!id || !ws || (ws !== workspace && realOrRaw(ws) !== wsReal)) continue;
                    if (num(r.last_at) < first.at || (num(r.first_at) > first.at + PROMPT_AFTER_INPUT_SLACK_MS)) continue;
                    let msgs: any[];
                    try { msgs = db.prepare(src.message_query).all(id); } catch { continue; }
                    for (let i = 0; i < msgs.length; i += 1) {
                        const projected = projectMessages(msgs[i], src.message_map, i, msgs.length, 0).find(m => m.role === 'user' && m.content);
                        if (!projected) continue;
                        if (normInput(projected.content) === first.text) matches.push({ id, claimKey: `${dbPath}#${id}` });
                        break;
                    }
                }
                return matches;
            } catch { return []; } finally { try { db.close(); } catch { /* ignore */ } }
        },
    });
}
