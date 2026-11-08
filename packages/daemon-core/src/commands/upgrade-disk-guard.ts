/**
 * Free-disk precheck for daemon_upgrade. Live 2026-11-08: an upgrade ran out of disk mid npm install
 * and left the mesh host half-dead (server WS up, P2P gone, version unknown) until the owner freed
 * space and reinstalled by hand. Refusing BEFORE the detached helper starts is the only safe point:
 * after the spawn this process exits and nothing can intervene.
 */
import { statfsSync } from 'node:fs';
import { homedir } from 'node:os';

/** An npm install of adhdev plus its staged copy and cache needs well under this; below it, refuse. */
export const UPGRADE_MIN_FREE_BYTES = 1024 * 1024 * 1024;

export function readFreeDiskBytes(dir: string = homedir()): number | undefined {
    try {
        const s = statfsSync(dir);
        const free = Number(s.bavail) * Number(s.bsize);
        return Number.isFinite(free) && free >= 0 ? free : undefined;
    } catch { return undefined; }
}

/** Undefined = proceed (enough space, or unmeasurable: fail open). Otherwise the refusal detail. */
export function upgradeDiskShortfall(freeBytes: number | undefined, minBytes: number = UPGRADE_MIN_FREE_BYTES): { freeBytes: number; requiredBytes: number } | undefined {
    if (freeBytes === undefined || freeBytes >= minBytes) return undefined;
    return { freeBytes, requiredBytes: minBytes };
}

export function formatGiB(bytes: number): string {
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
