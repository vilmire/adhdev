/**
 * Staged `project_note` writes (design 2026-10-07-assistant-layer.md §4.10.3).
 *
 * `project_note` takes the same origin gate as memory and skills: a write made
 * after a non-human input is held for the owner instead of reaching the mesh's
 * operating notes (which every coordinator of that mesh reads). A note written
 * during a review turn is ALWAYS held, clean window or not: its blast radius
 * (every coordinator, which edits the repo) is larger than the assistant's own
 * memory (research 2026-10-08 Q8). Same staged
 * directory as memory/skills (`<configDir>/assistant/staged/`), file prefix
 * `note-`, `kind: 'note'` — the memory and skill readers reject other kinds.
 *
 * The note itself is written by the caller through the existing
 * `recordOperatingNote` / `forgetOperatingNote`; this module only holds the op.
 */

import { readdirSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { getConfigDir } from '../config/config.js';
import { writeFileAtomic600, type StoreWriteOrigin } from './store-guards.js';

/** Categories `recordOperatingNote` knows (TTL table + durable provider_quirk). */
export const PROJECT_NOTE_CATEGORIES = ['provider_quirk', 'pattern_to_avoid', 'recovery_lesson'] as const;
export type ProjectNoteCategory = typeof PROJECT_NOTE_CATEGORIES[number];

export type ProjectNoteOp =
    | { action: 'record'; text: string; category?: ProjectNoteCategory }
    | { action: 'forget'; noteId?: string; text?: string };

export interface StagedNoteWrite {
    kind: 'note';
    id: string;
    createdAt: string;
    origin: StoreWriteOrigin;
    meshId: string;
    /** Project ref as the assistant wrote it (display only). */
    project: string;
    callerSessionId?: string;
    op: ProjectNoteOp;
    /** Review turn that staged it — the owner can resolve one review's writes together. */
    reviewTurnId?: string;
}

const ID_RE = /^note-[A-Za-z0-9-]+$/;

export class AssistantNoteStaging {
    readonly dir: string;
    private readonly now: () => Date;

    constructor(opts: { configDir?: string; now?: () => Date } = {}) {
        this.dir = join(opts.configDir ?? getConfigDir(), 'assistant', 'staged');
        this.now = opts.now ?? (() => new Date());
    }

    private path(id: string): string {
        return join(this.dir, `${id}.json`);
    }

    write(rec: Omit<StagedNoteWrite, 'kind' | 'id' | 'createdAt'>): string {
        const id = `note-${this.now().getTime()}-${randomBytes(4).toString('hex')}`;
        const full: StagedNoteWrite = { kind: 'note', id, createdAt: this.now().toISOString(), ...rec };
        writeFileAtomic600(this.path(id), JSON.stringify(full, null, 2));
        return id;
    }

    read(id: string): StagedNoteWrite | null {
        if (!ID_RE.test(id)) return null;
        try {
            const v = JSON.parse(readFileSync(this.path(id), 'utf-8')) as StagedNoteWrite;
            if (v && v.kind === 'note' && v.id === id && typeof v.meshId === 'string' && v.op && typeof v.op.action === 'string') return v;
        } catch { /* missing or corrupt */ }
        return null;
    }

    list(): StagedNoteWrite[] {
        if (!existsSync(this.dir)) return [];
        const out: StagedNoteWrite[] = [];
        for (const n of readdirSync(this.dir)) {
            if (!n.startsWith('note-') || !n.endsWith('.json')) continue;
            const rec = this.read(n.slice(0, -'.json'.length));
            if (rec) out.push(rec);
        }
        return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }

    remove(id: string): void {
        if (!ID_RE.test(id)) return;
        try { unlinkSync(this.path(id)); } catch { /* already gone */ }
    }

    /** Drop staged notes older than maxAgeMs. Returns ids dropped. */
    expire(maxAgeMs: number): string[] {
        const cutoff = this.now().getTime() - maxAgeMs;
        const dropped: string[] = [];
        for (const rec of this.list()) {
            if (Date.parse(rec.createdAt) < cutoff) {
                this.remove(rec.id);
                dropped.push(rec.id);
            }
        }
        return dropped;
    }
}
