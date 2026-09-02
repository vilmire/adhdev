/**
 * §8 unit 8 — mcp SEMANTIC transcript consumers (design §4 roster ids 6, 7, 8).
 *
 * These three consumers differ from unit 6's display cutover in that each one
 * derives an IRREVERSIBLE decision from the transcript. So beyond "does the
 * replica answer", this suite pins the ADMISSION GATE — the per-consumer
 * coverage and freshness requirements from §4's roster table and §5.5's
 * semantic-consumer clause — plus the two invariants the design's acceptance
 * checklist names for every consumer commit:
 *
 *   - the roster entry is the ON/OFF switch (flip `enabled:false` → the whole
 *     cutover is inert and the legacy path runs), and
 *   - a defect injected into the snapshot falls back to legacy with an
 *     observable closed-union reason, rather than being parsed anyway.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SEMANTIC_TRANSCRIPT_FRESHNESS_BUDGET_MS,
  readTranscriptReplicaForSemanticConsumer,
} from '../src/tools/mesh-transcript-semantic-read.js';
import {
  rosterIdsForUnit,
  TRANSCRIPT_CONSUMER_ROSTER,
  withRosterEntryDisabled,
} from '../../daemon-core/src/mesh/transcript-read-model-consumers.js';

/** This suite's §8 unit — the roster ids it owns, and the only ones it asserts. */
const UNIT = 8;

const NOW = Date.parse('2026-09-02T00:00:00.000Z');

function snapshot(overrides: Record<string, any> = {}): any {
  return {
    schemaVersion: 1,
    sessionId: 'sess-remote',
    historySessionId: null,
    providerType: 'claude-cli',
    providerSessionId: 'psid-1',
    producerDaemonId: 'daemon-remote',
    producerWriterId: 'writer-1',
    producerEpoch: 'epoch-1',
    revision: 12,
    observedAt: new Date(NOW - 1_000).toISOString(),
    status: 'idle',
    providerObservedStatus: 'idle',
    title: null,
    activeModal: null,
    activeInteractivePrompt: null,
    turn: null,
    provenance: { messageSource: 'native_history', transcriptProvenance: null },
    messages: [
      { role: 'user', kind: 'standard', content: 'do it', receivedAt: 1, timestamp: 1, turnKey: 't1', bubbleState: 'final', senderName: null, toolName: null, streaming: null },
      { role: 'assistant', kind: 'standard', content: 'REPLICA_ANSWER', receivedAt: 2, timestamp: 2, turnKey: 't2', bubbleState: 'final', senderName: null, toolName: null, streaming: null },
    ],
    terminalMarkers: [],
    coverage: { mode: 'current-turn', totalMessageCount: 2, returnedMessageCount: 2, omittedBefore: false },
    ...overrides,
  };
}

/** A transport whose replica read is fully controllable, recording call order. */
function transportFor(opts: { snap?: any; available?: boolean; ready?: boolean; reason?: string } = {}) {
  const calls: string[] = [];
  return {
    calls,
    async command(type: string) {
      calls.push(type);
      if (type === 'ensure_transcript_subscription') {
        return opts.ready === false
          ? { success: true, ready: false, reason: opts.reason ?? 'ipc_unavailable' }
          : { success: true, ready: true };
      }
      if (type === 'read_transcript_replica') {
        return opts.available === false
          ? { success: true, available: false, reason: opts.reason ?? 'no_complete_revision' }
          : { success: true, available: true, snapshot: opts.snap ?? snapshot(), identity: { revision: 12 } };
      }
      throw new Error(`unexpected command ${type}`);
    },
  };
}

const BASE = { ownerDaemonId: 'daemon-remote', rawSessionId: 'sess-remote', nowMs: NOW };

// ── the roster is the switch (design §4: "roster 밖 코드는 replica를 읽을 수 없다") ──

test('this unit owns roster ids 6-8, and the shipped roster has them enabled', () => {
  // ★ Scoped to THIS unit's ids, derived from the roster's own ownership field
  // rather than hardcoded — so a future unit enabling ITS id does not touch
  // this suite. The complete enabled set (all 8) is asserted once, by
  // daemon-core's test/mesh/transcript-read-model-consumers.test.ts, which also
  // enforces that no per-unit suite asserts a foreign id. See the roster
  // module header's "Test authority" note.
  const owned = rosterIdsForUnit(UNIT);
  assert.deepEqual([...owned], ['mcp_mesh_status_reconciliation', 'magi_approval_probe', 'magi_result_collect']);
  for (const id of owned) {
    assert.equal(TRANSCRIPT_CONSUMER_ROSTER[id].enabled, true, `roster id ${id}`);
  }
});

