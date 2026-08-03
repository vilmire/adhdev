/**
 * usage-normalize — provider-neutral token/cost usage extracted from native history.
 *
 * Every CLI provider records token accounting in its own shape and its own
 * accumulation semantics. This module defines the single normalized type the
 * four native-history adapters emit, plus the folding rules that turn a stream
 * of per-provider records into one per-session total.
 *
 * ── Accumulation semantics (the part that is easy to get wrong) ──────────────
 *
 * The providers disagree about what a usage record MEANS, and summing them
 * uniformly produces wildly wrong numbers:
 *
 *   claude-cli  DELTA      one `message.usage` per assistant message.
 *   kimi        DELTA      `usage.record` with `usageScope: "turn"`.
 *   codex-cli   CUMULATIVE `total_token_usage` is the running session total,
 *                          re-reported in full on EVERY turn. Summing N records
 *                          over-counts by roughly N×. (Observed live: a single
 *                          session's last record read 53,220,473 input tokens —
 *                          that is the session total, not one turn.)
 *   hermes-cli  CUMULATIVE the `sessions` row holds session-to-date totals.
 *
 * `mode` carries this per record so `foldUsageRecords` can apply the right
 * rule: DELTA records sum, CUMULATIVE records take the last (max) observation.
 * A caller must never sum a mixed list by hand.
 *
 * ── Cost ────────────────────────────────────────────────────────────────────
 *
 * Only hermes persists a USD figure. It is carried through verbatim when the
 * provider marks it trustworthy and dropped otherwise (see `readHermesCost`),
 * because hermes ships `estimated_cost_usd = 0.0` with `cost_status = 'unknown'`
 * when no pricing table was available — a real zero and an absent value are
 * different facts and must not be conflated. No cost is ever computed here from
 * a token count: that would require a pricing table this layer has no business
 * owning, and a stale table silently produces confidently wrong money numbers.
 *
 * OSS code (AGPL-3.0). Must not import from packages/ (proprietary).
 */

/** How a provider's usage record accumulates across a session. */
export type NativeUsageMode = 'delta' | 'cumulative';

/**
 * Provider-neutral token usage.
 *
 * Token fields are always non-negative integers; a provider that does not
 * report a given dimension yields 0 rather than undefined, so arithmetic never
 * has to null-check. `costUsd` is genuinely optional — absent means "unknown",
 * NOT "free".
 */
export interface NativeUsage {
  /** Non-cached input tokens. */
  inputTokens: number;
  /** Generated output tokens. */
  outputTokens: number;
  /** Input tokens served from cache (cheaper; billed separately by most vendors). */
  cacheReadTokens: number;
  /** Input tokens written INTO the cache (billed at a premium by most vendors). */
  cacheCreationTokens: number;
  /** Reasoning/thinking tokens, when the provider reports them separately. */
  reasoningTokens?: number;
  /** USD cost, only when the provider itself computed one it considers valid. */
  costUsd?: number;
  /** Model identifier the provider attributed this usage to, when known. */
  model?: string;
}

/** One usage observation, tagged with the semantics needed to fold it. */
export interface NativeUsageRecord extends NativeUsage {
  /** Whether this observation is a per-turn delta or a session-to-date total. */
  mode: NativeUsageMode;
  /** Epoch ms of the observation, used to order cumulative records. */
  receivedAt: number;
}

/** Per-session rollup: totals plus the provenance needed to aggregate upward. */
export interface SessionUsageTotals extends NativeUsage {
  /** Provider session id these totals belong to. */
  providerSessionId: string;
  /** Which adapter produced them. */
  agent: string;
  /** Number of usage observations folded in (0 ⇒ the session reported none). */
  recordCount: number;
  /** Epoch ms of the newest observation, 0 when there were none. */
  lastUsageAt: number;
}

const ZERO: NativeUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/**
 * Coerce an arbitrary JSON value to a non-negative token count.
 *
 * Returns 0 for anything that is not a finite non-negative number — absent
 * fields, nulls, strings, NaN, and negatives all collapse to 0 so a malformed
 * record degrades to "no usage" instead of poisoning a total with NaN. A single
 * NaN would otherwise propagate through every downstream sum.
 */
export function readTokenCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/** True when a usage carries no countable tokens at all. */
export function isEmptyUsage(usage: NativeUsage): boolean {
  return (
    usage.inputTokens === 0
    && usage.outputTokens === 0
    && usage.cacheReadTokens === 0
    && usage.cacheCreationTokens === 0
    && !usage.reasoningTokens
  );
}

/**
 * Build a normalized usage from already-extracted numbers.
 * Optional fields are omitted (not zeroed) when they carry no information, so
 * "provider does not report reasoning" stays distinguishable from "0 reasoning".
 */
