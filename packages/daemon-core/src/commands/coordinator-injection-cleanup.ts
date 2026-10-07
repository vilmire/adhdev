/**
 * Inject-then-remove for the file-based coordinator/assistant prompt injections
 * (context_file wrapper blocks and agent_file temp files).
 *
 * The CLI reads these files once at startup, so they are removed from disk once
 * the launched session has read them — otherwise a worker or an ordinary session
 * opened later in the same workspace would pick up the coordinator prompt.
 *
 * When to remove:
 *   - The launch failed (or threw): at once. Nothing will ever read the file, and
 *     no other path would remove it (the registry fallback only knows sessions
 *     that registered, which a failed launch never does).
 *   - The launch succeeded: when the session reports ready, but never before
 *     `minSettleMs` (the historical fixed 5 s — some CLIs read their context
 *     file after the first frame) and never later than `maxWaitMs` (a session
 *     that never becomes ready must not keep the block on disk forever).
 *
 * Every launch path that writes these files (mesh coordinator cli_command and
 * auto_import branches, the assistant launch) goes through here so the timing
 * and the sentinels cannot drift between them.
 */

import { LOG } from '../logging/logger.js';
import {
    cleanupCoordinatorAgentFile,
    stripCoordinatorWrapperFile,
    type CoordinatorInjectionEffect,
} from './mesh-coordinator.js';

export const INJECTION_CLEANUP_MIN_SETTLE_MS = 5_000;
export const INJECTION_CLEANUP_MAX_WAIT_MS = 60_000;
const INJECTION_CLEANUP_POLL_MS = 250;

type InjectionFiles = Pick<CoordinatorInjectionEffect, 'contextFilePath' | 'contextFileOwned' | 'contextFileSentinels' | 'agentFilePath'>;

export interface InjectionCleanupOptions {
    /** False when the launch failed or threw — remove at once. */
    launched: boolean;
    /** True once the launched session is ready (has read its startup files). Omitted ⇒ ready. */
    isReady?: () => boolean;
    /** Log tag, e.g. `coordinator cli_command`. */
    label: string;
    minSettleMs?: number;
    maxWaitMs?: number;
    pollMs?: number;
}

export function hasInjectionFiles(effect: InjectionFiles | null | undefined): boolean {
    return !!(effect?.contextFilePath || effect?.agentFilePath);
}

/** Remove the files an injection wrote, now. Idempotent and best-effort. */
export function removeInjectionFiles(effect: InjectionFiles, reason: string, label: string): void {
    if (effect.contextFilePath) {
        stripCoordinatorWrapperFile(effect.contextFilePath, effect.contextFileOwned === true, effect.contextFileSentinels);
        LOG.info('MeshCoordinator', `Stripped wrapper from ${effect.contextFilePath} (${label}, ${reason})`);
    }
    if (effect.agentFilePath) cleanupCoordinatorAgentFile(effect.agentFilePath);
}

/**
 * Schedule the removal described in the file header. Resolves once the files
 * are removed (tests await it under fake timers; production ignores it).
 */
export function scheduleInjectionCleanup(effect: InjectionFiles | null | undefined, opts: InjectionCleanupOptions): Promise<void> {
    if (!effect || !hasInjectionFiles(effect)) return Promise.resolve();
    if (!opts.launched) {
        removeInjectionFiles(effect, 'launch failed', opts.label);
        return Promise.resolve();
    }
    const minSettleMs = opts.minSettleMs ?? INJECTION_CLEANUP_MIN_SETTLE_MS;
    const maxWaitMs = Math.max(minSettleMs, opts.maxWaitMs ?? INJECTION_CLEANUP_MAX_WAIT_MS);
    const pollMs = opts.pollMs ?? INJECTION_CLEANUP_POLL_MS;
    const startedAt = Date.now();
    return new Promise<void>((resolve) => {
        const tick = (): void => {
            const elapsed = Date.now() - startedAt;
            let ready = true;
            if (opts.isReady) {
                try { ready = opts.isReady(); } catch { ready = true; }
            }
            if (ready || elapsed >= maxWaitMs) {
                removeInjectionFiles(effect, ready ? 'session ready' : `session not ready after ${maxWaitMs}ms`, opts.label);
                resolve();
                return;
            }
            const t = setTimeout(tick, pollMs);
            (t as { unref?: () => void }).unref?.();
        };
        const t = setTimeout(tick, minSettleMs);
        (t as { unref?: () => void }).unref?.();
    });
}

/**
 * Readiness probe over the daemon's local CLI adapters. A session whose adapter
 * is gone (exited during startup) counts as ready — nothing is left to read the file.
 */
export function localSessionReadyProbe(
    adapters: { get(id: string): unknown } | undefined,
    sessionId: string | undefined,
): (() => boolean) | undefined {
    if (!adapters || !sessionId) return undefined;
    return () => {
        const adapter = adapters.get(sessionId) as { isReady?: () => boolean; currentStatus?: string } | undefined;
        if (!adapter) return true;
        if (typeof adapter.isReady === 'function' && adapter.isReady()) return true;
        return adapter.currentStatus === 'idle';
    };
}
