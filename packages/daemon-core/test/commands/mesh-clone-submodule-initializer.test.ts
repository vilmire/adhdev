import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { initializeWorktreeSubmodules } from '../../src/git/initialize-worktree-submodules.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temp() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'clone-initializer-')));
    roots.push(root); return root;
}
function git(cwd: string, ...args: string[]) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env,
        GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const rootScripts = fileURLToPath(new URL('../../../../../scripts/', import.meta.url));
it.skipIf(!existsSync(join(rootScripts, 'bootstrap-submodules.mjs')))('fresh clone uses validated sibling source before raw init and preserves shared config and exact pin', async () => {
    const base = temp(); const parent = join(base, 'parent'); const upstream = join(base, 'upstream'); const worker = join(base, 'worker');
    for (const dir of [parent, upstream]) { mkdirSync(dir); git(dir, 'init', '-q'); }
    writeFileSync(join(upstream, 'tracked'), 'original'); git(upstream, 'add', '.'); git(upstream, 'commit', '-qm', 'initial');
    const pin = git(upstream, 'rev-parse', 'HEAD');
    git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', upstream, 'module');
    git(parent, 'config', '-f', '.gitmodules', 'submodule.module.url', 'https://example.invalid/module.git');
    git(join(parent, 'module'), 'remote', 'set-url', 'origin', 'https://example.invalid/module.git');
    mkdirSync(join(parent, 'scripts'));
    for (const name of ['bootstrap-submodules.mjs', 'submodule-origins.mjs']) copyFileSync(join(rootScripts, name), join(parent, 'scripts', name));
    git(parent, 'add', '.'); git(parent, 'commit', '-qm', 'superproject');
    git(parent, 'worktree', 'add', '-qb', 'worker', worker);
    const sharedConfig = readFileSync(join(parent, '.git/config'), 'utf8');
    await expect(initializeWorktreeSubmodules(worker)).resolves.toBeUndefined();
    expect(git(join(worker, 'module'), 'rev-parse', 'HEAD')).toBe(pin);
    expect(readFileSync(join(worker, 'module/tracked'), 'utf8')).toBe('original');
    expect(git(join(worker, 'module'), 'status', '--porcelain')).toBe('');
    expect(git(join(worker, 'module'), 'config', '--get', 'remote.origin.url')).toBe('https://example.invalid/module.git');
    expect(readFileSync(join(parent, '.git/config'), 'utf8')).toBe(sharedConfig);
    // A later helper refusal must preserve WIP, with no raw update fallback.
    git(join(worker, 'module'), 'rm', 'tracked');
    writeFileSync(join(worker, 'module/keep'), 'WIP');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(initializeWorktreeSubmodules(worker)).rejects.toThrow();
    expect(git(join(worker, 'module'), 'ls-files')).toBe('');
    expect(readFileSync(join(worker, 'module/keep'), 'utf8')).toBe('WIP');
});
it('helper failure never falls through to raw init', async () => {
    const worker = temp(); git(worker, 'init', '-q'); mkdirSync(join(worker, 'scripts'));
    writeFileSync(join(worker, 'scripts/bootstrap-submodules.mjs'), 'process.exit(23);');
    writeFileSync(join(worker, 'scripts/setup-hooks.mjs'), 'throw new Error("must not run");');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Raw submodule update would succeed in this empty repository.
    await expect(initializeWorktreeSubmodules(worker)).rejects.toThrow();
});
it('repositories without a helper retain generic git initialization', async () => {
    const worker = temp(); git(worker, 'init', '-q');
    await expect(initializeWorktreeSubmodules(worker)).resolves.toBeUndefined();
});
