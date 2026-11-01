/**
 * Input hygiene for mission git refs. Ref entries can arrive from another mesh
 * member (`mesh_ref_containment_probe`), so every value that reaches `git` or
 * the filesystem is checked here first:
 *  - `repo` is a relative path inside one of this node's own repos (no absolute
 *    path, no `..` segment, no backslash) and must still resolve inside that
 *    repo after symlinks are followed;
 *  - commit values are hex object ids; branch values are plain ref names that
 *    cannot be read as a git option.
 */
import { realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

const HEX_SHA = /^[0-9a-f]{7,64}$/i;
// git check-ref-format subset: no leading '-' or '/', no '..', no control/space or ~^:?*[\ characters,
// no '@{', no trailing '/', '.' or '.lock'.
const SAFE_REF = /^(?!-)(?!\/)(?!.*\.\.)(?!.*@\{)(?!.*\/\/)[A-Za-z0-9._\-/]+(?<![/.])(?<!\.lock)$/;

export function isSafeRefValue(kind: 'commit' | 'branch', value: string): boolean {
    if (!value || value.length > 300) return false;
    return kind === 'commit' ? HEX_SHA.test(value) : SAFE_REF.test(value);
}

export function isSafeBranchName(name: string): boolean {
    return !!name && name.length <= 200 && SAFE_REF.test(name);
}

/** Lexical check of a repo-relative path supplied with a ref. */
export function isSafeRelativeRepo(repo: string): boolean {
    if (!repo || repo.length > 300) return false;
    if (repo.startsWith('/') || repo.includes('\\') || /^[A-Za-z]:/.test(repo)) return false;
    return !repo.split('/').some(seg => seg === '..' || seg === '.');
}

/** `join(root, repo)` only when it still lies inside `root` after symlinks are resolved. */
export function containedRepoPath(root: string, repo: string): string | undefined {
    if (!isSafeRelativeRepo(repo)) return undefined;
    try {
        const realRoot = realpathSync(root);
        const real = realpathSync(join(root, repo));
        return real === realRoot || real.startsWith(realRoot + sep) ? real : undefined;
    } catch {
        return undefined;
    }
}
