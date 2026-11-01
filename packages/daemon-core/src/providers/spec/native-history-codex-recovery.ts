/**
 * Post-restart recovery of a codex session's rollout from PERSISTED input
 * evidence.
 *
 * The in-memory sent-prompt registry and the spawn floor both die with the
 * daemon. A worker re-adopted from the session host after a restart therefore
 * has no way to prove which rollout is its own: the rollout's session_meta
 * timestamp predates the new spawn floor and the registry is empty, so the
 * read stays `transcript_unmapped` forever and the dashboard shows prompts
 * only.
 *
 * The per-instance saved history (config history dir) survives restarts and
 * holds the exact user inputs this instance sent. A rollout is mapped only when
 *   - its session_meta.cwd is this session's workspace,
 *   - one of its user records equals the FIRST persisted input of this
 *     instance as a whole (not a substring),
 *   - it was created no later than shortly after that input, and written
 *     since,
 *   - exactly one rollout qualifies and no other instance persisted the same
 *     first input, and no other live session holds the transcript.
 * Anything else fails closed (null).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getHistoryDir, listHistoryFiles } from '../../config/chat-history-files.js';
import { LOG } from '../../logging/logger.js';
import type { NativeHistoryJsonlSource } from './types.js';
import type { NativeHistoryInput } from './native-history-types.js';
import { readJsonlLines } from './native-history-jsonl-cache.js';
import { compileRecordShapes, projectMessages } from './native-history-projection.js';
import {
    claimKeyForPath, expandPathForDate, globToRegex, readCandidateSessionMeta, recentFiles, safeMtimeMs,
} from './native-history-paths.js';
import { claimTranscript, isTranscriptClaimedByOther } from '../native-history/transcript-claim-registry.js';
import { recordSentPrompt } from '../native-history/sent-prompt-registry.js';

const MAX_LOOKBACK_DAYS = 14;
const META_AFTER_INPUT_SLACK_MS = 60_000;
const NEGATIVE_CACHE_MS = 15_000;
const MAX_INPUTS = 20;

const recovered = new Map<string, string>();
const negative = new Map<string, number>();

export function __resetCodexRecoveryForTest(): void { recovered.clear(); negative.clear(); }

const norm = (t: string): string => t.replace(/\s+/g, ' ').trim();

interface PersistedInput { text: string; at: number }

function readPersistedUserInputs(agentType: string, instanceId: string): PersistedInput[] {
    const dir = path.join(getHistoryDir(), agentType.replace(/[^a-zA-Z0-9_-]/g, '_'));
    let files: string[];
    try { files = listHistoryFiles(dir, instanceId).slice().reverse(); } catch { return []; }
    const out: PersistedInput[] = [];
    for (const f of files) {
        let raw = '';
        try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
        for (const line of raw.split('\n')) {
            if (!line) continue;
            let r: any;
            try { r = JSON.parse(line); } catch { continue; }
            if (r?.role !== 'user' || typeof r.content !== 'string') continue;
            if (r.instanceId && String(r.instanceId) !== instanceId) continue;
            const at = Number(r.receivedAt) || Date.parse(r.ts || '') || 0;
            if (at > 0 && norm(r.content).length >= 8) out.push({ text: norm(r.content), at });
        }
    }
    return out.sort((a, b) => a.at - b.at);
}

/** True when another instance of this provider persisted the same first input. */
function siblingPersistedSameInput(agentType: string, instanceId: string, text: string, sinceMs: number): boolean {
    const dir = path.join(getHistoryDir(), agentType.replace(/[^a-zA-Z0-9_-]/g, '_'));
    let files: string[];
    try { files = listHistoryFiles(dir); } catch { return false; }
    const needle = text.slice(0, 200);
    for (const f of files) {
        if (f.startsWith(`${instanceId}_`)) continue;
        try { if (fs.statSync(path.join(dir, f)).mtimeMs < sinceMs) continue; } catch { continue; }
        let raw = '';
        try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
        if (!raw.includes(JSON.stringify(needle).slice(1, -1).slice(0, 120))) continue;
        for (const line of raw.split('\n')) {
            if (!line) continue;
            try {
                const r = JSON.parse(line);
                if (r?.role === 'user' && typeof r.content === 'string' && norm(r.content) === text) return true;
            } catch { /* skip */ }
        }
    }
    return false;
}

