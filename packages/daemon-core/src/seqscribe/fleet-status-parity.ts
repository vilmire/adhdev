/**
 * Phase 4 Stage 3 — `fleet.status` producer parity.
 *
 * The status reporter records two independently-built views of one tick:
 *
 *   · the WS view, projected through `buildCloudStatusReportPayload`
 *   · the `fleet.status` entry appended by the Stage 1 shadow
 *
 * This module retains only the WS view's fixed count/state axes, periodically
 * reads the Stage 1 producer's last-successful append snapshot, and compares
 * them. This is intentionally BUILDER-PATH parity, not ring-delivery parity:
 * whether the non-persistent in-memory ring tail reached a subscriber is the
 * Stage 2 SUB consumer's end-to-end responsibility. This module therefore uses
 * no seqscribe read API, consumer, cursor, vector, or stats poll.
 *
 * Mismatch output is deliberately aggregate-only. Logs contain fixed bucket
 * names and integers, never daemon/writer ids, timestamps, or field values.
 */

import { LOG } from '../logging/logger.js';
import type { FleetOnlineState, FleetSessionCounts } from '../status/reporter.js';
import type { SeqscribeNodeHandle } from './node.js';
import {
    getLastAppendedEntryForParity,
    isFleetStatusShadowActive,
} from './fleet-status-shadow.js';

export const FLEET_STATUS_PARITY_INTERVAL_MS = 60_000;
export const FLEET_STATUS_PARITY_SUMMARY_INTERVAL_MS = 60_000;
export const FLEET_STATUS_APPEND_SETTLE_MS = 5_000;

const EXPECTATION_TAIL = 128;

export type FleetStatusParityMismatchKind =
    | 'missing_shadow_append'
    | 'unexpected_shadow_append'
    | 'ide_count'
    | 'cli_count'
    | 'acp_count'
    | 'idle_count'
    | 'generating_count'
    | 'waiting_approval_count'
    | 'errored_count'
    | 'online_state';

const MISMATCH_KINDS: readonly FleetStatusParityMismatchKind[] = [
    'missing_shadow_append',
    'unexpected_shadow_append',
    'ide_count',
    'cli_count',
    'acp_count',
    'idle_count',
    'generating_count',
    'waiting_approval_count',
    'errored_count',
    'online_state',
];

const COUNT_AXES = [
    ['ideCount', 'ide_count'],
    ['cliCount', 'cli_count'],
    ['acpCount', 'acp_count'],
    ['idleCount', 'idle_count'],
    ['generatingCount', 'generating_count'],
    ['waitingApprovalCount', 'waiting_approval_count'],
    ['erroredCount', 'errored_count'],
] as const satisfies readonly (readonly [keyof FleetSessionCounts, FleetStatusParityMismatchKind])[];

export type FleetStatusParityBuckets = Record<FleetStatusParityMismatchKind, number>;

export interface FleetStatusParityCounters {
    /** Checks that reached a clean or mismatching verdict. */
    runs: number;
    /** Successful shadow snapshots compared with the matching WS tick. */
    compared: number;
    /** Cumulative differing axes / structural failures since process start. */
    mismatches: number;
    /** Fixed enum buckets only; no identifiers or values. */
    buckets: FleetStatusParityBuckets;
}

export interface FleetStatusParityExpectation {
    /** Correlation only. It is never logged or exposed in counters. */
    at: string;
    sessionCounts: FleetSessionCounts;
    onlineState: FleetOnlineState;
}

export interface FleetStatusParityRunResult {
    compared: boolean;
    mismatches: FleetStatusParityMismatchKind[];
}

export interface FleetStatusParityHandle {
    runOnce(): FleetStatusParityRunResult | null;
    stop(): void;
}

export interface FleetStatusParityOptions {
    intervalMs?: number;
    summaryIntervalMs?: number;
    appendSettleMs?: number;
    /** Do not arm an interval. Tests and manual diagnostics call runOnce. */
    once?: boolean;
    clock?: () => number;
    /** Injectable aggregate-only sink. */
    log?: (message: string) => void;
}

interface ObservedExpectation extends FleetStatusParityExpectation {
    generation: number;
    observedAt: number;
}

function emptyBuckets(): FleetStatusParityBuckets {
    return Object.fromEntries(MISMATCH_KINDS.map((kind) => [kind, 0])) as FleetStatusParityBuckets;
}

const counters: FleetStatusParityCounters = {
    runs: 0,
    compared: 0,
    mismatches: 0,
    buckets: emptyBuckets(),
};

let activeHandle: SeqscribeNodeHandle | null = null;
let activeTimer: ReturnType<typeof setInterval> | null = null;
let activeClock: () => number = () => Date.now();
let activeLog: (message: string) => void = (message) => LOG.info('Seqscribe', message);
let summaryIntervalMs = FLEET_STATUS_PARITY_SUMMARY_INTERVAL_MS;
let appendSettleMs = FLEET_STATUS_APPEND_SETTLE_MS;
let lastSummaryAt: number | null = null;
let summaryPending = false;
let nextGeneration = 1;
const expectations: ObservedExpectation[] = [];

function isOnlineState(value: unknown): value is FleetOnlineState {
    return value === 'online' || value === 'reconnecting' || value === 'offline';
}

function readCounts(value: unknown): FleetSessionCounts | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const result = {} as FleetSessionCounts;
    for (const [axis] of COUNT_AXES) {
        const count = record[axis];
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return null;
        result[axis] = count;
    }
    return result;
}

function normalizeExpectation(value: FleetStatusParityExpectation): FleetStatusParityExpectation | null {
    if (!value || typeof value.at !== 'string' || value.at.length === 0) return null;
    if (!isOnlineState(value.onlineState)) return null;
    const sessionCounts = readCounts(value.sessionCounts);
    if (!sessionCounts) return null;
    return { at: value.at, sessionCounts, onlineState: value.onlineState };
}

