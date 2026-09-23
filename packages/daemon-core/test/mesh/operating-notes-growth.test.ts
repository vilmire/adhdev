import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Override home dir to use a temp directory for ledger storage (same pattern as
// mesh-ledger.test.ts — mock getConfigDir before importing the module).
const testTmpDir = join(tmpdir(), `adhdev-opnotes-test-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) {
            mkdirSync(testConfigDir, { recursive: true });
        }
        return testConfigDir;
    },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));

import { readLocalRecords } from '../../src/mesh/mesh-local-records.js';
import { meshRecord } from '../../src/mesh/mesh-record.js';
import { seedLocalRecord } from '../helpers/local-records.js';
import {
    forgetOperatingNote as tombstoneOperatingNote,
    pruneOperatingNotes,
    readOperatingNotes,
    recordOperatingNote,
    OPERATING_NOTE_KEEP_LATEST,
} from '../../src/mesh/mesh-operating-notes.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

// C-W8: operating notes live in `mesh_operating_notes` (mesh-operating-notes.ts),
// not the event ledger. The growth-control contract below is unchanged.
function recordNote(meshId: string, text: string) {
    return recordOperatingNote(meshId, { text });
}

/** Every stored note row (live + tombstoned), for the "what does the store hold" assertions. */
function storedNotes(meshId: string) {
    return MeshRuntimeStore.getInstance().turnStore().listOperatingNotes(meshId, { includeTombstoned: true }).filter((n) => !n.meta.textTombstone);
}

describe('operating-notes growth controls', () => {
    let meshId: string;

    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        meshId = `test-opnotes-${randomUUID().slice(0, 8)}`;
    });

    afterEach(() => {
        MeshRuntimeStore.resetForTests();
        try { rmSync(testTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    // ── Fix (1) dedupe-on-record ──
    describe('dedupe-on-record', () => {
        it('records the same lesson 20 times but keeps only one note in the tail', () => {
            const first = recordNote(meshId, 'always run scoped tests');
            for (let i = 0; i < 19; i++) recordNote(meshId, 'always run scoped tests');

            const notes = readOperatingNotes(meshId);
            expect(notes.length).toBe(1);
            // The returned entry for a duplicate is the original (same id).
            expect(notes[0].id).toBe(first.id);
        });

        it('dedupes on trimmed text so surrounding whitespace does not defeat it', () => {
            recordNote(meshId, 'lesson A');
            recordNote(meshId, '  lesson A  ');
            const notes = readOperatingNotes(meshId);
            expect(notes.length).toBe(1);
        });

        it('keeps distinct lessons as separate notes', () => {
            recordNote(meshId, 'lesson A');
            recordNote(meshId, 'lesson B');
            recordNote(meshId, 'lesson A'); // dup of A
            const notes = readOperatingNotes(meshId);
            expect(notes.map(n => (n.payload as any).text).sort()).toEqual(['lesson A', 'lesson B']);
        });

        it('does not dedupe non-note kinds (task_completed accumulates)', () => {
            for (let i = 0; i < 5; i++) {
                seedLocalRecord(meshId, { kind: 'task_completed', payload: { taskId: 't1', note: 'same' } });
            }
            const completed = readLocalRecords(meshId, { kind: ['task_completed'] });
            expect(completed.length).toBe(5);
        });
    });

    // ── Fix (2) tombstone / forget ──
    describe('tombstone / forget', () => {
        it('excludes a note from readOperatingNotes after it is forgotten by id', () => {
            const note = recordNote(meshId, 'stale lesson');
            recordNote(meshId, 'good lesson');

            expect(readOperatingNotes(meshId).map(n => (n.payload as any).text))
                .toEqual(['stale lesson', 'good lesson']);

            const { matched } = tombstoneOperatingNote(meshId, { noteId: note.id });
            expect(matched).toBe(1);

            const live = readOperatingNotes(meshId).map(n => (n.payload as any).text);
            expect(live).toEqual(['good lesson']);
        });

        it('forgets every note with the given exact text', () => {
            // Two distinct meshes would be cleaner, but distinct text lets both live pre-tombstone.
            recordNote(meshId, 'wrong lesson');
            recordNote(meshId, 'keep me');
            const { matched } = tombstoneOperatingNote(meshId, { text: 'wrong lesson' });
            expect(matched).toBe(1);
            expect(readOperatingNotes(meshId).map(n => (n.payload as any).text)).toEqual(['keep me']);
        });

        it('a text forget also retracts a note with that text recorded LATER (the old fingerprint tombstone)', () => {
            tombstoneOperatingNote(meshId, { text: 'never again' });
            recordNote(meshId, 'never again');
            expect(readOperatingNotes(meshId).map(n => (n.payload as any).text)).not.toContain('never again');
        });

        it('notes are refused as mesh records (they would be invisible there)', () => {
            const res = meshRecord(meshId, 'coordinator_operating_note', { payload: { text: 'x' } }, { local: true });
            expect(res).toMatchObject({ storedLocally: false, published: false });
            expect(readLocalRecords(meshId, { kind: ['coordinator_operating_note'] })).toEqual([]);
        });

        it('requires a target', () => {
            expect(() => tombstoneOperatingNote(meshId, {})).toThrow();
        });
    });

    // ── Fix (3) keep-latest-N prune ──
    describe('keep-latest-N prune', () => {
        it('keeps only the latest N notes and prunes the oldest surplus', () => {
            const keep = OPERATING_NOTE_KEEP_LATEST;
            const total = keep + 15;
            for (let i = 0; i < total; i++) recordNote(meshId, `lesson ${i}`);

            const notes = storedNotes(meshId);
            expect(notes.length).toBe(keep);

            const texts = notes.map(n => n.text);
            // Oldest (lesson 0 .. lesson 14) pruned; freshest preserved including the very last.
            expect(texts).not.toContain('lesson 0');
            expect(texts).toContain(`lesson ${total - 1}`);
        });

        it('preserves the prompt tail (freshest 20) after pruning', () => {
            const total = OPERATING_NOTE_KEEP_LATEST + 30;
            for (let i = 0; i < total; i++) recordNote(meshId, `note ${i}`);
            const tail = readOperatingNotes(meshId, { tail: 20 }).map(n => (n.payload as any).text);
            expect(tail.length).toBe(20);
            expect(tail[tail.length - 1]).toBe(`note ${total - 1}`);
        });

        it('prunes tombstoned notes first (they never count toward keep-latest)', () => {
            const note = recordNote(meshId, 'tombstoned early');
            for (let i = 0; i < 5; i++) recordNote(meshId, `later ${i}`);
            tombstoneOperatingNote(meshId, { noteId: note.id });

            // Explicit prune with a tiny bound: tombstoned note must be gone regardless of order.
            pruneOperatingNotes(meshId, 100);
            expect(storedNotes(meshId).some(e => e.noteId === note.id)).toBe(false);
        });

        it('is a no-op below the keep-latest bound', () => {
            recordNote(meshId, 'a');
            recordNote(meshId, 'b');
            const removed = pruneOperatingNotes(meshId);
            expect(removed).toBe(0);
            expect(storedNotes(meshId).length).toBe(2);
        });
    });
});
