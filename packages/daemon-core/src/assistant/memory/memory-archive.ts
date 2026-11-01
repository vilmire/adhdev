/**
 * Assistant memory archive tier (docs/design/2026-11-01-assistant-memory.md §2.2).
 *
 * SQLite rows in `mesh-runtime.db` (`assistant_memory_entry`, created by
 * `ensureAssistantMemorySchema`) plus an FTS5 external-content index. This
 * class is pure storage + search: write CHECKS (origin, credentials, content
 * scan, staging) live in `AssistantMemoryStore.apply`, the only write path.
 *
 * Search returns pull-only data. Nothing here is ever injected into the system
 * prompt; the assistant asks via `memory_search`. Stored text is re-scanned on
 * the way out (`scanStoredContent`), so a row planted by hand cannot reach the
 * model.
 */

import { createHash, randomBytes } from 'crypto';
import type { Database as DatabaseHandle } from 'better-sqlite3';
import { scanStoredContent } from '../store-guards.js';
import { normalizeMemoryText } from './memory-content.js';

export type ArchiveScope = 'global' | 'project';
export type ArchiveKind = 'rule' | 'env' | 'preference' | 'lesson';
export const ARCHIVE_KINDS: readonly ArchiveKind[] = ['rule', 'env', 'preference', 'lesson'];

const DAY_MS = 24 * 60 * 60 * 1000;
/** Active rows kept per (scope, project). A leak bound, not a budget the assistant plans around. */
export const ARCHIVE_MAX_ACTIVE_PER_SCOPE = 2000;
/** Soft-deleted rows are removed for good after this long (undo window). */
export const ARCHIVE_GRACE_MS = 30 * DAY_MS;
export const DEFAULT_LESSON_TTL_DAYS = 90;
/** A human entry unused for this long is only SUGGESTED for review, never deleted. */
export const ARCHIVE_UNUSED_SUGGEST_MS = 180 * DAY_MS;
export const SEARCH_RESULT_MAX_CHARS = 2000;
export const SEARCH_QUERY_MAX_CHARS = 200;
export const SEARCH_LIMIT_MAX = 10;
export const SEARCH_LIMIT_DEFAULT = 5;

export interface ArchiveEntry {
    id: string;
    scope: ArchiveScope;
    projectRef: string | null;
    kind: ArchiveKind;
    text: string;
    origin: string;
    createdAt: number;
    updatedAt: number;
    lastHitAt: number | null;
    hitCount: number;
    expiresAt: number | null;
    sourceRef: string | null;
    archivedAt: number | null;
}

interface Row {
    id: string; scope: string; project_ref: string | null; kind: string; text: string; origin: string;
    created_at: number; updated_at: number; last_hit_at: number | null; hit_count: number;
    expires_at: number | null; source_ref: string | null; archived_at: number | null;
}

function toEntry(r: Row): ArchiveEntry {
    return {
        id: r.id, scope: r.scope as ArchiveScope, projectRef: r.project_ref, kind: r.kind as ArchiveKind, text: r.text,
        origin: r.origin, createdAt: r.created_at, updatedAt: r.updated_at, lastHitAt: r.last_hit_at, hitCount: r.hit_count,
        expiresAt: r.expires_at, sourceRef: r.source_ref, archivedAt: r.archived_at,
    };
}

export interface ArchiveAddInput {
    scope: ArchiveScope;
    projectRef?: string | null;
    kind: ArchiveKind;
    text: string;
    origin: string;
    sourceRef?: string | null;
}

export interface SearchOptions {
    scope?: ArchiveScope | 'all';
    projectRef?: string | null;
    limit?: number;
}

export interface SearchHit {
    id: string;
    scope: ArchiveScope;
    projectRef: string | null;
    kind: ArchiveKind;
    text: string;
    updatedAt: number;
    score: number;
}

export interface SearchResult {
    hits: SearchHit[];
    truncated: boolean;
    tokensApprox: number;
}

export type SearchRefusal = { error: 'query_empty' | 'query_too_long' | 'limit_invalid' | 'project_required' };

const HANGUL = /^[가-힣]+$/u;

/**
 * Query → FTS5 MATCH expression. Tokens are `\p{L}\p{N}` runs only, each
 * double-quoted with a prefix star, so FTS syntax characters (`" * : ( ) NEAR
 * OR AND NOT`) in the query can never form operators. Hangul tokens (particles
 * are glued to the stem, and `unicode61` does no morphology) also contribute
 * their stem-shortened prefixes.
 */
