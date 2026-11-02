import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { configDirIdentity } from '@adhdev/daemon-core';
import { IpcTransport } from '../src/transports/ipc.js';
import { LocalTransport } from '../src/transports/local.js';
import { meshAddNode, meshCreate } from '../src/tools/mesh-tools-crud.js';

// mesh_create / mesh_add_node must write to the daemon the MCP is CONNECTED to.
// The writes are daemon commands (create_mesh / add_mesh_node) in both transports —
// never an in-process meshes.json write — and when the MCP process resolves a
// DIFFERENT config dir than that daemon (the daemon stamps `daemonConfigIdentity`
// on its onboarding plan), the tools refuse before any write command is sent.

const PLAN_OK = (identity?: string) => ({
  success: true,
  dryRun: true,
  plan: { kind: 'create_mesh_and_onboard' },
  discovery: { repoRoot: '/repo', repoIdentity: 'example/repo', defaultBranch: 'main', origin: { urls: ['git@example.com:example/repo.git'] } },
  ...(identity ? { daemonConfigIdentity: identity } : {}),
});

function withConfigDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.ADHDEV_CONFIG_DIR;
  process.env.ADHDEV_CONFIG_DIR = dir;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = prev;
  });
}

function makeTransport(kind: 'ipc' | 'local', daemonIdentity: string | undefined) {
  const calls: Array<{ type: string; args: any }> = [];
  const transport: any = kind === 'ipc' ? new IpcTransport() : new LocalTransport({ port: 3847 });
  transport.command = async (type: string, args: any = {}) => {
    calls.push({ type, args });
    if (type === 'plan_mesh_onboarding') return PLAN_OK(daemonIdentity);
    if (type === 'create_mesh') return { success: true, mesh: { id: 'mesh-1', name: args.name, repoIdentity: args.repoIdentity, defaultBranch: 'main', nodes: [] } };
    if (type === 'add_mesh_node') return { success: true, node: { id: 'node-1', workspace: args.workspace } };
    throw new Error(`unexpected command ${type}`);
  };
  return { transport, calls };
}

for (const kind of ['ipc', 'local'] as const) {
  test(`${kind} mode: mesh_create + add_current go through daemon commands and write nothing in this process's config dir`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-mcp-cfg-'));
    try {
      await withConfigDir(dir, async () => {
        const { transport, calls } = makeTransport(kind, configDirIdentity());
        const out = JSON.parse(await meshCreate(transport, { name: 'm', add_current: true, workspace: '/repo' }));
        assert.equal(out.success, true, JSON.stringify(out));
        assert.equal(out.mesh_id, 'mesh-1');
        assert.equal(out.node_id, 'node-1');
        assert.deepEqual(calls.map(c => c.type), ['plan_mesh_onboarding', 'create_mesh', 'add_mesh_node']);
        assert.equal(fs.existsSync(path.join(dir, 'meshes.json')), false, 'the MCP process must not write meshes.json itself');
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${kind} mode: mesh_create refuses, sending no write, when the daemon's config dir is not this process's`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-mcp-cfg-'));
    try {
      await withConfigDir(dir, async () => {
        const { transport, calls } = makeTransport(kind, 'deadbeefdeadbeef');
        const out = JSON.parse(await meshCreate(transport, { name: 'm', add_current: true, workspace: '/repo' }));
        assert.equal(out.success, false);
        assert.equal(out.code, 'mesh_config_dir_mismatch');
        assert.match(out.action, /same config dir|ADHDEV_CONFIG_DIR/);
        assert.equal(calls.some(c => c.type === 'create_mesh' || c.type === 'add_mesh_node'), false);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('mesh_create with an explicit repo identity still verifies the daemon config dir before writing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-mcp-cfg-'));
  try {
    await withConfigDir(dir, async () => {
      const { transport, calls } = makeTransport('ipc', 'deadbeefdeadbeef');
      const out = JSON.parse(await meshCreate(transport, { name: 'm', repo_identity: 'example/repo' }));
      assert.equal(out.code, 'mesh_config_dir_mismatch');
      assert.equal(calls.some(c => c.type === 'create_mesh'), false);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mesh_add_node refuses on a config-dir mismatch and proceeds on a match', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-mcp-cfg-'));
  try {
    await withConfigDir(dir, async () => {
      const bad = makeTransport('ipc', 'deadbeefdeadbeef');
      const refused = JSON.parse(await meshAddNode(bad.transport, { mesh_id: 'mesh-1', workspace: '/repo' }));
      assert.equal(refused.code, 'mesh_config_dir_mismatch');
      assert.equal(bad.calls.some(c => c.type === 'add_mesh_node'), false);

      const good = makeTransport('ipc', configDirIdentity());
      const added = JSON.parse(await meshAddNode(good.transport, { mesh_id: 'mesh-1', workspace: '/repo' }));
      assert.equal(added.success, true, JSON.stringify(added));
      assert.equal(good.calls.some(c => c.type === 'add_mesh_node'), true);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a daemon that reports no config identity (older build) is not blocked; the explicit env override lifts a mismatch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-mcp-cfg-'));
  try {
    await withConfigDir(dir, async () => {
      const legacy = makeTransport('ipc', undefined);
      assert.equal(JSON.parse(await meshAddNode(legacy.transport, { mesh_id: 'mesh-1', workspace: '/repo' })).success, true);

      process.env.ADHDEV_MCP_ALLOW_CONFIG_DIR_MISMATCH = '1';
      try {
        const forced = makeTransport('ipc', 'deadbeefdeadbeef');
        assert.equal(JSON.parse(await meshAddNode(forced.transport, { mesh_id: 'mesh-1', workspace: '/repo' })).success, true);
      } finally {
        delete process.env.ADHDEV_MCP_ALLOW_CONFIG_DIR_MISMATCH;
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
