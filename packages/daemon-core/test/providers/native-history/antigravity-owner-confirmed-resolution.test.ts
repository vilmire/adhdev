/** Owner confirmation requires an accepted handle or unique sent input. */

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

const OWNER = 'aaaaaaaa-1111-4000-8000-000000000001';
const REPLICA = 'bbbbbbbb-2222-4000-8000-000000000002';

function antigravityRoot(): string {
  return path.join(tmpDir, '.gemini', 'antigravity-cli');
}

// ─── protobuf encoders (mirror antigravity step_payload; shared with sibling test) ─
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
function tag(field: number, wireType: number): Buffer { return encodeVarint(field * 8 + wireType); }
function lenField(field: number, payload: Buffer): Buffer { return Buffer.concat([tag(field, 2), encodeVarint(payload.length), payload]); }
function varField(field: number, value: number): Buffer { return Buffer.concat([tag(field, 0), encodeVarint(value)]); }
function strField(field: number, text: string): Buffer { return lenField(field, Buffer.from(text, 'utf-8')); }
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
  const insert = db.prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, 3, ?)');
  steps.forEach((s, i) => insert.run(i, s.step_type, s.payload));
  db.close();
  return filePath;
}

function ownerSteps(tag: string) {
  return [
    { step_type: 14, payload: encodeUserStep(`${tag} prompt`) },
    { step_type: 15, payload: encodeModelStep(`${tag} answer`) },
  ];
}

describe('antigravity dispatcher — ownerConfirmed signal', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-agy-ownerconf-'));
    vi.resetModules();
  });
  afterEach(async () => {
    const { __resetAntigravityClaimRegistry } = await import(
      '../../../src/providers/native-history/antigravity-claim-registry.js'
    );
    __resetAntigravityClaimRegistry();
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('exact uuid bind → ownerConfirmed=true', async () => {
    await makeConversationDb(OWNER, ownerSteps('owner'));
    const { createNativeHistoryDispatcher } = await import('../../../src/providers/native-history/dispatcher.js');
    const dispatch = createNativeHistoryDispatcher('antigravity-cli');
    const result = dispatch({
      agentType: 'antigravity-cli',
      sessionId: OWNER,          // exact uuid bind
      workspace: '/workspaces/agy',
      instanceId: 'coordinator-instance-1',
    });
    expect(result).not.toBeNull();
    expect(result!.providerSessionId).toBe(OWNER);
    expect(result!.ownerConfirmed).toBe(true);
  });

  it('sent-input evidence confirms a store within the spawn floor', async () => {
    const ownerPath = await makeConversationDb(OWNER, ownerSteps('owner'));
    const { recordSentPrompt } = await import('../../../src/providers/native-history/sent-prompt-registry.js');
    recordSentPrompt('coordinator-instance-1', 'owner prompt');
    const ownerBirthMs = Math.floor(fs.statSync(ownerPath).birthtimeMs || fs.statSync(ownerPath).mtimeMs);

    const { createNativeHistoryDispatcher } = await import('../../../src/providers/native-history/dispatcher.js');
    const dispatch = createNativeHistoryDispatcher('antigravity-cli');
    const result = dispatch({
      agentType: 'antigravity-cli',
      sessionId: '',                              // no exact uuid — discovery
      workspace: '/workspaces/agy',
      sessionStartedAtMs: ownerBirthMs - 500,     // floor just before the owner db was born
      instanceId: 'coordinator-instance-1',
    });
    expect(result).not.toBeNull();
    expect(result!.providerSessionId).toBe(OWNER);
    // The sent input confirms ownership; birth time only excludes older stores.
    expect(result!.ownerConfirmed).toBe(true);
  });

  it('a spawn floor without sent input cannot confirm or claim a store', async () => {
    await makeConversationDb(OWNER, ownerSteps('owner'));
    const { createNativeHistoryDispatcher } = await import('../../../src/providers/native-history/dispatcher.js');
    const { antigravityConversationOwner } = await import('../../../src/providers/native-history/antigravity-claim-registry.js');
    expect(createNativeHistoryDispatcher('antigravity-cli')({ instanceId: 'coordinator', workspace: '/ws', sessionStartedAtMs: Date.now() - 1000 })).toBeNull();
    expect(antigravityConversationOwner(OWNER)).toBeUndefined();
  });

  it('a rejected exact claim never returns an owner-confirmed result', async () => {
    await makeConversationDb(OWNER, ownerSteps('owner'));
    const claims = await import('../../../src/providers/native-history/antigravity-claim-registry.js');
    vi.spyOn(claims, 'claimAntigravityConversation').mockReturnValue(false);
    const { createNativeHistoryDispatcher } = await import('../../../src/providers/native-history/dispatcher.js');
    expect(createNativeHistoryDispatcher('antigravity-cli')({ sessionId: OWNER, instanceId: 'coordinator', workspace: '/ws' })).toBeNull();
  });

  it('spawn-floor excludes a store born BEFORE the floor (a replica\'s prior store is never bound)', async () => {
    // Replica store born well before this session's spawn floor: the floor filter
    // must exclude it, so discovery returns null (native_history_empty) rather than
    // binding a sibling's conversation. This is the crosswire guard at the resolver.
    const replicaPath = await makeConversationDb(REPLICA, ownerSteps('replica'));
    const { recordSentPrompt } = await import('../../../src/providers/native-history/sent-prompt-registry.js');
    recordSentPrompt('coordinator-instance-1', 'replica prompt');
    const replicaBirthMs = Math.floor(fs.statSync(replicaPath).birthtimeMs || fs.statSync(replicaPath).mtimeMs);

    const { createNativeHistoryDispatcher } = await import('../../../src/providers/native-history/dispatcher.js');
    const dispatch = createNativeHistoryDispatcher('antigravity-cli');
    const result = dispatch({
      agentType: 'antigravity-cli',
      sessionId: '',
      workspace: '/workspaces/agy',
      // Floor set 10s AFTER the replica store was born → replica excluded, and no
      // own store exists yet → null (this session waits for its own store).
      sessionStartedAtMs: replicaBirthMs + 10_000,
      instanceId: 'coordinator-instance-1',
    });
    expect(result).toBeNull();
  });

  it('floor-less read without sent evidence returns no native choice', async () => {
    await makeConversationDb(OWNER, ownerSteps('owner'));
    const { createNativeHistoryDispatcher } = await import('../../../src/providers/native-history/dispatcher.js');
    const dispatch = createNativeHistoryDispatcher('antigravity-cli');
    const result = dispatch({
      agentType: 'antigravity-cli',
      sessionId: '',
      workspace: '/workspaces/agy',
      // sessionStartedAtMs omitted → floor-less discovery.
      instanceId: 'coordinator-instance-1',
    });
    expect(result).toBeNull();
  });
});
