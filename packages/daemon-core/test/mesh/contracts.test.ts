import { describe, it, expect } from 'vitest';

import {
  MESH_PROTOCOL_VERSION_V2,
  assertCoordinatorIdentity,
  assertPendingMeshCoordinatorEventV2,
  coordinatorIdentityEquals,
  coordinatorIdentityKey,
  isMeshEventScope,
  isMeshTaskStatus,
  isSupportedMeshProtocolVersion,
  meshSessionHandleKey,
  shouldDeliverPendingEventToCoordinator,
  MeshContractViolationError,
  defaultScopeForEvent,
  coordinatorIdentityFromEmitFields,
  buildPendingEventEmitStamp,
  type CoordinatorIdentity,
  type PendingMeshCoordinatorEventV2,
} from '../../src/mesh/contracts.js';

const COORD_A: CoordinatorIdentity = { daemonId: 'd1', coordinatorRunId: 'run-a' };
const COORD_B: CoordinatorIdentity = { daemonId: 'd2', coordinatorRunId: 'run-b' };
const COORD_A_WITH_SESSION: CoordinatorIdentity = { daemonId: 'd1', coordinatorRunId: 'run-a', sessionId: 'sess-1' };

describe('coordinatorIdentity helpers', () => {
  it('equals ignores undefined vs absent sessionId difference', () => {
    expect(coordinatorIdentityEquals(COORD_A, { ...COORD_A })).toBe(true);
    expect(coordinatorIdentityEquals(COORD_A, COORD_B)).toBe(false);
    expect(coordinatorIdentityEquals(COORD_A, COORD_A_WITH_SESSION)).toBe(false);
  });
  it('key is stable across calls', () => {
    expect(coordinatorIdentityKey(COORD_A)).toBe(coordinatorIdentityKey({ ...COORD_A }));
    expect(coordinatorIdentityKey(COORD_A)).not.toBe(coordinatorIdentityKey(COORD_A_WITH_SESSION));
  });
});

describe('coordinatorIdentity daemon-id form normalization (RF-IDENTITY)', () => {
  // One machine answers to three interchangeable daemon-id forms, all derived
  // from a single `mach_<hex>` core. Before the fix, equals/key used a raw `===`
  // and treated the same coordinator addressed under two forms as distinct,
  // silently dropping unicast completion events at the scope filter.
  const CORE = 'mach_abc123';
  const bare: CoordinatorIdentity = { daemonId: CORE, coordinatorRunId: 'run-x' };
  const cloud: CoordinatorIdentity = { daemonId: `daemon_${CORE}`, coordinatorRunId: 'run-x' };
  const standalone: CoordinatorIdentity = { daemonId: `standalone_${CORE}`, coordinatorRunId: 'run-x' };

  it('equals collapses the three interchangeable daemon-id forms of one machine', () => {
    expect(coordinatorIdentityEquals(bare, cloud)).toBe(true);
    expect(coordinatorIdentityEquals(bare, standalone)).toBe(true);
    expect(coordinatorIdentityEquals(cloud, standalone)).toBe(true);
  });

  it('still distinguishes a different machine core and a different run id', () => {
    expect(coordinatorIdentityEquals(bare, { daemonId: 'daemon_mach_other', coordinatorRunId: 'run-x' })).toBe(false);
    expect(coordinatorIdentityEquals(bare, { ...cloud, coordinatorRunId: 'run-y' })).toBe(false);
  });

  it('key stays consistent with equals: equal identities produce an identical key', () => {
    // Invariant: a==b  ⟺  key(a)===key(b). A raw-form key here would break it.
    expect(coordinatorIdentityKey(bare)).toBe(coordinatorIdentityKey(cloud));
    expect(coordinatorIdentityKey(bare)).toBe(coordinatorIdentityKey(standalone));
    expect(coordinatorIdentityKey(cloud)).toBe(coordinatorIdentityKey(standalone));
  });

  it('key still separates different cores and run ids', () => {
    expect(coordinatorIdentityKey(bare)).not.toBe(coordinatorIdentityKey({ daemonId: 'mach_other', coordinatorRunId: 'run-x' }));
    expect(coordinatorIdentityKey(bare)).not.toBe(coordinatorIdentityKey({ ...bare, coordinatorRunId: 'run-y' }));
  });

  it('routes a unicast event whose intendedFor and drainer use different daemon-id forms of the same machine', () => {
    // Latent-bug guard at the routing layer: a completion scoped to
    // `daemon_mach_X` must still reach a drainer holding bare `mach_X`.
    const evt = buildV2Event({ scope: 'unicast', intendedFor: cloud });
    expect(shouldDeliverPendingEventToCoordinator(evt, bare)).toBe(true);
    expect(shouldDeliverPendingEventToCoordinator(evt, standalone)).toBe(true);
    expect(shouldDeliverPendingEventToCoordinator(evt, { daemonId: 'daemon_mach_other', coordinatorRunId: 'run-x' })).toBe(false);
  });
});

