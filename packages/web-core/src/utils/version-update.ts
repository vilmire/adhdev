import type { DaemonData } from '../types';

interface ParsedVersion {
    base: [number, number, number];
    /** rc/beta numeric suffix when present (e.g. `-rc.373` → 373); null for a release build. */
    prereleaseNumber: number | null;
    isPrerelease: boolean;
}

function parseVersion(version: string): ParsedVersion | null {
    const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
    if (!match) return null;
    const prerelease = match[4] ?? null;
    let prereleaseNumber: number | null = null;
    if (prerelease) {
        const num = prerelease.match(/(?:^|\.)(\d+)$/);
        prereleaseNumber = num ? Number(num[1]) : null;
    }
    return {
        base: [Number(match[1]), Number(match[2]), Number(match[3])],
        prereleaseNumber,
        isPrerelease: prerelease !== null,
    };
}

function parseSemver(version: string): [number, number, number] | null {
    return parseVersion(version)?.base ?? null;
}

function compareSemver(a: string, b: string): number {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    if (!pa || !pb) return a.localeCompare(b);
    for (let i = 0; i < 3; i += 1) {
        if (pa[i] < pb[i]) return -1;
        if (pa[i] > pb[i]) return 1;
    }
    return 0;
}

/**
 * Is the daemon behind the target version, in this product's versioning scheme?
 *
 * Preview builds are versioned `X.Y.Z-rc.N` and are successors of the previous
 * stable — a daemon on `0.9.82-rc.373` is NOT behind a `0.9.82` target (standard
 * semver would say it is). So: base version decides first; with equal bases a
 * prerelease↔release pair is treated as up-to-date, and two prereleases compare
 * by their rc number (rc.100 is behind rc.373).
 */
function isDaemonBehindTarget(daemonVersion: string, targetVersion: string): boolean {
    const daemon = parseVersion(daemonVersion);
    const target = parseVersion(targetVersion);
    // Unparseable version strings: fall back to the old inequality behavior.
    if (!daemon || !target) return daemonVersion !== targetVersion;
    for (let i = 0; i < 3; i += 1) {
        if (daemon.base[i] < target.base[i]) return true;
        if (daemon.base[i] > target.base[i]) return false;
    }
    if (daemon.isPrerelease && target.isPrerelease) {
        if (daemon.prereleaseNumber === null || target.prereleaseNumber === null) return false;
        return daemon.prereleaseNumber < target.prereleaseNumber;
    }
    return false;
}

export function isVersionMismatch(daemon: DaemonData, appVersion: string | null): boolean {
    const daemonVersion = daemon.version || null;
    if (daemon.versionMismatch === true) return true;
    if (!daemonVersion || !appVersion) return false;
    return isDaemonBehindTarget(daemonVersion, appVersion);
}

export function isVersionUpdateRequired(daemon: DaemonData, appVersion: string | null): boolean {
    if (daemon.versionUpdateRequired === true) return true;
    const daemonVersion = daemon.version || null;
    if (!daemonVersion || !appVersion || daemonVersion === appVersion) return false;
    if (compareSemver(daemonVersion, appVersion) >= 0) return false;
    const daemonParts = parseSemver(daemonVersion);
    const appParts = parseSemver(appVersion);
    if (!daemonParts || !appParts) return false;
    return daemonParts[0] !== appParts[0] || daemonParts[1] !== appParts[1];
}
