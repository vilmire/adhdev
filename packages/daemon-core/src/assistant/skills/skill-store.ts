/**
 * Assistant skill store — `skill_view`, `skill_manage` (create / patch /
 * archive) with the self-patch caps, owner admin operations and staged
 * (owner-approval) skill writes.
 *
 * Design: docs/design/2026-10-07-assistant-layer.md §4.10.4–4.10.6.
 *
 *  - Files: <configDir>/assistant/skills/<name>/…, state in skills/.state.json,
 *    journal in skills/.journal.jsonl, staged writes next to the memory ones in
 *    assistant/staged/ (`kind: 'skill'`). All writes 0600 tmp+rename.
 *  - Write checks: name/format → caps (agent only) → match → size limits →
 *    credential → staging. Any failure means nothing is written. Limits are
 *    refusals; nothing is ever truncated.
 *  - "agent" writes are every non-owner StoreWriteOrigin (human/relay/review):
 *    the caps count them; a relay origin, or a patch on an owner/imported
 *    skill, is staged. `owner` writes (dashboard, import, staged resolve)
 *    skip caps and staging but not format/limit/credential checks.
 *  - Synchronous I/O, so one store is serialized within the daemon process.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { getConfigDir } from '../../config/config.js';
import { detectCredential, mustStage, writeFileAtomic600, type StoreWriteOrigin } from '../store-guards.js';
import { charCount } from '../memory/memory-store.js';
import {
    checkSkillLimits, composeSkillMd, isValidSkillName, normalizeSkillFilePath, readSkillDir, SKILL_FILE, SKILL_LIMITS, type SkillDirRead, type SkillLimitReason,
    type SkillOrigin, type SkillStatus,
} from './skill-format.js';
import {
    bumpCounter, needsReview, newSkillState, readSkillStateFile, turnKey, writeSkillStateFile, SKILL_PATCH_CAPS,
    type SkillState, type SkillStateFile,
} from './skill-state.js';
import { prepareCreate, preparePatch, type PreparedWrite } from './skill-write-prep.js';
import { SkillJournal, SkillStaging, type SkillJournalRecord, type StagedSkillWrite } from './skill-journal.js';

export type SkillManageOp =
    | { action: 'create'; name: string; description: string; body: string; project?: string; files?: Record<string, string> }
    /** Exactly one form: `old`+`new` (body, or `file`), `file`+`new` (add file), or `description`. */
    | { action: 'patch'; name: string; old?: string; new?: string; file?: string; description?: string }
    | { action: 'archive'; name: string };

/** Caller-supplied identity of the assistant session / turn making the write (caps key). */
export interface SkillCallContext {
    sessionId: string;
    turnId: string;
}

export type SkillInvalidReason = 'bad_description' | 'empty_body' | 'bad_file_path' | 'bad_patch' | 'missing_context' | 'unparseable_skill_md';

export type SkillRefusal =
    | { result: 'skill_invalid_name' }
    | { result: 'skill_invalid_format'; reason: SkillInvalidReason }
    | { result: 'skill_exists' }
    | { result: 'skill_not_found' }
    | { result: 'skill_file_not_found' }
    | { result: 'skill_file_exists' }
    | { result: 'skill_archived' }
    | { result: 'skill_no_match' }
    | { result: 'skill_ambiguous'; count: number }
    | { result: 'skill_too_large'; reason: SkillLimitReason; actual: number; limit: number; path?: string }
    | { result: 'skill_limit'; live: number; limit: number }
    | { result: 'skill_patch_limit'; scope: 'session' | 'turn'; limit: number }
    | { result: 'skill_needs_review' }
    | { result: 'skill_secret_rejected' }
    | { result: 'skill_store_unreadable' };

export type SkillManageResult =
    | { result: 'applied' }
    | { result: 'staged'; stagedId: string; reason: 'origin' | 'protected_skill' }
    | SkillRefusal;

export interface SkillSummary {
    name: string;
    description: string;
    project?: string;
    status: SkillStatus;
    pinned: boolean;
    origin: SkillOrigin;
    createdAt: string;
    viewCount: number;
    lastViewedAt: string | null;
    patchesSinceReview: number;
    needsReview: boolean;
    /** SKILL.md problem; such skills are left out of the index. */
    problem?: string;
}

