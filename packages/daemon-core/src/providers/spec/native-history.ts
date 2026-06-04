/**
 * Native history reader for adhdev:cli/spec@1.
 *
 * Driven entirely by the `native_history` field of the spec — daemon-core
 * never branches on provider id. Three formats:
 *
 *   jsonl_lines       — newline-delimited JSON, each line is an event /
 *                       message. Used by claude-cli, codex-cli.
 *   json_single       — one JSON object containing a `messages` array.
 *                       Used by hermes-cli.
 *   antigravity_brain — agy's brain transcript / pb / history hybrid.
 *                       Delegates to the existing reader (the format is
 *                       inherently storage-specific; spec.json only
 *                       points at where to look).
 *
 * Outputs the same NativeMessage shape regardless of source so the
 * adapter can hand them to the dashboard without per-provider branching.
 */
'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { NativeHistoryConfig, NhExtractor, NhLocation } from './types.js';
import { readSession as readAntigravityBrainSession } from '../native-history/antigravity-cli-transcript.js';

export interface NativeMessage {
    id: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    timestamp?: number;
}

export interface NativeHistoryResult {
    messages: NativeMessage[];
    sourcePath: string;
    sourceMtimeMs: number;
}

export interface ResolveContext {
    workingDir: string;
    sessionId?: string;
    providerSessionId?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Public entry
// ────────────────────────────────────────────────────────────────────────────

export function readNativeHistorySync(
    cfg: NativeHistoryConfig,
    ctx: ResolveContext,
): NativeHistoryResult | null {
    const sourcePath = resolveSourcePath(cfg.location, ctx);
    if (!sourcePath || !fs.existsSync(sourcePath)) return null;

    if (cfg.format === 'antigravity_brain') {
        // antigravity reader is `async function` but contains no await —
        // it's effectively sync. Unwrap the promise immediately.
        const sessionPromise = readAntigravityBrainSession(sourcePath, ctx.providerSessionId, ctx.workingDir);
        let session: any = null;
        sessionPromise.then(s => { session = s; }).catch(() => {});
        if (!session) return null;
        return {
            messages: (session.messages as any[]).map((m: any) => ({
                id: (m as any).id ?? hashId(`${m.role}:${m.content}`),
                role: normalizeRole(m.role),
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                timestamp: (m as any).timestamp,
            })),
            sourcePath: session.sourcePath,
            sourceMtimeMs: session.sourceMtimeMs,
        };
    }

    const mtime = safeMtime(sourcePath);

    if (cfg.format === 'jsonl_lines') {
        const messages = parseJsonl(sourcePath, cfg.message_extractor ?? {});
        return { messages, sourcePath, sourceMtimeMs: mtime };
    }

    if (cfg.format === 'json_single') {
        const messages = parseJsonSingle(sourcePath, cfg.message_extractor ?? {});
        return { messages, sourcePath, sourceMtimeMs: mtime };
    }

    return null;
}

/** Async wrapper retained for the SpecCliAdapter polling path that already
 *  uses Promises. The sync version is what daemon's existing chat-history
 *  pipeline calls. */
export async function readNativeHistory(
    cfg: NativeHistoryConfig,
    ctx: ResolveContext,
): Promise<NativeHistoryResult | null> {
    return readNativeHistorySync(cfg, ctx);
}

// ────────────────────────────────────────────────────────────────────────────
// Path resolution
// ────────────────────────────────────────────────────────────────────────────

function resolveSourcePath(loc: NhLocation, ctx: ResolveContext): string | null {
    const dir = expandPath(loc.directory, ctx);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
    const pattern = expandPath(loc.file_pattern, ctx);

    if (loc.pick === 'by_session_id' && ctx.sessionId) {
        const candidate = path.join(dir, pattern.replace(/\{session_id\}/g, ctx.sessionId));
        return fs.existsSync(candidate) ? candidate : null;
    }
    if (loc.pick === 'by_provider_session_id' && ctx.providerSessionId) {
        const candidate = path.join(dir, pattern.replace(/\{provider_session_id\}/g, ctx.providerSessionId));
        return fs.existsSync(candidate) ? candidate : null;
    }
    // newest_by_mtime — allow both files and directories. Directories
    // pick the newest, then descend into a transcript.jsonl if present
    // (antigravity layout: <uuid>/.system_generated/logs/transcript.jsonl).
    const regex = patternToRegex(pattern);
    const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => regex.test(e.name))
        .map(e => {
            const p = path.join(dir, e.name);
            return { p, mtime: safeMtime(p), isDir: e.isDirectory() };
        })
        .sort((a, b) => b.mtime - a.mtime);
    for (const e of entries) {
        if (!e.isDir) return e.p;
        // Try common transcript locations inside the dir.
        const candidates = [
            path.join(e.p, '.system_generated', 'logs', 'transcript.jsonl'),
            path.join(e.p, '.system_generated', 'logs', 'transcript_full.jsonl'),
        ];
        for (const c of candidates) if (fs.existsSync(c)) return c;
    }
    return null;
}

