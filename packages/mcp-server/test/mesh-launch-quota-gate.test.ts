import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshLaunchSession } from '../src/tools/mesh-tools.js';
import { readProviderPriority } from '../src/tools/mesh-tools-internal.js';
import { evaluateProviderQuotaGate, rankProvidersByQuotaGate } from '@adhdev/daemon-core';

// LAUNCH-SESSION QUOTA GATE.
//
// Two dispatch paths pick a provider for a node, and only ONE of them consulted
// the quota snapshots:
//
//   auto-launch / queue-drain  (daemon-core resolveUsableProvider)  → gated ✅
//   mesh_launch_session        (this module)                        → NOT gated ❌
//
// The manual path called detect_provider (a PATH/install probe) and never read
// nodeFacts at all, so a provider measurably out of quota was launched anyway.
// Observed 2026-08-13: kimi at 1% weekly (threshold 15%) with a perfectly valid
// snapshot present — the base node reached through the queue drain was correctly
// diverted to claude-cli, while a worktree node reached through mesh_launch_session
// launched kimi and took an immediate 403. Which path dispatched decided whether
// the quota was honoured.
//
// The gate's FAIL-OPEN contract is the load-bearing part of these tests. Blocking
// on anything except a fresh, measured exhaustion would create a self-healing
// deadlock: a CLI owns its own token lifecycle, so an 'expired-token' block would
// stop the CLI that must run to refresh the token. See mesh-quota-routing.ts.

const HOUR = 60 * 60 * 1000;

function quotaFacts(
  perProvider: Record<string, unknown>,
  { reportedAt = Date.now(), }: { reportedAt?: number } = {},
) {
  return { schemaVersion: 1, reportedAt, quota: perProvider };
}

/** A fresh, healthy 'ok' snapshot with plenty of headroom on both windows. */
function healthy(provider: string, now = Date.now()) {
  return {
    provider,
    status: 'ok',
    session: { usedPercent: 10, windowMinutes: 300, resetsAt: now + 4 * HOUR },
    weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: now + 5 * 24 * HOUR },
    updatedAt: now,
    error: null,
  };
}

/** The kimi incident shape: a fresh 'ok' snapshot at 1% weekly remaining. */
function weeklyExhausted(provider: string, now = Date.now()) {
  return {
    provider,
    status: 'ok',
    session: { usedPercent: 20, windowMinutes: 300, resetsAt: now + 4 * HOUR },
    weekly: { usedPercent: 99, windowMinutes: 10080, resetsAt: now + 5 * 24 * HOUR },
    updatedAt: now,
    error: null,
  };
}

/** The provider's own "usage limit reached" verdict (e.g. kimi's 403). */
function exhaustedError(provider: string, now = Date.now()) {
  return {
    provider,
    status: 'error',
    session: null,
    weekly: null,
    updatedAt: now,
    error: 'usage limit reached',
    metadata: { failureKind: 'quota-exhausted' },
  };
}

