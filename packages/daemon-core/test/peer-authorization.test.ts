import { describe, expect, it } from 'vitest';
import { endsPeerAuthorization } from '../src/transport/peer-authorization.js';

describe('peer credential lifetime', () => {
  it.each(['token_revoked', 'credential_rejected', 'evicted', 'force_disconnected', 'clean_shutdown', 'version_incompatible', 'credentials_changed'])(
    'ends on %s', (reason) => expect(endsPeerAuthorization(reason)).toBe(true),
  );
  it.each([undefined, 'will_reconnect', 'ws_error', 'auth_timeout'])(
    'survives recoverable signaling interruption %s', (reason) => expect(endsPeerAuthorization(reason)).toBe(false),
  );
});
