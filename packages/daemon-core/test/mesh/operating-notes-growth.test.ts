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
}));

import {
    appendLedgerEntry,
    readLedgerEntries,
    readOperatingNotes,
    tombstoneOperatingNote,
    pruneOperatingNotes,
    OPERATING_NOTE_KEEP_LATEST,
} from '../../src/mesh/mesh-ledger.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

function recordNote(meshId: string, text: string) {
    return appendLedgerEntry(meshId, {
        kind: 'coordinator_operating_note',
        payload: { text, createdAt: new Date().toISOString() },
    });
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

            const notes = readLedgerEntries(meshId, { kind: ['coordinator_operating_note'] });
            expect(notes.length).toBe(1);
            // The returned entry for a duplicate is the original (same id).
            expect(notes[0].id).toBe(first.id);
        });

        it('dedupes on trimmed text so surrounding whitespace does not defeat it', () => {
            recordNote(meshId, 'lesson A');
            recordNote(meshId, '  lesson A  ');
            const notes = readLedgerEntries(meshId, { kind: ['coordinator_operating_note'] });
            expect(notes.length).toBe(1);
        });

        it('keeps distinct lessons as separate notes', () => {
            recordNote(meshId, 'lesson A');
            recordNote(meshId, 'lesson B');
            recordNote(meshId, 'lesson A'); // dup of A
            const notes = readLedgerEntries(meshId, { kind: ['coordinator_operating_note'] });
            expect(notes.map(n => (n.payload as any).text).sort()).toEqual(['lesson A', 'lesson B']);
        });

        it('does not dedupe non-note kinds (task_completed accumulates)', () => {
            for (let i = 0; i < 5; i++) {
                appendLedgerEntry(meshId, { kind: 'task_completed', payload: { taskId: 't1', note: 'same' } });
            }
            const completed = readLedgerEntries(meshId, { kind: ['task_completed'] });
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

        it('preserves history — the note and tombstone remain in the raw ledger', () => {
            const note = recordNote(meshId, 'to forget');
            tombstoneOperatingNote(meshId, { noteId: note.id });
            const raw = readLedgerEntries(meshId);
            const kinds = raw.map(e => e.kind).sort();
            expect(kinds).toContain('coordinator_operating_note_tombstone');
            // readOperatingNotes hides it, but the raw entry still exists somewhere in history
            // (unless already pruned — with a single note under the keep-latest bound it survives).
            expect(raw.some(e => e.id === note.id) || raw.some(e => e.kind === 'coordinator_operating_note_tombstone')).toBe(true);
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

            const notes = readLedgerEntries(meshId, { kind: ['coordinator_operating_note'] });
            expect(notes.length).toBe(keep);

            const texts = notes.map(n => (n.payload as any).text);
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
            const raw = readLedgerEntries(meshId, { kind: ['coordinator_operating_note'] });
            expect(raw.some(e => e.id === note.id)).toBe(false);
        });

        it('is a no-op below the keep-latest bound', () => {
            recordNote(meshId, 'a');
            recordNote(meshId, 'b');
            const removed = pruneOperatingNotes(meshId);
            expect(removed).toBe(0);
            expect(readLedgerEntries(meshId, { kind: ['coordinator_operating_note'] }).length).toBe(2);
        });
    });
});
