import { describe, it, expect } from 'vitest';

import {
  resolveProviderRole,
  resolveProviderMaxParallel,
  normalizeMeshSchedulingStrategy,
  resolveNodeSchedulingPriority,
  DEFAULT_MESH_SCHEDULING_STRATEGY,
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

describe('normalizeMeshSchedulingStrategy', () => {
  it('defaults to first_eligible for missing/blank/unknown values', () => {
    expect(DEFAULT_MESH_SCHEDULING_STRATEGY).toBe('first_eligible');
    expect(normalizeMeshSchedulingStrategy(undefined)).toBe('first_eligible');
    expect(normalizeMeshSchedulingStrategy(null)).toBe('first_eligible');
    expect(normalizeMeshSchedulingStrategy('')).toBe('first_eligible');
    expect(normalizeMeshSchedulingStrategy('nonsense')).toBe('first_eligible');
    expect(normalizeMeshSchedulingStrategy(42 as any)).toBe('first_eligible');
  });

  it('accepts every valid strategy (trimmed)', () => {
    expect(normalizeMeshSchedulingStrategy('least_loaded')).toBe('least_loaded');
    expect(normalizeMeshSchedulingStrategy('round_robin')).toBe('round_robin');
    expect(normalizeMeshSchedulingStrategy('priority_only')).toBe('priority_only');
    expect(normalizeMeshSchedulingStrategy('  least_loaded  ')).toBe('least_loaded');
  });
});

describe('resolveNodeSchedulingPriority', () => {
  it('defaults to 0 for missing/blank/NaN', () => {
    expect(resolveNodeSchedulingPriority(undefined)).toBe(0);
    expect(resolveNodeSchedulingPriority(null)).toBe(0);
    expect(resolveNodeSchedulingPriority({})).toBe(0);
    expect(resolveNodeSchedulingPriority({ schedulingPriority: NaN })).toBe(0);
  });

  it('returns the configured numeric priority (incl. negative)', () => {
    expect(resolveNodeSchedulingPriority({ schedulingPriority: 5 })).toBe(5);
    expect(resolveNodeSchedulingPriority({ schedulingPriority: -3 })).toBe(-3);
    expect(resolveNodeSchedulingPriority({ schedulingPriority: 2.5 })).toBe(2.5);
  });
});
