/**
 * Per-slot provider usability for queue auto-launch: "can this node run provider X
 * right now?" — answered by the machine that will actually spawn the CLI.
 *
 * ★REMOTE NODES ARE NOT JUDGED BY THIS DAEMON'S CONFIG. The check used to call the
 * HOST's `providerLoader.isMachineProviderEnabled()` and a HOST-local `detectCLI()`
 * for every node, remote ones included. Provider enablement and CLI installation
 * are machine-local facts, so a remote member was refused for the host's state:
 * live standalone multi-machine run (2026-10-08) — claude-cli enabled ONLY on the
 * member, task stuck at `skipped: provider_priority_unusable: claude-cli: disabled`
 * until the operator also enabled it on the host (which then "fixed" it for the
 * wrong reason). Cloud meshes share this function, so the same host-vs-member
 * confusion produced unexplained `provider_priority_unusable` skips there too.
 * It also wrote the remote verdict into the host's own CLI detection cache.
 *
 * For a remote node the only facts this daemon has are what the member reports on
 * its own facts bundle (`nodeFacts.providerEnablement`, booleans decided on the
 * member — see mesh-shared node-facts.ts). The rule mirrors mesh-route-preview's
 * `providerReportedDisabled` and classifyAbsentQuotaReason:
 *   - the member REPORTED `enabled: false` → refuse (its own verdict);
 *   - anything else (enabled, absent field, older daemon, provider outside the
 *     reported set) → usable here. Absence is "the node did not tell us", never
 *     "disabled". The forwarded launch_cli then runs on the member, which applies
 *     its own enablement + detection, and a refusal surfaces through the existing
 *     `remote_launch_cli_failed` / dispatch-failure skip path.
 * Worktree clones share the source node's daemon, so a clone with no bundle of its
 * own reads its source node's report (same fallback the quota lookup uses).
 */
import type { DaemonComponents } from '../boot/daemon-components.js';
import { detectCLI } from '../detection/cli-detector.js';
import { isLocalAutoLaunchNode } from './mesh-candidacy-predicates.js';
import { cloneSourceNodeFor } from './mesh-quota-sources.js';

function reportedProviderEnabled(node: any, providerType: string): boolean | undefined {
    const enabled = node?.nodeFacts?.providerEnablement?.[providerType]?.enabled;
    return typeof enabled === 'boolean' ? enabled : undefined;
}

/** The member's own reported enablement verdict, or undefined when it reported none. */
export function remoteReportedProviderEnabled(node: any, providerType: string, nodes?: any[]): boolean | undefined {
    const own = reportedProviderEnabled(node, providerType);
    if (own !== undefined) return own;
    const source = cloneSourceNodeFor(node, { nodes });
    return source !== undefined ? reportedProviderEnabled(source, providerType) : undefined;
}

/**
 * Returns null when the slot's provider is usable on `node`, else the failure detail
 * that resolveUsableProvider joins into `provider_priority_unusable: <type>: <detail>`.
 */
export async function slotProviderUnusableReason(
    components: DaemonComponents,
    node: any,
    providerType: string,
    nodes?: any[],
): Promise<string | null> {
    if (!isLocalAutoLaunchNode(node)) {
        return remoteReportedProviderEnabled(node, providerType, nodes) === false ? 'disabled on node' : null;
    }
    const providerLoader = components.providerLoader!;
    if (typeof providerLoader.isMachineProviderEnabled === 'function' && !providerLoader.isMachineProviderEnabled(providerType)) {
        return 'disabled';
    }
    let detected: any;
    try {
        detected = await detectCLI(providerType, providerLoader, { includeVersion: false });
    } catch (e: any) {
        return `detect failed: ${e?.message || e}`;
    }
    if (typeof providerLoader.setCliDetectionResults === 'function') {
        providerLoader.setCliDetectionResults([{ id: providerType, installed: !!detected, path: detected?.path }], false);
    }
    (components as any).onStatusChange?.();
    return detected ? null : 'not detected';
}
