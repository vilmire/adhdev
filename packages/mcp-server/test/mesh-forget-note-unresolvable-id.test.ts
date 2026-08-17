import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { meshRecordNote, meshForgetNote } from '../src/tools/mesh-tools.js';
import { getLedgerDir } from '@adhdev/daemon-core';

// MISSION-UPSERT-SILENT-CREATE: a note_id is a specific, singular target (unlike text,
// which can legitimately match zero notes). Previously an unresolved note_id (e.g. a
// truncated/abbreviated id copied from a display view) returned success:true alongside
// matched:0 — the tombstone was recorded honestly, but the top-level success:true read as
// "it worked" to a skimming caller. This must now surface as success:false.

const createdMeshes: string[] = [];
function nextMeshId(): string {
  const id = `mesh_forgetnote_${randomUUID().slice(0, 8)}`;
  createdMeshes.push(id);
  return id;
}

function buildCtx(meshId: string): any {
  // meshRecordNote/meshForgetNote only read ctx.mesh.id (plus optional identity fields
  // for note attribution, none required) — a minimal mesh is enough.
  return { mesh: { id: meshId }, transport: {} };
}

test.after(() => {
  for (const meshId of createdMeshes) {
    const p = join(getLedgerDir(), `${meshId}.jsonl`);
    try { if (existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
  }
});

test('unresolvable note_id: success:false, code:note_not_found, matched:0 surfaced', async () => {
  const meshId = nextMeshId();
  const ctx = buildCtx(meshId);

  const recorded = JSON.parse(await meshRecordNote(ctx, { text: 'a real operating note' } as any));
  assert.equal(recorded.success, true);
  const realNoteId = recorded.noteId as string;
  // Simulate a truncated/abbreviated id, as a coordinator might copy from a display view.
  const truncated = realNoteId.slice(0, 8);
  assert.notEqual(truncated, realNoteId, 'sanity: the truncated form must differ from the real id');

  const raw = await meshForgetNote(ctx, { note_id: truncated } as any);
  const res = JSON.parse(raw);

  assert.equal(res.success, false, 'an id that does not match a live note must not report success');
  assert.equal(res.code, 'note_not_found');
  assert.equal(res.forgot.matched, 0);
  assert.match(res.note, /truncated|wrong id|exact match/i);

  // The real note was NOT retracted — a follow-up forget by its exact id still matches it.
  const followUp = JSON.parse(await meshForgetNote(ctx, { note_id: realNoteId } as any));
  assert.equal(followUp.success, true);
  assert.equal(followUp.forgot.matched, 1);
});

test('exact note_id match: success:true, matched:1 (regression guard)', async () => {
  const meshId = nextMeshId();
  const ctx = buildCtx(meshId);

  const recorded = JSON.parse(await meshRecordNote(ctx, { text: 'another real note' } as any));
  const raw = await meshForgetNote(ctx, { note_id: recorded.noteId } as any);
  const res = JSON.parse(raw);

  assert.equal(res.success, true);
  assert.equal(res.code, undefined);
  assert.equal(res.forgot.matched, 1);
});

test('text-based forget with zero matches is NOT treated as a failure (only note_id targets are)', async () => {
  const meshId = nextMeshId();
  const ctx = buildCtx(meshId);

  // No note with this text was ever recorded — retracting by content with zero live
  // matches is a legitimate no-op (e.g. pre-emptively suppressing wording that hasn't
  // been recorded yet), unlike a wrong/truncated note_id which is almost always a mistake.
  const raw = await meshForgetNote(ctx, { text: 'never recorded wording' } as any);
  const res = JSON.parse(raw);

  assert.equal(res.success, true);
  assert.equal(res.code, undefined);
  assert.equal(res.forgot.matched, 0);
});
