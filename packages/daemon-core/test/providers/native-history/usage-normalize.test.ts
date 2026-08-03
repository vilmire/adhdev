/**
 * Unit tests for the provider-neutral usage normalization layer.
 *
 * Covers:
 *  1. readTokenCount — coercion and the malformed-input floor
 *  2. makeUsage — optional fields omitted vs zeroed
 *  3. foldUsageRecords — delta sums, cumulative last-wins, mixed
 *  4. foldUsageRecords — ordering determinism for cumulative records
 *  5. sumSessionUsage — cross-session totals + cost coverage
 */

import { describe, expect, it } from 'vitest';
import {
  foldUsageRecords,
  isEmptyUsage,
  makeUsage,
  readTokenCount,
  sumSessionUsage,
  totalTokens,
  type NativeUsageRecord,
  type SessionUsageTotals,
} from '../../../src/providers/native-history/usage-normalize.js';

const META = { providerSessionId: 'sess-1', agent: 'test-cli' };

function delta(fields: Partial<NativeUsageRecord> & { receivedAt: number }): NativeUsageRecord {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    mode: 'delta',
    ...fields,
  };
}

function cumulative(fields: Partial<NativeUsageRecord> & { receivedAt: number }): NativeUsageRecord {
  return { ...delta(fields), mode: 'cumulative' };
}

describe('readTokenCount', () => {
  it('coerces valid numbers and numeric strings', () => {
    expect(readTokenCount(42)).toBe(42);
    expect(readTokenCount('42')).toBe(42);
    expect(readTokenCount(42.9)).toBe(42);
  });

  it('floors every malformed input to 0 so a total can never become NaN', () => {
    // A single NaN would propagate through every downstream sum, so absent,
    // null, non-numeric and negative values must all collapse to 0.
    for (const bad of [undefined, null, '', 'abc', NaN, Infinity, -5, {}, []]) {
      expect(readTokenCount(bad)).toBe(0);
    }
  });
});

