/**
 * SQLite adapter for the recurring-procedure signals / candidates
 * (design 2026-11-01-procedure-skills.md §4.5, §5.3–5.4). The pure rules live
 * in `procedure-signals.ts`. Local rows only — see the schema module.
 */

import type { Database as DatabaseHandle } from 'better-sqlite3';
import {
    PROCEDURE_RULES, clusterIdOf, clusterSignals, clusterStats, meetsCandidateRules, prepareSignal, sameProcedure,
    type ProcedureSignalSource, type SignalRow,
} from './procedure-signals.js';
import { SKILL_COVERED_THRESHOLD, matchSkills, type MatchableSkill } from './skills/skill-match.js';

export type CandidateState = 'open' | 'proposed' | 'saved' | 'dismissed' | 'covered';

export interface ProcedureCandidate {
    clusterId: string;
    firstAt: number;
    lastAt: number;
    signalCount: number;
    distinctDays: number;
    excerpt: string;
    keywords: string[];
    simhash: string;
    state: CandidateState;
    stagedId: string | null;
    dismissedUntil: number;
}

/** Proposal evidence for the dashboard card ("M similar requests in the last N days"). */
export interface ProposalEvidence {
    stagedId: string;
    candidateId: string;
    signalCount: number;
    distinctDays: number;
    spanDays: number;
    excerpt: string;
}

/** What the store verbs and the runtime see (the runtime installs the SQLite-backed one). */
export interface ProcedureSignalPort {
    /** Record one owner request / project_send. Returns false when it was dropped (noise, credential, duplicate turn). */
    record(input: { text: string; source: ProcedureSignalSource; meshId: string; turnKey: string; attached?: readonly string[]; at?: number }): boolean;
    reviewCandidates(now: number, skills: readonly MatchableSkill[]): ProcedureCandidate[];
    isOpenCandidate(clusterId: string): boolean;
    markProposed(clusterId: string, stagedId: string, now: number): boolean;
    settleStaged(stagedId: string, how: 'applied' | 'discarded' | 'expired', now: number): { clusterId: string; outcome: 'saved' | 'dismissed' } | null;
    evidenceFor(stagedIds: readonly string[]): ProposalEvidence[];
    /** Candidate rows by state (diagnostics / owner list). */
    candidateCounts?(): Record<string, number>;
}

const DAY = 24 * 60 * 60_000;

interface CandidateRow {
    cluster_id: string; first_at: number; last_at: number; signal_count: number; distinct_days: number;
    representative_excerpt: string; keywords_json: string; simhash: string; state: string; staged_id: string | null;
    dismissed_until: number;
}

const toCandidate = (r: CandidateRow): ProcedureCandidate => ({
    clusterId: r.cluster_id, firstAt: r.first_at, lastAt: r.last_at, signalCount: r.signal_count, distinctDays: r.distinct_days,
    excerpt: r.representative_excerpt, keywords: safeJson<string[]>(r.keywords_json, []), simhash: r.simhash,
    state: r.state as CandidateState, stagedId: r.staged_id, dismissedUntil: r.dismissed_until,
});

function safeJson<T>(s: string, fallback: T): T {
    try { return JSON.parse(s) as T; } catch { return fallback; }
}

export class ProcedureSignalStore implements ProcedureSignalPort {
    constructor(private readonly db: DatabaseHandle, private readonly clock: () => number = Date.now) {}

