/** Read the installed bytes again at approval time, without instantiating a
 * runtime. Prefix paths exactly as the canonical provider-tree digest does. */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ProviderLoader } from '../providers/provider-loader.js';
import { validateDriverProviderManifest } from '../providers/sdk/v1/validators/manifest.js';
import type { InstalledDriverManifest } from './activation-store.js';

export function computeDriverTreeDigest(dir: string): string {
    if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error('Invalid driver directory');
    const files: string[] = [];
    const walk = (sub: string) => {
        for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
            const rel = sub ? `${sub}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(rel);
            else if (entry.isFile()) files.push(rel);
            else throw new Error('Non-regular driver tree entry');
        }
    };
    walk('');
    if (!files.length) throw new Error('Empty driver tree');
    const hash = createHash('sha256');
    for (const rel of files.sort()) {
        const bytes = readFileSync(join(dir, rel));
        hash.update(`driver/${basename(dir)}/${rel}\0${bytes.length}\0`).update(bytes);
    }
    return `sha256:${hash.digest('hex')}`;
}

export function readInstalledDriver(loader: Pick<ProviderLoader, 'getMeta' | 'findProviderDir'>, type: string) {
    const meta = loader.getMeta(type);
    const dir = loader.findProviderDir(type);
    if (meta?.category !== 'driver' || !dir) return null;
    const digest = computeDriverTreeDigest(dir);
    let raw: string;
    try { raw = readFileSync(join(dir, 'provider.v1.json'), 'utf8'); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        raw = readFileSync(join(dir, 'provider.json'), 'utf8');
    }
    const module = JSON.parse(raw) as InstalledDriverManifest;
    if (!validateDriverProviderManifest(module).ok || module.type !== type || digest !== computeDriverTreeDigest(dir)) return null;
    return { module: { ...module, _sourceTrust: (meta as InstalledDriverManifest)._sourceTrust }, treeDigest: digest };
}