export type SkillViewResult =
    | { result: 'list'; skills: SkillSummary[] }
    | {
          result: 'ok'; name: string; description: string; project?: string; origin: SkillOrigin; status: SkillStatus;
          needsReview: boolean; body: string; files: string[]; file?: { path: string; content: string };
      }
    | Extract<SkillRefusal, { result: 'skill_invalid_name' | 'skill_not_found' | 'skill_file_not_found' | 'skill_invalid_format' }>;

export type SkillAdminResult = { result: 'applied' } | { result: 'skill_not_found' } | { result: 'skill_store_unreadable' };

export interface SkillImportInput {
    name: string;
    frontmatterRaw: string;
    body: string;
    files: Array<{ path: string; content: string }>;
    /** Hermes counters — journaled only, never copied into .state.json. */
    sourceUsage?: Record<string, unknown>;
}

export interface AssistantSkillStoreOptions {
    configDir?: string;
    now?: () => Date;
}


export class AssistantSkillStore {
    readonly skillsDir: string;
    readonly stagedDir: string;
    readonly journal: SkillJournal;
    private readonly staging: SkillStaging;
    private readonly now: () => Date;

    constructor(opts: AssistantSkillStoreOptions = {}) {
        const assistantDir = join(opts.configDir ?? getConfigDir(), 'assistant');
        this.skillsDir = join(assistantDir, 'skills');
        this.stagedDir = join(assistantDir, 'staged');
        this.now = opts.now ?? (() => new Date());
        this.journal = new SkillJournal(join(this.skillsDir, '.journal.jsonl'), this.now);
        this.staging = new SkillStaging(this.stagedDir, this.now);
    }

    get statePath(): string {
        return join(this.skillsDir, '.state.json');
    }

    skillDir(name: string): string {
        return join(this.skillsDir, name);
    }

    // ── read ────────────────────────────────────────────────────────────────

    private loadState(): { file: SkillStateFile; corrupt?: string } {
        return readSkillStateFile(this.statePath, this.now().toISOString());
    }

    private stateFor(file: SkillStateFile, name: string): SkillState {
        const s = file.skills[name];
        if (s) return s;
        let created = this.now().toISOString();
        try { created = statSync(join(this.skillDir(name), SKILL_FILE)).mtime.toISOString(); } catch { /* keep now */ }
        return newSkillState('owner', created); // hand-made directory
    }

    private readDir(name: string): SkillDirRead | null {
        return isValidSkillName(name) ? readSkillDir(this.skillDir(name), name) : null;
    }

    private skillNames(): string[] {
        if (!existsSync(this.skillsDir)) return [];
        return readdirSync(this.skillsDir).filter((n) => isValidSkillName(n) && existsSync(join(this.skillDir(n), SKILL_FILE))).sort();
    }

    list(): SkillSummary[] {
        const { file } = this.loadState();
        const out: SkillSummary[] = [];
        for (const name of this.skillNames()) {
            const d = this.readDir(name);
            if (!d) continue;
            const s = this.stateFor(file, name);
            out.push({
                name, description: d.description, project: d.project, status: s.status, pinned: s.pinned, origin: s.origin,
                createdAt: s.createdAt, viewCount: s.viewCount, lastViewedAt: s.lastViewedAt,
                patchesSinceReview: s.patchesSinceReview, needsReview: needsReview(s), problem: d.problem,
            });
        }
        return out;
    }

    liveCount(): number {
        return this.list().filter((s) => s.status !== 'archived').length;
    }

    /** `skill_view`. Counts the view and revives a stale/archived skill to active. */
    view(name: string, opts: { file?: string } = {}): SkillViewResult {
        if (name === 'list') return { result: 'list', skills: this.list() };
        if (!isValidSkillName(name)) return { result: 'skill_invalid_name' };
        const d = this.readDir(name);
        if (!d) return { result: 'skill_not_found' };
        if (d.problem) return { result: 'skill_invalid_format', reason: 'unparseable_skill_md' };
        let file: { path: string; content: string } | undefined;
        if (opts.file !== undefined) {
            const p = normalizeSkillFilePath(opts.file);
            if (!p || !d.files.some((f) => f.path === p)) return { result: 'skill_file_not_found' };
            file = { path: p, content: readFileSync(join(this.skillDir(name), p), 'utf-8') };
        }
        const { file: stateFile, corrupt } = this.loadState();
        let s = this.stateFor(stateFile, name);
        if (!corrupt) {
            const nowIso = this.now().toISOString();
            s = { ...s, viewCount: s.viewCount + 1, lastViewedAt: nowIso, ...(s.status !== 'active' ? { status: 'active', statusChangedAt: nowIso } : {}) };
            stateFile.skills[name] = s;
            writeSkillStateFile(this.statePath, stateFile);
        }
        return {
            result: 'ok', name, description: d.description, project: d.project, origin: s.origin, status: s.status,
            needsReview: needsReview(s), body: d.body, files: d.files.map((f) => f.path), file,
        };
    }

