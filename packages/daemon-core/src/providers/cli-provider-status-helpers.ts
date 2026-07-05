/**
 * CLI provider status/launch pure helpers.
 *
 * Pure move out of cli-provider-instance.ts (no behavior change): the
 * side-effect-free status predicates, the turn-anchored duration computation,
 * the forced-new-session script resolver, the adapter-ready poll, and the lazy
 * node:sqlite DatabaseSync loader. cli-provider-instance re-exports the
 * public symbols (computeTurnAnchoredDurationMs, getForcedNewSessionScriptName,
 * waitForCliAdapterReady) so existing importers/tests keep their path.
 */

import * as path from 'path';
import { createRequire } from 'node:module';
import type { ProviderModule } from './contracts.js';

export function isIdleStatus(value: unknown): boolean {
    const status = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return !status || status === 'idle' || status === 'ready';
}

export function getMessageTime(message: unknown): number {
    if (!message || typeof message !== 'object') return 0;
    const record = message as { receivedAt?: unknown; timestamp?: unknown };
    const value = Number(record.receivedAt ?? record.timestamp ?? 0);
    return Number.isFinite(value) ? value : 0;
}

export function hasNonEmptyCliModalButtons(activeModal: unknown): boolean {
    const buttons = (activeModal as any)?.buttons;
    return Array.isArray(buttons) && buttons.some((button) => String(button || '').trim().length > 0);
}

export function isCliGeneratingLikeStatus(status: unknown): boolean {
    return status === 'generating' || status === 'streaming' || status === 'no_progress' || status === 'long_generating' || status === 'starting';
}

/**
 * NOTIF Defect-2a: the REPORTED short-generating duration, anchored on the IMMUTABLE turn
 * start. generatingStartedAt is reset to 0 on every mid-turn waiting_approval/idle blip and
 * re-armed on the next →generating, so a long turn that blips would otherwise measure only the
 * final 1.5-2.5s sliver. engine.currentTurnStartedAt (set once at onTurnStarted, surviving
 * mid-turn blips until the next turn starts) is preferred; generatingStartedAt is the fallback
 * for turns that never recorded an engine turn start. Returns 0 when neither anchor is set.
 * Pure / unit-testable.
 */
export function computeTurnAnchoredDurationMs(
    engineTurnStartedAt: number | undefined,
    generatingStartedAt: number,
    now: number,
): { durationMs: number; anchor: 'turn-start' | 'generatingStartedAt' | 'none' } {
    const engineStart = typeof engineTurnStartedAt === 'number' && Number.isFinite(engineTurnStartedAt)
        ? engineTurnStartedAt
        : 0;
    if (engineStart > 0) return { durationMs: now - engineStart, anchor: 'turn-start' };
    if (generatingStartedAt > 0) return { durationMs: now - generatingStartedAt, anchor: 'generatingStartedAt' };
    return { durationMs: 0, anchor: 'none' };
}

let CachedDatabaseSync: (new (path: string, options?: { readOnly?: boolean }) => {
    prepare(sql: string): { get(...params: Array<string | number>): unknown };
    close(): void;
}) | null = null;

export function getDatabaseSync() {
    if (CachedDatabaseSync) return CachedDatabaseSync;
    const requireFn = typeof require === 'function'
        ? require
        : createRequire(path.join(process.cwd(), '__adhdev_sqlite_loader__.js'));
    const sqliteModule = requireFn(`node:${'sqlite'}`) as {
        DatabaseSync: typeof CachedDatabaseSync;
    };
    CachedDatabaseSync = sqliteModule.DatabaseSync;
    if (!CachedDatabaseSync) {
        throw new Error('node:sqlite DatabaseSync unavailable');
    }
    return CachedDatabaseSync;
}

export function getForcedNewSessionScriptName(
    provider: ProviderModule | undefined,
    launchMode: 'new' | 'resume' | 'manual',
): string | null {
    if (!provider || launchMode !== 'new') return null;
    const resume = provider.resume;
    if (!resume?.supported) return null;
    if (Array.isArray(resume.newSessionArgs) && resume.newSessionArgs.length > 0) return null;

    const controls = Array.isArray((provider as any).controls) ? (provider as any).controls : [];
    for (const control of controls) {
        if (control?.type !== 'action') continue;
        if (typeof control?.confirmTitle === 'string' && control.confirmTitle.trim()) continue;
        if (typeof control?.confirmMessage === 'string' && control.confirmMessage.trim()) continue;
        if (typeof control?.confirmLabel === 'string' && control.confirmLabel.trim()) continue;
        const invokeScript = typeof control?.invokeScript === 'string' ? control.invokeScript.trim() : '';
        if (!invokeScript) continue;
        const controlId = typeof control?.id === 'string' ? control.id.trim() : '';
        if (controlId === 'new_session' || /^new.?session$/i.test(invokeScript)) {
            return invokeScript;
        }
    }

    return null;
}

export async function waitForCliAdapterReady(
    adapter: { isReady?: () => boolean; getStatus?: () => { status?: string } },
    options?: { timeoutMs?: number; pollMs?: number },
): Promise<void> {
    const timeoutMs = Math.max(100, options?.timeoutMs ?? 15_000);
    const pollMs = Math.max(10, options?.pollMs ?? 50);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (adapter?.isReady?.()) return;
        const status = adapter?.getStatus?.()?.status;
        if (status === 'stopped') {
            throw new Error('CLI runtime stopped before it became ready');
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    throw new Error(`CLI runtime did not become ready within ${timeoutMs}ms`);
}
