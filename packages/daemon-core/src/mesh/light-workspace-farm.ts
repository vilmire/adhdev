/**
 * LIGHT-TASK: node_modules link farm (design §5.3) and dist clone (§5.4).
 *
 * Rules are derived from filesystem facts only (no package-manager metadata, no scope
 * names hard-coded). For every top-level entry `e` of a source node_modules dir:
 *   1. dot-entries (except `.bin`) are skipped, so tool caches never write through a link;
 *   2. a symlink resolving INSIDE the checkout but outside any node_modules (an npm
 *      workspace link such as `@adhdev/x -> ../../packages/x`) is recreated to point at the
 *      same relative location inside the light workspace;
 *   3. a `@scope` directory becomes a real directory whose children follow 1/2/4;
 *   4. everything else is linked by absolute path (symlink; junction on win32);
 *   5. `.bin` becomes a real directory of relative symlinks (posix) / copied shims (win32).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expandRepoPattern, type LightWorkspaceConfig } from './light-workspace-config.js';

export interface FarmResult {
    /** Absolute paths (inside the light workspace) of every link created. */
    links: string[];
    /** Absolute paths of real directories created for the farm. */
    dirs: string[];
}

const IS_WIN = process.platform === 'win32';

function inside(root: string, p: string): boolean {
    const rel = path.relative(root, p);
    return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function hasNodeModulesSegment(rel: string): boolean {
    return rel.split(path.sep).includes('node_modules');
}

function link(target: string, at: string, isDir: boolean, out: FarmResult): void {
    if (IS_WIN) {
        if (isDir) fs.symlinkSync(target, at, 'junction');
        else fs.copyFileSync(target, at); // file symlinks need privileges on win32
    } else {
        fs.symlinkSync(target, at, isDir ? 'dir' : 'file');
    }
    out.links.push(at);
}

function farmEntry(srcRoot: string, checkout: string, lw: string, srcEntry: string, dstEntry: string, allowScope: boolean, out: FarmResult): void {
    const name = path.basename(srcEntry);
    if (name.startsWith('.') && name !== '.bin') return;
    let lst: fs.Stats;
    try { lst = fs.lstatSync(srcEntry); } catch { return; }
    if (name === '.bin') { farmBin(srcEntry, dstEntry, out); return; }
    if (lst.isSymbolicLink()) {
        let real: string;
        try { real = fs.realpathSync(srcEntry); } catch { return; } // dangling
        const isDir = fs.statSync(real).isDirectory();
        const relInCheckout = path.relative(checkout, real);
        if (inside(checkout, real) && !hasNodeModulesSegment(relInCheckout)) {
            link(path.join(lw, relInCheckout), dstEntry, isDir, out); // workspace link -> light workspace itself
        } else {
            link(real, dstEntry, isDir, out);
        }
        return;
    }
    if (allowScope && lst.isDirectory() && name.startsWith('@')) {
        fs.mkdirSync(dstEntry, { recursive: true });
        out.dirs.push(dstEntry);
        for (const child of fs.readdirSync(srcEntry)) farmEntry(srcRoot, checkout, lw, path.join(srcEntry, child), path.join(dstEntry, child), false, out);
        return;
    }
    link(srcEntry, dstEntry, lst.isDirectory(), out);
}

function farmBin(srcBin: string, dstBin: string, out: FarmResult): void {
    fs.mkdirSync(dstBin, { recursive: true });
    out.dirs.push(dstBin);
    for (const name of fs.readdirSync(srcBin)) {
        const s = path.join(srcBin, name);
        const d = path.join(dstBin, name);
        let lst: fs.Stats;
        try { lst = fs.lstatSync(s); } catch { continue; }
        if (!IS_WIN && lst.isSymbolicLink()) {
            fs.symlinkSync(fs.readlinkSync(s), d); // relative text: resolves through the light node_modules
            out.links.push(d);
        } else if (lst.isFile() || lst.isSymbolicLink()) {
            try { fs.copyFileSync(s, d); } catch { /* shim vanished mid-copy: tolerable */ }
        }
    }
}

export function buildNodeModulesFarm(checkout: string, lw: string, cfg: Pick<LightWorkspaceConfig, 'linkNodeModules'>): FarmResult {
    const out: FarmResult = { links: [], dirs: [] };
    for (const pattern of cfg.linkNodeModules) {
        for (const rel of expandRepoPattern(checkout, pattern)) {
            const src = path.join(checkout, rel);
            let st: fs.Stats;
            try { st = fs.statSync(src); } catch { continue; }
            if (!st.isDirectory()) continue;
            const dst = path.join(lw, rel);
            fs.mkdirSync(dst, { recursive: true });
            out.dirs.push(dst);
            for (const entry of fs.readdirSync(src)) farmEntry(src, checkout, lw, path.join(src, entry), path.join(dst, entry), true, out);
        }
    }
    return out;
}

function copyTree(src: string, dst: string): number {
    let count = 0;
    fs.mkdirSync(dst, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, ent.name);
        const d = path.join(dst, ent.name);
        if (ent.isDirectory()) count += copyTree(s, d);
        else if (ent.isSymbolicLink()) {
            try { fs.symlinkSync(fs.readlinkSync(s), d); count++; } catch { /* ignore */ }
        } else if (ent.isFile()) {
            // COW clone where the filesystem supports it, silent real copy elsewhere.
            fs.copyFileSync(s, d, fs.constants.COPYFILE_FICLONE);
            count++;
        }
    }
    return count;
}

/** Clone `copyDirs` (minus `copyExclude`) and create `freshDirs`. Returns the relative dirs copied. */
export function cloneBuildOutputs(checkout: string, lw: string, cfg: Pick<LightWorkspaceConfig, 'copyDirs' | 'copyExclude' | 'freshDirs'>): string[] {
    const excluded = new Set(cfg.copyExclude.flatMap(p => expandRepoPattern(checkout, p)));
    const copied: string[] = [];
    for (const pattern of cfg.copyDirs) {
        for (const rel of expandRepoPattern(checkout, pattern)) {
            if (excluded.has(rel)) continue;
            const src = path.join(checkout, rel);
            try { if (!fs.statSync(src).isDirectory()) continue; } catch { continue; }
            copyTree(src, path.join(lw, rel));
            copied.push(rel);
        }
    }
    for (const rel of cfg.freshDirs) {
        for (const r of expandRepoPattern(checkout, rel)) fs.mkdirSync(path.join(lw, r), { recursive: true });
    }
    return copied;
}

/**
 * Remove every symlink/junction under `dir` WITHOUT following any of them (design §10:
 * a recursive delete that followed a link would erase the original node_modules).
 * Never descends into a link; returns the number of links removed.
 */
export function unlinkAllLinks(dir: string): number {
    let removed = 0;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
    for (const ent of entries) {
        const p = path.join(dir, ent.name);
        if (ent.isSymbolicLink()) {
            try { fs.unlinkSync(p); } catch { try { fs.rmdirSync(p); } catch { continue; } }
            removed++;
        } else if (ent.isDirectory()) {
            removed += unlinkAllLinks(p);
        }
    }
    return removed;
}
