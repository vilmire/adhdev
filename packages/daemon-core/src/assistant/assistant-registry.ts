/**
 * Assistant registry — `<configDir>/assistant.json`, one entry per daemon
 * (design 2026-10-07-assistant-layer.md §4.5, §4.3 restart note, §4.6).
 *
 * Shape follows the design's field list. Unlike `mesh-coordinators.json` the
 * entry is never deleted when the session goes away: aliases, `busyInputMode`,
 * `reviewTurn`, `memoryBudget`, `firstRelayAt` and `lastTurnState` are
 * settings/history that outlive any one assistant session. "Unregister" here
 * means clearing the session binding (`sessionId`, `mcpConfigPath`) only.
 *
 * Patterns kept from `mesh/coordinator-registry.ts`:
 *   - written immediately on every change, atomically (tmp + rename) at 0600;
 *   - a `daemon_shutdown` termination never releases the binding (the hosted
 *     runtime survives and is re-attached after restart);
 *   - stale bindings are pruned against the FULL boot-time restore set only
 *     (`pruneAfterRestore`), never against a partial list.
 * Restore re-binds by exact runtimeId only (`matchesAssistantRestore`). One
 * assistant per daemon means no workspace fallback (§4.5).
 */

import { existsSync, readFileSync, renameSync } from 'fs';
import { join } from 'path';
import type { SendPolicy } from '@adhdev/mesh-shared';
import { getConfigDir } from '../config/config.js';
import type { SessionLifecycleBus, Unsubscribe } from '../sessions/lifecycle-bus.js';
import { resolveMemoryBudgets, type MemoryBudgets } from './memory/memory-store.js';
import { writeFileAtomic600 } from './store-guards.js';

export const ASSISTANT_REGISTRY_FILE = 'assistant.json';

/** Hermes `busy_input_mode` names (§4.3), mapped onto the existing SendPolicy. */
export const BUSY_INPUT_MODES = ['queue', 'interrupt', 'steer'] as const;
export type BusyInputMode = typeof BUSY_INPUT_MODES[number];
export const DEFAULT_BUSY_INPUT_MODE: BusyInputMode = 'queue';

/**
 * §4.3 table. Applies to HUMAN input into the assistant only; every daemon
 * input (relay, signals, restart note, review, first run) is always `queue`.
 * A refusal under the mapped policy is shown as is — callers never retry
 * under another mode (fail-closed).
 */
export function busyInputModeToSendPolicy(mode: BusyInputMode | undefined | null): SendPolicy {
    switch (mode) {
        case 'interrupt': return { mode: 'interrupt' };
        case 'steer': return { mode: 'send_now' };
        default: return { mode: 'queue' };
    }
}

export type AssistantTurnStateValue = 'idle' | 'working';

export interface AssistantTurnState {
    state: AssistantTurnStateValue;
    /** Epoch ms of the edge. */
    at: number;
    /** Session the edge was observed on. */
    sessionId: string;
}

export interface AssistantRegistryEntry {
    /** Bound assistant session (= hosted runtimeId); null when none is bound. */
    sessionId: string | null;
    cliType: string;
    workspace: string;
    mcpConfigPath?: string;
    /** User aliases → meshId (§4.2). */
    aliases: Record<string, string>;
    /** First launch, epoch ms. */
    createdAt: number;
    /** First relay ever delivered (M-metric anchor, §4.7), epoch ms. */
    firstRelayAt: number | null;
    busyInputMode: BusyInputMode;
    /** `false` disables the idle review turn (§4.10.7). */
    reviewTurn: boolean;
    lastTurnState: AssistantTurnState | null;
    memoryBudget?: Partial<MemoryBudgets>;
    /**
     * Epoch ms of idle review inputs delivered in the last 24 h (§4.10.7 "2 h
     * since the last review", "4 per day"). History, not a setting: kept here
     * so a daemon restart cannot re-fire a review the previous process already
     * delivered. Absent when empty.
     */
    reviewAts?: number[];
}

export interface BindAssistantSessionInput {
    sessionId: string;
    cliType: string;
    workspace: string;
    mcpConfigPath?: string;
    at: number;
}

