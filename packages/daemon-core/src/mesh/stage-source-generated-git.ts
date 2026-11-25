import { execFileSync } from 'node:child_process';
import { gitChildEnv } from '../git/git-locale.js';
import { TextDecoder } from 'node:util';
import { STAGE_DIFF_SCAN_BYTES } from './stage-diff-content-guard.js';
import { StageDiffBlocked } from './stage-diff-manifest.js';
import type { StageSourceGeneratedHost } from './stage-source-generated-evidence.js';

const pin = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const rawHeader = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]+) ([a-f0-9]+) ([ADMT])$/;

type GitPort = Pick<StageSourceGeneratedHost, 'inventory' | 'sourcePatch'> & {
    blob(repo: 'root' | 'oss', oid: string, maxBytes: number): Buffer;
    files(scope: Scope, repo: 'root' | 'oss', side: 'before' | 'after'): Map<string, { mode: string; oid: string }>;
};
type Scope = Parameters<GitPort['inventory']>[0];

/** Host-owned Git object reader. Directory bindings must come from the verified
 * checkout provider. Both methods address immutable commits, never the index. */
export function createStageSourceGeneratedGit(rootGitDir: string, ossGitDir: string): GitPort {
    function fail(code: string): never {
        throw new StageDiffBlocked(code, {});
    }
    function git(repo: 'root' | 'oss', args: string[], maxBuffer = STAGE_DIFF_SCAN_BYTES) {
        try {
            return execFileSync('git', ['--no-replace-objects', '--git-dir', repo === 'root' ? rootGitDir : ossGitDir,
                '--literal-pathspecs', ...args], { maxBuffer, env: gitChildEnv(), windowsHide: true, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch {
            return fail('review_source_generated_git');
        }
    }
    function ossLink(value: string): string {
        // StageDiffScope contains the complete root gitlink inventory in
        // production. A single pin is supported for existing verifier callers.
        if (pin.test(value)) return value;
        const links = value.split('\n').filter(line => line.endsWith('\toss'));
        const match = /^160000 commit ([a-f0-9]+)\toss$/.exec(links[0] ?? '');
        if (links.length !== 1 || !match || !pin.test(match[1]!)) fail('review_source_generated_scope');
        return match![1]!;
    }
    const range = (scope: Scope, repo: 'root' | 'oss') => repo === 'root'
        ? [scope.baseSha, scope.headSha] as const : [ossLink(scope.gitlinks.base), ossLink(scope.gitlinks.head)] as const;
    function tree(repo: 'root' | 'oss', commit: string) {
        if (!pin.test(commit)) fail('review_source_generated_scope');
        const treeId = (git(repo, ['rev-parse', '--verify', commit + '^{tree}'], 512)).toString().trim();
        if (!pin.test(treeId)) fail('review_source_generated_scope');
        return treeId;
    }
    return {
        files(scope, repo, side) {
            const bytes = git(repo, ['ls-tree', '-r', '-z', range(scope, repo)[side === 'before' ? 0 : 1]]);
            const entries = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).split('\0');
            if (entries.pop() !== '') fail('review_source_generated_inventory');
            return new Map(entries.map(entry => {
                const parsed = /^([0-7]{6}) (?:blob|commit) ([a-f0-9]+)\t(.+)$/s.exec(entry);
                if (!parsed || !pin.test(parsed[2]!)) return fail('review_source_generated_inventory');
                return [parsed[3]!, { mode: parsed[1]!, oid: parsed[2]! }];
            }));
        },
        blob(repo, oid, maxBytes) {
            if (!pin.test(oid)) fail('review_source_generated_scope');
            return git(repo, ['cat-file', 'blob', oid], maxBytes);
        },
        inventory(scope) {
            const [ossBase, ossHead] = range(scope, 'oss');
            const changes: Awaited<ReturnType<GitPort['inventory']>>['changes'] = [];
            const trees = {
                root: { baseTree: tree('root', scope.baseSha), headTree: tree('root', scope.headSha) },
                oss: { baseTree: tree('oss', ossBase), headTree: tree('oss', ossHead) },
            };
            for (const [i, commit] of range(scope, 'root').entries()) {
                const link = range(scope, 'oss')[i];
                const recorded = i === 0 ? scope.gitlinks.base : scope.gitlinks.head;
                const actual = (git('root', ['ls-tree', '-r', commit])).toString().split('\n')
                    .filter(line => line.startsWith('160000 ')).join('\n');
                if (!pin.test(recorded) && recorded !== actual) fail('review_source_generated_scope');
                if ((git('root', ['ls-tree', commit, '--', 'oss'], 512)).toString() !== `160000 commit ${link}\toss\n`) {
                    fail('review_source_generated_scope');
                }
            }
            for (const repo of ['root', 'oss'] as const) {
                const raw = git(repo, ['diff-tree', '--no-commit-id', '-r', '--raw', '-z', '--no-renames', '--ignore-submodules=none',
                    '--no-abbrev', ...range(scope, repo)]);
                if (!raw.length) continue;
                const values = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw).split('\0');
                if (values.pop() !== '' || values.length % 2) fail('review_source_generated_inventory');
                for (let i = 0; i < values.length; i += 2) {
                    const parsed = rawHeader.exec(values[i]!);
                    if (!parsed || !values[i + 1] || !pin.test(parsed[3]!) || !pin.test(parsed[4]!)) {
                        return fail('review_source_generated_inventory');
                    }
                    changes.push({ repo, path: values[i + 1]!,
                        before: parsed[1] === '000000' ? null : { mode: parsed[1]!, oid: parsed[3]! },
                        after: parsed[2] === '000000' ? null : { mode: parsed[2]!, oid: parsed[4]! } });
                }
            }
            return { trees, changes };
        },
        *sourcePatch(scope, entries) {
            for (const repo of ['root', 'oss'] as const) {
                const paths = entries.filter(entry => entry.repo === repo).map(entry => entry.path);
                if (paths.length) {
                    yield git(repo, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--binary', '--full-index',
                        '--no-renames', '--ignore-submodules=none', '--submodule=short', ...range(scope, repo), '--', ...paths]);
                }
            }
        },
    };
}
