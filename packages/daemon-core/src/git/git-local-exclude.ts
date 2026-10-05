/**
 * Keep daemon-generated config files out of the user's commits.
 *
 * The daemon writes MCP configs into the workspace for CLIs that only read them
 * from there (opencode.json, .cursor/mcp.json, .kimi-code/mcp.json,
 * .grok/config.toml, an untracked .mcp.json). A worker's entry carries its
 * session bind token, and any `git add -A` — a Refinery checkpoint commit, an
 * agent committing "everything" — would put that token into the repo history
 * (an untracked .mcp.json was swept into a checkpoint commit on 2026-10-01, and a
 * base-node opencode worker left its token in repo-root opencode.json on
 * 2026-10-06). The path is listed in the repository's LOCAL exclude file
 * (`$GIT_DIR/info/exclude`): never shared, no tracked file changes, and a no-op
 * for a path git already tracks.
 */
import { execFileSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import * as path from 'path';

/** Best-effort; returns true when the path is (now) listed. */
export function ensureLocalGitExclude(workspace: string, filePath: string): boolean {
    try {
        const absWorkspace = path.resolve(workspace);
        const rel = path.relative(absWorkspace, path.resolve(filePath));
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
        const excludeFile = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], {
            cwd: absWorkspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true,
        }).trim();
        if (!excludeFile) return false;
        const pattern = '/' + rel.split(path.sep).join('/');
        const existing = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
        if (existing.split(/\r?\n/).some(line => line.trim() === pattern)) return true;
        mkdirSync(path.dirname(excludeFile), { recursive: true });
        const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
        appendFileSync(excludeFile, `${prefix}# adhdev: generated MCP config\n${pattern}\n`, 'utf8');
        return true;
    } catch {
        return false;
    }
}
