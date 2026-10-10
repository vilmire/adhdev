import { describe, expect, it } from 'vitest';
import {
    PROJECT_STATUS_ROUTING_DIFFICULTY,
    compactProjectStatus, isUnmanagedRepoIdentity, machinesSummary, projectRoutingView, sessionRows,
} from '../../src/assistant/project-views.js';

describe('isUnmanagedRepoIdentity', () => {
    it('treats remote, local-name and real path identities as projects', () => {
        for (const id of ['github.com/vilmire/adhdev', 'local/todo-web', 'local/5e25f4abf52510677f716c76340f6e424e77fb24', '/Users/me/demo/remotes/todo-web', 'C:\\Users\\me\\code\\app']) {
            expect(isUnmanagedRepoIdentity(id), id).toBe(false);
        }
    });

    it('keeps scratch identities apart', () => {
        for (const id of ['', 'test-repo', 'scratch/x', 'local:abc', '/tmp/x', '/private/tmp/claude/scratch/repo', '/var/folders/ml/T/repo', 'C:\\Users\\me\\AppData\\Local\\Temp\\repo']) {
            expect(isUnmanagedRepoIdentity(id), id).toBe(true);
        }
    });
});

describe('compactProjectStatus — node labels and platform on standalone', () => {
    const extras = { queue: null, pendingApprovals: 0, coordinator: 'none' as const, threadOpen: null, lastRelayAt: null };

    it('falls back to the machine identity display name, then machineName, and to the os= capability tag', () => {
        const view = {
            routes: { node_a: { route: 'local' } },
            status: {
                nodes: [
                    // standalone: no nickname, identity display name is a hostname
                    { nodeId: 'node_a', machine: { displayName: 'studio.local', daemonId: 'standalone_mach_1' } },
                    // display name is only the daemon id → use machineName instead
                    { nodeId: 'node_b', machineName: 'win-box', machine: { displayName: 'standalone_mach_2', daemonId: 'standalone_mach_2' }, daemonBuildVersion: '1.0.78' },
                    { nodeId: 'node_c', machine: { displayName: 'standalone_mach_3', daemonId: 'standalone_mach_3' } },
                ],
            },
            membership: {
                mesh: {
                    nodes: [
                        { id: 'node_a', capabilities: ['gpu', 'os=darwin'] },
                        { id: 'node_b', nodeFacts: { platform: 'win32' } },
                        { id: 'node_c' },
                    ],
                },
            },
        };
        const out: any = compactProjectStatus(view, extras);
        expect(out.machines.map((m: any) => [m.node, m.label, m.os, m.build])).toEqual([
            ['node_a', 'studio.local', 'darwin', null],
            ['node_b', 'win-box', 'win32', '1.0.78'],
            ['node_c', null, null, null],
        ]);
    });

    it('an operator nickname still wins', () => {
        const out: any = compactProjectStatus({
            status: { nodes: [{ nodeId: 'n', machineNickname: 'mac-studio', reportedPlatform: 'darwin', machine: { displayName: 'studio.local' } }] },
        }, extras);
        expect(out.machines[0]).toMatchObject({ label: 'mac-studio', os: 'darwin' });
    });
});

describe('machinesSummary — remote hosts', () => {
    it('folds in remote hosts deduped against node-reported machines across id forms', () => {
        const meshes: any[] = [
            { id: 'm1', nodes: [{ id: 'n1', daemonId: 'mach_self' }, { id: 'n2', daemonId: 'mach_host', machineNickname: 'mac-studio' }] },
            { id: 'm2', nodes: [{ id: 'n3', daemonId: 'daemon_mach_self' }] },
        ];
        const out = machinesSummary(meshes, 'daemon_mach_self', undefined, [
            { daemonId: 'daemon_mach_host', label: 'host-label' },
            { daemonId: 'daemon_mach_other', label: 'jupiter' },
            { daemonId: null, label: 'unknown host' },
            { daemonId: 'mach_self', label: 'me' },
        ]);
        expect(out.map((m) => [m.label, m.self])).toEqual([['this machine', true], ['jupiter', false], ['mac-studio', false]]);
    });
});