function expandPath(input: string, ctx: ResolveContext): string {
    let out = input
        .replace(/^~/, os.homedir())
        .replace(/\{home\}/g, os.homedir())
        .replace(/\{cwd\}/g, ctx.workingDir)
        .replace(/\{cwd_slug:dashes\}/g, slugWithDashes(ctx.workingDir))
        .replace(/\{cwd_slug\}/g, slugWithDashes(ctx.workingDir))
        .replace(/\{session_id\}/g, ctx.sessionId ?? '')
        .replace(/\{provider_session_id\}/g, ctx.providerSessionId ?? '')
        .replace(/\{year\}/g, String(new Date().getUTCFullYear()))
        .replace(/\{month\}/g, String(new Date().getUTCMonth() + 1).padStart(2, '0'))
        .replace(/\{day\}/g, String(new Date().getUTCDate()).padStart(2, '0'));
    return out;
}

function slugWithDashes(cwd: string): string {
    // claude's convention: full absolute path with '/' replaced by '-'
    // including a leading '-'. e.g. /Users/x/proj → -Users-x-proj
    return cwd.replace(/\//g, '-');
}

function patternToRegex(pattern: string): RegExp {
    // Convert simple glob (*.jsonl, session_*.json) to RegExp.
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
}

function safeMtime(p: string): number {
    try { return Math.floor(fs.statSync(p).mtimeMs); } catch { return 0; }
}

// ────────────────────────────────────────────────────────────────────────────
// jsonl_lines parser
// ────────────────────────────────────────────────────────────────────────────

function parseJsonl(p: string, ext: NhExtractor): NativeMessage[] {
    const text = readSafely(p);
    if (!text) return [];
    const out: NativeMessage[] = [];
    let idx = 0;
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let obj: any;
        try { obj = JSON.parse(line); } catch { continue; }
        if (shouldSkip(obj, ext.skip_if)) continue;
        const m = extractMessage(obj, ext, idx);
        if (m) { out.push(m); idx += 1; }
    }
    return out;
}

// ────────────────────────────────────────────────────────────────────────────
// json_single parser
// ────────────────────────────────────────────────────────────────────────────

function parseJsonSingle(p: string, ext: NhExtractor): NativeMessage[] {
    const text = readSafely(p);
    if (!text) return [];
    let root: any;
    try { root = JSON.parse(text); } catch { return []; }
    const container = ext.container_path ? getByPath(root, ext.container_path) : root;
    if (!Array.isArray(container)) return [];
    const out: NativeMessage[] = [];
    let idx = 0;
    for (const obj of container) {
        if (shouldSkip(obj, ext.skip_if)) continue;
        const m = extractMessage(obj, ext, idx);
        if (m) { out.push(m); idx += 1; }
    }
    return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Field extraction
// ────────────────────────────────────────────────────────────────────────────

function extractMessage(obj: any, ext: NhExtractor, fallbackIdx: number): NativeMessage | null {
    const role = ext.role_field ? getByPath(obj, ext.role_field) : obj.role;
    const contentRaw = ext.content_field ? getByPath(obj, ext.content_field) : obj.content;
    const content = ext.content_text_path
        ? coerceString(getByPath(contentRaw, ext.content_text_path))
        : coerceString(contentRaw);
    if (!role || !content) return null;
    const ts = ext.timestamp_field ? getByPath(obj, ext.timestamp_field) : undefined;
    return {
        id: obj.id ?? obj.uuid ?? `msg_${fallbackIdx}`,
        role: normalizeRole(role),
        content,
        timestamp: typeof ts === 'number' ? ts : (typeof ts === 'string' ? Date.parse(ts) || undefined : undefined),
    };
}

function shouldSkip(obj: any, rules: NhSkipRule[] | undefined): boolean {
    if (!rules) return false;
    for (const r of rules) {
        const v = getByPath(obj, r.field);
        if (r.equals !== undefined) {
            if (deepEqual(v, r.equals)) return true;
        } else {
            if (v !== undefined && v !== null) return true;
        }
    }
    return false;
}

interface NhSkipRule { field: string; equals?: unknown }

function getByPath(obj: any, p: string): any {
    if (!obj || !p) return undefined;
    const parts = p.split(/[.\[\]]+/).filter(Boolean);
    let cur: any = obj;
    for (const part of parts) {
        if (cur === null || cur === undefined) return undefined;
        const idx = Number(part);
        cur = Number.isInteger(idx) && !part.match(/[^0-9]/) ? cur[idx] : cur[part];
    }
    return cur;
}

function coerceString(v: any): string {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) {
        return v.map(x => coerceString(typeof x === 'object' && x?.text ? x.text : x)).filter(Boolean).join('\n');
    }
    if (typeof v === 'object') return v.text ? String(v.text) : JSON.stringify(v);
    return String(v);
}

function normalizeRole(r: any): 'user' | 'assistant' | 'system' {
    const s = String(r ?? '').toLowerCase();
    if (s === 'user' || s === 'human' || s === 'user_input') return 'user';
    if (s === 'assistant' || s === 'ai' || s === 'model' || s === 'model_output' || s === 'agent_response') return 'assistant';
    // daemon's chat schema rejects 'tool'/'function' — surface as assistant
    // so the tool result message still shows up in the dashboard chat panel.
    if (s === 'tool' || s === 'tool_result' || s === 'function' || s === 'tool_call' || s === 'tool_output' || s === 'tool_response') return 'assistant';
    return 'system';
}

function deepEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object' || a === null || b === null) return false;
    const ka = Object.keys(a); const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) { if (!deepEqual(a[k], b[k])) return false; }
    return true;
}

function readSafely(p: string): string | null {
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function hashId(s: string): string {
    return `msg_${crypto.createHash('sha1').update(s).digest('hex').slice(0, 12)}`;
}
