/**
 * Coordinator operating-rules layer — repo-read with a bundled fallback.
 *
 * The high-churn operating rules (orchestration workflow, dispatch policy,
 * session reuse, branch convergence…) used to live only as compiled string
 * constants inside coordinator-prompt.ts, so a merged rules fix stayed
 * invisible to live coordinators until the next deploy + daemon restart
 * ("rules merged ≠ rules live" — fragmentation audit 2026-08-24 CRIT #1).
 *
 * This module resolves that layer at COORDINATOR LAUNCH:
 *   1. `<mesh base workspace>/.adhdev/coordinator-rules.md` when present and
 *      non-trivial — the repo is the source of truth, merged rules apply on
 *      the next coordinator launch with no deploy in between.
 *   2. Otherwise the bundled default (default-coordinator-rules.ts, generated
 *      from this monorepo's own .adhdev/coordinator-rules.md and kept in
 *      sync by check:coordinator-rules-sync).
 *
 * Fail-open by design: an unreadable/empty/gutted repo file falls back to the
 * bundled default — a coordinator launching with no rules at all is strictly
 * worse than one launching with slightly stale rules. Safety invariants (the
 * destructive-git approval rule) deliberately do NOT live in this layer; they
 * stay compiled in coordinator-prompt.ts so no repo file can remove them.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_COORDINATOR_RULES } from './default-coordinator-rules.js';

export interface CoordinatorRulesResolution {
    /** The full rules-layer markdown injected into the prompt. */
    text: string;
    source: 'repo' | 'bundled';
    /** Absolute path of the repo file when source === 'repo'. */
    path?: string;
    /** source === 'repo' only: true when the repo file differs from the bundled default. */
    differsFromBundled?: boolean;
}

/**
 * A repo file smaller than this is treated as a stub (someone touched the
 * path but wrote no real rules) and the bundled default is used instead.
 */
const MIN_MEANINGFUL_RULES_CHARS = 200;

export function resolveCoordinatorRules(meshBaseWorkspace?: string | null): CoordinatorRulesResolution {
    const bundled: CoordinatorRulesResolution = { text: DEFAULT_COORDINATOR_RULES, source: 'bundled' };
    const workspace = (meshBaseWorkspace ?? '').trim();
    if (!workspace) return bundled;
    const rulesPath = path.join(workspace, '.adhdev', 'coordinator-rules.md');
    try {
        const text = fs.readFileSync(rulesPath, 'utf8');
        if (text.trim().length < MIN_MEANINGFUL_RULES_CHARS) return bundled;
        return {
            text,
            source: 'repo',
            path: rulesPath,
            differsFromBundled: text !== DEFAULT_COORDINATOR_RULES,
        };
    } catch {
        return bundled;
    }
}

/**
 * Split the rules layer for the {{workflow}} / {{rules}} override-template
 * placeholders: everything before the `## Rules` H2 is the workflow half,
 * `## Rules` onward is the rules half. A repo file without that exact header
 * keeps the whole text in the rules half (and the workflow half empty) so no
 * content is ever silently dropped from an override template that uses
 * {{rules}}.
 */
export function splitRulesLayer(text: string): { workflow: string; rules: string } {
    const match = /^## Rules\b/m.exec(text);
    if (!match || match.index === undefined) return { workflow: '', rules: text.trim() };
    return {
        workflow: text.slice(0, match.index).trim(),
        rules: text.slice(match.index).trim(),
    };
}
