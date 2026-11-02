import { describe, expect, it, vi } from 'vitest';
import { withAnnotations } from '../src/tools/tool-annotations.js';
import { canAdvertiseOwnerHandoff, projectHostHandoff, PROJECT_HOST_HANDOFF_TOOL } from '../src/tools/project-host-handoff.js';

describe('owner management host handoff tool', () => {
    it('is available only in the authenticated standard local operator scope', () => {
        expect(withAnnotations(PROJECT_HOST_HANDOFF_TOOL).annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
        const owner = { mode: 'local', password: 'fixture-owner-token' };
        expect(canAdvertiseOwnerHandoff(owner, {})).toBe(true);
        for (const denied of [{ mode: 'ipc' }, { worker: true }, { assistant: true }, { meshId: 'project' }, { daemonAuthFile: '/fixture/internal-auth' }, { password: '' }]) {
            expect(canAdvertiseOwnerHandoff({ ...owner, ...denied }, {})).toBe(false);
        }
        expect(canAdvertiseOwnerHandoff(owner, { ADHDEV_MCP_SESSION_CREDENTIAL: 'fixture-session' })).toBe(false);
        expect(canAdvertiseOwnerHandoff(owner, { ADHDEV_WORKER_SESSION_BIND: 'fixture-worker' })).toBe(false);
    });
    it('routes the exact owner-selected machine/idempotency key to the owner verb and cannot carry remote commands or credentials', async () => {
        const command = vi.fn(async () => ({ success: true, handoffId: 'same', phase: 'frozen' }));
        const args = { op: 'start', meshId: 'project', targetDaemonId: 'selected-machine', handoffId: 'same' };
        expect(JSON.parse(await projectHostHandoff({ command } as never, args))).toMatchObject({ success: true, handoffId: 'same' });
        expect(command).toHaveBeenCalledWith('mesh_host_handoff', args);
        command.mockClear();
        expect(JSON.parse(await projectHostHandoff({ command } as never, { ...args, command: 'arbitrary-shell' }))).toEqual({ success: false, code: 'invalid_args' });
        expect(command).not.toHaveBeenCalled();
    });
});