export type AssistantSettingsPatch = Partial<Pick<AssistantRegistryEntry, 'aliases' | 'busyInputMode' | 'reviewTurn' | 'memoryBudget'>>;

export interface AssistantRegistryOptions {
    configDir?: string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function normalizeAliases(raw: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const alias = k.trim();
        if (alias && isStr(v)) out[alias] = v;
    }
    return out;
}

function normalizeTurnState(raw: unknown): AssistantTurnState | null {
    const r = raw as Partial<AssistantTurnState> | null;
    if (!r || (r.state !== 'idle' && r.state !== 'working') || !isNum(r.at) || !isStr(r.sessionId)) return null;
    return { state: r.state, at: r.at, sessionId: r.sessionId };
}

/** Review timestamps kept: the last 24 h, at most this many. */
export const ASSISTANT_REVIEW_HISTORY_MS = 24 * 60 * 60 * 1000;
const REVIEW_HISTORY_MAX = 16;

function normalizeReviewAts(raw: unknown): number[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(isNum).sort((a, b) => a - b).slice(-REVIEW_HISTORY_MAX);
}

function normalizeBudget(raw: unknown): Partial<MemoryBudgets> | undefined {
    const r = raw as Partial<MemoryBudgets> | null;
    if (!r || typeof r !== 'object') return undefined;
    const out: Partial<MemoryBudgets> = {};
    if (isNum(r.memory)) out.memory = r.memory;
    if (isNum(r.user)) out.user = r.user;
    return Object.keys(out).length ? out : undefined;
}

/** Validate a parsed file. Returns null when the minimum fields are missing. */
export function normalizeAssistantRegistryEntry(raw: unknown): AssistantRegistryEntry | null {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    if (!isStr(r.cliType) || !isStr(r.workspace) || !isNum(r.createdAt)) return null;
    const mode = BUSY_INPUT_MODES.includes(r.busyInputMode as BusyInputMode) ? r.busyInputMode as BusyInputMode : DEFAULT_BUSY_INPUT_MODE;
    const budget = normalizeBudget(r.memoryBudget);
    const reviewAts = normalizeReviewAts(r.reviewAts);
    return {
        sessionId: isStr(r.sessionId) ? r.sessionId : null,
        cliType: r.cliType,
        workspace: r.workspace,
        ...(isStr(r.mcpConfigPath) ? { mcpConfigPath: r.mcpConfigPath } : {}),
        aliases: normalizeAliases(r.aliases),
        createdAt: r.createdAt,
        firstRelayAt: isNum(r.firstRelayAt) ? r.firstRelayAt : null,
        busyInputMode: mode,
        reviewTurn: r.reviewTurn !== false,
        lastTurnState: normalizeTurnState(r.lastTurnState),
        ...(budget ? { memoryBudget: budget } : {}),
        ...(reviewAts.length ? { reviewAts } : {}),
    };
}

/**
 * The restore matcher (§4.5): a hosted runtime re-binds to the assistant only
 * when its runtimeId equals the registered sessionId exactly. No trimming, no
 * case folding, no workspace fallback.
 */
export function matchesAssistantRestore(
    entry: Pick<AssistantRegistryEntry, 'sessionId'> | null | undefined,
    record: { runtimeId?: unknown } | null | undefined,
): boolean {
    const sid = entry?.sessionId;
    const rid = record?.runtimeId;
    return typeof sid === 'string' && sid.length > 0 && typeof rid === 'string' && rid === sid;
}

/** The single restore record that re-binds the assistant, or null. */
export function findAssistantRestoreRecord<T extends { runtimeId?: unknown }>(
    entry: Pick<AssistantRegistryEntry, 'sessionId'> | null | undefined,
    records: readonly T[],
): T | null {
    return records.find((r) => matchesAssistantRestore(entry, r)) ?? null;
}

export class AssistantRegistry {
    readonly path: string;
    private cache: AssistantRegistryEntry | null | undefined;

