/**
 * Contract versioning — the store façade: one object binding the private DB,
 * clock, budgets, source reader and authority fence. Daemon wiring
 * (mesh/contract-runtime.ts) owns the process singleton; tests build their own
 * over an in-memory database.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Database as DatabaseHandle } from 'better-sqlite3';
import { canonicalDaemonId } from '@adhdev/mesh-shared';
import { resolveContractBudgets, type ContractBudgets, type ContractRuntime } from './contract-types.js';
import type { ContractAuthorityFencePort, ContractCtx } from './contract-context.js';
import { ensureContractSchema } from './contract-schema.js';
import { GitContractSourceReader, type ContractSourceReader } from './contract-git-source.js';

/** Fence evidence in a small JSON file beside (not inside) the database. */
export class FileContractAuthorityFence implements ContractAuthorityFencePort {
    constructor(private readonly filePath: string) {}

    private load(): Record<string, number> {
        try {
            if (!existsSync(this.filePath)) return {};
            const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
            return parsed && typeof parsed === 'object' ? parsed as Record<string, number> : {};
        } catch {
            return {};
        }
    }

    read(namespaceId: string): number | null {
        const v = this.load()[namespaceId];
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
    }

    write(namespaceId: string, authorityEpoch: number): void {
        const all = this.load();
        if ((all[namespaceId] ?? 0) >= authorityEpoch) return;
        all[namespaceId] = authorityEpoch;
        mkdirSync(path.dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.tmp`;
        writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
        renameSync(tmp, this.filePath);
    }
}

export class MemoryContractAuthorityFence implements ContractAuthorityFencePort {
    readonly epochs = new Map<string, number>();
    read(namespaceId: string): number | null { return this.epochs.get(namespaceId) ?? null; }
    write(namespaceId: string, authorityEpoch: number): void {
        if ((this.epochs.get(namespaceId) ?? 0) < authorityEpoch) this.epochs.set(namespaceId, authorityEpoch);
    }
}

export const SYSTEM_CONTRACT_RUNTIME: ContractRuntime = {
    nowMs: () => Date.now(),
    randomBytes: (n: number) => randomBytes(n),
};

export function createContractCtx(opts: {
    db: DatabaseHandle;
    localDaemonId: string;
    fence: ContractAuthorityFencePort;
    budgets?: Partial<ContractBudgets> | null;
    rt?: ContractRuntime;
    sourceReader?: ContractSourceReader;
    ensureSchema?: boolean;
}): ContractCtx {
    if (opts.ensureSchema !== false) ensureContractSchema(opts.db);
    return {
        db: opts.db,
        rt: opts.rt ?? SYSTEM_CONTRACT_RUNTIME,
        budgets: resolveContractBudgets(opts.budgets ?? null),
        // Stored and compared in canonical form (CANON-IDENTITY): SQL filters use equality.
        localDaemonId: canonicalDaemonId(opts.localDaemonId) || opts.localDaemonId,
        sourceReader: opts.sourceReader ?? new GitContractSourceReader(),
        fence: opts.fence,
    };
}
