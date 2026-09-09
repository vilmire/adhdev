import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { probeRefineBaseCas } from '../../src/mesh/mesh-refine-base-cas.js';

/**
 * REFINE-GIT-TIMEOUT-DISCIPLINE injection proof.
 *
 * `git-executor.ts` / `git-worktree.ts` / `mesh-fast-forward.ts` all bound their
 * git children with a `timeout` (and run them through `gitChildEnv()`); the four
 * refine-path call sites below did not. Node's default is `timeout: 0`, i.e. NO
 * bound, and the two failure modes are different in kind:
 *
 *   - `mesh-refine-submodule-converge.ts` uses `execFileSync`, so an unreachable
 *     remote blocks the daemon's whole EVENT LOOP. Measured against a blackhole
 *     remote: the fetch had not returned after 25s and fired ZERO of the 30
 *     expected 100ms heartbeat ticks — the coordinator sees a live node as dead.
 *   - the async sites (`router-refine.ts`, `mesh-refine-base-cas.ts`) leave a
 *     promise that never settles, so the refine job holds its node slot forever.
 *
 * Separately, `mesh-refine-submodule-preflight.ts` had six call sites that
 * bypassed its own timed `runGit` helper AND its `gitChildEnv()`. Measured: with
 * `GIT_DIR` pointing at repo A, `git rev-parse HEAD` run with `cwd` = repo B
 * returned A's SHA — the preflight reading a different repository's history.
 *
 * The base-CAS case below is a real behavioural assertion (the module takes an
 * injectable exec). The others are source-level, because their call sites are
 * module-internal: an assertion on the shipped text is what actually pins them.
 */

function sourceOf(relative: string): string {
    return readFileSync(fileURLToPath(new URL(`../../src/mesh/${relative}`, import.meta.url)), 'utf8');
}

