import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionHostServer } from '../src/server.js';

test('oversized Unix endpoint is rejected before eviction, guardian or listen effects', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-'));
  const server = new SessionHostServer({
    endpoint: { kind: 'unix', path: '/' + 'x'.repeat(108) },
    storageRootDir: path.join(root, 'storage'),
  });
  const effects: string[] = [];
  (server as any).evictPriorEndpointOwners = async () => { effects.push('eviction'); throw new Error('unexpected eviction'); };
  try {
    await assert.rejects(server.start(), /session_host_unix_socket_path_too_long: path_bytes=109 required_bytes=110 limit_bytes=(104|108)/);
    assert.deepEqual(effects, []);
    assert.equal((server as any).ipcServer, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
