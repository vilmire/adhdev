/**
 * Periodic provider auto-update loop (docs/design/2026-10-10-provider-auto-update.md §3.1).
 *
 * Replaces the 08-10 read-only staleness probe timer (10 min after boot, then
 * every 24 h) in the same slot: the first run waits for the boot sync chain
 * to settle and then 5–10 min more (off the boot storm), then every 6 h ± 30
 * min. Jitter keeps a fleet that restarted together from hitting the registry
 * and the provider tarball host in the same second.
 *
 * Each run is `ProviderLoader.runAutoUpdate({ enabled })`: always the read-only
 * listing (the dashboard badge data), plus — when enabled and something is
 * stale — a gated activation restricted to the stale pinned types. The
 * enabled flag is re-read every run, so flipping `providerAutoUpdate` in
 * config takes effect without a restart.
 */

export const AUTO_UPDATE_FIRST_DELAY_MS = 5 * 60_000;
export const AUTO_UPDATE_FIRST_JITTER_MS = 5 * 60_000;
export const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60_000;
export const AUTO_UPDATE_INTERVAL_JITTER_MS = 30 * 60_000;

type RunResult = {
  probe: { error?: string; staleTypes: string[]; newTypes: string[]; channel: string };
  report: { activated: unknown[]; blocked?: unknown[] } | null;
};

export interface ProviderAutoUpdateLoopDeps {
  runAutoUpdate(options: { enabled: boolean }): Promise<RunResult>;
  isEnabled(): boolean;
  /** Settles when the boot-time verified sync chain finished — the loop never overlaps it. */
  bootSync: Promise<unknown>;
  /** Re-detect + reload consumers after an activation. */
  onActivated(count: number): Promise<void> | void;
  /** The probe saw stale or never-installed types (badge refresh). */
  onStale(): void;
  log: { info(msg: string): void; debug(msg: string): void };
  /** Test seams. */
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
}

export interface ProviderAutoUpdateLoop {
  stop(): void;
  /** Run one check now (tests / manual trigger). Never rejects. */
  runOnce(): Promise<void>;
}

export function startProviderAutoUpdateLoop(deps: ProviderAutoUpdateLoopDeps): ProviderAutoUpdateLoop {
  const random = deps.random ?? Math.random;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return { cancel: () => clearTimeout(handle) };
  });
  let stopped = false;
  let pending: { cancel(): void } | null = null;

  const runOnce = async (): Promise<void> => {
    try {
      const enabled = deps.isEnabled();
      const { probe, report } = await deps.runAutoUpdate({ enabled });
      if (probe.error) {
        deps.log.debug(`Channel staleness probe failed (kept previous snapshot): ${probe.error}`);
      } else if (probe.staleTypes.length > 0 || probe.newTypes.length > 0) {
        deps.log.info(`Channel staleness: ${probe.staleTypes.length} stale [${probe.staleTypes.join(', ')}], ${probe.newTypes.length} never-installed [${probe.newTypes.join(', ')}] (${probe.channel}; auto-update ${enabled ? 'on' : 'off'})`);
        try { deps.onStale(); } catch { /* a listener never breaks the loop */ }
      }
      const activated = report?.activated.length ?? 0;
      if (activated > 0) {
        deps.log.info(`Provider auto-update activated ${activated} provider(s) (${probe.channel})`);
        await deps.onActivated(activated);
      }
    } catch (e: any) {
      deps.log.debug(`Provider auto-update run error: ${e?.message || e}`);
    }
  };

  const schedule = (baseMs: number, jitterMs: number) => {
    if (stopped) return;
    pending = setTimer(() => {
      pending = null;
      void runOnce().then(() => schedule(AUTO_UPDATE_INTERVAL_MS - AUTO_UPDATE_INTERVAL_JITTER_MS, 2 * AUTO_UPDATE_INTERVAL_JITTER_MS));
    }, baseMs + Math.floor(random() * jitterMs));
  };

  void deps.bootSync.catch(() => undefined).then(() => schedule(AUTO_UPDATE_FIRST_DELAY_MS, AUTO_UPDATE_FIRST_JITTER_MS));

  return {
    stop() {
      stopped = true;
      pending?.cancel();
      pending = null;
    },
    runOnce,
  };
}
