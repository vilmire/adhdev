/**
 * Provider-neutral core of post-restart transcript recovery.
 *
 * After a daemon restart the in-memory evidence that maps a live CLI session to
 * its provider-native transcript (sent-prompt registry, spawn time floor) is
 * gone. The per-instance saved history (config history dir) survives and holds
 * the exact user inputs the instance sent. A provider-specific `find` supplies
 * the transcripts whose FIRST user message equals the instance's first persisted
 * input (and whose workspace / time window fit); this core then enforces the
 * provider-independent safety rules:
 *   - exactly one transcript qualifies,
 *   - no other live session holds it (claim registry),
 *   - no sibling instance of the same provider persisted the same first input,
 *   - it can be claimed for this owner.
 * Anything else fails closed (null). The exact persisted pin is always tried
 * before this path (it is resolved upstream as the requested session id).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getHistoryDir, listHistoryFiles } from '../../config/chat-history-files.js';
import { LOG } from '../../logging/logger.js';
import { claimTranscript, isTranscriptClaimedByOther } from '../native-history/transcript-claim-registry.js';
import { recordSentPrompt } from '../native-history/sent-prompt-registry.js';

const NEGATIVE_CACHE_MS = 15_000;
const MAX_INPUTS = 20;

const recovered = new Map<string, string>();
const negative = new Map<string, number>();

export function __resetRestartRecoveryForTest(): void { recovered.clear(); negative.clear(); }

export const normInput = (t: string): string => t.replace(/\s+/g, ' ').trim();

export interface PersistedInput { text: string; at: number }

export function readPersistedUserInputs(agentType: string, instanceId: string): PersistedInput[] {
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
            if (at > 0 && normInput(r.content).length >= 8) out.push({ text: normInput(r.content), at });
        }
    }
    return out.sort((a, b) => a.at - b.at);
}

/** True when another instance of this provider persisted the same first input. */
export function siblingPersistedSameInput(agentType: string, instanceId: string, text: string, sinceMs: number): boolean {
    const dir = path.join(getHistoryDir(), agentType.replace(/[^a-zA-Z0-9_-]/g, '_'));
    let files: string[];
    try { files = listHistoryFiles(dir); } catch { return false; }
    const needle = JSON.stringify(text.slice(0, 200)).slice(1, -1).slice(0, 120);
    for (const f of files) {
        if (f.startsWith(`${instanceId}_`)) continue;
        try { if (fs.statSync(path.join(dir, f)).mtimeMs < sinceMs) continue; } catch { continue; }
        let raw = '';
        try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
        if (!raw.includes(needle)) continue;
        for (const line of raw.split('\n')) {
            if (!line) continue;
            try {
                const r = JSON.parse(line);
                if (r?.role === 'user' && typeof r.content === 'string' && normInput(r.content) === text) return true;
            } catch { /* skip */ }
        }
    }
    return false;
}

export interface RecoveryMatch { id: string; claimKey: string }

export interface RecoverUniqueOptions {
    provider: string;
    instanceId: string;
    owner: string;
    workspace: string;
    /** Transcripts whose first user message equals `first.text` and that fit the workspace/time rules. */
    find: (first: PersistedInput) => RecoveryMatch[];
    /** Re-validates a previously recovered id (default: always valid). */
    stillValid?: (id: string) => boolean;
}

export function recoverUnique(o: RecoverUniqueOptions): string | null {
    if (!o.instanceId || !o.owner || !o.workspace) return null;
    const cacheKey = `${o.provider}\u0000${o.owner}`;
    const known = recovered.get(cacheKey);
    if (known && (o.stillValid ? o.stillValid(known) : true)) return known;
    const now = Date.now();
    if ((negative.get(cacheKey) ?? 0) > now) return null;
    const miss = (): null => { negative.set(cacheKey, now + NEGATIVE_CACHE_MS); return null; };

    const inputs = readPersistedUserInputs(o.provider, o.instanceId);
    if (inputs.length === 0) return miss();
    const first = inputs[0];
    const matches = o.find(first);
    if (matches.length !== 1) {
        if (matches.length > 1) LOG.info('TranscriptClaim', `decision=ambiguous provider=${o.provider} owner=${o.owner} candidates=${matches.length} → recovery refused`);
        return miss();
    }
    const m = matches[0];
    if (isTranscriptClaimedByOther(m.claimKey, o.owner)) return miss();
    if (siblingPersistedSameInput(o.provider, o.instanceId, first.text, first.at - 60_000)) return miss();
    if (claimTranscript(m.claimKey, o.owner) === 'denied') return miss();

    // Re-arm the in-memory ownership evidence so the standard confirmation
    // (exclusive whole input) holds for this and later reads.
    for (const i of inputs.slice(-MAX_INPUTS)) recordSentPrompt(o.instanceId, i.text);
    recovered.set(cacheKey, m.id);
    LOG.info('TranscriptClaim', `decision=recovered provider=${o.provider} owner=${o.owner} key=${m.id} (persisted input evidence)`);
    return m.id;
}
