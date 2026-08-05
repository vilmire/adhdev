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
import { readQuotaCache } from '../quota/refresh.js';
import { getProviderSpecPins } from '../detection/cli-detector.js';

/**
 * ★PERFORMANCE CONTRACT: this function must stay CHEAP and SYNCHRONOUS.
 *
 * It runs inside every `git_status`, and `mesh_status` probes git_status on
 * every node on every call. Quota therefore comes from a cache the refresh loop
 * fills on its own timer (`../quota/refresh.js`) — reading it is a map lookup.
 * NEVER call a quota fetcher (or any other spawn/network/fs work) from here:
 * the codex fetcher alone spawns a `codex app-server` child (~900ms), which
 * would be charged to every node of every mesh_status. Regression test:
 * test/mesh/node-facts-quota.test.ts asserts zero fetcher calls.
 */
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
    // Cache READ only — see the performance contract above. Undefined until the
    // refresh loop's first tick, which is the honest report: absent `quota`
    // means "this node has not told us", distinct from a present entry whose
    // status is 'unavailable' ("it looked and could not read one").
    const quota = (() => {
        try {
            return readQuotaCache();
        } catch {
            return undefined; // facts stamp is best-effort observability
        }
    })();
    // The verified-channel PIN per provider: which provider MANIFEST this node
    // actually loads. Deliberately a SEPARATE field from providerVersions,
    // which is the CLI BINARY version — a node can run kimi-code 1.2.3 while
    // pinned to kimi spec 1.0.0, so folding them together would repeat the
    // multi-identifier confusion behind the canon-identity defect class.
    //
    // This is the field that makes a remote node's pin knowable at all. A
    // published provider fix does not propagate on its own (the pin advances
    // only on an explicit activation, by design), so without this a node that
    // never adopted a fix is indistinguishable from one that did.
    //
    // Local read, no network — same best-effort contract as quota below.
    const providerSpecPins = (() => {
        try {
            const pins = getProviderSpecPins();
            return Object.keys(pins).length > 0 ? pins : undefined;
        } catch {
            return undefined; // facts stamp is best-effort observability
        }
    })();
    return {
        schemaVersion: 1,
        reportedAt: Date.now(),
        ...(build ? { daemonBuild: build } : {}),
        ...(providerVersions ? { providerVersions } : {}),
        ...(providerSpecPins ? { providerSpecPins } : {}),
        platform: process.platform,
        arch: process.arch,
        ...(machineNickname ? { machineNickname } : {}),
        ...(quota ? { quota } : {}),
    };
}