export interface CodexRecoveryResult { path: string }

export function recoverCodexSourceFromPersistedInputs(
    src: NativeHistoryJsonlSource, input: NativeHistoryInput, owner: string,
): CodexRecoveryResult | null {
    const instanceId = String(input.instanceId || '').trim();
    const workspace = String(input.workspace || '').trim();
    if (!instanceId || !owner || !workspace) return null;
    const known = recovered.get(owner);
    if (known && fs.existsSync(known)) return { path: known };
    const now = Date.now();
    if ((negative.get(owner) ?? 0) > now) return null;
    const miss = (): null => { negative.set(owner, now + NEGATIVE_CACHE_MS); return null; };

    const inputs = readPersistedUserInputs('codex-cli', instanceId);
    if (inputs.length === 0) return miss();
    const first = inputs[0];
    const wsKey = claimKeyForPath(workspace);
    const filePat = src.file_pattern ? globToRegex(src.file_pattern) : /^rollout-.*\.jsonl$/;
    const shapes = compileRecordShapes(src);

    const seen = new Set<string>();
    const candidates: string[] = [];
    const lastDay = now + 24 * 3_600_000;
    for (let day = first.at - 24 * 3_600_000, n = 0; day <= lastDay && n < MAX_LOOKBACK_DAYS + 2; day += 24 * 3_600_000, n++) {
        const dir = expandPathForDate(src.path, input, new Date(day));
        if (!dir || seen.has(dir)) continue;
        seen.add(dir);
        for (const p of recentFiles(dir, filePat, now - first.at + 1, first.at)) candidates.push(p);
    }

    const matches: string[] = [];
    for (const p of candidates) {
        if (safeMtimeMs(p) < first.at) continue;
        const meta = readCandidateSessionMeta(p);
        if (!meta?.cwd || claimKeyForPath(meta.cwd) !== wsKey) continue;
        if (meta.sessionTimestampMs == null || meta.sessionTimestampMs > first.at + META_AFTER_INPUT_SLACK_MS) continue;
        const lines = readJsonlLines(p);
        let hit = false;
        for (let i = 0; i < lines.length && !hit; i += 1) {
            const shape = shapes.pick(lines[i]);
            if (!shape) continue;
            for (const msg of projectMessages(lines[i], shape.map, i, lines.length, 0)) {
                if (msg.role === 'user' && msg.content && norm(msg.content) === first.text) { hit = true; break; }
            }
        }
        if (hit) matches.push(p);
    }
    if (matches.length !== 1) {
        if (matches.length > 1) LOG.info('TranscriptClaim', `decision=ambiguous provider=codex-cli owner=${owner} candidates=${matches.length} → recovery refused`);
        return miss();
    }
    if (isTranscriptClaimedByOther(claimKeyForPath(matches[0]), owner)) return miss();
    if (siblingPersistedSameInput('codex-cli', instanceId, first.text, first.at - 60_000)) return miss();
    if (claimTranscript(claimKeyForPath(matches[0]), owner) === 'denied') return miss();

    // Re-arm the in-memory ownership evidence so the standard confirmation
    // (exclusive whole input) holds for this and later reads.
    for (const i of inputs.slice(-MAX_INPUTS)) recordSentPrompt(instanceId, i.text);
    recovered.set(owner, matches[0]);
    LOG.info('TranscriptClaim', `decision=recovered provider=codex-cli owner=${owner} key=${matches[0]} (persisted input evidence)`);
    return { path: matches[0] };
}
