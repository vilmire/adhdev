/**
 * Install a verified driver package under `<configDir>/external/`.
 *
 * Owner principle (convenience first, never silent): the files land inactive.
 * Activation is a separate, digest-bound, owner-only step (driver-staging.ts).
 * Hard rule: this module NEVER writes the user layer — user-layer providers are
 * classified `trusted` and low-risk drivers there auto-activate without the
 * owner, which would turn "install" into "activate".
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { computeDriverTreeDigest } from './installed-driver.js';
import { DriverPackageError, type VerifiedDriverPackage } from './driver-package.js';

export const INSTALL_SOURCE_NAME = 'adhdev-installed';
const LEGACY_CATEGORIES = new Set(['cli', 'ide', 'extension', 'driver']);

/** What `findProviderDir(type)` returned for a type that is already loaded (null dir = loaded from somewhere unlocatable). */
export interface ExistingProvider { dir: string | null }
export interface InstallResult { dest: string; replaced: boolean }

function within(root: string, target: string): boolean {
    const rel = relative(resolve(root), resolve(target));
    return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Decide where a package goes; throws type_conflict when a non-external layer already provides the type. */
export function resolveInstallDest(configDir: string, type: string, existing: ExistingProvider | null): { dest: string; replaced: boolean } {
    const externalRoot = join(configDir, 'external');
    if (existing) {
        // findProviderDir walks user > external > channel > upstream, so a hit outside external/ means a
        // higher-priority (or official) provider owns the type; installing beside it would be shadowed or shadow it.
        if (!existing.dir || !within(externalRoot, existing.dir)) {
            throw new DriverPackageError('type_conflict', `A user, built-in or channel provider already uses the type "${type}"`);
        }
        return { dest: existing.dir, replaced: true };
    }
    // The loader treats an external/ root that holds category dirs as ONE legacy source and ignores
    // named sources beside them; follow whichever layout is already on disk.
    let legacy = false;
    try { legacy = readdirSync(externalRoot, { withFileTypes: true }).some(e => e.isDirectory() && LEGACY_CATEGORIES.has(e.name)); } catch { /* none yet */ }
    const dest = legacy ? join(externalRoot, 'driver', type) : join(externalRoot, INSTALL_SOURCE_NAME, 'driver', type);
    return { dest, replaced: false };
}

/** Write atomically (sibling-of-nothing staging dir that no loader scans), verify the digest, then swap in. */
export function installDriverPackage(configDir: string, pkg: VerifiedDriverPackage, existing: ExistingProvider | null): InstallResult {
    const { type, treeDigest } = pkg.report;
    const { dest, replaced } = resolveInstallDest(configDir, type, existing);
    const work = join(configDir, 'drivers', '.installing', randomBytes(6).toString('hex'));
    const staged = join(work, type);
    try {
        for (const file of pkg.files) {
            const target = join(staged, file.path);
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, file.bytes, { mode: 0o644 });
        }
        if (computeDriverTreeDigest(staged) !== treeDigest) throw new DriverPackageError('bundle_digest_mismatch', 'Written tree does not match the verified digest');
        mkdirSync(dirname(dest), { recursive: true });
        const old = join(work, 'previous');
        if (existsSync(dest)) renameSync(dest, old);
        try { renameSync(staged, dest); }
        catch (error) { if (existsSync(old)) renameSync(old, dest); throw error; }
        return { dest, replaced };
    } finally {
        try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
    }
}
