import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => '/nonexistent-adhdev-config',
  getMachineId: () => 'test-machine',
  getMachineNickname: () => null,
  loadConfig: () => ({ workspaces: [
    { id: 'ws-1', path: '/work/proj-one', label: 'one' },
    { id: 'ws-2', path: '/work/proj-two', label: 'two' },
  ] }),
}));

import { meshScopeFromEntry } from '../../src/transfer/workspace-scope.js';

const SELF = 'daemon_mach_self';
const PEER = 'daemon_mach_peer';
const ids = (scope: ReturnType<typeof meshScopeFromEntry>) => (scope?.workspaces ?? []).map((w) => w.id).sort();

describe('meshScopeFromEntry - nodes without a daemonId', () => {
  const standaloneMesh = {
    id: 'mesh-1',
    nodes: [{ id: 'n1', workspace: '/work/proj-one' }, { id: 'n2', workspace: '/work/proj-two', daemonId: PEER }],
  };

  it('counts an anonymous node for the local caller on the daemon that hosts the mesh', () => {
    // No other daemon pinned as host and no foreign host: this daemon is the host, its anonymous node is its own.
    const mesh = { id: 'mesh-1', nodes: [{ id: 'n1', workspace: '/work/proj-one' }] };
    expect(ids(meshScopeFromEntry(mesh, SELF))).toEqual(['ws-1']);
  });

  it('does not hand an anonymous node to a peer-served request', () => {
    const mesh = { id: 'mesh-1', nodes: [{ id: 'n1', workspace: '/work/proj-one' }, { id: 'n3', workspace: '/work/proj-two', daemonId: PEER }] };
    // PEER asks about SELF's workspaces: n1 has no daemonId, so it was never proven to be SELF's.
    expect(ids(meshScopeFromEntry(mesh, SELF, PEER))).toEqual([]);
  });

  it('still gives a peer-served request the nodes that positively identify the machine', () => {
    const mesh = { id: 'mesh-1', nodes: [
      { id: 'n1', workspace: '/work/proj-one' },
      { id: 'n2', workspace: '/work/proj-two', daemonId: SELF },
      { id: 'n3', workspace: '/work/other', daemonId: PEER },
    ] };
    expect(ids(meshScopeFromEntry(mesh, SELF, PEER))).toEqual(['ws-2']);
  });

  it('does not count an anonymous node on a member daemon, even for the local caller', () => {
    const mesh = { ...standaloneMesh, meshHost: { role: 'member', hostDaemonId: PEER } };
    expect(ids(meshScopeFromEntry(mesh, SELF))).toEqual([]);
  });

  it('does not count an anonymous node when another daemon is the pinned host', () => {
    const mesh = { ...standaloneMesh, meshHost: { role: 'host', hostDaemonId: PEER } };
    expect(ids(meshScopeFromEntry(mesh, SELF))).toEqual([]);
  });

  it('with a foreign peer on the roster and no host pin the host is unknown: anonymous nodes stay out', () => {
    expect(ids(meshScopeFromEntry(standaloneMesh, SELF))).toEqual([]);
  });
});
