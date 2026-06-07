/**
 * Spec-aware dispatcher for native conversation history.
 *
 * The four existing readers (claude/codex/antigravity/hermes) already know
 * how to parse each agent's on-disk format. This dispatcher just resolves
 * the right file given a workspace + sessionId hint, then hands it off.
 *
 * Wired into ProviderModule.scripts.readNativeHistory by provider-loader
 * when spec.json declares native_history.reader. The script signature
 * matches what chat-history.ts expects (see callProviderNativeHistoryRead).
 */
'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readSession as readClaudeCliSession } from './claude-cli-transcript.js';
import { readSession as readCodexCliSession } from './codex-cli-transcript.js';
import { readSession as readAntigravityCliSession } from './antigravity-cli-transcript.js';
import { readSession as readHermesCliSession } from './hermes-cli-transcript.js';

export type ReaderId = 'claude-cli' | 'codex-cli' | 'antigravity-cli' | 'hermes-cli';

export interface NativeHistoryInput {
    agentType?: string;
    sessionId?: string;
    providerSessionId?: string;
    historySessionId?: string;
    workspace?: string;
    format?: string;
    watchPath?: string;
    forceRefresh?: boolean;
    args?: Record<string, unknown>;
}

export interface NativeHistoryResult {
    messages: Array<{ role: string; content: string; receivedAt?: number; kind?: string }>;
    providerSessionId?: string;
    sourcePath: string;
    sourceMtimeMs: number;
    nativeHistoryCoverage?: 'full' | 'partial' | 'best-effort';
}