    record(input: { text: string; source: ProcedureSignalSource; meshId: string; turnKey: string; attached?: readonly string[]; at?: number }): boolean {
        const prepared = prepareSignal(input.text);
        if (!prepared) return false;
        const at = input.at ?? this.clock();
        if (input.turnKey) {
            const dup = this.db.prepare('SELECT 1 FROM assistant_procedure_signals WHERE turn_key = ? AND source = ? AND mesh_id = ? AND simhash = ?')
                .get(input.turnKey, input.source, input.meshId, prepared.simhash);
            if (dup) return false;
        }
        this.db.prepare(`
            INSERT INTO assistant_procedure_signals (at_ms, mesh_id, source, turn_key, keywords_json, simhash, excerpt, attached_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(at, input.meshId, input.source, input.turnKey, JSON.stringify(prepared.keywords), prepared.simhash, prepared.excerpt, JSON.stringify([...(input.attached ?? [])]));
        return true;
    }

    private signals(now: number): SignalRow[] {
        const rows = this.db.prepare('SELECT * FROM assistant_procedure_signals WHERE at_ms >= ? ORDER BY at_ms, id')
            .all(now - PROCEDURE_RULES.signalRetentionMs) as Array<Record<string, unknown>>;
        return rows.map((r) => ({
            id: Number(r.id), atMs: Number(r.at_ms), meshId: String(r.mesh_id ?? ''), source: String(r.source) as ProcedureSignalSource,
            turnKey: String(r.turn_key ?? ''), simhash: String(r.simhash), keywords: safeJson<string[]>(String(r.keywords_json), []),
            excerpt: String(r.excerpt ?? ''), attached: safeJson<string[]>(String(r.attached_json), []),
        }));
    }

    private allCandidates(): ProcedureCandidate[] {
        return (this.db.prepare('SELECT * FROM assistant_procedure_candidates').all() as CandidateRow[]).map(toCandidate);
    }

    /**
     * Re-cluster the retained signals and upsert candidates. A cluster that
     * meets the rules becomes `open`, or `covered` when an existing skill
     * already matches it; an existing row keeps its terminal state (`saved`,
     * `proposed`, a running `dismissed` snooze). Returns every candidate row.
     */
    evaluate(now: number, skills: readonly MatchableSkill[]): ProcedureCandidate[] {
        const existing = this.allCandidates();
        const upsert = this.db.prepare(`
            INSERT INTO assistant_procedure_candidates
                (cluster_id, first_at, last_at, signal_count, distinct_days, representative_excerpt, keywords_json, simhash, state, staged_id, dismissed_until, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(cluster_id) DO UPDATE SET first_at = excluded.first_at, last_at = excluded.last_at,
                signal_count = excluded.signal_count, distinct_days = excluded.distinct_days,
                representative_excerpt = excluded.representative_excerpt, keywords_json = excluded.keywords_json,
                simhash = excluded.simhash, state = excluded.state, staged_id = excluded.staged_id,
                dismissed_until = excluded.dismissed_until, updated_at = excluded.updated_at
        `);
        this.db.transaction(() => {
            for (const cluster of clusterSignals(this.signals(now))) {
                const st = clusterStats(cluster);
                const row = existing.find((e) => e.clusterId === clusterIdOf(cluster.rep))
                    ?? existing.find((e) => sameProcedure(e, cluster.rep));
                const eligible = meetsCandidateRules(st);
                const terminal = row && (row.state === 'saved' || row.state === 'proposed' || (row.state === 'dismissed' && row.dismissedUntil > now));
                if (!eligible && !terminal) {
                    // Signals aged out of the retention window: a stale open / covered row goes with them.
                    if (row) this.db.prepare('DELETE FROM assistant_procedure_candidates WHERE cluster_id = ?').run(row.clusterId);
                    continue;
                }
                const covered = matchSkills(`${cluster.rep.excerpt} ${cluster.rep.keywords.join(' ')}`, skills)[0]?.score ?? 0;
                const state: CandidateState = terminal ? row!.state
                    : st.attached || covered >= SKILL_COVERED_THRESHOLD ? 'covered' : 'open';
                const id = row?.clusterId ?? clusterIdOf(cluster.rep);
                upsert.run(id, st.firstAt, st.lastAt, st.count, st.distinctDays, row?.excerpt || cluster.rep.excerpt,
                    JSON.stringify(row?.keywords.length ? row.keywords : cluster.rep.keywords), row?.simhash || cluster.rep.simhash,
                    state, state === 'proposed' ? row?.stagedId ?? null : null, state === 'dismissed' ? row?.dismissedUntil ?? 0 : 0, now);
            }
        })();
        return this.allCandidates();
    }

    reviewCandidates(now: number, skills: readonly MatchableSkill[]): ProcedureCandidate[] {
        return this.evaluate(now, skills)
            .filter((c) => c.state === 'open')
            .sort((a, b) => b.signalCount - a.signalCount || b.lastAt - a.lastAt || a.clusterId.localeCompare(b.clusterId))
            .slice(0, PROCEDURE_RULES.maxPerReview);
    }

    isOpenCandidate(clusterId: string): boolean {
        const r = this.db.prepare('SELECT state FROM assistant_procedure_candidates WHERE cluster_id = ?').get(clusterId) as { state?: string } | undefined;
        return r?.state === 'open';
    }

    markProposed(clusterId: string, stagedId: string, now: number): boolean {
        return this.db.prepare("UPDATE assistant_procedure_candidates SET state = 'proposed', staged_id = ?, updated_at = ? WHERE cluster_id = ? AND state = 'open'")
            .run(stagedId, now, clusterId).changes > 0;
    }

    settleStaged(stagedId: string, how: 'applied' | 'discarded' | 'expired', now: number): { clusterId: string; outcome: 'saved' | 'dismissed' } | null {
        const r = this.db.prepare("SELECT cluster_id FROM assistant_procedure_candidates WHERE staged_id = ? AND state = 'proposed'").get(stagedId) as { cluster_id?: string } | undefined;
        if (!r?.cluster_id) return null;
        if (how === 'applied') {
            this.db.prepare("UPDATE assistant_procedure_candidates SET state = 'saved', updated_at = ? WHERE cluster_id = ?").run(now, r.cluster_id);
            return { clusterId: r.cluster_id, outcome: 'saved' };
        }
        // Discard = "no, do not ask again" (90 days); an unanswered proposal that expired only snoozes 30 days.
        const until = now + (how === 'discarded' ? PROCEDURE_RULES.dismissMs : PROCEDURE_RULES.expiredDismissMs);
        this.db.prepare("UPDATE assistant_procedure_candidates SET state = 'dismissed', dismissed_until = ?, updated_at = ? WHERE cluster_id = ?").run(until, now, r.cluster_id);
        return { clusterId: r.cluster_id, outcome: 'dismissed' };
    }

    evidenceFor(stagedIds: readonly string[]): ProposalEvidence[] {
        const out: ProposalEvidence[] = [];
        for (const id of stagedIds) {
            const r = this.db.prepare("SELECT * FROM assistant_procedure_candidates WHERE staged_id = ? AND state = 'proposed'").get(id) as CandidateRow | undefined;
            if (!r) continue;
            out.push({
                stagedId: id, candidateId: r.cluster_id, signalCount: r.signal_count, distinctDays: r.distinct_days,
                spanDays: Math.max(1, Math.ceil((r.last_at - r.first_at) / DAY)), excerpt: r.representative_excerpt,
            });
        }
        return out;
    }

    /** Signals older than 30 days; `dismissed` candidates after their snooze, every other candidate 30 days after its last update. */
    prune(now: number): void {
        this.db.prepare('DELETE FROM assistant_procedure_signals WHERE at_ms < ?').run(now - PROCEDURE_RULES.signalRetentionMs);
        this.db.prepare("DELETE FROM assistant_procedure_candidates WHERE (state = 'dismissed' AND dismissed_until < ?) OR (state != 'dismissed' AND updated_at < ?)")
            .run(now, now - PROCEDURE_RULES.signalRetentionMs);
    }

    candidateCounts(): Record<string, number> {
        const out: Record<string, number> = {};
        for (const r of this.db.prepare('SELECT state, COUNT(*) AS n FROM assistant_procedure_candidates GROUP BY state').all() as Array<{ state: string; n: number }>) out[r.state] = r.n;
        return out;
    }

    /** Test / diagnostic view. */
    candidates(): ProcedureCandidate[] {
        return this.allCandidates();
    }
}
