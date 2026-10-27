// Managed copies inside a private HOME.
//
// A private HOME imports some real-home files by COPY (antigravity
// `settings.json`, ...). Re-copying on every launch erased whatever the agent
// itself wrote into its copy (a "Persist" / always-allow grant), and a source
// deleted from the real home left its copy behind forever. This module tracks
// what we copied (a manifest of source hash + hash of the bytes we wrote) so a
// relaunch can tell "unchanged since we copied it" from "the agent edited it".
//
// Rules (narrowest first):
//  - copy missing                          -> write it, record it
//  - copy unmodified since our last write  -> refresh from source
//  - copy modified by the agent            -> KEEP it (never merge: the format is
//    not known to be safe to merge); log when the source also changed
//  - source deleted, copy unmodified       -> remove the copy
//  - source deleted, copy modified         -> keep it
//  - copy with no manifest record (legacy) -> adopt: overwrite once (the old
//    behaviour), then track
// Only ever touches paths under the private HOME; never writes the real HOME.

import { createHash } from 'crypto';
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import * as path from 'path';
import { LOG } from '../logging/logger.js';

export const MANAGED_COPY_MANIFEST = '.adhdev-managed-copies.json';

interface ManagedCopyRecord {
    /** sha256 of the source bytes at our last copy. */
    source: string;
    /** sha256 of the bytes we wrote into the private copy. */
    copy: string;
}
type Manifest = Record<string, ManagedCopyRecord>;

const sha = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');

function readManifest(home: string): Manifest {
    try {
        const parsed = JSON.parse(readFileSync(path.join(home, MANAGED_COPY_MANIFEST), 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

/** Hash of the file at `target` if it is a regular file we can read, else null. */
function regularFileHash(target: string): string | null {
    try {
        if (!lstatSync(target).isFile()) return null;
        return sha(readFileSync(target));
    } catch {
        return null;
    }
}

export class ManagedHomeCopies {
    private readonly manifest: Manifest;
    private dirty = false;

    constructor(private readonly home: string, private readonly label: string) {
        this.manifest = readManifest(home);
    }

    /**
     * Reconcile one copied import. `desired` is what a refreshed copy holds
     * (already key-stripped when applicable); `sourceBytes` the raw source.
     * Returns 'written' or 'kept' (agent-modified copy preserved).
     */
    sync(rel: string, target: string, sourceBytes: Buffer, desired: Buffer | string): 'written' | 'kept' {
        const rec = this.manifest[rel];
        const srcHash = sha(sourceBytes);
        const current = regularFileHash(target);
        if (rec && current !== null && current !== rec.copy) {
            if (srcHash !== rec.source) {
                LOG.warn('WorkerMcp', `[${this.label}] ${rel}: source changed but the private copy was modified in-session — keeping the private copy`);
            }
            return 'kept';
        }
        writeFileSync(target, desired, { mode: 0o600 });
        this.manifest[rel] = { source: srcHash, copy: sha(desired) };
        this.dirty = true;
        return 'written';
    }

    /** Source is gone: drop the copy only if still exactly what we wrote. */
    sourceGone(rel: string, target: string): void {
        const rec = this.manifest[rel];
        if (!rec) return;
        const current = regularFileHash(target);
        if (current === null) {
            delete this.manifest[rel];
            this.dirty = true;
        } else if (current === rec.copy) {
            rmSync(target, { force: true });
            delete this.manifest[rel];
            this.dirty = true;
            LOG.info('WorkerMcp', `[${this.label}] ${rel}: source removed — deleted unmodified private copy`);
        } else {
            LOG.warn('WorkerMcp', `[${this.label}] ${rel}: source removed but the private copy was modified in-session — keeping it`);
        }
    }

    flush(): void {
        if (!this.dirty || !existsSync(this.home)) return;
        const file = path.join(this.home, MANAGED_COPY_MANIFEST);
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.manifest, null, 2), { mode: 0o600 });
        renameSync(tmp, file);
        this.dirty = false;
    }
}