export function createNativeHistoryDispatcher(reader: ReaderId): (input: NativeHistoryInput) => NativeHistoryResult | null {
    return (input: NativeHistoryInput) => {
        const workspace = input.workspace || '';
        const sessionId = input.sessionId || input.historySessionId || '';
        // Caller may pass a providerSessionId (the *provider's own* id, e.g.
        // the uuid claude writes into the jsonl basename). When present, the
        // dispatcher only returns a transcript whose file id matches —
        // otherwise the newest_by_mtime fallback can surface a different
        // session's chat (round 9 part b: the user reported "previous chat
        // shows up before I type anything" on every provider).
        const requestedProviderSid = input.providerSessionId || '';

        const sourcePath = resolveSourcePath(reader, workspace, sessionId);
        if (!sourcePath) return null;
        if (input.forceRefresh === true || input.args?.forceRefresh === true) {
            try { fs.statSync(sourcePath); } catch { /* best-effort metadata refresh */ }
        }

        const session = readByReader(reader, sourcePath, sessionId, workspace);
        if (!session) return null;

        if (requestedProviderSid && session.providerSessionId && session.providerSessionId !== requestedProviderSid) {
            return null;
        }

        return {
            messages: session.messages.map((m: any) => ({
                role: normalizeRole(m.role),
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                receivedAt: typeof m.receivedAt === 'number' ? m.receivedAt : Date.parse(m.timestamp || '') || Date.now(),
                kind: typeof m.kind === 'string' ? m.kind : 'standard',
            })),
            providerSessionId: session.providerSessionId,
            sourcePath: session.sourcePath,
            sourceMtimeMs: session.sourceMtimeMs,
            nativeHistoryCoverage: (session as any).nativeHistoryCoverage || 'full',
        };
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Per-provider path resolution
// ────────────────────────────────────────────────────────────────────────────

function resolveSourcePath(reader: ReaderId, workspace: string, sessionId: string): string | null {
    switch (reader) {
        case 'claude-cli':   return resolveClaudePath(workspace, sessionId);
        case 'codex-cli':    return resolveCodexPath(workspace);
        case 'antigravity-cli': return resolveAntigravityPath(workspace);
        case 'hermes-cli':   return resolveHermesPath(workspace, sessionId);
    }
}

function resolveClaudePath(workspace: string, sessionId: string): string | null {
    // claude stores per-cwd: ~/.claude/projects/<cwd-as-dashes>/<uuid>.jsonl
    const dir = path.join(os.homedir(), '.claude', 'projects', cwdAsDashes(workspace));
    if (!fs.existsSync(dir)) return null;
    if (sessionId) {
        const candidate = path.join(dir, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) return candidate;
    }
    // No exact match: return null. The newest_by_mtime fallback used to
    // grab whichever transcript was touched most recently, but that
    // surfaced a different (often the user's *external* claude session
    // in the same workspace) chat in the dashboard before the user
    // typed anything. The right answer is to show nothing until either
    // the daemon's sessionId actually maps to a file or the caller
    // passes the correct providerSessionId (round 9 part b).
    return null;
}

function resolveCodexPath(workspace: string): string | null {
    void workspace;
    // codex stores by UTC date: ~/.codex/sessions/<year>/<month>/<day>/<file>.jsonl
    const now = new Date();
    const dir = path.join(
        os.homedir(), '.codex', 'sessions',
        String(now.getUTCFullYear()),
        String(now.getUTCMonth() + 1).padStart(2, '0'),
        String(now.getUTCDate()).padStart(2, '0'),
    );
    if (fs.existsSync(dir)) {
        const f = newestRecentFile(dir, /\.jsonl$/);
        if (f) return f;
    }
    return null;
}

function resolveAntigravityPath(workspace: string): string | null {
    void workspace;
    // agy brain/<uuid>/.system_generated/logs/transcript.jsonl
    const brainRoot = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
    if (!fs.existsSync(brainRoot)) return null;
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    const entries = fs.readdirSync(brainRoot, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => ({ p: path.join(brainRoot, e.name), mtime: safeMtime(path.join(brainRoot, e.name)) }))
        .filter(e => e.mtime >= cutoff)
        .sort((a, b) => b.mtime - a.mtime);
    for (const e of entries) {
        const t = path.join(e.p, '.system_generated', 'logs', 'transcript.jsonl');
        if (fs.existsSync(t)) return t;
    }
    return null;
}

function resolveHermesPath(workspace: string, sessionId: string): string | null {
    void workspace; void sessionId;
    // Hermes ≥ 0.14 persists all chat to ~/.hermes/state.db (SQLite). The
    // db file is the "path" we hand to the reader — it pulls the newest
    // source='cli' session inside readSession.
    const dbPath = path.join(os.homedir(), '.hermes', 'state.db');
    if (fs.existsSync(dbPath)) return dbPath;
    // Legacy fallback: pre-db hermes wrote per-session JSON dumps.
    const dir = path.join(os.homedir(), '.hermes', 'sessions');
    if (!fs.existsSync(dir)) return null;
    return newestRecentFile(dir, /^session_.*\.json$/);
}

// ────────────────────────────────────────────────────────────────────────────
// Reader dispatch
// ────────────────────────────────────────────────────────────────────────────

function readByReader(
    reader: ReaderId,
    sourcePath: string,
    sessionId: string,
    workspace: string,
): any | null {
    switch (reader) {
        case 'claude-cli':      return readClaudeCliSession(sourcePath);
        case 'codex-cli':       return readCodexCliSession(sourcePath);
        case 'antigravity-cli': return readAntigravityCliSession(sourcePath, sessionId || undefined, workspace || undefined);
        case 'hermes-cli':      return readHermesCliSession(sourcePath);
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function cwdAsDashes(cwd: string): string {
    if (!cwd) return '';
    return cwd.replace(/\//g, '-');
}

function newestFile(dir: string, pattern: RegExp): string | null {
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
            .filter(e => e.isFile() && pattern.test(e.name))
            .map(e => ({ p: path.join(dir, e.name), mtime: safeMtime(path.join(dir, e.name)) }))
            .sort((a, b) => b.mtime - a.mtime);
        return entries[0]?.p ?? null;
    } catch { return null; }
}

/**
 * Like newestFile but only returns a candidate when its mtime is within
 * the recent activity window. Prevents the dashboard from surfacing a
 * prior session's transcript when the daemon's sessionId doesn't match
 * any file on disk (e.g. claude allocates its own uuid; daemon and
 * agent disagree about what the "current" session is).
 */
const RECENT_WINDOW_MS = 5 * 60 * 1000;
function newestRecentFile(dir: string, pattern: RegExp): string | null {
    try {
        const cutoff = Date.now() - RECENT_WINDOW_MS;
        const entries = fs.readdirSync(dir, { withFileTypes: true })
            .filter(e => e.isFile() && pattern.test(e.name))
            .map(e => ({ p: path.join(dir, e.name), mtime: safeMtime(path.join(dir, e.name)) }))
            .filter(e => e.mtime >= cutoff)
            .sort((a, b) => b.mtime - a.mtime);
        return entries[0]?.p ?? null;
    } catch { return null; }
}

function safeMtime(p: string): number {
    try { return Math.floor(fs.statSync(p).mtimeMs); } catch { return 0; }
}

function normalizeRole(r: any): 'user' | 'assistant' | 'system' {
    const s = String(r ?? '').toLowerCase();
    if (s === 'user' || s === 'human') return 'user';
    if (s === 'assistant' || s === 'ai' || s === 'model') return 'assistant';
    // daemon's chat schema rejects 'tool'/'function' — surface as assistant.
    if (s === 'tool' || s === 'tool_result' || s === 'function') return 'assistant';
    return 'system';
}