test('a disabled roster id declines BEFORE any IPC — the cutover is fully inert when flipped off', async () => {
  // ★ The roster is fully enabled now that units 7 and 8 have both landed, so
  // this cannot borrow a still-disabled id as a stand-in (it did while unit 7
  // was in flight, which coupled this assertion to another unit's progress).
  // Injecting the roster instead pins the BEHAVIOUR — "enabled:false means no
  // IPC at all" — independently of which ids happen to be enabled today. The
  // preceding test is what keeps the injected stub honest about shipped state.
  const t = transportFor();
  const outcome = await readTranscriptReplicaForSemanticConsumer(t, {
    ...BASE,
    consumerId: 'magi_result_collect',
    acceptCoverage: ['full', 'tail', 'current-turn'],
    requireFresh: false,
    roster: withRosterEntryDisabled('magi_result_collect'),
  });
  assert.equal(outcome.payload, null);
  assert.equal(outcome.fallbackReason, 'consumer_not_enabled');
  assert.deepEqual(t.calls, [], 'a disabled consumer must not touch the IPC at all');
});

// ── the happy path for each consumer ────────────────────────────────────────

test('roster id 6 (status reconciliation) serves a read_chat-shaped payload the existing parser can read', async () => {
  const outcome = await readTranscriptReplicaForSemanticConsumer(transportFor(), {
    ...BASE,
    consumerId: 'mcp_mesh_status_reconciliation',
    acceptCoverage: ['full', 'current-turn'],
    requireFresh: true,
  });
  assert.equal(outcome.fallbackReason, null);
  assert.ok(outcome.payload);
  // The shape the untouched evidence parser reads.
  assert.equal(outcome.payload!.transcriptReadSource, 'replica');
  assert.equal(outcome.payload!.status, 'idle');
  assert.equal(outcome.payload!.messages.length, 2);
  assert.equal(outcome.payload!.messages[1].content, 'REPLICA_ANSWER');
});

test('roster id 7 (approval probe) carries status + activeModal for the wedge predicate', async () => {
  const modal = { message: 'Allow git read?', buttons: ['Yes', 'No'] };
  const outcome = await readTranscriptReplicaForSemanticConsumer(
    transportFor({ snap: snapshot({ status: 'waiting_approval', activeModal: modal }) }),
    { ...BASE, consumerId: 'magi_approval_probe', acceptCoverage: ['full', 'tail', 'current-turn'], requireFresh: true },
  );
  assert.ok(outcome.payload);
  assert.equal(outcome.payload!.status, 'waiting_approval');
  assert.deepEqual(outcome.payload!.activeModal, modal);
});

test('roster id 8 (result collect) preserves the assistant content the kind parser needs', async () => {
  const outcome = await readTranscriptReplicaForSemanticConsumer(transportFor(), {
    ...BASE,
    consumerId: 'magi_result_collect',
    acceptCoverage: ['current-turn'],
    requireFresh: true,
  });
  assert.ok(outcome.payload);
  assert.equal(outcome.payload!.messages[1].content, 'REPLICA_ANSWER');
});

// ── the admission gate: coverage (§4 "coverage가 tail뿐이면 legacy") ─────────

test('roster id 8 REFUSES tail-only coverage — the FIX#1 cross-turn guard must not be lost', async () => {
  const outcome = await readTranscriptReplicaForSemanticConsumer(
    transportFor({ snap: snapshot({ coverage: { mode: 'tail', totalMessageCount: 9, returnedMessageCount: 2, omittedBefore: true } }) }),
    { ...BASE, consumerId: 'magi_result_collect', acceptCoverage: ['current-turn'], requireFresh: true },
  );
  assert.equal(outcome.payload, null);
  assert.equal(outcome.fallbackReason, 'coverage_insufficient');
});

test('roster id 6 REFUSES tail coverage — the trailing-activity veto needs the post-final bubbles', async () => {
  const outcome = await readTranscriptReplicaForSemanticConsumer(
    transportFor({ snap: snapshot({ coverage: { mode: 'tail', totalMessageCount: 9, returnedMessageCount: 2, omittedBefore: true } }) }),
    { ...BASE, consumerId: 'mcp_mesh_status_reconciliation', acceptCoverage: ['full', 'current-turn'], requireFresh: true },
  );
  assert.equal(outcome.payload, null);
  assert.equal(outcome.fallbackReason, 'coverage_insufficient');
});

test('roster id 7 ACCEPTS tail coverage — status/activeModal are session-level, not window-derived', async () => {
  const outcome = await readTranscriptReplicaForSemanticConsumer(
    transportFor({ snap: snapshot({ status: 'waiting_approval', coverage: { mode: 'tail', totalMessageCount: 9, returnedMessageCount: 1, omittedBefore: true } }) }),
    { ...BASE, consumerId: 'magi_approval_probe', acceptCoverage: ['full', 'tail', 'current-turn'], requireFresh: true },
  );
  assert.equal(outcome.fallbackReason, null);
  assert.equal(outcome.payload!.status, 'waiting_approval');
});

