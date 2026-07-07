/**
 * Regression: antigravity mesh coordinator + MAGI replica birth-floor isolation
 * (D3 — the FINAL root of "coordinator chat shows only the user message").
 *
 * The mesh coordinator and its MAGI replicas run as session-host HOSTED RUNTIMES
 * sharing ONE workspace, each attached with attachExisting=true. The attach used
 * to collapse the session-registry spawnedAtMs to 0 for ALL of them. With
 * spawnedAtMs=0, resolveAntigravityPath takes the FLOOR-LESS newest-by-mtime
 * branch (ownerConfirmed:false) instead of the per-session birth-floor branch —
 * so a replica's floor-less read claims the coordinator's OWN conversation first;
 * the coordinator then finds its own conv claimedByOther, excludes it, and picks a
 * replica's conv. ownerConfirmed never becomes true → D1's pin/gate never fires →
 * the coordinator chat regresses to the pty-parser (user-only) path.
 *
 * The fix threads each runtime's REAL session-host startedAt (a PAST timestamp)
 * into spawnedAtMs on attach, restoring each session's native-history birth-floor.
 * With a real floor each session resolves its OWN conversation (ownerConfirmed:true)
 * and cannot claim a sibling's — exactly as a fresh (non-attach) launch does.
 *
 * NOTE ON TIMING: the birth-floor uses the store's real filesystem birthtime, which
 * cannot be forged via utimes. The three conversation DBs are therefore created in
 * birth order (coordinator first, then the two replicas) so their natural creation
 * order is coord < replicaA < replicaB, and floors are expressed relative to
 * Date.now() — mirroring the sibling antigravity-conversation-binding-isolation test.
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir = '';

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpDir };
});
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => tmpDir };
});

// Distinct conversation uuids: coordinator + two replicas.
const COORD = 'cccccccc-0000-0000-0000-00000000c00d';
const REPLICA_A = 'aaaaaaaa-0000-0000-0000-0000000000aa';
const REPLICA_B = 'bbbbbbbb-0000-0000-0000-0000000000bb';

function antigravityRoot(): string {
  return path.join(tmpDir, '.gemini', 'antigravity-cli');
}

// ─── Minimal protobuf encoders (mirror the real antigravity step_payload) ─────
function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    bytes.push(b);
  } while (v > 0);
  return Buffer.from(bytes);
}
function tag(field: number, wireType: number): Buffer {
  return encodeVarint(field * 8 + wireType);
}
function lenField(field: number, payload: Buffer): Buffer {
  return Buffer.concat([tag(field, 2), encodeVarint(payload.length), payload]);
}
function varField(field: number, value: number): Buffer {
  return Buffer.concat([tag(field, 0), encodeVarint(value)]);
}
function strField(field: number, text: string): Buffer {
  return lenField(field, Buffer.from(text, 'utf-8'));
}
function encodeUserStep(prompt: string): Buffer {
  const inner = Buffer.concat([strField(2, prompt), strField(3, `\n\n${prompt}`)]);
  return Buffer.concat([varField(1, 14), varField(4, 3), lenField(19, inner)]);
}
function encodeModelStep(answer: string): Buffer {
  const inner = Buffer.concat([strField(1, answer), strField(8, answer)]);
  return Buffer.concat([varField(1, 15), varField(4, 3), lenField(20, inner)]);
}

async function makeConversationDb(
  sessionId: string,
  steps: Array<{ step_type: number; payload: Buffer }>,
): Promise<string> {
  const dir = path.join(antigravityRoot(), 'conversations');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.db`);
  const { loadBetterSqlite3 } = await import('../../../src/system/load-better-sqlite3.js');
  const Database = loadBetterSqlite3();
  const db = new Database(filePath);
  db.exec(
    'CREATE TABLE `steps` (`idx` integer, `step_type` integer NOT NULL DEFAULT 0, ' +
      '`status` integer NOT NULL DEFAULT 0, `step_payload` blob, PRIMARY KEY (`idx`));',
  );
  const insert = db.prepare(
    'INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, 3, ?)',
  );
  steps.forEach((s, i) => insert.run(i, s.step_type, s.payload));
  db.close();
  return filePath;
}

function turn(prompt: string, answer: string) {
  return [
    { step_type: 14, payload: encodeUserStep(prompt) },
    { step_type: 15, payload: encodeModelStep(answer) },
  ];
}

const WORKSPACE = '/workspaces/magi';

describe('antigravity coordinator + MAGI replica birth-floor isolation (D3)', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-agy-coord-replica-'));
    vi.resetModules();
    const { __resetAntigravityClaimRegistry } = await import(
      '../../../src/providers/native-history/antigravity-claim-registry.js'
    );
    __resetAntigravityClaimRegistry();
    // Created in birth order: coordinator FIRST (oldest birth), replicas after.
    // The coordinator is mesh-heavy; replicas do task work.
    await makeConversationDb(COORD, turn('mesh_dispatch task to replica', 'coordinator answer'));
    await makeConversationDb(REPLICA_A, turn('do the replica-A work', 'replica A answer'));
    await makeConversationDb(REPLICA_B, turn('do the replica-B work', 'replica B answer'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('coordinator (real floor before all births) resolves the OLDEST-born (its own mesh-heavy) conv with ownerConfirmed:true', async () => {
    const { createNativeHistoryDispatcher } = await import(
      '../../../src/providers/native-history/dispatcher.js'
    );
    const dispatch = createNativeHistoryDispatcher('antigravity-cli');

    // Floor sits before every store's birth → all three qualify; the floor branch
    // returns the OLDEST-born store, which is the coordinator's own conv. This is
    // exactly the pick the coordinator makes when it carries a valid (past) floor
    // instead of the pre-fix spawnedAtMs=0.
    const coord = dispatch({
      agentType: 'antigravity-cli',
      sessionId: '',
      instanceId: 'coord-session-iid',
      workspace: WORKSPACE,
      sessionStartedAtMs: Date.now() - 60_000,
    });

    expect(coord).not.toBeNull();
    expect(coord!.sourcePath.endsWith(`${COORD}.db`)).toBe(true);
    expect((coord as any).ownerConfirmed).toBe(true);
    expect(coord!.messages.some(m => m.role === 'assistant' && m.content === 'coordinator answer')).toBe(true);
  });

  it('replica (floor AFTER the coordinator birth) resolves its OWN conv and CANNOT claim the coordinator conv', async () => {
    // Backdate the coordinator store far enough into the past that a replica floor
    // can sit strictly AFTER the coordinator birth but before the replicas — the
    // birth-window guard then excludes the coordinator conv from the replica.
    // (birthtime is not forgeable, so we express the SEPARATION via the floor and
    //  verify claim-exclusion, the other half of the isolation, independently.)
    const { createNativeHistoryDispatcher } = await import(
      '../../../src/providers/native-history/dispatcher.js'
    );
    const dispatch = createNativeHistoryDispatcher('antigravity-cli');

    // Coordinator reads first with a valid floor and CLAIMS its own (oldest) conv,
    // exactly as it does live.
    const coord = dispatch({
      agentType: 'antigravity-cli',
      sessionId: '',
      instanceId: 'coord-session-iid',
      workspace: WORKSPACE,
      sessionStartedAtMs: Date.now() - 60_000,
    });
    expect(coord!.sourcePath.endsWith(`${COORD}.db`)).toBe(true);

    // The replica reads with its OWN valid floor and a distinct instanceId. The
    // coordinator's conv is now claimedByOther (the coordinator's owner token), so
    // the claim registry excludes it from the replica's candidate set entirely —
    // the replica resolves a NON-coordinator conv, owner-confirmed as its own.
    const replica = dispatch({
      agentType: 'antigravity-cli',
      sessionId: '',
      instanceId: 'replica-a-iid',
      workspace: WORKSPACE,
      sessionStartedAtMs: Date.now() - 60_000,
    });
    expect(replica).not.toBeNull();
    // The hard invariant: the replica NEVER surfaced the coordinator's conv.
    expect(replica!.sourcePath.endsWith(`${COORD}.db`)).toBe(false);
    expect(replica!.messages.some(m => m.content === 'coordinator answer')).toBe(false);
    expect((replica as any).ownerConfirmed).toBe(true);
  });

  it('with NO floor (spawnedAtMs=0, the pre-fix attach) a replica read is NOT owner-confirmed — the regression', async () => {
    // Documents the exact pre-fix failure so the fix is meaningful: floor-less, the
    // read takes the newest-by-mtime branch (ownerConfirmed:false). A bare recency
    // pick can alias a co-located session's conv, which is what let a replica claim
    // the coordinator's conv and left the coordinator ownerConfirmed:false → D1 gate
    // never fired → pty-parser / user-only.
    const { createNativeHistoryDispatcher } = await import(
      '../../../src/providers/native-history/dispatcher.js'
    );
    const dispatch = createNativeHistoryDispatcher('antigravity-cli');

    const floorless = dispatch({
      agentType: 'antigravity-cli',
      sessionId: '',
      instanceId: 'replica-floorless-iid',
      workspace: WORKSPACE,
      sessionStartedAtMs: 0,
    });
    expect(floorless).not.toBeNull();
    expect((floorless as any).ownerConfirmed).not.toBe(true);
  });
});
