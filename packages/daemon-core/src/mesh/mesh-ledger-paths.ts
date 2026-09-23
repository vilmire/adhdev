/**
 * The mesh runtime directory (`<configDir>/mesh-ledger/`) — home of
 * `mesh-runtime.db`, the turn-ledger migration exports and a few small JSON
 * state files. Named after the retired event ledger (C-W9a dropped its JSONL
 * mirror, the per-mesh path helpers and the archive sidecars); the directory
 * name stays because every install already has its database there.
 */
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getConfigDir } from '../config/config.js';

const LEDGER_DIR_NAME = 'mesh-ledger';

export function getLedgerDir(): string {
    const dir = join(getConfigDir(), LEDGER_DIR_NAME);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    return dir;
}