    /** Body + origin for `## Attached procedure` (does not count as a view). */
    readForAttach(name: string): { name: string; origin: SkillOrigin; body: string } | null {
        const d = this.readDir(name);
        if (!d || d.problem) return null;
        return { name, origin: this.stateFor(this.loadState().file, name).origin, body: d.body };
    }

    // ── skill_manage ────────────────────────────────────────────────────────

    manage(op: SkillManageOp, origin: StoreWriteOrigin, ctx: SkillCallContext | null): SkillManageResult {
        const out = this.manageInner(op, origin, ctx, null);
        if (out.result !== 'applied' && out.result !== 'staged') this.journal.append({ action: op.action, name: op.name, origin, result: out.result });
        return out;
    }

    private manageInner(op: SkillManageOp, origin: StoreWriteOrigin, ctx: SkillCallContext | null, resolving: string | null): SkillManageResult {
        if (!isValidSkillName(op?.name)) return { result: 'skill_invalid_name' };
        const agent = origin !== 'owner' && !resolving;
        if (agent && (!ctx || !ctx.sessionId || !ctx.turnId)) return { result: 'skill_invalid_format', reason: 'missing_context' };
        const { file: stateFile, corrupt } = this.loadState();
        if (corrupt) return { result: 'skill_store_unreadable' };
        const name = op.name;

        if (op.action === 'create') {
            if (existsSync(this.skillDir(name))) return { result: 'skill_exists' };
            const prep = prepareCreate(op);
            if ('result' in prep) return prep;
            const live = this.liveCount();
            if (live >= SKILL_LIMITS.liveSkills) return { result: 'skill_limit', live, limit: SKILL_LIMITS.liveSkills };
            if (prep.scan.some((t) => detectCredential(t))) return { result: 'skill_secret_rejected' };
            if (agent && mustStage(origin)) return this.stage(op, origin, ctx, 'origin', prep);
            this.writeFiles(name, prep.files);
            stateFile.skills[name] = newSkillState(origin === 'owner' && !resolving ? 'owner' : 'agent', this.now().toISOString());
            writeSkillStateFile(this.statePath, stateFile);
            this.journal.append({ action: 'create', name, origin, result: 'applied', stagedId: resolving ?? undefined, ...prep.journal });
            return { result: 'applied' };
        }

        const d = this.readDir(name);
        if (!d) return { result: 'skill_not_found' };
        if (d.problem) return { result: 'skill_invalid_format', reason: 'unparseable_skill_md' };
        const s = this.stateFor(stateFile, name);

        if (op.action === 'archive') {
            if (agent && mustStage(origin)) return this.stage(op, origin, ctx, 'origin', null);
            if (s.status !== 'archived') stateFile.skills[name] = { ...s, status: 'archived', statusChangedAt: this.now().toISOString() };
            writeSkillStateFile(this.statePath, stateFile);
            this.journal.append({ action: 'archive', name, origin, result: 'applied', stagedId: resolving ?? undefined });
            return { result: 'applied' };
        }

        if (op.action !== 'patch') return { result: 'skill_invalid_format', reason: 'bad_patch' };
        if (s.status === 'archived') return { result: 'skill_archived' };
        if (agent) {
            if (needsReview(s)) return { result: 'skill_needs_review' };
            const k = turnKey(ctx!.sessionId, ctx!.turnId);
            if ((s.turnPatches[k] ?? 0) >= SKILL_PATCH_CAPS.perTurn) return { result: 'skill_patch_limit', scope: 'turn', limit: SKILL_PATCH_CAPS.perTurn };
            if ((s.sessionPatches[ctx!.sessionId] ?? 0) >= SKILL_PATCH_CAPS.perSession) {
                return { result: 'skill_patch_limit', scope: 'session', limit: SKILL_PATCH_CAPS.perSession };
            }
        }
        const prep = preparePatch(op, d, this.skillDir(name));
        if ('result' in prep) return prep;
        if (prep.scan.some((t) => detectCredential(t))) return { result: 'skill_secret_rejected' };

        let next = s;
        if (agent) {
            next = {
                ...s,
                sessionPatches: bumpCounter(s.sessionPatches, ctx!.sessionId),
                turnPatches: bumpCounter(s.turnPatches, turnKey(ctx!.sessionId, ctx!.turnId)),
            };
            const why = mustStage(origin) ? 'origin' : s.origin !== 'agent' ? 'protected_skill' : null;
            if (why) {
                stateFile.skills[name] = next;
                writeSkillStateFile(this.statePath, stateFile);
                return this.stage(op, origin, ctx, why, prep);
            }
            next = { ...next, patchesSinceReview: next.patchesSinceReview + 1 };
        }
        this.writeFiles(name, prep.files);
        stateFile.skills[name] = { ...next, patchCount: next.patchCount + 1, lastPatchedAt: this.now().toISOString() };
        writeSkillStateFile(this.statePath, stateFile);
        this.journal.append({ action: 'patch', name, origin, result: 'applied', stagedId: resolving ?? undefined, ...prep.journal });
        return { result: 'applied' };
    }