describe('protocol version + enum guards', () => {
  it('accepts known versions and rejects unknown', () => {
    expect(isSupportedMeshProtocolVersion('1.0')).toBe(true);
    expect(isSupportedMeshProtocolVersion('2.0')).toBe(true);
    expect(isSupportedMeshProtocolVersion('3.0')).toBe(false);
    expect(isSupportedMeshProtocolVersion(2.0)).toBe(false);
  });
  it('isMeshEventScope is strict', () => {
    expect(isMeshEventScope('unicast')).toBe(true);
    expect(isMeshEventScope('broadcast')).toBe(true);
    expect(isMeshEventScope('system')).toBe(true);
    expect(isMeshEventScope('multicast')).toBe(false);
  });
  it('isMeshTaskStatus is strict', () => {
    expect(isMeshTaskStatus('pending')).toBe(true);
    expect(isMeshTaskStatus('in_progress')).toBe(true);
    expect(isMeshTaskStatus('done')).toBe(false);
  });
});

describe('meshSessionHandleKey', () => {
  it('combines nodeId and sessionId', () => {
    const key = meshSessionHandleKey({
      nodeId: 'node-1',
      sessionId: 'sess-2',
      providerType: 'claude-cli',
      coordinatorDaemonId: 'd1',
      assignedAt: 0,
    });
    expect(key).toBe('node-1|sess-2');
  });
});

describe('assertCoordinatorIdentity', () => {
  it('parses a valid identity', () => {
    expect(assertCoordinatorIdentity(COORD_A, '$')).toEqual(COORD_A);
    expect(assertCoordinatorIdentity(COORD_A_WITH_SESSION, '$')).toEqual(COORD_A_WITH_SESSION);
  });
  it('rejects missing daemonId / coordinatorRunId', () => {
    expect(() => assertCoordinatorIdentity({ coordinatorRunId: 'x' }, '$')).toThrow(MeshContractViolationError);
    expect(() => assertCoordinatorIdentity({ daemonId: 'x' }, '$')).toThrow(MeshContractViolationError);
  });
  it('rejects empty-string sessionId', () => {
    expect(() => assertCoordinatorIdentity({ ...COORD_A, sessionId: '' }, '$')).toThrow(MeshContractViolationError);
  });
});

function buildV2Event(overrides: Partial<PendingMeshCoordinatorEventV2> = {}): PendingMeshCoordinatorEventV2 {
  return {
    event: 'agent:completed',
    meshId: 'mesh-1',
    nodeLabel: 'node-1',
    metadataEvent: { taskId: 't-1' },
    queuedAt: 1_000,
    protocolVersion: MESH_PROTOCOL_VERSION_V2,
    eventId: 'evt-1',
    scope: 'broadcast',
    dispatchedBy: COORD_A,
    ...overrides,
  };
}

