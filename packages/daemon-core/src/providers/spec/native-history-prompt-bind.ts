/**
 * Prompt-evidence transcript binding for stores that expose no session id up
 * front (cursor-agent's agent-transcripts).
 *
 * Prompt text alone is weak evidence: a long task prompt re-driven into several
 * sessions (or an identical prompt typed twice) appears in every sibling's
 * transcript. 2026-10 fleet member: a cursor worker lost its transcript to a
 * sibling and showed "generating…" forever. The rules here keep a bind honest:
 *
 *   1. PIN — a transcript this session already holds the claim on is kept
 *      (no recency window: an idle finished session still reads its own file).
 *   2. SPAWN PROXIMITY — among prompt matches, a transcript born at/after this
 *      session's spawn (minus the bind grace) ranks first, closest birth first,
 *      so two live sessions with identical prompts each get their own file.
 *   3. NO TAKEOVER ON PROMPT ALONE — a transcript with a foreign claim record
 *      (even a stale one) is only taken when it was born after this session's
 *      spawn, or its FIRST user record is this session's FIRST prompt.
 *
 * Trade-off (owner principle: convenience first, never silent): rule 3 can
 * leave a restored/attached session unbound when its sibling's stale claim
 * still names the file; the typed `no_prompt_evidence` debug line says so, and
 * exact-id binds (resume) are unaffected.
 */
import * as fs from 'fs';
import { containsSentPrompt } from '../native-history/sent-prompt-registry.js';
import { SPAWN_BIND_GRACE_MS } from '../native-history/constants.js';
import { claimTranscript, hasForeignClaimRecord, transcriptKeysOwnedBy } from '../native-history/transcript-claim-registry.js';
import { claimKeyForPath, safeBirthtimeMs } from './native-history-paths.js';

/** The transcript this session already holds the claim on (and that still
 *  exists and matches the source's file pattern), refreshed; else null. */
export function pinnedTranscript(owner: string, filePat: RegExp): string | null {
    for (const key of transcriptKeysOwnedBy(owner)) {
        try {
            if (!fs.statSync(key).isFile()) continue;
        } catch { continue; }
        filePat.lastIndex = 0;
        if (!filePat.test(key.split(/[\\/]/).pop() || '')) continue;
        if (claimTranscript(key, owner) === 'denied') continue;
        return key;
    }
    return null;
}

const FIRST_RECORD_SCAN_BYTES = 64 * 1024;

/** True when the transcript's first user record contains `snippet`. */
export function firstUserRecordHasPrompt(p: string, snippet: string): boolean {
    if (!snippet) return false;
    let head = '';
    try {
        const fd = fs.openSync(p, 'r');
        try {
            const buf = Buffer.alloc(FIRST_RECORD_SCAN_BYTES);
            const n = fs.readSync(fd, buf, 0, buf.length, 0);
            head = buf.subarray(0, n).toString('utf8');
        } finally { fs.closeSync(fd); }
    } catch { return false; }
    for (const line of head.split('\n')) {
        if (!line.trim()) continue;
        let rec: any;
        try { rec = JSON.parse(line); } catch { continue; }
        if (rec?.role !== 'user') continue;
        const content = rec?.message?.content;
        const text = Array.isArray(content) ? content.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('\n') : String(content ?? '');
        return containsSentPrompt(text, [snippet]);
    }
    return false;
}

/**
 * Order + filter the prompt-matching candidates (already known to contain a
 * sent prompt). Returns the paths this session may bind, best first.
 */
export function rankPromptEvidenceCandidates(
    matching: string[],
    owner: string,
    sessionFloorMs: number,
    firstSnippet: string,
): string[] {
    const spawnBorn = (p: string): number | null => {
        if (!(sessionFloorMs > 0)) return null;
        const born = safeBirthtimeMs(p);
        return born >= sessionFloorMs - SPAWN_BIND_GRACE_MS ? born : null;
    };
    const rows = matching.map((p, order) => ({ p, order, born: spawnBorn(p) }))
        .filter(r => r.born !== null
            || !hasForeignClaimRecord(claimKeyForPath(r.p), owner)
            || firstUserRecordHasPrompt(r.p, firstSnippet));
    rows.sort((a, b) => {
        if (a.born !== null && b.born !== null) return a.born - b.born;
        if (a.born !== null) return -1;
        if (b.born !== null) return 1;
        return a.order - b.order;
    });
    return rows.map(r => r.p);
}
