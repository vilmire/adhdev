/** Native ownership requires sent-input attribution before exclusive claims. */

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

  for (const format of ['db', 'brain'] as const) {
    async function store(uuid: string, prompt: string) {
      if (format === 'db') return makeConversationDb(uuid, turn(prompt, 'answer'));
      const dir = path.join(antigravityRoot(), 'brain', uuid, '.system_generated', 'logs');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'transcript.jsonl'), [
        { source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: prompt },
        { source: 'MODEL', type: 'MODEL_RESPONSE', status: 'DONE', content: 'answer' },
      ].map(row => JSON.stringify(row)).join('\n'));
    }

    it.each(['workspace', 'task'])(`${format}: common worker wrappers differing by %s require full sent input`, async (difference) => {
      const { recordSentPrompt } = await import('../../../src/providers/native-history/sent-prompt-registry.js');
      const { createNativeHistoryDispatcher } = await import('../../../src/providers/native-history/dispatcher.js');
      const wrapper = 'You are a delegated worker. Follow the worker protocol and preserve all existing sessions.\n';
      const a = wrapper + 'Workspace: /ws/a\nTask: task-a fix the admission guard';
      const b = wrapper + (difference === 'workspace' ? 'Workspace: /ws/b\nTask: task-a fix the admission guard' : 'Workspace: /ws/a\nTask: task-b recover CI');
      recordSentPrompt('a', a);
      recordSentPrompt('b', b);
      await store(SESSION_B, b);
      await store(SESSION_A, a);
      const dispatch = createNativeHistoryDispatcher('antigravity-cli');
      const input = { workspace: '/ws/a', sessionStartedAtMs: Date.now() - 1000 };
      expect(dispatch({ ...input, instanceId: 'a' })).toMatchObject({ providerSessionId: SESSION_A, ownerConfirmed: true });
      expect(dispatch({ ...input, instanceId: 'b', workspace: difference === 'workspace' ? '/ws/b' : '/ws/a' })).toMatchObject({ providerSessionId: SESSION_B, ownerConfirmed: true });
    });

    it(`${format}: old unbound runtime cannot steal a worker store; delayed first store recovers`, async () => {
      const { recordSentPrompt } = await import('../../../src/providers/native-history/sent-prompt-registry.js');
      const { antigravityConversationOwner } = await import('../../../src/providers/native-history/antigravity-claim-registry.js');
      const { createNativeHistoryDispatcher } = await import('../../../src/providers/native-history/dispatcher.js');
      recordSentPrompt('old', 'Older runtime task: unrelated CI recovery');
      recordSentPrompt('worker', 'Worker task: fix-autolaunch-admission-guard task d015');
      await store(SESSION_A, 'Worker task: fix-autolaunch-admission-guard task d015');
      const dispatch = createNativeHistoryDispatcher('antigravity-cli');
      const old = { instanceId: 'old', workspace: '/ws', sessionStartedAtMs: Date.now() - 60000 };
      expect(dispatch(old)).toBeNull();
      expect(antigravityConversationOwner(SESSION_A)).toBeUndefined();
      expect(dispatch({ instanceId: 'worker', workspace: '/ws', sessionStartedAtMs: Date.now() - 1000 })).toMatchObject({ providerSessionId: SESSION_A, ownerConfirmed: true });
      await store(SESSION_B, 'Older runtime task: unrelated CI recovery');
      expect(dispatch(old)).toMatchObject({ providerSessionId: SESSION_B, ownerConfirmed: true });
    });

    it(`${format}: ambiguous matching conversations produce no choice or claims`, async () => {
      const { recordSentPrompt } = await import('../../../src/providers/native-history/sent-prompt-registry.js');
      const { createNativeHistoryDispatcher } = await import('../../../src/providers/native-history/dispatcher.js');
      const { antigravityConversationOwner } = await import('../../../src/providers/native-history/antigravity-claim-registry.js');
      recordSentPrompt('a', 'Identical task input with no unique conversation');
      await store(SESSION_A, 'Identical task input with no unique conversation');
      await store(SESSION_B, 'Identical task input with no unique conversation');
      expect(createNativeHistoryDispatcher('antigravity-cli')({ instanceId: 'a', workspace: '/ws', sessionStartedAtMs: Date.now() - 1000 })).toBeNull();
      expect(antigravityConversationOwner(SESSION_A)).toBeUndefined();
      expect(antigravityConversationOwner(SESSION_B)).toBeUndefined();
    });

    it(`${format}: a store containing different owners' sent inputs is ambiguous`, async () => {
      const { recordSentPrompt } = await import('../../../src/providers/native-history/sent-prompt-registry.js');
      recordSentPrompt('a', 'Workspace /ws/a task admission guard');
      recordSentPrompt('b', 'Workspace /ws/b task CI recovery');
      await store(SESSION_A, 'Workspace /ws/a task admission guard\nWorkspace /ws/b task CI recovery');
      const { createNativeHistoryDispatcher } = await import('../../../src/providers/native-history/dispatcher.js');
      const { antigravityConversationOwner } = await import('../../../src/providers/native-history/antigravity-claim-registry.js');
      expect(createNativeHistoryDispatcher('antigravity-cli')({ instanceId: 'a', workspace: '/ws/a' })).toBeNull();
      expect(antigravityConversationOwner(SESSION_A)).toBeUndefined();
    });

    it(`${format}: authoritative handle works without sent evidence and respects providerSessionId`, async () => {
      await store(SESSION_A, 'Authoritative handle task');
      const { createNativeHistoryDispatcher } = await import('../../../src/providers/native-history/dispatcher.js');
      const dispatch = createNativeHistoryDispatcher('antigravity-cli');
      expect(dispatch({ sessionId: SESSION_A, instanceId: 'a', workspace: '/ws' })).toMatchObject({ providerSessionId: SESSION_A, ownerConfirmed: true });
      expect(dispatch({ sessionId: 'runtime-id', providerSessionId: SESSION_A, instanceId: 'a', workspace: '/ws' })).toMatchObject({ providerSessionId: SESSION_A, ownerConfirmed: true });
    });

    it(`${format}: exact UUID cannot override a rejected claim`, async () => {
      await store(SESSION_A, 'Authoritative handle task');
      const { claimAntigravityConversation, antigravityConversationOwner } = await import('../../../src/providers/native-history/antigravity-claim-registry.js');
      claimAntigravityConversation(SESSION_A, 'iid:other');
      const { createNativeHistoryDispatcher } = await import('../../../src/providers/native-history/dispatcher.js');
      expect(createNativeHistoryDispatcher('antigravity-cli')({ sessionId: SESSION_A, instanceId: 'a', workspace: '/ws' })).toBeNull();
      expect(antigravityConversationOwner(SESSION_A)).toBe('iid:other');
    });
  }

  it('assistant text quoting sent input cannot establish ownership', async () => {
    const { recordSentPrompt } = await import('../../../src/providers/native-history/sent-prompt-registry.js');
    recordSentPrompt('a', 'Workspace /ws/a task admission guard');
    await makeConversationDb(SESSION_A, turn('An unrelated task input', 'Workspace /ws/a task admission guard'));
    const { createNativeHistoryDispatcher } = await import('../../../src/providers/native-history/dispatcher.js');
    expect(createNativeHistoryDispatcher('antigravity-cli')({ instanceId: 'a', workspace: '/ws/a' })).toBeNull();
  });

  it('a missing explicit provider handle never claims a different matching store', async () => {
    const { recordSentPrompt } = await import('../../../src/providers/native-history/sent-prompt-registry.js');
    const { createNativeHistoryDispatcher } = await import('../../../src/providers/native-history/dispatcher.js');
    const { antigravityConversationOwner } = await import('../../../src/providers/native-history/antigravity-claim-registry.js');
    recordSentPrompt('a', 'A task with a missing persisted handle');
    await makeConversationDb(SESSION_A, turn('A task with a missing persisted handle', 'answer'));
    expect(createNativeHistoryDispatcher('antigravity-cli')({ instanceId: 'a', providerSessionId: SESSION_B, workspace: '/ws' })).toBeNull();
    expect(antigravityConversationOwner(SESSION_A)).toBeUndefined();
  });

  it('DB and brain for different matching UUIDs stay ambiguous across layouts', async () => {
    const prompt = 'Cross-layout task input requiring one conversation';
    await makeConversationDb(SESSION_A, turn(prompt, 'DB answer'));
    const dir = path.join(antigravityRoot(), 'brain', SESSION_B, '.system_generated', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcript.jsonl'), JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: prompt }));
    const { recordSentPrompt } = await import('../../../src/providers/native-history/sent-prompt-registry.js');
    recordSentPrompt('a', prompt);
    const { createNativeHistoryDispatcher } = await import('../../../src/providers/native-history/dispatcher.js');
    expect(createNativeHistoryDispatcher('antigravity-cli')({ instanceId: 'a', workspace: '/ws' })).toBeNull();
  });

  it('identical inputs sent by different runtimes cannot prove an owner; release clears evidence', async () => {
    const { recordSentPrompt, releaseSentPrompts } = await import('../../../src/providers/native-history/sent-prompt-registry.js');
    const { createNativeHistoryDispatcher } = await import('../../../src/providers/native-history/dispatcher.js');
    const prompt = 'A common instruction sent to multiple workers';
    recordSentPrompt('a', prompt);
    recordSentPrompt('b', prompt);
    await makeConversationDb(SESSION_A, turn(prompt, 'answer'));
    const dispatch = createNativeHistoryDispatcher('antigravity-cli');
    expect(dispatch({ instanceId: 'a', workspace: '/ws' })).toBeNull();
    releaseSentPrompts('a');
    releaseSentPrompts('b');
    expect(dispatch({ instanceId: 'a', workspace: '/ws' })).toBeNull();
  });

  it('(a) two concurrent unbound sessions never resolve to the same conversation uuid', async () => {
    // Two conversations exist on disk; both sessions read UNBOUND (no provider
    // conv id yet) in the same workspace, started ~94ms apart. Each carries its
    // own stable instanceId and sent input. Read order must not choose identity.
    await makeConversationDb(SESSION_A, turn('prompt A', 'answer A'));
    await makeConversationDb(SESSION_B, turn('prompt B', 'answer B'));

    const { createNativeHistoryDispatcher } = await import(
      '../../../src/providers/native-history/dispatcher.js'
    );
    const dispatch = createNativeHistoryDispatcher('antigravity-cli');

    const { recordSentPrompt } = await import('../../../src/providers/native-history/sent-prompt-registry.js');
    recordSentPrompt('agy-session-a', 'prompt A');
    recordSentPrompt('agy-session-b', 'prompt B');
    const startedA = Date.now() - 1000;
    const startedB = startedA + 94; // sibling spawned 94ms later

    const a = dispatch({ agentType: 'antigravity-cli', sessionId: '', instanceId: 'agy-session-a', workspace: '/workspaces/agy', sessionStartedAtMs: startedA });
    const b = dispatch({ agentType: 'antigravity-cli', sessionId: '', instanceId: 'agy-session-b', workspace: '/workspaces/agy', sessionStartedAtMs: startedB });

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
    const { recordSentPrompt } = await import('../../../src/providers/native-history/sent-prompt-registry.js');
    recordSentPrompt('solo', 'solo prompt');

    const { createNativeHistoryDispatcher } = await import(
      '../../../src/providers/native-history/dispatcher.js'
    );
    const dispatch = createNativeHistoryDispatcher('antigravity-cli');

    const result = dispatch({
      agentType: 'antigravity-cli',
      sessionId: '',
      workspace: '/workspaces/agy',
      instanceId: 'solo',
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
    const { recordSentPrompt } = await import('../../../src/providers/native-history/sent-prompt-registry.js');
    recordSentPrompt('later', 'earlier prompt');

    const { createNativeHistoryDispatcher } = await import(
      '../../../src/providers/native-history/dispatcher.js'
    );
    const dispatch = createNativeHistoryDispatcher('antigravity-cli');

    const result = dispatch({
      agentType: 'antigravity-cli',
      sessionId: '',
      workspace: '/workspaces/agy',
      instanceId: 'later',
      sessionStartedAtMs: Date.now() + 60_000, // spawned "after" the store existed
    });

    expect(result).toBeNull();
  });

  it('(e) idle store past the recency window still binds when sent-input evidence identifies it (ANTIGRAVITY-FINAL-MESSAGE-TAIL-GAP)', async () => {
    // The session's own conversation .db has sat idle far longer than
    // RECENT_WINDOW_MS (5 min). This runtime still has its sent-input evidence,
    // so an unpinned read may recover its idle store without trusting recency.
    // An attached runtime with neither evidence nor an explicit handle waits.
    const dbPath = await makeConversationDb(SESSION_A, turn('idle prompt', 'idle answer'));

    const { recordSentPrompt } = await import('../../../src/providers/native-history/sent-prompt-registry.js');
    recordSentPrompt('idle', 'idle prompt');

    // Backdate the store ~30 min so it is well past the 5-min recency window,
    // while its birth time still sits after the (older) spawn floor below.
    const idleMs = Date.now() - 30 * 60 * 1000;
    const idleSec = idleMs / 1000;
    fs.utimesSync(dbPath, idleSec, idleSec);

    const { createNativeHistoryDispatcher } = await import(
      '../../../src/providers/native-history/dispatcher.js'
    );
    const dispatch = createNativeHistoryDispatcher('antigravity-cli');

    // Spawn floor is OLDER than the store (session started before it wrote its
    // .db), so the birth-time exclusion allows it; sent input proves ownership. Idle age is irrelevant.
    const result = dispatch({
      agentType: 'antigravity-cli',
      sessionId: '',
      workspace: '/workspaces/agy',
      instanceId: 'idle',
      sessionStartedAtMs: idleMs - 60_000,
    });

    expect(result).not.toBeNull();
    expect(result!.sourcePath.endsWith(`${SESSION_A}.db`)).toBe(true);
    expect(result!.messages.some(m => m.role === 'assistant' && m.content === 'idle answer')).toBe(true);
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

    const ownerA = antigravityOwnerToken('/ws', 1000, 'session-A-iid');
    const ownerB = antigravityOwnerToken('/ws', 1094, 'session-B-iid');
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

    const dead = antigravityOwnerToken('/ws', 1000, 'dead-session-iid');
    const live = antigravityOwnerToken('/ws', 2000, 'live-session-iid');
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

    // SSOT invariant: the token is keyed ONLY on the instanceId. Without one it
    // is EMPTY (skip-claim), never a spawn-timestamp token — so the same
    // session's instance-side and read-side reads can no longer produce two
    // DIFFERENT non-empty tokens the way the removed spawn: fallback did (the
    // state that silently broke claim isolation). An empty token means "don't
    // claim", which is strictly safer than a mismatched claim.
    const noIidInstance = antigravityOwnerToken('/workspaces/agy', instanceStartedAt);
    const noIidRead = antigravityOwnerToken('/workspaces/agy', registrySpawnedAtMs);
    expect(noIidInstance).toBe('');
    expect(noIidRead).toBe('');
  });
});
