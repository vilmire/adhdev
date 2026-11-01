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
import type { NativeHistoryJsonlSource } from './types.js';
import type { NativeHistoryInput } from './native-history-types.js';
import { readJsonlLines } from './native-history-jsonl-cache.js';
import { compileRecordShapes, projectMessages } from './native-history-projection.js';
import {
    claimKeyForPath, expandPathForDate, globToRegex, readCandidateSessionMeta, recentFiles, safeMtimeMs,
} from './native-history-paths.js';
import { __resetRestartRecoveryForTest, normInput, recoverUnique, type RecoveryMatch } from './native-history-restart-recovery.js';

const MAX_LOOKBACK_DAYS = 14;
const META_AFTER_INPUT_SLACK_MS = 60_000;

export function __resetCodexRecoveryForTest(): void { __resetRestartRecoveryForTest(); }

export interface CodexRecoveryResult { path: string }

export function recoverCodexSourceFromPersistedInputs(
    src: NativeHistoryJsonlSource, input: NativeHistoryInput, owner: string,
): CodexRecoveryResult | null {
    const instanceId = String(input.instanceId || '').trim();
    const workspace = String(input.workspace || '').trim();
    const wsKey = claimKeyForPath(workspace || '.');
    const filePat = src.file_pattern ? globToRegex(src.file_pattern) : /^rollout-.*\.jsonl$/;
    const shapes = compileRecordShapes(src);
    const p = recoverUnique({
        provider: 'codex-cli', instanceId, owner, workspace,
        stillValid: fs.existsSync,
        find: (first) => {
            const now = Date.now();
            const seen = new Set<string>();
            const candidates: string[] = [];
            const lastDay = now + 24 * 3_600_000;
            for (let day = first.at - 24 * 3_600_000, n = 0; day <= lastDay && n < MAX_LOOKBACK_DAYS + 2; day += 24 * 3_600_000, n++) {
                const dir = expandPathForDate(src.path, input, new Date(day));
                if (!dir || seen.has(dir)) continue;
                seen.add(dir);
                for (const f of recentFiles(dir, filePat, now - first.at + 1, first.at)) candidates.push(f);
            }
            const matches: RecoveryMatch[] = [];
            for (const f of candidates) {
                if (safeMtimeMs(f) < first.at) continue;
                const meta = readCandidateSessionMeta(f);
                if (!meta?.cwd || claimKeyForPath(meta.cwd) !== wsKey) continue;
                if (meta.sessionTimestampMs == null || meta.sessionTimestampMs > first.at + META_AFTER_INPUT_SLACK_MS) continue;
                const lines = readJsonlLines(f);
                let hit = false;
                for (let i = 0; i < lines.length && !hit; i += 1) {
                    const shape = shapes.pick(lines[i]);
                    if (!shape) continue;
                    for (const msg of projectMessages(lines[i], shape.map, i, lines.length, 0)) {
                        if (msg.role === 'user' && msg.content && normInput(msg.content) === first.text) { hit = true; break; }
                    }
                }
                if (hit) matches.push({ id: f, claimKey: claimKeyForPath(f) });
            }
            return matches;
        },
    });
    return p ? { path: p } : null;
}
