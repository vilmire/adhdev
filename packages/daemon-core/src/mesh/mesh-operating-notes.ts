// ---------------------------------------------------------------------------
// mesh-operating-notes — coordinator operating notes on `mesh_operating_notes`
// ---------------------------------------------------------------------------
// Wiring-unification C3 / C-W8. Operating notes (the lessons a coordinator
// records for every future coordinator on the mesh) used to be
// `coordinator_operating_note` / `_tombstone` rows of the
// legacy event ledger. The C3 migration (migrate-v1 step h) moved them into
// `mesh_operating_notes`, but every reader kept reading the ledger — so on a
// migrated daemon the pre-migration notes were invisible. This module is now the
// ONE read/write path; the event ledger no longer holds notes.
//
// Local-only by design: note TEXT is free text authored by a coordinator, so it
// never rides `mesh.<id>.events` (content boundary). The mcp-server reaches this
// over the daemon's local `note_upsert` / `note_forget` IPC commands.
//
// Semantics preserved from the ledger implementation (operating-notes-growth
// tests pin them):
//   · dedupe-on-record — the same trimmed text among the most recent
//     OPERATING_NOTE_DEDUPE_WINDOW live notes returns the existing note;
//   · keep-latest-N — at most OPERATING_NOTE_KEEP_LATEST live notes; the oldest
//     surplus and every tombstoned note are pruned (tombstone MARKERS stay);
//   · forget by id or by exact text — a text forget also leaves a marker, so a
//     note with that text recorded LATER is born retracted (the old fingerprint
//     tombstone's behaviour).
// ---------------------------------------------------------------------------

import { randomUUID } from 'crypto';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import type { MeshOperatingNoteRow } from './turn-ledger/store.js';

export const OPERATING_NOTE_KIND = 'coordinator_operating_note' as const;

/** Dedupe window: the same trimmed text among this many most recent live notes is a no-op. */
export const OPERATING_NOTE_DEDUPE_WINDOW = 40;

/** Keep-latest-N bound on live notes (the prompt reads a much smaller budget). */
export const OPERATING_NOTE_KEEP_LATEST = 100;

/** Content-free lifecycle fields kept beside the text (`mesh_operating_notes.meta_json`). */
export interface OperatingNoteMeta {
    pinned?: boolean;
    /** Explicit expiry (ISO); wins over the category TTL. */
    expiresAt?: string;
    /** Note id (or subject key) an earlier note this one supersedes. */
    supersedes?: string;
    subjectKey?: string;
    sourceCoordinator?: string;
    /** Marker row left by a text forget: suppresses a later note with this text. */
    textTombstone?: boolean;
    forgetReason?: string;
}

/** A live note in the shape the ledger-era readers consumed (id / timestamp / payload). */
export interface OperatingNoteEntry {
    id: string;
    meshId: string;
    timestamp: string;
    kind: typeof OPERATING_NOTE_KIND;
    sessionId?: string;
    payload: {
        text: string;
        category?: string;
        createdAt: string;
        sourceCoordinator?: string;
        pinned?: boolean;
        expiresAt?: string;
        supersedes?: string;
        subjectKey?: string;
    };
}

export interface RecordOperatingNoteInput {
    text: string;
    category?: string;
    pinned?: boolean;
    expiresAt?: string;
    supersedes?: string;
    subjectKey?: string;
    sourceCoordinator?: string;
    callerSessionId?: string;
    /** Epoch ms; now when omitted. */
    createdAtMs?: number;
}

function toEntry(row: MeshOperatingNoteRow): OperatingNoteEntry {
    const meta = row.meta;
    const createdAt = new Date(row.createdAt).toISOString();
    return {
        id: row.noteId,
        meshId: row.meshId,
        timestamp: createdAt,
        kind: OPERATING_NOTE_KIND,
        ...(row.callerSessionId ? { sessionId: row.callerSessionId } : {}),
        payload: {
            text: row.text,
            ...(row.category ? { category: row.category } : {}),
            createdAt,
            ...(meta.sourceCoordinator ? { sourceCoordinator: meta.sourceCoordinator } : {}),
            ...(meta.pinned ? { pinned: true } : {}),
            ...(meta.expiresAt ? { expiresAt: meta.expiresAt } : {}),
            ...(meta.supersedes ? { supersedes: meta.supersedes } : {}),
            ...(meta.subjectKey ? { subjectKey: meta.subjectKey } : {}),
        },
    };
}