describe('Refinery git call sites are timeout- and env-bounded', () => {
    it('base-CAS passes a timeout to its network fetch (and reports a timed-out fetch as undeterminable)', async () => {
        const seen: Array<{ args: string[]; timeout: number | undefined }> = [];
        const verdict = await probeRefineBaseCas({
            execFileAsync: async (_file: string, args: string[], options: any) => {
                seen.push({ args, timeout: options?.timeout });
                if (args[0] === 'remote') return { stdout: 'git@example.com:o/r.git\n', stderr: '' };
                if (args[0] === 'fetch') {
                    // What a `timeout`-killed child actually surfaces as.
                    throw Object.assign(new Error('spawnSync git ETIMEDOUT'), { killed: true });
                }
                return { stdout: '', stderr: '' };
            },
            repoRoot: '/tmp/does-not-need-to-exist',
            baseBranch: 'main',
            pinnedBaseHead: 'a'.repeat(40),
        });

        const fetchCall = seen.find(c => c.args[0] === 'fetch');
        expect(fetchCall).toBeDefined();
        // The assertion that goes RED without the fix: timeout must be a real bound.
        expect(fetchCall!.timeout).toBeGreaterThan(0);
        // A remote we could not reach must never be reported as a comparison result.
        expect(verdict.state).toBe('undeterminable');
    });

    it('every execFileSync in the submodule-converge path declares a timeout', () => {
        const src = sourceOf('mesh-refine-submodule-converge.ts');
        // One options object per call site; each must carry a timeout.
        const callSites = src.match(/execFileSync\(GIT,[\s\S]*?\n?\s*\}\)/g) ?? [];
        expect(callSites.length).toBeGreaterThan(0);
        const untimed = callSites.filter(site => !/timeout:/.test(site));
        expect(untimed).toEqual([]);
        // ...and none may inherit a repo-redirecting GIT_DIR.
        const unsanitized = callSites.filter(site => !/gitChildEnv\(\)/.test(site));
        expect(unsanitized).toEqual([]);
    });

    it('the submodule preflight runs git ONLY through its timed, env-sanitized runGit helper', () => {
        const src = sourceOf('mesh-refine-submodule-preflight.ts');
        // Exactly one execFileAsync call in the module: the runGit helper itself.
        expect(src.match(/execFileAsync\(/g) ?? []).toHaveLength(1);
        const helper = src.match(/const runGit = async[\s\S]*?\n\};/)?.[0] ?? '';
        expect(helper).toMatch(/timeout:/);
        expect(helper).toMatch(/gitChildEnv\(\)/);
        expect(helper).toMatch(/windowsHide: true/);
    });

    it('router-refine bounds its fetch and push network calls', () => {
        // The batch Refinery orchestration (incl. one of the fetch call sites) moved out
        // of router-refine.ts into router-refine-batch-jobs.ts (pure move, no behavior
        // change). Only the read path follows it — every assertion below is unchanged.
        const src = ['router-refine.ts', 'router-refine-batch-jobs.ts']
            .map(f => readFileSync(
                fileURLToPath(new URL(`../../src/commands/${f}`, import.meta.url)),
                'utf8',
            ))
            .join('\n');
        const network = src.match(/execFileAsync\('git', \['(?:fetch|push)'[\s\S]{0,240}?\}\);/g) ?? [];
        expect(network.length).toBeGreaterThanOrEqual(3);
        expect(network.filter(call => !/timeout:/.test(call))).toEqual([]);
    });

    /**
     * ★The adjacent gap the first pass missed. `mesh-refine-gitlink-utils.ts` is
     * the sibling of the converge module pinned above, and its
     * `ensureSubmoduleCommitLocal` runs THREE `git fetch` strategies with
     * `protocol.file.allow=always` — a network-capable call that had no bound at
     * all. Measured in that exact shape: against a blackhole remote
     * (git://10.255.255.1) the unbounded fetch had NOT returned after 30s and
     * fired ZERO of the ~300 expected 100ms heartbeat ticks (execFileSync blocks
     * the whole event loop), while the same call with a timeout returned at its
     * bound. Source-level, for the same reason as the sibling assertions: these
     * call sites are module-internal, so pinning the shipped text is what
     * actually holds them.
     */
    it('every execFileSync in the gitlink-utils path declares a timeout and a sanitized env', () => {
        const src = sourceOf('mesh-refine-gitlink-utils.ts');
        const callSites = src.match(/execFileSync\(GIT,[\s\S]*?\n?\s*\}\)/g) ?? [];
        // Guards against the regex silently matching nothing after a refactor.
        expect(callSites.length).toBeGreaterThanOrEqual(8);
        expect(callSites.filter(site => !/timeout:/.test(site))).toEqual([]);
        expect(callSites.filter(site => !/gitChildEnv\(\)/.test(site))).toEqual([]);
    });

    it('the gitlink-utils network fetch strategies use the NETWORK bound, not the local one', () => {
        const src = sourceOf('mesh-refine-gitlink-utils.ts');
        // The `protocol.file.allow=always` fetch loop in ensureSubmoduleCommitLocal:
        // it accepts any transport, so it must carry the 30s network bound.
        const fetchSite = src.match(/execFileSync\(GIT, \['-c', 'protocol\.file\.allow=always'[\s\S]*?\n\s*\}\)/)?.[0] ?? '';
        expect(fetchSite).not.toBe('');
        expect(fetchSite).toMatch(/timeout: GIT_NETWORK_TIMEOUT_MS/);
        // Both bounds live beside gitChildEnv() so this module and router-refine.ts
        // share one value and one rationale rather than minting parallel constants.
        const locale = readFileSync(
            fileURLToPath(new URL('../../src/git/git-locale.ts', import.meta.url)),
            'utf8',
        );
        expect(locale).toMatch(/export const GIT_NETWORK_TIMEOUT_MS = 30_000;/);
        expect(locale).toMatch(/export const GIT_LOCAL_TIMEOUT_MS = 15_000;/);
    });

    it('router-refine bounds its SYNCHRONOUS rebase pair (event-loop blocking)', () => {
        const src = readFileSync(
            fileURLToPath(new URL('../../src/commands/router-refine.ts', import.meta.url)),
            'utf8',
        );
        // The rebase pair shares one options object (`rebaseExec`); the remaining
        // sync sites carry their options inline. Both must be bounded and sanitized.
        const rebaseExec = src.match(/const rebaseExec = \{[^}]*\}/)?.[0] ?? '';
        expect(rebaseExec).toMatch(/timeout: REFINE_GIT_LOCAL_TIMEOUT_MS/);
        expect(rebaseExec).toMatch(/env: gitChildEnv\(\)/);
        // ★Unbounded, a rebase that stalls (lock contention, a hung filter/hook)
        // freezes the daemon outright — it is SYNCHRONOUS.
        const rebaseCalls = src.match(/execFileSync\('git', \['rebase'[^;]*?\);/g) ?? [];
        expect(rebaseCalls).toHaveLength(2);
        expect(rebaseCalls.filter(call => !/rebaseExec/.test(call))).toEqual([]);

        const inlineSync = src.match(/execFileSync\('git',(?![^;]*rebaseExec)[\s\S]{0,240}?\}\)/g) ?? [];
        expect(inlineSync.length).toBeGreaterThanOrEqual(2);
        expect(inlineSync.filter(call => !/timeout:/.test(call))).toEqual([]);
        expect(inlineSync.filter(call => !/gitChildEnv\(\)/.test(call))).toEqual([]);
    });
});