function makeCtx(
  nodePolicy: Record<string, unknown>,
  nodeFacts?: unknown,
  meshPolicy: Record<string, unknown> = {},
) {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const launchCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
  transport.command = async (command, args = {}) => {
    if (command === 'get_status_metadata') return { success: true, status: { sessions: [] } };
    if (command === 'get_mesh') return { success: true, mesh: (args as any).inlineMesh || mesh };
    if (command === 'trigger_mesh_queue') return { success: true, trigger: { success: true } };
    if (command === 'launch_cli') {
      launchCalls.push({ command, args });
      return { success: true, sessionId: 'session-1' };
    }
    // Every provider is INSTALLED — isolating the quota gate from detection.
    if (command === 'detect_provider') return { success: true, detected: true };
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (_daemonId, command) => {
    if (command === 'get_status_metadata') return { success: true, result: { status: { sessions: [] } } };
    if (command === 'detect_provider') return { success: true, result: { success: true, detected: true } };
    return { success: true, result: { success: true } };
  };

  const mesh = {
    id: 'mesh-quota',
    name: 'Quota Mesh',
    repoIdentity: 'example/repo',
    policy: meshPolicy,
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [{
      id: 'node-a',
      workspace: '/repo',
      repoRoot: '/repo',
      userOverrides: {},
      policy: nodePolicy,
      ...(nodeFacts ? { nodeFacts } : {}),
    }],
  };
  return { ctx: { mesh, transport, localDaemonId: 'daemon-a' } as any, launchCalls };
}

function launchedType(launchCalls: Array<{ command: string; args: Record<string, unknown> }>) {
  return launchCalls.find(c => c.command === 'launch_cli')?.args.cliType;
}

// ── 1. The gate blocks and falls through ─────────────────────────────────────

test('exhausted first choice falls through to the next candidate', async () => {
  // THE REGRESSION TEST for the 2026-08-13 incident: kimi is priority[0] and out
  // of weekly quota; claude-cli is healthy. Before the fix this launched kimi.
  const { ctx, launchCalls } = makeCtx(
    { slots: [{ provider: 'kimi' }, { provider: 'claude-cli' }] },
    quotaFacts({ kimi: weeklyExhausted('kimi'), 'claude-cli': healthy('claude-cli') }),
  );
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-a' }));
  assert.equal(result.success !== false, true, `launch should succeed: ${JSON.stringify(result)}`);
  assert.equal(launchedType(launchCalls), 'claude-cli', 'fell through past the exhausted kimi');
  assert.equal(result.resolvedProviderType, 'claude-cli');
});

test("a fresh 'quota-exhausted' error also falls through", async () => {
  // The provider's own 403-shaped verdict, not a window threshold.
  const { ctx, launchCalls } = makeCtx(
    { slots: [{ provider: 'kimi' }, { provider: 'claude-cli' }] },
    quotaFacts({ kimi: exhaustedError('kimi'), 'claude-cli': healthy('claude-cli') }),
  );
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-a' }));
  assert.equal(launchedType(launchCalls), 'claude-cli');
  assert.equal(result.resolvedProviderType, 'claude-cli');
});

test('every candidate gated → no launch, reported as a WAIT not a misconfiguration', async () => {
  const { ctx, launchCalls } = makeCtx(
    { slots: [{ provider: 'kimi' }, { provider: 'claude-cli' }] },
    quotaFacts({ kimi: weeklyExhausted('kimi'), 'claude-cli': weeklyExhausted('claude-cli') }),
  );
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-a' }));
  assert.equal(result.success, false);
  assert.equal(result.code, 'mesh_all_providers_quota_gated');
  assert.equal(launchCalls.some(c => c.command === 'launch_cli'), false, 'nothing was launched');
  assert.deepEqual(result.gated.map((g: any) => g.providerType).sort(), ['claude-cli', 'kimi']);
  // Distinguishable from "nothing installed" — conflating them sends a coordinator
  // chasing an install problem that does not exist.
  assert.ok(!/not detected/.test(result.error), 'not reported as a detection failure');
});

// ── 2. FAIL-OPEN (the load-bearing contract) ─────────────────────────────────

test('fail-open: no quota snapshot at all → first candidate launches', async () => {
  // Pre-quota daemons, and nodes that never reported, must behave exactly as
  // before the feature existed.
  const { ctx, launchCalls } = makeCtx({ slots: [{ provider: 'kimi' }, { provider: 'claude-cli' }] });
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-a' }));
  assert.equal(result.success !== false, true);
  assert.equal(launchedType(launchCalls), 'kimi', 'unmeasured is never blocked');
});

test('fail-open: quota tracking switched OFF → not blocked (but sorts last)', async () => {
  // quotaEnabled === false means "do not read my usage" — a deliberate user
  // choice. It must degrade to "no signal", never to "assumed exhausted".
  //
  // NOTE the distinction this test pins: an unmeasured provider is never
  // BLOCKED, but it is out-RANKED. rankProvidersByQuotaGate sorts unknown
  // candidates below every measured one (never above — "assumed full" would
  // preferentially overload the one provider that declined to be measured).
  // So with a healthy measured peer present, the measured peer wins. Being
  // out-ranked is not being blocked: the next test proves the unmeasured
  // provider still launches when it is the only candidate.
  const { ctx, launchCalls } = makeCtx(
    { slots: [{ provider: 'kimi' }, { provider: 'claude-cli' }] },
    quotaFacts({ 'claude-cli': healthy('claude-cli') }), // kimi absent entirely
  );
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-a' }));
  assert.equal(result.success !== false, true, 'never blocked');
  assert.equal(launchedType(launchCalls), 'claude-cli', 'measured peer out-ranks unknown');
});

test('fail-open: an opted-out provider alone on the node still launches', async () => {
  // The stranding check. If unknown-last ever hardened into "unknown is
  // blocked", a node whose only provider opted out of quota tracking would be
  // permanently unlaunchable — the failure mode the fail-open contract exists
  // to prevent.
  const { ctx, launchCalls } = makeCtx(
    { slots: [{ provider: 'kimi' }] },
    quotaFacts({ 'claude-cli': healthy('claude-cli') }), // kimi never measured
  );
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-a' }));
  assert.equal(result.success !== false, true, `opted-out sole provider must launch: ${JSON.stringify(result)}`);
  assert.equal(launchedType(launchCalls), 'kimi');
});

test('STALE exhausted snapshot with a healthy peer → the node still launches', async () => {
  // ★History: 2026-08-20 changed which provider WINS (claude-cli out-ranks a
  // near-exhausted stale kimi); 2026-08-24 window-boundary validity then made
  // kimi outright GATED (its 3h-old weekly reading is still within its reset
  // boundary, so the 1% remaining is a measured fact, not noise). The
  // node-level contract this test pins is unchanged throughout: a stale
  // near-exhausted provider must never take the whole NODE down while a
  // usable peer exists — claude-cli launches.
  const now = Date.now();
  const stale = weeklyExhausted('kimi', now - 3 * HOUR);
  const { ctx, launchCalls } = makeCtx(
    { slots: [{ provider: 'kimi' }, { provider: 'claude-cli' }] },
    quotaFacts({ kimi: stale, 'claude-cli': healthy('claude-cli') }, { reportedAt: now - 3 * HOUR }),
  );
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-a' }));
  assert.equal(result.success !== false, true, 'stale exhaustion must never block the launch');
  assert.equal(launchedType(launchCalls), 'claude-cli', 'a healthy current reading out-ranks a near-exhausted stale one');
});

test('a STALE-but-within-window exhausted provider ALONE on the node now gates as a WAIT (2026-08-24)', async () => {
  // ★The assertion changed 2026-08-24 (was: launched anyway — the stale
  // fail-open stranding guard). Window-boundary validity inverted it: this
  // 3h-old reading's weekly window still runs for days, usage within a
  // window is monotonic, so "≤1% weekly remaining" is a measured fact, and
  // launching would burn the last of the window — exactly what the owner's
  // floor exists to prevent. The launch fails as a WAIT
  // (all_providers_quota_gated), pointing the caller at the queue. The
  // anti-stranding property is preserved in its window-shaped form by the
  // next test: once the measured window RESETS, the gate stands down.
  const now = Date.now();
  const { ctx, launchCalls } = makeCtx(
    { slots: [{ provider: 'kimi' }] },
    quotaFacts({ kimi: weeklyExhausted('kimi', now - 3 * HOUR) }, { reportedAt: now - 3 * HOUR }),
  );
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-a' }));
  assert.equal(result.success, false, `within-window exhaustion must gate: ${JSON.stringify(result)}`);
  assert.equal(result.code, 'mesh_all_providers_quota_gated');
  assert.equal(launchCalls.length, 0);
});

test('fail-open: a stale reading whose window has RESET launches — the anti-stranding guard, window-shaped', async () => {
  // The reading predates its own weekly reset, so it describes a DEAD window
  // — gating on it would be the permanent-misexclusion trap the fail-open
  // contract exists to prevent. The gate stands down and the sole provider
  // launches; the next successful refresh re-measures the live window.
  const now = Date.now();
  const elapsed = weeklyExhausted('kimi', now - 3 * HOUR);
  elapsed.weekly = { ...elapsed.weekly, resetsAt: now - HOUR };
  const { ctx, launchCalls } = makeCtx(
    { slots: [{ provider: 'kimi' }] },
    quotaFacts({ kimi: elapsed }, { reportedAt: now - 3 * HOUR }),
  );
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-a' }));
  assert.equal(result.success !== false, true, `reset-elapsed reading must fail open: ${JSON.stringify(result)}`);
  assert.equal(launchedType(launchCalls), 'kimi');
});

test("fail-open: 'expired-token' → NOT blocked (self-healing deadlock guard)", async () => {
  // ★The deadlock this prevents: the CLI owns its own token refresh, so blocking
  // launch on an expired token means the CLI never runs, so the token is never
  // refreshed — a single-provider node would wedge permanently.
  const now = Date.now();
  const { ctx, launchCalls } = makeCtx(
    { slots: [{ provider: 'kimi' }] },
    quotaFacts({
      kimi: {
        provider: 'kimi', status: 'error', session: null, weekly: null,
        updatedAt: now, error: 'token expired',
        metadata: { failureKind: 'expired-token' },
      },
    }),
  );
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-a' }));
  assert.equal(result.success !== false, true, `expired-token must not block: ${JSON.stringify(result)}`);
  assert.equal(launchedType(launchCalls), 'kimi');
});

test('fail-open: transient failure kinds (network / unauthorized) → not blocked', async () => {
  for (const failureKind of ['network', 'unauthorized', 'parse', 'cli-unavailable']) {
    const now = Date.now();
    const { ctx, launchCalls } = makeCtx(
      { slots: [{ provider: 'kimi' }] },
      quotaFacts({
        kimi: {
          provider: 'kimi', status: 'error', session: null, weekly: null,
          updatedAt: now, error: failureKind, metadata: { failureKind },
        },
      }),
    );
    const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-a' }));
    assert.equal(result.success !== false, true, `${failureKind} must fail open`);
    assert.equal(launchedType(launchCalls), 'kimi', `${failureKind} must fail open`);
  }
});

// ── 3. Path agreement: both dispatch paths use the SAME gate ─────────────────

test('regression guard: the manual path delegates to the shared judgement module', () => {
  // ★This is the guard that catches a THIRD dispatch path appearing. It asserts
  // agreement at the only place agreement can be guaranteed — the shared module —
  // rather than re-deriving the expected winner independently. If someone adds a
  // path that reimplements the gate locally, the two orders drift and this fails.
  const now = Date.now();
  const node = {
    id: 'node-a',
    policy: { slots: [{ provider: 'kimi' }, { provider: 'claude-cli' }] },
    nodeFacts: quotaFacts({ kimi: weeklyExhausted('kimi', now), 'claude-cli': healthy('claude-cli', now) }),
  } as any;

  // The candidate list the manual path builds (slots order, all detected)…
  const candidates = readProviderPriority(node.policy);
  assert.deepEqual(candidates, ['kimi', 'claude-cli']);

  // …ranked by the SAME function the auto-launch loop calls.
  const ranked = rankProvidersByQuotaGate(node, candidates, null, now);
  assert.deepEqual(ranked.clear, ['claude-cli'], 'gate-clear survivor');
  assert.deepEqual(ranked.gated.map(g => g.providerType), ['kimi']);
  assert.equal(ranked.gated[0].block.reason, 'provider_quota_weekly_low');

  // And the single-provider form agrees with the ranking form.
  assert.equal(evaluateProviderQuotaGate(node, 'claude-cli', null, now), null);
  assert.ok(evaluateProviderQuotaGate(node, 'kimi', null, now), 'kimi is blocked');
});

test('slots-first ordering matches the auto-launch path on a node declaring both', () => {
  // The auto-launch path resolves from policy.slots (resolveNodeCapabilitySlots).
  // The manual path must produce the same first choice, or the same node gets a
  // different provider depending on which path dispatched.
  const policy = { providerPriority: ['kimi'], slots: [{ provider: 'claude-cli' }, { provider: 'kimi' }] };
  assert.deepEqual(readProviderPriority(policy), ['claude-cli', 'kimi']);
});

// ── 4. Legacy slots-less nodes keep working ──────────────────────────────────

test('legacy node with no slots: providerPriority fallback still gates', async () => {
  // providerPriority must survive as the fallback (a slots-less node has no other
  // preference signal) AND the gate must apply to it — a legacy node is exactly
  // as capable of being out of quota.
  const { ctx, launchCalls } = makeCtx(
    { providerPriority: ['kimi', 'claude-cli'] },
    quotaFacts({ kimi: weeklyExhausted('kimi'), 'claude-cli': healthy('claude-cli') }),
  );
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-a' }));
  assert.equal(result.success !== false, true, `legacy node should launch: ${JSON.stringify(result)}`);
  assert.equal(launchedType(launchCalls), 'claude-cli', 'gated via the legacy fallback list');
});

test('legacy node with no slots and no quota data launches priority[0]', async () => {
  const { ctx, launchCalls } = makeCtx({ providerPriority: ['kimi', 'claude-cli'] });
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-a' }));
  assert.equal(result.success !== false, true);
  assert.equal(launchedType(launchCalls), 'kimi');
});

// ── 5. Explicit type: advisory, not fail-closed ──────────────────────────────

test('explicit type that is quota-gated still launches, but WARNS', async () => {
  // An explicit type is an operator OVERRIDE. Fail-closing would contradict the
  // existing contract that an explicit type may name any provider (the daemon-side
  // launch is the real gate) and would leave no way to run a provider whose
  // snapshot is wrong. Launching SILENTLY is what produced the 403, so the
  // response must carry the warning.
  const { ctx, launchCalls } = makeCtx(
    { slots: [{ provider: 'kimi' }, { provider: 'claude-cli' }] },
    quotaFacts({ kimi: weeklyExhausted('kimi'), 'claude-cli': healthy('claude-cli') }),
  );
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-a', type: 'kimi' }));
  assert.equal(result.success !== false, true, 'explicit override still launches');
  assert.equal(launchedType(launchCalls), 'kimi', 'the requested provider, not a substitute');
  assert.ok(result.quotaWarning, 'the caller is told the provider is out of quota');
  assert.equal(result.quotaBlock.providerType, 'kimi');
  assert.equal(result.quotaBlock.reason, 'provider_quota_weekly_low');
});

test('explicit type with healthy quota carries no warning', async () => {
  const { ctx, launchCalls } = makeCtx(
    { slots: [{ provider: 'kimi' }, { provider: 'claude-cli' }] },
    quotaFacts({ kimi: weeklyExhausted('kimi'), 'claude-cli': healthy('claude-cli') }),
  );
  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-a', type: 'claude-cli' }));
  assert.equal(launchedType(launchCalls), 'claude-cli');
  assert.equal(result.quotaWarning, undefined, 'no warning noise on a healthy provider');
});

// ── 6. Policy thresholds are honoured ────────────────────────────────────────

test('mesh policy quotaRouting thresholds drive the gate', async () => {
  // 30% weekly remaining is above the 15% default (would NOT gate) but below a
  // configured 50%, proving the policy is actually threaded through rather than
  // the defaults being silently used.
  const now = Date.now();
  const thirtyPercentLeft = {
    provider: 'kimi', status: 'ok',
    session: { usedPercent: 10, windowMinutes: 300, resetsAt: now + 4 * HOUR },
    weekly: { usedPercent: 70, windowMinutes: 10080, resetsAt: now + 5 * 24 * HOUR },
    updatedAt: now, error: null,
  };
  const facts = quotaFacts({ kimi: thirtyPercentLeft });
  // A SINGLE-provider node, deliberately: it isolates the GATE (block / don't
  // block) from the expiry-risk RANKING that reorders multiple clear candidates.
  // With two providers the winner would also depend on relative risk, and this
  // test would no longer be testing the threshold it names.
  const slots = { slots: [{ provider: 'kimi' }] };

  const lenient = makeCtx(slots, facts);
  const lenientResult = JSON.parse(await meshLaunchSession(lenient.ctx, { node_id: 'node-a' }));
  assert.equal(lenientResult.success !== false, true, 'default 15% threshold does not gate 30%');
  assert.equal(launchedType(lenient.launchCalls), 'kimi');

  const strict = makeCtx(slots, facts, { quotaRouting: { weeklyMinRemainingPercent: 50 } });
  const strictResult = JSON.parse(await meshLaunchSession(strict.ctx, { node_id: 'node-a' }));
  assert.equal(strictResult.success, false, 'configured 50% threshold gates 30%');
  assert.equal(strictResult.code, 'mesh_all_providers_quota_gated');
  assert.equal(strict.launchCalls.some(c => c.command === 'launch_cli'), false);
});

// ── 7. The offline fast-fail guard survives full enumeration ─────────────────

test('offline node still fails fast: one throw stops the whole probe loop', async () => {
  // The loop no longer short-circuits on the FIRST DETECTED provider (it must
  // enumerate every candidate for the gate to rank them), so the OFFLINE guard
  // has to keep doing its job independently: a transport THROW means the node
  // itself is unreachable and every remaining probe would fail identically.
  // Without the break this becomes ~90s × providers of serialized stalling.
  const transport = new IpcTransport() as any;
  let probes = 0;
  transport.command = async (command: string, args: any = {}) => {
    if (command === 'get_mesh') return { success: true, mesh: (args as any).inlineMesh || mesh };
    if (command === 'detect_provider') { probes++; throw new Error('peer not connected'); }
    if (command === 'get_status_metadata') return { success: true, status: { sessions: [] } };
    throw new Error(`unexpected: ${command}`);
  };
  transport.meshCommand = async () => ({ success: true, result: { success: true } });
  const mesh = {
    id: 'mesh-quota', name: 'Quota Mesh', repoIdentity: 'example/repo',
    policy: {}, coordinator: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    nodes: [{
      id: 'node-a', workspace: '/repo', repoRoot: '/repo', userOverrides: {},
      policy: { slots: [{ provider: 'kimi' }, { provider: 'claude-cli' }, { provider: 'codex-cli' }] },
    }],
  };
  const ctx = { mesh, transport, localDaemonId: 'daemon-a' } as any;

  const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-a' }));
  assert.equal(result.success, false);
  assert.match(result.error, /unreachable/, 'reported as node-unreachable, not quota');
  assert.equal(probes, 1, 'stopped after the FIRST transport failure, did not probe all 3');
});
