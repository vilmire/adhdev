/**
 * Routing — resolve a CLI provider definition to its SpecCliAdapter
 * (single spec.json + SpecDriver).
 *
 * The legacy ProviderCliAdapter path (scripts/v1/*.js parsers +
 * cli-state-engine) was DELETED 2026-08-17 after the last three builtin
 * CLIs (kimi / cursor-cli / opencode) were migrated to specs and
 * live-verified on the standalone daemon. A CLI provider without a
 * resolvable spec now fails the launch with a descriptive error instead
 * of silently running a weaker engine — this also ends out-of-tree
 * support for the v1 tui-manifest CLI layout (an out-of-tree CLI provider
 * must ship a spec.json).
 */
'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CliProviderModule } from '../../cli-adapters/provider-cli-shared.js';
import type { PtyTransportFactory } from '../../cli-adapters/pty-transport.js';
import type { CliAdapter } from '../../cli-adapter-types.js';
import { SpecCliAdapter } from './cli-adapter.js';
import { LOG } from '../../logging/logger.js';
import { IDENTITY } from '../../track-identity.js';

/**
 * Recovery copy when a CLI provider has no resolvable spec.
 *
 * The command string is the real CLI (`provider sync-channel`, no extra
 * args) — NOT the non-existent `providers sync`. Dashboard recovery is the
 * stale-count badge on the machine Providers tab, which sends the existing
 * `activate_provider_updates` daemon command (same `syncVerifiedChannel()`).
 */
export function formatNoResolvableSpecError(providerType: string, dir?: string): string {
    const cli = `${IDENTITY.binaryName} provider sync-channel`;
    return (
        `CLI provider '${providerType}' has no resolvable spec (checked compatibility[].spec, `
        + `specs/default.json, spec.json under ${dir || 'the resolved provider dir'}). `
        + `The legacy scripts/tui-manifest CLI engine was removed; update the provider bundle `
        + `with \`${cli}\` (no extra arguments), or click the stale provider badge on the `
        + `machine Providers tab in the dashboard, or add a spec.json to the provider.`
    );
}

export function createCliAdapter(
    provider: CliProviderModule,
    workingDir: string,
    cliArgs: string[],
    extraEnv: Record<string, string>,
    transportFactory?: PtyTransportFactory,
    /** FSMLOG-SESSION-ATTRIBUTION (D3): owning session id, threaded to SpecCliAdapter so the
     *  FSM driver's log lines carry a session segment.
     *  TOMBSTONE-LEDGER-BRIDGE: also threaded to ProviderCliAdapter, which needs the
     *  owning session id to attribute a mesh `session_stopped` ledger entry on exit. */
    sessionId?: string,
): CliAdapter {
    // Prefer the path provider-loader already resolved (it walks the
    // compatibility[i].spec → specs/default.json → spec.json chain).
    // Fall back to the legacy spec.json-in-provider-dir lookup if the
    // loader didn't attach one — keeps out-of-tree providers that still
    // use the original layout working.
    const resolvedSpecPath = (provider as unknown as { _resolvedSpecPath?: string })._resolvedSpecPath;
    const dir = (provider as unknown as { _resolvedProviderDir?: string })._resolvedProviderDir;
    let specPath: string | undefined = resolvedSpecPath && fs.existsSync(resolvedSpecPath) ? resolvedSpecPath : undefined;
    if (!specPath && dir) {
        const legacy = path.join(dir, 'spec.json');
        if (fs.existsSync(legacy)) specPath = legacy;
    }
    if (!specPath) {
        throw new Error(formatNoResolvableSpecError(provider.type, dir));
    }
    LOG.info('spec-route', `[${provider.type}] routing through SpecCliAdapter (${path.relative(dir || '', specPath) || specPath})`);
    // MANIFEST-SEND-DELAY: hand the manifest's own submit tuning to the adapter. Until
    // now the manifest was consumed here purely as a carrier for _resolvedSpecPath and
    // its `sendDelayMs` went nowhere on the spec path (its only reader died with the
    // ProviderCliAdapter engine in 48e5ed1a) — so a provider could declare 1200ms and
    // silently run at 200ms. The driver treats it as a floor, never a reduction.
    return new SpecCliAdapter(specPath, workingDir, cliArgs, extraEnv, transportFactory, sessionId, {
        sendDelayMs: provider.sendDelayMs,
    });
}
