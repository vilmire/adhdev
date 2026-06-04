/**
 * Routing — given a CLI provider definition, decide whether to drive
 * it via the legacy ProviderCliAdapter (scripts/v1/*.js parsers +
 * cli-state-engine) or via SpecCliAdapter (single spec.json +
 * SpecDriver). The gate is the presence of spec.json in the resolved
 * provider directory.
 *
 * This is the only place in the daemon that knows which path a given
 * provider takes. Providers can be migrated one at a time by adding
 * a spec.json next to their scripts/v1/, then deleting scripts/v1/.
 */
'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ProviderCliAdapter } from '../../cli-adapters/provider-cli-adapter.js';
import type { CliProviderModule } from '../../cli-adapters/provider-cli-adapter.js';
import type { PtyTransportFactory } from '../../cli-adapters/pty-transport.js';
import type { CliAdapter } from '../../cli-adapter-types.js';
import { SpecCliAdapter } from './cli-adapter.js';
import { LOG } from '../../logging/logger.js';

export function createCliAdapter(
    provider: CliProviderModule,
    workingDir: string,
    cliArgs: string[],
    extraEnv: Record<string, string>,
    transportFactory?: PtyTransportFactory,
): CliAdapter {
    const dir = (provider as unknown as { _resolvedProviderDir?: string })._resolvedProviderDir;
    if (dir) {
        const specPath = path.join(dir, 'spec.json');
        if (fs.existsSync(specPath)) {
            try {
                LOG.info('spec-route', `[${provider.type}] routing through SpecCliAdapter (spec.json present)`);
                return new SpecCliAdapter(specPath, workingDir, cliArgs, extraEnv, transportFactory);
            } catch (err) {
                LOG.warn('spec-route', `[${provider.type}] spec invalid, falling back to ProviderCliAdapter: ${(err as Error).message}`);
            }
        }
    }
    return new ProviderCliAdapter(provider, workingDir, cliArgs, extraEnv, transportFactory) as unknown as CliAdapter;
}
