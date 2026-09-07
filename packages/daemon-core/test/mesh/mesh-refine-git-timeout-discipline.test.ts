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
        const src = readFileSync(
            fileURLToPath(new URL('../../src/commands/router-refine.ts', import.meta.url)),
            'utf8',
        );
        const network = src.match(/execFileAsync\('git', \['(?:fetch|push)'[\s\S]{0,240}?\}\);/g) ?? [];
        expect(network.length).toBeGreaterThanOrEqual(3);
        expect(network.filter(call => !/timeout:/.test(call))).toEqual([]);
    });
});
