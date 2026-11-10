import { createHash } from 'node:crypto';
import type { TurnAttemptRef } from '@adhdev/mesh-shared';
import { recordCliRateLimitEvidence } from '../../quota/refresh.js';
import { stripAnsi, stripToolAndCodeLines } from '../spec/provider-failure-classifier.js';
import { parseClaudeUsageLimitBanner } from '../spec/provider-output-attribution.js';
import { emitTurnEnd, type TurnEvidencePort } from '../turn-evidence-port.js';

interface RuntimeQuotaHost {
    type: string;
    instanceId: string;
    providerSessionId?: string;
    adapter: { getStatus?: (opts: { allowParse: boolean }) => { activeModal?: unknown; activeInteractivePrompt?: unknown }; getTerminalScreenSnapshot?: () => { text?: string; hash?: string; truncated?: boolean } | null | undefined };
    turnEvidencePort?: TurnEvidencePort | null;
    currentAttemptRef?(): TurnAttemptRef | null;
    isMeshWorkerSession(): boolean;
}

// This is screen chrome, never a search through append-only history. Keep the
// original line boundaries/indentation so quotes, tool output and prose cannot
// manufacture a whole-banner match by whitespace folding.
export function claudeRuntimeQuotaScreen(screen: string): string | null {
    const clean = stripAnsi(screen).replace(/\r\n?/g, '\n');
    const filtered = new Set(stripToolAndCodeLines(clean).split('\n'));
    const lines = clean.split('\n').filter(line => line.trim());
    const banners = lines.slice(-8).filter((line, index, tail) =>
        // A literal example introduced by prose has no provider-chrome authority.
        !(index > 0 && /:\s*$/.test(tail[index - 1]!)) && /^[ ]{0,2}(?:You've hit your weekly limit|Usage limit reached)/.test(line)
        && filtered.has(line) && parseClaudeUsageLimitBanner(line));
    return banners.length ? banners.map(line => line.trim()).join('\n') : null;
}

const emitted = new WeakMap<object, string>();

/** Observe the current attempt only; the ledger owns stopping and retirement. */
export function observeRuntimeQuota(host: RuntimeQuotaHost, now = Date.now()): boolean {
    if (host.type !== 'claude-cli' || !host.turnEvidencePort || !host.isMeshWorkerSession()) return false;
    const ref = host.currentAttemptRef?.();
    if (!ref) return false;
    let snapshot: { text?: string; hash?: string; truncated?: boolean } | null | undefined;
    try {
        const status = host.adapter.getStatus?.({ allowParse: false });
        if (status?.activeModal || status?.activeInteractivePrompt) return false;
        snapshot = host.adapter.getTerminalScreenSnapshot?.();
    } catch { return false; }
    if (snapshot?.truncated) return false;
    const screen = snapshot?.text;
    if (!screen) return false;
    const banners = claudeRuntimeQuotaScreen(screen);
    if (!banners) return false;
    const key = `${ref.attemptId}:${ref.generation}`;
    const screenHash = snapshot?.hash || createHash('sha256').update(screen).digest('hex');
    const resetsAt = banners.split('\n').map(line => parseClaudeUsageLimitBanner(line, now)?.resetsAt)
        .find(at => at !== undefined);
    // Record before emitting: a settled writer can immediately release a queue
    // claim, whose existing provider selector must already see the runtime hold.
    recordCliRateLimitEvidence(host.type, { observedAt: now, ...(resetsAt ? { resetsAt } : {}),
        runtime: { sessionId: host.instanceId, screenHash, resetText: banners } });
    if (emitted.get(host) === key) return true;
    emitted.set(host, key);
    emitTurnEnd(host.turnEvidencePort, {
        sessionId: host.instanceId, attemptRef: ref, at: now,
        observedBy: 'claude_runtime_quota', source: 'fsm_edge',
        strength: 'genuine', providerFailure: 'usage_limit_exceeded',
        envelope: { finalSummary: banners, providerType: host.type,
            notice: { completionMetadata: { diagnosticReason: 'quota_blocked', screenHash,
                providerSessionId: host.providerSessionId, resetsAt, observedAt: now } } },
    });
    return true;
}
