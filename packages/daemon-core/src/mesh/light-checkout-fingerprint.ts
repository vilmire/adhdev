/**
 * LIGHT-TASK shared-checkout mutation detector (design §8, layer 3).
 *
 * The light base node's checkout is fingerprinted just before the worker starts and again when its
 * result is captured. A difference only BLOCKS the result when it can be attributed to this task:
 * it overlaps the task's touched/owned paths, or `node_modules` (the shared install) changed.
 * Anything else (the coordinator fast-forwarding, the owner editing, another landing) is a warning.
 * The daemon never repairs the shared checkout automatically.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { touchedFilesOutsideOwnership, type OwnedPathsDeclaration } from '@adhdev/mesh-shared';
import { expandRepoPattern } from './light-workspace-config.js';
import { lightGit } from './light-git.js';

export interface LightCheckoutFingerprint {
    head: string;
    /** local branch refs other than mesh/light/* -> sha */
    branches: Record<string, string>;
    /** submodule path -> HEAD */
    submoduleHeads: Record<string, string>;
    /** repo-relative path -> porcelain status code (tracked + staged + untracked, root and submodules) */
    status: Record<string, string>;
    stashCount: number;
    /** linkNodeModules dir -> `entry:mtimeMs` list (top level only) */
    nodeModules: Record<string, string[]>;
    takenAt: string;
}

async function statusMap(cwd: string, prefix: string): Promise<Record<string, string>> {
    const r = await lightGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
    const out: Record<string, string> = {};
    if (r.code !== 0) return out;
    const parts = r.stdout.split('\0').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
        const code = parts[i].slice(0, 2);
        out[`${prefix}${parts[i].slice(3)}`] = code;
        if (code[0] === 'R' || code[0] === 'C') i++; // rename source follows as its own field
    }
    return out;
}

export async function takeLightCheckoutFingerprint(checkoutRoot: string, linkNodeModules: readonly string[], submodules: readonly string[] = []): Promise<LightCheckoutFingerprint> {
    const head = (await lightGit(checkoutRoot, ['rev-parse', 'HEAD'])).stdout.trim();
    const refs = await lightGit(checkoutRoot, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads']);
    const branches: Record<string, string> = {};
    for (const line of refs.stdout.split('\n')) {
        const [name, sha] = line.trim().split(' ');
        if (name && sha && !name.startsWith('mesh/light/')) branches[name] = sha;
    }
    const submoduleHeads: Record<string, string> = {};
    let status = await statusMap(checkoutRoot, '');
    for (const sub of submodules) {
        if (!fs.existsSync(path.join(checkoutRoot, sub, '.git'))) continue;
        submoduleHeads[sub] = (await lightGit(path.join(checkoutRoot, sub), ['rev-parse', 'HEAD'])).stdout.trim();
        status = { ...status, ...(await statusMap(path.join(checkoutRoot, sub), `${sub}/`)) };
    }
    const stash = await lightGit(checkoutRoot, ['stash', 'list']);
    const nodeModules: Record<string, string[]> = {};
    for (const pattern of linkNodeModules) {
        for (const rel of expandRepoPattern(checkoutRoot, pattern)) {
            try {
                nodeModules[rel] = fs.readdirSync(path.join(checkoutRoot, rel)).sort().map(name => {
                    let m = 0; try { m = Math.trunc(fs.lstatSync(path.join(checkoutRoot, rel, name)).mtimeMs); } catch { /* vanished */ }
                    return `${name}:${m}`;
                });
            } catch { /* dir absent */ }
        }
    }
    return { head, branches, submoduleHeads, status, stashCount: stash.stdout.split('\n').filter(Boolean).length, nodeModules, takenAt: new Date().toISOString() };
}

export interface LightFingerprintDiff {
    /** paths whose status changed (symmetric) */
    changedPaths: string[];
    /** changed paths that overlap the task's touched or owned paths -> attributable */
    overlappingPaths: string[];
    nodeModulesChanged: string[];
    /** unattributable movement worth a warning */
    headMoved: boolean;
    refsChanged: string[];
    stashChanged: boolean;
}

export function diffLightFingerprints(before: LightCheckoutFingerprint, after: LightCheckoutFingerprint, scope: { touchedPaths: readonly string[]; owned?: OwnedPathsDeclaration }): LightFingerprintDiff {
    const changed = new Set<string>();
    for (const p of new Set([...Object.keys(before.status), ...Object.keys(after.status)])) if (before.status[p] !== after.status[p]) changed.add(p);
    const touched = new Set(scope.touchedPaths);
    const overlapping = [...changed].filter(p => touched.has(p) || (scope.owned ? touchedFilesOutsideOwnership([p], scope.owned).undeclaredTouched.length === 0 : false));
    const nodeModulesChanged = Object.keys({ ...before.nodeModules, ...after.nodeModules }).filter(k => JSON.stringify(before.nodeModules[k] ?? []) !== JSON.stringify(after.nodeModules[k] ?? []));
    const refsChanged = [...new Set([...Object.keys(before.branches), ...Object.keys(after.branches)])].filter(b => before.branches[b] !== after.branches[b]);
    const headMoved = before.head !== after.head || JSON.stringify(before.submoduleHeads) !== JSON.stringify(after.submoduleHeads);
    return { changedPaths: [...changed].sort(), overlappingPaths: overlapping.sort(), nodeModulesChanged, headMoved, refsChanged, stashChanged: before.stashCount !== after.stashCount };
}

export const LIGHT_FINGERPRINT_SUFFIX = '.adhdev-light-fp.json';

/** The "before" fingerprint lives beside the workspace (outside it, so it never shows up in `git status`). */
export function saveLightFingerprint(workspacePath: string, fp: LightCheckoutFingerprint): void {
    fs.writeFileSync(`${workspacePath}${LIGHT_FINGERPRINT_SUFFIX}`, JSON.stringify(fp));
}
export function loadLightFingerprint(workspacePath: string): LightCheckoutFingerprint | null {
    try { return JSON.parse(fs.readFileSync(`${workspacePath}${LIGHT_FINGERPRINT_SUFFIX}`, 'utf8')); } catch { return null; }
}