export function makeUsage(fields: {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheCreationTokens?: unknown;
  reasoningTokens?: unknown;
  costUsd?: number;
  model?: string;
}): NativeUsage {
  const usage: NativeUsage = {
    inputTokens: readTokenCount(fields.inputTokens),
    outputTokens: readTokenCount(fields.outputTokens),
    cacheReadTokens: readTokenCount(fields.cacheReadTokens),
    cacheCreationTokens: readTokenCount(fields.cacheCreationTokens),
  };
  if (fields.reasoningTokens !== undefined) {
    const reasoning = readTokenCount(fields.reasoningTokens);
    if (reasoning > 0) usage.reasoningTokens = reasoning;
  }
  if (typeof fields.costUsd === 'number' && Number.isFinite(fields.costUsd) && fields.costUsd >= 0) {
    usage.costUsd = fields.costUsd;
  }
  const model = typeof fields.model === 'string' ? fields.model.trim() : '';
  if (model) usage.model = model;
  return usage;
}

function addInto(target: NativeUsage, source: NativeUsage): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheCreationTokens += source.cacheCreationTokens;
  if (source.reasoningTokens) {
    target.reasoningTokens = (target.reasoningTokens ?? 0) + source.reasoningTokens;
  }
  if (source.costUsd !== undefined) {
    target.costUsd = (target.costUsd ?? 0) + source.costUsd;
  }
}

function replaceWith(target: NativeUsage, source: NativeUsage): void {
  target.inputTokens = source.inputTokens;
  target.outputTokens = source.outputTokens;
  target.cacheReadTokens = source.cacheReadTokens;
  target.cacheCreationTokens = source.cacheCreationTokens;
  if (source.reasoningTokens !== undefined) target.reasoningTokens = source.reasoningTokens;
  if (source.costUsd !== undefined) target.costUsd = source.costUsd;
}

/**
 * Fold a session's usage observations into one total.
 *
 * DELTA records are summed. CUMULATIVE records are NOT summed — the newest one
 * already IS the session total, so the latest observation replaces rather than
 * accumulates. When a provider emits both (none do today, but the type allows
 * it), the cumulative baseline and the delta sum are added, which is the only
 * combination that does not double-count.
 *
 * Cumulative recency is decided by `receivedAt`, falling back to input order
 * when timestamps tie or are absent — so an unordered list still folds
 * deterministically.
 */
export function foldUsageRecords(
  records: readonly NativeUsageRecord[],
  meta: { providerSessionId: string; agent: string },
): SessionUsageTotals {
  const deltas: NativeUsage = { ...ZERO };
  let latestCumulative: NativeUsageRecord | null = null;
  let latestCumulativeIndex = -1;
  let lastUsageAt = 0;
  let model: string | undefined;

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.receivedAt > lastUsageAt) lastUsageAt = record.receivedAt;
    if (record.model) model = record.model;

    if (record.mode === 'cumulative') {
      // Strictly-greater on timestamp, with index as the tiebreak, keeps the
      // LAST record of an equal-timestamp run — matching append order, which is
      // the true chronology when a provider stamps a whole turn identically.
      const newer = latestCumulative === null
        || record.receivedAt > latestCumulative.receivedAt
        || (record.receivedAt === latestCumulative.receivedAt && i > latestCumulativeIndex);
      if (newer) {
        latestCumulative = record;
        latestCumulativeIndex = i;
      }
      continue;
    }
    addInto(deltas, record);
  }

  const total: NativeUsage = { ...ZERO };
  if (latestCumulative) replaceWith(total, latestCumulative);
  addInto(total, deltas);
  if (model && !total.model) total.model = model;

  return {
    ...total,
    providerSessionId: meta.providerSessionId,
    agent: meta.agent,
    recordCount: records.length,
    lastUsageAt,
  };
}

/**
 * Sum already-folded per-session totals into one bucket (e.g. per mesh).
 *
 * Session totals are absolute, so this is a plain sum regardless of the modes
 * that produced them — the cumulative/delta distinction was already resolved by
 * `foldUsageRecords`. Cost sums only over sessions that reported one; a mesh
 * total therefore under-reports rather than inventing cost for sessions whose
 * provider gave none, and `costCoverage` makes that explicit instead of leaving
 * a partial number to be misread as complete.
 */
export function sumSessionUsage(totals: readonly SessionUsageTotals[]): NativeUsage & {
  sessionCount: number;
  costCoverage: { withCost: number; total: number };
} {
  const sum: NativeUsage = { ...ZERO };
  let withCost = 0;
  for (const entry of totals) {
    addInto(sum, {
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cacheCreationTokens: entry.cacheCreationTokens,
      ...(entry.reasoningTokens !== undefined ? { reasoningTokens: entry.reasoningTokens } : {}),
      ...(entry.costUsd !== undefined ? { costUsd: entry.costUsd } : {}),
    });
    if (entry.costUsd !== undefined) withCost += 1;
  }
  return { ...sum, sessionCount: totals.length, costCoverage: { withCost, total: totals.length } };
}

/** Total billable tokens, for display/sorting. Cache reads included — they cost money. */
export function totalTokens(usage: NativeUsage): number {
  return (
    usage.inputTokens
    + usage.outputTokens
    + usage.cacheReadTokens
    + usage.cacheCreationTokens
    + (usage.reasoningTokens ?? 0)
  );
}
