import type { DaemonData } from '../types';

function parseSemver(version: string): [number, number, number] | null {
    const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
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

export function isVersionMismatch(daemon: DaemonData, appVersion: string | null): boolean {
    const daemonVersion = daemon.version || null;
    if (daemon.versionMismatch === true) return true;
    if (!daemonVersion || !appVersion) return false;
    return daemonVersion !== appVersion;
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