function turnStore() {
    return MeshRuntimeStore.getInstance().turnStore();
}

/** Live (non-tombstoned, non-marker) notes, oldest → newest; `tail` keeps the freshest N. */
export function readOperatingNotes(meshId: string, opts: { tail?: number } = {}): OperatingNoteEntry[] {
    let rows = turnStore().listOperatingNotes(meshId).filter((r) => !r.meta.textTombstone);
    if (opts.tail && opts.tail > 0 && rows.length > opts.tail) rows = rows.slice(-opts.tail);
    return rows.map(toEntry);
}

/**
 * Record a note (dedupe-on-record, then keep-latest-N). A note whose text a
 * previous text-forget retracted is recorded ALREADY retracted, so it never
 * reaches a prompt — the old fingerprint-tombstone contract.
 */
export function recordOperatingNote(meshId: string, input: RecordOperatingNoteInput): OperatingNoteEntry {
    const text = input.text.trim();
    if (!text) throw new Error('recordOperatingNote requires non-empty text');
    const store = turnStore();
    const live = store.listOperatingNotes(meshId).filter((r) => !r.meta.textTombstone);
    const existing = live.slice(-OPERATING_NOTE_DEDUPE_WINDOW).find((r) => r.text.trim() === text);
    if (existing) return toEntry(existing);

    const nowMs = input.createdAtMs ?? Date.now();
    const meta: OperatingNoteMeta = {
        ...(input.pinned ? { pinned: true } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        ...(input.supersedes ? { supersedes: input.supersedes } : {}),
        ...(input.subjectKey ? { subjectKey: input.subjectKey } : {}),
        ...(input.sourceCoordinator ? { sourceCoordinator: input.sourceCoordinator } : {}),
    };
    const row: Omit<MeshOperatingNoteRow, 'tombstonedAt'> = {
        noteId: randomUUID(),
        meshId,
        text,
        category: input.category ?? null,
        callerSessionId: input.callerSessionId ?? null,
        createdAt: nowMs,
        meta,
    };
    store.insertOperatingNote(row);
    const retracted = store.listOperatingNotes(meshId, { includeTombstoned: true })
        .some((r) => r.meta.textTombstone && r.text.trim() === text);
    if (retracted) store.tombstoneOperatingNote(meshId, row.noteId, nowMs);
    try { pruneOperatingNotes(meshId); } catch { /* prune is best-effort */ }
    return toEntry({ ...row, tombstonedAt: retracted ? nowMs : null });
}

/**
 * Retract notes by id and/or exact trimmed text. Returns how many LIVE notes it
 * hid. A text target also leaves a marker so a later note with that text is
 * born retracted; an id target that matched nothing leaves nothing behind (a
 * later note cannot reuse a generated id).
 */
export function forgetOperatingNote(meshId: string, target: { noteId?: string; text?: string; reason?: string }): { matched: number; tombstoneId: string } {
    const noteId = typeof target.noteId === 'string' ? target.noteId.trim() : '';
    const text = typeof target.text === 'string' ? target.text.trim() : '';
    if (!noteId && !text) throw new Error('forgetOperatingNote requires a noteId or text target');
    const store = turnStore();
    const nowMs = Date.now();
    let matched = 0;
    for (const note of store.listOperatingNotes(meshId)) {
        if (note.meta.textTombstone) continue;
        if ((noteId && note.noteId === noteId) || (text && note.text.trim() === text)) {
            if (store.tombstoneOperatingNote(meshId, note.noteId, nowMs)) matched += 1;
        }
    }
    const tombstoneId = randomUUID();
    if (text) {
        store.insertOperatingNote({
            noteId: tombstoneId,
            meshId,
            text,
            category: null,
            callerSessionId: null,
            createdAt: nowMs,
            meta: { textTombstone: true, ...(target.reason?.trim() ? { forgetReason: target.reason.trim() } : {}) },
        });
    }
    try { pruneOperatingNotes(meshId); } catch { /* prune is best-effort */ }
    return { matched, tombstoneId };
}

/**
 * Keep-latest-N prune: deletes every tombstoned note and the oldest live notes
 * beyond `keepLatest`. Text-tombstone MARKERS are kept (they are what keeps a
 * forgotten text forgotten). Returns the number of notes removed.
 */
export function pruneOperatingNotes(meshId: string, keepLatest: number = OPERATING_NOTE_KEEP_LATEST): number {
    const store = turnStore();
    const rows = store.listOperatingNotes(meshId, { includeTombstoned: true }).filter((r) => !r.meta.textTombstone);
    const remove: string[] = rows.filter((r) => r.tombstonedAt !== null).map((r) => r.noteId);
    const live = rows.filter((r) => r.tombstonedAt === null);
    const bound = Math.max(0, Math.floor(keepLatest));
    if (live.length > bound) remove.push(...live.slice(0, live.length - bound).map((r) => r.noteId));
    return remove.length ? store.deleteOperatingNotes(meshId, remove) : 0;
}

// ─── Operating-note lifecycle: category TTL + expiry (read-side only) ──────────
// (Moved from mesh-ledger.ts with the notes themselves, C-W8.)
// Minimal first cut of the operating-notes lifecycle. Expiry is READ/INJECTION
// side ONLY — the store prune (keep-latest-100 above) stays purely count-based
// and NEVER deletes by age, so audit history is preserved. isNoteExpired decides
// whether an UNPINNED note still rides into a coordinator prompt.
//
// Per-category retention (days). A category not listed here — including the
// uncategorized case — is durable (never expires). provider_quirk is durable
// because a runtime quirk stays true until the provider changes.
export const OPERATING_NOTE_CATEGORY_TTL_DAYS: Readonly<Record<string, number>> = {
    recovery_lesson: 14,
    pattern_to_avoid: 30,
    // provider_quirk: durable (intentionally absent → never expires)
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Shape isNoteExpired reads. Structural so mesh-ledger stays free of a
 * coordinator-prompt import (CoordinatorOperatingNote satisfies this).
 */
export interface OperatingNoteExpiryInput {
    category?: string;
    pinned?: boolean;
    createdAt?: string;
    /** Explicit expiry override; wins over the category TTL when parseable. */
    expiresAt?: string;
    /** Fallback creation time (ledger entry timestamp) when createdAt absent. */
    timestamp?: string;
}

/**
 * Pure helper: is this UNPINNED operating note expired as of `now` (epoch ms)?
 *
 * Rules:
 *  - pinned notes NEVER expire (always false).
 *  - an explicit, parseable `expiresAt` in the past → expired.
 *  - otherwise the category TTL applies; a durable category (provider_quirk,
 *    uncategorized, or any category not in the TTL map) never expires.
 *  - age is measured from createdAt, falling back to `timestamp` (ledger entry
 *    time). If neither is a valid date, the note is treated as NOT expired
 *    (never silently drop a note we cannot age).
 */
export function isNoteExpired(note: OperatingNoteExpiryInput, now: number): boolean {
    return resolveNoteExpiry(note, now).expired;
}

/** What a caller needs to both display and enforce a note's lifetime. */
export interface ResolvedNoteExpiry {
    /** When this note stops being injected. Absent = durable (never expires). */
    effectiveExpiresAt?: string;
    expired: boolean;
}

/**
 * Single source for the note-lifetime policy: pinned beats everything, an
 * explicit parseable `expiresAt` beats the category TTL, and a category with no
 * TTL is durable.
 *
 * Callers that only need the boolean use isNoteExpired; the dashboard also needs
 * the resolved deadline to show it. Those were briefly two separate
 * implementations — one here, one in the list_mesh_notes handler — which agreed
 * by luck and would have drifted.
 */
export function resolveNoteExpiry(note: OperatingNoteExpiryInput, now: number): ResolvedNoteExpiry {
    if (!note || note.pinned) return { expired: false };

    // Explicit expiresAt wins when present and parseable.
    if (typeof note.expiresAt === 'string') {
        const exp = new Date(note.expiresAt).getTime();
        if (!Number.isNaN(exp)) return { effectiveExpiresAt: new Date(exp).toISOString(), expired: exp <= now };
    }

    const ttlDays = note.category ? OPERATING_NOTE_CATEGORY_TTL_DAYS[note.category] : undefined;
    if (typeof ttlDays !== 'number' || !Number.isFinite(ttlDays)) {
        // Durable category (provider_quirk / uncategorized / unknown) → never expires.
        return { expired: false };
    }

    const created = new Date(note.createdAt ?? note.timestamp ?? '').getTime();
    if (Number.isNaN(created)) return { expired: false }; // cannot age → keep

    const deadline = created + ttlDays * MS_PER_DAY;
    return { effectiveExpiresAt: new Date(deadline).toISOString(), expired: now >= deadline };
}
