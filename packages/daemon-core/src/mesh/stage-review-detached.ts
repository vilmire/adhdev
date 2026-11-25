import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gitChildEnv } from '../git/git-locale.js';
import type { ReviewerWorkspaceProvider } from './stage-ports.js';

const exec = promisify(execFile);
const pin = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

async function git(cwd: string, ...args: string[]) {
    const env = gitChildEnv();
    // Only the new repository's own config is used for checkout, including filters.
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
    env.GIT_CONFIG_COUNT = '0';
    return (await exec('git', ['--no-replace-objects', '-c', 'core.hooksPath=.git/disabled-hooks', ...args], {
        cwd, env, windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    })).stdout;
}

/** A detached checkout with a private index/config and read-only access to the source object store. */
export function createDetachedStageReviewerWorkspace(baseDir: () => string): ReviewerWorkspaceProvider {
    return {
        async release(path) {
            const base = await realpath(baseDir()).catch(() => undefined);
            if (base && dirname(path) === base && /^review-[a-zA-Z0-9]+$/.test(basename(path))) {
                await rm(path, { recursive: true, force: true });
            }
        },
        async prepare({ sourceWorkspace, rootSha }) {
            const base = baseDir();
            await mkdir(base, { recursive: true, mode: 0o700 });
            const root = await mkdtemp(join(await realpath(base), 'review-'));
            const release = () => rm(root, { recursive: true, force: true });
            let repos = 0;
            async function materialize(source: string, target: string, head: string): Promise<void> {
                if (!pin.test(head) || ++repos > 128 || await realpath(source) !== source
                    || await realpath((await git(source, 'rev-parse', '--show-toplevel')).trim()) !== source) {
                    throw new Error('review_detached_source');
                }
                const format = (await git(source, 'rev-parse', '--show-object-format')).trim();
                if (format !== 'sha1' && format !== 'sha256') throw new Error('review_detached_object_format');
                const objects = await realpath((await git(source, 'rev-parse', '--path-format=absolute', '--git-path', 'objects')).trim());
                if (/[\r\n]/.test(objects)) throw new Error('review_detached_objects');
                await mkdir(target, { recursive: true });
                if (await realpath(target) !== target) throw new Error('review_detached_path');
                await git(target, 'init', '--quiet', '--template=', '--object-format=' + format);
                await writeFile(join(target, '.git/objects/info/alternates'), objects + '\n', { flag: 'wx', mode: 0o600 });
                await git(target, 'checkout', '--quiet', '--detach', head);
                const links = (await git(target, 'ls-tree', '-r', '-z', head)).split('\0');
                for (const entry of links) {
                    const match = /^160000 commit ([a-f0-9]+)\t(.+)$/s.exec(entry);
                    if (!match) continue;
                    const [_, sha, path] = match;
                    const nextSource = resolve(source, path), nextTarget = resolve(target, path);
                    if (!nextSource.startsWith(source + sep) || !nextTarget.startsWith(target + sep)) throw new Error('review_detached_link');
                    await materialize(nextSource, nextTarget, sha);
                }
            }
            try {
                await materialize(await realpath(sourceWorkspace), root, rootSha);
                return { path: root, headSha: rootSha, release };
            } catch (error) {
                await release();
                throw error;
            }
        },
    };
}