function summaryLine(): string {
    return [
        'fleet.status parity summary',
        `runs=${counters.runs}`,
        `compared=${counters.compared}`,
        `mismatches=${counters.mismatches}`,
        ...MISMATCH_KINDS.map((kind) => `${kind}=${counters.buckets[kind]}`),
    ].join(' ');
}

function recordVerdict(result: FleetStatusParityRunResult): FleetStatusParityRunResult {
    counters.runs++;
    if (result.compared) counters.compared++;
    for (const kind of result.mismatches) {
        counters.buckets[kind]++;
        counters.mismatches++;
    }
    if (result.mismatches.length > 0) summaryPending = true;

    const now = activeClock();
    if (
        summaryPending &&
        (lastSummaryAt === null || now - lastSummaryAt >= summaryIntervalMs)
    ) {
        activeLog(summaryLine());
        lastSummaryAt = now;
        summaryPending = false;
    }
    return result;
}

function runOnce(): FleetStatusParityRunResult | null {
    const handle = activeHandle;
    if (!handle) return null;

    const now = activeClock();
    const settled = expectations.filter((item) => now - item.observedAt >= appendSettleMs).at(-1);
    const actual = getLastAppendedEntryForParity();
    if (!actual) {
        return settled
            ? recordVerdict({ compared: false, mismatches: ['missing_shadow_append'] })
            : null;
    }

    let expected: ObservedExpectation | undefined;
    for (let index = expectations.length - 1; index >= 0; index--) {
        if (expectations[index]?.at === actual.at) {
            expected = expectations[index];
            break;
        }
    }
    if (!expected) return recordVerdict({ compared: false, mismatches: ['unexpected_shadow_append'] });

    // If an expectation old enough to have settled is newer than the newest
    // landed record, an append was dropped/failed. Do not compare the older
    // pair and accidentally call the current producer clean.
    if (settled && expected.generation < settled.generation) {
        return recordVerdict({ compared: false, mismatches: ['missing_shadow_append'] });
    }

    const mismatches: FleetStatusParityMismatchKind[] = [];
    for (const [axis, bucket] of COUNT_AXES) {
        if (expected.sessionCounts[axis] !== actual.sessionCounts[axis]) mismatches.push(bucket);
    }
    if (expected.onlineState !== actual.onlineState) mismatches.push('online_state');
    return recordVerdict({ compared: true, mismatches });
}

/**
 * Capture the WS path's independently projected count/state view.
 *
 * The thunk is not evaluated unless the shadow parity loop is armed. Thus the
 * default/off mode is a complete no-op, including projection cost. Never
 * throws into the status reporting path.
 */
export function observeFleetStatusWsProjection(
    build: () => FleetStatusParityExpectation,
): boolean {
    if (!activeHandle) return false;
    try {
        const value = normalizeExpectation(build());
        if (!value) return false;
        const observed: ObservedExpectation = {
            ...value,
            generation: nextGeneration++,
            observedAt: activeClock(),
        };
        const duplicate = expectations.findIndex((item) => item.at === observed.at);
        if (duplicate >= 0) expectations.splice(duplicate, 1);
        expectations.push(observed);
        if (expectations.length > EXPECTATION_TAIL) expectations.splice(0, expectations.length - EXPECTATION_TAIL);
        return true;
    } catch {
        return false;
    }
}

/**
 * Arm/detach the process-wide checker. Only an active shadow can arm it.
 * Calling with null is the shutdown detach and clears all correlation state.
 */
export function configureFleetStatusParity(
    handle: SeqscribeNodeHandle | null,
    opts: FleetStatusParityOptions = {},
): FleetStatusParityHandle | null {
    if (activeTimer) clearInterval(activeTimer);
    activeTimer = null;
    activeHandle = null;
    expectations.length = 0;
    nextGeneration = 1;
    summaryPending = false;
    lastSummaryAt = null;

    if (!handle || !isFleetStatusShadowActive()) return null;

    activeHandle = handle;
    activeClock = opts.clock ?? (() => Date.now());
    activeLog = opts.log ?? ((message) => LOG.info('Seqscribe', message));
    summaryIntervalMs = Math.max(1, opts.summaryIntervalMs ?? FLEET_STATUS_PARITY_SUMMARY_INTERVAL_MS);
    appendSettleMs = Math.max(0, opts.appendSettleMs ?? FLEET_STATUS_APPEND_SETTLE_MS);

    if (!opts.once) {
        activeTimer = setInterval(runOnce, Math.max(1, opts.intervalMs ?? FLEET_STATUS_PARITY_INTERVAL_MS));
        activeTimer.unref?.();
    }
    LOG.info('Seqscribe', 'fleet.status parity loop armed');

    const ownedHandle = handle;
    return {
        runOnce: () => activeHandle === ownedHandle ? runOnce() : null,
        stop(): void {
            if (activeHandle !== ownedHandle) return;
            configureFleetStatusParity(null);
        },
    };
}

export function fleetStatusParityCounters(): FleetStatusParityCounters {
    return { ...counters, buckets: { ...counters.buckets } };
}

/** Reset module state. TESTS ONLY. */
export function __resetFleetStatusParityForTests(): void {
    configureFleetStatusParity(null);
    counters.runs = 0;
    counters.compared = 0;
    counters.mismatches = 0;
    counters.buckets = emptyBuckets();
    activeClock = () => Date.now();
    activeLog = (message) => LOG.info('Seqscribe', message);
    summaryIntervalMs = FLEET_STATUS_PARITY_SUMMARY_INTERVAL_MS;
    appendSettleMs = FLEET_STATUS_APPEND_SETTLE_MS;
}