    constructor(opts: AssistantRegistryOptions = {}) {
        this.path = join(opts.configDir ?? getConfigDir(), ASSISTANT_REGISTRY_FILE);
    }

    /** The entry, or null when the assistant was never launched. Corrupt → null (the file is kept aside on the next write). */
    read(): AssistantRegistryEntry | null {
        if (this.cache !== undefined) {
            if (!this.cache) return null;
            return { ...this.cache, aliases: { ...this.cache.aliases }, ...(this.cache.reviewAts ? { reviewAts: [...this.cache.reviewAts] } : {}) };
        }
        this.cache = this.load();
        return this.read();
    }

    /** Drop the in-memory copy (a person edited the file). */
    reload(): AssistantRegistryEntry | null {
        this.cache = undefined;
        return this.read();
    }

    memoryBudgets(): MemoryBudgets {
        return resolveMemoryBudgets(this.read()?.memoryBudget);
    }

    /**
     * `launch_assistant` / restore: bind the session, creating the entry on
     * first launch. A NEW session id resets `lastTurnState` to idle for that
     * session and hands back the previous one — the restart-note input
     * (§4.3), which must be read before anything overwrites it. Re-binding
     * the same id (restore) keeps the state and returns `previous: null`.
     */
    bindSession(input: BindAssistantSessionInput): { entry: AssistantRegistryEntry; previous: AssistantTurnState | null } {
        const prev = this.read();
        const sameSession = !!prev && prev.sessionId === input.sessionId;
        const next: AssistantRegistryEntry = {
            ...(prev ?? {
                aliases: {},
                createdAt: input.at,
                firstRelayAt: null,
                busyInputMode: DEFAULT_BUSY_INPUT_MODE,
                reviewTurn: true,
                lastTurnState: null,
            }),
            sessionId: input.sessionId,
            cliType: input.cliType,
            workspace: input.workspace,
        };
        if (!sameSession) next.lastTurnState = { state: 'idle', at: input.at, sessionId: input.sessionId };
        if (input.mcpConfigPath) next.mcpConfigPath = input.mcpConfigPath;
        else delete next.mcpConfigPath;
        const entry = this.write(next);
        return { entry, previous: sameSession ? null : prev?.lastTurnState ?? null };
    }

    /** Owner settings. Unknown busy modes are refused rather than coerced. */
    updateSettings(patch: AssistantSettingsPatch): AssistantRegistryEntry | null {
        const prev = this.read();
        if (!prev) return null;
        if (patch.busyInputMode !== undefined && !BUSY_INPUT_MODES.includes(patch.busyInputMode)) {
            throw new Error(`invalid busyInputMode: ${String(patch.busyInputMode)}`);
        }
        const next: AssistantRegistryEntry = { ...prev };
        if (patch.aliases !== undefined) next.aliases = normalizeAliases(patch.aliases);
        if (patch.busyInputMode !== undefined) next.busyInputMode = patch.busyInputMode;
        if (patch.reviewTurn !== undefined) next.reviewTurn = patch.reviewTurn !== false;
        if (patch.memoryBudget !== undefined) {
            const b = normalizeBudget(patch.memoryBudget);
            if (b) next.memoryBudget = b;
            else delete next.memoryBudget;
        }
        return this.write(next);
    }

    /** `turn` / `registered` edge of the bound session (restart note input, §4.3). */
    recordTurnState(sessionId: string, state: AssistantTurnStateValue, at: number): void {
        const prev = this.read();
        if (!prev || prev.sessionId !== sessionId) return;
        if (prev.lastTurnState?.state === state && prev.lastTurnState.sessionId === sessionId) return;
        this.write({ ...prev, lastTurnState: { state, at, sessionId } });
    }

    /** First relay delivery; later calls are no-ops. */
    markFirstRelay(at: number): void {
        const prev = this.read();
        if (!prev || prev.firstRelayAt !== null) return;
        this.write({ ...prev, firstRelayAt: at });
    }

