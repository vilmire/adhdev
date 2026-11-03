import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { withAnnotations } from '../src/tools/tool-annotations.js';
import { canAdvertiseOwnerHandoff, projectHostHandoff, PROJECT_HOST_HANDOFF_TOOL } from '../src/tools/project-host-handoff.js';

describe('owner management host handoff tool', () => {
    it('is available only in the authenticated standard local operator scope', () => {
        const annotations = withAnnotations(PROJECT_HOST_HANDOFF_TOOL).annotations;
        assert.equal(annotations.readOnlyHint, false);
        assert.equal(annotations.destructiveHint, true);
        assert.equal(annotations.openWorldHint, true);
        const owner = { mode: 'local', password: 'fixture-owner-token' };
        assert.equal(canAdvertiseOwnerHandoff(owner, {}), true);
        for (const denied of [{ mode: 'ipc' }, { worker: true }, { assistant: true }, { meshId: 'project' }, { daemonAuthFile: '/fixture/internal-auth' }, { password: '' }]) {
            assert.equal(canAdvertiseOwnerHandoff({ ...owner, ...denied }, {}), false);
        }
        assert.equal(canAdvertiseOwnerHandoff(owner, { ADHDEV_MCP_SESSION_CREDENTIAL: 'fixture-session' }), false);
        assert.equal(canAdvertiseOwnerHandoff(owner, { ADHDEV_WORKER_SESSION_BIND: 'fixture-worker' }), false);
    });
    it('routes the exact owner-selected machine/idempotency key to the owner verb and cannot carry remote commands or credentials', async () => {
        const command = mock.fn(async () => ({ success: true, handoffId: 'same', phase: 'frozen' }));
        const args = { op: 'start', meshId: 'project', targetDaemonId: 'selected-machine', handoffId: 'same' };
        assert.deepEqual(JSON.parse(await projectHostHandoff({ command } as never, args)), { success: true, handoffId: 'same', phase: 'frozen' });
        assert.deepEqual(command.mock.calls.map(call => call.arguments), [['mesh_host_handoff', args]]);
        command.mock.resetCalls();
        assert.deepEqual(JSON.parse(await projectHostHandoff({ command } as never, { ...args, command: 'arbitrary-shell' })), { success: false, code: 'invalid_args' });
        assert.equal(command.mock.callCount(), 0);
    });
});