describe('projectRoutingView — routing visibility (A7d)', () => {
    /**
     * Shaped exactly like a live `mesh_route_preview` answer, including the
     * prose/observability fields the allow-list must drop (`note`,
     * `availabilityAssumption`, `warning`, `limitations`, `fitnessWinner`'s
     * deprecation prose neighbours) and the free-text-ish extras a future
     * upstream field could look like.
     */
    const preview = {
        success: true,
        tool: 'mesh_route_preview',
        snapshot: {
            observedAt: '2026-10-10T00:00:00.000Z',
            pointInTime: true,
            warning: 'PROSE-SNAPSHOT-WARNING',
            writesPerformed: false,
            quotaFetchPerformed: false,
        },
        query: { difficulty: 'difficult', requiredTags: [], readonly: false },
        schedulingStrategy: 'fitness',
        targetMatched: true,
        nodeOrder: ['n1', 'n2'],
        predictedWinner: { nodeId: 'n1', providerType: 'claude-cli', model: 'opus', fitnessScore: 42 },
        nodes: [
            {
                nodeId: 'n1',
                predictedWinner: { providerType: 'claude-cli', model: 'opus', fitnessScore: 42 },
                availabilityAssumption: 'PROSE-AVAILABILITY-N1',
                stages: {
                    difficultyFloor: {
                        required: true,
                        admittedSlots: [{ providerType: 'claude-cli', model: 'opus' }],
                        excludedSlots: [
                            { providerType: 'codex-cli', model: 'gpt-5', reason: 'slot_capacity_exhausted' },
                            { providerType: 'kimi-cli', reason: 'difficulty_floor_unavailable' },
                            // malformed rows must not become half-rows
                            { reason: 'slot_capacity_exhausted' },
                            { providerType: 'cursor-cli' },
                        ],
                    },
                    fitness: [{ providerType: 'claude-cli', total: 42, selectionRank: 0 }],
                    quota: {
                        fitnessOrder: ['codex-cli', 'claude-cli'],
                        clearOrder: ['claude-cli', 'codex-cli'],
                        gated: [],
                        fitnessWinner: 'codex-cli',
                        fitnessOrderHead: 'codex-cli',
                        note: 'PROSE-QUOTA-NOTE',
                        winner: 'claude-cli',
                        reordered: true,
                        displacedFitnessWinner: 'codex-cli',
                        axis: 'weekly',
                        sessionAxisActive: false,
                    },
                },
                quotaDiagnostics: [
                    {
                        providerType: 'claude-cli',
                        bonus: { value: 12 },
                        gate: { outcome: 'clear' },
                        ranking: { axis: 'weekly', risk: 9.5, remainingPercent: 61, clearOrderIndex: 0 },
                    },
                    {
                        providerType: 'codex-cli',
                        bonus: { value: 0, zeroReason: 'snapshot-error', snapshotStatus: 'error', failureKind: 'auth_expired' },
                        gate: { outcome: 'skip', reason: 'provider_quota_weekly_low' },
                    },
                    {
                        providerType: 'kimi-cli',
                        bonus: { value: 0, zeroReason: 'stale', snapshotStatus: 'stale' },
                        gate: { outcome: 'not-evaluated-floor' },
                    },
                ],
            },
            {
                nodeId: 'n2',
                reason: 'provider_priority_unusable',
                availabilityAssumption: 'PROSE-AVAILABILITY-N2',
                stages: {
                    difficultyFloor: { required: false, admittedSlots: [], excludedSlots: [] },
                    fitness: [],
                    quota: { fitnessOrder: [], clearOrder: [], gated: [], reordered: false, note: 'PROSE-QUOTA-NOTE-2', axis: 'weekly', sessionAxisActive: false },
                },
                quotaDiagnostics: [],
            },
            // no nodeId → dropped
            { stages: {}, quotaDiagnostics: [] },
        ],
        limitations: ['PROSE-LIMITATION-1', 'PROSE-LIMITATION-2'],
    };

    const labels = new Map<string, string | null>([['n1', 'mac-studio'], ['n2', null]]);

    it('carries the exclusion and node-level reason enums through verbatim', () => {
        const out = projectRoutingView(preview, 'difficult', labels);
        expect(out).toMatchObject({ strategy: 'fitness', difficulty: 'difficult' });
        expect(out.predictedWinner).toEqual({ nodeId: 'n1', providerType: 'claude-cli', model: 'opus', fitnessScore: 42 });
        expect(out.perNode.map((n) => n.nodeId)).toEqual(['n1', 'n2']);

        const n1 = out.perNode[0]!;
        expect(n1.machineName).toBe('mac-studio');
        expect(n1.predictedWinner).toEqual({ providerType: 'claude-cli', model: 'opus', fitnessScore: 42 });
        // the reason enums are the answer to "why is this provider not used"
        expect(n1.excluded).toEqual([
            { providerType: 'codex-cli', model: 'gpt-5', reason: 'slot_capacity_exhausted' },
            { providerType: 'kimi-cli', reason: 'difficulty_floor_unavailable' },
        ]);
        expect(n1.admitted).toEqual([{ providerType: 'claude-cli', model: 'opus' }]);
        expect(n1.reordered).toBe(true);
        expect(n1.displacedFitnessWinner).toBe('codex-cli');

        const n2 = out.perNode[1]!;
        expect(n2.machineName).toBeNull();
        expect(n2.predictedWinner).toBeNull();
        expect(n2.reason).toBe('provider_priority_unusable');
    });

    it('shows failureKind / zeroReason / gateOutcome when a quota snapshot is error or stale', () => {
        const quota = projectRoutingView(preview, 'difficult', labels).perNode[0]!.quota;
        expect(quota).toEqual([
            { providerType: 'claude-cli', gateOutcome: 'clear', bonusValue: 12, remainingPercent: 61, axis: 'weekly' },
            {
                providerType: 'codex-cli',
                snapshotStatus: 'error',
                failureKind: 'auth_expired',
                zeroReason: 'snapshot-error',
                gateOutcome: 'skip',
                gateReason: 'provider_quota_weekly_low',
                bonusValue: 0,
            },
            { providerType: 'kimi-cli', snapshotStatus: 'stale', zeroReason: 'stale', gateOutcome: 'not-evaluated-floor', bonusValue: 0 },
        ]);
    });

    it('is an allow-list: no prose from the preview, and no key outside the declared shape', () => {
        const out = projectRoutingView(preview, 'difficult', labels);
        const json = JSON.stringify(out);
        for (const prose of ['PROSE-SNAPSHOT-WARNING', 'PROSE-AVAILABILITY-N1', 'PROSE-AVAILABILITY-N2', 'PROSE-QUOTA-NOTE', 'PROSE-LIMITATION-1']) {
            expect(json, prose).not.toContain(prose);
        }

        // Every key that crosses, enumerated. A field added upstream to
        // NodeRoutePreview / ProviderQuotaGateDiagnostic cannot appear here
        // without this list being updated on purpose.
        const keys = new Set<string>();
        const walk = (v: unknown): void => {
            if (Array.isArray(v)) return void v.forEach(walk);
            if (v && typeof v === 'object') {
                for (const [k, val] of Object.entries(v)) { keys.add(k); walk(val); }
            }
        };
        walk(out);
        const ALLOWED = [
            'admitted', 'axis', 'bonusValue', 'difficulty', 'displacedFitnessWinner', 'excluded',
            'failureKind', 'fitnessScore', 'gateOutcome', 'gateReason', 'machineName', 'model',
            'nodeId', 'perNode', 'predictedWinner', 'providerType', 'quota', 'reason',
            'remainingPercent', 'reordered', 'snapshotStatus', 'strategy', 'zeroReason',
        ];
        expect([...keys].sort()).toEqual(ALLOWED);
    });

    it('answers with an empty view, never a throw, when the preview is missing', () => {
        const out = projectRoutingView(null, PROJECT_STATUS_ROUTING_DIFFICULTY);
        expect(out).toEqual({ strategy: 'unknown', difficulty: 'medium', predictedWinner: null, perNode: [] });
    });
});

