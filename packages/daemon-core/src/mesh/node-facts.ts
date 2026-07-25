/**
 * buildLocalNodeFacts — THE single producer of this daemon's MeshNodeFacts
 * bundle (design: root repo docs/design/2026-07-25-deploy-lag-visibility.md).
 *
 * De-mirroring core: the reporter envelope (git-commands handleGitCommand)
 * and the self/worktree node stamp (mesh-node-identity, whose local probe
 * bypasses the envelope) BOTH call this one function, so a fact added here
 * reaches self and remote nodes identically — the field-by-field dual-path
 * plumbing that produced the mirror-defect class (version chip self-miss,
 * slot-cap chip remote-miss, dead stale-build badge) cannot recur for bundle
 * fields.
 */

import type { MeshNodeFacts } from '@adhdev/mesh-shared';
import { getDaemonBuildInfo } from '../build-info.js';

export function buildLocalNodeFacts(deps?: {
    providerVersions?: Record<string, string> | null;
    machineNickname?: string | null;
}): MeshNodeFacts {
    const build = (() => {
        try {
            const info = getDaemonBuildInfo();
            const commit = typeof info.commit === 'string' && info.commit && info.commit !== 'unknown' ? info.commit : undefined;
            const commitShort = typeof info.commitShort === 'string' && info.commitShort && info.commitShort !== 'unknown' ? info.commitShort : undefined;
            const version = typeof info.version === 'string' && info.version && info.version !== 'unknown' ? info.version : undefined;
            const builtAt = typeof info.builtAt === 'string' && info.builtAt ? info.builtAt : undefined;
            if (!commit && !version) return undefined;
            return {
                ...(commit ? { commit } : {}),
                ...(commitShort ? { commitShort } : {}),
                ...(version ? { version } : {}),
                ...(builtAt ? { builtAt } : {}),
            };
        } catch {
            return undefined;
        }
    })();
    const providerVersions = deps?.providerVersions && Object.keys(deps.providerVersions).length > 0
        ? deps.providerVersions
        : undefined;
    const machineNickname = typeof deps?.machineNickname === 'string' && deps.machineNickname.trim()
        ? deps.machineNickname.trim()
        : undefined;
    return {
        schemaVersion: 1,
        reportedAt: Date.now(),
        ...(build ? { daemonBuild: build } : {}),
        ...(providerVersions ? { providerVersions } : {}),
        platform: process.platform,
        arch: process.arch,
        ...(machineNickname ? { machineNickname } : {}),
    };
}
