/**
 * Pre-score exclusion visibility (prescore-exclusions-visibility, 2026-10-10).
 *
 * resolveUsableProvider's per-slot loop (mesh-queue-autolaunch.ts) rejects slots
 * BEFORE they ever reach scoring — required-tags mismatch, or
 * slotProviderUnusableReason's enablement/detection gates. Those rejections were
 * built into a local `failed` array but only surfaced to the caller when
 * `usableSlots.length === 0` (the `provider_priority_unusable` branch). The
 * moment ANY slot survived (e.g. claude-cli always passing), every other slot's
 * rejection reason was computed and then silently discarded — no log line, no
 * ledger trace, no way to reconstruct post-hoc which gate tripped.
 *
 * Live evidence (2026-10-10): 5 difficult-task dispatches in a row showed
 * `selectionTrajectory.candidates=[claude-cli]` and `intraNodeLosers=[]`, while
 * mesh_route_preview (which doesn't run this filter) admitted codex/kimi/grok/claude
 * all 4. The rejected 3 never reached scoring, so they could never appear in
 * `candidates` or `intraNodeLosers` either — those arrays only ever see slots
 * that already passed this filter.
 *
 * This suite pins: the rejection reason is now always returned as
 * `preScoreExclusions`, regardless of whether other slots survived, and the two
 * distinct gates (required-tags mismatch / isMachineProviderEnabled "disabled" /
 * detectCLI "not detected") are distinguishable by their `reason` string.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testTmpDir = join(tmpdir(), `adhdev-prescore-exclusions-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'mach_host000000000001' }),
    getMachineId: () => 'mach_host000000000001',
    getMachineNickname: () => null,
}));

const detectCliMocks = vi.hoisted(() => ({ detected: new Set<string>() }));
vi.mock('../../src/detection/cli-detector.js', () => ({
    detectCLI: async (id: string) => (detectCliMocks.detected.has(id) ? { id, installed: true, path: `/mock/${id}` } : null),
}));

import { __resolveUsableProviderForTests } from '../../src/mesh/mesh-queue-assignment.js';
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js';

const MESH_ID = 'mesh_prescore_exclusions';

/** Local node: isMachineProviderEnabled + detectCLI are both judged locally. */
function components(enabled: string[]) {
    return {
        providerLoader: {
            resolveAlias: (t: string) => t,
            isMachineProviderEnabled: (t: string) => enabled.includes(t),
            setCliDetectionResults: () => {},
        },
    } as any;
}

function resolve(comps: any, node: any, requiredTags?: string[], difficulty = 'freeform') {
    return __resolveUsableProviderForTests(
        comps, node.id, node, MESH_ID, requiredTags,
        { difficulty, requiredTags } as any, null,
        { nodes: [node] }, 'task_1',
    );
}

beforeEach(() => { detectCliMocks.detected.clear(); });
afterEach(() => {
    __resetMeshRuntimeStoreForTests();
    if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true });
});

describe('pre-score exclusion visibility', () => {
    it('① one of two slots usable: the OTHER slot\'s rejection is still reported — the bug this fixes', async () => {
        // claude-cli enabled+detected, codex-cli disabled. Old code: usableSlots.length > 0
        // so the `provider_priority_unusable` branch (the only reader of `failed`) never ran —
        // codex-cli's rejection vanished with zero trace.
        detectCliMocks.detected.add('claude-cli');
        const comps = components(['claude-cli']);
        const node = {
            id: 'node_local',
            daemonId: 'mach_host000000000001',
            policy: { slots: [{ provider: 'claude-cli' }, { provider: 'codex-cli' }] },
        };
        const res = await resolve(comps, node);
        expect(res.reason).toBeUndefined();
        expect(res.providerType).toBe('claude-cli');
        expect(res.preScoreExclusions).toEqual([
            { providerType: 'codex-cli', reason: 'disabled' },
        ]);
        // The rejected slot never reached scoring — it must not leak into the
        // scored-candidate arrays (those are a strictly different population).
        expect(res.selectionTrajectory?.candidates.map((c: any) => c.providerType)).toEqual(['claude-cli']);
        expect((res.selectionTrajectory as any)?.preScoreExclusions).toEqual([
            { providerType: 'codex-cli', reason: 'disabled' },
        ]);
    });

    it('② all slots unusable: the existing provider_priority_unusable behavior is unchanged (no regression)', async () => {
        const comps = components([]);
        const node = {
            id: 'node_local',
            daemonId: 'mach_host000000000001',
            policy: { slots: [{ provider: 'claude-cli' }, { provider: 'codex-cli' }] },
        };
        const res = await resolve(comps, node);
        expect(res.providerType).toBeUndefined();
        expect(res.reason).toBe('provider_priority_unusable: claude-cli: disabled; codex-cli: disabled');
        expect(res.preScoreExclusions).toEqual([
            { providerType: 'claude-cli', reason: 'disabled' },
            { providerType: 'codex-cli', reason: 'disabled' },
        ]);
    });

    it('③ the two usability gates are distinguishable by reason: enablement vs detection', async () => {
        // codex-cli: isMachineProviderEnabled() returns true, but detectCLI finds nothing.
        detectCliMocks.detected.add('claude-cli');
        const comps = components(['claude-cli', 'codex-cli']);
        const node = {
            id: 'node_local',
            daemonId: 'mach_host000000000001',
            policy: { slots: [{ provider: 'claude-cli' }, { provider: 'codex-cli' }, { provider: 'kimi' }] },
        };
        const res = await resolve(comps, node);
        expect(res.providerType).toBe('claude-cli');
        expect(res.preScoreExclusions).toEqual([
            { providerType: 'codex-cli', reason: 'not detected' },
            { providerType: 'kimi', reason: 'disabled' },
        ]);
        // 'disabled' (isMachineProviderEnabled gate) and 'not detected' (detectCLI gate)
        // must never collapse into the same string — that collision is exactly what made
        // today's post-hoc reconstruction impossible.
        const reasons = res.preScoreExclusions!.map(e => e.reason);
        expect(new Set(reasons).size).toBe(reasons.length);
    });

    it('a required-tags mismatch is reported as its own distinct reason, not conflated with enablement/detection', async () => {
        detectCliMocks.detected.add('claude-cli');
        const comps = components(['claude-cli', 'kimi']);
        const node = {
            id: 'node_local',
            daemonId: 'mach_host000000000001',
            policy: { slots: [{ provider: 'claude-cli' }, { provider: 'kimi', tags: ['other-tag'] }] },
        };
        const res = await resolve(comps, node, ['needs-kimi-tag']);
        expect(res.preScoreExclusions?.some(e => e.providerType === 'kimi' && e.reason === 'required_tags_mismatch')).toBe(true);
    });
});
