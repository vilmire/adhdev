import { describe, it, expect } from 'vitest';

import {
  resolveProviderMaxParallel,
  normalizeMeshSchedulingStrategy,
  resolveNodeSchedulingPriority,
  DEFAULT_MESH_SCHEDULING_STRATEGY,
} from '../../src/repo-mesh-types.js';

describe('resolveProviderMaxParallel (slots-based)', () => {
  it('returns undefined when no matching slot declares a cap (backward compatible)', () => {
    expect(resolveProviderMaxParallel(undefined, 'claude-cli')).toBeUndefined();
    expect(resolveProviderMaxParallel(null, 'claude-cli')).toBeUndefined();
    expect(resolveProviderMaxParallel([], 'claude-cli')).toBeUndefined();
    // slot present for the provider but no cap → uncapped
    expect(resolveProviderMaxParallel([{ provider: 'claude-cli' }], 'claude-cli')).toBeUndefined();
    // capped slot but for a different provider
    expect(resolveProviderMaxParallel([{ provider: 'codex-cli', maxParallel: 2 }], 'claude-cli')).toBeUndefined();
  });

  it('returns undefined for a blank/missing providerType lookup', () => {
    const slots = [{ provider: 'claude-cli', maxParallel: 2 }];
    expect(resolveProviderMaxParallel(slots, '')).toBeUndefined();
    expect(resolveProviderMaxParallel(slots, undefined)).toBeUndefined();
    expect(resolveProviderMaxParallel(slots, null)).toBeUndefined();
  });

  it('matches the slot provider case-insensitively and trims', () => {
    const slots = [
      { provider: 'claude-cli', maxParallel: 2 },
      { provider: 'codex-cli', maxParallel: 4 },
    ];
    expect(resolveProviderMaxParallel(slots, 'CLAUDE-CLI')).toBe(2);
    expect(resolveProviderMaxParallel(slots, '  codex-cli ')).toBe(4);
  });

  it('sums maxParallel across multiple slots for the same provider', () => {
    const slots = [
      { provider: 'claude-cli', maxParallel: 2, difficulty: ['easy'] as any },
      { provider: 'claude-cli', maxParallel: 3, difficulty: ['difficult'] as any },
      { provider: 'codex-cli', maxParallel: 5 },
    ];
    expect(resolveProviderMaxParallel(slots, 'claude-cli')).toBe(5);
    expect(resolveProviderMaxParallel(slots, 'codex-cli')).toBe(5);
  });

  it('skips malformed slots without throwing', () => {
    const slots = [
      null as any,
      'nope' as any,
      { provider: '' } as any,
      { provider: 'claude-cli', maxParallel: 3 },
    ];
    expect(resolveProviderMaxParallel(slots, 'claude-cli')).toBe(3);
  });

  it('floors caps and ignores negative/non-finite ones', () => {
    expect(resolveProviderMaxParallel([{ provider: 'claude-cli', maxParallel: 3.9 }], 'claude-cli')).toBe(3);
    expect(resolveProviderMaxParallel([{ provider: 'claude-cli', maxParallel: 0 }], 'claude-cli')).toBe(0);
    // one bad + one good slot: bad is skipped, good still counts
    expect(resolveProviderMaxParallel([
      { provider: 'claude-cli', maxParallel: -1 } as any,
      { provider: 'claude-cli', maxParallel: 2 },
    ], 'claude-cli')).toBe(2);
    // only bad caps → undefined (no contribution)
    expect(resolveProviderMaxParallel([{ provider: 'claude-cli', maxParallel: NaN } as any], 'claude-cli')).toBeUndefined();
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

  it('maps the deprecated least_loaded/round_robin aliases to fitness (trimmed), keeps the rest verbatim', () => {
    expect(normalizeMeshSchedulingStrategy('least_loaded')).toBe('fitness');
    expect(normalizeMeshSchedulingStrategy('round_robin')).toBe('fitness');
    expect(normalizeMeshSchedulingStrategy('  least_loaded  ')).toBe('fitness');
    expect(normalizeMeshSchedulingStrategy('fitness')).toBe('fitness');
    expect(normalizeMeshSchedulingStrategy('priority_only')).toBe('priority_only');
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
