import assert from 'node:assert/strict';
import test from 'node:test';

import { CloudTransport } from '../src/transports/cloud.js';
import { LocalTransport } from '../src/transports/local.js';
import { isLocalTransport } from '../src/transports/mode.js';

test('isLocalTransport distinguishes real local and cloud transports by local-only command capability', () => {
  assert.equal(isLocalTransport(new LocalTransport()), true);
  assert.equal(isLocalTransport(new CloudTransport({ apiKey: 'adk_test' })), false);
});
