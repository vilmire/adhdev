import { describe, expect, it } from 'vitest';
import { compactProjectStatus, isUnmanagedRepoIdentity, machinesSummary } from '../../src/assistant/project-views.js';

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
