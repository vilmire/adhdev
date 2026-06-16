import { describe, it, expect } from 'vitest';

import {
  resolveProviderRole,
  resolveProviderMaxParallel,
} from '../../src/repo-mesh-types.js';

describe('resolveProviderRole', () => {
  it('returns undefined when no providerRoles are configured', () => {
    expect(resolveProviderRole(undefined, 'claude-cli')).toBeUndefined();
    expect(resolveProviderRole(null, 'claude-cli')).toBeUndefined();
    expect(resolveProviderRole({}, 'claude-cli')).toBeUndefined();
    expect(resolveProviderRole({ providerRoles: [] }, 'claude-cli')).toBeUndefined();
  });

  it('returns undefined for a blank/missing providerType lookup', () => {
    const policy = { providerRoles: [{ providerType: 'claude-cli', role: 'coding' }] };
    expect(resolveProviderRole(policy, '')).toBeUndefined();
    expect(resolveProviderRole(policy, undefined)).toBeUndefined();
    expect(resolveProviderRole(policy, null)).toBeUndefined();
  });

  it('matches providerType case-insensitively and trims', () => {
    const policy = {
      providerRoles: [
        { providerType: 'claude-cli', role: 'coding', maxParallel: 2 },
        { providerType: 'codex-cli', role: 'investigation', maxParallel: 4 },
      ],
    };
    expect(resolveProviderRole(policy, 'CLAUDE-CLI')?.role).toBe('coding');
    expect(resolveProviderRole(policy, '  codex-cli ')?.role).toBe('investigation');
  });

  it('skips malformed entries without throwing', () => {
    const policy = {
      providerRoles: [
        null as any,
        'nope' as any,
        { providerType: '' },
        { providerType: 'claude-cli', role: 'orchestration' },
      ],
    };
    expect(resolveProviderRole(policy, 'claude-cli')?.role).toBe('orchestration');
  });
});

describe('resolveProviderMaxParallel', () => {
  it('returns undefined when no cap is declared (backward compatible)', () => {
    expect(resolveProviderMaxParallel(undefined, 'claude-cli')).toBeUndefined();
    expect(resolveProviderMaxParallel({ providerRoles: [{ providerType: 'claude-cli', role: 'coding' }] }, 'claude-cli')).toBeUndefined();
  });

  it('returns the declared cap as a floored non-negative integer', () => {
    expect(resolveProviderMaxParallel({ providerRoles: [{ providerType: 'claude-cli', maxParallel: 2 }] }, 'claude-cli')).toBe(2);
    expect(resolveProviderMaxParallel({ providerRoles: [{ providerType: 'claude-cli', maxParallel: 3.9 }] }, 'claude-cli')).toBe(3);
    expect(resolveProviderMaxParallel({ providerRoles: [{ providerType: 'claude-cli', maxParallel: 0 }] }, 'claude-cli')).toBe(0);
  });

  it('treats a negative or non-finite cap as undeclared', () => {
    expect(resolveProviderMaxParallel({ providerRoles: [{ providerType: 'claude-cli', maxParallel: -1 }] }, 'claude-cli')).toBeUndefined();
    expect(resolveProviderMaxParallel({ providerRoles: [{ providerType: 'claude-cli', maxParallel: NaN }] }, 'claude-cli')).toBeUndefined();
  });
});