    private writeFiles(name: string, files: PreparedWrite['files']): void {
        for (const f of files) writeFileAtomic600(join(this.skillDir(name), f.path), f.content);
    }

    private stage(
        op: SkillManageOp, origin: StoreWriteOrigin, ctx: SkillCallContext | null,
        reason: 'origin' | 'protected_skill', prep: PreparedWrite | null,
    ): SkillManageResult {
        const stagedId = this.staging.write({ op, origin, reason, ctx });
        this.journal.append({ action: op.action, name: op.name, origin, result: 'staged', stagedId, ...(prep?.journal ?? {}) });
        return { result: 'staged', stagedId, reason };
    }

    // ── staged writes (owner) ───────────────────────────────────────────────

    listStaged(): StagedSkillWrite[] {
        return this.staging.list();
    }

    /** Apply re-runs every check except caps/staging against the current files; a failure keeps the staged write. */
    resolveStaged(id: string, decision: 'apply' | 'discard'): SkillManageResult | { result: 'discarded' } | { result: 'staged_not_found' } {
        const rec = this.staging.read(id);
        if (!rec) return { result: 'staged_not_found' };
        if (decision === 'discard') {
            this.dropStaged(rec, 'owner');
            return { result: 'discarded' };
        }
        const out = this.manageInner(rec.op, rec.origin, rec.ctx, rec.id);
        if (out.result === 'applied') this.staging.remove(rec.id);
        else this.journal.append({ action: rec.op.action, name: rec.op.name, origin: rec.origin, result: out.result, stagedId: rec.id, resolvedBy: 'owner' });
        return out;
    }

    expireStaged(maxAgeMs: number): string[] {
        const cutoff = this.now().getTime() - maxAgeMs;
        const dropped: string[] = [];
        for (const rec of this.staging.list()) {
            if (Date.parse(rec.createdAt) < cutoff) {
                this.dropStaged(rec, 'expiry');
                dropped.push(rec.id);
            }
        }
        return dropped;
    }

    private dropStaged(rec: StagedSkillWrite, by: 'owner' | 'expiry'): void {
        this.journal.append({ action: rec.op.action, name: rec.op.name, origin: rec.origin, result: 'discarded', stagedId: rec.id, resolvedBy: by });
        this.staging.remove(rec.id);
    }

    // ── owner admin ─────────────────────────────────────────────────────────

    pin(name: string): SkillAdminResult { return this.admin(name, 'pin', (s) => ({ ...s, pinned: true })); }
    unpin(name: string): SkillAdminResult { return this.admin(name, 'unpin', (s) => ({ ...s, pinned: false })); }
    /** Owner review done: patchesSinceReview → 0, which lifts the needs_review lock. */
    clearReviewLock(name: string): SkillAdminResult { return this.admin(name, 'clear_review', (s) => ({ ...s, patchesSinceReview: 0 })); }
    restore(name: string): SkillAdminResult {
        return this.admin(name, 'restore', (s, nowIso) => (s.status === 'active' ? s : { ...s, status: 'active', statusChangedAt: nowIso }));
    }

