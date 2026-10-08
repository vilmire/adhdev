/**
 * Skill store journal (`skills/.journal.jsonl`) and staged skill writes
 * (`assistant/staged/skl-*.json`, `kind: 'skill'`, next to the memory ones).
 *
 * Design: docs/design/2026-10-07-assistant-layer.md §4.10.2 (journal, staging)
 * and §4.10.4 (owner reviews the diff since the last review from the journal).
 * Text that matches a credential pattern never reaches the journal.
 */

import { existsSync, readdirSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { appendJsonLine600, detectCredential, writeFileAtomic600, type StoreWriteOrigin } from '../store-guards.js';
import type { SkillCallContext, SkillManageOp } from './skill-store.js';

export interface SkillJournalRecord {
    ts: string;
    action: 'create' | 'patch' | 'archive' | 'pin' | 'unpin' | 'restore' | 'clear_review' | 'curate' | 'import';
    name: string;
    origin: StoreWriteOrigin | 'curator';
    /** `applied`, `staged`, `discarded` or a refusal code. */
    result: string;
    /** What a patch touched: body, description, a reference file, or a whole new skill. */
    field?: 'body' | 'description' | 'file' | 'create';
    file?: string;
    /** Replaced text / previous value (patch, curate), or null. */
    before?: string | null;
    /** New text / new value, or null. */
    after?: string | null;
    stagedId?: string;
    resolvedBy?: 'owner' | 'expiry';
    redacted?: Array<'before' | 'after'>;
    /** Hermes counters at import time (they are not copied into .state.json). */
    sourceUsage?: Record<string, unknown>;
    /** Review turn the write came from (review / review_tainted origins). */
    reviewTurnId?: string;
}

/** Refusals whose payload text never reaches the journal. */
const REDACT_RESULTS: ReadonlySet<string> = new Set(['skill_secret_rejected', 'skill_hidden_chars_rejected', 'skill_injection_rejected']);

export class SkillJournal {
    constructor(
        readonly path: string,
        private readonly now: () => Date,
    ) {}

    append(rec: Omit<SkillJournalRecord, 'ts' | 'redacted'>): void {
        const full: SkillJournalRecord = { ts: this.now().toISOString(), ...rec };
        const redacted: Array<'before' | 'after'> = [];
        for (const f of ['before', 'after'] as const) {
            const v = full[f];
            if (typeof v === 'string' && (detectCredential(v) || REDACT_RESULTS.has(rec.result))) {
                full[f] = null;
                redacted.push(f);
            }
        }
        if (redacted.length) full.redacted = redacted;
        try {
            appendJsonLine600(this.path, full);
        } catch { /* audit trail; a failed append must not fail the write */ }
    }

    read(): SkillJournalRecord[] {
        if (!existsSync(this.path)) return [];
        const out: SkillJournalRecord[] = [];
        for (const line of readFileSync(this.path, 'utf-8').split('\n')) {
            if (!line.trim()) continue;
            try { out.push(JSON.parse(line) as SkillJournalRecord); } catch { /* skip corrupt line */ }
        }
        return out;
    }
}

export interface StagedSkillWrite {
    kind: 'skill';
    id: string;
    createdAt: string;
    origin: StoreWriteOrigin;
    /** `origin`: written after a non-human input; `protected_skill`: agent patch on an owner/imported skill. */
    reason: 'origin' | 'protected_skill';
    op: SkillManageOp;
    ctx: SkillCallContext | null;
    /** Review turn that staged it — the owner can resolve one review's writes together. */
    reviewTurnId?: string;
}

export class SkillStaging {
    constructor(
        readonly dir: string,
        private readonly now: () => Date,
    ) {}

    private path(id: string): string {
        return join(this.dir, `${id}.json`);
    }

    write(rec: Omit<StagedSkillWrite, 'kind' | 'id' | 'createdAt'>): string {
        const id = `skl-${this.now().getTime()}-${randomBytes(4).toString('hex')}`;
        const full: StagedSkillWrite = { kind: 'skill', id, createdAt: this.now().toISOString(), ...rec };
        writeFileAtomic600(this.path(id), JSON.stringify(full, null, 2));
        return id;
    }

    read(id: string): StagedSkillWrite | null {
        if (!/^skl-[A-Za-z0-9-]+$/.test(id)) return null;
        try {
            const v = JSON.parse(readFileSync(this.path(id), 'utf-8')) as StagedSkillWrite;
            if (v && v.kind === 'skill' && v.id === id && typeof v.createdAt === 'string' && v.op && typeof v.op.action === 'string') return v;
        } catch { /* missing or corrupt */ }
        return null;
    }

    list(): StagedSkillWrite[] {
        if (!existsSync(this.dir)) return [];
        const out: StagedSkillWrite[] = [];
        for (const n of readdirSync(this.dir)) {
            if (!n.startsWith('skl-') || !n.endsWith('.json')) continue;
            const rec = this.read(n.slice(0, -'.json'.length));
            if (rec) out.push(rec);
        }
        return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }

    remove(id: string): void {
        try { unlinkSync(this.path(id)); } catch { /* already gone */ }
    }
}
