import { describe, expect, it } from 'vitest';
import { toHostedCliRuntimeDescriptor } from '../../src/commands/low-family/session-host.js';

describe('session-host control restore descriptor', () => {
  it.each([' mesh-test ', '', '   ', 42, null])('validates the persisted coordinator mesh association (%j)', value => {
    expect(toHostedCliRuntimeDescriptor({ sessionId: 'coordinator', providerType: 'test-cli', workspace: '/test',
      lifecycle: 'running', meta: { meshCoordinatorFor: value } })?.meshCoordinatorFor)
      .toBe(value === ' mesh-test ' ? 'mesh-test' : undefined);
  });

  it('preserves assistant and approval provenance for explicit resume/restart', () => {
    expect(toHostedCliRuntimeDescriptor({ sessionId: 'assistant', providerType: 'claude-cli', workspace: '/assistant',
      lifecycle: 'running', meta: { assistant: true, autoApproveMode: 'accept-edits', managedBy: 'adhdev-cloud' } }))
      .toMatchObject({ assistant: true, autoApproveMode: 'accept-edits', managedBy: 'adhdev-cloud' });
  });
});