    private admin(name: string, action: SkillJournalRecord['action'], fn: (s: SkillState, nowIso: string) => SkillState): SkillAdminResult {
        if (!this.readDir(name)) return { result: 'skill_not_found' };
        const { file, corrupt } = this.loadState();
        if (corrupt) return { result: 'skill_store_unreadable' };
        file.skills[name] = fn(this.stateFor(file, name), this.now().toISOString());
        writeSkillStateFile(this.statePath, file);
        this.journal.append({ action, name, origin: 'owner', result: 'applied' });
        return { result: 'applied' };
    }

    // ── curator / import hooks ──────────────────────────────────────────────

    /**
     * Status transitions only (§4.10.6): last view (or creation) ≥ 90 days →
     * archived, ≥ 30 days → stale. Pinned skills are skipped. Never deletes files.
     */
    curateStatuses(staleAfterMs: number, archiveAfterMs: number): { staled: string[]; archived: string[] } {
        const { file, corrupt } = this.loadState();
        const out = { staled: [] as string[], archived: [] as string[] };
        if (corrupt) return out;
        const now = this.now().getTime();
        const nowIso = this.now().toISOString();
        for (const name of this.skillNames()) {
            const s = this.stateFor(file, name);
            if (s.pinned || s.status === 'archived') continue;
            const ref = Date.parse(s.lastViewedAt ?? s.createdAt);
            if (!Number.isFinite(ref)) continue;
            const age = now - ref;
            const to: SkillStatus | null = age >= archiveAfterMs ? 'archived' : age >= staleAfterMs && s.status === 'active' ? 'stale' : null;
            if (!to) continue;
            file.skills[name] = { ...s, status: to, statusChangedAt: nowIso };
            (to === 'archived' ? out.archived : out.staled).push(name);
            this.journal.append({ action: 'curate', name, origin: 'curator', result: 'applied', before: s.status, after: to });
        }
        if (out.staled.length || out.archived.length) writeSkillStateFile(this.statePath, file);
        return out;
    }

    /** Every import check except the live-skill cap, without writing. Null = importable. */
    checkImport(input: SkillImportInput): SkillRefusal | null {
        return this.prepareImport(input).refusal;
    }

    private prepareImport(input: SkillImportInput): { refusal: SkillRefusal | null; files: PreparedWrite['files'] } {
        const no = (refusal: SkillRefusal) => ({ refusal, files: [] });
        if (!isValidSkillName(input.name)) return no({ result: 'skill_invalid_name' });
        if (this.loadState().corrupt) return no({ result: 'skill_store_unreadable' });
        if (existsSync(this.skillDir(input.name))) return no({ result: 'skill_exists' });
        const files: PreparedWrite['files'] = [];
        for (const f of input.files) {
            const p = normalizeSkillFilePath(f.path);
            if (!p) return no({ result: 'skill_invalid_format', reason: 'bad_file_path' });
            files.push({ path: p, content: f.content });
        }
        const over = checkSkillLimits(charCount(input.body), files.map((f) => ({ path: f.path, chars: charCount(f.content) })));
        if (over[0]) return no({ result: 'skill_too_large', ...over[0] });
        if ([input.frontmatterRaw, input.body, ...files.map((f) => f.content)].some((t) => detectCredential(t))) {
            return no({ result: 'skill_secret_rejected' });
        }
        return { refusal: null, files };
    }

    /** Owner import (Hermes): origin `imported`, no staging, every format/limit/credential check. */
    importSkill(input: SkillImportInput): SkillManageResult {
        const fail = (r: SkillRefusal) => (this.journal.append({ action: 'import', name: String(input.name), origin: 'owner', result: r.result }), r);
        const { refusal, files } = this.prepareImport(input);
        if (refusal) return fail(refusal);
        const live = this.liveCount();
        if (live >= SKILL_LIMITS.liveSkills) return fail({ result: 'skill_limit', live, limit: SKILL_LIMITS.liveSkills });
        this.writeFiles(input.name, [{ path: SKILL_FILE, content: composeSkillMd(input.frontmatterRaw, input.body) }, ...files]);
        const { file } = this.loadState();
        file.skills[input.name] = newSkillState('imported', this.now().toISOString());
        writeSkillStateFile(this.statePath, file);
        this.journal.append({ action: 'import', name: input.name, origin: 'owner', result: 'applied', sourceUsage: input.sourceUsage });
        return { result: 'applied' };
    }
}
