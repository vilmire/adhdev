import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSessionHostEndpoint } from '../src/ipc.js';

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