// ── the admission gate: freshness (§5.5 — irreversible acts never read stale) ─

test('a snapshot older than the freshness budget declines with stale_active_session', async () => {
  const stale = snapshot({ observedAt: new Date(NOW - SEMANTIC_TRANSCRIPT_FRESHNESS_BUDGET_MS - 1).toISOString() });
  const outcome = await readTranscriptReplicaForSemanticConsumer(transportFor({ snap: stale }), {
    ...BASE,
    consumerId: 'magi_approval_probe',
    acceptCoverage: ['full', 'tail', 'current-turn'],
    requireFresh: true,
  });
  assert.equal(outcome.payload, null);
  assert.equal(outcome.fallbackReason, 'stale_active_session');
});

test('a snapshot just inside the budget is admitted — the gate is a budget, not a demand for zero age', async () => {
  const edge = snapshot({ observedAt: new Date(NOW - SEMANTIC_TRANSCRIPT_FRESHNESS_BUDGET_MS + 1_000).toISOString() });
  const outcome = await readTranscriptReplicaForSemanticConsumer(transportFor({ snap: edge }), {
    ...BASE,
    consumerId: 'magi_approval_probe',
    acceptCoverage: ['full', 'tail', 'current-turn'],
    requireFresh: true,
  });
  assert.equal(outcome.fallbackReason, null);
  assert.ok(outcome.payload);
});

test('an unparseable observedAt fails CLOSED — treated as stale, never as fresh enough', async () => {
  const outcome = await readTranscriptReplicaForSemanticConsumer(
    transportFor({ snap: snapshot({ observedAt: 'not-a-timestamp' }) }),
    { ...BASE, consumerId: 'magi_result_collect', acceptCoverage: ['current-turn'], requireFresh: true },
  );
  assert.equal(outcome.payload, null);
  assert.equal(outcome.fallbackReason, 'stale_active_session');
});

// ── defect injection → legacy fallback with an observable reason ─────────────

test('a projection regression (messages dropped) falls back rather than synthesizing from a half-empty transcript', async () => {
  const { messages, ...broken } = snapshot();
  const outcome = await readTranscriptReplicaForSemanticConsumer(transportFor({ snap: broken }), {
    ...BASE,
    consumerId: 'mcp_mesh_status_reconciliation',
    acceptCoverage: ['full', 'current-turn'],
    requireFresh: true,
  });
  assert.equal(outcome.payload, null);
  assert.equal(outcome.fallbackReason, 'revision_invalid');
});

test('a malformed activeModal is refused — the approve click never reads a half-typed modal', async () => {
  const outcome = await readTranscriptReplicaForSemanticConsumer(
    transportFor({ snap: snapshot({ activeModal: { message: 'ok', buttons: 'Yes' } }) }),
    { ...BASE, consumerId: 'magi_approval_probe', acceptCoverage: ['full', 'tail', 'current-turn'], requireFresh: true },
  );
  assert.equal(outcome.payload, null);
  assert.equal(outcome.fallbackReason, 'revision_invalid');
});

test('an unavailable replica reports the ensure reason, and a throwing IPC is never fatal', async () => {
  const notReady = await readTranscriptReplicaForSemanticConsumer(
    transportFor({ ready: false, available: false, reason: 'ipc_unavailable' }),
    { ...BASE, consumerId: 'magi_result_collect', acceptCoverage: ['current-turn'], requireFresh: true },
  );
  assert.equal(notReady.payload, null);
  assert.equal(notReady.fallbackReason, 'ipc_unavailable');

  const throwing = await readTranscriptReplicaForSemanticConsumer(
    { async command() { throw new Error('ipc down'); } },
    { ...BASE, consumerId: 'magi_result_collect', acceptCoverage: ['current-turn'], requireFresh: true },
  );
  assert.equal(throwing.payload, null);
  assert.equal(throwing.fallbackReason, 'ipc_unavailable');
});

test('an off-union reason from the daemon is narrowed, never passed through', async () => {
  // A daemon on a different version must not be able to widen the closed
  // vocabulary from across the process boundary (design §4).
  const outcome = await readTranscriptReplicaForSemanticConsumer(
    transportFor({ ready: false, available: false, reason: 'something_invented' }),
    { ...BASE, consumerId: 'magi_result_collect', acceptCoverage: ['current-turn'], requireFresh: true },
  );
  assert.equal(outcome.fallbackReason, 'ipc_unavailable');
});

test('both key parts are required', async () => {
  const outcome = await readTranscriptReplicaForSemanticConsumer(
    { async command() { throw new Error('must not be called'); } },
    { consumerId: 'magi_result_collect', ownerDaemonId: '', rawSessionId: 's', acceptCoverage: ['current-turn'], requireFresh: true },
  );
  assert.equal(outcome.payload, null);
  assert.equal(outcome.fallbackReason, 'no_node');
});
