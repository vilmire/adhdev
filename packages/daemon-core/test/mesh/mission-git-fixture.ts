/** Real-git fixtures for mission git-ref tests: a bare `origin` and a working clone on `main`. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0',
};

export function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'advice.detachedHead=false', ...args], { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export interface MissionGitFixture {
    root: string;
    origin: string;
    work: string;
    commit(file: string, content: string, message: string): string;
    head(): string;
    cleanup(): void;
}

export function makeFixture(): MissionGitFixture {
    const root = mkdtempSync(join(tmpdir(), 'mission-git-'));
    const origin = join(root, 'origin.git');
    const work = join(root, 'work');
    mkdirSync(origin);
    git(origin, 'init', '--bare', '-b', 'main');
    git(root, 'clone', '-q', origin, work);
    git(work, 'checkout', '-q', '-B', 'main');
    const fx: MissionGitFixture = {
        root, origin, work,
        commit(file, content, message) {
            writeFileSync(join(work, file), content);
            git(work, 'add', file);
            git(work, 'commit', '-q', '-m', message);
            return git(work, 'rev-parse', 'HEAD');
        },
        head: () => git(work, 'rev-parse', 'HEAD'),
        cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
    fx.commit('base.txt', 'base\n', 'base');
    git(work, 'push', '-q', 'origin', 'main');
    return fx;
}
