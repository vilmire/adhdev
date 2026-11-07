import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-resolve-'));
const reg = path.join(tmp, 'registered');
const unreg = path.join(tmp, 'checkout');
const missing = path.join(tmp, 'gone');
fs.mkdirSync(reg); fs.mkdirSync(unreg);

const mesh = {
  id: 'mesh-1',
  nodes: [
    { id: 'n-reg', workspace: reg, daemonId: 'daemon_mach_x' },
    { id: 'n-un', workspace: unreg, label: 'Checkout', daemonId: 'daemon_mach_x' },
    { id: 'n-gone', workspace: missing, daemonId: 'daemon_mach_x' },
    { id: 'n-other', workspace: path.join(tmp, 'other'), daemonId: 'daemon_mach_y' },
  ],
};

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => '/nonexistent-adhdev-config',
  getMachineId: () => 'test-machine',
  getMachineNickname: () => null,
  loadConfig: () => ({ workspaces: [{ id: 'ws-reg', path: reg, label: 'reg' }] }),
}));
vi.mock('../../src/config/mesh-config.js', () => ({ getMesh: (id: string) => (id === 'mesh-1' ? mesh : null) }));

import { matchScopedWorkspace, meshScopeFromEntry } from '../../src/transfer/workspace-scope.js';
import { resolveTransferWorkspaceById } from '../../src/transfer/workspace-resolve.js';
import { findWorkspace } from '../../src/transfer/workspace-lookup.js';

const X = 'daemon_mach_x';
const Y = 'daemon_mach_y';

describe('unregistered mesh node folders as transfer workspaces', () => {
  it('scope lists an unregistered node folder under a synthetic id; registered keeps its real id once', () => {
    const scope = meshScopeFromEntry(mesh, X)!;
    const ids = scope.workspaces.map((w) => w.id).sort();
    expect(ids).toEqual(['mesh-node:mesh-1:n-gone', 'mesh-node:mesh-1:n-un', 'ws-reg']);
    expect(scope.workspaces.find((w) => w.id === 'mesh-node:mesh-1:n-un')).toMatchObject({ path: unreg, label: 'Checkout' });
    expect(matchScopedWorkspace(scope, 'mesh-node:mesh-1:n-un')?.path).toBe(unreg);
  });

  it('resolver returns the path on this machine, null elsewhere, null for a missing folder', () => {
    expect(resolveTransferWorkspaceById('mesh-node:mesh-1:n-un', X)?.path).toBe(unreg);
    expect(resolveTransferWorkspaceById('mesh-node:mesh-1:n-un', Y)).toBeNull();
    expect(resolveTransferWorkspaceById('mesh-node:mesh-1:n-gone', X)).toBeNull();
    expect(resolveTransferWorkspaceById('mesh-node:mesh-1:n-other', X)).toBeNull();
    expect(resolveTransferWorkspaceById('mesh-node:nope:n-un', X)).toBeNull();
    expect(resolveTransferWorkspaceById('ws-reg', X)?.path).toBe(reg);
  });

  it('findWorkspace resolves the synthetic id when given this daemon id', () => {
    expect(findWorkspace('mesh-node:mesh-1:n-un', X)?.path).toBe(unreg);
    expect(findWorkspace('mesh-node:mesh-1:n-un')).toBeNull();
  });
});
