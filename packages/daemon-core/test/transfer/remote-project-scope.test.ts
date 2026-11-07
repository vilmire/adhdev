import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const cfg = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-scope-')));

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => cfg,
  getMachineId: () => 'test-machine',
  getMachineNickname: () => null,
  loadConfig: () => ({ workspaces: [] }),
}));
vi.mock('../../src/config/mesh-config.js', () => ({ getMesh: () => null }));

import { remoteProjectKey } from '../../src/assistant/remote-project-key.js';
import { writeMeshHostRecord } from '../../src/mesh/mesh-host-memory.js';
import { matchScopedWorkspace, resolveMeshScope } from '../../src/transfer/workspace-scope.js';
import { resolveTransferWorkspaceById } from '../../src/transfer/workspace-resolve.js';

const M = 'mesh-remote-1';
const HOST = 'daemon_mach_host';
const OTHER = 'daemon_mach_other';
const SELF = 'daemon_mach_self';
const IDENTITY = 'github.com/acme/widget';

function checkout(key: string, origin: string): string {
  const dir = path.join(cfg, 'remote-projects', key);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir], { windowsHide: true });
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin], { windowsHide: true });
  return dir;
}

const goodKey = remoteProjectKey(M, IDENTITY);
const goodDir = checkout(goodKey, 'https://github.com/acme/widget.git');
const wrongKey = 'a'.repeat(24);
checkout(wrongKey, 'https://github.com/acme/other.git');
fs.writeFileSync(path.join(cfg, 'remote-projects', `${goodKey}.lock`), '');
writeMeshHostRecord(M, HOST, 'pairing');

describe('remote-project checkouts as transfer scope on a member', () => {
  it('a request from the recorded host sees the checkout under a remote-project id', () => {
    const scope = resolveMeshScope(M, SELF, HOST)!;
    expect(scope.workspaces).toEqual([{ id: `remote-project:${goodKey}`, path: goodDir, label: 'widget' }]);
    expect(matchScopedWorkspace(scope, 'widget')?.id).toBe(`remote-project:${goodKey}`);
  });

  it('a local caller sees it too', () => {
    expect(resolveMeshScope(M, SELF, null)?.workspaces.map((w) => w.id)).toEqual([`remote-project:${goodKey}`]);
  });

  it('another daemon, or a mesh with no host record, gets nothing', () => {
    expect(resolveMeshScope(M, SELF, OTHER)).toBeNull();
    expect(resolveMeshScope('mesh-unknown', SELF, HOST)).toBeNull();
  });

  it('a folder whose key does not match its origin is excluded', () => {
    const ids = resolveMeshScope(M, SELF, HOST)!.workspaces.map((w) => w.id);
    expect(ids).not.toContain(`remote-project:${wrongKey}`);
  });

  it('resolveTransferWorkspaceById resolves the id, rejects malformed and unknown keys', () => {
    expect(resolveTransferWorkspaceById(`remote-project:${goodKey}`, SELF)?.path).toBe(goodDir);
    expect(resolveTransferWorkspaceById(`remote-project:${wrongKey}`, SELF)).toBeNull();
    expect(resolveTransferWorkspaceById('remote-project:../etc', SELF)).toBeNull();
    expect(resolveTransferWorkspaceById('remote-project:' + 'b'.repeat(24), SELF)).toBeNull();
    expect(resolveTransferWorkspaceById('remote-project:' + goodKey.toUpperCase(), SELF)).toBeNull();
  });
});
