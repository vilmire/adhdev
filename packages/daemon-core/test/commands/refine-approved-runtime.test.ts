import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fastForwardHandlers } from '../../src/commands/med-family/fast-forward.js';
import { APPROVED_RUNTIME_COMMAND, requireApprovedMain, requireApprovedPins, selectApprovedRuntimeStage, verifyRuntimePayload } from '../../src/commands/med-family/refine-approved-runtime.js';
import { attachAuthenticatedMcpCommand } from '../../src/commands/mcp-command-ingress.js';
import { setArtifactCommandRuntimeForDeps } from '../../src/commands/med-family/artifact-runtime.js';
import { registerMeshCoordinator, unregisterMeshCoordinator } from '../../src/mesh/coordinator-registry.js';
import { runMeshRefineValidationGate } from '../../src/mesh/mesh-refine-gates.js';

describe('owner-approved Refinery runtime', () => {
    it('rejects a changed command, a preexisting PATH, and a different Git pin', () => {
        const path = '/fixture/runtime';
        const command = () => ({ command: 'node', args: ['gate.js'] });
        const bootstrap = { commands: [command()] };
        const refine = { validation: { bootstrapCommands: [command()], commands: Array.from({ length: 45 }, command), schedule: { prepare: [command()] } } };
        const withPath = () => ({ ...command(), env: { PATH: path } });
        const proposed = { worktreeBootstrapConfig: { commands: [withPath()] }, refineConfig: { validation: {
            bootstrapCommands: [withPath()], commands: Array.from({ length: 45 }, withPath), schedule: { prepare: [withPath()] },
        } } };
        expect(verifyRuntimePayload(bootstrap, refine, proposed, path)).toEqual({ commandCounts: [1, 1, 1, 45], equivalent: true, environmentKeys: ['PATH'] });
        proposed.refineConfig.validation.commands[44].args.push('--modified');
        expect(() => verifyRuntimePayload(bootstrap, refine, proposed, path)).toThrow('payload_contains_non_path_changes');
        Object.assign(bootstrap.commands[0], { env: { PATH: path } });
        expect(() => verifyRuntimePayload(bootstrap, refine, proposed, path)).toThrow('existing_command_path');
        const root = '441a8fa59dcff03cacd13a1f584af9a7ab609dab';
        const oss = '86ce8d27e2f064088a61b38bfe560a760c670c54';
        const gitlink = `160000 commit ${oss}\toss`;
        expect(() => requireApprovedPins({ root, oss, gitlink })).not.toThrow();
        expect(() => requireApprovedPins({ root, oss: root, gitlink })).toThrow('approved_source_changed');
    });

    it('requires an exact opt-in for private Root and refuses a moved or out-of-order main', () => {
        const first = selectApprovedRuntimeStage('node_346dc118ddb04ab5841a60bd209f9bdf', undefined, undefined);
        const node = 'node_127a5a2ab7154904916a9356e6692ca0';
        const second = selectApprovedRuntimeStage(node, undefined, undefined);
        expect(second.publishRoot).toBe(false);
        expect(second.count).toBe(2);
        expect(() => selectApprovedRuntimeStage(node, 'ff-only', { [node]: first.root })).toThrow('private_root_contract_mismatch');
        expect(() => selectApprovedRuntimeStage(node, 'ff-only', { [node]: second.root, [first.nodeId]: first.root })).toThrow('private_root_contract_mismatch');
        expect(selectApprovedRuntimeStage(node, 'ff-only', { [node]: second.root }).publishRoot).toBe(true);
        expect(() => requireApprovedMain(second, first.rootBase, first.ossBase)).toThrow('approved_main_changed');
        expect(() => requireApprovedMain(second, first.root, first.ossBase)).toThrow('approved_main_changed');
        expect(() => requireApprovedMain(second, first.root, first.oss)).not.toThrow();
        expect(() => requireApprovedMain(second, first.root, first.oss, true)).toThrow('approved_main_changed');
        expect(() => requireApprovedMain(second, first.root, second.oss, true)).not.toThrow();
        expect(() => requireApprovedMain(first, second.rootBase, second.oss)).toThrow('approved_main_changed');
        // Stage 1 accepts canonical OSS main at stage2.oss (9245) ONLY when proven incrementalReachable=true (exact 2 incremental approved commits above 86ce), and rejects unapproved descendants (e.g. 4d319d05) or unproven reachability
        expect(() => requireApprovedMain(first, first.rootBase, second.oss, false, false)).toThrow('approved_main_changed');
        expect(() => requireApprovedMain(first, first.rootBase, second.oss, true, false)).toThrow('approved_main_changed');
        expect(() => requireApprovedMain(first, first.rootBase, second.oss, false, true)).not.toThrow();
        expect(() => requireApprovedMain(first, first.rootBase, second.oss, true, true)).not.toThrow();
        expect(() => requireApprovedMain(first, first.rootBase, '4d319d05bc33ee0adc1b4410a3385f0b6ef346d4', false, true)).toThrow('approved_main_changed');
        expect(() => requireApprovedMain(second, second.rootBase, '4d319d05bc33ee0adc1b4410a3385f0b6ef346d4', false, true)).toThrow('approved_main_changed');
    });

    it('rejects an envelope without coordinator authority or with extra input', async () => {
        const handler = fastForwardHandlers[APPROVED_RUNTIME_COMMAND];
        const args = { meshId: 'fixture', nodeId: 'fixture', runtimeApprovalId: 'mi_917b95c8c342' };
        expect(await handler({} as never, { ...args, env: { PATH: '/unapproved' } })).toMatchObject({ code: 'invalid_runtime_approval_request' });
        expect(await handler({} as never, args)).toMatchObject({ code: 'runtime_approval_refused', error: 'local_coordinator_required' });
    });

    it('reads current owner decisions and verifies artifact bytes on the authenticated route', async () => {
        const meshId = 'mesh_271444af883843e9b36c67155b87b22f';
        const sessionId = 'coordinator-approved-runtime-fixture';
        const artifactId = 'art_8e90c58cbd79f9af';
        const missionId = 'release-fixture';
        const args = { meshId, nodeId: 'node_346dc118ddb04ab5841a60bd209f9bdf', runtimeApprovalId: 'mi_917b95c8c342' };
        const answer = { by: 'owner', via: 'dashboard', optionId: 'a', at: '2026-11-26T15:20:41.346Z' };
        const record = { kind: 'decision', state: 'answered', missionId, decision: { answer, answerRevision: 1 }, refs: [{ value: artifactId }] };
        const incremental = structuredClone(record);
        incremental.decision.answer.at = '2026-11-27T03:38:58.306Z';
        const deps = {};
        registerMeshCoordinator({ sessionId, meshId } as never);
        setArtifactCommandRuntimeForDeps(deps as never, {
            meshRuntimeStore: {
                getMission: () => ({ status: 'active' }),
                missionItems: () => ({ getItem: (_mesh: string, id: string) => id === 'mi_b8876f8fedba' ? incremental : ['mi_917b95c8c342', 'mi_729d08b91f11'].includes(id) ? record : undefined }),
            } as never,
            artifactStore: {
                get: () => ({ meshId, missionId, kind: 'json', originDaemonId: 'daemon_mach_6733c865d60f432dbeb119a6875ee303',
                    sha256: '4a070077fa1860ba7eee1c79f9279a98922ed088c673f09a4875f9632c3082a9' }),
                readArtifactContent: () => ({ hasMore: false, totalBytes: 2, byteContentBase64: 'e30=' }),
            } as never,
        });
        let live = true;
        const envelope = attachAuthenticatedMcpCommand(args, APPROVED_RUNTIME_COMMAND, () => live, { sessionId, meshId, isCoordinator: true });
        const call = () => fastForwardHandlers[APPROVED_RUNTIME_COMMAND]({ deps } as never, envelope);
        try {
            expect(await call()).toMatchObject({ error: 'artifact_content_changed' });
            const secondEnvelope = attachAuthenticatedMcpCommand(
                { ...args, nodeId: 'node_127a5a2ab7154904916a9356e6692ca0' },
                APPROVED_RUNTIME_COMMAND, () => live, { sessionId, meshId, isCoordinator: true },
            );
            const callSecond = () => fastForwardHandlers[APPROVED_RUNTIME_COMMAND]({ deps } as never, secondEnvelope);
            expect(await callSecond()).toMatchObject({ error: 'artifact_content_changed' });
            incremental.decision.answerRevision++;
            expect(await callSecond()).toMatchObject({ error: 'incremental_decision_changed' });
            expect(await call()).toMatchObject({ error: 'artifact_content_changed' });
            incremental.decision.answerRevision = 1;
            expect(await call()).toMatchObject({ error: 'artifact_content_changed' });
            answer.by = 'auto_recommended';
            expect(await call()).toMatchObject({ error: 'owner_decision_changed' });
            answer.by = 'owner';
            record.decision.answerRevision++;
            expect(await call()).toMatchObject({ error: 'runtime_decision_changed' });
            live = false;
            expect(await call()).toMatchObject({ error: 'local_coordinator_required' });
        } finally {
            unregisterMeshCoordinator(sessionId);
            setArtifactCommandRuntimeForDeps(deps as never, null);
        }
    });

    it('projects only the approved runtime wire contract with no legacy fallback', async () => {
        const { meshRefineNode } = await import('../../../mcp-server/src/tools/mesh-tools-refine.js');
        const calls: Array<{ command: string; payload: unknown }> = [];
        const args = { node_id: 'node-test', runtime_approval_id: 'mi_917b95c8c342', execute: true };
        const ctx = {
            mesh: { id: 'mesh-test', nodes: [{ id: 'node-test' }] },
            transport: { command: async (command: string, payload: unknown) => {
                calls.push({ command, payload });
                return { success: false, error: 'Unknown command' };
            } },
        } as never;
        await meshRefineNode(ctx, args);
        expect(calls.filter(call => call.command.startsWith('refine_mesh_node'))).toEqual([{
            command: APPROVED_RUNTIME_COMMAND,
            payload: { meshId: 'mesh-test', nodeId: 'node-test', runtimeApprovalId: args.runtime_approval_id, execute: true, dryRun: undefined },
        }]);
        expect(JSON.parse(await meshRefineNode(ctx, { ...args, env: { PATH: '/fixture' } } as never))).toMatchObject({ code: 'invalid_runtime_approval_request' });
        await meshRefineNode(ctx, { ...args, merge_mode: 'ff-only', approved_target_shas: { [args.node_id]: 'a'.repeat(40) } });
        expect(calls.at(-1)?.payload).toMatchObject({ mergeMode: 'ff-only', approvedTargetShas: { [args.node_id]: 'a'.repeat(40) } });
        expect(JSON.parse(await meshRefineNode(ctx, { ...args, approved_publish_shas: ['a'.repeat(40)] }))).toMatchObject({ code: 'invalid_runtime_approval_request' });
    });

    const originalPath = process.env.PATH;
    afterEach(() => expect(process.env.PATH).toBe(originalPath));

    it('uses child-only PATH for bootstrap, fallback, serial, prepare and lanes, including failed runs', async () => {
        const path = [dirname(process.execPath), '/fixture/runtime', originalPath].join(delimiter);
        const runtime = { path, checkAuthority: () => {} };
        const ws = mkdtempSync(join(tmpdir(), 'adhdev-approved-runtime-'));
        writeFileSync(join(ws, 'gate.js'), 'console.log(process.env.PATH.includes("/fixture/runtime") ? "scoped" : "baseline"); if (process.argv.includes("fail")) process.exitCode = 1;');
        const cmd = (id: string, ...args: string[]) => ({ id, command: 'node', args: ['gate.js', ...args], category: 'custom' });
        const mesh = { policy: { refineConfig: { version: 1, validation: {
            required: true, bootstrapCommands: [cmd('legacy')], commands: [cmd('serial')],
        } } } };
        const serial = await runMeshRefineValidationGate(mesh, ws, { approvedRuntime: runtime });
        expect(serial.status).toBe('passed');
        expect(serial.bootstrapCommandsRun[0].stdout).toContain('scoped');
        expect(serial.commandsRun[0].stdout).toContain('scoped');

        const scheduledMesh = { policy: {
            worktreeBootstrapConfig: { version: 1, commands: [cmd('bootstrap')] },
            refineConfig: { version: 1, validation: {
                commands: [cmd('lane', 'fail'), cmd('cancelled-phase')],
                schedule: { prepare: [cmd('prepare')], phases: [
                    { id: 'gates', lanes: [{ id: 'checks', commands: ['lane'] }] },
                    { id: 'unreached', lanes: [{ id: 'later', commands: ['cancelled-phase'] }] },
                ] },
            } },
        } };
        const started: string[] = [];
        const failed = await runMeshRefineValidationGate(scheduledMesh, ws, {
            approvedRuntime: { path, checkAuthority: () => { started.push('checked'); } },
        });
        expect(failed.status).toBe('failed');
        expect(failed.bootstrap?.commandsRun?.[0]).toMatchObject({ stdout: expect.stringContaining('scoped') });
        expect(failed.schedule?.prepareRun[0].stdout).toContain('scoped');
        expect(failed.commandsRun[0].stdout).toContain('scoped');
        expect(started).toHaveLength(3);
        expect(failed.schedule?.report?.aborted).toBe(true);

        const revoked = await runMeshRefineValidationGate(mesh, ws, {
            approvedRuntime: { path, checkAuthority: () => { throw new Error('approval_changed_during_job'); } },
        });
        expect(revoked.status).toBe('failed');
        expect(revoked.commandsRun).toHaveLength(0);
        const ordinary = await runMeshRefineValidationGate(mesh, ws);
        expect(ordinary.commandsRun[0].stdout).toContain('baseline');
    });
});
