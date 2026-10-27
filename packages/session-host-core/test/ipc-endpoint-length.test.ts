import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDefaultSessionHostEndpoint, validateSessionHostEndpoint } from '../src/ipc.js';
import { resolveSessionHostIpcKey } from '../src/instance-key.js';

for (const [platform, limit] of [['darwin', 104], ['linux', 108]] as const) {
  test(`${platform} Unix socket byte budget includes the trailing NUL`, () => {
    assert.doesNotThrow(() => validateSessionHostEndpoint({ kind: 'unix', path: '/' + 'x'.repeat(limit - 2) }, platform));
    assert.throws(() => validateSessionHostEndpoint({ kind: 'unix', path: '/' + 'x'.repeat(limit - 1) }, platform),
      new RegExp(`session_host_unix_socket_path_too_long: path_bytes=${limit} required_bytes=${limit + 1} limit_bytes=${limit}`));
  });
  test(`${platform} counts UTF-8 bytes, not JavaScript characters`, () => {
    const endpoint = { kind: 'unix' as const, path: '/' + 'é'.repeat(Math.ceil(limit / 2)) };
    assert.ok(endpoint.path.length < limit);
    assert.throws(() => validateSessionHostEndpoint(endpoint, platform), /session_host_unix_socket_path_too_long/);
  });
}
test('Windows named pipes are not constrained by sockaddr_un', () => {
  assert.doesNotThrow(() => validateSessionHostEndpoint({ kind: 'pipe', path: '\\\\.\\pipe\\' + 'x'.repeat(200) }, 'win32'));
});

test('valid legacy endpoints, including the exact byte boundary, stay identical', () => {
  for (const [platform, maxBytes] of [['darwin', 103], ['linux', 107]] as const) {
    const appName = 'host';
    const filename = `${appName}-session-host.sock`;
    const tmpDir = '/' + 'x'.repeat(maxBytes - Buffer.byteLength(filename) - 2);
    const endpoint = getDefaultSessionHostEndpoint(appName, { platform, tmpDir });
    assert.equal(Buffer.byteLength(endpoint.path), maxBytes);
    assert.equal(endpoint.path, path.join(tmpDir, filename));
    validateSessionHostEndpoint(endpoint, platform);
    const overflow = getDefaultSessionHostEndpoint(appName, { platform, tmpDir: tmpDir + 'x' });
    assert.match(overflow.path, /^\/tmp\/adhdev-sh-[0-9a-f]{64}\.sock$/);
    validateSessionHostEndpoint(overflow, platform);
  }
  for (const ipcKey of ['', '0123456789ab']) {
    const suffix = ipcKey ? `-${ipcKey}` : '';
    assert.equal(getDefaultSessionHostEndpoint('adhdev', { tmpDir: '/tmp', platform: 'darwin', ipcKey }).path,
      `/tmp/adhdev-session-host${suffix}.sock`);
  }
});

test('long tmpdir, app and config names derive deterministic disjoint namespaces', () => {
  const tmpDir = '/tmp/' + 'native-temp-'.repeat(12);
  const appName = 'instance-'.repeat(12);
  const config = '/tmp/' + 'config-'.repeat(30);
  const firstKey = resolveSessionHostIpcKey(config, '/tmp/home');
  const secondKey = resolveSessionHostIpcKey(config + '-other', '/tmp/home');
  const derive = (name = appName, ipcKey = firstKey, dir = tmpDir) =>
    getDefaultSessionHostEndpoint(name, { ipcKey, tmpDir: dir, platform: 'darwin' });
  const endpoint = derive();
  assert.deepEqual(endpoint, derive());
  validateSessionHostEndpoint(endpoint, 'darwin');
  assert.notEqual(endpoint.path, derive(appName, secondKey).path);
  assert.notEqual(endpoint.path, derive(appName + '-other').path);
  assert.notEqual(endpoint.path, derive(appName, firstKey, tmpDir + '-other').path);
  assert.notEqual(endpoint.path, derive(appName, '').path);
});

test('multibyte names shorten by encoded bytes even below the character limit', () => {
  const appName = 'é'.repeat(42);
  const legacy = `/tmp/${appName}-session-host.sock`;
  assert.ok(legacy.length < 103);
  assert.ok(Buffer.byteLength(legacy) > 103);
  const endpoint = getDefaultSessionHostEndpoint(appName, { platform: 'darwin', tmpDir: '/tmp' });
  assert.notEqual(endpoint.path, legacy);
  validateSessionHostEndpoint(endpoint, 'darwin');
  assert.notEqual(endpoint.path, getDefaultSessionHostEndpoint('e'.repeat(42), { platform: 'darwin', tmpDir: '/tmp' }).path);
});

test('native TMPDIR discovery agrees across independent processes without touching sockets', () => {
  const appName = 'discovery-'.repeat(12);
  const ipcKey = '0123456789ab';
  const endpoint = getDefaultSessionHostEndpoint(appName, { ipcKey });
  const modulePath = fileURLToPath(new URL('../src/ipc.ts', import.meta.url));
  const script = `const { getDefaultSessionHostEndpoint } = require(${JSON.stringify(modulePath)}); console.log(JSON.stringify(getDefaultSessionHostEndpoint(${JSON.stringify(appName)}, { ipcKey: ${JSON.stringify(ipcKey)} })));`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=commonjs', '-e', script], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), endpoint);
});

test('native Unix sockets bind and reconnect at the byte limit and at the shortened endpoint', { skip: process.platform === 'win32' }, async (t) => {
  const root = fs.mkdtempSync('/tmp/sh-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const maxBytes = process.platform === 'linux' ? 107 : 103;
  const prefix = root + '/';
  const boundary = prefix + 'é'.repeat(Math.floor((maxBytes - Buffer.byteLength(prefix)) / 2))
    + 'x'.repeat((maxBytes - Buffer.byteLength(prefix)) % 2);
  assert.equal(Buffer.byteLength(boundary), maxBytes);
  const shortened = getDefaultSessionHostEndpoint('native-'.repeat(20), { tmpDir: root, ipcKey: '0123456789ab' });
  for (const endpoint of [{ kind: 'unix' as const, path: boundary }, shortened]) {
    validateSessionHostEndpoint(endpoint);
    const server = net.createServer((socket) => socket.end('owned-fixture'));
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint.path, resolve); });
      assert.ok(fs.lstatSync(endpoint.path).isSocket());
      for (let attempt = 0; attempt < 2; attempt++) {
        const data = await new Promise<string>((resolve, reject) => {
          const socket = net.createConnection(endpoint.path);
          let text = '';
          socket.on('data', (chunk) => { text += chunk; });
          socket.on('error', reject);
          socket.on('end', () => resolve(text));
        });
        assert.equal(data, 'owned-fixture');
      }
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