export function buildFtsMatch(query: string): string | null {
    const raw = query.match(/[\p{L}\p{N}]+/gu) ?? [];
    const terms = new Set<string>();
    for (const tok of raw.slice(0, 12)) {
        const t = tok.toLowerCase();
        terms.add(t);
        if (HANGUL.test(t)) {
            const cps = Array.from(t);
            if (cps.length >= 3) terms.add(cps.slice(0, cps.length - 1).join(''));
            if (cps.length >= 5) terms.add(cps.slice(0, cps.length - 2).join(''));
        }
    }
    if (!terms.size) return null;
    return [...terms].map((t) => `"${t}"*`).join(' OR ');
}

export class MemoryArchive {
    constructor(
        readonly db: DatabaseHandle,
        private readonly now: () => number = Date.now,
        /** Lesson TTL in ms (review-origin lessons only); read per call so a config change applies. */
        private readonly lessonTtlMs: () => number = () => DEFAULT_LESSON_TTL_DAYS * DAY_MS,
    ) {}

    // ── CRUD ───────────────────────────────────────────────────────────────

    add(input: ArchiveAddInput): { result: 'applied'; entry: ArchiveEntry } | { result: 'memory_duplicate'; existing: ArchiveEntry } | { result: 'memory_budget_exceeded'; used: number; budget: number } {
        const projectRef = input.scope === 'project' ? (input.projectRef ?? '') : null;
        const dup = this.findActiveByText(input.scope, projectRef, input.text);
        if (dup) return { result: 'memory_duplicate', existing: dup };
        const used = this.countActive(input.scope, projectRef);
        if (used >= ARCHIVE_MAX_ACTIVE_PER_SCOPE) return { result: 'memory_budget_exceeded', used, budget: ARCHIVE_MAX_ACTIVE_PER_SCOPE };
        const at = this.now();
        let id = createHash('sha1').update(`${input.scope}|${projectRef ?? ''}|${input.text}`).digest('hex').slice(0, 10);
        if (this.get(id)) id = randomBytes(5).toString('hex'); // a text that was soft-deleted and re-added
        this.db.prepare(`INSERT INTO assistant_memory_entry
            (id, scope, project_ref, kind, text, origin, created_at, updated_at, expires_at, source_ref)
            VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
            id, input.scope, projectRef, input.kind, input.text, input.origin, at, at,
            this.expiryFor(input.kind, input.origin, at), input.sourceRef ?? null,
        );
        return { result: 'applied', entry: this.get(id)! };
    }

    get(id: string): ArchiveEntry | null {
        const r = this.db.prepare('SELECT * FROM assistant_memory_entry WHERE id=?').get(id) as Row | undefined;
        return r ? toEntry(r) : null;
    }

    /** Active entries whose text contains `match` (case-sensitive, like the core tier). */
    findMatches(scope: ArchiveScope, projectRef: string | null, match: string): ArchiveEntry[] {
        return this.active(scope, projectRef).filter((e) => e.text.includes(match));
    }

    findActiveByText(scope: ArchiveScope, projectRef: string | null, text: string): ArchiveEntry | null {
        const norm = normalizeMemoryText(text);
        return this.active(scope, projectRef).find((e) => normalizeMemoryText(e.text) === norm) ?? null;
    }

    /** Keeps `id`, `created_at` and provenance; only text/kind/updated change. */
    replaceText(id: string, text: string, kind?: ArchiveKind): void {
        const at = this.now();
        this.db.prepare('UPDATE assistant_memory_entry SET text=?, kind=COALESCE(?, kind), updated_at=? WHERE id=?').run(text, kind ?? null, at, id);
    }

    archive(id: string): boolean {
        return this.db.prepare('UPDATE assistant_memory_entry SET archived_at=? WHERE id=? AND archived_at IS NULL').run(this.now(), id).changes > 0;
    }

    restore(id: string): boolean {
        const e = this.get(id);
        if (!e || e.archivedAt === null) return false;
        const same = this.findActiveByText(e.scope, e.projectRef, e.text);
        if (same) return false;
        return this.db.prepare('UPDATE assistant_memory_entry SET archived_at=NULL, updated_at=? WHERE id=?').run(this.now(), id).changes > 0;
    }

    /** Hard delete (undo of an add that must leave no row, and the grace sweep). */
    purge(id: string): boolean {
        return this.db.prepare('DELETE FROM assistant_memory_entry WHERE id=?').run(id).changes > 0;
    }

    active(scope?: ArchiveScope, projectRef?: string | null): ArchiveEntry[] {
        let sql = 'SELECT * FROM assistant_memory_entry WHERE archived_at IS NULL';
        const args: unknown[] = [];
        if (scope) { sql += ' AND scope=?'; args.push(scope); }
        if (scope === 'project') { sql += ' AND project_ref=?'; args.push(projectRef ?? ''); }
        sql += ' ORDER BY seq';
        return (this.db.prepare(sql).all(...args) as Row[]).map(toEntry);
    }

    bySourceRef(sourceRef: string, opts: { activeOnly?: boolean } = {}): ArchiveEntry[] {
        const rows = this.db.prepare(`SELECT * FROM assistant_memory_entry WHERE source_ref=?${opts.activeOnly ? ' AND archived_at IS NULL' : ''} ORDER BY seq`).all(sourceRef) as Row[];
        return rows.map(toEntry);
    }

    countActive(scope: ArchiveScope, projectRef: string | null): number {
        const r = scope === 'project'
            ? this.db.prepare('SELECT COUNT(*) AS n FROM assistant_memory_entry WHERE archived_at IS NULL AND scope=? AND project_ref=?').get(scope, projectRef ?? '')
            : this.db.prepare('SELECT COUNT(*) AS n FROM assistant_memory_entry WHERE archived_at IS NULL AND scope=?').get(scope);
        return Number((r as { n: number }).n);
    }

    /** Active project-scope entry counts by project ref (counts only; the assistant learns a project has memory). */
    projectCounts(): Map<string, number> {
        const rows = this.db.prepare("SELECT project_ref AS p, COUNT(*) AS n FROM assistant_memory_entry WHERE archived_at IS NULL AND scope='project' GROUP BY project_ref").all() as Array<{ p: string; n: number }>;
        return new Map(rows.map((r) => [r.p, Number(r.n)]));
    }

    /** Project removed/detached: soft-delete its entries. Returns the ids. */
    archiveProject(projectRef: string): string[] {
        const ids = (this.db.prepare("SELECT id FROM assistant_memory_entry WHERE scope='project' AND project_ref=? AND archived_at IS NULL").all(projectRef) as Array<{ id: string }>).map((r) => r.id);
        if (ids.length) this.db.prepare("UPDATE assistant_memory_entry SET archived_at=? WHERE scope='project' AND project_ref=? AND archived_at IS NULL").run(this.now(), projectRef);
        return ids;
    }

    /** Soft-delete entries of projects no longer in `liveProjectRefs`. */
    archiveOrphanProjects(liveProjectRefs: ReadonlySet<string>): string[] {
        const out: string[] = [];
        for (const ref of this.projectCounts().keys()) if (!liveProjectRefs.has(ref)) out.push(...this.archiveProject(ref));
        return out;
    }

    // ── search ─────────────────────────────────────────────────────────────

    search(query: string, opts: SearchOptions = {}): SearchResult | SearchRefusal {
        if (typeof query !== 'string' || !query.trim()) return { error: 'query_empty' };
        if (Array.from(query).length > SEARCH_QUERY_MAX_CHARS) return { error: 'query_too_long' };
        const limit = opts.limit ?? SEARCH_LIMIT_DEFAULT;
        if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX) return { error: 'limit_invalid' };
        const scope = opts.scope ?? 'all';
        if (scope === 'project' && !opts.projectRef) return { error: 'project_required' };
        const match = buildFtsMatch(query);
        if (!match) return { hits: [], truncated: false, tokensApprox: 0 };

        let filter = '';
        const args: unknown[] = [match];
        if (scope === 'global') filter = " AND e.scope='global'";
        else if (scope === 'project') { filter = " AND e.scope='project' AND e.project_ref=?"; args.push(opts.projectRef); }
        else if (opts.projectRef) { filter = " AND (e.scope='global' OR (e.scope='project' AND e.project_ref=?))"; args.push(opts.projectRef); }
        // Over-fetch: rows the read-time re-scan drops must not shrink the page.
        args.push(limit * 3 + 1);
        const rows = this.db.prepare(`
            SELECT e.*, bm25(assistant_memory_fts) AS score
            FROM assistant_memory_fts JOIN assistant_memory_entry e ON e.seq = assistant_memory_fts.rowid
            WHERE assistant_memory_fts MATCH ? AND e.archived_at IS NULL${filter}
            ORDER BY score, e.seq LIMIT ?`).all(...args) as Array<Row & { score: number }>;

        const hits: SearchHit[] = [];
        let chars = 0;
        let truncated = false;
        for (const r of rows) {
            if (scanStoredContent(r.text)) continue; // injection/credential planted outside the write path
            const len = Array.from(r.text).length;
            if (hits.length >= limit || chars + len > SEARCH_RESULT_MAX_CHARS) { truncated = true; break; }
            chars += len;
            hits.push({ id: r.id, scope: r.scope as ArchiveScope, projectRef: r.project_ref, kind: r.kind as ArchiveKind, text: r.text, updatedAt: r.updated_at, score: Math.round(r.score * 1000) / 1000 });
        }
        this.touch(hits.map((h) => h.id));
        return { hits, truncated, tokensApprox: Math.ceil(chars / 3) };
    }

    /** A search hit: feeds the "unused" suggestion and restarts a lesson's TTL. */
    touch(ids: readonly string[]): void {
        if (!ids.length) return;
        const at = this.now();
        const upd = this.db.prepare('UPDATE assistant_memory_entry SET last_hit_at=?, hit_count=hit_count+1, expires_at=CASE WHEN expires_at IS NULL THEN NULL ELSE ? END WHERE id=?');
        const ttl = this.lessonTtlMs();
        this.db.transaction(() => { for (const id of ids) upd.run(at, at + ttl, id); })();
    }

    // ── expiry (§3.10) ─────────────────────────────────────────────────────

    private expiryFor(kind: ArchiveKind, origin: string, at: number): number | null {
        return kind === 'lesson' && isReviewOriginName(origin) ? at + this.lessonTtlMs() : null;
    }

    /**
     * Review-origin lessons whose TTL ran out (no search hit and no write since
     * `ttl` ago). ONLY lessons written by a review turn can appear here: human,
     * owner, promotion and every non-lesson row are never returned, however
     * much time passes. The caller soft-deletes them through the journaled write
     * path so the owner can undo within the grace period.
     */
    staleLessons(now: number = this.now()): ArchiveEntry[] {
        const rows = this.db.prepare(`SELECT * FROM assistant_memory_entry
            WHERE archived_at IS NULL AND kind='lesson' AND origin IN ('review','review_tainted')
              AND COALESCE(last_hit_at, created_at) < ? ORDER BY seq`).all(now - this.lessonTtlMs()) as Row[];
        return rows.map(toEntry);
    }

    /** Remove soft-deleted rows whose undo window (30 days) has passed. Returns the count. */
    purgeGrace(now: number = this.now()): number {
        return this.db.prepare('DELETE FROM assistant_memory_entry WHERE archived_at IS NOT NULL AND archived_at < ?').run(now - ARCHIVE_GRACE_MS).changes;
    }

    /** Human-origin entries nobody searched for 180 days: suggestions only, never auto-deleted. */
    unusedSuggestions(now: number = this.now(), limit = 20): ArchiveEntry[] {
        const rows = this.db.prepare(`SELECT * FROM assistant_memory_entry
            WHERE archived_at IS NULL AND hit_count=0 AND origin NOT IN ('review','review_tainted') AND created_at < ?
            ORDER BY created_at LIMIT ?`).all(now - ARCHIVE_UNUSED_SUGGEST_MS, limit) as Row[];
        return rows.map(toEntry);
    }

    // ── metrics (§3 M-mem-*) ───────────────────────────────────────────────

    bump(metric: string, n: number = 1): void {
        const d = new Date(this.now());
        const p = (x: number) => String(x).padStart(2, '0');
        const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        this.db.prepare('INSERT INTO assistant_memory_metric(day, metric, n) VALUES (?,?,?) ON CONFLICT(day, metric) DO UPDATE SET n = n + excluded.n').run(day, metric, n);
    }

    metrics(sinceDay?: string): Array<{ day: string; metric: string; n: number }> {
        const rows = (sinceDay
            ? this.db.prepare('SELECT day, metric, n FROM assistant_memory_metric WHERE day >= ? ORDER BY day, metric').all(sinceDay)
            : this.db.prepare('SELECT day, metric, n FROM assistant_memory_metric ORDER BY day, metric').all()) as Array<{ day: string; metric: string; n: number }>;
        return rows.map((r) => ({ day: r.day, metric: r.metric, n: Number(r.n) }));
    }
}

function isReviewOriginName(origin: string): boolean {
    return origin === 'review' || origin === 'review_tainted';
}
