/**
 * Recurring-procedure detection — the pure part (design
 * 2026-11-01-procedure-skills.md §4.5, §5). No I/O, no LLM: a signal is a
 * normalised keyword set plus a simhash of one owner request; signals that are
 * close (Hamming ≤ 8 AND Jaccard ≥ 0.5) form a cluster; a cluster with enough
 * distinct turns over enough distinct days and no skill attached is a
 * candidate. The thresholds are chosen values, not measurements — the
 * proposal acceptance rate (M-S2) is the first calibration evidence.
 *
 * The data never leaves this machine: rows hold a 120-char excerpt of the
 * owner's own request and are never part of the status path (server content
 * boundary, CLAUDE.md).
 */

import { detectCredential, scanWriteContent } from './store-guards.js';
import { hammingDistance, jaccard, keywordsOf, simhash64, tokenize } from './skills/skill-text.js';

export const PROCEDURE_RULES = {
    /** Two signals are the same procedure at or under this simhash distance… */
    hammingMax: 8,
    /** …and at or over this keyword Jaccard. */
    jaccardMin: 0.5,
    /** A request with fewer distinct keywords is noise ("ok", "continue"). */
    minKeywords: 3,
    keywordsMax: 12,
    excerptChars: 120,
    /** Distinct turns / distinct local days a cluster needs before it is a candidate. */
    minSignals: 3,
    minDistinctDays: 2,
    /** Candidates handed to one review turn. */
    maxPerReview: 2,
    signalRetentionMs: 30 * 24 * 60 * 60_000,
    /** "No, don't ask again" snooze, and the snooze after an unanswered proposal expired. */
    dismissMs: 90 * 24 * 60 * 60_000,
    expiredDismissMs: 30 * 24 * 60 * 60_000,
} as const;

export type ProcedureSignalSource = 'project_send' | 'owner_input';

export interface PreparedSignal {
    keywords: string[];
    simhash: string;
    excerpt: string;
}

/**
 * Normalise one request into a signal, or null when it must not be recorded:
 * empty / too short to be a procedure, or the text matches a credential,
 * hidden-character or injection pattern (the whole signal is dropped, not just
 * the excerpt).
 */
export function prepareSignal(text: string): PreparedSignal | null {
    if (typeof text !== 'string' || !text.trim()) return null;
    if (detectCredential(text) || scanWriteContent(text)) return null;
    const keywords = keywordsOf(text, PROCEDURE_RULES.keywordsMax);
    if (keywords.length < PROCEDURE_RULES.minKeywords) return null;
    const excerpt = Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, PROCEDURE_RULES.excerptChars).join('');
    return { keywords, simhash: simhash64(tokenize(text)), excerpt };
}

export interface SignalLike {
    simhash: string;
    keywords: readonly string[];
}

export function sameProcedure(a: SignalLike, b: SignalLike): boolean {
    return hammingDistance(a.simhash, b.simhash) <= PROCEDURE_RULES.hammingMax && jaccard(a.keywords, b.keywords) >= PROCEDURE_RULES.jaccardMin;
}

export interface SignalRow extends SignalLike {
    id: number;
    atMs: number;
    meshId: string;
    source: ProcedureSignalSource;
    /** `<session>:<turn>` or the dashboard message id — signals of one turn count once. */
    turnKey: string;
    excerpt: string;
    attached: string[];
}

export interface SignalCluster {
    /** Earliest signal: the cluster's representative. */
    rep: SignalRow;
    signals: SignalRow[];
}

/** Greedy clustering in time order against each cluster's representative (deterministic). */
export function clusterSignals(rows: readonly SignalRow[]): SignalCluster[] {
    const ordered = [...rows].sort((a, b) => a.atMs - b.atMs || a.id - b.id);
    const clusters: SignalCluster[] = [];
    for (const row of ordered) {
        const hit = clusters.find((c) => sameProcedure(c.rep, row));
        if (hit) hit.signals.push(row);
        else clusters.push({ rep: row, signals: [row] });
    }
    return clusters;
}

/** Local calendar day, like the metric days (the owner's days). */
export function localDay(at: number): string {
    const d = new Date(at);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface ClusterStats {
    /** Distinct turns. */
    count: number;
    distinctDays: number;
    firstAt: number;
    lastAt: number;
    /** Some signal of the cluster already had a skill attached. */
    attached: boolean;
}

export function clusterStats(c: SignalCluster): ClusterStats {
    const turns = new Set(c.signals.map((s) => s.turnKey || `id:${s.id}`));
    return {
        count: turns.size,
        distinctDays: new Set(c.signals.map((s) => localDay(s.atMs))).size,
        firstAt: Math.min(...c.signals.map((s) => s.atMs)),
        lastAt: Math.max(...c.signals.map((s) => s.atMs)),
        attached: c.signals.some((s) => s.attached.length > 0),
    };
}

export function meetsCandidateRules(st: ClusterStats): boolean {
    return st.count >= PROCEDURE_RULES.minSignals && st.distinctDays >= PROCEDURE_RULES.minDistinctDays && !st.attached;
}

/** Stable cluster id from the representative's simhash. */
export function clusterIdOf(rep: SignalLike): string {
    return `pc-${rep.simhash.slice(0, 12)}`;
}
