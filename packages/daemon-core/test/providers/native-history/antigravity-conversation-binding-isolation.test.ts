/**
 * Regression: antigravity conversation-binding isolation.
 *
 * Two concurrent antigravity-cli sessions on ONE daemon each write their own
 * conversations/<uuid>.db, but before either resolved its provider session id
 * the discovery fallback picked "the newest .db on disk by mtime" — so two
 * sessions started a few ms apart both grabbed the SAME store and their inputs
 * / completions cross-routed (RCA: a coordinator session read the owner's
 * conversation, and its own injected instruction was absent from the bound db).
 *
 * The fix binds+locks each session to a distinct conversation via a daemon-local
 * claim registry plus a spawn-window guard. These tests exercise that through
 * the dispatcher — the layer the live daemon calls — and directly against the
 * registry primitives.
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

const SESSION_A = 'aaaaaaaa-1111-0000-0000-000000000001';
const SESSION_B = 'bbbbbbbb-2222-0000-0000-000000000002';

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

describe('antigravity conversation-binding isolation', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-agy-isolation-'));
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('(a) two concurrent unbound sessions never resolve to the same conversation uuid', async () => {
    // Two conversations exist on disk; both sessions read UNBOUND (no sessionId
    // yet) in the same workspace, started ~94ms apart. Without the claim registry
    // both would grab the newest .db; with it, the second must be excluded from
    // the conversation the first already claimed.
    await makeConversationDb(SESSION_A, turn('prompt A', 'answer A'));
    await makeConversationDb(SESSION_B, turn('prompt B', 'answer B'));

    const { createNativeHistoryDispatcher } = await import(
      '../../../src/providers/native-history/dispatcher.js'
    );
    const dispatch = createNativeHistoryDispatcher('antigravity-cli');

    const startedA = Date.now() - 1000;
    const startedB = startedA + 94; // sibling spawned 94ms later — distinct owner

    const a = dispatch({ agentType: 'antigravity-cli', sessionId: '', workspace: '/workspaces/agy', sessionStartedAtMs: startedA });
    const b = dispatch({ agentType: 'antigravity-cli', sessionId: '', workspace: '/workspaces/agy', sessionStartedAtMs: startedB });

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // The hard invariant: the two sessions resolved to DIFFERENT conversations.
    expect(a!.providerSessionId).not.toBe(b!.providerSessionId);
    expect(new Set([a!.providerSessionId, b!.providerSessionId]).size).toBe(2);
    // And each surfaces its OWN store's answer, never a shared one.
    expect(a!.sourcePath).not.toBe(b!.sourcePath);
  });

  it('(b) a locked (bound) session does not re-bind to a newer .db on a later read', async () => {
    // Session bound to SESSION_A. A newer conversation SESSION_B.db then appears
    // (newer mtime). A bound read must stay on SESSION_A — never chase the newer
    // store the way the old newest-by-mtime fallback did.
    await makeConversationDb(SESSION_A, turn('bound prompt', 'bound answer'));
    // SESSION_B written afterwards → newer mtime than SESSION_A.
    await makeConversationDb(SESSION_B, turn('other prompt', 'other answer'));

    const { createNativeHistoryDispatcher } = await import(
      '../../../src/providers/native-history/dispatcher.js'
    );
    const dispatch = createNativeHistoryDispatcher('antigravity-cli');

    const result = dispatch({
      agentType: 'antigravity-cli',
      sessionId: SESSION_A,
      providerSessionId: SESSION_A,
      workspace: '/workspaces/agy',
      sessionStartedAtMs: Date.now() - 5000,
    });

    expect(result).not.toBeNull();
    expect(result!.providerSessionId).toBe(SESSION_A);
    expect(result!.sourcePath.endsWith(`${SESSION_A}.db`)).toBe(true);
    expect(result!.messages.some(m => m.role === 'assistant' && m.content === 'bound answer')).toBe(true);
    expect(result!.messages.some(m => m.content === 'other answer')).toBe(false);
  });

  it('(c) a single unbound session still resolves its own conversation (no regression)', async () => {
    await makeConversationDb(SESSION_A, turn('solo prompt', 'solo answer'));

    const { createNativeHistoryDispatcher } = await import(
      '../../../src/providers/native-history/dispatcher.js'
    );
    const dispatch = createNativeHistoryDispatcher('antigravity-cli');

    const result = dispatch({
      agentType: 'antigravity-cli',
      sessionId: '',
      workspace: '/workspaces/agy',
      sessionStartedAtMs: Date.now() - 500, // store created ~now, within spawn window
    });

    expect(result).not.toBeNull();
    expect(result!.providerSessionId).toBe(SESSION_A);
    expect(result!.messages.some(m => m.role === 'assistant' && m.content === 'solo answer')).toBe(true);
  });

  it('(d) spawn-window guard: does not bind to a store that predates this session\'s spawn', async () => {
    // The only store on disk was created BEFORE this session spawned (simulated
    // by a spawn floor in the future relative to the store). It belongs to an
    // earlier session — the resolver must return null (native_history_empty)
    // rather than mis-bind to a sibling's conversation.
    await makeConversationDb(SESSION_A, turn('earlier prompt', 'earlier answer'));

    const { createNativeHistoryDispatcher } = await import(
      '../../../src/providers/native-history/dispatcher.js'
    );
    const dispatch = createNativeHistoryDispatcher('antigravity-cli');

    const result = dispatch({
      agentType: 'antigravity-cli',
      sessionId: '',
      workspace: '/workspaces/agy',
      sessionStartedAtMs: Date.now() + 60_000, // spawned "after" the store existed
    });

    expect(result).toBeNull();
  });
});

describe('antigravity-claim-registry primitives', () => {
  beforeEach(() => { vi.resetModules(); });

  it('excludes a conversation claimed by a different owner, allows the same owner, releases on owner shutdown', async () => {
    const {
      claimAntigravityConversation,
      isAntigravityConversationClaimedByOther,
      antigravityConversationOwner,
      releaseAntigravityOwner,
      antigravityOwnerToken,
      __resetAntigravityClaimRegistry,
    } = await import('../../../src/providers/native-history/antigravity-claim-registry.js');
    __resetAntigravityClaimRegistry();

    const ownerA = antigravityOwnerToken('/ws', 1000);
    const ownerB = antigravityOwnerToken('/ws', 1094);
    expect(ownerA).not.toBe(ownerB);

    // First claim wins.
    expect(claimAntigravityConversation(SESSION_A, ownerA)).toBe(true);
    // A different owner is excluded and cannot steal it.
    expect(isAntigravityConversationClaimedByOther(SESSION_A, ownerB)).toBe(true);
    expect(claimAntigravityConversation(SESSION_A, ownerB)).toBe(false);
    expect(antigravityConversationOwner(SESSION_A)).toBe(ownerA);
    // The owning session sees no conflict and may re-affirm.
    expect(isAntigravityConversationClaimedByOther(SESSION_A, ownerA)).toBe(false);
    expect(claimAntigravityConversation(SESSION_A, ownerA)).toBe(true);

    // Shutdown releases the claim; the conversation is now free for ownerB.
    releaseAntigravityOwner(ownerA);
    expect(antigravityConversationOwner(SESSION_A)).toBeUndefined();
    expect(claimAntigravityConversation(SESSION_A, ownerB)).toBe(true);
  });

  it('reclaims a stale claim whose owner never released it', async () => {
    const {
      claimAntigravityConversation,
      isAntigravityConversationClaimedByOther,
      antigravityOwnerToken,
      CLAIM_STALE_MS,
      __resetAntigravityClaimRegistry,
    } = await import('../../../src/providers/native-history/antigravity-claim-registry.js');
    __resetAntigravityClaimRegistry();

    const dead = antigravityOwnerToken('/ws', 1000);
    const live = antigravityOwnerToken('/ws', 2000);
    const t0 = 1_000_000;
    expect(claimAntigravityConversation(SESSION_A, dead, t0)).toBe(true);
    // Just before the stale window: still owned.
    expect(isAntigravityConversationClaimedByOther(SESSION_A, live, t0 + CLAIM_STALE_MS - 1)).toBe(true);
    // Past the stale window: the dead owner's claim ages out and a live session may take it.
    expect(isAntigravityConversationClaimedByOther(SESSION_A, live, t0 + CLAIM_STALE_MS + 1)).toBe(false);
    expect(claimAntigravityConversation(SESSION_A, live, t0 + CLAIM_STALE_MS + 1)).toBe(true);
  });

  it('instance-side and read-side owner tokens AGREE when keyed on the same instanceId (crosswire regression)', async () => {
    const { antigravityOwnerToken } = await import('../../../src/providers/native-history/antigravity-claim-registry.js');

    // The one session is observed at three sites, each sampling Date.now()
    // independently: the provider instance's startedAt, the adapter's
    // spawnedAtMs, and the session registry's spawnedAtMs. These never match.
    const instanceStartedAt = 1000;      // cli-provider-instance this.startedAt
    const registrySpawnedAtMs = 1042;    // sessions/registry spawnedAtMs (read side)

    // Instance side (dispose/claim) derives its owner token; read side derives
    // its token from the registry spawn time. Both now pass the SAME instanceId
    // (== the session registry's sessionId), so both resolve to `iid:<id>` and
    // the spawn-time divergence is irrelevant.
    const instanceOwner = antigravityOwnerToken('/workspaces/agy', instanceStartedAt, SESSION_A);
    const readOwner = antigravityOwnerToken('/workspaces/agy', registrySpawnedAtMs, SESSION_A);
    expect(instanceOwner).toBe(`iid:${SESSION_A}`);
    expect(readOwner).toBe(instanceOwner);

    // Two distinct sessions still get distinct tokens (isolation preserved).
    const otherOwner = antigravityOwnerToken('/workspaces/agy', registrySpawnedAtMs, SESSION_B);
    expect(otherOwner).toBe(`iid:${SESSION_B}`);
    expect(otherOwner).not.toBe(instanceOwner);

    // Guard the original defect: WITHOUT the instanceId, the same session's
    // instance-side and read-side tokens diverge because the spawn samples
    // differ — the state that silently broke claim isolation.
    const legacyInstance = antigravityOwnerToken('/workspaces/agy', instanceStartedAt);
    const legacyRead = antigravityOwnerToken('/workspaces/agy', registrySpawnedAtMs);
    expect(legacyInstance).not.toBe(legacyRead);
  });
});