describe('assertPendingMeshCoordinatorEventV2', () => {
  it('parses a well-formed broadcast event', () => {
    const evt = buildV2Event();
    const out = assertPendingMeshCoordinatorEventV2(evt);
    expect(out.scope).toBe('broadcast');
    expect(out.dispatchedBy).toEqual(COORD_A);
    expect(out.intendedFor).toBeUndefined();
  });

  it('requires intendedFor for unicast scope', () => {
    expect(() => assertPendingMeshCoordinatorEventV2(buildV2Event({ scope: 'unicast' })))
      .toThrow(/unicast scope requires intendedFor/);
  });

  it('forbids intendedFor for non-unicast scope', () => {
    expect(() => assertPendingMeshCoordinatorEventV2(buildV2Event({ scope: 'broadcast', intendedFor: COORD_B })))
      .toThrow(/only unicast scope may set intendedFor/);
  });

  it('rejects unsupported protocolVersion', () => {
    expect(() => assertPendingMeshCoordinatorEventV2(buildV2Event({ protocolVersion: '9.9' as any })))
      .toThrow(/protocolVersion/);
  });

  it('requires a non-empty eventId', () => {
    expect(() => assertPendingMeshCoordinatorEventV2(buildV2Event({ eventId: '' as any })))
      .toThrow(/eventId/);
    const { eventId: _drop, ...noEventId } = buildV2Event();
    expect(() => assertPendingMeshCoordinatorEventV2(noEventId))
      .toThrow(/eventId/);
  });

  it('round-trips eventId through validation', () => {
    const out = assertPendingMeshCoordinatorEventV2(buildV2Event({ eventId: 'evt-xyz' }));
    expect(out.eventId).toBe('evt-xyz');
  });
});

describe('shouldDeliverPendingEventToCoordinator', () => {
  it('broadcast goes to everyone', () => {
    const evt = buildV2Event({ scope: 'broadcast' });
    expect(shouldDeliverPendingEventToCoordinator(evt, COORD_A)).toBe(true);
    expect(shouldDeliverPendingEventToCoordinator(evt, COORD_B)).toBe(true);
  });
  it('system goes to no coordinator', () => {
    const evt = buildV2Event({ scope: 'system' });
    expect(shouldDeliverPendingEventToCoordinator(evt, COORD_A)).toBe(false);
    expect(shouldDeliverPendingEventToCoordinator(evt, COORD_B)).toBe(false);
  });
  it('unicast goes only to intendedFor', () => {
    const evt = buildV2Event({ scope: 'unicast', intendedFor: COORD_A });
    expect(shouldDeliverPendingEventToCoordinator(evt, COORD_A)).toBe(true);
    expect(shouldDeliverPendingEventToCoordinator(evt, COORD_B)).toBe(false);
  });
  it('routing fix bundles the audit case: two coordinators, A dispatches → only A receives', () => {
    // The audit's headline case: a unicast completion event from coord A
    // must not reach coord B. Multiple back-to-back events keep landing
    // on the right side.
    const events = [
      buildV2Event({ scope: 'unicast', intendedFor: COORD_A, event: 'task1:completed' }),
      buildV2Event({ scope: 'unicast', intendedFor: COORD_B, event: 'task2:completed' }),
      buildV2Event({ scope: 'unicast', intendedFor: COORD_A, event: 'task3:completed' }),
    ];
    const aReceived = events.filter(e => shouldDeliverPendingEventToCoordinator(e, COORD_A));
    const bReceived = events.filter(e => shouldDeliverPendingEventToCoordinator(e, COORD_B));
    expect(aReceived.map(e => e.event)).toEqual(['task1:completed', 'task3:completed']);
    expect(bReceived.map(e => e.event)).toEqual(['task2:completed']);
  });
});

