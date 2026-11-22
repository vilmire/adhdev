import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL_MESH_TOOLS } from '../src/tools/mesh-tool-schemas.js';
import { meshLightContinueIntegration } from '../src/tools/mesh-tools-light.js';
import { validateMeshToolArgs } from '../src/tools/validate-tool-args.js';

test('light continuation requires and forwards the exact owner answer and source CAS', async () => {
    const name = 'mesh_light_continue_integration';
    const tool = ALL_MESH_TOOLS.find(entry => entry.name === name)!;
    const args = {
        task_id: 'light-source', expected_revision: 8, owner_decision_id: 'owner-answer',
        owner_option_id: 'a', owner_answer_revision: 2, dry_run: true,
    };
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(validateMeshToolArgs(name, args), null);
    for (const invalid of [
        { ...args, owner_option_id: undefined },
        { ...args, owner_answer_revision: undefined },
        { ...args, owner_answer_by: 'owner' },
    ]) assert.notEqual(validateMeshToolArgs(name, invalid), null);

    const calls: unknown[] = [];
    const ctx = {
        mesh: { id: 'mesh' },
        transport: { command: async (command: string, payload: unknown) => {
            calls.push({ command, payload });
            return { success: true };
        } },
    } as unknown as Parameters<typeof meshLightContinueIntegration>[0];
    for (const invalid of [
        { expected_revision: 8, owner_decision_id: 'owner-answer', owner_option_id: 'a', owner_answer_revision: 2 },
        { ...args, task_id: '' },
        { ...args, owner_answer_revision: undefined },
        { ...args, owner_answer_revision: '2' },
        { ...args, dry_run: 'true' },
    ]) {
        const input = invalid as Parameters<typeof meshLightContinueIntegration>[1];
        assert.equal(JSON.parse(await meshLightContinueIntegration(ctx, input)).code, 'bad_request');
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(JSON.parse(await meshLightContinueIntegration(ctx, args)), { success: true });
    assert.deepEqual(calls, [{
        command: 'light_continue_integration',
        payload: { meshId: 'mesh', sourceTaskId: 'light-source', expectedRevision: 8, ownerAnswer: { decisionId: 'owner-answer', optionId: 'a', revision: 2 }, dryRun: true },
    }]);
});
