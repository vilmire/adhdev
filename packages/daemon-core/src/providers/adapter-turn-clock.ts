/**
 * The adapter's per-turn clock: when the current turn STARTED and which mesh task
 * it was bound to at submit time (`currentTurnStartedAt` / `currentTurnTaskId`).
 *
 * ★ PRODUCTION STATUS (2026-09-29 diet round): no production adapter sets these
 * fields. They were stamped by the legacy CliStateEngine's onTurnStarted, which was
 * deleted with ProviderCliAdapter (oss 48e5ed1a, 2026-08-17); SpecCliAdapter never
 * grew an equivalent. Every reader therefore sees `0` / `undefined` in production,
 * and only suites that drive fake adapters exercise the populated branch. The
 * consequences are material and are an open owner decision, not something a
 * refactor may settle silently:
 *   - injectedTaskHasStartedGenerating() is constant-false, so the stall-path
 *     transcript reconcile, the pre-cleanup mesh completion flush and the
 *     external-native completion evidence gate never admit;
 *   - the startup-grace fast-collapse synth never fires (no started-turn task id);
 *   - turn-duration / turn-scope anchors fall back to generatingStartedAt or the
 *     mesh injection time.
 * Either wire a real turn clock (SpecDriver's submit/turn-start edge) and
 * live-verify the rescue paths it re-enables, or delete those paths. Until then
 * the reads live HERE, in one place, instead of as `(adapter as any)` casts
 * scattered across the completion engine.
 */

type TurnClockCarrier = { currentTurnStartedAt?: unknown; currentTurnTaskId?: unknown } | null | undefined;

/** Turn-start instant (ms epoch), or 0 when the adapter carries no turn clock. */
export function adapterTurnStartedAt(adapter: unknown): number {
    const value = (adapter as TurnClockCarrier)?.currentTurnStartedAt;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Task id bound to the current turn at submit time, or undefined. */
export function adapterTurnTaskId(adapter: unknown): string | undefined {
    const value = (adapter as TurnClockCarrier)?.currentTurnTaskId;
    return typeof value === 'string' && value.trim() ? value : undefined;
}