    /** An idle review input reached the assistant (§4.10.7). Keeps the last 24 h. */
    recordReview(at: number): void {
        const prev = this.read();
        if (!prev || !isNum(at)) return;
        const reviewAts = normalizeReviewAts([...(prev.reviewAts ?? []), at].filter((t) => at - t < ASSISTANT_REVIEW_HISTORY_MS));
        this.write({ ...prev, reviewAts });
    }

    /**
     * The session left the registry. `daemon_shutdown` keeps the binding (the
     * runtime is re-attached after restart). Any other cause clears it; the
     * rest of the entry, `lastTurnState` included, is kept.
     */
    releaseSession(sessionId: string, cause: string): boolean {
        if (cause === 'daemon_shutdown') return false;
        const prev = this.read();
        if (!prev || !prev.sessionId || prev.sessionId !== sessionId) return false;
        const next: AssistantRegistryEntry = { ...prev, sessionId: null };
        delete next.mcpConfigPath;
        this.write(next);
        return true;
    }

    /**
     * After the boot-time restore: clear a binding whose runtime is not among
     * the live hosted runtimes. Callers MUST pass the full restore set.
     * Returns the cleared sessionId, or null.
     */
    pruneAfterRestore(liveRuntimeIds: ReadonlySet<string>): string | null {
        const prev = this.read();
        if (!prev?.sessionId || liveRuntimeIds.has(prev.sessionId)) return null;
        const cleared = prev.sessionId;
        const next: AssistantRegistryEntry = { ...prev, sessionId: null };
        delete next.mcpConfigPath;
        this.write(next);
        return cleared;
    }

    private load(): AssistantRegistryEntry | null {
        if (!existsSync(this.path)) return null;
        try {
            return normalizeAssistantRegistryEntry(JSON.parse(readFileSync(this.path, 'utf-8')));
        } catch {
            return null;
        }
    }

    private write(entry: AssistantRegistryEntry): AssistantRegistryEntry {
        this.keepCorruptAside();
        writeFileAtomic600(this.path, `${JSON.stringify(entry, null, 2)}\n`);
        this.cache = entry;
        return this.read()!;
    }

    /** A file that exists but does not parse is renamed, not overwritten silently. */
    private keepCorruptAside(): void {
        if (!existsSync(this.path)) return;
        try {
            if (normalizeAssistantRegistryEntry(JSON.parse(readFileSync(this.path, 'utf-8')))) return;
        } catch { /* corrupt → fall through */ }
        try {
            renameSync(this.path, `${this.path}.corrupt-${Date.now()}`);
        } catch { /* best effort; the write below still proceeds */ }
    }
}

let sharedRegistry: AssistantRegistry | null = null;

/**
 * The daemon's one registry instance (boot wiring, `launch_assistant`,
 * restore), so its in-memory copy never goes stale against another writer in
 * the same process. Built lazily from the config dir.
 */
export function getAssistantRegistry(): AssistantRegistry {
    if (!sharedRegistry) sharedRegistry = new AssistantRegistry();
    return sharedRegistry;
}

/** Tests: install a registry (null → rebuild lazily from the config dir). */
export function setAssistantRegistryForTests(registry: AssistantRegistry | null): void {
    sharedRegistry = registry;
}

/**
 * Keep the registry in step with the bus (wiring calls this at boot):
 *  - `terminated` of the bound session releases the binding (not on daemon_shutdown);
 *  - `turn` started/resumed → working, committed → idle;
 *  - `registered` of the bound session → idle.
 */
export function subscribeAssistantRegistry(bus: Pick<SessionLifecycleBus, 'on'>, registry: AssistantRegistry): Unsubscribe {
    return bus.on(['terminated', 'turn', 'registered'], (event) => {
        if (event.kind === 'terminated') {
            registry.releaseSession(event.sessionId, event.cause);
            return;
        }
        if (event.kind === 'registered') {
            registry.recordTurnState(event.sessionId, 'idle', event.at);
            return;
        }
        if (event.phase === 'started' || event.phase === 'resumed') registry.recordTurnState(event.sessionId, 'working', event.at);
        else if (event.phase === 'committed') registry.recordTurnState(event.sessionId, 'idle', event.at);
    }, { name: 'assistant.registry' });
}
