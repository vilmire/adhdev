import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { meshRecordNote } from '../src/tools/mesh-tools.js';
import { readOperatingNotes } from '@adhdev/daemon-core';
import { answerTurnIpc, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';
import { validateMeshToolArgs } from '../src/tools/validate-tool-args.js';
import { MESH_NOTE_TOOL } from '../src/tools/mesh-tool-schemas.js';
import { resolveMeshToolHandler } from '../src/tools/mesh-tool-dispatch.js';

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

test('mesh_note schema declares expiresAt and its expires_at snake_case alias', () => {
    const props = MESH_NOTE_TOOL.inputSchema.properties as any;
    assert.ok('expiresAt' in props, 'expiresAt missing from schema');
    assert.ok('expires_at' in props, 'expires_at missing from schema');
});

test('validateMeshToolArgs: mesh_note action=record accepts expiresAt', () => {
    const err = validateMeshToolArgs('mesh_note', { action: 'record', text: 'a note', expiresAt: '2030-01-01T00:00:00.000Z' });
    assert.equal(err, null);
});

test('mesh_note record core: an explicit ISO expiresAt is stored on the note', async () => {
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

test('mesh_note record core: the snake_case expires_at alias is accepted when expiresAt is absent', async () => {
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

test('mesh_note record core: expiresAt takes precedence over ttl_days when both are given', async () => {
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

// 2026-09-26 tool consolidation: record + forget are one published tool. Drive the
// merged tool end-to-end through the real dispatch table: record a note, then
// forget it by the returned id, and confirm the store reflects both.
test('mesh_note through dispatch: action=record stores a note, action=forget retracts it', async () => {
    const meshId = nextMeshId();
    const ctx = buildCtx(meshId);
    const handler = resolveMeshToolHandler('mesh_note')!;
    assert.equal(validateMeshToolArgs('mesh_note', { action: 'record', text: 'merged-tool note' }), null);
    const recorded = JSON.parse(await handler(ctx, { action: 'record', text: 'merged-tool note' }));
    assert.equal(recorded.success, true, JSON.stringify(recorded));
    assert.ok(readOperatingNotes(meshId).some(n => n.id === recorded.noteId));

    assert.equal(validateMeshToolArgs('mesh_note', { action: 'forget', note_id: recorded.noteId }), null);
    const forgotten = JSON.parse(await handler(ctx, { action: 'forget', note_id: recorded.noteId }));
    assert.equal(forgotten.success, true, JSON.stringify(forgotten));
    assert.equal(readOperatingNotes(meshId).some(n => n.id === recorded.noteId), false, 'forgotten note still live');
});
