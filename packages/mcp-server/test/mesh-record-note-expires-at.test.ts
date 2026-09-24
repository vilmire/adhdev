import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { meshRecordNote } from '../src/tools/mesh-tools.js';
import { readOperatingNotes } from '@adhdev/daemon-core';
import { answerTurnIpc, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';
import { validateMeshToolArgs } from '../src/tools/validate-tool-args.js';
import { MESH_RECORD_NOTE_TOOL } from '../src/tools/mesh-tool-schemas.js';

/**
 * Parity audit gap: `meshRecordNote` (mesh-tools-mission.ts) already read
 * `args.expiresAt` (an ISO-8601 alternative to ttl_days), but the schema
 * declared no `expiresAt`/`expires_at` property at all — so a caller using the
 * exact field the handler reads was rejected by the unknown-arg gate, and a
 * snake_case caller had no alias at all. Fixed by adding both to the schema
 * and reading `expires_at` as a fallback in the handler.
 */

function nextMeshId(): string {
    return `mesh_recordnote_expiresat_${randomUUID().slice(0, 8)}`;
}

function buildCtx(meshId: string): any {
    return {
        mesh: { id: meshId },
        transport: {
            command: async (command: string, args: Record<string, unknown> = {}) => {
                if (isTurnIpcCommand(command)) return answerTurnIpc(command, args);
                throw new Error(`unexpected command: ${command}`);
            },
        },
    };
}

test('mesh_record_note schema declares expiresAt and its expires_at snake_case alias', () => {
    const props = MESH_RECORD_NOTE_TOOL.inputSchema.properties as any;
    assert.ok('expiresAt' in props, 'expiresAt missing from schema');
    assert.ok('expires_at' in props, 'expires_at missing from schema');
});

test('validateMeshToolArgs: mesh_record_note accepts expiresAt', () => {
    const err = validateMeshToolArgs('mesh_record_note', { text: 'a note', expiresAt: '2030-01-01T00:00:00.000Z' });
    assert.equal(err, null);
});

test('mesh_record_note: an explicit ISO expiresAt is stored on the note', async () => {
    const meshId = nextMeshId();
    const ctx = buildCtx(meshId);
    const iso = '2030-06-15T00:00:00.000Z';

    const raw = await meshRecordNote(ctx, { text: 'expires on an exact date', expiresAt: iso } as any);
    const res = JSON.parse(raw);
    assert.equal(res.success, true, JSON.stringify(res));

    const notes = readOperatingNotes(meshId);
    const stored = notes.find(n => n.id === res.noteId);
    assert.ok(stored, 'note not found in the operating-notes store');
    assert.equal(stored!.payload.expiresAt, iso);
});

test('mesh_record_note: the snake_case expires_at alias is accepted when expiresAt is absent', async () => {
    const meshId = nextMeshId();
    const ctx = buildCtx(meshId);
    const iso = '2030-07-01T00:00:00.000Z';

    const raw = await meshRecordNote(ctx, { text: 'snake case expiry', expires_at: iso } as any);
    const res = JSON.parse(raw);
    assert.equal(res.success, true, JSON.stringify(res));

    const notes = readOperatingNotes(meshId);
    const stored = notes.find(n => n.id === res.noteId);
    assert.ok(stored, 'note not found in the operating-notes store');
    assert.equal(stored!.payload.expiresAt, iso);
});

test('mesh_record_note: expiresAt takes precedence over ttl_days when both are given', async () => {
    const meshId = nextMeshId();
    const ctx = buildCtx(meshId);
    const iso = '2031-01-01T00:00:00.000Z';

    const raw = await meshRecordNote(ctx, { text: 'expiresAt wins over ttl_days', expiresAt: iso, ttl_days: 5 } as any);
    const res = JSON.parse(raw);
    assert.equal(res.success, true, JSON.stringify(res));

    const notes = readOperatingNotes(meshId);
    const stored = notes.find(n => n.id === res.noteId);
    assert.equal(stored!.payload.expiresAt, iso);
});
