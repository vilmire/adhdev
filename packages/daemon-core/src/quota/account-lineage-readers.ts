/**
 * Current owning-CLI account lineage per quota provider, for restart
 * hydration. Each reader is local and read-only (state file, credential file,
 * or the platform credential store) — no request, no token exchange — and
 * resolves to UNKNOWN when the CLI records no stable account identity.
 *
 * opencode has no owning account (it routes to whichever upstream accounts its
 * providers configure); its usage comes from the local session store, so its
 * readings are keyed to that store instead (see readOpencodeQuotaAccountLineage).
 */
import { UNKNOWN_ACCOUNT_LINEAGE, type QuotaAccountLineage } from './account-lineage.js';
import { readAntigravityQuotaAccountLineage } from './fetchers/antigravity.js';
import { readClaudeQuotaAccountLineage } from './fetchers/claude.js';
import { readCodexQuotaAccountLineage } from './fetchers/codex.js';
import { readCursorQuotaAccountLineage } from './fetchers/cursor.js';
import { readGrokQuotaAccountLineage } from './fetchers/grok.js';
import { readKimiQuotaAccountLineage } from './fetchers/kimi.js';
import { readOpencodeQuotaAccountLineage } from './fetchers/opencode.js';

export function readCurrentQuotaAccountLineage(
    provider: string,
    env: NodeJS.ProcessEnv,
): QuotaAccountLineage | Promise<QuotaAccountLineage> {
    switch (provider) {
        case 'grok-cli': return readGrokQuotaAccountLineage({ env });
        case 'kimi': return readKimiQuotaAccountLineage({ env });
        case 'claude-cli': return readClaudeQuotaAccountLineage({ env });
        case 'codex-cli': return readCodexQuotaAccountLineage({ env });
        case 'cursor-cli': return readCursorQuotaAccountLineage({ env });
        // darwin/win32 credential stores are read through a child process.
        case 'antigravity-cli': return readAntigravityQuotaAccountLineage({ env });
        case 'opencode': return readOpencodeQuotaAccountLineage({ env });
        default: return UNKNOWN_ACCOUNT_LINEAGE;
    }
}
