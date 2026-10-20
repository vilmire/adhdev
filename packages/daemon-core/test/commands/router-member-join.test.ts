import { describe, expect, it } from 'vitest';
import { buildMemberJoinNode } from '../../src/commands/router-member-join.js';
import { buildMemberJoinNode as fromRouter } from '../../src/commands/router.js';

describe('member-join payload construction', () => {
    it('retains the existing router export as the same function', () => {
        expect(fromRouter).toBe(buildMemberJoinNode);
    });

    it('selects the requested configured member and preserves explicit capabilities', () => {
        const member = {
            id: 'worker-b', workspace: ' /repo/b ', repoRoot: ' /repo ',
            daemonId: 'daemon_mach_b', machineId: 'mach_b',
            userOverrides: { platform: 'win32', arch: 'x64', custom: true },
            policy: { taskLimit: 2 },
        };
        const mesh = { nodes: [{ id: 'worker-a', workspace: '/repo/a' }, member] };
        expect(fromRouter(mesh, { memberNodeId: ' worker-b ' }, 'daemon_mach_fallback')).toEqual({
            id: 'worker-b', workspace: '/repo/b', repoRoot: '/repo',
            daemonId: 'daemon_mach_b', machineId: 'mach_b',
            userOverrides: member.userOverrides, policy: member.policy, role: 'member',
        });
        expect(member.workspace).toBe(' /repo/b ');
    });

    it('prefers the explicit member and fills only absent platform and architecture', () => {
        const explicit = { nodeId: 'explicit', userOverrides: { custom: 7 }, policy: { max: 1 } };
        expect(fromRouter({ nodes: [{ id: 'configured', workspace: '/other' }] }, {
            memberNode: explicit, workspace: ' /chosen ',
        }, 'daemon_mach_fallback')).toEqual({
            id: 'explicit', workspace: '/chosen', daemonId: 'daemon_mach_fallback',
            userOverrides: { custom: 7, platform: process.platform, arch: process.arch },
            policy: explicit.policy, role: 'member',
        });
        expect(explicit.userOverrides).toEqual({ custom: 7 });
    });

    it('retains first-node selection and the process-workspace fallback', () => {
        expect(fromRouter({ nodes: [{ id: 'first', workspace: '/first' }, { id: 'second' }] }, {})).toMatchObject({
            id: 'first', workspace: '/first', role: 'member',
        });
        expect(fromRouter({}, {})).toEqual({
            workspace: process.cwd(),
            userOverrides: { platform: process.platform, arch: process.arch },
            policy: {}, role: 'member',
        });
    });
});