describe('defaultScopeForEvent (B2a)', () => {
  it('maps terminal task events to unicast', () => {
    for (const e of ['agent:generating_completed', 'agent:stopped', 'refine:completed', 'refine:failed', 'refine:accepted']) {
      expect(defaultScopeForEvent(e)).toBe('unicast');
    }
  });
  it('maps coordinator-addressed dispatch-plane alerts to unicast (dispatch_blocked pages the originating coordinator)', () => {
    expect(defaultScopeForEvent('mesh:dispatch_blocked')).toBe('unicast');
  });
  it('defaults everything else to broadcast (v1-compatible)', () => {
    expect(defaultScopeForEvent('node_joined')).toBe('broadcast');
    expect(defaultScopeForEvent('agent:ready')).toBe('broadcast');
    expect(defaultScopeForEvent('worktree_bootstrap_complete')).toBe('broadcast');
  });
});

describe('coordinatorIdentityFromEmitFields (B2a)', () => {
  it('returns undefined without a daemonId', () => {
    expect(coordinatorIdentityFromEmitFields({})).toBeUndefined();
    expect(coordinatorIdentityFromEmitFields({ daemonId: '' })).toBeUndefined();
    expect(coordinatorIdentityFromEmitFields({ sessionId: 's' })).toBeUndefined();
  });
  it('falls coordinatorRunId back to daemonId when absent', () => {
    expect(coordinatorIdentityFromEmitFields({ daemonId: 'd1' })).toEqual({ daemonId: 'd1', coordinatorRunId: 'd1' });
  });
  it('carries an explicit coordinatorRunId and sessionId', () => {
    expect(coordinatorIdentityFromEmitFields({ daemonId: 'd1', coordinatorRunId: 'run', sessionId: 's' }))
      .toEqual({ daemonId: 'd1', coordinatorRunId: 'run', sessionId: 's' });
  });
});

describe('buildPendingEventEmitStamp (B2a)', () => {
  const COORD: CoordinatorIdentity = { daemonId: 'd1', coordinatorRunId: 'd1' };

  it('returns undefined without a dispatchedBy identity', () => {
    expect(buildPendingEventEmitStamp({ eventName: 'agent:generating_completed', eventId: 'e1' })).toBeUndefined();
  });

  it('stamps a unicast terminal event addressed to intendedFor', () => {
    const stamp = buildPendingEventEmitStamp({
      eventName: 'agent:generating_completed', eventId: 'e1', dispatchedBy: COORD, intendedFor: COORD,
    });
    expect(stamp).toEqual({ protocolVersion: MESH_PROTOCOL_VERSION_V2, eventId: 'e1', scope: 'unicast', dispatchedBy: COORD, intendedFor: COORD });
  });

  it('downgrades a unicast event with no intendedFor to broadcast (contract-safe, never dropped)', () => {
    const stamp = buildPendingEventEmitStamp({ eventName: 'agent:generating_completed', eventId: 'e1', dispatchedBy: COORD });
    expect(stamp?.scope).toBe('broadcast');
    expect(stamp?.intendedFor).toBeUndefined();
  });

  it('drops intendedFor for a non-unicast scope', () => {
    const stamp = buildPendingEventEmitStamp({ eventName: 'node_joined', eventId: 'e1', dispatchedBy: COORD, intendedFor: COORD });
    expect(stamp?.scope).toBe('broadcast');
    expect(stamp?.intendedFor).toBeUndefined();
  });

  it('honors an explicit scope override', () => {
    const stamp = buildPendingEventEmitStamp({ eventName: 'node_joined', eventId: 'e1', dispatchedBy: COORD, scope: 'system' });
    expect(stamp?.scope).toBe('system');
  });

  it('produces a stamp that passes assertPendingMeshCoordinatorEventV2 when merged onto an event', () => {
    const stamp = buildPendingEventEmitStamp({ eventName: 'agent:generating_completed', eventId: 'e1', dispatchedBy: COORD, intendedFor: COORD })!;
    const evt = { event: 'agent:generating_completed', meshId: 'm', nodeLabel: 'n', metadataEvent: {}, queuedAt: 1, ...stamp };
    expect(() => assertPendingMeshCoordinatorEventV2(evt)).not.toThrow();
  });
});