describe('makeUsage', () => {
  it('always emits the four token dimensions as numbers', () => {
    const usage = makeUsage({});
    expect(usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('omits optional fields rather than zeroing them', () => {
    const usage = makeUsage({ inputTokens: 10 });
    expect('reasoningTokens' in usage).toBe(false);
    expect('costUsd' in usage).toBe(false);
    expect('model' in usage).toBe(false);
  });

  it('keeps a genuine zero cost distinct from an absent one', () => {
    expect(makeUsage({ costUsd: 0 }).costUsd).toBe(0);
    expect(makeUsage({}).costUsd).toBeUndefined();
  });

  it('rejects a negative cost as malformed', () => {
    expect(makeUsage({ costUsd: -1 }).costUsd).toBeUndefined();
  });
});

describe('foldUsageRecords', () => {
  it('sums delta records', () => {
    const folded = foldUsageRecords([
      delta({ inputTokens: 100, outputTokens: 10, receivedAt: 1 }),
      delta({ inputTokens: 200, outputTokens: 20, receivedAt: 2 }),
    ], META);
    expect(folded.inputTokens).toBe(300);
    expect(folded.outputTokens).toBe(30);
    expect(folded.recordCount).toBe(2);
    expect(folded.lastUsageAt).toBe(2);
  });

  it('takes the newest cumulative record instead of summing it', () => {
    // This is the codex case: total_token_usage is re-reported in full every
    // turn, so summing N records would over-count by ~N×.
    const folded = foldUsageRecords([
      cumulative({ inputTokens: 100, outputTokens: 10, receivedAt: 1 }),
      cumulative({ inputTokens: 250, outputTokens: 25, receivedAt: 2 }),
      cumulative({ inputTokens: 400, outputTokens: 40, receivedAt: 3 }),
    ], META);
    expect(folded.inputTokens).toBe(400);
    expect(folded.outputTokens).toBe(40);
    expect(folded.recordCount).toBe(3);
  });

  it('picks the newest cumulative record regardless of input order', () => {
    const folded = foldUsageRecords([
      cumulative({ inputTokens: 400, receivedAt: 3 }),
      cumulative({ inputTokens: 100, receivedAt: 1 }),
      cumulative({ inputTokens: 250, receivedAt: 2 }),
    ], META);
    expect(folded.inputTokens).toBe(400);
  });

  it('breaks equal-timestamp cumulative ties by append order (last wins)', () => {
    // Providers stamp a whole turn with one timestamp; append order is the
    // true chronology there.
    const folded = foldUsageRecords([
      cumulative({ inputTokens: 100, receivedAt: 5 }),
      cumulative({ inputTokens: 300, receivedAt: 5 }),
    ], META);
    expect(folded.inputTokens).toBe(300);
  });

  it('adds the cumulative baseline to the delta sum without double-counting', () => {
    const folded = foldUsageRecords([
      cumulative({ inputTokens: 1000, receivedAt: 1 }),
      delta({ inputTokens: 50, receivedAt: 2 }),
      delta({ inputTokens: 25, receivedAt: 3 }),
    ], META);
    expect(folded.inputTokens).toBe(1075);
  });

  it('returns a zeroed total for an empty record list', () => {
    const folded = foldUsageRecords([], META);
    expect(folded.recordCount).toBe(0);
    expect(folded.lastUsageAt).toBe(0);
    expect(isEmptyUsage(folded)).toBe(true);
  });

  it('carries session provenance through the fold', () => {
    const folded = foldUsageRecords([delta({ inputTokens: 1, receivedAt: 1 })], META);
    expect(folded.providerSessionId).toBe('sess-1');
    expect(folded.agent).toBe('test-cli');
  });

  it('sums reasoning and cost across delta records', () => {
    const folded = foldUsageRecords([
      delta({ reasoningTokens: 10, costUsd: 0.5, receivedAt: 1 }),
      delta({ reasoningTokens: 5, costUsd: 0.25, receivedAt: 2 }),
    ], META);
    expect(folded.reasoningTokens).toBe(15);
    expect(folded.costUsd).toBeCloseTo(0.75);
  });
});

describe('sumSessionUsage', () => {
  function session(fields: Partial<SessionUsageTotals>): SessionUsageTotals {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      providerSessionId: 's',
      agent: 'a',
      recordCount: 1,
      lastUsageAt: 1,
      ...fields,
    };
  }

  it('sums absolute session totals', () => {
    const sum = sumSessionUsage([
      session({ inputTokens: 100, outputTokens: 10 }),
      session({ inputTokens: 200, outputTokens: 20 }),
    ]);
    expect(sum.inputTokens).toBe(300);
    expect(sum.outputTokens).toBe(30);
    expect(sum.sessionCount).toBe(2);
  });

  it('reports partial cost coverage rather than implying a complete total', () => {
    // Only hermes reports USD. A mesh mixing providers yields a cost covering
    // some sessions, and the caller must be able to say which.
    const sum = sumSessionUsage([
      session({ costUsd: 1.5 }),
      session({}),
      session({ costUsd: 0.5 }),
    ]);
    expect(sum.costUsd).toBeCloseTo(2.0);
    expect(sum.costCoverage).toEqual({ withCost: 2, total: 3 });
  });

  it('leaves cost undefined when no session reported one', () => {
    const sum = sumSessionUsage([session({}), session({})]);
    expect(sum.costUsd).toBeUndefined();
    expect(sum.costCoverage).toEqual({ withCost: 0, total: 2 });
  });

  it('handles an empty list', () => {
    const sum = sumSessionUsage([]);
    expect(sum.sessionCount).toBe(0);
    expect(isEmptyUsage(sum)).toBe(true);
  });
});

describe('totalTokens', () => {
  it('counts cache reads — they are billed', () => {
    expect(totalTokens({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      reasoningTokens: 5,
    })).toBe(105);
  });
});