describe('sessionRows — live session visibility (A2)', () => {
    const NOW = 1_800_000_000_000;

    /** The orphan the owner found before the assistant did (live 2026-10-10). */
    const orphan = {
        instanceId: 'bbd6c422',
        type: 'claude-cli',
        status: 'idle',
        workspace: '/Users/me/Work/BATRP',
        activeChat: { id: 'c', title: 't', status: 'idle', messages: [], activeModal: null },
        settings: { meshNodeFor: 'mesh_batrp', meshNodeId: 'node_3922a9ee' },
        launch: { launchedBy: 'mesh_launch_session', launchedAt: NOW - 90_000 },
    };
    const working = {
        instanceId: 'a34e7359',
        type: 'antigravity-cli',
        status: 'generating',
        workspace: '/Users/me/Work/BATRP',
        activeChat: { id: 'c', title: 't', status: 'generating', messages: [{ role: 'user' }, { role: 'assistant' }] },
        settings: { meshNodeFor: 'mesh_batrp', meshNodeId: 'node_3922a9ee', autoLaunchedForQueueTaskId: '33c49fa9' },
        launch: { launchedBy: 'auto_launch', launchedAt: NOW - 30_000 },
    };
    /** Another mesh on the SAME daemon — one daemon hosts several (live: adhdev-cloud + BATRP). */
    const otherMesh = {
        instanceId: '423670c4',
        type: 'claude-cli',
        status: 'idle',
        workspace: '/Users/me/Work/adhdev',
        activeChat: { id: 'c', title: 't', status: 'idle', messages: [{ role: 'user' }] },
        settings: { meshCoordinatorFor: 'mesh_adhdev' },
        launch: { launchedBy: 'coordinator', launchedAt: NOW - 600_000 },
    };

    it('carries the orphan signature: messageCount 0 + spawnedForTaskId null, next to a session that holds work', () => {
        const rows = sessionRows([orphan, working], { now: NOW });
        const byId = new Map(rows.map((r) => [r.sessionId, r]));

        const o = byId.get('bbd6c422')!;
        expect(o.messageCount).toBe(0);
        expect(o.spawnedForTaskId).toBeNull();
        expect(o.status).toBe('idle');
        expect(o.ageMs).toBe(90_000);
        expect(o.launchedBy).toBe('mesh_launch_session');
        expect(o.isCoordinator).toBe(false);

        // The contrast that makes the signal usable: same node, but this one has work.
        const w = byId.get('a34e7359')!;
        expect(w.messageCount).toBe(2);
        expect(w.spawnedForTaskId).toBe('33c49fa9');
    });

    it('is daemon-wide: cross-mesh sessions are READABLE, and narrowing keeps unstamped sessions', () => {
        // No meshId → every mesh on this daemon. Orphan hunting needs this; a
        // coordinator scoped to one mesh was refused outright ("not a member of mesh").
        expect(sessionRows([orphan, working, otherMesh], { now: NOW }).map((r) => r.sessionId))
            .toEqual(['423670c4', 'a34e7359', 'bbd6c422']);
        expect(sessionRows([otherMesh], { now: NOW })[0]!.meshId).toBe('mesh_adhdev');
        expect(sessionRows([otherMesh], { now: NOW })[0]!.isCoordinator).toBe(true);

        // Narrowed → that mesh only…
        expect(sessionRows([orphan, working, otherMesh], { meshId: 'mesh_batrp', now: NOW }).map((r) => r.sessionId))
            .toEqual(['a34e7359', 'bbd6c422']);
        // …but a session with NO mesh stamp is kept: an orphan often has none,
        // and dropping it would hide the very thing this surface exists for.
        const unstamped = { instanceId: 'zz99', type: 'kimi', status: 'idle', activeChat: null, settings: {} };
        expect(sessionRows([unstamped], { meshId: 'mesh_batrp', now: NOW }).map((r) => r.sessionId)).toEqual(['zz99']);
    });

    it('is an allow-list: no transcript/prose field crosses, and no key outside the declared shape', () => {
        // Every excluded field populated on the input at once. None may appear.
        const leaky = {
            ...working,
            lastMessagePreview: 'PROSE-LAST-MESSAGE-PREVIEW',
            errorMessage: 'PROSE-ERROR-MESSAGE',
            title: 'PROSE-TITLE',
            activeChat: {
                ...working.activeChat,
                title: 'PROSE-CHAT-TITLE',
                inputContent: 'PROSE-INPUT-CONTENT',
                messages: [{ role: 'user', content: 'PROSE-MESSAGE-BODY' }],
                activeModal: { message: 'PROSE-MODAL-MESSAGE', buttons: ['PROSE-BUTTON'] },
            },
            summaryMetadata: { note: 'PROSE-SUMMARY-METADATA' },
            launch: { ...working.launch, cliArgs: ['PROSE-CLI-ARG'] },
            settings: { ...working.settings, autoApproveMode: 'PROSE-SETTING' },
        };
        const out = sessionRows([leaky], { now: NOW });
        const json = JSON.stringify(out);
        for (const prose of [
            'PROSE-LAST-MESSAGE-PREVIEW', 'PROSE-ERROR-MESSAGE', 'PROSE-TITLE', 'PROSE-CHAT-TITLE',
            'PROSE-INPUT-CONTENT', 'PROSE-MESSAGE-BODY', 'PROSE-MODAL-MESSAGE', 'PROSE-BUTTON',
            'PROSE-SUMMARY-METADATA', 'PROSE-CLI-ARG', 'PROSE-SETTING',
        ]) {
            expect(json, prose).not.toContain(prose);
        }
        // The message BODY must not cross, but its COUNT must.
        expect(out[0]!.messageCount).toBe(1);

        // Every key that crosses, enumerated. A field added to ProviderState /
        // SessionLaunchRecord upstream cannot appear here without this list
        // being updated on purpose — this list IS the boundary declaration.
        const keys = new Set<string>();
        const walk = (v: unknown): void => {
            if (Array.isArray(v)) return void v.forEach(walk);
            if (v && typeof v === 'object') {
                for (const [k, val] of Object.entries(v)) { keys.add(k); walk(val); }
            }
        };
        walk(out);
        const ALLOWED = [
            'ageMs', 'assistant', 'isCoordinator', 'launchedBy', 'meshId', 'messageCount',
            'nodeId', 'provider', 'sessionId', 'spawnedForTaskId', 'status', 'workspace',
        ];
        expect([...keys].sort()).toEqual(ALLOWED);
    });

    it('never throws on malformed or absent state (no launch record, null chat, junk entries)', () => {
        const rows = sessionRows([null, undefined, 42, {}, { instanceId: '' }, { instanceId: 'ok', activeChat: null, settings: null }], { now: NOW });
        expect(rows.map((r) => r.sessionId)).toEqual(['ok']);
        expect(rows[0]).toMatchObject({ ageMs: null, launchedBy: null, messageCount: 0, workspace: null, assistant: false });
    });
});
