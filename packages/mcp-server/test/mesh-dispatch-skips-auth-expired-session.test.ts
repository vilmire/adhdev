import assert from 'node:assert/strict';
import test from 'node:test';

import { chooseDispatchableSession } from '../src/tools/mesh-tools.js';

// D4 — the dispatch-selection half of AUTH-EXPIRY-GENERALIZATION.
//
// Live incident: claude-cli session b23d10ee answered "Login expired · Please run
// /login" in 34s with zero content (2026-09-20), stayed dispatch-eligible, and
// swallowed task 1c225a59 the next day with the identical empty fingerprint.
//
// The FIX is upstream, in the provider layer: SpecCliAdapter now classifies the
// auth banner for every spec-backed CLI (not just kimi), and getStatus() then
// reports `status: 'error'` instead of `idle`. These tests pin the CONSEQUENCE at
// the selection layer — that an auth-failed session is not dispatchable, and,
// just as importantly, that healthy sessions still are.
//
// Note `error` is deliberately NOT in isTerminalSessionRecord's set: the session
// is not dead, it is blocked on a credential. It becomes dispatchable again the
// moment the adapter reports idle (re-auth / relaunch), with no durable stigma —
// there is no "unhealthy" flag to clear, which is what makes recovery automatic.

const MESH = 'mesh_auth';
const NODE = 'node_worker';
const COORD = 'daemon-coordinator';
const PROVIDER = 'claude-cli';

function meshSession(id: string, status: string): any {
  return {
    id,
    status,
    providerType: PROVIDER,
    settings: {
      meshNodeFor: MESH,
      meshNodeId: NODE,
      meshCoordinatorDaemonId: COORD,
    },
  };
}

test('D4: an auth-failed (error) session is not dispatchable', () => {
  const authFailed = meshSession('sess_auth_expired', 'error');
  const chosen = chooseDispatchableSession([authFailed], PROVIDER, MESH, NODE, COORD);
  assert.equal(chosen, undefined);
});

test('D4: the healthy idle session is preferred over an auth-failed sibling', () => {
  const authFailed = meshSession('sess_auth_expired', 'error');
  const healthy = meshSession('sess_healthy', 'idle');
  const chosen = chooseDispatchableSession([authFailed, healthy], PROVIDER, MESH, NODE, COORD);
  assert.equal(chosen?.id, 'sess_healthy');
});

// ── OVERCORRECTION GUARD ─────────────────────────────────────────────────────
// The task must not degrade into "exclude anything that looks weak".

test('D4 control: a normal idle session stays dispatchable', () => {
  const healthy = meshSession('sess_healthy', 'idle');
  const chosen = chooseDispatchableSession([healthy], PROVIDER, MESH, NODE, COORD);
  assert.equal(chosen?.id, 'sess_healthy');
});

test('D4 control: a session that merely answered briefly is NOT excluded', () => {
  // A worker legitimately replying "nothing to do" is indistinguishable from the
  // incident by content length alone. Only a PROVIDER-CLASSIFIED auth failure
  // excludes — never emptiness, and never a one-off short turn.
  const terse: any = meshSession('sess_terse', 'idle');
  terse.lastFinalContentLength = 0;
  const chosen = chooseDispatchableSession([terse], PROVIDER, MESH, NODE, COORD);
  assert.equal(chosen?.id, 'sess_terse');
});

test('D4 control: re-authentication restores dispatchability with no lingering stigma', () => {
  // Same session id that was previously 'error'; once the adapter reports idle
  // again it is immediately eligible. No durable exclusion list to clear.
  const recovered = meshSession('sess_auth_expired', 'idle');
  const chosen = chooseDispatchableSession([recovered], PROVIDER, MESH, NODE, COORD);
  assert.equal(chosen?.id, 'sess_auth_expired');
});
